// The filesystem probe every deletion guard shares: the cleanup planner's
// recheck, and the recheck in front of `shell:trash`.
//
// It reads with lstat and never stat, so a link is measured as the link rather
// than as its target.
//
// The modification time is in whole SECONDS. That is not a detail: it is the
// unit the scan table stores (`mtime` in types.ts), the unit the lister records
// (lister.ts) and the unit `fs:stat` reports. The renderer sends a file's size
// and mtime exactly as the table holds them, so a probe in any other unit
// disagrees with every target it is handed and refuses every file it is asked
// about. Which is what happened while this returned milliseconds: nothing could
// be moved to the Recycle Bin, and the interface said the files might be in use.
//
// This lives in its own module rather than inside index.ts so it can be held to
// the scanner's units by a test. The previous arrangement could not be: the
// cleanup planner fills each item's size and mtime from this same probe
// (cleanup.ts `buildPlan`), so the planner was comparing the probe with itself,
// and the unit could be wrong without any test noticing.
import { lstatSync } from "node:fs";
import type { FsProbe } from "../shared/cleanup";

export const fsProbe: FsProbe = {
  resolve(path) {
    try {
      lstatSync(path);
      return path;
    } catch {
      return null;
    }
  },
  fingerprint(path) {
    try {
      const st = lstatSync(path);
      return { size: st.size, mtime: Math.max(0, Math.floor(st.mtimeMs / 1000)) };
    } catch {
      return null;
    }
  },
};
