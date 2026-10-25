// Measures the performance targets recorded in docs/TESTING.md.
//
//   npm run bench [-- <folder>]        default folder: the repository's own node_modules
//
// What this does and does not measure, because the difference matters:
//
//   MEASURED   the walk, using the production lister (src/main/lister.ts) and the
//              real table builders, on a real tree with a warm cache.
//   NOT IN     the worker pool. The application spreads directories across
//              os.availableParallelism() workers, so its wall clock should be
//              better than the single-threaded walk here, never worse. These
//              numbers are therefore a floor.
//
// The two targets that need the running application -- cancel latency, and a
// multi-million-file volume -- are not measured here and are reported as such.
import { availableParallelism, cpus } from "node:os";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { makeLister } from "../src/main/lister";
import { layoutTreemap } from "../src/renderer/src/lib/treemap";
import type { Disk } from "../src/renderer/src/lib/disk";
import { finishTable } from "../src/shared/table";
import type { RawScan, ScanFacts } from "../src/shared/table";
import { F_DIR, F_ERR, F_LINK } from "../src/shared/types";

const ms = (n: number): string => `${n.toFixed(1)} ms`;
const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(1)} MB`;

interface Columns {
  n: number;
  parent: Int32Array;
  size: Float64Array;
  logical: Float64Array;
  mtime: Uint32Array;
  flags: Uint8Array;
  nameOff: Uint32Array;
  names: Uint8Array;
  nameEnd: number;
}

function emptyColumns(cap = 1 << 16, nameBytes = 1 << 18): Columns {
  return {
    n: 0,
    parent: new Int32Array(cap),
    size: new Float64Array(cap),
    logical: new Float64Array(cap),
    mtime: new Uint32Array(cap),
    flags: new Uint8Array(cap),
    nameOff: new Uint32Array(cap + 1),
    names: new Uint8Array(nameBytes),
    nameEnd: 0,
  };
}

// The walk. Same shape as the scan worker's, without the threads.
function walk(root: string): { raw: RawScan; columns: Columns; dirs: number; errors: number; files: number } {
  const c = emptyColumns();
  const encoder = new TextEncoder();

  const grow = (min: number): void => {
    let cap = c.parent.length;
    while (cap < min) cap *= 2;
    const p = new Int32Array(cap);
    p.set(c.parent.subarray(0, c.n));
    c.parent = p;
    const s = new Float64Array(cap);
    s.set(c.size.subarray(0, c.n));
    c.size = s;
    const l = new Float64Array(cap);
    l.set(c.logical.subarray(0, c.n));
    c.logical = l;
    const m = new Uint32Array(cap);
    m.set(c.mtime.subarray(0, c.n));
    c.mtime = m;
    const f = new Uint8Array(cap);
    f.set(c.flags.subarray(0, c.n));
    c.flags = f;
    const o = new Uint32Array(cap + 1);
    o.set(c.nameOff.subarray(0, c.n + 1));
    c.nameOff = o;
  };
  const growNames = (min: number): void => {
    let len = c.names.length;
    while (len < min) len *= 2;
    const b = new Uint8Array(len);
    b.set(c.names.subarray(0, c.nameEnd));
    c.names = b;
  };

  let pendingParent = 0;
  const sink = {
    add(name: string, flag: number, onDisk: number, length: number, mtime: number): void {
      if (c.n + 1 > c.parent.length) grow(c.n + 1);
      const bytes = encoder.encode(name);
      if (c.nameEnd + bytes.length > c.names.length) growNames(c.nameEnd + bytes.length);
      const id = c.n++;
      c.parent[id] = pendingParent;
      c.size[id] = onDisk;
      c.logical[id] = length;
      c.mtime[id] = mtime;
      c.flags[id] = flag;
      c.names.set(bytes, c.nameEnd);
      c.nameOff[id] = c.nameEnd;
      c.nameOff[id + 1] = c.nameEnd + bytes.length;
      c.nameEnd += bytes.length;
    },
  };

  const lister = makeLister(sink);
  // Root node.
  {
    const bytes = encoder.encode(root);
    growNames(bytes.length);
    c.names.set(bytes, 0);
    c.nameEnd = bytes.length;
    c.parent[0] = -1;
    c.flags[0] = F_DIR;
    c.nameOff[0] = 0;
    c.nameOff[1] = c.nameEnd;
    c.n = 1;
  }

  const queue: { id: number; path: string }[] = [{ id: 0, path: root }];
  let dirs = 1;
  let errors = 0;
  let at = 0;
  while (at < queue.length) {
    const { id, path } = queue[at++];
    pendingParent = id;
    const before = c.n;
    const result = lister(path);
    if (typeof result === "string") {
      c.flags[id] |= F_ERR;
      errors++;
      continue;
    }
    for (let i = before; i < c.n; i++) {
      if (c.flags[i] & F_DIR) {
        dirs++;
        queue.push({ id: i, path: path.endsWith("\\") ? path + nameOf(c, i) : path + "\\" + nameOf(c, i) });
      } else if (c.flags[i] & F_ERR) {
        errors++;
      }
    }
  }
  const files = c.n - dirs;
  return { raw: rawOf(root, c), columns: c, dirs, errors, files };
}

const DECODER = new TextDecoder();

function nameOf(c: Columns, id: number): string {
  return DECODER.decode(c.names.subarray(c.nameOff[id], c.nameOff[id + 1]));
}

function rawOf(root: string, c: Columns): RawScan {
  return {
    root,
    n: c.n,
    parent: c.parent.subarray(0, c.n),
    size: c.size.subarray(0, c.n),
    logical: c.logical.subarray(0, c.n),
    mtime: c.mtime.subarray(0, c.n),
    flags: c.flags.subarray(0, c.n),
    nameOff: c.nameOff.subarray(0, c.n + 1),
    names: c.names.subarray(0, c.nameEnd),
  };
}

const facts = (dirs: number, errors: number): ScanFacts => ({
  startedAt: Date.now(),
  durationMs: 0,
  dirs,
  errors,
  errorSamples: [],
});

// A synthetic table with two million nodes, for the memory target.
function synthetic(count: number): { raw: RawScan; dirs: number } {
  // Room for every name, since nothing here grows the buffer.
  const c = emptyColumns(count + 1, Math.max(1 << 18, count * 24));
  const encoder = new TextEncoder();
  const rootBytes = encoder.encode("C:\\synthetic");
  c.names.set(rootBytes, 0);
  c.nameEnd = rootBytes.length;
  c.parent[0] = -1;
  c.flags[0] = F_DIR;
  c.nameOff[0] = 0;
  c.nameOff[1] = c.nameEnd;
  c.n = 1;
  let name = 0;
  let dirs = 1;
  for (let i = 1; i <= count; i++) {
    const bytes = encoder.encode("file" + name++ + ".dat");
    c.names.set(bytes, c.nameEnd);
    const id = c.n++;
    c.parent[id] = Math.floor((i - 1) / 50);
    c.size[id] = 4096;
    c.logical[id] = 3000;
    c.mtime[id] = 1_700_000_000;
    c.flags[id] = 0;
    c.nameOff[id] = c.nameEnd;
    c.nameOff[id + 1] = c.nameEnd + bytes.length;
    c.nameEnd += bytes.length;
  }
  // Every fiftieth node is a folder, to give the tree some shape.
  for (let i = 50; i <= count; i += 50) {
    c.flags[i] |= F_DIR;
    c.size[i] = 0;
    c.logical[i] = 0;
    dirs++;
  }
  return { raw: rawOf("C:\\synthetic", c), dirs };
}

// The treemap needs the *finished* table, where the root's size column holds
// the subtree total. On the raw scan it is still zero and nothing is drawn.
function diskOver(t: { n: number; parent: Int32Array; size: Float64Array; flags: Uint8Array }): Disk {
  const children = new Map<number, number[]>();
  for (let i = 1; i < t.n; i++) {
    const p = t.parent[i];
    const list = children.get(p);
    if (list) list.push(i);
    else children.set(p, [i]);
  }
  for (const list of children.values()) list.sort((a, b) => t.size[b] - t.size[a]);
  return {
    t,
    isDir: (id: number) => (t.flags[id] & F_DIR) !== 0,
    children: (id: number) => children.get(id) ?? [],
    size: (id: number) => t.size[id],
  } as unknown as Disk;
}

// ---------------------------------------------------------------------------

// Cancel latency, which is the one performance target that needs the running
// scanner rather than the library: it is about how quickly the built
// coordinator notices and lets its threads go. Cancel is asked for as soon as
// the worker says anything at all, and the clock runs until the thread is gone,
// which is the stricter of the two things the target names.
function measureCancel(root: string): Promise<{ askedAfterMs: number; retiredMs: number } | null> {
  const entry = resolve("out", "main", "scanworker.js");
  if (!existsSync(entry)) return Promise.resolve(null);

  return new Promise((done) => {
    const worker = new Worker(entry, { workerData: { root, snapshotDir: "", quiet: true } });
    const began = Date.now();
    let asked = 0;
    // A cancel that arrives after the walk has finished measures nothing, so the
    // completion message is watched for: if the scan reported itself done, the
    // number is withheld rather than reported as a cancel latency.
    let completed = false;
    let settled = false;
    const finish = (value: { askedAfterMs: number; retiredMs: number } | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      done(value);
    };
    // A scanner that never answers must not hang the benchmark.
    const guard = setTimeout(() => {
      void worker.terminate();
      finish(null);
    }, 60_000);

    worker.on("message", (msg) => {
      if ((msg as { type?: string } | null)?.type === "done") completed = true;
      if (asked !== 0) return;
      asked = Date.now();
      worker.postMessage({ type: "cancel" });
    });
    worker.on("exit", () =>
      finish(asked === 0 || completed ? null : { askedAfterMs: asked - began, retiredMs: Date.now() - asked }),
    );
    worker.on("error", () => finish(null));
  });
}

const folder = resolve(process.argv[2] ?? "node_modules");

console.log("");
console.log("SpaceWise benchmark");
console.log(`  cpus            ${cpus().length} (${availableParallelism()} available to Node)`);
console.log(`  node            ${process.version}`);
console.log(`  folder          ${folder}`);
console.log("");

// Warm the cache, then measure.
walk(folder);
const beganWalk = performance.now();
const { raw, dirs, errors, files } = walk(folder);
const walkMs = performance.now() - beganWalk;

const beganFinish = performance.now();
const table = finishTable(raw, facts(dirs, errors));
const finishMs = performance.now() - beganFinish;

const beganLayout = performance.now();
const layout = layoutTreemap(diskOver(table), 0, 1200, 800, 5);
const layoutMs = performance.now() - beganLayout;

console.log("real tree, warm cache, single thread (the application also uses a worker pool)");
console.log(`  files           ${files.toLocaleString()}`);
console.log(`  folders         ${dirs.toLocaleString()}`);
console.log(`  on disk         ${mb(table.size?.[0] ?? 0)}`);
console.log(`  walk            ${ms(walkMs)}   (${Math.round(files / (walkMs / 1000)).toLocaleString()} files/s)`);
console.log(`  finalise        ${ms(finishMs)}`);
console.log(`  treemap layout  ${ms(layoutMs)}   (${layout.count.toLocaleString()} cells, 1200x800, 5 levels)`);
console.log("");

const M2 = 2_000_000;
const beganSynth = performance.now();
const syn = synthetic(M2);
const synthMs = performance.now() - beganSynth;
const beganSynthFinish = performance.now();
const synTable = finishTable(syn.raw, facts(syn.dirs, 0));
const synthFinishMs = performance.now() - beganSynthFinish;
const rss = process.memoryUsage().rss;

console.log(`synthetic table, ${M2.toLocaleString()} nodes`);
console.log(`  build           ${ms(synthMs)}   (this script filling the arrays, not application code)`);
console.log(`  finalise        ${ms(synthFinishMs)}`);
console.log(`  peak RSS        ${mb(rss)}`);
console.log(`  nodes in the finished table: ${synTable.n.toLocaleString()}`);
console.log("");

const TARGETS: [string, string, string][] = [
  [
    "100k-file project folder, warm cache, under 2 s",
    files > 0 ? `${Math.round((walkMs / files) * 100_000)} ms at ${files.toLocaleString()} files` : "n/a",
    `the walk is measured for real; the worker pool is not in the loop, so the application should be faster. ${files.toLocaleString()} files is not 100,000, so this is a rate, not the target`,
  ],
  ["Treemap relayout, under 30 ms", `${layoutMs.toFixed(1)} ms`, layoutMs < 30 ? "meets the target" : "MISSES the target"],
  ["Memory at 2M files, under 400 MB", mb(rss), rss < 400 * 1024 * 1024 ? "meets the target" : "MISSES the target"],
  ["Multi-million-file volume in tens of seconds", "not measured", "needs a real volume of that size, which this machine does not have"],
];

console.log("targets");
for (const [target, value, note] of TARGETS) {
  console.log(`  ${target}`);
  console.log(`      measured: ${value}`);
  console.log(`      ${note}`);
}
console.log("");

// Cancel latency, which is the one target that is about the built scanner
// rather than the library, and so cannot be measured on the calling thread.
void measureCancel(folder).then((cancelled) => {
  console.log("cancel latency, on the built scanner");
  if (cancelled === null) {
    console.log("  not measured: build first, so that out/main/scanworker.js exists");
  } else {
    console.log(`  cancel asked for   ${ms(cancelled.askedAfterMs)} into the scan`);
    console.log(`  thread gone after  ${ms(cancelled.retiredMs)}   (target: retired within 4 s)`);
  }
  console.log("");
});
