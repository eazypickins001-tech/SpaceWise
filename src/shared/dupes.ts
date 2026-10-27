// What a duplicate search is actually worth.
//
// Grouping is done on logical length, because two files can only hold identical
// content if they are the same length. What it *frees* is a different quantity:
// the space the copies occupy on disk. The two differ for compressed, sparse and
// cloud placeholder files, so this is kept separate on purpose and the interface
// must not use one in place of the other.
import type { DupGroup } from "./types";

// The most that deleting all but one copy of each set could free.
//
// It is an upper bound rather than a promise, because it assumes the largest
// copy on disk is the one kept, which is the best case for the person doing the
// deleting. Summing the logical length instead would overstate the saving on a
// compressed or sparse file and understate it where the cluster size dominates.
export function reclaimableBytes(
  groups: readonly DupGroup[],
  allocatedOf: (id: number) => number,
  isGone: (id: number) => boolean = () => false,
): number {
  let total = 0;
  for (const group of groups) {
    const sizes: number[] = [];
    for (const id of group.ids) {
      if (isGone(id)) continue;
      const onDisk = allocatedOf(id);
      sizes.push(Number.isFinite(onDisk) && onDisk > 0 ? onDisk : 0);
    }
    // One copy on its own is not a duplicate any more, and frees nothing.
    if (sizes.length < 2) continue;
    let sum = 0;
    let largest = 0;
    for (const s of sizes) {
      sum += s;
      if (s > largest) largest = s;
    }
    total += sum - largest;
  }
  return total;
}

// How many duplicate sets the free tier lists. A search returns its sets biggest
// saving first (see main/dupfind.ts), so the cap keeps the ones worth acting on,
// and the rest are counted rather than hidden. The premium feature
// "duplicates.unlimited" lifts it.
export const FREE_DUPLICATE_SETS = 20;

// The sets to draw and how many were left out. Pass Infinity to lift the cap.
export function capGroups(groups: readonly DupGroup[], limit: number): { shown: DupGroup[]; hidden: number } {
  if (groups.length <= limit) return { shown: groups.slice(), hidden: 0 };
  return { shown: groups.slice(0, limit), hidden: groups.length - limit };
}
