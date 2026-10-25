// The invariant that keeps the deletion guard from refusing honest work.
//
// Before anything is removed, the main process compares what the scanner
// recorded against a fresh `lstat`. Those two come from different places: the
// bulk lister reads the Win32 directory block and derives the time from a
// FILETIME, while the guard uses `lstatSync`. If they disagreed by even a
// second, every legitimate deletion would be refused as "changed since it was
// scanned". This test exists to make sure they cannot.
import { strict as assert } from "node:assert";
import { lstatSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { bulkLister, makeLister, portableLister } from "./lister";
import type { EntrySink, Lister } from "./lister";

const dir = mkdtempSync(join(tmpdir(), "spacewise-agree-"));
after(() => rmSync(dir, { recursive: true, force: true }));

interface Row {
  flag: number;
  onDisk: number;
  length: number;
  mtime: number;
}

function run(build: (sink: EntrySink) => Lister | null, folder: string): Map<string, Row> | null {
  const rows = new Map<string, Row>();
  const lister = build({
    add(name, flag, onDisk, length, mtime) {
      rows.set(name, { flag, onDisk, length, mtime });
    },
  });
  if (!lister) return null;
  lister(folder);
  return rows;
}

// Exactly what the guard asks for, from exactly the call it makes.
function expected(path: string): { size: number; mtime: number } {
  const st = lstatSync(path);
  return { size: st.size, mtime: Math.max(0, Math.floor(st.mtimeMs / 1000)) };
}

const implementations: [string, (sink: EntrySink) => Lister | null][] = [
  ["portable", portableLister],
  ["bulk", bulkLister],
  ["makeLister", makeLister],
];

// A name with a space and a non-ASCII character, and a length that is not a
// multiple of anything, so nothing passes by coincidence.
const NAMES = ["plain.dat", "with space.dat", "unicode-\u00e9\u00fc-".concat("x".repeat(37))];

describe("what the scanner records is what the deletion guard compares", () => {
  for (const [label, build] of implementations) {
    it(`[${label}] records the same length and time a fresh lstat reports`, () => {
      const folder = mkdtempSync(join(dir, label + "-"));
      const sizes = [0, 1, 4096, 4097, 65_536, 100_003];
      NAMES.forEach((name, i) => writeFileSync(join(folder, name), Buffer.alloc(sizes[i % sizes.length], 7)));

      const rows = run(build, folder);
      if (rows === null) {
        assert.equal(label, "bulk", "only the bulk lister is allowed to be unavailable");
        return;
      }
      for (const name of NAMES) {
        const row = rows.get(name);
        assert.ok(row, `[${label}] should have listed ${name}`);
        const want = expected(join(folder, name));
        assert.equal(row.length, want.size, `[${label}] length of ${name}`);
        assert.equal(row.mtime, want.mtime, `[${label}] modification time of ${name}`);
      }
    });
  }

  it("the bulk lister is available on Windows, where it is the one that ships", () => {
    // Without this, every assertion above could pass by falling back to the
    // portable lister, and the production path would be untested while looking
    // tested. koffi is a runtime dependency, so on Windows its absence is worth
    // knowing about rather than quietly accepting.
    if (process.platform !== "win32") return;
    assert.notEqual(
      bulkLister({ add() {} }),
      null,
      "the bulk lister should be available on Windows; without koffi the scan silently uses the slower path",
    );
  });

  it("agrees at a fractional second, where a rounded time could drift", () => {
    // 1699999999.999 and 1700000000.001 sit either side of a whole second. A
    // lister that rounded instead of flooring would disagree with the guard on
    // one of them.
    const folder = mkdtempSync(join(dir, "fractional-"));
    const below = join(folder, "below.dat");
    const above = join(folder, "above.dat");
    writeFileSync(below, "x");
    writeFileSync(above, "x");
    utimesSync(below, 1_699_999_999.999, 1_699_999_999.999);
    utimesSync(above, 1_700_000_000.001, 1_700_000_000.001);

    for (const [label, build] of implementations) {
      const rows = run(build, folder);
      if (rows === null) continue;
      for (const name of ["below.dat", "above.dat"]) {
        const want = expected(join(folder, name));
        assert.equal(rows.get(name)?.mtime, want.mtime, `[${label}] ${name} at a fractional second`);
      }
    }
  });
});
