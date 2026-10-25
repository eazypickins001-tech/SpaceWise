import { F_DIR, F_ERR, F_GONE, F_LINK } from "../../../shared/types";
import type { ScanTable } from "../../../shared/types";

const decoder = new TextDecoder();

// What can be added to a scan after the fact.
export type Graftable =
  | { kind: "file"; name: string; size: number; mtime: number; logical?: number; flags?: number }
  | { kind: "dir"; name: string; table: ScanTable };

// Read access to one scan, plus the few edits the app makes after it
// (marking nodes removed and resorting a folder on demand).
export class Disk {
  readonly t: ScanTable;
  readonly sep: string;
  private nameCache = new Map<number, string>();
  private haystack: string | null = null;

  constructor(table: ScanTable) {
    this.t = table;
    this.sep = table.root.includes("/") && !table.root.includes("\\") ? "/" : "\\";
  }

  get n(): number {
    return this.t.n;
  }
  size(id: number): number {
    return this.t.size[id];
  }
  logical(id: number): number {
    return this.t.logical[id];
  }
  parent(id: number): number {
    return this.t.parent[id];
  }
  isDir(id: number): boolean {
    return (this.t.flags[id] & F_DIR) !== 0;
  }
  isLink(id: number): boolean {
    return (this.t.flags[id] & F_LINK) !== 0;
  }
  hasError(id: number): boolean {
    return (this.t.flags[id] & F_ERR) !== 0;
  }
  isGone(id: number): boolean {
    return (this.t.flags[id] & F_GONE) !== 0;
  }
  files(id: number): number {
    return this.isDir(id) ? this.t.files[id] : 1;
  }
  ext(id: number): string {
    return this.t.exts[this.t.ext[id]];
  }

  name(id: number): string {
    let s = this.nameCache.get(id);
    if (s === undefined) {
      s = decoder.decode(this.t.names.subarray(this.t.nameOff[id], this.t.nameOff[id + 1]));
      if (this.nameCache.size > 200_000) this.nameCache.clear();
      this.nameCache.set(id, s);
    }
    return s;
  }

  path(id: number): string {
    const parts: string[] = [];
    for (let i = id; i > 0; i = this.t.parent[i]) parts.push(this.name(i));
    const root = this.t.root;
    if (parts.length === 0) return root;
    return (root.endsWith(this.sep) ? root : root + this.sep) + parts.reverse().join(this.sep);
  }

  // The names from the root down to a node, and the way back. Used to carry
  // a position from one table to the next, where ids differ.
  trail(id: number): string[] {
    const out: string[] = [];
    for (let i = id; i > 0; i = this.t.parent[i]) out.push(this.name(i));
    return out.reverse();
  }
  follow(trail: string[]): number {
    let at = 0;
    for (const name of trail) {
      let next = -1;
      for (const c of this.children(at)) {
        if (this.name(c) === name) {
          next = c;
          break;
        }
      }
      if (next === -1) return -1;
      at = next;
    }
    return at;
  }

  // The node for an absolute path, or -1 when it is not part of this scan.
  findPath(path: string): number {
    const norm = (p: string): string => p.replace(/[\\/]+/g, this.sep).replace(/[\\/]$/, "").toLowerCase();
    const root = norm(this.t.root);
    const full = norm(path);
    if (full === root) return 0;
    if (!full.startsWith(root + this.sep)) return -1;
    const names = path.replace(/[\\/]+/g, this.sep).replace(/[\\/]$/, "").slice(root.length + 1).split(this.sep);
    let at = 0;
    for (const name of names) {
      const want = name.toLowerCase();
      let next = -1;
      for (const c of this.children(at)) {
        if (this.name(c).toLowerCase() === want) {
          next = c;
          break;
        }
      }
      if (next === -1) return -1;
      at = next;
    }
    return at;
  }

  // Adds freshly measured files and folders, each under its `parent`, in one
  // pass. Ids already in use do not change: the new nodes are appended.
  // Returns the id given to each addition, in order.
  graftAll(adds: { parent: number; item: Graftable }[]): number[] {
    if (adds.length === 0) return [];
    const t = this.t as { -readonly [K in keyof ScanTable]: ScanTable[K] };
    const enc = new TextEncoder();
    const n0 = t.n;
    let m = 0;
    let nameBytes = 0;
    const plan = adds.map((a) => {
      const sub = a.item.kind === "dir" ? a.item.table : null;
      const rootName = enc.encode(a.item.name);
      const base = n0 + m;
      const namesAt = t.names.length + nameBytes;
      m += sub ? sub.n : 1;
      nameBytes += rootName.length + (sub ? sub.names.length - sub.nameOff[1] : 0);
      return { parent: a.parent, item: a.item, sub, rootName, base, namesAt };
    });
    const n1 = n0 + m;

    const grow = <A extends Int32Array | Float64Array | Uint32Array | Uint8Array | Uint16Array>(a: A, len: number): A => {
      const b = new (a.constructor as new (n: number) => A)(len);
      b.set(a.subarray(0, Math.min(a.length, len)));
      return b;
    };
    const parentCol = grow(t.parent, n1);
    const size = grow(t.size, n1);
    const logical = grow(t.logical, n1);
    const mtime = grow(t.mtime, n1);
    const flags = grow(t.flags, n1);
    const files = grow(t.files, n1);
    const ext = grow(t.ext, n1);
    const nameOff = grow(t.nameOff, n1 + 1);
    const names = new Uint8Array(t.names.length + nameBytes);
    names.set(t.names);

    const extId = (e: string): number => {
      let at = t.exts.indexOf(e);
      if (at === -1 && t.exts.length < 0xffff) at = t.exts.push(e) - 1;
      return Math.max(0, at);
    };

    for (const p of plan) {
      const { sub, base, item } = p;
      names.set(p.rootName, p.namesAt);
      nameOff[base + 1] = p.namesAt + p.rootName.length;
      parentCol[base] = p.parent;
      if (sub) {
        names.set(sub.names.subarray(sub.nameOff[1]), nameOff[base + 1]);
        // Extensions are indexes into a per-table list; translate them.
        const extMap = sub.exts.map(extId);
        const shift = nameOff[base + 1] - sub.nameOff[1];
        for (let j = 0; j < sub.n; j++) {
          const id = base + j;
          if (j > 0) {
            parentCol[id] = base + sub.parent[j];
            nameOff[id + 1] = sub.nameOff[j + 1] + shift;
          }
          size[id] = sub.size[j];
          logical[id] = sub.logical[j];
          mtime[id] = sub.mtime[j];
          flags[id] = sub.flags[j];
          files[id] = sub.files[j];
          ext[id] = extMap[sub.ext[j]] ?? 0;
        }
      } else if (item.kind === "file") {
        size[base] = item.size;
        logical[base] = item.logical ?? item.size;
        mtime[base] = item.mtime;
        flags[base] = item.flags ?? 0;
        const dot = item.name.lastIndexOf(".");
        if (dot > 0 && dot < item.name.length - 1 && item.name.length - dot <= 12) ext[base] = extId(item.name.slice(dot + 1).toLowerCase());
      }
    }

    // Children lists: every folder keeps its order and gains its new entries.
    const childStart = new Int32Array(n1 + 1);
    for (let i = 0; i < n0; i++) childStart[i + 1] = t.childStart[i + 1] - t.childStart[i];
    for (const p of plan) {
      childStart[p.parent + 1]++;
      if (p.sub) for (let j = 0; j < p.sub.n; j++) childStart[p.base + j + 1] = p.sub.childStart[j + 1] - p.sub.childStart[j];
    }
    for (let i = 0; i < n1; i++) childStart[i + 1] += childStart[i];
    const childList = new Int32Array(Math.max(0, n1 - 1));
    for (let i = 0; i < n0; i++) childList.set(t.childList.subarray(t.childStart[i], t.childStart[i + 1]), childStart[i]);
    const tail = new Map<number, number>(); // next free slot at the end of each parent's range
    for (const p of plan) {
      const used = tail.get(p.parent) ?? t.childStart[p.parent + 1] - t.childStart[p.parent];
      childList[childStart[p.parent] + used] = p.base;
      tail.set(p.parent, used + 1);
      if (p.sub) {
        for (let j = 0; j < p.sub.n; j++) {
          const from = p.sub.childList.subarray(p.sub.childStart[j], p.sub.childStart[j + 1]);
          const at = childStart[p.base + j];
          for (let k = 0; k < from.length; k++) childList[at + k] = p.base + from[k];
        }
      }
    }

    Object.assign(t, { n: n1, parent: parentCol, size, logical, mtime, flags, files, ext, nameOff, names, childStart, childList });
    const touched = new Set<number>();
    for (const p of plan) {
      const addFiles = t.flags[p.base] & F_DIR ? t.files[p.base] : 1;
      if (p.sub) t.dirs += p.sub.dirs;
      for (let a = p.parent; a >= 0; a = t.parent[a]) {
        t.size[a] += t.size[p.base];
        t.logical[a] += t.logical[p.base];
        t.files[a] += addFiles;
        if (t.mtime[p.base] > t.mtime[a]) t.mtime[a] = t.mtime[p.base];
        touched.add(a);
      }
    }
    for (const a of touched) this.resort(a);
    this.nameCache.clear();
    this.haystack = null;
    return plan.map((p) => p.base);
  }

  graft(parent: number, item: Graftable): number {
    return this.graftAll([{ parent, item }])[0];
  }

  // A file that changed on disk: new sizes, and the difference carried up.
  resize(id: number, size: number, logical: number, mtime: number): void {
    const t = this.t;
    const dSize = size - t.size[id];
    const dLogical = logical - t.logical[id];
    t.size[id] = size;
    t.logical[id] = logical;
    t.mtime[id] = mtime;
    for (let p = t.parent[id]; p >= 0; p = t.parent[p]) {
      t.size[p] += dSize;
      t.logical[p] += dLogical;
      if (mtime > t.mtime[p]) t.mtime[p] = mtime;
      this.resort(p);
    }
  }

  // A number that stands for a node's path. Two scans of the same place give
  // the same number to the same item even though their ids differ, which is
  // what lets the plan follow a block from one drawing to the next.
  private keys = new Map<number, number>();
  pathKey(id: number): number {
    if (id <= 0) return 1;
    let k = this.keys.get(id);
    if (k !== undefined) return k;
    const pk = this.pathKey(this.t.parent[id]);
    let h1 = (pk ^ 0x811c9dc5) >>> 0;
    let h2 = (Math.floor(pk / 4294967296) + 0x9e3779b1) >>> 0;
    const names = this.t.names;
    for (let i = this.t.nameOff[id], e = this.t.nameOff[id + 1]; i < e; i++) {
      h1 = Math.imul(h1 ^ names[i], 16777619) >>> 0;
      h2 = (Math.imul(h2, 31) + names[i]) >>> 0;
    }
    k = (h2 & 0xfffff) * 4294967296 + h1;
    this.keys.set(id, k);
    return k;
  }

  // Root first, the node itself last.
  ancestors(id: number): number[] {
    const out: number[] = [];
    for (let i = id; i >= 0; i = this.t.parent[i]) out.push(i);
    return out.reverse();
  }

  depth(id: number): number {
    let d = 0;
    for (let i = this.t.parent[id]; i >= 0; i = this.t.parent[i]) d++;
    return d;
  }

  contains(ancestor: number, id: number): boolean {
    for (let i = id; i >= 0; i = this.t.parent[i]) if (i === ancestor) return true;
    return false;
  }

  // Children, largest first. Removed nodes sort last and are cut off.
  children(id: number): Int32Array {
    const s = this.t.childStart[id];
    let e = this.t.childStart[id + 1];
    const list = this.t.childList;
    while (e > s && this.t.flags[list[e - 1]] & F_GONE) e--;
    return list.subarray(s, e);
  }

  // Marks a node as removed and takes its weight off every ancestor.
  remove(id: number): void {
    if (this.isDir(id)) this.t.dirs = Math.max(1, this.t.dirs - 1);
    const t = this.t;
    if (id <= 0 || t.flags[id] & F_GONE) return;
    const bytes = t.size[id];
    const length = t.logical[id];
    const count = this.files(id);
    t.flags[id] |= F_GONE;
    for (let p = t.parent[id], child = id; p >= 0; child = p, p = t.parent[p]) {
      t.size[p] -= bytes;
      t.logical[p] -= length;
      t.files[p] -= count;
      this.resort(p);
    }
    t.size[id] = 0;
    this.resort(t.parent[id]);
  }

  private resort(dir: number): void {
    const t = this.t;
    const gone = (i: number): number => (t.flags[i] & F_GONE ? 1 : 0);
    t.childList
      .subarray(t.childStart[dir], t.childStart[dir + 1])
      .sort((a, b) => gone(a) - gone(b) || t.size[b] - t.size[a] || a - b);
  }

  // Every name as one string with one character per byte, so a substring
  // search runs natively and a match offset maps back to a node.
  private names1(): string {
    if (this.haystack === null) {
      const bytes = this.t.names;
      const parts: string[] = [];
      const STEP = 1 << 15;
      for (let i = 0; i < bytes.length; i += STEP) {
        parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + STEP) as unknown as number[]));
      }
      this.haystack = parts.join("").toLowerCase();
    }
    return this.haystack;
  }

  private nodeAtOffset(off: number): number {
    const o = this.t.nameOff;
    let lo = 0;
    let hi = this.t.n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (o[mid] <= off) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  // Ids whose name contains the query, case insensitive. Stops at `limit`.
  search(query: string, limit: number): number[] {
    const bytes = new TextEncoder().encode(query);
    const needle = String.fromCharCode.apply(null, bytes as unknown as number[]).toLowerCase();
    if (needle.length === 0) return [];
    const hay = this.names1();
    const o = this.t.nameOff;
    const out: number[] = [];
    let at = hay.indexOf(needle, o[1]); // skip the root
    while (at !== -1 && out.length < limit) {
      const id = this.nodeAtOffset(at);
      // A match may not run across the border between two names.
      if (at + needle.length <= o[id + 1] && !(this.t.flags[id] & F_GONE)) out.push(id);
      at = hay.indexOf(needle, Math.max(at + 1, o[id + 1] - needle.length + 1));
      if (at !== -1 && at < o[id + 1] && out[out.length - 1] === id) at = hay.indexOf(needle, o[id + 1]);
    }
    return out;
  }
}
