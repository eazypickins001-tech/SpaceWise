// "Why Is My PC Slow?" — the analysis, with no machine in it.
//
// Every finding is a threshold applied to a number that was actually read. A
// reading that could not be taken is null and is reported as unavailable, never
// treated as healthy: "we could not read the disk's health" and "the disk is fine"
// are different statements, and only the second may be shown as good news.
//
// The words live in the interface, not here. A finding carries its numbers and an
// id; the renderer turns that into a sentence in the reader's language. That is
// the same split the rest of the app uses for anything a person reads.

export type SlowSeverity = "high" | "medium" | "info";

export type SlowId =
  | "space-full"
  | "space-tight"
  | "memory-pressure"
  | "disk-unhealthy"
  | "io-slow"
  | "boot-slow"
  | "startup-busy";

// The Windows settings pages this application may open, by bare page name.
//
// A closed list, and one list: main/external.ts matches against this same array,
// so the type here and the allow-list there cannot drift apart.
export const WINDOWS_PAGES = ["storagesense", "startupapps", "batterysaver", "windowsupdate", "powersleep"] as const;

export type WindowsPage = (typeof WINDOWS_PAGES)[number];

export type SlowAction =
  // Open the tab that would free space. Nothing is removed from here.
  | { kind: "cleanup" }
  | { kind: "largest" }
  // Hand the person to the Windows screen that owns the fix.
  | { kind: "windows"; page: WindowsPage };

export interface SlowFinding {
  id: SlowId;
  severity: SlowSeverity;
  // Numbers and short names the sentence needs, so it can be formatted per locale.
  values: Record<string, string | number>;
  action: SlowAction | null;
}

export interface SlowFacts {
  space: { totalBytes: number; freeBytes: number } | null;
  // Committed bytes against the commit *limit* — RAM plus the page file. Comparing
  // committed memory to physical RAM instead reports three-figure percentages on a
  // perfectly healthy machine, because Windows commits more than it holds.
  memory: { commitLimitBytes: number; committedBytes: number } | null;
  disk: { status: string; wear: number | null; readErrors: number | null } | null;
  io: { secondsPerTransfer: number; queueLength: number } | null;
  boot: { seconds: number; blamed: string[] } | null;
  startup: { count: number } | null;
  // What could not be read, by check name, with the reason. Shown as such.
  missing: Record<string, string>;
}

// Thresholds, named so the interface can quote them rather than invent its own.
export const TIGHT_FREE_RATIO = 0.15;
export const FULL_FREE_RATIO = 0.08;
export const MEMORY_PRESSURE_RATIO = 0.9;
export const SLOW_TRANSFER_SECONDS = 0.025;
export const BUSY_QUEUE_LENGTH = 2;
export const SLOW_BOOT_SECONDS = 30;
export const MANY_STARTUP_ITEMS = 12;

const RANK: Record<SlowSeverity, number> = { high: 0, medium: 1, info: 2 };

export function diagnose(f: SlowFacts): SlowFinding[] {
  const out: SlowFinding[] = [];

  if (f.space && f.space.totalBytes > 0) {
    const ratio = f.space.freeBytes / f.space.totalBytes;
    if (ratio < TIGHT_FREE_RATIO) {
      const full = ratio < FULL_FREE_RATIO;
      out.push({
        id: full ? "space-full" : "space-tight",
        severity: full ? "high" : "medium",
        values: {
          percentFree: Math.round(ratio * 100),
          freeBytes: f.space.freeBytes,
          totalBytes: f.space.totalBytes,
        },
        // Both of these are storage, which is the part SpaceWise can actually do.
        action: { kind: "largest" },
      });
    }
  }

  if (f.memory && f.memory.commitLimitBytes > 0) {
    const ratio = f.memory.committedBytes / f.memory.commitLimitBytes;
    if (ratio >= MEMORY_PRESSURE_RATIO) {
      out.push({
        id: "memory-pressure",
        severity: "medium",
        values: { percentCommitted: Math.round(ratio * 100), limitBytes: f.memory.commitLimitBytes },
        // Nothing in Windows Settings fixes this by itself, so no button is offered
        // rather than a button that goes somewhere unhelpful.
        action: null,
      });
    }
  }

  if (f.disk) {
    const status = f.disk.status.trim().toLowerCase();
    const healthy = status === "ok" || status === "healthy";
    const readErrors = f.disk.readErrors ?? 0;
    const wear = f.disk.wear ?? 0;
    if (!healthy || readErrors > 0 || wear >= 80) {
      out.push({
        id: "disk-unhealthy",
        severity: "high",
        values: { status: f.disk.status, readErrors, wear },
        // A failing disk is not a settings problem, and nothing here can fix it.
        action: null,
      });
    }
  }

  if (f.io && (f.io.secondsPerTransfer >= SLOW_TRANSFER_SECONDS || f.io.queueLength >= BUSY_QUEUE_LENGTH)) {
    out.push({
      id: "io-slow",
      severity: "medium",
      values: {
        msPerTransfer: Math.round(f.io.secondsPerTransfer * 1000),
        queue: Math.round(f.io.queueLength),
      },
      action: null,
    });
  }

  if (f.boot && f.boot.seconds >= SLOW_BOOT_SECONDS) {
    out.push({
      id: "boot-slow",
      severity: f.boot.blamed.length > 0 ? "medium" : "info",
      values: {
        seconds: Math.round(f.boot.seconds),
        blamed: f.boot.blamed.slice(0, 3).join(", "),
      },
      action: { kind: "windows", page: "startupapps" },
    });
  }

  if (f.startup && f.startup.count >= MANY_STARTUP_ITEMS) {
    out.push({
      id: "startup-busy",
      severity: "info",
      values: { count: f.startup.count },
      action: { kind: "windows", page: "startupapps" },
    });
  }

  return out.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
}
