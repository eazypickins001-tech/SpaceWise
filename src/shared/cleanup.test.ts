// The cleanup planner is the part of the product that can lose someone's data,
// so it is tested hardest. Nothing here touches a real disk: the filesystem is
// a fake, which also makes the time-of-check/time-of-use case easy to stage.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  actionLabel,
  buildAuditRecord,
  buildPlan,
  isInside,
  normalizePath,
  revalidate,
  summarizeOutcomes,
  validatePath,
} from "./cleanup";
import type { FsProbe, ItemOutcome } from "./cleanup";

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
