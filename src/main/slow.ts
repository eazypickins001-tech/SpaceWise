// The readings behind "Why Is My PC Slow?", as taken on a real Windows machine.
//
// One PowerShell call collects them, and every source inside it is guarded on its
// own: a counter this build lacks, a log that needs administrator rights, an OEM
// image that answers differently — those make one reading *unavailable*, with its
// own reason, never the whole sheet and never a silent "healthy". Nothing here
// writes, stops, disables, elevates or connects anywhere.
//
// The judgement lives in src/shared/slow.ts, which is pure and tested. This module
// only measures.
import { execFile } from "node:child_process";
import { statfs } from "node:fs/promises";
import type { SlowFacts } from "../shared/slow";

const TIMEOUT_MS = 25000;

// Kept as one script because six concurrent PowerShell starts proved unreliable:
// the storage module's first load lost the race and one reading came back empty.
const SCRIPT = `
$o = [ordered]@{}
try {
  $d = @(Get-PhysicalDisk)
  $o.diskHealth = (($d | ForEach-Object { "$($_.HealthStatus)" }) -join ';')
  $o.diskState  = (($d | ForEach-Object { "$($_.OperationalStatus)" }) -join ';')
  if ($d.Count -eq 0) { $o.diskError = "Windows' storage provider reported no physical disks on this machine" }
} catch { $o.diskError = "$($_.Exception.Message)" }
try {
  $r = Get-PhysicalDisk | Get-StorageReliabilityCounter | Select-Object -First 1
  if ($r) { $o.wear = $r.Wear; $o.readErrors = $r.ReadErrorsTotal }
} catch { $o.reliabilityError = "$($_.Exception.Message)" }
try {
  $m = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory
  $o.committedBytes = [double]$m.CommittedBytes
  $o.commitLimit = [double]$m.CommitLimit
} catch { $o.memoryError = "$($_.Exception.Message)" }
try {
  $c = Get-Counter '\\\\PhysicalDisk(_Total)\\\\Avg. Disk sec/Transfer','\\\\PhysicalDisk(_Total)\\\\Current Disk Queue Length' -SampleInterval 1 -MaxSamples 1
  $o.transfer = ($c.CounterSamples | Where-Object { $_.Path -like '*sec/transfer*' } | Select-Object -First 1).CookedValue
  $o.queue    = ($c.CounterSamples | Where-Object { $_.Path -like '*queue length*' } | Select-Object -First 1).CookedValue
} catch { $o.ioError = "$($_.Exception.Message)" }
try {
  $e = Get-WinEvent -LogName 'Microsoft-Windows-Diagnostics-Performance/Operational' -MaxEvents 40 -ErrorAction Stop | Where-Object { $_.Id -eq 100 } | Select-Object -First 1
  if ($e) {
    $x = [xml]$e.ToXml()
    $o.bootMs = [double](($x.Event.EventData.Data | Where-Object { $_.Name -eq 'BootTime' }).'#text')
  } else { $o.bootError = 'no boot event was recorded' }
} catch { $o.bootError = "$($_.Exception.Message)" }
try { $o.startup = [int](Get-CimInstance Win32_StartupCommand | Measure-Object).Count }
catch { $o.startupError = "$($_.Exception.Message)" }
$o | ConvertTo-Json -Compress
`;

interface Raw {
  diskHealth?: string;
  diskState?: string;
  diskError?: string;
  wear?: number | null;
  readErrors?: number | null;
  committedBytes?: number;
  commitLimit?: number;
  memoryError?: string;
  transfer?: number;
  queue?: number;
  ioError?: string;
  bootMs?: number;
  bootError?: string;
  startup?: number;
  startupError?: string;
}

function ps(command: string): Promise<string> {
  return new Promise((done) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", command],
      { timeout: TIMEOUT_MS, windowsHide: true },
      (_error, stdout) => done(String(stdout ?? "").trim()),
    );
  });
}

function num(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function reason(error: unknown): string {
  const e = error as { code?: string; message?: string };
  return e?.code ?? e?.message ?? "it could not be read";
}

// Windows' own words for a refused read are alarming and say nothing about what
// happened. "Attempted to perform an unauthorized operation." is the .NET text for an
// access-denied on an event log: it means the log is kept for administrators, and not
// that something improper was tried. A person reading the sheet should not have to know
// that, so it is translated here — and the sentence says plainly that no elevation is
// asked for, because the alternative reading of "unauthorized" is that the application
// did something it should not have.
export function explainReason(what: string, error: string): string {
  const denied = /unauthorized operation|access is denied|access denied|0x80070005|(?:do|does) not have permission/i;
  if (denied.test(error)) {
    return `Windows keeps ${what} for administrators, and SpaceWise runs as you, without administrator rights`;
  }
  return error;
}

export async function readSlowFacts(): Promise<SlowFacts> {
  const facts: SlowFacts = { space: null, memory: null, disk: null, io: null, boot: null, startup: null, missing: {} };
  if (process.platform !== "win32") {
    facts.missing.all = "these readings are Windows-only";
    return facts;
  }

  // Free space needs no PowerShell at all.
  try {
    const drive = process.env.SystemDrive || "C:";
    const s = await statfs(drive + "\\");
    const total = s.blocks * s.bsize;
    if (total <= 0) throw new Error("the system drive reported no capacity");
    facts.space = { totalBytes: total, freeBytes: s.bavail * s.bsize };
  } catch (error) {
    facts.missing.space = reason(error);
  }

  const text = await ps(SCRIPT);
  let raw: Raw | null = null;
  try {
    raw = text === "" ? null : (JSON.parse(text) as Raw);
  } catch {
    raw = null;
  }
  if (!raw) {
    facts.missing.all = "Windows did not answer the readings";
    return facts;
  }

  const health = (raw.diskHealth ?? "").split(";").filter(Boolean);
  const state = (raw.diskState ?? "").split(";").filter(Boolean);
  if (raw.diskError || health.length === 0) {
    facts.missing.disk = explainReason("the disk health report", raw.diskError ?? "Windows' storage provider reported no physical disks on this machine");
  } else {
    // The worst disk is the one worth mentioning; keeping the largest copy of a
    // healthy one would hide a failing second drive.
    const worst = health.findIndex((h, i) => h.toLowerCase() !== "healthy" || (state[i] ?? "").toLowerCase() !== "ok");
    facts.disk = {
      status: worst >= 0 ? health[worst] : "OK",
      // The reliability counters often need administrator rights. When they are
      // not available the health status is still a real reading, so it is still
      // reported; wear and error counts are simply absent.
      wear: num(raw.wear),
      readErrors: num(raw.readErrors),
    };
  }

  const committed = num(raw.committedBytes);
  const limit = num(raw.commitLimit);
  if (raw.memoryError || committed === null || limit === null || limit <= 0) {
    facts.missing.memory = explainReason("the memory counters", raw.memoryError ?? "Windows did not report the memory counters");
  } else {
    facts.memory = { commitLimitBytes: limit, committedBytes: committed };
  }

  const transfer = num(raw.transfer);
  const queue = num(raw.queue);
  if (raw.ioError || transfer === null || queue === null) {
    facts.missing.io = explainReason("the disk counters", raw.ioError ?? "the disk counters were not available");
  } else {
    facts.io = { secondsPerTransfer: transfer, queueLength: queue };
  }

  const bootMs = num(raw.bootMs);
  if (raw.bootError || bootMs === null || bootMs <= 0) {
    facts.missing.boot = explainReason("the start-up log", raw.bootError ?? "Windows kept no boot measurement");
  } else {
    // The per-application breakdown is events 101-110 and is deliberately not read
    // yet: nothing is shown that this build cannot stand behind.
    facts.boot = { seconds: bootMs / 1000, blamed: [] };
  }

  const startup = num(raw.startup);
  if (raw.startupError || startup === null || startup < 0) {
    facts.missing.startup = explainReason("the start-up item list", raw.startupError ?? "Windows did not list the startup items");
  } else {
    facts.startup = { count: startup };
  }

  return facts;
}
