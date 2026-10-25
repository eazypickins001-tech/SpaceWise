import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { DupGroup } from "./types";
import { extraCopies, reclaimableBytes } from "./dupes";

// A lookup that reports the same size for every id, which is the ordinary case.
const flat =
  (onDisk: number): ((id: number) => number) =>
  () =>
    onDisk;

const anyAlive = (): boolean => false;

describe("reclaimable space from duplicates", () => {
  it("counts every copy but one", () => {
    const groups: DupGroup[] = [{ size: 1000, ids: [1, 2] }];
    assert.equal(reclaimableBytes(groups, flat(4096), anyAlive), 4096);
  });

  it("counts three copies as two, not three", () => {
    const groups: DupGroup[] = [{ size: 1000, ids: [1, 2, 3] }];
    assert.equal(reclaimableBytes(groups, flat(4096), anyAlive), 8192);
    assert.equal(extraCopies(groups, anyAlive), 2);
  });

  it("adds up across several sets", () => {
    const groups: DupGroup[] = [
      { size: 1000, ids: [1, 2] },
      { size: 2000, ids: [3, 4, 5] },
    ];
    assert.equal(reclaimableBytes(groups, flat(100), anyAlive), 100 + 200);
  });

  it("uses what the copies occupy, not the length they share", () => {
    // Two files of the same length where one is compressed: they are duplicates
    // by content, but only the uncompressed one frees much.
    const groups: DupGroup[] = [{ size: 1_000_000, ids: [1, 2] }];
    const onDisk = (id: number): number => (id === 1 ? 1_000_000 : 1000);
    // Keeping the 1 MB copy, deleting the compressed one.
    assert.equal(reclaimableBytes(groups, onDisk, anyAlive), 1000);
  });

  it("keeps the largest copy, so it never overstates the saving", () => {
    const groups: DupGroup[] = [{ size: 500, ids: [1, 2, 3] }];
    const onDisk = (id: number): number => (id === 3 ? 900_000 : 500);
    assert.equal(reclaimableBytes(groups, onDisk, anyAlive), 1000);
  });

  it("ignores a set that is down to one copy, because nothing is freed", () => {
    assert.equal(reclaimableBytes([{ size: 900, ids: [1] }], flat(900), anyAlive), 0);
  });

  it("drops copies that are already gone", () => {
    const groups: DupGroup[] = [{ size: 700, ids: [1, 2, 3] }];
    const gone = (id: number): boolean => id === 1;
    assert.equal(reclaimableBytes(groups, flat(700), gone), 700);
    assert.equal(extraCopies(groups, gone), 1);
    // And once two of the three are gone, one copy is left and nothing is freed.
    assert.equal(reclaimableBytes(groups, flat(700), () => true), 0);
    assert.equal(extraCopies(groups, () => true), 0);
  });

  it("treats a missing or nonsensical on-disk size as nothing rather than as a negative", () => {
    const groups: DupGroup[] = [{ size: 100, ids: [1, 2] }];
    const onDisk = (id: number): number => (id === 1 ? Number.NaN : -5);
    assert.equal(reclaimableBytes(groups, onDisk, anyAlive), 0);
  });

  it("is zero when there is nothing to reclaim", () => {
    assert.equal(reclaimableBytes([], flat(1000), anyAlive), 0);
    assert.equal(extraCopies([], anyAlive), 0);
  });
});
