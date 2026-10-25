// The scan table builder is the correctness core of the whole product: every
// size, count and total the interface reports comes out of it. Upstream shipped
// it with no tests at all, so these are the first ones.
import { test } from "node:test";
import assert from "node:assert/strict";
import { F_DIR, F_LINK } from "./types";
import { finishTable, previewTable, tableBuffers } from "./table";
import type { RawScan } from "./table";
import { build, facts } from "./test-fixtures";

// root
//   a.txt        100
//   sub/
//     b.bin      300
//     c.bin      200
const sample = (): RawScan =>
  build("C:\\root", {
    name: "",
    children: [
      { name: "a.txt", size: 100, mtime: 10 },
      { name: "sub", children: [{ name: "b.bin", size: 300, mtime: 30 }, { name: "c.bin", size: 200, mtime: 20 }] },
    ],
  });

test("finishTable sums bytes upward from the leaves", () => {
  const t = finishTable(sample(), facts());
  assert.equal(t.n, 5);
  assert.equal(t.size[0], 600, "root holds every byte");
  assert.equal(t.size[2], 500, "sub holds its two files");
  assert.equal(t.size[1], 100);
  assert.equal(t.size[3], 300);
  assert.equal(t.size[4], 200);
});

test("finishTable counts files, not folders, in the subtree total", () => {
  const t = finishTable(sample(), facts());
  assert.equal(t.files[0], 3, "root has three files across two folders");
  assert.equal(t.files[2], 2, "sub has two");
  // A file node's own column stays 0: the count is a subtree total, and
  // readers treat a non-folder as one file themselves.
  assert.equal(t.files[1], 0);
});

test("finishTable keeps on-disk size and logical size independent", () => {
  // A sparse or compressed file: 8 KiB reserved on disk, 1 MiB of content.
  const raw = build("C:\\root", {
    name: "",
    children: [{ name: "sparse.dat", size: 8192, logical: 1024 * 1024 }],
  });
  const t = finishTable(raw, facts());
  assert.equal(t.size[0], 8192, "the total reports what the file occupies");
  assert.equal(t.logical[0], 1024 * 1024, "the logical total is reported separately");
  assert.notEqual(t.size[0], t.logical[0], "the two measures must never be conflated");
});

test("finishTable carries the newest change time up the tree", () => {
  const t = finishTable(sample(), facts());
  assert.equal(t.mtime[2], 30, "sub reflects its newest child");
  assert.equal(t.mtime[0], 30, "root reflects the newest node anywhere below it");
});

test("finishTable orders each folder's children largest first", () => {
  const t = finishTable(sample(), facts());
  const kids = Array.from(t.childList.subarray(t.childStart[0], t.childStart[1]));
  assert.equal(kids.length, 2);
  assert.equal(kids[0], 2, "the 500 byte folder sorts before the 100 byte file");
  assert.equal(kids[1], 1);
});

test("finishTable indexes extensions, lowercased and deduplicated", () => {
  const raw = build("C:\\root", {
    name: "",
    children: [
      { name: "one.TXT", size: 1 },
      { name: "two.txt", size: 1 },
      { name: "three.bin", size: 1 },
      { name: "no-extension", size: 1 },
      { name: "trailing.", size: 1 },
      { name: "a.abcdefghijklmn", size: 1 },
      { name: "unicode.\u00fcnicode", size: 1 },
    ],
  });
  const t = finishTable(raw, facts());
  assert.equal(t.exts[t.ext[1]], "txt");
  assert.equal(t.ext[1], t.ext[2], "the same extension shares one index");
  assert.equal(t.exts[t.ext[3]], "bin");
  assert.equal(t.ext[4], 0, "a name with no dot has no extension");
  assert.equal(t.ext[5], 0, "a trailing dot is not an extension");
  assert.equal(t.ext[6], 0, "a dot further than 12 bytes from the end is ignored");
  assert.equal(t.ext[7], 0, "a non-ASCII extension is not indexed");
  assert.equal(t.exts[0], "", "index 0 is reserved for no type");
});

test("finishTable records the scan's own facts and drops an explicit false", () => {
  const t = finishTable(sample(), facts({ dirs: 7, errors: 2, durationMs: 99 }));
  assert.equal(t.dirs, 7);
  assert.equal(t.errors, 2);
  assert.equal(t.durationMs, 99);
  assert.equal(t.root, "C:\\root");
  assert.equal(t.incomplete, undefined, "a finished scan is not marked incomplete");
});

test("finishTable keeps an incomplete scan marked as such", () => {
  const t = finishTable(sample(), facts({ incomplete: true }));
  assert.equal(t.incomplete, true);
});

test("previewTable keeps the cut as a solid block and drops what is below it", () => {
  const t = previewTable(sample(), 1, facts());
  assert.equal(t.n, 3, "root, a.txt and sub survive a depth of one");
  assert.equal(t.parent[0], -1, "the root has no parent in a preview");
  assert.equal(t.size[0], 600, "the total is still complete");
  assert.equal(t.flags[2] & F_DIR, 0, "the folder at the cut is drawn as solid");
  assert.equal(t.flags[0] & F_DIR, F_DIR, "folders above the cut stay folders");
});

test("previewTable returns the whole tree when the depth is deep enough", () => {
  const t = previewTable(sample(), 8, facts());
  assert.equal(t.n, 5);
  assert.equal(t.size[0], 600);
});

test("previewTable starts with no type breakdown and no errors carried over", () => {
  const t = previewTable(sample(), 1, facts({ errors: 3 }));
  assert.deepEqual(t.exts, [""]);
  assert.deepEqual(t.errorSamples, []);
});

test("a link keeps its flag and is never counted as a folder", () => {
  const raw = build("C:\\root", {
    name: "",
    children: [{ name: "junction", size: 0, flags: F_LINK }],
  });
  const t = finishTable(raw, facts());
  assert.equal(t.flags[1] & F_LINK, F_LINK);
  assert.equal(t.flags[1] & F_DIR, 0, "a link is not traversed as a directory");
  assert.equal(t.files[0], 1, "it still counts as one entry");
});

test("tableBuffers hands over every column but the type list", () => {
  const t = finishTable(sample(), facts());
  const buffers = tableBuffers(t);
  assert.equal(buffers.length, 11);
  for (const b of buffers) assert.ok(b instanceof ArrayBuffer, "each column is a transferable buffer");
});

test("a scan whose declared count is smaller than its arrays is honoured", () => {
  // Workers hand back over-allocated arrays; only the first `n` may be read.
  // Cutting at three keeps the root, a.txt and sub, and so drops the two files
  // inside sub. The totals follow the declared count exactly.
  const raw = sample();
  const sloppy: RawScan = { ...raw, n: 3 };
  const t = finishTable(sloppy, facts());
  assert.equal(t.n, 3);
  assert.equal(t.size[0], 100, "only the kept subtree is summed");
  assert.equal(t.files[0], 1, "the dropped files are not counted");
});

test("an empty root is a valid scan of an empty folder", () => {
  const t = finishTable(build("C:\\empty", { name: "" }), facts({ dirs: 1 }));
  assert.equal(t.n, 1);
  assert.equal(t.size[0], 0);
  assert.equal(t.files[0], 0);
  assert.equal(t.childStart.length, 2);
});
