// Which drives the start screen lists, and what it says about the ones it could
// not read.
//
// The filesystem is a fake, so the interesting cases -- a share that never
// answers, a letter that holds a device with no media, a drive that reports no
// capacity -- are staged exactly rather than hoped for.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isAbsent, listDrives, reasonFor } from "./drives";
import type { DriveStat } from "./drives";

const B = 4096;

function named(code: string, message = code): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: ${message}, statfs`), { code });
}

function ok(blocks: number, bavail: number): { blocks: number; bsize: number; bavail: number } {
  return { blocks, bsize: B, bavail };
}

// Every letter not named in `map` answers the way a letter with nothing assigned
// to it does, which is what this machine was measured doing.
function fake(map: Partial<Record<string, () => { blocks: number; bsize: number; bavail: number }>>): {
  stat: DriveStat;
  asked: string[];
} {
  const asked: string[] = [];
  const stat: DriveStat = async (path) => {
    asked.push(path);
    const fn = map[path.slice(0, 1).toUpperCase()];
    if (!fn) throw named("ENOENT", "no such file or directory");
    return fn();
  };
  return { stat, asked };
}

test("a letter with nothing on it is left out, and every letter is still asked", async () => {
  const { stat, asked } = fake({ C: () => ok(1000, 250) });
  const drives = await listDrives(stat, { platform: "win32", timeoutMs: 50 });

  assert.equal(asked.length, 26, "all 26 letters are probed");
  assert.equal(drives.length, 1, "only the drive that answered is listed");
  assert.equal(drives[0].path, "C:\\");
  assert.equal(drives[0].total, 1000 * B);
  assert.equal(drives[0].free, 250 * B);
  assert.equal(drives[0].unavailable, undefined);
});

test("a drive that never answers is listed with the reason instead of vanishing", async () => {
  const { stat } = fake({
    C: () => ok(1000, 250),
    // A disconnected network share: the probe is given up on rather than waited
    // for, and the letter must still appear.
    Z: () => new Promise<never>(() => undefined) as never,
  });
  const drives = await listDrives(stat, { platform: "win32", timeoutMs: 20 });

  const z = drives.find((d) => d.path === "Z:\\");
  assert.ok(z, "the drive that hung is still in the list");
  assert.equal(z.unavailable, "it did not answer in time");
  assert.equal(z.total, 0);
  assert.equal(z.free, 0);
  assert.ok(drives.find((d) => d.path === "C:\\"), "and the good drive is beside it");
});

test("a letter that holds a device with no media is listed, not hidden", async () => {
  // Measured on this machine: an empty card-reader slot gives a bare UNKNOWN
  // rather than ENOENT, so it is a letter the system has.
  const { stat } = fake({
    C: () => ok(1000, 250),
    E: () => {
      throw named("UNKNOWN", "unknown error");
    },
  });
  const drives = await listDrives(stat, { platform: "win32", timeoutMs: 50 });

  const e = drives.find((d) => d.path === "E:\\");
  assert.ok(e, "the empty reader is listed rather than dropped");
  assert.equal(e.unavailable, "it could not be read (UNKNOWN)");
});

test("a drive that reports no capacity is listed rather than dropped", async () => {
  const { stat } = fake({ C: () => ok(1000, 250), D: () => ok(0, 0) });
  const drives = await listDrives(stat, { platform: "win32", timeoutMs: 50 });

  const d = drives.find((x) => x.path === "D:\\");
  assert.ok(d);
  assert.equal(d.unavailable, "it reports no capacity");
});

test("a drive that cannot be read is never listed as if it were healthy", async () => {
  const { stat } = fake({
    C: () => ok(1000, 250),
    D: () => {
      throw named("EACCES", "permission denied");
    },
  });
  const drives = await listDrives(stat, { platform: "win32", timeoutMs: 50 });

  const d = drives.find((x) => x.path === "D:\\");
  assert.ok(d);
  // The rule the interface keys on: an unreadable drive always carries a reason.
  assert.equal(typeof d.unavailable, "string");
  assert.notEqual(d.unavailable, "");
});

test("only ENOENT counts as nothing mounted", () => {
  assert.equal(isAbsent(named("ENOENT")), true);
  for (const code of ["UNKNOWN", "EACCES", "ENOTCONN", "EIO", "EBUSY", "ENODEV"]) {
    assert.equal(isAbsent(named(code)), false, code);
  }
  assert.equal(isAbsent(new Error("no code at all")), false);
});

test("a code with one plain meaning becomes a sentence, and anything else stays itself", () => {
  assert.equal(reasonFor(named("ENOTCONN")), "the network drive is not connected");
  assert.equal(reasonFor(named("EACCES")), "reading it needs permission");
  assert.equal(reasonFor(named("EPERM")), "reading it needs permission");
  assert.equal(reasonFor(named("EBUSY")), "it is in use by something else");
  assert.equal(reasonFor(named("EIO")), "the device reported an input/output error");
  assert.equal(reasonFor(named("ENODEV")), "there is no device here");

  // A code with no plain meaning is named rather than dressed up as a cause the
  // code does not carry -- the mistake this product has already shipped twice.
  assert.match(reasonFor(named("EWEIRD")), /EWEIRD/);
  assert.match(reasonFor(named("EWEIRD")), /could not be read/);

  // An error with no code at all still says something rather than nothing.
  assert.equal(reasonFor(new Error("the device is on fire")), "the device is on fire");
  assert.equal(reasonFor({}), "it could not be read");
});

test("elsewhere in the world there is one root to scan", async () => {
  const stat: DriveStat = async (path) => {
    assert.equal(path, "/");
    return ok(2048, 1024);
  };
  const drives = await listDrives(stat, { platform: "linux" });
  assert.deepEqual(drives, [{ path: "/", total: 2048 * B, free: 1024 * B }]);
});
