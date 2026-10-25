// Who may name which paths.
//
// Every handler that turns a renderer-supplied path into a filesystem action
// goes through here, so there is one policy rather than eight copies of one.
//
// Two rules, and they are deliberately not equally strong:
//
//   1. The path must lie in a folder this window actually scanned. This is
//      hygiene rather than a boundary, because scanning is itself driven from
//      the interface: whatever can reach `scan:start` can put any existing
//      folder into that set. It stops a mistake in the interface from reaching
//      outside the window's own subject matter, and it is a precondition for
//      tightening scan initiation later.
//
//   2. The path must not be an operating-system location or a credential store
//      (see `protectedPlace`). This one holds even when the first does not,
//      because it does not depend on what was scanned. Under a compromised
//      renderer it is the rule doing the actual work.
//
// The reaches below differ in one way: a folder that was scanned may be read,
// revealed, and pasted into, but may not itself be deleted or moved.
import { isInside, normalizePath, protectedPlace } from "../shared/cleanup";

export type Reach =
  // The scanned root itself, or anything inside it: revealing, measuring,
  // opening, and the destination of a paste.
  | "scan"
  // Something being deleted or moved. Never the scanned root itself.
  | "target";

export interface ScopeRequest {
  path: string;
  roots: ReadonlySet<string>;
  reach: Reach;
}

// Returns null when the path may be used, or a reason when it may not.
export function refuseReason({ path, roots, reach }: ScopeRequest): string | null {
  const raw = String(path ?? "");
  if (raw === "") return "no path was given";
  if (raw.includes("*") || raw.includes("?")) return "a wildcard is not a path";

  const norm = normalizePath(raw);
  if (norm === "") return "that is not a path";

  const guarded = protectedPlace(norm);
  if (guarded) return guarded;

  const lower = norm.toLowerCase();
  let inside = false;
  let isRoot = false;
  for (const root of roots) {
    const r = root.toLowerCase();
    if (r === lower) {
      isRoot = true;
      inside = true;
      break;
    }
    if (isInside(r, lower)) {
      inside = true;
      break;
    }
  }

  if (!inside) return "that location is not part of a scan in this window";
  if (reach === "target" && isRoot) return "the folder that was scanned is not itself a target";
  return null;
}
