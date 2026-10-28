// Folders the person has said cleanup must never touch.
//
// Additive only, by design: this list can refuse more than the policy already
// refuses, never less. It lives in the main process because a list the interface
// owned would be advice rather than a rule — the enforcement has to sit where the
// deletion happens, on the other side of the IPC boundary.
//
// Kept out of index.ts so the store can be tested against a real temporary file,
// the way the audit log and the licence store already are.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { normalizePath } from "../shared/cleanup";

// A rule file nobody can read is not protection. A hundred is far more than
// anyone needs and bounded enough to stay legible.
export const MAX_PROTECTED = 100;

// Absolute paths only, normalised, one entry per folder, de-duplicated
// case-insensitively. Anything else is dropped rather than stored as a rule that
// looks like protection and protects nothing.
export function cleanEntries(values: readonly unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const raw = String(value ?? "").trim();
    // The input is tested, not the normalised form: normalizePath() renders
    // anything it does not recognise as a UNC share, so "relative\\path" comes
    // back looking absolute and would be accepted as a rule that protects a
    // folder nobody named.
    const absolute = /^[a-z]:[\\/]/i.test(raw) || raw.startsWith("\\\\");
    if (!absolute) continue;
    const norm = normalizePath(raw);
    if (norm === "") continue;
    const key = norm.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(norm);
    if (out.length >= MAX_PROTECTED) break;
  }
  return out;
}

export function readProtected(file: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    // A damaged file means "nothing protected yet", not a crash and not a
    // silently-wide-open rule set: the built-in policy is unaffected either way.
    return Array.isArray(parsed) ? cleanEntries(parsed) : [];
  } catch {
    return [];
  }
}

export function writeProtected(file: string, values: readonly unknown[]): string[] {
  const next = cleanEntries(values);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
  return next;
}

// Adding is idempotent; removing matches case-insensitively, because Windows does.
export function addProtected(file: string, path: string): string[] {
  return writeProtected(file, [...readProtected(file), path]);
}

export function removeProtected(file: string, path: string): string[] {
  const drop = normalizePath(path).toLowerCase();
  return writeProtected(
    file,
    readProtected(file).filter((p) => p.toLowerCase() !== drop),
  );
}
