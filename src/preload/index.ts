import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { IpcRendererEvent } from "electron";
import type {
  DriveInfo,
  DupCandidate,
  DupGroup,
  DupProgress,
  FileClip,
  ItemStat,
  Measured,
  PasteResult,
  WatchBatch,
  WindowInfo,
  ScanProgress,
  ScanTable,
  SnapshotMeta,
  SnapshotTable,
  TrashResult,
  TrashTarget,
  AiStatusState,
  AiSummaryResult,
  UpdateStatus,
  Capabilities,
  PhoneApi,
} from "../shared/types";
import type { Action, AuditRecord, Candidate, CleanupPlan, CleanupProgress, CleanupRunResult } from "../shared/cleanup";
import type { LicenseState } from "../shared/entitlements";

// Main to renderer events return an unsubscribe function, for effect cleanup.
function on<A extends unknown[]>(channel: string, cb: (...args: A) => void): () => void {
  const h = (_e: IpcRendererEvent, ...args: unknown[]): void => cb(...(args as A));
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.off(channel, h);
}

const api = {
  can: { windows: true, trash: true, reveal: true, update: true, watch: true, fileClipboard: true, drop: true, driveTotals: true } as Capabilities,
  compact: false, // a phone-sized screen
  phone: undefined as PhoneApi | undefined,
  // Desktop systems let any program read the disk; there is nothing to ask for.
  access: async (): Promise<boolean> => true,
  requestAccess: async (): Promise<void> => undefined,
  onResume: (_cb: () => void): (() => void) => () => undefined,

  listDrives: (): Promise<DriveInfo[]> => ipcRenderer.invoke("drives:list"),
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke("dialog:pickFolder"),

  startScan: (root: string, liveDepth?: number): Promise<{ ok: boolean; root?: string; error?: string }> =>
    ipcRenderer.invoke("scan:start", root, liveDepth),
  stopScan: (): Promise<void> => ipcRenderer.invoke("scan:stop"),
  cancelScan: (): Promise<void> => ipcRenderer.invoke("scan:cancel"),
  onScanProgress: (cb: (p: ScanProgress) => void) => on("scan:progress", cb),
  onScanPartial: (cb: (t: ScanTable) => void) => on("scan:partial", cb),
  onScanDone: (cb: (t: ScanTable, snapshot: SnapshotMeta | null) => void) => on("scan:done", cb),
  onScanError: (cb: (error: string) => void) => on("scan:error", cb),

  listSnapshots: (root: string): Promise<SnapshotMeta[]> => ipcRenderer.invoke("snap:list", root),
  loadSnapshot: (file: string): Promise<{ ok: boolean; snapshot?: SnapshotTable; error?: string }> =>
    ipcRenderer.invoke("snap:load", file),

  startDuplicates: (candidates: DupCandidate[]): Promise<void> => ipcRenderer.invoke("dup:start", candidates),
  cancelDuplicates: (): Promise<void> => ipcRenderer.invoke("dup:cancel"),
  onDupProgress: (cb: (p: DupProgress) => void) => on("dup:progress", cb),
  onDupDone: (cb: (groups: DupGroup[]) => void) => on("dup:done", cb),
  onDupError: (cb: (error: string) => void) => on("dup:error", cb),

  showInFolder: (path: string): Promise<void> => ipcRenderer.invoke("shell:showInFolder", path),
  openPath: (path: string): Promise<string> => ipcRenderer.invoke("shell:openPath", path),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke("shell:openExternal", url),
  trash: (targets: TrashTarget[]): Promise<TrashResult[]> => ipcRenderer.invoke("shell:trash", targets),

  planCleanup: (scope: string, candidates: Candidate[], action: Action): Promise<CleanupPlan> =>
    ipcRenderer.invoke("clean:plan", scope, candidates, action),
  runCleanup: (plan: CleanupPlan): Promise<CleanupRunResult> => ipcRenderer.invoke("clean:run", plan),
  cancelCleanup: (): Promise<void> => ipcRenderer.invoke("clean:cancel"),
  onCleanupProgress: (cb: (progress: CleanupProgress) => void) => on("clean:progress", cb),
  cleanupHistory: (limit?: number): Promise<AuditRecord[]> => ipcRenderer.invoke("clean:history", limit),

  // Folders this person protects from cleanup. Each call returns the new list.
  protectedFolders: (): Promise<string[]> => ipcRenderer.invoke("protect:list"),
  addProtectedFolder: (path: string): Promise<string[]> => ipcRenderer.invoke("protect:add", path),
  removeProtectedFolder: (path: string): Promise<string[]> => ipcRenderer.invoke("protect:remove", path),

  licenseStatus: (): Promise<LicenseState> => ipcRenderer.invoke("lic:status"),
  activateLicense: (token: string): Promise<LicenseState> => ipcRenderer.invoke("lic:activate", token),
  clearLicense: (): Promise<LicenseState> => ipcRenderer.invoke("lic:clear"),

  aiStatus: (): Promise<AiStatusState> => ipcRenderer.invoke("ai:status"),
  aiConfigure: (settings: { baseUrl?: string; model?: string; apiKey?: string }): Promise<AiStatusState> =>
    ipcRenderer.invoke("ai:configure", settings),
  // Handed the exact text that was shown for approval, and nothing else.
  aiSummarise: (message: string): Promise<AiSummaryResult> => ipcRenderer.invoke("ai:summarise", message),
  aiAsk: (message: string): Promise<AiSummaryResult> => ipcRenderer.invoke("ai:ask", message),

  copyText: (text: string): Promise<void> => ipcRenderer.invoke("clipboard:write", text),

  measure: (path: string): Promise<Measured> => ipcRenderer.invoke("fs:measure", path),
  stat: (path: string): Promise<ItemStat> => ipcRenderer.invoke("fs:stat", path),
  setClip: (paths: string[], cut: boolean): Promise<void> => ipcRenderer.invoke("clip:set", paths, cut),
  getClip: (): Promise<FileClip | null> => ipcRenderer.invoke("clip:get"),
  paste: (paths: string[], cut: boolean, destDir: string): Promise<PasteResult[]> => ipcRenderer.invoke("fs:paste", paths, cut, destDir),

  onPasteProgress: (cb: (p: { done: number; total: number }) => void) => on("paste:progress", cb),

  startWatch: (root: string): Promise<void> => ipcRenderer.invoke("watch:start", root),
  stopWatch: (): Promise<void> => ipcRenderer.invoke("watch:stop"),
  onWatchChanges: (cb: (batch: WatchBatch) => void) => on("watch:changes", cb),
  onWatchLost: (cb: () => void) => on("watch:lost", cb),
  saveSnapshot: (reduced: import("../shared/reduce").Reduced): Promise<SnapshotMeta | null> => ipcRenderer.invoke("snap:save", reduced),

  newWindow: (root?: string): Promise<void> => ipcRenderer.invoke("win:new", root),
  closeWindow: (): Promise<void> => ipcRenderer.invoke("win:close"),
  listWindows: (): Promise<WindowInfo[]> => ipcRenderer.invoke("win:list"),
  focusWindow: (id: number): Promise<void> => ipcRenderer.invoke("win:focus", id),
  arrangeWindows: (how: "columns" | "rows" | "cascade"): Promise<void> => ipcRenderer.invoke("win:arrange", how),
  setTitle: (title: string): Promise<void> => ipcRenderer.invoke("win:setTitle", title),
  onWindows: (cb: (list: WindowInfo[]) => void) => on("win:list", cb),

  setOverlay: (symbolColor: string): Promise<void> => ipcRenderer.invoke("win:setOverlay", symbolColor),
  toggleFullScreen: (): Promise<void> => ipcRenderer.invoke("win:toggleFullScreen"),
  toggleDevTools: (): Promise<void> => ipcRenderer.invoke("win:devtools"),
  // `build` is the commit and time this bundle was built, so the About box can
  // say which build is running rather than only which version.
  info: (): Promise<{ version: string; platform: string; home: string; build: string }> => ipcRenderer.invoke("app:info"),
  quit: (): Promise<void> => ipcRenderer.invoke("app:quit"),

  checkUpdate: (): Promise<void> => ipcRenderer.invoke("upd:check"),
  downloadUpdate: (): Promise<void> => ipcRenderer.invoke("upd:download"),
  installUpdate: (): Promise<void> => ipcRenderer.invoke("upd:install"),
  onUpdateStatus: (cb: (s: UpdateStatus) => void) => on("upd:status", cb),
};

contextBridge.exposeInMainWorld("api", api);

export type Api = typeof api;
