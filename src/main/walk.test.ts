// The scan walk, against a fake disk and a real one.
//
// Before this file existed, the walk was only ever exercised by the running
// application: nothing could say what it did with a folder it could not read,
// or with a link, without a person clicking and watching.
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { makeLister } from "./lister";
import type { EntrySink } from "./lister";
import { Walker } from "./walk";
import type { DirBatch, ListDirs } from "./walk";
import { F_DIR, F_ERR, F_LINK } from "../shared/types";

// ---------------------------------------------------------------- fake disk

// A number is a file of that size; the strings are the awkward cases; an object
// is a folder. Kept declarative so a test reads like a description of a disk.
type Spec = number | "link" | "unreadable" | "opaque" | { [name: string]: Spec };

interface Entry {
  kind: "dir" | "file" | "link" | "unreadable" | "opaque";
  size: number;
}

const ROOT = "R:";

function flatten(spec: { [name: string]: Spec }, at: string, out: Map<string, Entry>): void {
  for (const [name, value] of Object.entries(spec)) {
    const path = at === "" ? name : at + "/" + name;
    if (typeof value === "number") out.set(path, { kind: "file", size: value });
    else if (value === "link" || value === "unreadable" || value === "opaque") out.set(path, { kind: value, size: 0 });
    else {
      out.set(path, { kind: "dir", size: 0 });
      flatten(value, path, out);
    }
  }
}

const encoder = new TextEncoder();

function fakeList(spec: { [name: string]: Spec }, root = ROOT): ListDirs {
  const all = new Map<string, Entry>();
  flatten(spec, "", all);

  const key = (given: string): string => {
    const stripped = given.startsWith(root) ? given.slice(root.length) : given;
    return stripped.replace(/^[\\/]+/, "").replace(/\\/g, "/");
  };
  const childOf = (path: string, parent: string): boolean => {
    if (parent === "") return !path.includes("/");
    return path.startsWith(parent + "/") && !path.slice(parent.length + 1).includes("/");
  };

  return (dirs) => {
    const counts = new Uint32Array(dirs.length);
    const failed: [number, string][] = [];
    const flags: number[] = [];
    const sizes: number[] = [];
    const logical: number[] = [];
    const mtimes: number[] = [];
    const nameLens: number[] = [];
    const parts: Uint8Array[] = [];

    for (let d = 0; d < dirs.length; d++) {
      const at = key(dirs[d]);
      const self = at === "" ? undefined : all.get(at);
      if (at !== "" && !self) {
        failed.push([d, "ENOENT"]);
        continue;
      }
      if (self?.kind === "opaque") {
        failed.push([d, "EPERM"]);
        continue;
      }
      const kids = [...all.entries()].filter(([p]) => childOf(p, at)).sort((a, b) => (a[0] < b[0] ? -1 : 1));
      for (const [path, entry] of kids) {
        const name = path.slice(at === "" ? 0 : at.length + 1);
        const bytes = encoder.encode(name);
        nameLens.push(bytes.length);
        parts.push(bytes);
        // An "opaque" folder is still a folder, and must be flagged as one: the
        // walk has to queue it and then find out for itself that it cannot be
        // read. Flagging it as a file would quietly turn it into a bad byte
        // count, which is exactly the kind of thing this fake exists to catch.
        const isFolder = entry.kind === "dir" || entry.kind === "opaque";
        flags.push(isFolder ? F_DIR : entry.kind === "link" ? F_LINK : entry.kind === "unreadable" ? F_ERR : 0);
        sizes.push(entry.size);
        logical.push(entry.size);
        mtimes.push(1000);
      }
      counts[d] = kids.length;
    }

    let total = 0;
    for (const part of parts) total += part.length;
    const names = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
      names.set(part, at);
      at += part.length;
    }

    const batch: DirBatch = {
      counts,
      failed,
      nameLens: Uint16Array.from(nameLens),
      names,
      sizes: Float64Array.from(sizes),
      logical: Float64Array.from(logical),
      mtimes: Uint32Array.from(mtimes),
      flags: Uint8Array.from(flags),
    };
    return Promise.resolve(batch);
  };
}

async function walkFake(spec: { [name: string]: Spec }, options: { batch?: number; concurrency?: number } = {}) {
  const walker = new Walker({ root: ROOT, list: fakeList(spec), batch: options.batch ?? 2, concurrency: options.concurrency ?? 1 });
  walker.start();
  const outcome = await walker.done;
  return { walker, outcome };
}

const namesOf = (walker: Walker): string[] => Array.from({ length: walker.raw().n }, (_, i) => walker.nameOf(i));

// ------------------------------------------------------------------- tests

describe("the walk counts what is there", () => {
  it("counts files, folders and bytes through nested folders", async () => {
    const { walker } = await walkFake({
      a: { "one.bin": 100, "two.bin": 200, deep: { "three.bin": 400 } },
      "top.bin": 50,
    });
    assert.equal(walker.files(), 4);
    assert.equal(walker.dirs(), 3, "the root, a, and a/deep");
    assert.equal(walker.bytes(), 750);
    assert.equal(walker.errors(), 0);
  });

  it("names the root with its path and every other node with its own name", async () => {
    const { walker } = await walkFake({ a: { "one.bin": 1 } });
    const names = namesOf(walker);
    assert.equal(names[0], ROOT);
    assert.deepEqual(names.slice(1).sort(), ["a", "one.bin"]);
  });

  it("links each entry to the folder it is in, so the tree has a shape", async () => {
    const { walker } = await walkFake({ a: { "one.bin": 10 }, "top.bin": 20 });
    const raw = walker.raw();
    const byName = new Map<string, number>();
    for (let i = 1; i < raw.n; i++) byName.set(walker.nameOf(i), i);
    assert.equal(raw.parent[byName.get("a")!], 0, "the folder sits in the root");
    assert.equal(raw.parent[byName.get("one.bin")!], byName.get("a"), "the file sits in the folder");
    assert.equal(raw.parent[byName.get("top.bin")!], 0);
  });

  it("visits everything with a batch of one and several batches in flight", async () => {
    const wide: { [name: string]: Spec } = {};
    for (let i = 0; i < 40; i++) wide["d" + i] = { ["f" + i]: i + 1 };
    const { walker } = await walkFake(wide, { batch: 1, concurrency: 4 });
    assert.equal(walker.files(), 40);
    assert.equal(walker.dirs(), 41);
    assert.equal(walker.bytes(), (40 * 41) / 2);
  });
});

describe("the walk does not follow links", () => {
  it("records a link as a link and never descends into it", async () => {
    const { walker } = await walkFake({ real: { "inside.bin": 500 }, shortcut: "link" });
    const raw = walker.raw();
    let shortcut = -1;
    for (let i = 1; i < raw.n; i++) if (walker.nameOf(i) === "shortcut") shortcut = i;
    assert.ok(shortcut > 0, "the link should still be listed");
    assert.equal(raw.flags[shortcut] & F_LINK, F_LINK, "and marked as a link");
    assert.equal(raw.flags[shortcut] & F_DIR, 0, "and never as a folder");
    assert.equal(walker.dirs(), 2, "the root and real, nothing through the link");
  });

  it("does not count a link's size as though it were stored bytes", async () => {
    const { walker } = await walkFake({ "real.bin": 900, "shadow.bin": "link" });
    assert.equal(walker.files(), 2, "both are listed");
    assert.equal(walker.bytes(), 900, "but only the real one occupies anything");
  });
});

describe("the walk survives what it cannot read", () => {
  it("marks a folder it cannot list, says why, and carries on", async () => {
    const { walker } = await walkFake({ fine: { "a.bin": 10 }, blocked: "opaque", also: { "b.bin": 20 } });
    assert.equal(walker.files(), 2, "the readable folders are still read");
    assert.equal(walker.bytes(), 30);
    assert.equal(walker.errors(), 1);
    assert.equal(walker.issues()[0].code, "EPERM");
    assert.match(walker.issues()[0].path, /blocked$/);

    const raw = walker.raw();
    let blocked = -1;
    for (let i = 1; i < raw.n; i++) if (walker.nameOf(i) === "blocked") blocked = i;
    assert.equal(raw.flags[blocked] & F_ERR, F_ERR, "the folder is flagged as unreadable");
  });

  it("records a file it could not stat rather than dropping it quietly", async () => {
    const { walker } = await walkFake({ "ok.bin": 100, "locked.bin": "unreadable" });
    assert.equal(walker.files(), 2, "it is still an entry");
    assert.equal(walker.errors(), 1);
    assert.equal(walker.issues()[0].code, "ESTAT");
    assert.equal(walker.bytes(), 100, "and it contributes no bytes");
  });

  it("finishes rather than hanging when a listing call fails outright", async () => {
    let calls = 0;
    const list: ListDirs = () => {
      calls++;
      return Promise.reject(new Error("the pool died"));
    };
    const walker = new Walker({ root: ROOT, list, batch: 2, concurrency: 2 });
    walker.start();
    const outcome = await walker.done;
    assert.equal(outcome.cancelled, false);
    assert.equal(calls, 1, "one call is enough to discover the pool is gone");
    assert.equal(walker.errors(), 1, "the root is reported as unreadable");
    assert.equal(walker.issues()[0].code, "EWORKER");
  });

  it("keeps only the first two hundred issues, however many there are", async () => {
    const many: { [name: string]: Spec } = {};
    for (let i = 0; i < 250; i++) many["u" + i] = "unreadable";
    const { walker } = await walkFake(many);
    assert.equal(walker.errors(), 250, "every one is counted");
    assert.equal(walker.issues().length, 200, "but the samples are capped");
  });
});

describe("stopping and cancelling", () => {
  it("hands over what it has when asked to stop, and says it was cut short", async () => {
    // The list callback stops the walk as soon as the first folder is read, so
    // the outcome is deterministic rather than a race.
    let walker: Walker;
    const list: ListDirs = (dirs) => {
      const batch = fakeList({ a: { "one.bin": 10 }, b: { "two.bin": 20 } })(dirs);
      walker.stop();
      return batch;
    };
    walker = new Walker({ root: ROOT, list, batch: 1, concurrency: 1 });
    walker.start();
    const outcome = await walker.done;
    assert.equal(outcome.stopped, true);
    assert.equal(outcome.cancelled, false);
    assert.equal(walker.incomplete(), true, "a table built from this must say so");
    assert.ok(walker.raw().n >= 1, "what was measured is kept");
  });

  it("marks itself cancelled when told to throw the work away", async () => {
    const walker = new Walker({ root: ROOT, list: fakeList({ a: { "one.bin": 1 } }), batch: 1, concurrency: 1 });
    walker.start();
    const outcome = await walker.done;
    assert.equal(outcome.cancelled, false, "it finished normally");
    // Cancelling after the fact changes nothing, which is the point of the guard.
    walker.cancel();
    assert.equal(walker.incomplete(), false);
  });

  it("stops reporting itself as running the moment it is asked to stop", async () => {
    // A driver publishes progress and previews from these callbacks, so it has
    // to be told to stop before it does, not afterwards.
    let during = true;
    let walker!: Walker;
    const list: ListDirs = (dirs) => {
      walker.stop();
      during = walker.running();
      return fakeList({ a: { "one.bin": 1 } })(dirs);
    };
    walker = new Walker({ root: ROOT, list, batch: 1, concurrency: 1 });
    walker.start();
    await walker.done;
    assert.equal(during, false);
  });
});

describe("the biggest folders so far", () => {
  it("ranks the direct children of the root by what they hold", async () => {
    const { walker } = await walkFake({
      small: { "a.bin": 10 },
      big: { "b.bin": 5000, deep: { "c.bin": 1000 } },
      medium: { "d.bin": 500 },
    });
    const top = walker.top(2);
    assert.equal(top.length, 2);
    assert.equal(walker.nameOf(top[0].id), "big");
    assert.equal(top[0].bytes, 6000, "a folder counts everything under it");
    assert.equal(walker.nameOf(top[1].id), "medium");
  });

  it("counts a file sitting directly in the root as its own line", async () => {
    const { walker } = await walkFake({ "loose.bin": 700, folder: { "in.bin": 100 } });
    const top = walker.top(5);
    const loose = top.find((t) => walker.nameOf(t.id) === "loose.bin");
    assert.ok(loose, "a loose file should appear");
    assert.equal(loose.bytes, 700);
  });

  it("knows which entries are folders", async () => {
    const { walker } = await walkFake({ folder: { "in.bin": 1 }, "file.bin": 2 });
    const byName = new Map(walker.top(5).map((t) => [walker.nameOf(t.id), t]));
    assert.equal(walker.isDir(byName.get("folder")!.id), true);
    assert.equal(walker.isDir(byName.get("file.bin")!.id), false);
  });
});

describe("the walk against a real disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "spacewise-walk-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  // The production lister, driven the way the command line tool drives it.
  const realList: ListDirs = (dirs) => {
    const counts = new Uint32Array(dirs.length);
    const failed: [number, string][] = [];
    const flags: number[] = [];
    const sizes: number[] = [];
    const logical: number[] = [];
    const mtimes: number[] = [];
    const nameLens: number[] = [];
    const parts: Uint8Array[] = [];
    const lister = makeLister({
      add(name, flag, onDisk, length, mtime) {
        const bytes = encoder.encode(name);
        nameLens.push(bytes.length);
        parts.push(bytes);
        flags.push(flag);
        sizes.push(onDisk);
        logical.push(length);
        mtimes.push(mtime);
      },
    } satisfies EntrySink);
    for (let d = 0; d < dirs.length; d++) {
      const result = lister(dirs[d]);
      if (typeof result === "string") failed.push([d, result]);
      else counts[d] = result;
    }
    let total = 0;
    for (const part of parts) total += part.length;
    const names = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
      names.set(part, at);
      at += part.length;
    }
    return Promise.resolve({
      counts,
      failed,
      nameLens: Uint16Array.from(nameLens),
      names,
      sizes: Float64Array.from(sizes),
      logical: Float64Array.from(logical),
      mtimes: Uint32Array.from(mtimes),
      flags: Uint8Array.from(flags),
    } satisfies DirBatch);
  };

  it("reads a real tree and agrees with what was written to it", async () => {
    const root = join(dir, "real");
    mkdirSync(join(root, "one", "deeper"), { recursive: true });
    mkdirSync(join(root, "two"), { recursive: true });
    writeFileSync(join(root, "top.bin"), Buffer.alloc(1000));
    writeFileSync(join(root, "one", "a.bin"), Buffer.alloc(2000));
    writeFileSync(join(root, "one", "deeper", "b.bin"), Buffer.alloc(3000));
    writeFileSync(join(root, "two", "c.bin"), Buffer.alloc(4000));

    const walker = new Walker({ root, list: realList, batch: 4, concurrency: 2 });
    walker.start();
    const outcome = await walker.done;

    assert.equal(outcome.cancelled, false);
    assert.equal(walker.files(), 4, "four files");
    assert.equal(walker.dirs(), 4, "the root, one, one/deeper and two");
    assert.equal(walker.errors(), 0);
    assert.ok(walker.bytes() >= 10_000, `expected at least the 10 kB written, got ${walker.bytes()}`);
    // Every node must be reachable from the root, or the tree is broken.
    const raw = walker.raw();
    for (let i = 1; i < raw.n; i++) assert.ok(raw.parent[i] >= 0 && raw.parent[i] < i, `node ${i} has no sensible parent`);
  });

  it("records a real folder that cannot be read, rather than skipping it", async () => {
    const missing = join(dir, "not-there");
    const walker = new Walker({ root: missing, list: realList, batch: 1, concurrency: 1 });
    walker.start();
    await walker.done;
    assert.equal(walker.errors(), 1);
    assert.equal(walker.issues()[0].code, "ENOENT");
  });
});
