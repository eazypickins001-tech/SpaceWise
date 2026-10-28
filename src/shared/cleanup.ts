// The safe cleanup workflow. Nothing in this file touches the disk: it decides
// what *may* be touched, and it is deliberately pure so every rule below is
// testable and every refusal can be explained to the person who asked.
//
// The order the product must follow, and the order these helpers implement:
//   1. a candidate is identified by a rule (storage-intelligence.ts)
//   2. the path is validated against the scope it came from
//   3. the plan is shown, with counts and an estimated size
//   4. immediately before acting, every path is revalidated
//   5. the action runs, and success, failure and skips are reported apart
//
// Nothing here permanently deletes by default, and nothing here will ever
// accept a bare wildcard as a target.
//
// This module is imported by both the main process and the renderer, so it must
// stay free of Node built-ins.

export type Action = "trash" | "delete";

export interface CleanupItem {
  id: number;
  path: string;
  bytes: number;
  risk: string;
  // Captured when the plan is built, compared again before the action runs, so
  // a file that changed in between is skipped rather than removed.
  size: number | null;
  mtime: number | null;
}

export interface RejectedItem {
  path: string;
  reason: string;
}

export interface CleanupPlan {
  scope: string;
  action: Action;
  items: CleanupItem[];
  rejected: RejectedItem[];
  estimatedBytes: number;
}

export type ItemStatus = "removed" | "failed" | "skipped";

export interface ItemOutcome {
  path: string;
  status: ItemStatus;
  bytes: number;
  error?: string;
}

export interface OutcomeSummary {
  removed: number;
  failed: number;
  skipped: number;
  bytesFreed: number;
  // True when anything at all was left behind, so a partial run is never
  // reported as complete.
  partial: boolean;
}

// What the planner needs to know about the disk. Injected, so the rules can be
// tested against a fake and so the real implementation stays in the main process.
export interface FsProbe {
  resolve(path: string): string | null;
  fingerprint(path: string): { size: number; mtime: number } | null;
}

// Locations that are never a cleanup target, whatever a rule says. This is the
// same layer the brief asks for: every deletion passes through it, including
// ones the person picked by hand.
const PROTECTED_NAMES = [".git", ".ssh", ".gnupg", "login data", "logins.json", "key3.db", "key4.db", "cookies"];

const PROTECTED_ROOTS = [
  "\\windows",
  "\\program files",
  "\\program files (x86)",
  "\\programdata",
  "\\$recycle.bin",
  "\\system volume information",
  "\\recovery",
  "\\boot",
  "\\efi",
];

// A path that looks like a drive root ("C:\") or a UNC share root.
const ROOT_LIKE = /^[a-z]:[\\/]?$/i;

export function normalizePath(input: string): string {
  const slashed = input.replace(/\//g, "\\");
  const parts = slashed.split("\\");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      // Never walk above the root of the path we were given.
      if (out.length > 0 && !/^[a-z]:$/i.test(out[out.length - 1])) out.pop();
      continue;
    }
    out.push(part);
  }
  if (out.length === 0) return "";
  if (/^[a-z]:$/i.test(out[0])) return out.length === 1 ? out[0] + "\\" : out.join("\\");
  return "\\\\" + out.join("\\");
}

// True when `child` is strictly below `parent`. Segment-aware, so
// "C:\ProgramData2" is not treated as being inside "C:\ProgramData".
export function isInside(parent: string, child: string): boolean {
  const p = normalizePath(parent).replace(/\\+$/, "").toLowerCase();
  const c = normalizePath(child).replace(/\\+$/, "").toLowerCase();
  if (p === "" || c === "" || p === c) return false;
  return c.startsWith(p + "\\");
}

// Operating-system locations and credential stores. Refused everywhere in the
// application, not only in cleanup: a location the interface never offers a way
// to reach should not be nameable by a compromised renderer either. This is the
// part of the policy that does not depend on which folders were scanned, so it
// is the part that still holds if the scan roots themselves are not trusted.
export function protectedPlace(path: string): string | null {
  const norm = normalizePath(path);
  const lower = norm.toLowerCase();
  const segments = lower.split("\\").filter(Boolean);

  for (const segment of segments) {
    if (PROTECTED_NAMES.includes(segment)) return `"${segment}" is a protected location`;
  }

  // Drop the drive letter (or UNC server) and compare what remains against the
  // protected roots at any depth. "C:\Windows\Temp" is refused for the same
  // reason "C:\Windows" is: a running installer may be using it.
  const tail = segments.length > 1 ? "\\" + segments.slice(1).join("\\") : lower;
  for (const root of PROTECTED_ROOTS) {
    if (tail === root || tail.startsWith(root + "\\")) return `${norm} is part of the operating system`;
  }
  return null;
}

// A cleanup target is additionally never a whole drive.
function isProtected(path: string): string | null {
  if (ROOT_LIKE.test(normalizePath(path))) return "a whole drive cannot be a cleanup target";
  return protectedPlace(path);
}

// A folder the person has added to the list cleanup must never touch.
//
// Additive by construction: this can only produce a refusal, never remove one,
// and the built-in list above is not consulted or edited here. It is a separate
// function from `protectedPlace` for that reason, not an extension of it.
export function userProtectedReason(path: string, extra: readonly string[]): string | null {
  if (extra.length === 0) return null;
  const norm = normalizePath(path);
  const lower = norm.toLowerCase();
  for (const raw of extra) {
    const folder = normalizePath(raw);
    if (folder === "") continue;
    if (lower === folder.toLowerCase()) return `${norm} is a folder you protect from cleanup`;
    if (isInside(folder, norm)) return `${norm} is inside a folder you protect from cleanup (${folder})`;
  }
  return null;
}

// Rule 2. Every path is validated against the scope it was found in, and against
// the protected list, before it can enter a plan.
export function validatePath(
  path: string,
  scope: string,
  extraProtected: readonly string[] = [],
): { ok: true; path: string } | { ok: false; reason: string } {
  const norm = normalizePath(path);
  if (norm === "") return { ok: false, reason: "the path is empty after normalisation" };
  if (path.includes("*") || path.includes("?")) return { ok: false, reason: "a wildcard is not a target" };
  if (ROOT_LIKE.test(norm)) return { ok: false, reason: "a whole drive cannot be a cleanup target" };

  const scopeNorm = normalizePath(scope);
  if (norm.toLowerCase() === scopeNorm.toLowerCase()) {
    return { ok: false, reason: "the folder being scanned is not itself a target" };
  }
  if (!isInside(scopeNorm, norm)) {
    return { ok: false, reason: `${norm} is outside the folder that was scanned (${scopeNorm})` };
  }
  const bad = isProtected(norm);
  if (bad) return { ok: false, reason: bad };
  const mine = userProtectedReason(norm, extraProtected);
  if (mine) return { ok: false, reason: mine };
  return { ok: true, path: norm };
}

export interface Candidate {
  id: number;
  path: string;
  bytes: number;
  risk: string;
}

// Rule 3. Builds the plan, recording why anything was refused rather than
// dropping it silently.
export function buildPlan(
  scope: string,
  candidates: readonly Candidate[],
  action: Action,
  probe: FsProbe,
  extraProtected: readonly string[] = [],
): CleanupPlan {
  const items: CleanupItem[] = [];
  const rejected: RejectedItem[] = [];

  for (const c of candidates) {
    const check = validatePath(c.path, scope, extraProtected);
    if (!check.ok) {
      rejected.push({ path: c.path, reason: check.reason });
      continue;
    }
    const resolved = probe.resolve(check.path);
    if (resolved === null) {
      rejected.push({ path: check.path, reason: "the item is no longer on disk" });
      continue;
    }
    const fp = probe.fingerprint(resolved);
    items.push({
      id: c.id,
      path: resolved,
      bytes: c.bytes,
      risk: c.risk,
      size: fp ? fp.size : null,
      mtime: fp ? fp.mtime : null,
    });
  }

  return {
    scope: normalizePath(scope),
    action,
    items,
    rejected,
    estimatedBytes: items.reduce((sum, i) => sum + i.bytes, 0),
  };
}

export interface Revalidation {
  ready: CleanupItem[];
  invalidated: RejectedItem[];
}

// Rule 4. The last thing before the action. A path that has gone, been
// replaced, or changed size or timestamp since the plan was drawn is dropped
// and reported. This is the time-of-check/time-of-use guard.
// What was known about a file when the interface drew it.
export interface FsTarget {
  path: string;
  size: number | null;
  mtime: number | null;
}

// How a file stopped being the file that was described.
export type ChangeKind = "gone" | "unreadable" | "size" | "mtime";

// The one comparison behind every time-of-check/time-of-use guard in the
// application. Anything that removes a file on the strength of a claim made
// earlier asks this first: the cleanup planner when a plan is executed, and
// the trash path when a duplicate is deleted. Returns null when the file is
// still what it was.
//
// A file that cannot be fingerprinted counts as changed. Proceeding on a file
// that cannot be read is the wrong direction for a deletion.
export function changedSince(target: FsTarget, probe: FsProbe): ChangeKind | null {
  const resolved = probe.resolve(target.path);
  if (resolved === null) return "gone";
  const fp = probe.fingerprint(resolved);
  if (fp === null) return "unreadable";
  if (target.size !== null && fp.size !== target.size) return "size";
  if (target.mtime !== null && fp.mtime !== target.mtime) return "mtime";
  return null;
}

// The same sentence for the cleanup planner, phrased for a plan.
function planReason(kind: ChangeKind): string {
  if (kind === "gone") return "the item was removed after the plan was made";
  if (kind === "size") return "the item changed size after the plan was made";
  if (kind === "mtime") return "the item was modified after the plan was made";
  return "the item could not be read";
}

// The same four kinds again, phrased for an action taken straight after a scan
// rather than for a plan drawn earlier. The interface shows one of these as the
// reason a file was left where it was, because "it may be in use" is a guess and
// it was standing in for an answer the application already had.
export function changeReason(kind: ChangeKind): string {
  if (kind === "gone") return "it is no longer there";
  if (kind === "size") return "its size changed after the scan";
  if (kind === "mtime") return "it was modified after the scan";
  return "it could not be read";
}

export function revalidate(plan: CleanupPlan, probe: FsProbe, extraProtected: readonly string[] = []): Revalidation {
  const ready: CleanupItem[] = [];
  const invalidated: RejectedItem[] = [];

  for (const item of plan.items) {
    const check = validatePath(item.path, plan.scope, extraProtected);
    if (!check.ok) {
      invalidated.push({ path: item.path, reason: check.reason });
      continue;
    }
    const changed = changedSince(item, probe);
    if (changed !== null) {
      invalidated.push({ path: item.path, reason: planReason(changed) });
      continue;
    }
    ready.push(item);
  }
  return { ready, invalidated };
}

// Rule 5. Success, failure and skips are counted separately, and a run with
// anything left behind is marked partial.
export function summarizeOutcomes(outcomes: readonly ItemOutcome[]): OutcomeSummary {
  let removed = 0;
  let failed = 0;
  let skipped = 0;
  let bytesFreed = 0;
  for (const o of outcomes) {
    if (o.status === "removed") {
      removed += 1;
      bytesFreed += o.bytes;
    } else if (o.status === "failed") {
      failed += 1;
    } else {
      skipped += 1;
    }
  }
  return { removed, failed, skipped, bytesFreed, partial: failed > 0 || skipped > 0 };
}

// How far a run has got. Sent once to state the total, before anything is
// touched, and again as each item finishes, so the interface can draw a
// determinate bar in place of an indefinite "Working..." that says nothing and
// cannot be stopped.
export interface CleanupProgress {
  done: number;
  total: number;
  // The item just finished. Empty before the first, which is what lets the
  // total be shown the moment the run begins rather than only after it ends.
  path: string;
}

export interface RunControl {
  // True once the person has asked to stop. Checked before each item and never
  // during one, so a removal already under way is never interrupted half-done.
  cancelled(): boolean;
  onProgress(progress: CleanupProgress): void;
}

// Why a stopped run never reached an item. It is a refusal, so a run that was
// cut short is counted as partial rather than presented as one that removed
// everything.
export const CANCELLED_REASON = "the cleanup was stopped before this was removed";

// Rule 5, the run itself. The only thing that touches the disk is the `remove`
// callback main supplies, so the order of the work, the progress reported and
// what a stopped run leaves behind are all decided here where a test can hold
// them to account.
export async function runPlan(
  ready: readonly CleanupItem[],
  invalidated: readonly RejectedItem[],
  remove: (item: CleanupItem) => Promise<ItemOutcome>,
  control: RunControl,
): Promise<ItemOutcome[]> {
  const outcomes: ItemOutcome[] = [];
  const total = ready.length + invalidated.length;
  const report = (path: string): void => control.onProgress({ done: outcomes.length, total, path });
  report("");

  for (let i = 0; i < ready.length; i++) {
    if (control.cancelled()) {
      // Everything left is reported as skipped, each with a reason, so the
      // result can never read as if the whole lot had gone.
      for (let j = i; j < ready.length; j++) {
        outcomes.push({ path: ready[j].path, status: "skipped", bytes: 0, error: CANCELLED_REASON });
      }
      break;
    }
    const outcome = await remove(ready[i]);
    outcomes.push(outcome);
    report(ready[i].path);
  }

  // Whatever the recheck refused is reported after, with its own reason.
  for (const bad of invalidated) {
    outcomes.push({ path: bad.path, status: "skipped", bytes: 0, error: bad.reason });
    report(bad.path);
  }
  return outcomes;
}

// Rule 10. What gets written to the local audit log. It contains the user's own
// paths, so it stays on the machine and is never sent anywhere.
export interface AuditRecord {
  at: number;
  action: Action;
  scope: string;
  planned: number;
  estimatedBytes: number;
  removed: number;
  failed: number;
  skipped: number;
  bytesFreed: number;
  partial: boolean;
  items: ItemOutcome[];
  rejected: RejectedItem[];
}

export function buildAuditRecord(
  plan: CleanupPlan,
  outcomes: readonly ItemOutcome[],
  invalidated: readonly RejectedItem[],
  at: number,
): AuditRecord {
  const summary = summarizeOutcomes(outcomes);
  return {
    at,
    action: plan.action,
    scope: plan.scope,
    planned: plan.items.length,
    estimatedBytes: plan.estimatedBytes,
    removed: summary.removed,
    failed: summary.failed,
    skipped: summary.skipped,
    bytesFreed: summary.bytesFreed,
    partial: summary.partial,
    items: [...outcomes],
    rejected: [...plan.rejected, ...invalidated],
  };
}

// What the main process returns from a cleanup run. `record` is null only when
// the run was refused before it started.
export interface CleanupRunResult {
  outcomes: ItemOutcome[];
  invalidated: RejectedItem[];
  record: AuditRecord | null;
  error: string | null;
}

// The label the interface shows next to an action, so an irreversible operation
// is never presented as a safe one.
export function actionLabel(action: Action): string {
  return action === "trash"
    ? "Move to Recycle Bin (recoverable from Windows)"
    : "Delete permanently (cannot be undone)";
}
