// Test-only helpers. Not imported by the application, so nothing here reaches a
// production bundle: the glob that runs the suite is `src/shared/*.test.ts`.
import { F_DIR } from "./types";
import { finishTable } from "./table";
import type { RawScan, ScanFacts } from "./table";
import type { ScanTable } from "./types";
import type { ScanView } from "./storage-intelligence";

export interface Spec {
  name: string;
  size?: number;
  logical?: number;
  mtime?: number;
  flags?: number;
  children?: Spec[];
}

// Builds the flat, parent-before-children layout the scanner produces, so tests
// exercise the real input shape rather than a convenient one. The root's own
// name is empty, matching what the scanner emits for node 0.
export function build(root: string, spec: Spec): RawScan {
  const parent: number[] = [];
  const size: number[] = [];
  const logical: number[] = [];
  const mtime: number[] = [];
  const flags: number[] = [];
  const names: number[] = [];
  const nameOff: number[] = [0];
  const enc = new TextEncoder();

  const walk = (s: Spec, p: number, isRoot: boolean): number => {
    const dir = s.children !== undefined && s.children.length > 0;
    const id = parent.length;
    parent.push(p);
    size.push(s.size ?? 0);
    logical.push(s.logical ?? s.size ?? 0);
    mtime.push(s.mtime ?? 0);
    flags.push(s.flags ?? (dir ? F_DIR : 0));
    for (const b of enc.encode(isRoot ? "" : s.name)) names.push(b);
    nameOff.push(names.length);
    if (s.children) for (const c of s.children) walk(c, id, false);
    return id;
  };
  walk(spec, -1, true);

  return {
    root,
    n: parent.length,
    parent: Int32Array.from(parent),
    size: Float64Array.from(size),
    logical: Float64Array.from(logical),
    mtime: Uint32Array.from(mtime),
    flags: Uint8Array.from(flags),
    nameOff: Uint32Array.from(nameOff),
    names: Uint8Array.from(names),
  };
}

export function facts(over: Partial<ScanFacts> = {}): ScanFacts {
  return { startedAt: 1_700_000_000_000, durationMs: 42, dirs: 2, errors: 0, errorSamples: [], ...over };
}

export function table(root: string, spec: Spec): ScanTable {
  return finishTable(build(root, spec), facts());
}

const decoder = new TextDecoder();

// A read-only view over a finished table. The renderer passes its real `Disk`
// object instead; this one exists so the analysis modules can be tested with no
// Electron and no filesystem.
export function tableView(t: ScanTable): ScanView {
  const sep = t.root.includes("/") && !t.root.includes("\\") ? "/" : "\\";
  const name = (id: number): string => decoder.decode(t.names.subarray(t.nameOff[id], t.nameOff[id + 1]));
  const path = (id: number): string => {
    const parts: string[] = [];
    for (let i = id; i > 0; i = t.parent[i]) parts.push(name(i));
    if (parts.length === 0) return t.root;
    return (t.root.endsWith(sep) ? t.root : t.root + sep) + parts.reverse().join(sep);
  };
  return {
    n: t.n,
    t,
    name,
    path,
    children: (id: number) => t.childList.subarray(t.childStart[id], t.childStart[id + 1]),
  };
}

export function view(root: string, spec: Spec): ScanView {
  return tableView(table(root, spec));
}
