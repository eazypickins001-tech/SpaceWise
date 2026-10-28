// The rules behind "Why Is My PC Slow?".
//
// The machine is not involved: each test hands `diagnose` a fixed set of readings.
// The two properties that matter most are here — a finding only appears when the
// number behind it was actually read, and an unread check never counts as good
// news.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MANY_STARTUP_ITEMS, SLOW_BOOT_SECONDS, diagnose } from "./slow";
import type { SlowFacts } from "./slow";

const GB = 1024 ** 3;

const nothing: SlowFacts = {
  space: null,
  memory: null,
  disk: null,
  io: null,
  boot: null,
  startup: null,
  missing: {},
};

const facts = (over: Partial<SlowFacts>): SlowFacts => ({ ...nothing, ...over });

test("a machine with nothing wrong produces no findings", () => {
  assert.deepEqual(
    diagnose(
      facts({
        space: { totalBytes: 200 * GB, freeBytes: 100 * GB },
        memory: { commitLimitBytes: 20 * GB, committedBytes: 6 * GB },
        disk: { status: "Healthy", wear: 3, readErrors: 0 },
        io: { secondsPerTransfer: 0.002, queueLength: 1 },
        boot: { seconds: 12, blamed: [] },
        startup: { count: 4 },
      }),
    ),
    [],
  );
});

test("a nearly full system drive is high, and a tight one is medium", () => {
  const full = diagnose(facts({ space: { totalBytes: 200 * GB, freeBytes: 10 * GB } }));
  assert.equal(full.length, 1);
  assert.equal(full[0].id, "space-full");
  assert.equal(full[0].severity, "high");
  assert.equal(full[0].values.percentFree, 5);
  assert.deepEqual(full[0].action, { kind: "largest" });

  const tight = diagnose(facts({ space: { totalBytes: 200 * GB, freeBytes: 24 * GB } }));
  assert.equal(tight[0].id, "space-tight");
  assert.equal(tight[0].severity, "medium");

  // 20% free is not a finding at all.
  assert.deepEqual(diagnose(facts({ space: { totalBytes: 200 * GB, freeBytes: 40 * GB } })), []);
});

test("commit charge close to the commit limit is a finding", () => {
  const out = diagnose(facts({ memory: { commitLimitBytes: 20 * GB, committedBytes: 19 * GB } }));
  assert.equal(out[0].id, "memory-pressure");
  assert.equal(out[0].values.percentCommitted, 95);
  assert.equal(out[0].action, null, "no button that goes somewhere unhelpful");
});

test("committing more than physical RAM is normal and is not a finding", () => {
  // This machine: 8 GB of RAM, a 33 GB commit limit, 27 GB committed. Comparing
  // committed bytes to RAM would call that a 328% emergency.
  assert.deepEqual(diagnose(facts({ memory: { commitLimitBytes: 33 * GB, committedBytes: 27 * GB } })), []);
});

test("a disk that is not healthy, or reports errors or wear, is a high finding", () => {
  for (const disk of [
    { status: "Unhealthy", wear: null, readErrors: null },
    { status: "Healthy", wear: null, readErrors: 4 },
    { status: "Healthy", wear: 91, readErrors: 0 },
  ]) {
    const out = diagnose(facts({ disk }));
    assert.equal(out.length, 1, JSON.stringify(disk));
    assert.equal(out[0].id, "disk-unhealthy");
    assert.equal(out[0].severity, "high");
  }
});

test("slow I/O is a finding, whether from latency or a queue", () => {
  assert.equal(diagnose(facts({ io: { secondsPerTransfer: 0.06, queueLength: 0 } }))[0].id, "io-slow");
  assert.equal(diagnose(facts({ io: { secondsPerTransfer: 0.001, queueLength: 4 } }))[0].id, "io-slow");
});

test("a slow boot names what Windows blamed, and hands over to Startup apps", () => {
  const out = diagnose(facts({ boot: { seconds: SLOW_BOOT_SECONDS + 13, blamed: ["Teams", "OneDrive", "Steam"] } }));
  assert.equal(out[0].id, "boot-slow");
  assert.equal(out[0].values.seconds, SLOW_BOOT_SECONDS + 13);
  assert.equal(out[0].values.blamed, "Teams, OneDrive, Steam");
  assert.deepEqual(out[0].action, { kind: "windows", page: "startupapps" });
});

test("a slow boot with nothing blamed is only worth noting", () => {
  const out = diagnose(facts({ boot: { seconds: 45, blamed: [] } }));
  assert.equal(out[0].id, "boot-slow");
  assert.equal(out[0].severity, "info");
});

test("a long startup list is a finding, and one shy of the threshold is not", () => {
  assert.equal(diagnose(facts({ startup: { count: MANY_STARTUP_ITEMS } }))[0].id, "startup-busy");
  assert.deepEqual(diagnose(facts({ startup: { count: MANY_STARTUP_ITEMS - 1 } })), []);
});

test("an unread check is never treated as good news", () => {
  // Everything failed to read: there is nothing to report, and nothing to praise.
  const out = diagnose(
    facts({
      missing: {
        space: "the drive did not answer",
        memory: "no counter",
        disk: "access denied",
        io: "no samples",
        boot: "no events",
        startup: "access denied",
      },
    }),
  );
  assert.deepEqual(out, []);
});

test("findings come back most severe first", () => {
  const out = diagnose(
    facts({
      space: { totalBytes: 200 * GB, freeBytes: 26 * GB }, // 13%: medium, under the 15% line
      disk: { status: "Unhealthy", wear: null, readErrors: null }, // high
      startup: { count: 20 }, // info
    }),
  );
  assert.deepEqual(
    out.map((f) => f.severity),
    ["high", "medium", "info"],
  );
});
