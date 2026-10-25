// The local cleanup and scan audit log.
//
// It records the user's own paths, which is exactly why it is a file on their
// machine and nothing else: no database, no server, no transmission. One JSON
// object per line, newest last, pruned to a bounded number of runs.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import type { AuditRecord } from "../shared/cleanup";

const KEEP_RUNS = 200;
const MAX_BYTES = 8 * 1024 * 1024;

// A damaged line is skipped rather than thrown: an unreadable audit history must
// never stop someone using the application.
export function readAudit(file: string, limit = 50): AuditRecord[] {
  if (!existsSync(file)) return [];
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: AuditRecord[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      out.push(JSON.parse(trimmed) as AuditRecord);
    } catch {
      // Skip the damaged entry.
    }
  }
  out.reverse(); // newest first
  return out.slice(0, Math.max(0, limit));
}

export function appendAudit(file: string, record: AuditRecord, keep = KEEP_RUNS): void {
  mkdirSync(dirname(file), { recursive: true });
  let existing = "";
  if (existsSync(file)) {
    try {
      existing = readFileSync(file, "utf8");
    } catch {
      existing = "";
    }
  }
  let next = existing;
  const line = JSON.stringify(record);
  next = next === "" || next.endsWith("\n") ? next + line + "\n" : next + "\n" + line + "\n";

  // Trim from the front when either the run count or the file size runs away.
  let lines = next.split("\n").filter((l) => l.trim() !== "");
  if (lines.length > keep) lines = lines.slice(lines.length - keep);
  next = lines.join("\n") + "\n";
  if (next.length > MAX_BYTES) {
    // Keep the newest half when a single run is pathologically large.
    lines = lines.slice(Math.floor(lines.length / 2));
    next = lines.join("\n") + "\n";
  }
  writeFileSync(file, next);
}
