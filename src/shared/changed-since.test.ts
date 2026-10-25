// The one guard behind every destructive action that was decided earlier.
// The cleanup planner and the trash path both call this, so these tests are the
// tests for both.
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { changedSince, revalidate } from "./cleanup";
import type { CleanupPlan, FsProbe } from "./cleanup";

// A probe over a fixed set of files, where a file can be made to disappear or
// to stop being readable.
function probeOf(
  files: Record<string, { size: number; mtime: number }>,
  options: { unreadable?: string[] } = {},
): FsProbe {
  const unreadable = new Set(options.unreadable ?? []);
  return {
    resolve: (path) => (path in files ? path : null),
    fingerprint: (path) => (unreadable.has(path) ? null : (files[path] ?? null)),
  };
}

const A = "C:\\work\\a.mp4";

describe("changed since", () => {
  it("says nothing when the file is exactly as described", () => {
    assert.equal(changedSince({ path: A, size: 100, mtime: 500 }, probeOf({ [A]: { size: 100, mtime: 500 } })), null);
  });

  it("notices a file that is gone", () => {
    assert.equal(changedSince({ path: A, size: 100, mtime: 500 }, probeOf({})), "gone");
  });

  it("notices a file it cannot read, and refuses rather than assuming", () => {
    const probe = probeOf({ [A]: { size: 100, mtime: 500 } }, { unreadable: [A] });
    assert.equal(changedSince({ path: A, size: 100, mtime: 500 }, probe), "unreadable");
  });

  it("notices a different length", () => {
    assert.equal(changedSince({ path: A, size: 100, mtime: 500 }, probeOf({ [A]: { size: 101, mtime: 500 } })), "size");
  });

  it("notices a different modification time", () => {
    assert.equal(changedSince({ path: A, size: 100, mtime: 500 }, probeOf({ [A]: { size: 100, mtime: 501 } })), "mtime");
  });

  it("reports the length first when both changed, because it is the cheaper fact", () => {
    assert.equal(changedSince({ path: A, size: 100, mtime: 500 }, probeOf({ [A]: { size: 200, mtime: 900 } })), "size");
  });

  it("ignores a fact it was not given", () => {
    const probe = probeOf({ [A]: { size: 100, mtime: 500 } });
    assert.equal(changedSince({ path: A, size: null, mtime: 500 }, probe), null);
    assert.equal(changedSince({ path: A, size: 100, mtime: null }, probe), null);
    assert.equal(changedSince({ path: A, size: null, mtime: null }, probe), null);
  });

  it("still insists the file is there when it was given nothing to compare", () => {
    assert.equal(changedSince({ path: A, size: null, mtime: null }, probeOf({})), "gone");
  });

  it("notices a file that changed but kept its length and its timestamp", () => {
    // The honest limit of this guard: it compares metadata, not content. A file
    // edited inside the timestamp resolution with its length preserved is not
    // detectable here, and no amount of re-reading would fix that without
    // hashing again. Recorded rather than pretended.
    const probe = probeOf({ [A]: { size: 100, mtime: 500 } });
    assert.equal(changedSince({ path: A, size: 100, mtime: 500 }, probe), null);
  });
});

describe("the cleanup planner uses the same guard", () => {
  const plan = (items: CleanupPlan["items"]): CleanupPlan => ({
    scope: "C:\\work",
    action: "trash",
    items,
    rejected: [],
    estimatedBytes: 0,
  });

  it("keeps an item that has not moved", () => {
    const probe = probeOf({ [A]: { size: 100, mtime: 500 } });
    const out = revalidate(plan([{ id: 1, path: A, bytes: 100, risk: "safe", size: 100, mtime: 500 }]), probe);
    assert.equal(out.ready.length, 1);
    assert.equal(out.invalidated.length, 0);
  });

  it("now refuses an item it cannot fingerprint, rather than waving it through", () => {
    // This is a tightening. The old code accepted an item whenever the
    // fingerprint came back empty, which is the wrong direction for a deletion.
    const probe = probeOf({ [A]: { size: 100, mtime: 500 } }, { unreadable: [A] });
    const out = revalidate(plan([{ id: 1, path: A, bytes: 100, risk: "safe", size: 100, mtime: 500 }]), probe);
    assert.equal(out.ready.length, 0);
    assert.match(out.invalidated[0].reason, /could not be read/);
  });
});
