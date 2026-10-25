// End-to-end test of the cleanup pipeline against a REAL filesystem.
//
// The unit tests use a fake probe for speed and determinism. This one walks an
// actual temporary tree with node:fs, builds a real scan table from it, and runs
// detection, planning and revalidation over the result. It is the closest thing
// to the "known dataset" protocol in docs/TESTING.md, and it is the only test
// that checks the rules hold on paths Windows actually produced.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, lstatSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { F_DIR } from "../shared/types";
import { finishTable } from "../shared/table";
import type { RawScan, ScanFacts } from "../shared/table";
import { analyzeStorage } from "../shared/storage-intelligence";
import { buildAuditRecord, buildPlan, revalidate, summarizeOutcomes } from "../shared/cleanup";
import type { FsProbe } from "../shared/cleanup";
import { tableView } from "../shared/test-fixtures";

const MB = 1024 * 1024;
const FILLER = Buffer.alloc(2 * MB, 7);

// A real probe, mirroring the one in the main process: lstat, never stat, so a
// link is measured as the link rather than as its target. A missing path must
// come back as null, which is what makes the revalidation tests meaningful.
const realProbe: FsProbe = {
  resolve(path) {
    try {
      return lstatSync(path) ? path : null;
    } catch {
      return null;
    }
  },
  fingerprint(path) {
    try {
      const st = lstatSync(path);
      return { size: st.size, mtime: Math.floor(st.mtimeMs) };
    } catch {
      return null;
    }
  },
};

// Walks a real directory into the flat, parent-before-children layout the
// scanner produces. Directories are pushed before their contents, so every
// parent index is lower than its children's.
function walk(root: string): RawScan {
  const parent: number[] = [];
  const size: number[] = [];
  const logical: number[] = [];
  const mtime: number[] = [];
  const flags: number[] = [];
  const names: number[] = [];
  const nameOff: number[] = [0];
  const enc = new TextEncoder();

  const push = (name: string, p: number, sz: number, mt: number, fl: number): number => {
    const id = parent.length;
    parent.push(p);
    size.push(sz);
    logical.push(sz);
    mtime.push(mt);
    flags.push(fl);
    for (const b of enc.encode(name)) names.push(b);
    nameOff.push(names.length);
    return id;
  };

  const visit = (dir: string, p: number, isRoot: boolean): void => {
    const st = statSync(dir);
    const id = push(isRoot ? "" : dir.slice(dir.lastIndexOf("\\") + 1), p, 0, Math.floor(st.mtimeMs / 1000), F_DIR);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const est = statSync(full);
      if (est.isDirectory()) {
        visit(full, id, false);
      } else {
        push(entry.name, id, est.size, Math.floor(est.mtimeMs / 1000), 0);
      }
    }
  };
  visit(root, -1, true);

  return {
    root,
    n: parent.length,
    parent: Int32Array.from(parent),
    size: Float64Array.from(size),
    logical: Float64Array.from(logical),
    mtime: Uint32Array.from(mtime),
    flags: Uint8Array.from(flags),
    nameOff: Uint32Array.from(nameOff),
    names: Uint8Array.from(names),
  };
}

const facts: ScanFacts = { startedAt: 1_700_000_000_000, durationMs: 5, dirs: 6, errors: 0, errorSamples: [] };

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "spacewise-pipeline-"));
  const mk = (rel: string): string => {
    const dir = join(root, rel);
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  const file = (rel: string, data: Buffer | string): void => writeFileSync(join(root, rel), data);

  // A real project: dist and node_modules are genuine candidates.
  mk("app");
  file("app/package.json", '{"name":"fixture"}');
  mk("app/dist");
  file("app/dist/bundle.js", FILLER);
  mk("app/node_modules/some-pkg");
  file("app/node_modules/some-pkg/index.js", Buffer.alloc(3 * MB, 9));
  file("app/node_modules/some-pkg/package.json", '{"name":"some-pkg"}');

  // Named dist with no manifest beside it: must NOT be a candidate.
  mk("loose/dist");
  file("loose/dist/bundle.js", FILLER);

  // Named cache in an unremarkable place: must NOT be a candidate.
  mk("app/cache");
  file("app/cache/big.dat", FILLER);

  return root;
}

function withFixture<T>(fn: (root: string) => T): T {
  const root = fixture();
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("detection on a real tree finds the two real candidates and nothing else", () => {
  withFixture((root) => {
    const table = finishTable(walk(root), facts);
    const view = tableView(table);
    const found = analyzeStorage(view);
    const paths = found.map((f) => f.path.replace(root, "").replace(/\\/g, "/"));

    assert.deepEqual(paths, ["/app/node_modules", "/app/dist"], "biggest first, and only the provable ones");

    const byPath = new Map(found.map((f) => [f.path.replace(root, "").replace(/\\/g, "/"), f]));
    assert.equal(byPath.get("/app/node_modules")?.category, "dev-dependencies");
    assert.equal(byPath.get("/app/node_modules")?.risk, "low");
    assert.equal(byPath.get("/app/dist")?.category, "build-output");
    // The two decoys.
    assert.equal(paths.includes("/loose/dist"), false, "a dist with no manifest beside it is not a candidate");
    assert.equal(paths.includes("/app/cache"), false, "a folder called cache proves nothing");
  });
});

test("the reported sizes match what the filesystem holds", () => {
  withFixture((root) => {
    const table = finishTable(walk(root), facts);
    const found = analyzeStorage(tableView(table));
    const byName = new Map(found.map((f) => [f.path, f]));
    const sz = (rel: string): number => statSync(join(root, rel)).size;

    const nodeModules = byName.get(join(root, "app", "node_modules"));
    assert.ok(nodeModules);
    assert.equal(
      nodeModules.bytes,
      sz("app/node_modules/some-pkg/index.js") + sz("app/node_modules/some-pkg/package.json"),
      "a folder holds exactly its files",
    );

    const dist = byName.get(join(root, "app", "dist"));
    assert.ok(dist);
    assert.equal(dist.bytes, sz("app/dist/bundle.js"), "the measured size, not an estimate");

    // The scan root holds every byte that is actually on disk, to the byte.
    const total =
      sz("app/package.json") +
      sz("app/dist/bundle.js") +
      sz("app/node_modules/some-pkg/index.js") +
      sz("app/node_modules/some-pkg/package.json") +
      sz("loose/dist/bundle.js") +
      sz("app/cache/big.dat");
    assert.equal(table.size[0], total);
  });
});

test("a real plan accepts both candidates and refuses nothing", () => {
  withFixture((root) => {
    const found = analyzeStorage(tableView(finishTable(walk(root), facts)));
    const plan = buildPlan(
      root,
      found.map((f) => ({ id: f.id, path: f.path, bytes: f.bytes, risk: f.risk })),
      "trash",
      realProbe,
    );
    assert.equal(plan.items.length, 2);
    assert.deepEqual(plan.rejected, []);
    assert.equal(plan.estimatedBytes, plan.items.reduce((s, i) => s + i.bytes, 0));
    for (const item of plan.items) assert.ok(item.size !== null, "each item was fingerprinted from the real disk");
  });
});

test("a folder that changes between planning and acting is refused on the real disk", () => {
  withFixture((root) => {
    const found = analyzeStorage(tableView(finishTable(walk(root), facts)));
    const plan = buildPlan(
      root,
      found.map((f) => ({ id: f.id, path: f.path, bytes: f.bytes, risk: f.risk })),
      "trash",
      realProbe,
    );
    const dist = join(root, "app", "dist");
    const nodeModules = join(root, "app", "node_modules");

    // Something appears inside dist after the plan was drawn. On Windows that
    // moves the folder's own timestamp, which is what the recheck compares.
    appendFileSync(join(dist, "bundle.js"), "// touched");
    writeFileSync(join(dist, "extra.js"), "new file");

    const { ready, invalidated } = revalidate(plan, realProbe);
    assert.deepEqual(
      ready.map((i) => i.path),
      [nodeModules],
      "only the untouched candidate is safe to act on",
    );
    assert.equal(invalidated.length, 1);
    assert.equal(invalidated[0].path, dist);
    assert.match(invalidated[0].reason, /modified after|changed size/);
  });
});

test("a candidate that disappears is refused rather than assumed", () => {
  withFixture((root) => {
    const found = analyzeStorage(tableView(finishTable(walk(root), facts)));
    const plan = buildPlan(
      root,
      found.map((f) => ({ id: f.id, path: f.path, bytes: f.bytes, risk: f.risk })),
      "trash",
      realProbe,
    );
    const nodeModules = join(root, "app", "node_modules");
    rmSync(nodeModules, { recursive: true, force: true });

    const { ready, invalidated } = revalidate(plan, realProbe);
    assert.equal(ready.length, 1);
    assert.equal(invalidated[0].path, nodeModules);
    assert.match(invalidated[0].reason, /no longer on disk|removed after/);
  });
});

test("a run over a real tree reports what happened and writes a truthful record", () => {
  withFixture((root) => {
    const found = analyzeStorage(tableView(finishTable(walk(root), facts)));
    const plan = buildPlan(
      root,
      found.map((f) => ({ id: f.id, path: f.path, bytes: f.bytes, risk: f.risk })),
      "trash",
      realProbe,
    );
    const { ready, invalidated } = revalidate(plan, realProbe);

    // Stand in for the Recycle Bin: one item goes, one is refused as busy.
    const outcomes = [
      { path: ready[0].path, status: "removed" as const, bytes: ready[0].bytes },
      { path: ready[1].path, status: "failed" as const, bytes: 0, error: "EBUSY" },
    ];
    const summary = summarizeOutcomes(outcomes);
    assert.equal(summary.removed, 1);
    assert.equal(summary.failed, 1);
    assert.equal(summary.bytesFreed, ready[0].bytes, "only what went is counted as freed");
    assert.equal(summary.partial, true, "a run with a failure is never complete");

    const record = buildAuditRecord(plan, outcomes, invalidated, 1_700_000_000_000);
    assert.equal(record.planned, 2);
    assert.equal(record.partial, true);
    assert.equal(record.scope, root);
    assert.equal(record.items.length, 2);
    assert.ok(record.items.every((i) => i.path.startsWith(root)), "the record holds real absolute paths");
  });
});

test("planning refuses a candidate that lies outside the scanned folder", () => {
  withFixture((root) => {
    const plan = buildPlan(
      join(root, "app"),
      [{ id: 1, path: join(root, "loose", "dist"), bytes: 1, risk: "safe" }],
      "trash",
      realProbe,
    );
    assert.equal(plan.items.length, 0);
    assert.match(plan.rejected[0].reason, /outside the folder that was scanned/);
  });
});
