// The scan walk, on its own.
//
// This owns the node table and the queue of folders still to read. It does not
// own worker threads, messages, progress reporting, previews or snapshots --
// those belong to whatever is driving it. The directory listing is injected, so
// the walk can be run against a fake, against a real folder on one thread, or
// across a pool of workers, and all three are the same code.
//
// It was lifted out of scanworker.ts so that it could be tested at all: before,
// the only thing exercising the walk was the application, and `scripts/explain.ts`
// had grown a second walker of its own that quietly disagreed with it.
import { sep } from "node:path";
import { F_DIR, F_ERR, F_LINK } from "../shared/types";
import type { ScanIssue } from "../shared/types";
import type { RawScan } from "../shared/table";

// What one listing pass over a batch of folders produced. Same shape the
// directory worker already returns, minus the sequence number, which is the
// caller's business.
export interface DirBatch {
  counts: Uint32Array; // entries per folder, in the order they were asked for
  failed: readonly [number, string][]; // [index into the batch, error code]
  nameLens: Uint16Array;
  names: Uint8Array;
  sizes: Float64Array; // on disk
  logical: Float64Array; // length in bytes
  mtimes: Uint32Array;
  flags: Uint8Array;
}

export type ListDirs = (dirs: readonly string[]) => Promise<DirBatch>;

export interface WalkOptions {
  root: string;
  list: ListDirs;
  // Folders per listing call, and calls in flight. The defaults match what the
  // application uses.
  batch?: number;
  concurrency?: number;
  // Called after each listing lands, which is where the driver reports progress
  // and refreshes any live preview. Throttling is the driver's business.
  onActivity?: () => void;
}

export interface WalkOutcome {
  cancelled: boolean; // thrown away on request
  stopped: boolean; // handed over unfinished, because it was asked to stop
}

interface Queued {
  id: number;
  path: string;
  top: number; // the depth-1 ancestor, or -1 for something directly in the root
}

const MAX_SAMPLES = 200;

export class Walker {
  private readonly root: string;
  private readonly list: ListDirs;
  private readonly batch: number;
  private readonly concurrency: number;
  private readonly onActivity: (() => void) | undefined;

  private cap = 1 << 16;
  private parent = new Int32Array(this.cap);
  private size = new Float64Array(this.cap);
  private logical = new Float64Array(this.cap);
  private mtime = new Uint32Array(this.cap);
  private flags = new Uint8Array(this.cap);
  private nameOff = new Uint32Array(this.cap + 1);
  private names = new Uint8Array(1 << 20);
  private n = 0;
  private nameEnd = 0;

  private queue: Queued[] = [];
  private inFlight = 0;
  private readonly topBytes = new Map<number, number>();
  private readonly issueList: ScanIssue[] = [];
  private fileCount = 0;
  private dirCount = 1;
  private byteCount = 0;
  private errorCount = 0;
  private currentPath: string;
  private started = false;
  private finished = false;
  private cancelled = false;
  private stopping = false;

  private readonly decoder = new TextDecoder();
  private readonly encoder = new TextEncoder();

  private settle: ((outcome: WalkOutcome) => void) | null = null;
  readonly done: Promise<WalkOutcome>;

  constructor(options: WalkOptions) {
    this.root = options.root;
    this.list = options.list;
    this.batch = Math.max(1, options.batch ?? 24);
    this.concurrency = Math.max(1, options.concurrency ?? 4);
    this.onActivity = options.onActivity;
    this.currentPath = options.root;
    this.done = new Promise((resolve) => {
      this.settle = resolve;
    });

    const bytes = this.encoder.encode(options.root);
    this.growNames(bytes.length);
    this.names.set(bytes, 0);
    this.nameEnd = bytes.length;
    this.parent[0] = -1;
    this.flags[0] = F_DIR;
    this.nameOff[0] = 0;
    this.nameOff[1] = this.nameEnd;
    this.n = 1;
    this.queue.push({ id: 0, path: options.root, top: -1 });
  }

  // ---------------------------------------------------------------- columns

  private grow(min: number): void {
    while (this.cap < min) this.cap *= 2;
    const p = new Int32Array(this.cap);
    p.set(this.parent.subarray(0, this.n));
    this.parent = p;
    const s = new Float64Array(this.cap);
    s.set(this.size.subarray(0, this.n));
    this.size = s;
    const l = new Float64Array(this.cap);
    l.set(this.logical.subarray(0, this.n));
    this.logical = l;
    const m = new Uint32Array(this.cap);
    m.set(this.mtime.subarray(0, this.n));
    this.mtime = m;
    const f = new Uint8Array(this.cap);
    f.set(this.flags.subarray(0, this.n));
    this.flags = f;
    const o = new Uint32Array(this.cap + 1);
    o.set(this.nameOff.subarray(0, this.n + 1));
    this.nameOff = o;
  }

  private growNames(min: number): void {
    let size = this.names.length;
    while (size < min) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.names.subarray(0, this.nameEnd));
    this.names = next;
  }

  // ------------------------------------------------------------------- view

  // A view of what has been collected so far. Valid only until the next batch
  // is absorbed, which is why callers use it immediately.
  raw(): RawScan {
    return {
      root: this.root,
      n: this.n,
      parent: this.parent,
      size: this.size,
      logical: this.logical,
      mtime: this.mtime,
      flags: this.flags,
      nameOff: this.nameOff,
      names: this.names,
    };
  }

  files(): number {
    return this.fileCount;
  }
  dirs(): number {
    return this.dirCount;
  }
  bytes(): number {
    return this.byteCount;
  }
  errors(): number {
    return this.errorCount;
  }
  issues(): readonly ScanIssue[] {
    return this.issueList;
  }
  current(): string {
    return this.currentPath;
  }
  // True when the walk was cut short, so a table built from it says so.
  incomplete(): boolean {
    return this.stopping;
  }

  // False once it has been asked to stop or to throw everything away, so a
  // driver knows not to publish any more of what has been collected.
  running(): boolean {
    return !this.cancelled && !this.stopping;
  }

  isDir(id: number): boolean {
    return (this.flags[id] & F_DIR) !== 0;
  }

  nameOf(id: number): string {
    return this.decoder.decode(this.names.subarray(this.nameOff[id], this.nameOff[id + 1]));
  }

  // The largest direct children of the root, biggest first, for a progress
  // readout while the walk is still running.
  top(limit = 14): { id: number; bytes: number }[] {
    return [...this.topBytes.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([id, bytes]) => ({ id, bytes }));
  }

  // --------------------------------------------------------------- the walk

  start(): void {
    if (this.started) return;
    this.started = true;
    this.pump();
  }

  // Hand over what has been measured, without reading any more folders.
  stop(): void {
    if (this.finished || this.stopping) return;
    this.stopping = true;
    this.queue.length = 0;
    this.checkDone();
  }

  // Throw away what has been measured.
  cancel(): void {
    if (this.finished) return;
    this.cancelled = true;
    this.queue.length = 0;
    this.checkDone();
  }

  private issue(path: string, code: string): void {
    this.errorCount++;
    if (this.issueList.length < MAX_SAMPLES) this.issueList.push({ path, code });
  }

  private pump(): void {
    if (this.finished) return;
    // Once asked to stop or cancel, folders found by calls still in flight are
    // not followed.
    if (this.cancelled || this.stopping) this.queue.length = 0;

    while (this.inFlight < this.concurrency && this.queue.length > 0) {
      const take = Math.min(this.batch, this.queue.length);
      const run = this.queue.splice(this.queue.length - take, take);
      this.inFlight++;
      this.list(run.map((q) => q.path)).then(
        (res) => {
          this.absorb(run, res);
          this.inFlight--;
          this.pump();
        },
        () => {
          // A listing call that rejects is the caller's plumbing failing, not a
          // folder being unreadable. Record it against each folder and carry on.
          for (const q of run) {
            this.flags[q.id] |= F_ERR;
            this.issue(q.path, "EWORKER");
          }
          this.inFlight--;
          this.pump();
        },
      );
    }

    this.checkDone();
  }

  private absorb(run: Queued[], res: DirBatch): void {
    for (const [d, code] of res.failed) {
      const q = run[d];
      if (!q) continue;
      this.flags[q.id] |= F_ERR;
      this.issue(q.path, code);
    }

    const total = res.flags.length;
    if (this.n + total > this.cap) this.grow(this.n + total);
    if (this.nameEnd + res.names.length > this.names.length) this.growNames(this.nameEnd + res.names.length);
    this.names.set(res.names, this.nameEnd);

    let e = 0;
    let off = 0; // offset inside res.names
    for (let d = 0; d < run.length; d++) {
      const q = run[d];
      const count = res.counts[d] ?? 0;
      if (count > 0) this.currentPath = q.path;
      let direct = 0; // bytes of the files directly in this folder
      let directTop = -1;
      for (let k = 0; k < count; k++, e++) {
        const id = this.n++;
        const flag = res.flags[e];
        const len = res.nameLens[e];
        this.parent[id] = q.id;
        this.size[id] = res.sizes[e];
        this.logical[id] = res.logical[e];
        this.mtime[id] = res.mtimes[e];
        this.flags[id] = flag;
        this.nameOff[id + 1] = this.nameEnd + off + len;

        const top = q.top === -1 ? id : q.top;
        if (flag & F_DIR) {
          this.dirCount++;
          const name = this.decoder.decode(res.names.subarray(off, off + len));
          this.queue.push({ id, path: q.path.endsWith(sep) ? q.path + name : q.path + sep + name, top });
          if (!this.topBytes.has(top)) this.topBytes.set(top, 0);
        } else {
          this.fileCount++;
          if (flag & F_ERR) {
            const name = this.decoder.decode(res.names.subarray(off, off + len));
            this.issue(q.path + sep + name, "ESTAT");
          } else if (!(flag & F_LINK)) {
            this.byteCount += res.sizes[e];
            if (q.top === -1) this.topBytes.set(id, res.sizes[e]);
            else {
              direct += res.sizes[e];
              directTop = top;
            }
          }
        }
        off += len;
      }
      if (directTop !== -1) this.topBytes.set(directTop, (this.topBytes.get(directTop) ?? 0) + direct);
    }
    this.nameEnd += res.names.length;
    this.onActivity?.();
  }

  private checkDone(): void {
    if (this.finished) return;
    if (this.inFlight > 0 || this.queue.length > 0) return;
    this.finished = true;
    this.settle?.({ cancelled: this.cancelled, stopped: this.stopping });
  }
}

// A walk that runs to completion on the calling thread, with the listing
// injected. Used by the command line tool and by tests.
export async function walkOnce(root: string, list: ListDirs, batch = 32): Promise<{ walker: Walker; outcome: WalkOutcome }> {
  const walker = new Walker({ root, list, batch, concurrency: 1 });
  walker.start();
  const outcome = await walker.done;
  return { walker, outcome };
}
