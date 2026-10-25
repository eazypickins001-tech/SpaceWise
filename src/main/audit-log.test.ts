// The audit log is the record of what the product actually did to someone's
// disk, so it is tested against a real temporary directory rather than a mock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAudit, readAudit } from "./audit-log";
import type { AuditRecord } from "../shared/cleanup";

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "spacewise-audit-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function record(at: number, over: Partial<AuditRecord> = {}): AuditRecord {
  return {
    at,
    action: "trash",
    scope: "C:\\work",
    planned: 1,
    estimatedBytes: 100,
    removed: 1,
    failed: 0,
    skipped: 0,
    bytesFreed: 100,
    partial: false,
    items: [{ path: "C:\\work\\node_modules", status: "removed", bytes: 100 }],
    rejected: [],
    ...over,
  };
}

test("reading a log that does not exist yields nothing rather than throwing", () => {
  withTempDir((dir) => {
    assert.deepEqual(readAudit(join(dir, "missing.jsonl")), []);
  });
});

test("appending creates the folder and the file", () => {
  withTempDir((dir) => {
    const file = join(dir, "nested", "deeper", "audit.jsonl");
    appendAudit(file, record(1000));
    assert.equal(readAudit(file).length, 1);
  });
});

test("runs come back newest first, with their paths intact", () => {
  withTempDir((dir) => {
    const file = join(dir, "audit.jsonl");
    appendAudit(file, record(1000));
    appendAudit(file, record(2000, { action: "delete", scope: "C:\\other" }));
    const runs = readAudit(file);
    assert.equal(runs.length, 2);
    assert.equal(runs[0].at, 2000, "the most recent run is first");
    assert.equal(runs[0].action, "delete");
    assert.equal(runs[1].at, 1000);
    assert.equal(runs[0].scope, "C:\\other");
    assert.equal(runs[1].items[0].path, "C:\\work\\node_modules");
  });
});

test("the limit is honoured without disturbing the stored file", () => {
  withTempDir((dir) => {
    const file = join(dir, "audit.jsonl");
    for (let i = 1; i <= 10; i++) appendAudit(file, record(i));
    assert.equal(readAudit(file, 3).length, 3);
    assert.deepEqual(
      readAudit(file, 3).map((r) => r.at),
      [10, 9, 8],
    );
    assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 10, "nothing was pruned yet");
  });
});

test("old runs age out once the cap is reached", () => {
  withTempDir((dir) => {
    const file = join(dir, "audit.jsonl");
    for (let i = 1; i <= 8; i++) appendAudit(file, record(i), 5);
    const raw = readFileSync(file, "utf8").trim().split("\n").length;
    assert.equal(raw, 5, "only the newest five runs are kept");
    assert.deepEqual(
      readAudit(file).map((r) => r.at),
      [8, 7, 6, 5, 4],
    );
  });
});

test("a damaged line does not destroy the rest of the history", () => {
  withTempDir((dir) => {
    const file = join(dir, "audit.jsonl");
    appendAudit(file, record(1000));
    writeFileSync(file, readFileSync(file, "utf8") + "{ this is not json\n");
    appendAudit(file, record(2000));
    const runs = readAudit(file);
    assert.equal(runs.length, 2, "both good runs survive");
    assert.deepEqual(
      runs.map((r) => r.at),
      [2000, 1000],
    );
  });
});

test("a partial run is stored as partial, not rounded up", () => {
  withTempDir((dir) => {
    const file = join(dir, "audit.jsonl");
    appendAudit(
      file,
      record(5000, {
        removed: 2,
        failed: 1,
        skipped: 1,
        bytesFreed: 200,
        partial: true,
        items: [
          { path: "a", status: "removed", bytes: 100 },
          { path: "b", status: "removed", bytes: 100 },
          { path: "c", status: "failed", bytes: 0, error: "EBUSY" },
          { path: "d", status: "skipped", bytes: 0, error: "locked" },
        ],
        rejected: [{ path: "C:\\Windows", reason: "C:\\Windows is part of the operating system" }],
      }),
    );
    const [run] = readAudit(file);
    assert.equal(run.partial, true);
    assert.equal(run.removed, 2);
    assert.equal(run.failed, 1);
    assert.equal(run.skipped, 1);
    assert.equal(run.bytesFreed, 200);
    assert.equal(run.items.length, 4);
    assert.equal(run.rejected[0].reason, "C:\\Windows is part of the operating system");
  });
});

test("appending tolerates a file that was truncated mid-line", () => {
  withTempDir((dir) => {
    const file = join(dir, "audit.jsonl");
    writeFileSync(file, '{"at":1,"act');
    assert.doesNotThrow(() => appendAudit(file, record(3000)));
    const runs = readAudit(file);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].at, 3000);
  });
});
