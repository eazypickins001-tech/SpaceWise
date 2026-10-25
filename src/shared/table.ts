// Turns the raw list of entries a scan collects into the table the interface
// reads. Shared by the desktop scanner and the Android build, so both draw
// exactly the same plan from the same entries.
import { F_DIR } from "./types";
import type { ScanIssue, ScanTable } from "./types";

// Entries in the order they were found. Every parent index is lower than its
// children. The arrays may be longer than `n`; only the first `n` count.
export interface RawScan {
  root: string;
  n: number;
  parent: Int32Array;
  size: Float64Array;
  logical: Float64Array;
  mtime: Uint32Array;
  flags: Uint8Array;
  nameOff: Uint32Array; // n + 1 offsets into names
  names: Uint8Array;
}

export interface ScanFacts {
  startedAt: number;
  durationMs: number;
  dirs: number;
  errors: number;
  errorSamples: ScanIssue[];
  incomplete?: boolean;
}

// Children of each folder as one flat list, largest first.
function childrenOf(n: number, parent: Int32Array, size: Float64Array): { childStart: Int32Array; childList: Int32Array } {
  const childStart = new Int32Array(n + 1);
  for (let i = 1; i < n; i++) childStart[parent[i] + 1]++;
  for (let i = 0; i < n; i++) childStart[i + 1] += childStart[i];
  const fill = childStart.slice(0, n);
  const childList = new Int32Array(Math.max(0, n - 1));
  for (let i = 1; i < n; i++) childList[fill[parent[i]]++] = i;
  const bySize = (a: number, b: number): number => size[b] - size[a] || a - b;
  for (let i = 0; i < n; i++) {
    const s = childStart[i];
    const e = childStart[i + 1];
    if (e - s > 1) childList.subarray(s, e).sort(bySize);
  }
  return { childStart, childList };
}

// The whole scan, with sizes summed upward and file types indexed.
export function finishTable(raw: RawScan, facts: ScanFacts): ScanTable {
  const count = raw.n;
  const tParent = raw.parent.slice(0, count);
  const tSize = raw.size.slice(0, count);
  const tLogical = raw.logical.slice(0, count);
  const tMtime = raw.mtime.slice(0, count);
  const tFlags = raw.flags.slice(0, count);
  const tNameOff = raw.nameOff.slice(0, count + 1);
  const tNames = raw.names.slice(0, tNameOff[count]);
  const files = new Uint32Array(count);

  // Sum sizes, file counts and newest change upward.
  for (let i = count - 1; i >= 1; i--) {
    const p = tParent[i];
    tSize[p] += tSize[i];
    tLogical[p] += tLogical[i];
    files[p] += tFlags[i] & F_DIR ? files[i] : 1;
    if (tMtime[i] > tMtime[p]) tMtime[p] = tMtime[i];
  }
  const { childStart, childList } = childrenOf(count, tParent, tSize);

  // Extension of each file, as an index into a small table.
  const ext = new Uint16Array(count);
  const exts: string[] = [""];
  const extIds = new Map<string, number>();
  for (let i = 1; i < count; i++) {
    if (tFlags[i] & F_DIR) continue;
    const s = tNameOff[i];
    const e = tNameOff[i + 1];
    let dot = -1;
    for (let k = e - 1; k > s && k >= e - 12; k--) {
      if (tNames[k] === 0x2e) {
        dot = k;
        break;
      }
    }
    if (dot === -1 || dot === e - 1) continue;
    let key = "";
    let ascii = true;
    for (let k = dot + 1; k < e; k++) {
      let c = tNames[k];
      if (c > 0x7f || c === 0x20) {
        ascii = false;
        break;
      }
      if (c >= 0x41 && c <= 0x5a) c += 32;
      key += String.fromCharCode(c);
    }
    if (!ascii) continue;
    let id = extIds.get(key);
    if (id === undefined) {
      if (exts.length >= 0xffff) continue;
      id = exts.length;
      exts.push(key);
      extIds.set(key, id);
    }
    ext[i] = id;
  }

  return {
    root: raw.root,
    n: count,
    parent: tParent,
    size: tSize,
    logical: tLogical,
    mtime: tMtime,
    flags: tFlags,
    files,
    nameOff: tNameOff,
    names: tNames,
    childStart,
    childList,
    ext,
    exts,
    ...facts,
    incomplete: facts.incomplete || undefined,
  };
}

// The top `depth` levels of a scan still running. A folder at the cut is
// kept as a solid block, so its weight still shows on the plan.
export function previewTable(raw: RawScan, depth: number, facts: ScanFacts): ScanTable {
  const { parent, flags, nameOff, names } = raw;
  const count = raw.n;
  const sz = raw.size.slice(0, count);
  const lg = raw.logical.slice(0, count);
  const mt = raw.mtime.slice(0, count);
  const fc = new Uint32Array(count);
  const level = new Uint8Array(count);
  for (let i = 1; i < count; i++) level[i] = Math.min(254, level[parent[i]] + 1);
  for (let i = count - 1; i >= 1; i--) {
    const p = parent[i];
    sz[p] += sz[i];
    lg[p] += lg[i];
    fc[p] += flags[i] & F_DIR ? fc[i] : 1;
    if (mt[i] > mt[p]) mt[p] = mt[i];
  }

  const remap = new Int32Array(count).fill(-1);
  let m = 0;
  let nameBytes = 0;
  for (let i = 0; i < count; i++) {
    if (level[i] <= depth) {
      remap[i] = m++;
      nameBytes += nameOff[i + 1] - nameOff[i];
    }
  }
  const tParent = new Int32Array(m);
  const tSize = new Float64Array(m);
  const tLogical = new Float64Array(m);
  const tMtime = new Uint32Array(m);
  const tFlags = new Uint8Array(m);
  const tFiles = new Uint32Array(m);
  const tNameOff = new Uint32Array(m + 1);
  const tNames = new Uint8Array(nameBytes);
  let off = 0;
  for (let i = 0; i < count; i++) {
    const j = remap[i];
    if (j === -1) continue;
    tParent[j] = i === 0 ? -1 : remap[parent[i]];
    tSize[j] = sz[i];
    tLogical[j] = lg[i];
    tMtime[j] = mt[i];
    tFiles[j] = fc[i];
    tFlags[j] = level[i] === depth ? flags[i] & ~F_DIR : flags[i];
    tNames.set(names.subarray(nameOff[i], nameOff[i + 1]), off);
    off += nameOff[i + 1] - nameOff[i];
    tNameOff[j + 1] = off;
  }
  const { childStart, childList } = childrenOf(m, tParent, tSize);

  return {
    root: raw.root,
    n: m,
    parent: tParent,
    size: tSize,
    logical: tLogical,
    mtime: tMtime,
    flags: tFlags,
    files: tFiles,
    nameOff: tNameOff,
    names: tNames,
    childStart,
    childList,
    ext: new Uint16Array(m),
    exts: [""],
    ...facts,
    errorSamples: [],
    incomplete: undefined,
  };
}

// The buffers of a table, to hand it to another thread without copying.
export function tableBuffers(t: ScanTable): ArrayBuffer[] {
  return [t.parent, t.size, t.logical, t.mtime, t.flags, t.files, t.nameOff, t.names, t.childStart, t.childList, t.ext].map(
    (a) => a.buffer as ArrayBuffer,
  );
}
