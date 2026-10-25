// Reads folders for the scan coordinator, one of these per core.
//
// On Windows a folder is listed in bulk: one call returns hundreds of entries
// with their sizes already in them, so no file is opened one by one. That is
// several times faster than a stat per file and also yields the size on disk.
// Anywhere else, or if the bulk path cannot load, it falls back to readdir
// plus lstat.
import { parentPort } from "worker_threads";
import { makeLister } from "./lister";
import { readdirSync, lstatSync } from "fs";
export interface DirJob {
  seq: number;
  paths: string[];
}

export interface DirResult {
  seq: number;
  counts: Uint32Array; // entries per folder of the job
  failed: [number, string][]; // [index in job, error code]
  nameLens: Uint16Array;
  names: Uint8Array;
  sizes: Float64Array; // on disk
  logical: Float64Array; // length in bytes
  mtimes: Uint32Array;
  flags: Uint8Array;
}

const encoder = new TextEncoder();

let cap = 4096;
let nameLens = new Uint16Array(cap);
let sizes = new Float64Array(cap);
let logical = new Float64Array(cap);
let mtimes = new Uint32Array(cap);
let flags = new Uint8Array(cap);
let names = new Uint8Array(1 << 17);
let n = 0;
let nameEnd = 0;

function growEntries(): void {
  cap *= 2;
  const l = new Uint16Array(cap);
  l.set(nameLens);
  nameLens = l;
  const s = new Float64Array(cap);
  s.set(sizes);
  sizes = s;
  const g = new Float64Array(cap);
  g.set(logical);
  logical = g;
  const m = new Uint32Array(cap);
  m.set(mtimes);
  mtimes = m;
  const f = new Uint8Array(cap);
  f.set(flags);
  flags = f;
}

function add(name: string, flag: number, onDisk: number, length: number, mtime: number): void {
  if (n === cap) growEntries();
  if (nameEnd + name.length * 3 > names.length) {
    const bigger = new Uint8Array(Math.max(names.length * 2, nameEnd + name.length * 3));
    bigger.set(names.subarray(0, nameEnd));
    names = bigger;
  }
  const written = encoder.encodeInto(name, names.subarray(nameEnd)).written;
  nameLens[n] = written;
  nameEnd += written;
  flags[n] = flag;
  sizes[n] = onDisk;
  logical[n] = length;
  mtimes[n] = mtime;
  n++;
}

// Returns the number of entries, or an error code.
const list = makeLister({ add });

function run(job: DirJob): void {
  const counts = new Uint32Array(job.paths.length);
  const failed: [number, string][] = [];
  n = 0;
  nameEnd = 0;

  for (let d = 0; d < job.paths.length; d++) {
    const before = n;
    const beforeNames = nameEnd;
    let r: number | string;
    try {
      r = list(job.paths[d]);
    } catch (e) {
      // Drop whatever a failed listing left half written.
      n = before;
      nameEnd = beforeNames;
      r = (e as NodeJS.ErrnoException).code ?? "EUNKNOWN";
    }
    if (typeof r === "string") failed.push([d, r]);
    else counts[d] = r;
  }

  const out: DirResult = {
    seq: job.seq,
    counts,
    failed,
    nameLens: nameLens.slice(0, n),
    names: names.slice(0, nameEnd),
    sizes: sizes.slice(0, n),
    logical: logical.slice(0, n),
    mtimes: mtimes.slice(0, n),
    flags: flags.slice(0, n),
  };
  parentPort!.postMessage(out, [
    out.counts.buffer,
    out.nameLens.buffer,
    out.names.buffer,
    out.sizes.buffer,
    out.logical.buffer,
    out.mtimes.buffer,
    out.flags.buffer,
  ] as ArrayBuffer[]);
}

parentPort!.on("message", (msg: DirJob | { exit: true }) => {
  // Leaving by closing the port lets the thread end on its own. Terminating a
  // thread from outside while a native module is loading can abort the process.
  if ("exit" in msg) parentPort!.close();
  else run(msg);
});
parentPort!.postMessage({ ready: true });
