import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Disk } from "../lib/disk";
import type { Comparison } from "../lib/analysis";
import type { Fmt, T } from "../lib/i18n";
import { HEADER, K_DIR, K_DIR_LABELLED, K_FILE, K_PACK, K_REST, findRect, hitTest, layoutTreemap } from "../lib/treemap";
import type { Layout } from "../lib/treemap";

const FONT = '12px "Barlow", "Bahnschrift", "Segoe UI", sans-serif';
const MARK_FLOOR = 4 * 1024 * 1024;
const ZOOM_MS = 280;
const FADE_MS = 260;
const MORPH_MS = 480;
// Above this many blocks a frame takes too long to redraw; the change dissolves instead.
const MORPH_MAX = 14000;

// What is on the sheet right now, block by block, so the next drawing can start from it.
interface Shown {
  count: number;
  key: Float64Array;
  x: Float32Array;
  y: Float32Array;
  w: Float32Array;
  h: Float32Array;
}

interface Colors {
  paper: string;
  ink: string;
  ink2: string;
  line: string;
  lineStrong: string;
  tones: string[];
  onWeak: string;
  onStrong: string;
  red: string;
}

function readColors(): Colors {
  const s = getComputedStyle(document.documentElement);
  const v = (name: string): string => s.getPropertyValue(name).trim();
  return {
    paper: v("--paper"),
    ink: v("--ink"),
    ink2: v("--ink-2"),
    line: v("--line"),
    lineStrong: v("--line-strong"),
    tones: [v("--t1"), v("--t2"), v("--t3"), v("--t4"), v("--t5")],
    onWeak: v("--on-weak"),
    onStrong: v("--on-strong"),
    red: v("--red"),
  };
}

function hatch(ctx: CanvasRenderingContext2D, color: string, dpr: number): CanvasPattern | null {
  const size = Math.round(6 * dpr);
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  g.strokeStyle = color;
  g.lineWidth = Math.max(1, dpr);
  g.beginPath();
  g.moveTo(0, size);
  g.lineTo(size, 0);
  g.moveTo(-1, 1);
  g.lineTo(1, -1);
  g.moveTo(size - 1, size + 1);
  g.lineTo(size + 1, size - 1);
  g.stroke();
  return ctx.createPattern(c, "repeat");
}

function fit(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (max <= 8) return "";
  const w = ctx.measureText(text).width;
  if (w <= max) return text;
  let keep = Math.max(1, Math.floor((text.length * max) / w) - 1);
  while (keep > 1 && ctx.measureText(text.slice(0, keep) + "…").width > max) keep--;
  return keep > 1 ? text.slice(0, keep) + "…" : "";
}

// Share of the view decides the value of the ink: heavy things print darkest.
function tone(share: number): number {
  return share >= 0.05 ? 4 : share >= 0.012 ? 3 : share >= 0.003 ? 2 : share >= 0.0006 ? 1 : 0;
}

function drawPlan(
  ctx: CanvasRenderingContext2D,
  l: Layout,
  disk: Disk,
  root: number,
  c: Colors,
  dpr: number,
  fmt: Fmt,
  delta: Float64Array | null,
): void {
  const W = ctx.canvas.width / dpr;
  const H = ctx.canvas.height / dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = c.paper;
  ctx.fillRect(0, 0, W, H);
  ctx.font = FONT;
  ctx.textBaseline = "middle";
  const total = disk.size(root) || 1;
  const rest = hatch(ctx, c.lineStrong, dpr);

  for (let i = 0; i < l.count; i++) {
    const x0 = Math.round(l.x[i]);
    const y0 = Math.round(l.y[i]);
    const w = Math.round(l.x[i] + l.w[i]) - x0;
    const h = Math.round(l.y[i] + l.h[i]) - y0;
    if (w < 1 || h < 1) continue;
    const id = l.id[i];
    const kind = l.kind[i];
    const grew = delta !== null && kind !== K_REST && delta[id] >= MARK_FLOOR;

    if (kind === K_REST) {
      if (rest && w > 1 && h > 1) {
        ctx.fillStyle = rest;
        ctx.fillRect(x0, y0, w - 1, h - 1);
      }
      continue;
    }

    if (kind === K_FILE || kind === K_PACK) {
      const tn = tone(disk.size(id) / total);
      ctx.fillStyle = c.tones[tn];
      ctx.fillRect(x0, y0, Math.max(1, w - 1), Math.max(1, h - 1));
      // A closed folder keeps a wall, so it does not pass for one big file.
      if (kind === K_PACK && w > 4 && h > 4) {
        ctx.strokeStyle = c.ink;
        ctx.lineWidth = 1;
        ctx.strokeRect(x0 + 0.5, y0 + 0.5, w - 2, h - 2);
      }
      if (w >= 50 && h >= 17) {
        ctx.fillStyle = tn >= 3 ? c.onStrong : c.onWeak;
        const name = fit(ctx, disk.name(id), w - 10);
        if (h >= 34) {
          ctx.fillText(name, x0 + 5, y0 + 11);
          ctx.fillText(fit(ctx, fmt.bytes(disk.size(id)), w - 10), x0 + 5, y0 + 25);
        } else {
          ctx.fillText(name, x0 + 5, y0 + Math.min(h / 2, 11));
        }
      }
    } else {
      const depth = l.depth[i];
      if (depth > 0) {
        // Walls: the nearer to the sheet, the heavier the line.
        const weight = depth === 1 ? 2 : 1;
        ctx.strokeStyle = depth <= 2 ? c.ink : c.lineStrong;
        ctx.lineWidth = weight;
        if (w > weight * 2 && h > weight * 2) {
          ctx.strokeRect(x0 + weight / 2, y0 + weight / 2, w - weight - 1, h - weight - 1);
        } else {
          ctx.fillStyle = c.lineStrong;
          ctx.fillRect(x0, y0, Math.max(1, w - 1), Math.max(1, h - 1));
        }
      }
      if (kind === K_DIR_LABELLED && h >= HEADER && w >= 30) {
        const mid = y0 + HEADER / 2 + 1;
        const size = grew ? fmt.signedBytes(delta![id]) : fmt.bytes(disk.size(id));
        const sizeW = w >= 150 ? ctx.measureText(size).width : 0;
        ctx.font = (depth <= 1 ? "600 " : "500 ") + FONT;
        ctx.fillStyle = c.ink;
        ctx.fillText(fit(ctx, id === 0 ? disk.t.root : disk.name(id), w - 14 - (sizeW ? sizeW + 10 : 0)), x0 + 6, mid);
        ctx.font = FONT;
        if (sizeW) {
          ctx.fillStyle = grew ? c.red : c.ink2;
          ctx.fillText(size, x0 + w - sizeW - 7, mid);
        }
      }
    }

    if (grew && kind !== K_DIR_LABELLED && w >= 12 && h >= 12) {
      ctx.fillStyle = c.red;
      ctx.fillRect(x0 + w - 9, y0 + 2, 6, 6);
    }
  }
}

function outline(ctx: CanvasRenderingContext2D, l: Layout, i: number, color: string, inner: string): void {
  const x = Math.round(l.x[i]);
  const y = Math.round(l.y[i]);
  const w = Math.round(l.x[i] + l.w[i]) - x - 1;
  const h = Math.round(l.y[i] + l.h[i]) - y - 1;
  ctx.lineWidth = 2;
  ctx.strokeStyle = color;
  ctx.strokeRect(x + 1, y + 1, Math.max(1, w - 2), Math.max(1, h - 2));
  if (w > 8 && h > 8) {
    ctx.lineWidth = 1;
    ctx.strokeStyle = inner;
    ctx.strokeRect(x + 2.5, y + 2.5, w - 5, h - 5);
  }
}

interface Props {
  disk: Disk;
  version: number;
  theme: string;
  zoom: number;
  levels: number;
  selected: number;
  hover: number;
  fresh: Set<number>; // just added: outlined for a moment
  comparison: Comparison | null;
  showDelta: boolean;
  fmt: Fmt;
  t: T;
  onHover: (id: number) => void;
  onSelect: (id: number) => void;
  onZoom: (id: number) => void;
  onContext: (id: number, x: number, y: number) => void;
  onArea: (pixels: number) => void;
}

export const Treemap = memo(function Treemap(p: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const base = useRef<HTMLCanvasElement>(null);
  const over = useRef<HTMLCanvasElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [fonts, setFonts] = useState(0);
  const [tip, setTip] = useState<{ x: number; y: number; rect: number } | null>(null);
  const last = useRef<{ zoom: number; layout: Layout | null; disk: Disk | null; version: number; theme: string }>({
    zoom: -1,
    layout: null,
    disk: null,
    version: 0,
    theme: "",
  });
  const anim = useRef(0);
  const wheelAt = useRef(0);
  const shown = useRef<Shown | null>(null);
  const { disk, zoom, fmt, t, onArea } = p;

  useLayoutEffect(() => {
    const el = wrap.current!;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    void document.fonts.ready.then(() => setFonts(1));
  }, []);

  const layout = useMemo(
    () => layoutTreemap(disk, zoom, box.w, box.h, p.levels),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [disk, p.version, zoom, box.w, box.h, p.levels],
  );

  useEffect(() => onArea(box.w * box.h), [box, onArea]);

  const delta = p.showDelta && p.comparison ? p.comparison.delta : null;

  // The plan itself.
  useEffect(() => {
    const cv = base.current!;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.round(box.w * dpr));
    const H = Math.max(1, Math.round(box.h * dpr));
    const prev = last.current;
    cancelAnimationFrame(anim.current);

    // Keep the old drawing to animate from when the zoom level changes.
    let from: HTMLCanvasElement | null = null;
    const zooming = prev.disk === disk && prev.zoom !== zoom && prev.layout !== null && cv.width === W && cv.height === H;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // The same view with new numbers: a scan filling in, a paste, a file that
    // grew. Those dissolve from the old drawing into the new one.
    const refreshed =
      !zooming &&
      prev.layout !== null &&
      prev.theme === p.theme &&
      cv.width === W &&
      cv.height === H &&
      (prev.disk !== disk || prev.version !== p.version) &&
      (prev.disk === disk || prev.disk?.t.root === disk.t.root);
    if ((zooming || refreshed) && !still) {
      from = document.createElement("canvas");
      from.width = W;
      from.height = H;
      from.getContext("2d")!.drawImage(cv, 0, 0);
    }

    if (cv.width !== W) cv.width = W;
    if (cv.height !== H) cv.height = H;
    const ctx = cv.getContext("2d")!;
    const colors = readColors();

    // Each block is known by its path, so it can be followed from the last
    // drawing to this one even when the scan handed over a whole new table.
    const n = layout.count;
    const keys = new Float64Array(n);
    for (let i = 0; i < n; i++) keys[i] = disk.pathKey(layout.id[i]) + (layout.kind[i] === K_REST ? 0.5 : 0);
    const before = shown.current;
    const morphing = refreshed && !still && before !== null && n <= MORPH_MAX && before.count <= MORPH_MAX;

    if (morphing && before) {
      // Blocks that were already there travel from where they stood. A new
      // one grows from nothing, at the spot it takes inside its folder.
      const where = new Map<number, number>();
      for (let i = 0; i < before.count; i++) where.set(before.key[i], i);
      const sx = new Float32Array(n);
      const sy = new Float32Array(n);
      const sw = new Float32Array(n);
      const sh = new Float32Array(n);
      const chain: number[] = []; // the open folder at each depth
      for (let i = 0; i < n; i++) {
        const depth = layout.depth[i];
        chain[depth] = i;
        const o = where.get(keys[i]);
        if (o !== undefined) {
          sx[i] = before.x[o];
          sy[i] = before.y[o];
          sw[i] = before.w[o];
          sh[i] = before.h[o];
          continue;
        }
        const cx = layout.x[i] + layout.w[i] / 2;
        const cy = layout.y[i] + layout.h[i] / 2;
        const p = depth > 0 ? chain[depth - 1] : -1;
        if (p >= 0 && layout.w[p] > 0 && layout.h[p] > 0) {
          sx[i] = sx[p] + ((cx - layout.x[p]) * sw[p]) / layout.w[p];
          sy[i] = sy[p] + ((cy - layout.y[p]) * sh[p]) / layout.h[p];
        } else {
          sx[i] = cx;
          sy[i] = cy;
        }
      }
      const frame: Layout = {
        count: n,
        id: layout.id,
        depth: layout.depth,
        kind: layout.kind,
        x: new Float32Array(n),
        y: new Float32Array(n),
        w: new Float32Array(n),
        h: new Float32Array(n),
      };
      shown.current = { count: n, key: keys, x: frame.x, y: frame.y, w: frame.w, h: frame.h };
      const start = performance.now();
      const step = (now: number): void => {
        const k = Math.min(1, (now - start) / MORPH_MS);
        const e = 1 - Math.pow(1 - k, 3);
        for (let i = 0; i < n; i++) {
          frame.x[i] = sx[i] + (layout.x[i] - sx[i]) * e;
          frame.y[i] = sy[i] + (layout.y[i] - sy[i]) * e;
          frame.w[i] = sw[i] + (layout.w[i] - sw[i]) * e;
          frame.h[i] = sh[i] + (layout.h[i] - sh[i]) * e;
        }
        drawPlan(ctx, frame, disk, zoom, colors, dpr, fmt, delta);
        if (k < 1) anim.current = requestAnimationFrame(step);
      };
      step(start);
      if (MORPH_MS > 0) anim.current = requestAnimationFrame(step);
      from = null;
    } else {
      drawPlan(ctx, layout, disk, zoom, colors, dpr, fmt, delta);
      shown.current = { count: n, key: keys, x: layout.x, y: layout.y, w: layout.w, h: layout.h };
    }

    if (from && refreshed) {
      const to = document.createElement("canvas");
      to.width = W;
      to.height = H;
      to.getContext("2d")!.drawImage(cv, 0, 0);
      const old = from;
      const start = performance.now();
      const step = (now: number): void => {
        const k = Math.min(1, (now - start) / FADE_MS);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = 1;
        ctx.drawImage(old, 0, 0);
        ctx.globalAlpha = 1 - Math.pow(1 - k, 3);
        ctx.drawImage(to, 0, 0);
        ctx.globalAlpha = 1;
        if (k < 1) anim.current = requestAnimationFrame(step);
      };
      step(start);
      anim.current = requestAnimationFrame(step);
    } else if (from && prev.layout) {
      const goingIn = disk.contains(prev.zoom, zoom);
      // The room being entered or left, as it sits in the wider of the two views.
      const r = goingIn ? findRect(prev.layout, zoom) : findRect(layout, prev.zoom);
      const src = goingIn ? prev.layout : layout;
      if (r >= 0) {
        const to = document.createElement("canvas");
        to.width = W;
        to.height = H;
        to.getContext("2d")!.drawImage(cv, 0, 0);
        const outer = goingIn ? from : to; // the wider view
        const inner = goingIn ? to : from; // the room seen from inside
        const rx = src.x[r] * dpr;
        const ry = src.y[r] * dpr;
        const rw = Math.max(1, src.w[r] * dpr);
        const rh = Math.max(1, src.h[r] * dpr);
        const start = performance.now();
        const step = (now: number): void => {
          const k = Math.min(1, (now - start) / ZOOM_MS);
          const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
          const a = goingIn ? e : 1 - e; // 0: the wider view fills the sheet, 1: the room does
          // The camera's window on the wider view. It narrows geometrically,
          // so the zoom feels even from start to end.
          const vw = W * Math.pow(rw / W, a);
          const vh = H * Math.pow(rh / H, a);
          const vx = W - rw > 0.5 ? (rx * (W - vw)) / (W - rw) : 0;
          const vy = H - rh > 0.5 ? (ry * (H - vh)) / (H - rh) : 0;
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = "high";
          ctx.globalAlpha = 1;
          ctx.drawImage(outer, vx, vy, vw, vh, 0, 0, W, H);
          // The room's own drawing rides on the room and takes over as it
          // grows, so the picture stays sharp instead of ending on a jump.
          const sx = W / vw;
          const sy = H / vh;
          ctx.globalAlpha = Math.max(0, Math.min(1, (a - 0.1) / 0.45));
          ctx.drawImage(inner, (rx - vx) * sx, (ry - vy) * sy, rw * sx, rh * sy);
          ctx.globalAlpha = 1;
          if (k < 1) anim.current = requestAnimationFrame(step);
          else ctx.drawImage(to, 0, 0);
        };
        step(start);
        anim.current = requestAnimationFrame(step);
      }
    }
    last.current = { zoom, layout, disk, version: p.version, theme: p.theme };
    return () => cancelAnimationFrame(anim.current);
  }, [layout, disk, zoom, box, p.theme, fonts, fmt, delta, p.version]);

  // Hover and selection, on their own layer so the plan is not redrawn.
  useEffect(() => {
    const cv = over.current!;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.round(box.w * dpr));
    const H = Math.max(1, Math.round(box.h * dpr));
    if (cv.width !== W) cv.width = W;
    if (cv.height !== H) cv.height = H;
    const ctx = cv.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, box.w, box.h);
    const c = readColors();
    if (p.hover >= 0 && p.hover !== p.selected && p.hover !== zoom) {
      const i = findRect(layout, p.hover);
      if (i >= 0) outline(ctx, layout, i, c.ink, c.paper);
    }
    let marked = 0;
    for (const id of p.fresh) {
      if (marked++ > 60) break;
      const i = findRect(layout, id);
      if (i >= 0) outline(ctx, layout, i, c.tones[4], c.paper);
    }
    if (p.selected >= 0 && p.selected !== zoom) {
      const i = findRect(layout, p.selected);
      if (i >= 0) outline(ctx, layout, i, c.red, c.paper);
    }
  }, [layout, box, p.hover, p.selected, p.theme, zoom, p.fresh]);

  const at = (e: { clientX: number; clientY: number }): number => {
    const r = over.current!.getBoundingClientRect();
    return hitTest(layout, e.clientX - r.left, e.clientY - r.top);
  };

  // The child of the current view that holds this node: one level deeper.
  const stepIn = (id: number): number => {
    let n = disk.isDir(id) ? id : disk.parent(id);
    while (n > 0 && disk.parent(n) !== zoom && n !== zoom) n = disk.parent(n);
    return n;
  };

  const tipRect = tip && tip.rect < layout.count ? tip.rect : -1;
  const tipId = tipRect >= 0 ? layout.id[tipRect] : -1;
  const tipRest = tipRect >= 0 && layout.kind[tipRect] === K_REST;

  return (
    <div className="plan" ref={wrap}>
      <canvas ref={base} />
      <canvas
        ref={over}
        role="img"
        aria-label={disk.path(zoom)}
        onMouseMove={(e) => {
          const i = at(e);
          setTip(i >= 0 ? { x: e.clientX, y: e.clientY, rect: i } : null);
          p.onHover(i >= 0 ? layout.id[i] : -1);
        }}
        onMouseLeave={() => {
          setTip(null);
          p.onHover(-1);
        }}
        onClick={(e) => {
          const i = at(e);
          if (i >= 0) p.onSelect(layout.id[i]);
        }}
        onDoubleClick={(e) => {
          const i = at(e);
          if (i < 0) return;
          const id = layout.id[i];
          const dir = disk.isDir(id) ? id : disk.parent(id);
          if (dir !== zoom) p.onZoom(dir);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          const i = at(e);
          if (i >= 0 && layout.kind[i] !== K_REST) {
            p.onSelect(layout.id[i]);
            p.onContext(layout.id[i], e.clientX, e.clientY);
          }
        }}
        onWheel={(e) => {
          // One step per gesture: a trackpad sends dozens of wheel events.
          if (e.timeStamp - wheelAt.current < 320) return;
          wheelAt.current = e.timeStamp;
          if (e.deltaY > 0) {
            if (zoom > 0) p.onZoom(disk.parent(zoom));
          } else {
            const i = at(e);
            if (i < 0) return;
            const next = stepIn(layout.id[i]);
            if (next !== zoom && next > 0) p.onZoom(next);
          }
        }}
      />
      {tip && tipId >= 0 && (
        <div
          className="tip"
          style={{
            left: Math.min(tip.x + 14, window.innerWidth - 300),
            top: tip.y + 18 > window.innerHeight - 90 ? tip.y - 70 : tip.y + 18,
          }}
        >
          <div className="n">{tipRest ? t("tip.rest", { name: disk.name(tipId) }) : tipId === 0 ? disk.t.root : disk.name(tipId)}</div>
          {!tipRest && (
            <div className="m">
              {fmt.bytes(disk.size(tipId))}, {t("tip.ofView", { pct: fmt.pct(disk.size(tipId) / (disk.size(zoom) || 1)) })}
              {disk.isDir(tipId) ? ", " + t("tip.files", { count: fmt.count(disk.files(tipId)) }) : ""}
            </div>
          )}
          {delta && !tipRest && Math.abs(delta[tipId]) >= MARK_FLOOR && <div className="m">{fmt.signedBytes(delta[tipId])}</div>}
        </div>
      )}
    </div>
  );
});

export { K_DIR };
