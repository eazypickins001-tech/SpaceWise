import type { Disk } from "./disk";

// Squarified treemap. Folders nest, with a label strip when there is room.
// Work is bounded by pixels, not by file count: once items fall under
// MIN_AREA the remainder of the folder becomes a single "rest" cell.

export const HEADER = 17;
const MIN_AREA = 12;
const MAX_RECTS = 90_000;

export interface Layout {
  count: number;
  id: Int32Array; // node id, or the parent id for a rest cell
  x: Float32Array;
  y: Float32Array;
  w: Float32Array;
  h: Float32Array;
  depth: Uint8Array;
  kind: Uint8Array; // K_FILE, K_DIR, K_DIR_LABELLED, K_REST
}

export const K_FILE = 0;
export const K_DIR = 1;
export const K_DIR_LABELLED = 2;
export const K_REST = 3;
export const K_PACK = 4; // a folder past the level limit, drawn as one solid block

// `levels` is how many levels of folders open up as rooms below the root.
export function layoutTreemap(disk: Disk, root: number, width: number, height: number, levels = Infinity): Layout {
  const out: Layout = {
    count: 0,
    id: new Int32Array(4096),
    x: new Float32Array(4096),
    y: new Float32Array(4096),
    w: new Float32Array(4096),
    h: new Float32Array(4096),
    depth: new Uint8Array(4096),
    kind: new Uint8Array(4096),
  };

  const push = (id: number, x: number, y: number, w: number, h: number, depth: number, kind: number): void => {
    if (out.count === out.id.length) {
      const cap = out.count * 2;
      const grow = <T extends Int32Array | Float32Array | Uint8Array>(a: T): T => {
        const b = new (a.constructor as new (n: number) => T)(cap);
        b.set(a);
        return b;
      };
      out.id = grow(out.id);
      out.x = grow(out.x);
      out.y = grow(out.y);
      out.w = grow(out.w);
      out.h = grow(out.h);
      out.depth = grow(out.depth);
      out.kind = grow(out.kind);
    }
    const i = out.count++;
    out.id[i] = id;
    out.x[i] = x;
    out.y[i] = y;
    out.w[i] = w;
    out.h[i] = h;
    out.depth[i] = Math.min(depth, 255);
    out.kind[i] = kind;
  };

  const place = (id: number, x: number, y: number, w: number, h: number, depth: number): void => {
    if (out.count >= MAX_RECTS) return;
    if (!disk.isDir(id)) {
      push(id, x, y, w, h, depth, K_FILE);
      return;
    }
    if (depth > levels) {
      push(id, x, y, w, h, depth, K_PACK);
      return;
    }
    const labelled = w >= 46 && h >= HEADER + 14;
    push(id, x, y, w, h, depth, labelled ? K_DIR_LABELLED : K_DIR);
    const pad = w > 14 && h > 14 ? 2 : w > 6 && h > 6 ? 1 : 0;
    const ix = x + pad;
    const iy = y + (labelled ? HEADER : pad);
    const iw = w - pad * 2;
    const ih = h - (labelled ? HEADER + pad : pad * 2);
    if (iw < 3 || ih < 3) return;
    squarify(id, ix, iy, iw, ih, depth + 1);
  };

  const squarify = (dir: number, x: number, y: number, w: number, h: number, depth: number): void => {
    const kids = disk.children(dir);
    const total = disk.size(dir);
    if (total <= 0 || kids.length === 0) return;
    const scale = (w * h) / total;
    let i = 0;
    while (i < kids.length && w > 0.5 && h > 0.5) {
      const first = disk.size(kids[i]) * scale;
      if (first < MIN_AREA) {
        if (first > 0) push(dir, x, y, w, h, depth, K_REST);
        return;
      }
      const short = Math.min(w, h);
      const s2 = short * short;
      let sum = 0;
      let min = Infinity;
      let max = 0;
      let worst = Infinity;
      let j = i;
      while (j < kids.length) {
        const a = disk.size(kids[j]) * scale;
        if (a < MIN_AREA) break;
        const nsum = sum + a;
        const nmax = Math.max(max, a);
        const nmin = Math.min(min, a);
        const ratio = Math.max((s2 * nmax) / (nsum * nsum), (nsum * nsum) / (s2 * nmin));
        if (j > i && ratio > worst) break;
        sum = nsum;
        max = nmax;
        min = nmin;
        worst = ratio;
        j++;
      }
      const thick = sum / short;
      if (w >= h) {
        let cy = y;
        for (let k = i; k < j; k++) {
          const hh = (disk.size(kids[k]) * scale) / thick;
          place(kids[k], x, cy, thick, hh, depth);
          cy += hh;
        }
        x += thick;
        w -= thick;
      } else {
        let cx = x;
        for (let k = i; k < j; k++) {
          const ww = (disk.size(kids[k]) * scale) / thick;
          place(kids[k], cx, y, ww, thick, depth);
          cx += ww;
        }
        y += thick;
        h -= thick;
      }
      i = j;
    }
  };

  if (width > 2 && height > 2 && disk.size(root) > 0) place(root, 0, 0, width, height, 0);
  return out;
}

// Deepest cell under a point. Children come after their parent in the list.
export function hitTest(l: Layout, px: number, py: number): number {
  for (let i = l.count - 1; i >= 0; i--) {
    if (px >= l.x[i] && py >= l.y[i] && px < l.x[i] + l.w[i] && py < l.y[i] + l.h[i]) return i;
  }
  return -1;
}

export function findRect(l: Layout, id: number): number {
  for (let i = 0; i < l.count; i++) if (l.id[i] === id && l.kind[i] !== K_REST) return i;
  return -1;
}
