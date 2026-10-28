// The cleanup planner is the part of the product that can lose someone's data,
// so it is tested hardest. Nothing here touches a real disk: the filesystem is
// a fake, which also makes the time-of-check/time-of-use case easy to stage.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CANCELLED_REASON,
  actionLabel,
  buildAuditRecord,
  buildPlan,
  changeReason,
  isInside,
  normalizePath,
  revalidate,
  runPlan,
  summarizeOutcomes,
  validatePath,
} from "./cleanup";
import type { CleanupItem, CleanupProgress, FsProbe, ItemOutcome } from "./cleanup";

function probeOf(entries: Record<string, { size: number; mtime: number }>): FsProbe {
  const key = (p: string): string => normalizePath(p).toLowerCase();
  const map = new Map(Object.entries(entries).map(([k, v]) => [key(k), v]));
  return {
    resolve: (p) => (map.has(key(p)) ? normalizePath(p) : null),
    fingerprint: (p) => map.get(key(p)) ?? null,
  };
}

test("normalizePath collapses separators, dots and a trailing slash", () => {
  assert.equal(normalizePath("C:/work//app/./dist/"), "C:\\work\\app\\dist");
  assert.equal(normalizePath("C:\\"), "C:\\");
  assert.equal(normalizePath("C:\\work\\app\\..\\other"), "C:\\work\\other");
});

test("normalizePath never climbs above the root it was given", () => {
  assert.equal(normalizePath("C:\\work\\..\\..\\..\\evil"), "C:\\evil");
});

test("isInside compares whole path segments", () => {
  assert.equal(isInside("C:\\ProgramData", "C:\\ProgramData\\x"), true);
  assert.equal(isInside("C:\\ProgramData", "C:\\ProgramData2\\x"), false, "a prefix is not a parent");
  assert.equal(isInside("C:\\ProgramData", "C:\\ProgramData"), false, "a folder is not inside itself");
  assert.equal(isInside("C:\\work", "C:\\work\\a\\..\\b"), true);
});

test("a candidate inside the scanned folder is accepted", () => {
  const r = validatePath("C:\\work\\app\\node_modules", "C:\\work\\app");
  assert.equal(r.ok, true);
});

test("a candidate outside the scanned folder is refused with a reason", () => {
  const r = validatePath("C:\\Windows\\Temp", "C:\\work\\app");
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /outside the folder that was scanned/);
});

test("the scanned folder itself is never a target", () => {
  const r = validatePath("C:\\work\\app", "C:\\work\\app");
  assert.equal(r.ok, false);
});

test("a wildcard is refused outright", () => {
  for (const bad of ["C:\\work\\*", "C:\\work\\app\\?.dll"]) {
    const r = validatePath(bad, "C:\\work");
    assert.equal(r.ok, false, bad);
    assert.match((r as { reason: string }).reason, /wildcard/);
  }
});

test("a whole drive is refused", () => {
  const r = validatePath("C:\\", "C:\\work");
  assert.equal(r.ok, false);
});

test("traversal out of the scope is refused", () => {
  // The scope is C:\work\app; climbing out and back in must not be accepted for
  // a path that really lands elsewhere.
  const r = validatePath("C:\\work\\app\\..\\..\\Users\\Someone", "C:\\work\\app");
  assert.equal(r.ok, false);
});

test("operating system folders are refused at any depth", () => {
  for (const bad of ["C:\\Windows", "C:\\Windows\\Temp", "C:\\Program Files\\app", "C:\\ProgramData\\x"]) {
    const r = validatePath(bad, "C:\\");
    assert.equal(r.ok, false, bad);
    assert.match((r as { reason: string }).reason, /operating system/);
  }
});

test("a repository, keys and browser credentials are refused", () => {
  for (const bad of ["C:\\work\\app\\.git", "C:\\Users\\X\\.ssh", "C:\\Users\\X\\.gnupg"]) {
    const r = validatePath(bad, "C:\\");
    assert.equal(r.ok, false, bad);
    assert.match((r as { reason: string }).reason, /protected location/);
  }
});

test("buildPlan keeps the good candidates and explains the refused ones", () => {
  const probe = probeOf({
    "C:\\work\\app\\node_modules": { size: 10, mtime: 1 },
    "C:\\work\\app\\__pycache__": { size: 20, mtime: 2 },
  });
  const plan = buildPlan(
    "C:\\work\\app",
    [
      { id: 1, path: "C:\\work\\app\\node_modules", bytes: 1000, risk: "low" },
      { id: 2, path: "C:\\work\\app\\__pycache__", bytes: 2000, risk: "safe" },
      { id: 3, path: "C:\\Windows", bytes: 9e9, risk: "safe" },
      { id: 4, path: "C:\\elsewhere\\stuff", bytes: 5, risk: "safe" },
    ],
    "trash",
    probe,
  );
  assert.equal(plan.items.length, 2);
  assert.equal(plan.rejected.length, 2);
  assert.equal(plan.estimatedBytes, 3000, "only the accepted candidates are estimated");
  assert.deepEqual(
    plan.items.map((i) => i.id),
    [1, 2],
  );
  assert.ok(plan.rejected.every((r) => r.reason.length > 0));
});

test("buildPlan drops a candidate that is already gone rather than assuming it", () => {
  const probe = probeOf({});
  const plan = buildPlan("C:\\work", [{ id: 1, path: "C:\\work\\gone", bytes: 10, risk: "safe" }], "trash", probe);
  assert.equal(plan.items.length, 0);
  assert.equal(plan.rejected[0].reason, "the item is no longer on disk");
});

test("revalidate passes through an untouched plan", () => {
  const probe = probeOf({ "C:\\work\\a": { size: 10, mtime: 100 } });
  const plan = buildPlan("C:\\work", [{ id: 1, path: "C:\\work\\a", bytes: 10, risk: "safe" }], "trash", probe);
  const { ready, invalidated } = revalidate(plan, probe);
  assert.equal(ready.length, 1);
  assert.deepEqual(invalidated, []);
});

test("revalidate drops an item that changed size after the plan was drawn", () => {
  const before = probeOf({ "C:\\work\\a": { size: 10, mtime: 100 } });
  const plan = buildPlan("C:\\work", [{ id: 1, path: "C:\\work\\a", bytes: 10, risk: "safe" }], "trash", before);
  const after = probeOf({ "C:\\work\\a": { size: 11, mtime: 100 } });
  const { ready, invalidated } = revalidate(plan, after);
  assert.equal(ready.length, 0, "the item must not be removed");
  assert.match(invalidated[0].reason, /changed size/);
});

test("revalidate drops an item that was modified after the plan was drawn", () => {
  const before = probeOf({ "C:\\work\\a": { size: 10, mtime: 100 } });
  const plan = buildPlan("C:\\work", [{ id: 1, path: "C:\\work\\a", bytes: 10, risk: "safe" }], "trash", before);
  const after = probeOf({ "C:\\work\\a": { size: 10, mtime: 200 } });
  const { invalidated } = revalidate(plan, after);
  assert.match(invalidated[0].reason, /modified after/);
});

test("revalidate drops an item that disappeared after the plan was drawn", () => {
  const before = probeOf({ "C:\\work\\a": { size: 10, mtime: 100 } });
  const plan = buildPlan("C:\\work", [{ id: 1, path: "C:\\work\\a", bytes: 10, risk: "safe" }], "trash", before);
  const { ready, invalidated } = revalidate(plan, probeOf({}));
  assert.equal(ready.length, 0);
  assert.match(invalidated[0].reason, /removed after/);
});

test("revalidate re-checks the protected list, not only the identity", () => {
  // A plan could be drawn before a folder is protected, or assembled by hand.
  const probe = probeOf({ "C:\\Windows\\Temp": { size: 10, mtime: 100 } });
  const handMade = {
    scope: "C:\\",
    action: "delete" as const,
    items: [{ id: 9, path: "C:\\Windows\\Temp", bytes: 10, risk: "safe", size: 10, mtime: 100 }],
    rejected: [],
    estimatedBytes: 10,
  };
  const { ready, invalidated } = revalidate(handMade, probe);
  assert.equal(ready.length, 0);
  assert.match(invalidated[0].reason, /operating system/);
});

test("outcomes are counted apart, and anything left behind marks the run partial", () => {
  const clean: ItemOutcome[] = [
    { path: "a", status: "removed", bytes: 5 },
    { path: "b", status: "removed", bytes: 7 },
  ];
  assert.deepEqual(summarizeOutcomes(clean), { removed: 2, failed: 0, skipped: 0, bytesFreed: 12, partial: false });

  const messy: ItemOutcome[] = [
    { path: "a", status: "removed", bytes: 5 },
    { path: "b", status: "failed", bytes: 7, error: "EBUSY" },
    { path: "c", status: "skipped", bytes: 9, error: "locked" },
  ];
  const s = summarizeOutcomes(messy);
  assert.equal(s.removed, 1);
  assert.equal(s.failed, 1);
  assert.equal(s.skipped, 1);
  assert.equal(s.bytesFreed, 5, "only bytes actually removed are counted as freed");
  assert.equal(s.partial, true, "a run that left something behind is never reported as complete");
});

test("the audit record says what was planned, what happened, and what was refused", () => {
  const probe = probeOf({ "C:\\work\\a": { size: 10, mtime: 100 } });
  const plan = buildPlan(
    "C:\\work",
    [
      { id: 1, path: "C:\\work\\a", bytes: 10, risk: "safe" },
      { id: 2, path: "C:\\Windows", bytes: 1, risk: "safe" },
    ],
    "trash",
    probe,
  );
  const outcomes: ItemOutcome[] = [{ path: "C:\\work\\a", status: "removed", bytes: 10 }];
  const record = buildAuditRecord(plan, outcomes, [], 1_700_000_000_000);

  assert.equal(record.action, "trash");
  assert.equal(record.scope, "C:\\work");
  assert.equal(record.planned, 1);
  assert.equal(record.estimatedBytes, 10);
  assert.equal(record.removed, 1);
  assert.equal(record.bytesFreed, 10);
  assert.equal(record.partial, false);
  assert.equal(record.rejected.length, 1, "the refusal is part of the record");
  assert.equal(record.at, 1_700_000_000_000);
});

test("a record merges refusals from planning and from revalidation", () => {
  const probe = probeOf({ "C:\\work\\a": { size: 10, mtime: 100 } });
  const plan = buildPlan("C:\\work", [{ id: 1, path: "C:\\work\\a", bytes: 10, risk: "safe" }], "delete", probe);
  const record = buildAuditRecord(
    plan,
    [{ path: "C:\\work\\a", status: "skipped", bytes: 10, error: "locked" }],
    [{ path: "C:\\work\\a", reason: "the item was modified after the plan was made" }],
    1,
  );
  assert.equal(record.rejected.length, 1);
  assert.equal(record.skipped, 1);
  assert.equal(record.partial, true);
});

test("an irreversible action is never labelled as a safe one", () => {
  assert.match(actionLabel("trash"), /recoverable/);
  assert.match(actionLabel("delete"), /cannot be undone/);
  assert.notEqual(actionLabel("trash"), actionLabel("delete"));
});

// A refusal is shown to the person verbatim, so the wording is the interface.
// The interface used to say "they may be in use" for every failure, which was a
// guess: these sentences are the answer it already had and threw away.
test("every refusal says why, and never names a cause it cannot know", () => {
  assert.equal(changeReason("gone"), "it is no longer there");
  assert.equal(changeReason("size"), "its size changed after the scan");
  assert.equal(changeReason("mtime"), "it was modified after the scan");
  assert.equal(changeReason("unreadable"), "it could not be read");

  // The four are distinct, and none of them is the old guess.
  const all = [changeReason("gone"), changeReason("size"), changeReason("mtime"), changeReason("unreadable")];
  assert.equal(new Set(all).size, 4);
  for (const sentence of all) assert.doesNotMatch(sentence, /in use/);
  // A sentence, not the bare code the main process used to hand over.
  for (const sentence of all) {
    assert.doesNotMatch(sentence, /^(gone|size|mtime|unreadable)$/, `"${sentence}" is still a code, not a sentence`);
    assert.match(sentence, /^it/, `"${sentence}" should read as a sentence`);
  }
});

// The run is where progress and a stop are decided. The filesystem is a fake, so
// the order of the work, the counts reported and what a stopped run leaves behind
// are pinned without a disk. Before this, the run was a bare loop in the main
// process: nothing reported how far it had got, and nothing could stop it, so the
// interface sat on an indefinite "Working..." it could not close.

function item(path: string, bytes: number): CleanupItem {
  return { id: bytes, path, bytes, risk: "safe", size: bytes, mtime: 1 };
}

test("a run states its total before it starts and reports each item as it finishes", async () => {
  const ready = [item("C:\\work\\a", 10), item("C:\\work\\b", 20), item("C:\\work\\c", 30)];
  const seen: CleanupProgress[] = [];
  const outcomes = await runPlan(ready, [], async (i) => ({ path: i.path, status: "removed", bytes: i.bytes }), {
    cancelled: () => false,
    onProgress: (p) => seen.push({ ...p }),
  });

  assert.equal(seen[0].done, 0, "the total is stated before anything is touched");
  assert.equal(seen[0].total, 3);
  assert.equal(seen[0].path, "", "and names no item, because none has finished yet");
  assert.deepEqual(
    seen.slice(1).map((p) => p.path),
    ["C:\\work\\a", "C:\\work\\b", "C:\\work\\c"],
    "each finished item is named in turn",
  );
  assert.deepEqual(
    seen.slice(1).map((p) => p.done),
    [1, 2, 3],
    "and the count climbs one at a time",
  );
  assert.equal(outcomes.length, 3);
});

test("a run that is stopped finishes the item in hand and reports the rest as skipped", async () => {
  const ready = [item("C:\\work\\a", 10), item("C:\\work\\b", 20), item("C:\\work\\c", 30)];
  const removed: string[] = [];
  let stop = false;
  const outcomes = await runPlan(
    ready,
    [],
    async (i) => {
      removed.push(i.path);
      stop = true; // the person asks to stop while this removal is under way
      return { path: i.path, status: "removed", bytes: i.bytes };
    },
    { cancelled: () => stop, onProgress: () => {} },
  );

  assert.deepEqual(removed, ["C:\\work\\a"], "the removal already under way is never interrupted");
  assert.deepEqual(
    outcomes.map((o) => o.status),
    ["removed", "skipped", "skipped"],
  );
  assert.equal(outcomes[1].error, CANCELLED_REASON, "an item that was never reached says why");
  assert.equal(outcomes[2].error, CANCELLED_REASON);
  const summary = summarizeOutcomes(outcomes);
  assert.equal(summary.removed, 1, "only what actually went is counted as removed");
  assert.equal(summary.partial, true, "a stopped run is never presented as one that removed everything");
});

test("a run that is stopped before the first item touches nothing and reports the lot as skipped", async () => {
  const ready = [item("C:\\work\\a", 10), item("C:\\work\\b", 20)];
  let touched = 0;
  const outcomes = await runPlan(ready, [], async (i) => {
    touched++;
    return { path: i.path, status: "removed", bytes: i.bytes };
  }, { cancelled: () => true, onProgress: () => {} });

  assert.equal(touched, 0, "nothing is removed once a stop has been asked for");
  assert.ok(outcomes.every((o) => o.status === "skipped"));
  assert.equal(summarizeOutcomes(outcomes).removed, 0);
});

test("what the recheck refused is reported as skipped, with its own reason", async () => {
  const outcomes = await runPlan(
    [item("C:\\work\\a", 10)],
    [{ path: "C:\\work\\gone", reason: "the item was removed after the plan was made" }],
    async (i) => ({ path: i.path, status: "removed", bytes: i.bytes }),
    { cancelled: () => false, onProgress: () => {} },
  );

  assert.equal(outcomes.length, 2);
  assert.equal(outcomes[0].status, "removed");
  assert.equal(outcomes[1].status, "skipped");
  assert.match(outcomes[1].error ?? "", /removed after/);
});

// Folders the person adds to the list cleanup must never touch. The only thing
// they may do is refuse more, so these tests check both directions: the protected
// folder is refused, and nothing that was already refused becomes acceptable.

test("a folder the person protects is refused, and so is everything inside it", () => {
  const extra = ["C:\\work\\app\\keep"];
  const inside = validatePath("C:\\work\\app\\keep\\deep\\file.bin", "C:\\work\\app", extra);
  assert.equal(inside.ok, false);
  assert.match((inside as { reason: string }).reason, /protect/);

  const itself = validatePath("C:\\work\\app\\keep", "C:\\work\\app", extra);
  assert.equal(itself.ok, false);

  // A sibling folder is untouched: protecting one does not freeze the scan.
  assert.equal(validatePath("C:\\work\\app\\drop", "C:\\work\\app", extra).ok, true);
});

test("protecting a folder can never make a refused path acceptable", () => {
  const r = validatePath("C:\\Windows\\Temp", "C:\\", ["C:\\work\\app"]);
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /operating system/);
});

test("the plan records which protected folder refused the item", () => {
  const probe = probeOf({ "C:\\work\\app\\keep\\a": { size: 10, mtime: 1 } });
  const plan = buildPlan(
    "C:\\work\\app",
    [{ id: 1, path: "C:\\work\\app\\keep\\a", bytes: 10, risk: "safe" }],
    "trash",
    probe,
    ["C:\\work\\app\\keep"],
  );
  assert.equal(plan.items.length, 0);
  assert.equal(plan.rejected.length, 1);
  assert.match(plan.rejected[0].reason, /C:\\work\\app\\keep/);
});

test("revalidation refuses an item inside a folder protected after the plan was drawn", () => {
  const probe = probeOf({ "C:\\work\\a": { size: 10, mtime: 100 } });
  const plan = buildPlan("C:\\work", [{ id: 1, path: "C:\\work\\a", bytes: 10, risk: "safe" }], "trash", probe);
  const { ready, invalidated } = revalidate(plan, probe, ["C:\\work\\a"]);
  assert.equal(ready.length, 0);
  assert.match(invalidated[0].reason, /protect/);
});
