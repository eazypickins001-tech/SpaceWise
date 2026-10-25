import { strict as assert } from "node:assert";
import { linkSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { reclaimableBytes } from "../shared/dupes";
import type { DupCandidate } from "../shared/types";
import { CHUNK, EDGE, edgeHash, findDuplicates } from "./dupfind";

const dir = mkdtempSync(join(tmpdir(), "spacewise-dup-"));
after(() => rmSync(dir, { recursive: true, force: true }));

// Deterministic bytes, so "these differ" is a fact about the data rather than
// luck with a random generator.
function pattern(size: number, seed = 7): Buffer {
  const b = Buffer.allocUnsafe(size);
  let x = seed >>> 0;
  for (let i = 0; i < size; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    b[i] = x >>> 24;
  }
  return b;
}

let planted = 0;
function plant(bytes: Buffer, label = "f"): string {
  const path = join(dir, `${label}-${planted++}.bin`);
  writeFileSync(path, bytes);
  return path;
}

let nextId = 0;
function asCandidate(paths: string[], size: number): DupCandidate {
  return { size, ids: paths.map(() => nextId++), paths };
}

const idsOf = (paths: string[]): number[] => paths.map((_, i) => nextId - paths.length + i);

// Comfortably longer than two edges, so the second pass is what decides.
const BIG = EDGE * 2 + 8192;

const alikes = (paths: string[], size: number): ReturnType<typeof findDuplicates> =>
  findDuplicates([asCandidate(paths, size)], { everyMs: 0 });

describe("duplicates: identical content", () => {
  it("groups two byte-identical large files", () => {
    const base = pattern(BIG);
    const out = alikes([plant(base, "a"), plant(base, "b")], BIG);
    assert.equal(out.length, 1);
    assert.equal(out[0].ids.length, 2);
    assert.equal(out[0].size, BIG);
  });

  it("groups three identical copies into one set of three", () => {
    const base = pattern(BIG, 11);
    const out = alikes([plant(base, "a"), plant(base, "b"), plant(base, "c")], BIG);
    assert.equal(out.length, 1);
    assert.equal(out[0].ids.length, 3);
  });

  it("groups small identical files, where the first pass already covers every byte", () => {
    const base = pattern(1024, 3);
    const out = alikes([plant(base, "s"), plant(base, "s")], 1024);
    assert.equal(out.length, 1);
    assert.equal(out[0].ids.length, 2);
  });

  it("produces one set per group of identical files, not one per file", () => {
    const one = pattern(BIG, 1);
    const two = pattern(BIG, 2);
    const out = findDuplicates(
      [asCandidate([plant(one, "a"), plant(one, "b")], BIG), asCandidate([plant(two, "c"), plant(two, "d")], BIG)],
      { everyMs: 0 },
    );
    assert.equal(out.length, 2);
    assert.equal(
      out.reduce((a, g) => a + g.ids.length, 0),
      4,
    );
  });
});

describe("duplicates: different content of the same length", () => {
  it("does not group a file with no twin", () => {
    const out = alikes([plant(pattern(BIG, 5), "lonely")], BIG);
    assert.equal(out.length, 0);
  });

  it("separates files that differ in the first byte", () => {
    const base = pattern(BIG, 8);
    const other = Buffer.from(base);
    other[0] ^= 0xff;
    assert.equal(alikes([plant(base, "a"), plant(other, "b")], BIG).length, 0);
  });

  it("separates files that differ in the last byte", () => {
    const base = pattern(BIG, 9);
    const other = Buffer.from(base);
    other[BIG - 1] ^= 0xff;
    assert.equal(alikes([plant(base, "a"), plant(other, "b")], BIG).length, 0);
  });

  it("separates files that differ only in the middle, which the first pass cannot see", () => {
    const base = pattern(BIG, 13);
    const other = Buffer.from(base);
    const at = Math.floor(BIG / 2);
    other[at] ^= 0xff;

    const a = plant(base, "same-edges-a");
    const b = plant(other, "same-edges-b");
    const buffer = Buffer.allocUnsafe(CHUNK);

    // The premise of the test: the cheap pass sees two identical files.
    assert.equal(edgeHash(a, BIG, buffer), edgeHash(b, BIG, buffer), "head and tail should match");

    // The whole read is what catches it.
    assert.equal(alikes([a, b], BIG).length, 0, "the second pass should separate them");
  });
});

describe("duplicates: the boundary between the two passes", () => {
  it("covers the whole file at exactly twice the edge, so one pass is enough", () => {
    const size = EDGE * 2;
    const base = pattern(size, 21);
    const other = Buffer.from(base);
    other[EDGE] ^= 0xff; // the first byte the tail read looks at

    const buffer = Buffer.allocUnsafe(CHUNK);
    const a = plant(base, "edge-a");
    const b = plant(other, "edge-b");
    assert.notEqual(edgeHash(a, size, buffer), edgeHash(b, size, buffer), "the tail read should reach this byte");
    assert.equal(alikes([a, b], size).length, 0);
  });

  it("leaves exactly one byte unread at the edge plus one, and relies on the second pass", () => {
    const size = EDGE * 2 + 1;
    const base = pattern(size, 22);
    const other = Buffer.from(base);
    other[EDGE] ^= 0xff; // the byte between the head read and the tail read

    const buffer = Buffer.allocUnsafe(CHUNK);
    const a = plant(base, "gap-a");
    const b = plant(other, "gap-b");

    // The premise: the cheap pass genuinely cannot tell these apart.
    assert.equal(edgeHash(a, size, buffer), edgeHash(b, size, buffer), "the cheap pass should miss this byte");

    // And the second pass still refuses to call them duplicates.
    assert.equal(alikes([a, b], size).length, 0, "the second pass should separate them");
  });
});

describe("duplicates: awkward input", () => {
  it("skips a file it cannot read, and still finds the pair beside it", () => {
    const base = pattern(BIG, 31);
    const a = plant(base, "readable-a");
    const b = plant(base, "readable-b");
    const gone = join(dir, "not-here.bin");
    const out = alikes([a, gone, b], BIG);
    assert.equal(out.length, 1);
    assert.equal(out[0].ids.length, 2);
  });

  it("says nothing at all when there is nothing to compare", () => {
    assert.deepEqual(findDuplicates([], { everyMs: 0 }), []);
  });

  it("groups two empty files with each other", () => {
    // The interface never reaches this, because candidates are filtered by a
    // size floor first, but the behaviour is pinned rather than left implied.
    const out = findDuplicates([asCandidate([plant(Buffer.alloc(0), "empty"), plant(Buffer.alloc(0), "empty")], 0)], {
      everyMs: 0,
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].ids.length, 2);
  });

  it("refuses a file whose length no longer matches what the scan recorded", () => {
    // A file this short is treated as fully covered by its head and tail. Had
    // the length not been rechecked, this file that grew after the scan would
    // have been judged on its first zero bytes and called identical.
    const wasEmpty = plant(Buffer.alloc(0), "was-empty");
    const grown = plant(pattern(1024, 4), "since-grown");
    assert.equal(alikes([wasEmpty, grown], 0).length, 0);
  });

  it("reports progress, and ends having accounted for every candidate", () => {
    const base = pattern(BIG, 41);
    const paths = [plant(base, "a"), plant(base, "b"), plant(base, "c")];
    const seen: number[] = [];
    findDuplicates([asCandidate(paths, BIG)], { everyMs: 0, onProgress: (p) => seen.push(p.done) });
    assert.ok(seen.length > 0, "progress should be reported when asked for");
    assert.ok(
      seen.every((d) => d <= 3),
      "progress must never claim more files than were given",
    );
  });

  it("returns ids that belong to the files it was given, never invented ones", () => {
    const base = pattern(BIG, 51);
    const paths = [plant(base, "a"), plant(base, "b")];
    const candidate = asCandidate(paths, BIG);
    const expected = [...candidate.ids];
    const out = findDuplicates([candidate], { everyMs: 0 });
    assert.deepEqual([...out[0].ids].sort((x, y) => x - y), expected.sort((x, y) => x - y));
  });
});

describe("duplicates: names that share their bytes", () => {
  // A hard link is one file under two names. Deleting either name frees
  // nothing, because the other name still holds the file, so a pair like this
  // must never be offered as reclaimable space. This is not hypothetical: pnpm
  // builds its whole store out of hard links, which makes a developer's
  // node_modules exactly the folder this tool exists to analyse.
  it("does not offer a hard link to the same file as a duplicate", () => {
    const bytes = pattern(BIG, 11);
    const original = plant(bytes, "linked");
    const alias = join(dir, "alias-same-file.bin");
    linkSync(original, alias);

    assert.equal(statSync(original).nlink, 2, "the planted pair really is one file with two names");
    assert.deepEqual(alikes([original, alias], BIG), [], "one file under two names must not be offered");

    // And the figure the interface would print is zero rather than the size.
    const onDisk = statSync(original).blocks * 512;
    assert.equal(reclaimableBytes(alikes([original, alias], BIG), () => onDisk, () => false), 0);
  });

  // The case that would quietly inflate a real number: a genuinely duplicated
  // file sitting beside a linked one. Only the names that each hold their own
  // copies can be counted, so the saving is one copy rather than three.
  it("counts only the names that each hold their own bytes, so the saving is one copy", () => {
    const bytes = pattern(BIG, 33);
    const original = plant(bytes, "linked");
    const alias = join(dir, "alias-beside-copies.bin");
    linkSync(original, alias);
    const one = plant(bytes, "real");
    const two = plant(bytes, "real");

    const candidate = asCandidate([original, alias, one, two], BIG);
    const groups = findDuplicates([candidate], { everyMs: 0 });

    assert.equal(groups.length, 1, "the genuine pair is still found");
    assert.deepEqual(groups[0].ids, candidate.ids.slice(2), "and the two linked names are not among them");

    const onDisk = statSync(one).blocks * 512;
    assert.equal(reclaimableBytes(groups, () => onDisk, () => false), onDisk, "one copy, because that is what deleting it frees");
  });
});
