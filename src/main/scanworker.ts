// Scan coordinator: owns the worker pool and the messages. The walk itself is
// in walk.ts, where it can be tested without threads. What is left here is the
// part that cannot be tested without them, and it is deliberately thin.
import { parentPort, workerData, Worker } from "worker_threads";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import type { ScanProgress, SnapshotMeta } from "../shared/types";
import { finishTable, previewTable, tableBuffers } from "../shared/table";
import type { ScanFacts } from "../shared/table";
import type { DirJob, DirResult } from "./dirworker";
import { Walker } from "./walk";
import type { DirBatch, ListDirs } from "./walk";
import { writeSnapshot } from "./snapshots";

interface Job {
  root: string;
  snapshotDir: string;
  quiet?: boolean; // no live preview and no snapshot: used to measure one pasted folder
  liveDepth?: number; // how deep the preview goes: one level past what the plan opens
}

const job = workerData as Job;
const port = parentPort!;

const BATCH = 24; // folders per listing call
const IN_FLIGHT = 2; // calls queued on each worker
// The preview only carries what the plan can show. Fewer levels mean a smaller
// table, built and sent more often, and a plan that keeps moving.
const LIVE_DEPTH = Math.max(3, Math.min(6, job.liveDepth ?? 5));

const poolSize = Math.max(2, Math.min(12, availableParallelism()));
const workers: Worker[] = [];
const load: number[] = [];
const waiting = new Map<number, { at: number; resolve: (batch: DirBatch) => void }>();
let seq = 0;
let ready = 0;
let aborted = false;
const startedAt = Date.now();

// Workers are asked to leave, never terminated: see dirworker.
function release(): void {
  for (const w of workers) w.postMessage({ exit: true });
}

// One listing call goes to the worker with the least work queued. The walker
// bounds how many calls are in flight, so this needs no queue of its own.
const list: ListDirs = (dirs) =>
  new Promise<DirBatch>((resolve) => {
    let best = 0;
    for (let i = 1; i < load.length; i++) if (load[i] < load[best]) best = i;
    const id = seq++;
    load[best]++;
    waiting.set(id, { at: best, resolve });
    workers[best].postMessage({ seq: id, paths: [...dirs] } satisfies DirJob);
  });

const walker = new Walker({
  root: job.root,
  list,
  batch: BATCH,
  concurrency: poolSize * IN_FLIGHT,
  onActivity: () => {
    reportProgress();
    maybePreview();
  },
});

function progress(): ScanProgress {
  return {
    files: walker.files(),
    dirs: walker.dirs(),
    bytes: walker.bytes(),
    errors: walker.errors(),
    current: walker.current(),
    elapsedMs: Date.now() - startedAt,
    top: walker.top().map((t) => ({ name: walker.nameOf(t.id), bytes: t.bytes, dir: walker.isDir(t.id) })),
  };
}

let lastProgress = 0;
function reportProgress(): void {
  const now = Date.now();
  if (now - lastProgress <= 120) return;
  lastProgress = now;
  port.postMessage({ type: "progress", progress: progress() });
}

function facts(): ScanFacts {
  return {
    startedAt,
    durationMs: Date.now() - startedAt,
    dirs: walker.dirs(),
    errors: walker.errors(),
    errorSamples: [...walker.issues()],
    incomplete: walker.incomplete(),
  };
}

let lastPreview = Date.now();
let previewCost = 0;
function maybePreview(): void {
  if (job.quiet || !walker.running()) return;
  const now = Date.now();
  // Never let the preview take more than about a tenth of the scan's time.
  if (now - lastPreview <= Math.max(900, previewCost * 10)) return;
  const began = Date.now();
  const table = previewTable(walker.raw(), LIVE_DEPTH, facts());
  port.postMessage({ type: "partial", table }, tableBuffers(table));
  lastPreview = Date.now();
  previewCost = lastPreview - began;
}

async function run(): Promise<void> {
  walker.start();
  const outcome = await walker.done;
  release();
  if (aborted || outcome.cancelled) {
    port.close();
    return;
  }

  const table = finishTable(walker.raw(), facts());
  let snapshot: SnapshotMeta | null = null;
  try {
    if (!job.quiet && !outcome.stopped) snapshot = writeSnapshot(job.snapshotDir, table);
  } catch {
    // A scan is still useful without its snapshot.
  }
  port.postMessage({ type: "done", table, snapshot }, tableBuffers(table));
  port.close();
}

for (let w = 0; w < poolSize; w++) {
  const worker = new Worker(join(__dirname, "dirworker.js"));
  load.push(0);
  workers.push(worker);
  worker.on("message", (res: DirResult | { ready: true }) => {
    if ("ready" in res) {
      if (++ready === poolSize) void run();
      return;
    }
    const entry = waiting.get(res.seq);
    if (!entry) return;
    waiting.delete(res.seq);
    load[entry.at]--;
    entry.resolve({
      counts: res.counts,
      failed: res.failed,
      nameLens: res.nameLens,
      names: res.names,
      sizes: res.sizes,
      logical: res.logical,
      mtimes: res.mtimes,
      flags: res.flags,
    });
  });
  worker.on("error", (err) => {
    if (aborted) return;
    aborted = true;
    port.postMessage({ type: "error", error: String((err as Error)?.message ?? err) });
    // The threads are gone, so waiting for an answer would hang. Give up and
    // report, which is what the window is expecting.
    walker.cancel();
  });
}

// Stop on request: the calls already in flight come back, then this leaves.
// "stop" finishes with what there is; "cancel" throws it away.
port.on("message", (msg: { type: string }) => {
  if (msg.type === "stop") walker.stop();
  else if (msg.type === "cancel") walker.cancel();
});
