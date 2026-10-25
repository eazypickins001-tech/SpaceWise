import { F_DIR, F_GONE } from "./types";
import type { ScanTable, SnapshotMeta } from "./types";

// A scan cut down to what the history needs: every folder plus the large
// files. Used by the scanner when a scan ends and by the window when live
// sync is switched off.
export const BIG_FILE = 8 * 1024 * 1024;

export interface Reduced {
  meta: Omit<SnapshotMeta, "file">;
  n: number;
  parent: Int32Array;
  size: Float64Array;
  flags: Uint8Array;
  nameOff: Uint32Array;
  names: Uint8Array;
}

export function reduceTable(t: ScanTable, date: number): Reduced {
  // A removed folder takes everything under it along. Parents always come
  // before their children, so one forward pass is enough.
  const dead = new Uint8Array(t.n);
  const remap = new Int32Array(t.n).fill(-1);
  let n = 0;
  let nameBytes = 0;
  for (let i = 0; i < t.n; i++) {
    if (i > 0 && (t.flags[i] & F_GONE || dead[t.parent[i]])) {
      dead[i] = 1;
      continue;
    }
    if (i === 0 || t.flags[i] & F_DIR || t.size[i] >= BIG_FILE) {
      remap[i] = n++;
      nameBytes += t.nameOff[i + 1] - t.nameOff[i];
    }
  }
  const parent = new Int32Array(n);
  const size = new Float64Array(n);
  const flags = new Uint8Array(n);
  const nameOff = new Uint32Array(n + 1);
  const names = new Uint8Array(nameBytes);
  let off = 0;
  for (let i = 0; i < t.n; i++) {
    const j = remap[i];
    if (j === -1) continue;
    parent[j] = i === 0 ? -1 : remap[t.parent[i]];
    size[j] = t.size[i];
    flags[j] = t.flags[i];
    names.set(t.names.subarray(t.nameOff[i], t.nameOff[i + 1]), off);
    off += t.nameOff[i + 1] - t.nameOff[i];
    nameOff[j + 1] = off;
  }
  return { meta: { root: t.root, date, total: t.size[0], files: t.files[0] }, n, parent, size, flags, nameOff, names };
}
