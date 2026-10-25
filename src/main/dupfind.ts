// Finding identical files among candidates that already share a length.
//
// Cheap pass first -- the head and tail of each file -- then a full read only
// for the survivors. Kept out of the worker that runs it so it can be tested
// directly against planted files; `dupworker.ts` is a thin shell over this.
import { createHash } from "crypto";
import { closeSync, fstatSync, openSync, readSync } from "fs";
import type { DupCandidate, DupGroup, DupProgress } from "../shared/types";

export const EDGE = 16 * 1024;
export const CHUNK = 1024 * 1024;

export interface DupOptions {
  onProgress?: (progress: DupProgress) => void;
  // Progress is reported no more often than this. Tests set it to 0 so that
  // nothing depends on wall-clock timing.
  everyMs?: number;
}

// Head and tail. For a file no larger than twice EDGE this covers every byte,
// so a match is already a real match and the second pass can be skipped.
//
// The buffer is passed in rather than shared at module scope: one buffer reused
// across calls is safe only while nothing else can interleave, and that is not
// a property this module should depend on.
export function edgeHash(path: string, size: number, buffer: Buffer): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    // The declared size comes from the scan, which can be older than this pass.
    // A short file is treated below as fully covered by the head and tail, so if
    // the file is no longer that length, that conclusion would rest on part of
    // it and two different files could be called identical. Refusing is the safe
    // direction: a missed duplicate costs the user nothing.
    if (fstatSync(fd).size !== size) return null;
    const h = createHash("sha1");
    const head = readSync(fd, buffer, 0, Math.min(EDGE, size), 0);
    h.update(buffer.subarray(0, head));
    if (size > EDGE) {
      // Starts where the head stopped, so the two reads never overlap and
      // together they cover the file exactly when size <= EDGE * 2.
      const at = Math.max(EDGE, size - EDGE);
      const got = readSync(fd, buffer, 0, Math.min(EDGE, size - EDGE), at);
      h.update(buffer.subarray(0, got));
    }
    return h.digest("hex");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function fullHash(path: string, buffer: Buffer, onBytes?: (n: number) => void): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const h = createHash("sha1");
    for (;;) {
      const got = readSync(fd, buffer, 0, buffer.length, null);
      if (got === 0) break;
      h.update(buffer.subarray(0, got));
      onBytes?.(got);
    }
    return h.digest("hex");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// Groups the ids by whatever key the callback produces, dropping anything that
// could not be read and anything left on its own.
function split(
  ids: number[],
  paths: string[],
  keyOf: (path: string) => string | null,
): { ids: number[]; paths: string[] }[] {
  const groups = new Map<string, { ids: number[]; paths: string[] }>();
  for (let i = 0; i < ids.length; i++) {
    const key = keyOf(paths[i]);
    if (key === null) continue;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { ids: [], paths: [] }));
    g.ids.push(ids[i]);
    g.paths.push(paths[i]);
  }
  return [...groups.values()].filter((g) => g.ids.length > 1);
}

export function findDuplicates(candidates: DupCandidate[], options: DupOptions = {}): DupGroup[] {
  const buffer = Buffer.allocUnsafe(CHUNK);
  const report = options.onProgress;
  const everyMs = options.everyMs ?? 150;
  let last = 0;

  const tick = (progress: DupProgress): void => {
    if (!report) return;
    const now = Date.now();
    if (now - last < everyMs) return;
    last = now;
    report(progress);
  };

  // Pass 1: head and tail of every candidate.
  const survivors: { size: number; ids: number[]; paths: string[] }[] = [];
  let done = 0;
  const totalFiles = candidates.reduce((a, c) => a + c.ids.length, 0);

  for (const c of candidates) {
    for (const g of split(c.ids, c.paths, (p) => {
      done++;
      tick({ done, total: totalFiles, bytes: 0, totalBytes: 0 });
      return edgeHash(p, c.size, buffer);
    })) {
      survivors.push({ size: c.size, ...g });
    }
  }

  // Pass 2: whole file, only where head and tail matched and the file is longer
  // than both together.
  const totalBytes = survivors.reduce((a, s) => a + (s.size > EDGE * 2 ? s.size * s.ids.length : 0), 0);
  let bytes = 0;
  const out: DupGroup[] = [];
  for (const s of survivors) {
    if (s.size <= EDGE * 2) {
      out.push({ size: s.size, ids: s.ids });
      continue;
    }
    for (const g of split(s.ids, s.paths, (p) =>
      fullHash(p, buffer, (got) => {
        bytes += got;
        tick({ done: totalFiles, total: totalFiles, bytes, totalBytes });
      }),
    )) {
      out.push({ size: s.size, ids: g.ids });
    }
  }

  // Biggest saving first, using what would actually be freed rather than the
  // number of copies.
  out.sort((a, b) => b.size * (b.ids.length - 1) - a.size * (a.ids.length - 1));
  return out;
}
