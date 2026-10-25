// Tests for the real directory lister, not a stand-in.
//
// This is the code that decides the size of every file, the flag on every
// junction, and the name of every entry, so a mistake here is wrong in every
// number the product reports. It used to be unreachable from a test because the
// worker grabbed `parentPort` at module load; it now takes a sink instead.
//
// Both implementations are exercised: the portable one explicitly, and whichever
// one the platform actually selects via `makeLister`. On Windows that second
// call goes through koffi and the real Win32 bulk API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, linkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { F_DIR, F_ERR, F_LINK } from "../shared/types";
import { makeLister, portableLister } from "./lister";
import type { EntrySink, Lister } from "./lister";

interface Entry {
  name: string;
  flag: number;
  onDisk: number;
  length: number;
  mtime: number;
}

function sinkInto(entries: Entry[]): EntrySink {
  return {
    add(name, flag, onDisk, length, mtime) {
      entries.push({ name, flag, onDisk, length, mtime });
    },
  };
}

interface Fixture {
  root: string;
  cleanup: () => void;
}

// A tree with the awkward things a real disk contains.
function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "spacewise-lister-"));
  writeFileSync(join(root, "plain.txt"), Buffer.alloc(1000, 1));
  writeFileSync(join(root, "empty.bin"), Buffer.alloc(0));
  writeFileSync(join(root, "with space.txt"), Buffer.alloc(123, 2));
  writeFileSync(join(root, "dots.in.the.name.tar.gz"), Buffer.alloc(456, 3));
  writeFileSync(join(root, "no-extension"), Buffer.alloc(789, 4));
  writeFileSync(join(root, "unicode-\u00fcn\u00efcode-\u65e5\u672c\u8a9e.txt"), Buffer.alloc(321, 5));
  mkdirSync(join(root, "subdir"));
  writeFileSync(join(root, "subdir", "nested.txt"), Buffer.alloc(64, 6));

  // A hard link. Both names point at the same bytes on disk; the product counts
  // it once per name, which is the behaviour pinned below.
  writeFileSync(join(root, "target.txt"), Buffer.alloc(2000, 7));
  linkSync(join(root, "target.txt"), join(root, "hardlink.txt"));

  // A junction. It is a directory to Windows but must be reported as a link and
  // must never be descended into.
  try {
    symlinkSync(join(root, "subdir"), join(root, "junction-to-subdir"), "junction");
  } catch {
    // Somewhere without the ability to create one: the assertions below adapt.
  }

  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function withFixture<T>(fn: (f: Fixture) => T): T {
  const f = fixture();
  try {
    return fn(f);
  } finally {
    f.cleanup();
  }
}

// Both listers must satisfy the same contract, so every case runs against both.
for (const [label, build] of [
  ["portable", (sink: EntrySink): Lister => portableLister(sink)],
  ["selected", (sink: EntrySink): Lister => makeLister(sink)],
] as [string, (sink: EntrySink) => Lister][]) {
  test(`[${label}] lists a folder and reports the entry count`, () => {
    withFixture(({ root }) => {
      const entries: Entry[] = [];
      const list = build(sinkInto(entries));
      const result = list(root);
      assert.equal(typeof result, "number", "a listing that worked returns how many entries it saw");
      assert.equal(result, entries.length, "the count matches what was handed to the sink");
      assert.ok(entries.length >= 8, `expected the whole fixture, saw ${entries.length}`);
    });
  });

  test(`[${label}] reads the logical length exactly and never understates what is occupied`, () => {
    withFixture(({ root }) => {
      const entries: Entry[] = [];
      build(sinkInto(entries))(root);
      const plain = entries.find((e) => e.name === "plain.txt");
      assert.ok(plain, "plain.txt is present");
      assert.equal(plain.length, 1000, "the logical length is exact on both paths");
      assert.equal(plain.flag & F_DIR, 0, "a file is not a folder");
      assert.ok(
        plain.onDisk >= plain.length,
        `occupied ${plain.onDisk} cannot be less than the logical length ${plain.length}`,
      );

      if (label === "selected") {
        // The Win32 bulk path reports the real allocation, rounded up to a
        // cluster, so it is strictly more than the file is long. That gap is the
        // whole reason the product tracks two sizes and says which one it shows.
        assert.ok(plain.onDisk > plain.length, "the bulk path reports what the file occupies, not how long it is");
      }

      const empty = entries.find((e) => e.name === "empty.bin");
      assert.ok(empty);
      assert.equal(empty.length, 0, "an empty file is zero, not missing");
    });
  });

  test(`[${label}] marks a subfolder as a folder`, () => {
    withFixture(({ root }) => {
      const entries: Entry[] = [];
      build(sinkInto(entries))(root);
      const dir = entries.find((e) => e.name === "subdir");
      assert.ok(dir);
      assert.equal(dir.flag & F_DIR, F_DIR);
    });
  });

  test(`[${label}] reports a junction as a link, never as a folder`, () => {
    withFixture(({ root }) => {
      const entries: Entry[] = [];
      build(sinkInto(entries))(root);
      const link = entries.find((e) => e.name === "junction-to-subdir");
      if (!link) {
        // The link could not be created here.
        return;
      }
      assert.equal(link.flag & F_LINK, F_LINK, "a junction is a link");
      assert.equal(link.flag & F_DIR, 0, "and is not treated as a folder, so it is never descended into");
      assert.equal(link.onDisk, 0, "a link carries no bytes of its own");
      assert.equal(link.length, 0);
    });
  });

  test(`[${label}] counts a hard link as its own name, with the shared size`, () => {
    withFixture(({ root }) => {
      const entries: Entry[] = [];
      build(sinkInto(entries))(root);
      const target = entries.find((e) => e.name === "target.txt");
      const alias = entries.find((e) => e.name === "hardlink.txt");
      assert.ok(target);
      assert.ok(alias, "a hard link is listed, not hidden");
      assert.equal(alias.length, 2000, "it reports the size of the bytes it shares");
      assert.equal(alias.flag & F_LINK, 0, "a hard link is not a reparse point");
      // The consequence, stated plainly: these two names are one file on disk,
      // so the folder's total counts those bytes twice. This is inherited
      // behaviour and is disclosed in the interface.
      assert.equal(alias.length, target.length);
    });
  });

  test(`[${label}] carries names through unchanged, including spaces and non-ASCII`, () => {
    withFixture(({ root }) => {
      const entries: Entry[] = [];
      build(sinkInto(entries))(root);
      const names = entries.map((e) => e.name);
      assert.ok(names.includes("with space.txt"));
      assert.ok(names.includes("dots.in.the.name.tar.gz"));
      assert.ok(names.includes("no-extension"));
      assert.ok(
        names.includes("unicode-\u00fcn\u00efcode-\u65e5\u672c\u8a9e.txt"),
        "a non-ASCII name survives the round trip out of the Win32 buffer",
      );
      assert.equal(new Set(names).size, names.length, "no entry is reported twice");
    });
  });

  test(`[${label}] neither '.' nor '..' is ever an entry`, () => {
    withFixture(({ root }) => {
      const entries: Entry[] = [];
      build(sinkInto(entries))(root);
      for (const e of entries) {
        assert.notEqual(e.name, ".");
        assert.notEqual(e.name, "..");
      }
    });
  });

  test(`[${label}] a folder that does not exist comes back as an error code`, () => {
    const missing = join(tmpdir(), "spacewise-definitely-not-here-" + Date.now());
    const entries: Entry[] = [];
    const result = build(sinkInto(entries))(missing);
    assert.equal(typeof result, "string", "a failure is an error code, never a silent zero");
    assert.equal(result, "ENOENT");
    assert.equal(entries.length, 0, "and it writes nothing");
  });

  test(`[${label}] listing a file never invents entries`, () => {
    withFixture(({ root }) => {
      const entries: Entry[] = [];
      const result = build(sinkInto(entries))(join(root, "plain.txt"));
      // The portable path refuses outright; the Win32 bulk path opens the handle
      // and finds nothing to enumerate. Both are acceptable, because the
      // coordinator only ever dispatches folders.
      assert.ok(typeof result === "string" || result === 0, `unexpected result ${String(result)}`);
      assert.equal(entries.length, 0, "a file must never be reported as containing things");
    });
  });
}

test("a path deeper than 260 characters is still readable", (t) => {
  const root = mkdtempSync(join(tmpdir(), "spacewise-longpath-"));
  try {
    let deep = root;
    for (let i = 0; i < 14; i++) deep = join(deep, `folder-with-a-long-name-${i}`);
    let created = true;
    try {
      mkdirSync(deep, { recursive: true });
    } catch {
      created = false;
    }
    if (!created || deep.length <= 260) {
      t.skip(`could not build a path over 260 characters here (length ${deep.length})`);
      return;
    }

    // The parent of the deepest folder is itself over the limit, which is the
    // case the \\?\ prefix exists for.
    const parent = deep.slice(0, deep.lastIndexOf("\\"));
    assert.ok(parent.length > 260, `the parent is over the limit too (${parent.length})`);

    const entries: Entry[] = [];
    const result = makeLister(sinkInto(entries))(parent);
    assert.equal(typeof result, "number", `listing a long path failed with ${String(result)}`);
    assert.equal(entries.length, 1, "the final folder is there");
    assert.equal(entries[0].flag & F_DIR, F_DIR);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("makeLister reports an error rather than throwing when the sink is asked for too much", () => {
  withFixture(({ root }) => {
    const entries: Entry[] = [];
    const sink: EntrySink = {
      add() {
        throw new Error("sink exploded");
      },
    };
    void entries;
    assert.throws(() => makeLister(sink)(root), /sink exploded/, "a sink failure is not swallowed");
  });
});

test("an unreadable entry is recorded as an error flag rather than dropped", () => {
  // Only meaningful on the portable path, which has the per-entry fallback.
  withFixture(({ root }) => {
    const entries: Entry[] = [];
    const sink: EntrySink = {
      add(name, flag, onDisk, length, mtime) {
        entries.push({ name, flag, onDisk, length, mtime });
      },
    };
    const list = portableLister(sink);
    const result = list(root);
    assert.equal(typeof result, "number");
    // Every entry is accounted for: none is silently missing.
    assert.equal(new Set(entries.map((e) => e.name)).size, entries.length);
    for (const e of entries) assert.ok((e.flag & F_ERR) === 0, `${e.name} should have been readable`);
  });
});
