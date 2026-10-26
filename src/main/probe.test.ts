// The probe the deletion guards share, held to the scanner's units.
//
// This is the check that was missing. Everything else in the application agrees
// that a modification time is whole seconds: the scan table declares it
// (`mtime` in types.ts), the lister records it that way, and `fs:stat` reports
// it that way. The probe alone returned milliseconds -- and because the renderer
// sends a file's size and mtime exactly as the table holds them, it disagreed
// with every target it was handed. Nothing could be moved to the Recycle Bin,
// and the interface blamed the files for it.
//
// It survived the whole suite because the cleanup planner fills each item's size
// and mtime from this same probe (cleanup.ts, `buildPlan`): the planner was
// comparing the probe against itself, so the unit could be wrong and every
// planner test still passed. Only the path that takes its facts from a scan --
// the one a person actually uses -- could disagree, and nothing drove it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedSince } from "../shared/cleanup";
import { makeLister } from "./lister";
import type { EntrySink } from "./lister";
import { fsProbe } from "./probe";

interface Listed {
  name: string;
  onDisk: number;
  length: number;
  mtime: number;
}

// What the production lister records for a real folder, using whichever
// implementation this platform selects.
function list(dir: string): Listed[] {
  const out: Listed[] = [];
  const sink: EntrySink = {
    add(name, _flag, onDisk, length, mtime) {
      out.push({ name, onDisk, length, mtime });
    },
  };
  const err = makeLister(sink)(dir);
  assert.equal(typeof err, "number", `listing ${dir} returned ${err}`);
  return out;
}

function withTemp<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "spacewise-probe-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function scannedFile(dir: string): { path: string; listed: Listed } {
  const path = join(dir, "hello.bin");
  writeFileSync(path, Buffer.alloc(1234, 3));
  const listed = list(dir).find((e) => e.name === "hello.bin");
  assert.ok(listed, "the lister did not report the file it was just given");
  return { path, listed };
}

test("the probe's modification time is in the unit the scan records", () => {
  withTemp((dir) => {
    const { path, listed } = scannedFile(dir);
    const fp = fsProbe.fingerprint(path);
    assert.ok(fp, "the probe could not fingerprint a file it was just given");
    assert.equal(fp.mtime, listed.mtime, "the probe and the lister disagree on the modification time");
    assert.equal(fp.size, listed.length, "the probe and the lister disagree on the size");
    // The regression, named: milliseconds are what this used to return.
    assert.notEqual(fp.mtime, Math.floor(lstatSync(path).mtimeMs), "the probe is back to milliseconds");
  });
});

test("a file straight out of a scan can be trashed", () => {
  withTemp((dir) => {
    const { path, listed } = scannedFile(dir);
    // Exactly what the renderer sends: the size and the mtime as the scan table
    // holds them (App.tsx, `confirmTrash`).
    const target = { path, size: listed.length, mtime: listed.mtime };
    assert.equal(changedSince(target, fsProbe), null, "an untouched file was refused, so nothing can be deleted");
  });
});

test("the guard still refuses a file that really did change", () => {
  withTemp((dir) => {
    const { path, listed } = scannedFile(dir);
    truncateSync(path, 999);
    assert.equal(changedSince({ path, size: listed.length, mtime: listed.mtime }, fsProbe), "size");
    assert.equal(changedSince({ path: join(dir, "not-here.bin"), size: null, mtime: null }, fsProbe), "gone");
    assert.equal(fsProbe.fingerprint(join(dir, "not-here.bin")), null, "a missing file must not fingerprint");
  });
});
