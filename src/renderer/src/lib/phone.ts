// Cleaning suggestions for a phone, the kind Android's storage settings and
// Files by Google offer, worked out from a finished scan.
import { F_DIR, F_GONE, F_LINK } from "../../../shared/types";
import type { Disk } from "./disk";

export type CleanKey = "large" | "oldDownloads" | "apks" | "screenshots" | "messaging" | "trashed";

export interface CleanGroup {
  key: CleanKey;
  ids: number[]; // largest first
  bytes: number;
}

export const LARGE = 100 * 1024 * 1024;
const OLD_DAYS = 90;
const APK = new Set(["apk", "apks", "xapk", "apkm"]);

// Folders are marked as they are met; their files inherit the mark.
const DOWNLOADS = 1;
const SCREENSHOTS = 2;
const MESSAGING = 3;

export function cleanGroups(disk: Disk, now = Date.now()): { groups: CleanGroup[]; bytes: number } {
  const t = disk.t;
  const mark = new Uint8Array(t.n);
  const depth = new Uint8Array(t.n);
  const old = Math.floor(now / 1000) - OLD_DAYS * 86400;
  const lists: Record<CleanKey, number[]> = { large: [], oldDownloads: [], apks: [], screenshots: [], messaging: [], trashed: [] };
  const counted = new Uint8Array(t.n); // so a file in two groups is freed only once in the total
  let total = 0;

  for (let i = 1; i < t.n; i++) {
    const p = t.parent[i];
    const f = t.flags[i];
    // Whatever was removed, and everything under it, is no longer there to clean.
    if (f & F_GONE || mark[p] === 255) {
      mark[i] = 255;
      continue;
    }
    if (f & F_DIR) {
      depth[i] = Math.min(255, depth[p] + 1);
      if (mark[p]) {
        mark[i] = mark[p];
        continue;
      }
      const name = disk.name(i).toLowerCase();
      const parent = p > 0 ? disk.name(p).toLowerCase() : "";
      if (depth[i] === 1 && (name === "download" || name === "downloads")) mark[i] = DOWNLOADS;
      else if (name === "screenshots" && (parent === "dcim" || parent === "pictures")) mark[i] = SCREENSHOTS;
      // /WhatsApp/Media, and /Android/media/com.whatsapp/WhatsApp/Media since Android 11.
      else if (name === "media" && parent === "whatsapp") mark[i] = MESSAGING;
      else if ((depth[i] === 1 && name === "telegram") || (name === "org.telegram.messenger" && parent === "media")) mark[i] = MESSAGING;
      continue;
    }
    if (f & F_LINK) continue;
    const size = t.size[i];
    const put = (key: CleanKey): void => {
      lists[key].push(i);
      if (!counted[i]) {
        counted[i] = 1;
        total += size;
      }
    };
    // A dot first, read from the table, before the name is decoded at all.
    if (t.names[t.nameOff[i]] === 0x2e && disk.name(i).startsWith(".trashed-")) {
      put("trashed");
      continue;
    }
    if (APK.has(disk.ext(i))) put("apks");
    if (size >= LARGE) put("large");
    if (mark[p] === DOWNLOADS && t.mtime[i] > 0 && t.mtime[i] < old) put("oldDownloads");
    if (mark[p] === SCREENSHOTS) put("screenshots");
    if (mark[p] === MESSAGING) put("messaging");
  }

  const groups: CleanGroup[] = [];
  for (const key of Object.keys(lists) as CleanKey[]) {
    const ids = lists[key];
    if (ids.length === 0) continue;
    ids.sort((a, b) => t.size[b] - t.size[a]);
    groups.push({ key, ids, bytes: ids.reduce((a, id) => a + t.size[id], 0) });
  }
  groups.sort((a, b) => b.bytes - a.bytes);
  return { groups, bytes: total };
}

// "Used today", "Used 3 days ago": the last use of an app in words.
export function daysSince(ms: number, now = Date.now()): number | null {
  if (!ms) return null;
  return Math.max(0, Math.floor((now - ms) / 86400000));
}
