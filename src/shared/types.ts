// Types shared by the main process, the workers and the renderer.

export const F_DIR = 1;
export const F_LINK = 2; // symlink or junction, never followed
export const F_ERR = 4; // unreadable folder or failed stat
export const F_GONE = 8; // removed from inside the app after the scan

// One scan, stored as columns. Node 0 is the root and every parent index is
// lower than its children, so one backward pass can sum sizes upward.
export interface ScanTable {
  root: string;
  n: number;
  parent: Int32Array;
  size: Float64Array; // bytes on disk where the system reports it
  logical: Float64Array; // length in bytes
  mtime: Uint32Array; // seconds since epoch
  flags: Uint8Array;
  files: Uint32Array; // files in the subtree, 1 for a file
  nameOff: Uint32Array; // n + 1 offsets into names
  names: Uint8Array; // UTF-8
  childStart: Int32Array; // n + 1 offsets into childList
  childList: Int32Array; // children of each folder, largest first
  ext: Uint16Array; // index into exts, 0 means none
  exts: string[];
  startedAt: number;
  durationMs: number;
  dirs: number;
  errors: number;
  errorSamples: ScanIssue[];
  incomplete?: boolean; // the scan was stopped before the end
}

export interface ScanIssue {
  path: string;
  code: string;
}

export interface ScanProgress {
  files: number;
  dirs: number;
  bytes: number;
  errors: number;
  current: string;
  elapsedMs: number;
  top: { name: string; bytes: number; dir: boolean }[];
}

export interface DriveInfo {
  path: string;
  label?: string; // shown instead of the path when the system names the volume
  total: number;
  free: number;
}

// What the platform underneath can do. The interface hides what it cannot.
export interface Capabilities {
  windows: boolean; // several windows, each with its own scan
  trash: boolean; // send to a Recycle Bin
  reveal: boolean; // open the file manager at an item, open an item
  update: boolean; // check for and install new versions
  watch: boolean; // live sync with the disk
  fileClipboard: boolean; // copy, cut and paste files
  drop: boolean; // drop a folder on the window
  driveTotals: boolean; // a scan of a whole drive covers the space the drive reports as used
}

export interface SnapshotMeta {
  file: string;
  root: string;
  date: number;
  total: number;
  files: number;
}

// A reduced copy of a past scan: every folder plus the large files.
export interface SnapshotTable {
  meta: SnapshotMeta;
  n: number;
  parent: Int32Array;
  size: Float64Array;
  flags: Uint8Array;
  nameOff: Uint32Array;
  names: Uint8Array;
}

export interface DupCandidate {
  size: number;
  ids: number[];
  paths: string[];
}

export interface DupGroup {
  size: number;
  ids: number[];
}

export interface DupProgress {
  done: number;
  total: number;
  bytes: number;
  totalBytes: number;
}

// What the interface may know about the optional storage summary. The key is
// never among these: it stays in the main process.
export interface AiStatusState {
  configured: boolean;
  baseUrl: string;
  model: string;
  hasKey: boolean;
  problem: string | null;
  // Whether the licence unlocks the feature at all, decided in the main process.
  unlocked: boolean;
}

export interface AiSummaryResult {
  ok: boolean;
  text: string;
  error: string;
  // How much was sent, so the interface can say so afterwards.
  bytes: number;
  // Which model produced the text, when one did. Several may be configured and
  // the first that answers is used, so saying which one is a matter of honesty
  // rather than of detail.
  model?: string;
}

// What a caller believed about a file when it asked for it to be removed.
// Deletion is immediate, so the belief is checked again before it happens.
export interface TrashTarget {
  path: string;
  size: number | null;
  mtime: number | null;
}

export interface TrashResult {
  path: string;
  ok: boolean;
  error?: string;
}

// One batch of folders that changed on disk, listed again. The arrays are the
// same ones a folder worker returns during a scan.
export interface WatchBatch {
  paths: string[];
  counts: Uint32Array;
  failed: [number, string][];
  nameLens: Uint16Array;
  names: Uint8Array;
  sizes: Float64Array;
  logical: Float64Array;
  mtimes: Uint32Array;
  flags: Uint8Array;
}

// An app installed on a phone, with what it takes and when it was last opened.
export interface AppEntry {
  pkg: string;
  label: string;
  icon: string; // a data URL
  system: boolean; // part of the system image: it can be disabled, not uninstalled
  installed: number; // ms
  lastUsed: number; // ms, 0 when Android has no record
  appBytes: number;
  dataBytes: number;
  cacheBytes: number;
}

// What only a phone offers. Absent on the desktop.
export interface PhoneApi {
  readonly sdk: number; // Android's API level; 30 (Android 11) brought the trash and the cache dialog
  usageAccess(): Promise<boolean>;
  requestUsageAccess(): Promise<void>;
  apps(): Promise<{ granted: boolean; apps: AppEntry[] }>;
  uninstall(pkg: string): Promise<void>;
  appInfo(pkg: string): Promise<void>;
  clearAppCaches(): Promise<boolean>; // false where Android has no such dialog
  // For good, no trash. Takes the same TrashTarget the desktop path takes, so an
  // implementation is handed what the caller believed about each file and can
  // revalidate it with `changedSince` before removing anything. Deleting on a
  // claim that has gone stale is the one mistake this application is built not
  // to make, so bare paths are deliberately not accepted here, and a type error
  // is the reminder rather than a comment.
  erase(targets: TrashTarget[]): Promise<TrashResult[]>;
  thumb(path: string): string; // a URL the interface can load an image from
}

export interface WindowInfo {
  id: number;
  title: string;
  focused: boolean;
}

// Files waiting to be pasted. A cut moves them, a copy duplicates them.
export interface FileClip {
  paths: string[];
  cut: boolean;
}

export interface PasteResult {
  src: string;
  dest: string;
  ok: boolean;
  error?: string;
}

// One item measured after the scan, ready to be added to it.
export type Measured =
  | { ok: true; kind: "file"; name: string; size: number; mtime: number }
  | { ok: true; kind: "dir"; name: string; table: ScanTable }
  | { ok: false; error: string };

export type ItemStat =
  | { ok: true; created: number; modified: number; accessed: number; readOnly: boolean }
  | { ok: false; error: string };

export type UpdateStatus =
  | { state: "dev" | "checking" | "none" }
  | { state: "available" | "ready"; version: string }
  | { state: "downloading"; percent: number }
  | { state: "error"; error: string };
