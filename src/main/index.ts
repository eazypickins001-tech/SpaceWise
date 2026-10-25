import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, screen, shell } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import { copyFile, lstat, mkdir, readdir, readlink, rename, rm, stat, statfs, symlink } from "fs/promises";
import { createReadStream, createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { existsSync, lstatSync, watch as watchFs } from "fs";
import type { FSWatcher } from "fs";
import { execFile } from "child_process";
import { basename, dirname, extname, join, resolve, sep } from "path";
import { Worker } from "worker_threads";
import { autoUpdater } from "electron-updater";
import { listSnapshots, readSnapshot, storeSnapshot } from "./snapshots";
import type { Reduced } from "../shared/reduce";
import { appendAudit, readAudit } from "./audit-log";
import { EMBEDDED_PUBLIC_KEY } from "./license";
import { activateLicense, clearLicense, licenseStatus } from "./license-store";
import type { LicenseStore } from "./license-store";
import { hasFeature } from "../shared/entitlements";
import type { LicenseState } from "../shared/entitlements";
import { aiStatus, readAiSettings, requestSummary, settingsPathIn, writeAiSettings } from "./ai";
import type { AiSettings } from "./ai";
import { buildAuditRecord, buildPlan, changedSince, normalizePath, revalidate } from "../shared/cleanup";
import type { Action, AuditRecord, Candidate, CleanupPlan, FsProbe, ItemOutcome } from "../shared/cleanup";
import { refuseReason } from "./scope";
import type { Reach } from "./scope";
import type { DirResult } from "./dirworker";
import type {
  DriveInfo,
  DupCandidate,
  FileClip,
  ItemStat,
  Measured,
  PasteResult,
  ScanTable,
  TrashResult,
  TrashTarget,
  AiStatusState,
  AiSummaryResult,
  UpdateStatus,
  WindowInfo,
} from "../shared/types";

const BAR_HEIGHT = 36;

// One window is one scan. Everything a window owns lives in its session.
interface Session {
  win: BrowserWindow;
  // Every root this window has scanned. A cleanup plan may only touch paths
  // under one of them, so the renderer cannot aim the cleanup code at an
  // arbitrary folder it never scanned.
  roots: Set<string>;
  scan: Worker | null;
  dup: Worker | null;
  watch: Watch | null;
}

// Live sync: the system reports which folders changed and only those are
// listed again.
interface Watch {
  watcher: FSWatcher;
  lister: Worker;
  dirty: Set<string>;
  batch: string[] | null; // being listed right now
  timer: NodeJS.Timeout | null;
}
const sessions = new Map<number, Session>(); // by webContents id

const snapshotDir = (): string => join(app.getPath("userData"), "snapshots");
const sessionOf = (e: IpcMainInvokeEvent): Session | undefined => sessions.get(e.sender.id);

function send(s: Session, channel: string, ...args: unknown[]): void {
  if (!s.win.isDestroyed()) s.win.webContents.send(channel, ...args);
}
function broadcast(channel: string, ...args: unknown[]): void {
  for (const s of sessions.values()) send(s, channel, ...args);
}

function windowList(): WindowInfo[] {
  const focused = BrowserWindow.getFocusedWindow();
  return [...sessions.values()].map((s) => ({ id: s.win.id, title: s.win.getTitle(), focused: s.win === focused }));
}
const announceWindows = (): void => broadcast("win:list", windowList());

function createWindow(root?: string): void {
  // A new window opens a little down and to the right of the current one.
  const from = BrowserWindow.getFocusedWindow();
  const at = from && !from.isMaximized() ? { x: from.getBounds().x + 32, y: from.getBounds().y + 32 } : {};
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    ...at,
    minWidth: 920,
    minHeight: 560,
    show: false,
    title: "SpaceWise",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#11121a" : "#ffffff",
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#00000000", symbolColor: "#808080", height: BAR_HEIGHT },
    icon: join(__dirname, "../../build/icon.png"),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: true,
      contextIsolation: true,
    },
  });
  const id = win.webContents.id;
  const session: Session = { win, scan: null, dup: null, watch: null, roots: new Set() };
  sessions.set(id, session);

  win.once("ready-to-show", () => win.show());
  win.on("closed", () => {
    stopScan(session);
    stopDup(session);
    stopWatch(session);
    sessions.delete(id);
    announceWindows();
  });
  win.on("focus", announceWindows);
  win.on("page-title-updated", () => setTimeout(announceWindows, 0));
  // Links open in the browser, never inside the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e) => e.preventDefault());

  const hash = root ? "#scan=" + encodeURIComponent(root) : "";
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL + hash);
  else void win.loadFile(join(__dirname, "../renderer/index.html"), root ? { hash: hash.slice(1) } : undefined);
  announceWindows();
}

// Ask the scan to stop and only terminate it if it does not answer. A hard
// stop while its threads load native code can take the whole app down.
function retire(w: Worker): void {
  w.postMessage({ type: "cancel" });
  const timer = setTimeout(() => void w.terminate(), 4000);
  w.once("exit", () => clearTimeout(timer));
}
function stopScan(s: Session): void {
  if (s.scan) {
    const w = s.scan;
    s.scan = null;
    retire(w);
  }
}
function stopDup(s: Session): void {
  if (s.dup) {
    const w = s.dup;
    s.dup = null;
    void w.terminate();
  }
}

function stopWatch(s: Session): void {
  const w = s.watch;
  if (!w) return;
  s.watch = null;
  if (w.timer) clearTimeout(w.timer);
  w.watcher.close();
  w.lister.postMessage({ exit: true });
}

const WATCH_DELAY = 900; // let a burst of changes settle
const WATCH_BATCH = 300; // folders listed per round

function startWatch(s: Session, root: string): void {
  stopWatch(s);
  const lister = new Worker(join(__dirname, "dirworker.js"));
  let seq = 0;
  const flush = (): void => {
    const w = s.watch;
    if (!w || w.batch) return;
    w.timer = null;
    // Shallow folders first: a change near the top matters most on the plan.
    const batch = [...w.dirty].sort((a, b) => a.length - b.length).slice(0, WATCH_BATCH);
    for (const p of batch) w.dirty.delete(p);
    if (batch.length === 0) return;
    w.batch = batch;
    lister.postMessage({ seq: seq++, paths: batch });
  };
  const schedule = (): void => {
    const w = s.watch;
    if (w && !w.timer && !w.batch) w.timer = setTimeout(flush, WATCH_DELAY);
  };
  lister.on("message", (res: DirResult | { ready: true }) => {
    const w = s.watch;
    if (!w || "ready" in res || !w.batch) return;
    const { seq: _seq, ...arrays } = res;
    send(s, "watch:changes", { paths: w.batch, ...arrays });
    w.batch = null;
    if (w.dirty.size > 0) schedule();
  });
  let watcher: FSWatcher;
  try {
    watcher = watchFs(root, { recursive: true }, (_event, name) => {
      const w = s.watch;
      if (!w || !name) return;
      // What changed is the folder that holds the name.
      w.dirty.add(dirname(join(root, String(name))));
      schedule();
    });
  } catch {
    lister.postMessage({ exit: true });
    send(s, "watch:lost");
    return;
  }
  // Windows gives up when changes come faster than they can be reported.
  watcher.on("error", () => {
    stopWatch(s);
    send(s, "watch:lost");
  });
  s.watch = { watcher, lister, dirty: new Set(), batch: null, timer: null };
}

ipcMain.handle("watch:start", (e, root: string) => {
  const s = sessionOf(e);
  // Watching reports file names as they change, so it is held to the same policy
  // as anything else that names a location. The renderer only starts this once
  // a scan of that root exists, so the root is already in scope by now.
  if (s && refused(s, resolve(String(root)), "scan") === null) startWatch(s, resolve(String(root)));
});
ipcMain.handle("watch:stop", (e) => {
  const s = sessionOf(e);
  if (s) stopWatch(s);
});
ipcMain.handle("snap:save", (_e, reduced: Reduced) => {
  try {
    return storeSnapshot(snapshotDir(), reduced);
  } catch {
    return null;
  }
});

// Drives ------------------------------------------------------------------

async function listDrives(): Promise<DriveInfo[]> {
  if (process.platform !== "win32") {
    const s = await statfs("/");
    return [{ path: "/", total: s.blocks * s.bsize, free: s.bavail * s.bsize }];
  }
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
  const probe = async (letter: string): Promise<DriveInfo | null> => {
    const path = letter + ":\\";
    try {
      // A disconnected network drive can hang; give up on it quickly.
      const s = await Promise.race([
        statfs(path),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 1500)),
      ]);
      const total = s.blocks * s.bsize;
      return total > 0 ? { path, total, free: s.bavail * s.bsize } : null;
    } catch {
      return null;
    }
  };
  return (await Promise.all(letters.map(probe))).filter((d): d is DriveInfo => d !== null);
}

ipcMain.handle("drives:list", () => listDrives());

ipcMain.handle("dialog:pickFolder", async (e) => {
  const s = sessionOf(e);
  if (!s) return null;
  const r = await dialog.showOpenDialog(s.win, { properties: ["openDirectory"] });
  return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0];
});

// Scan --------------------------------------------------------------------

ipcMain.handle("scan:start", (e, rootArg: string, liveDepth?: number) => {
  const s = sessionOf(e);
  if (!s) return { ok: false, error: "ENOWINDOW" };
  stopScan(s);
  stopDup(s);
  stopWatch(s);
  const root = resolve(String(rootArg));
  if (!existsSync(root)) return { ok: false, error: "ENOENT" };
  s.roots.add(normalizePath(root));

  const worker = new Worker(join(__dirname, "scanworker.js"), {
    workerData: { root, snapshotDir: snapshotDir(), liveDepth: Number(liveDepth) || undefined },
  });
  s.scan = worker;
  const mine = (): boolean => s.scan === worker;
  worker.on("message", (msg) => {
    if (!mine()) return;
    if (msg.type === "progress") send(s, "scan:progress", msg.progress);
    else if (msg.type === "partial") send(s, "scan:partial", msg.table);
    else if (msg.type === "done") {
      send(s, "scan:done", msg.table, msg.snapshot);
      stopScan(s);
    } else if (msg.type === "error") {
      send(s, "scan:error", msg.error);
      stopScan(s);
    }
  });
  worker.on("error", (err) => {
    if (!mine()) return;
    send(s, "scan:error", String((err as Error)?.message ?? err));
    stopScan(s);
  });
  worker.on("exit", (code) => {
    if (!mine()) return;
    s.scan = null;
    if (code !== 0) send(s, "scan:error", "The scan stopped unexpectedly (code " + code + ").");
  });
  return { ok: true, root };
});

// Stop, keeping what was measured: the worker answers with a last table.
ipcMain.handle("scan:stop", (e) => {
  sessionOf(e)?.scan?.postMessage({ type: "stop" });
});

ipcMain.handle("scan:cancel", (e) => {
  const s = sessionOf(e);
  if (s) stopScan(s);
});

// Measures one item after a paste, so it can be added to a scan that is
// already on screen. A folder is walked quietly: no preview, no snapshot.
function measure(path: string): Promise<Measured> {
  return stat(path).then((st) => {
    const name = basename(path);
    if (!st.isDirectory()) {
      return { ok: true, kind: "file", name, size: st.size, mtime: Math.floor(st.mtimeMs / 1000) } as Measured;
    }
    return new Promise<Measured>((done) => {
      const worker = new Worker(join(__dirname, "scanworker.js"), { workerData: { root: path, snapshotDir: "", quiet: true } });
      worker.on("message", (msg) => {
        if (msg.type === "done") done({ ok: true, kind: "dir", name, table: msg.table as ScanTable });
        else if (msg.type === "error") done({ ok: false, error: String(msg.error) });
      });
      worker.on("error", (err) => done({ ok: false, error: String((err as Error)?.message ?? err) }));
    });
  });
}
ipcMain.handle("fs:measure", (e, path: string) =>
  ((deny) =>
    deny
      ? Promise.resolve({ ok: false, error: deny } as Measured)
      : measure(String(path)).catch((err): Measured => ({ ok: false, error: String((err as Error).message) }))
  )(refused(sessionOf(e), String(path), "scan")),
);

// Snapshots ---------------------------------------------------------------

ipcMain.handle("snap:list", (_e, root: string) => listSnapshots(snapshotDir(), String(root)));
ipcMain.handle("snap:load", (_e, file: string) => {
  try {
    return { ok: true, snapshot: readSnapshot(snapshotDir(), String(file)) };
  } catch (e) {
    return { ok: false, error: String((e as Error).message) };
  }
});

// Duplicates --------------------------------------------------------------

ipcMain.handle("dup:start", (e, candidates: DupCandidate[]) => {
  const s = sessionOf(e);
  if (!s) return;
  stopDup(s);
  // Hashing reads file bytes, so these paths are held to the same policy as
  // every other renderer-supplied path. A group whose paths are not all in
  // scope is dropped rather than aborting the pass: this operation only reads.
  const allowed = (candidates ?? []).filter(
    (c) => Array.isArray(c?.paths) && c.paths.length > 0 && c.paths.every((p) => refused(s, String(p), "scan") === null),
  );
  if (allowed.length === 0) return;
  const worker = new Worker(join(__dirname, "dupworker.js"), { workerData: allowed });
  s.dup = worker;
  const mine = (): boolean => s.dup === worker;
  worker.on("message", (msg) => {
    if (!mine()) return;
    if (msg.type === "progress") send(s, "dup:progress", msg.progress);
    else if (msg.type === "done") {
      send(s, "dup:done", msg.groups);
      stopDup(s);
    }
  });
  worker.on("error", (err) => {
    if (!mine()) return;
    send(s, "dup:error", String((err as Error)?.message ?? err));
    stopDup(s);
  });
});

ipcMain.handle("dup:cancel", (e) => {
  const s = sessionOf(e);
  if (s) stopDup(s);
});

// Cleanup -----------------------------------------------------------------
//
// The rules live in src/shared/cleanup.ts and are pure. Main supplies only the
// two things that need a real filesystem: a probe, and the act of moving a file
// to the Recycle Bin.

const auditFile = (): string => join(app.getPath("userData"), "cleanup-audit.jsonl");

// lstat, never stat: a junction must be fingerprinted as the link itself rather
// than as its target, because the link is what will be moved.
const probe: FsProbe = {
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
      return { size: st.size, mtime: Math.floor(st.mtimeMs) };
    } catch {
      return null;
    }
  },
};

// A plan may only cover a root this window actually scanned.
function inScope(s: Session, scope: string): boolean {
  const want = normalizePath(scope).toLowerCase();
  for (const root of s.roots) if (root.toLowerCase() === want) return true;
  return false;
}

// Every handler that turns a renderer-supplied path into a filesystem action
// asks this first. See src/main/scope.ts for what the two reaches mean and for
// which half of the policy survives a compromised renderer.
function refused(s: Session | undefined, path: string, reach: Reach): string | null {
  if (!s) return "this window is not part of the application";
  return refuseReason({ path, roots: s.roots, reach });
}

ipcMain.handle("clean:plan", (e, scopeArg: string, candidates: Candidate[], action: Action): CleanupPlan => {
  const s = sessionOf(e);
  const scope = normalizePath(String(scopeArg));
  const wanted: Action = action === "delete" ? "delete" : "trash";
  if (!s || !inScope(s, scope)) {
    return {
      scope,
      action: wanted,
      items: [],
      rejected: [{ path: scope, reason: "This folder is not part of a scan in this window." }],
      estimatedBytes: 0,
    };
  }
  return buildPlan(scope, candidates ?? [], wanted, probe);
});

ipcMain.handle("clean:run", async (e, plan: CleanupPlan) => {
  const s = sessionOf(e);
  if (!s || !plan || !inScope(s, plan.scope)) {
    return { outcomes: [] as ItemOutcome[], invalidated: [], record: null, error: "ESCOPE" };
  }
  // Rule 4: every path is rechecked now, not when the plan was drawn.
  const { ready, invalidated } = revalidate(plan, probe);
  const outcomes: ItemOutcome[] = [];
  for (const item of ready) {
    try {
      if (plan.action === "trash") await shell.trashItem(item.path);
      else await rm(item.path, { recursive: true, force: true });
      outcomes.push({ path: item.path, status: "removed", bytes: item.bytes });
    } catch (err) {
      outcomes.push({ path: item.path, status: "failed", bytes: 0, error: String((err as Error)?.message ?? err) });
    }
  }
  // Whatever was invalidated is reported as skipped, with the reason kept.
  for (const bad of invalidated) outcomes.push({ path: bad.path, status: "skipped", bytes: 0, error: bad.reason });
  const record = buildAuditRecord(plan, outcomes, invalidated, Date.now());
  try {
    appendAudit(auditFile(), record);
  } catch {
    // A history that cannot be written must not fail the action itself.
  }
  return { outcomes, invalidated, record, error: null };
});

ipcMain.handle("clean:history", (_e, limit?: number): AuditRecord[] => readAudit(auditFile(), Number(limit) || 20));

// Licensing ---------------------------------------------------------------
//
// Verification is entirely offline: no activation server, nothing to phone home
// to, and no way for a network outage to take features away from someone who
// paid. The private key never ships, so the worst a tampered build can do is
// refuse a licence it should have accepted, which is the safe direction.

const licenseStore = (): LicenseStore => ({
  file: join(app.getPath("userData"), "license.key"),
  publicKey: EMBEDDED_PUBLIC_KEY,
});

ipcMain.handle("lic:status", (): LicenseState => licenseStatus(licenseStore()));
ipcMain.handle("lic:activate", (_e, token: string): LicenseState => activateLicense(licenseStore(), String(token ?? "")));
ipcMain.handle("lic:clear", (): LicenseState => clearLicense(licenseStore()));

// The optional storage summary ---------------------------------------------
//
// Off unless an endpoint is configured, off unless the licence unlocks it, and
// handed only the text that was shown to the person for approval. It never goes
// looking for anything itself, and no path reaches it except through that text.

function aiSettingsFile(): string {
  return settingsPathIn(app.getPath("userData"));
}

function aiState(): AiStatusState {
  return { ...aiStatus(readAiSettings(aiSettingsFile())), unlocked: hasFeature(licenseStatus(licenseStore()), "ai.summary") };
}

ipcMain.handle("ai:status", (): AiStatusState => aiState());

ipcMain.handle("ai:configure", (_e, next: Partial<AiSettings>): AiStatusState => {
  const patch: Partial<AiSettings> = {};
  if (typeof next?.baseUrl === "string") patch.baseUrl = next.baseUrl.trim();
  if (typeof next?.model === "string") patch.model = next.model.trim();
  // An empty key is ignored rather than cleared, so the address or the model can
  // be changed without the key ever having to travel back to the interface.
  if (typeof next?.apiKey === "string" && next.apiKey.trim() !== "") patch.apiKey = next.apiKey.trim();
  writeAiSettings(aiSettingsFile(), patch);
  return aiState();
});

ipcMain.handle("ai:summarise", async (_e, message: string): Promise<AiSummaryResult> => {
  // Decided here and not only in the interface: the licence says yes, not the caller.
  if (!hasFeature(licenseStatus(licenseStore()), "ai.summary")) {
    return { ok: false, text: "", error: "a licence is needed for this", bytes: 0 };
  }
  return requestSummary(String(message ?? ""), readAiSettings(aiSettingsFile()));
});

// Shell -------------------------------------------------------------------

// Revealing and opening only ever name a location inside a scan in this window.
// A refusal is silent: the interface only offers these on paths it drew from a
// scan, so a refusal means the request did not come from the interface.
ipcMain.handle("shell:showInFolder", (e, path: string) => {
  if (refused(sessionOf(e), String(path), "scan")) return;
  shell.showItemInFolder(String(path));
});
ipcMain.handle("shell:openPath", (e, path: string) => refused(sessionOf(e), String(path), "scan") ?? shell.openPath(String(path)));
ipcMain.handle("shell:openExternal", (_e, url: string) => {
  if (/^https:\/\//.test(String(url))) void shell.openExternal(String(url));
});
// Trashing is destructive, so the path must be strictly inside a scan: the
// folder that was scanned is never itself a target. Refusals are reported per
// path so the interface can say which ones were skipped and why.
ipcMain.handle("shell:trash", async (e, targets: TrashTarget[]): Promise<TrashResult[]> => {
  const s = sessionOf(e);
  const out: TrashResult[] = [];
  for (const t of targets ?? []) {
    const path = String(t?.path ?? "");
    const deny = refused(s, path, "target");
    if (deny) {
      out.push({ path, ok: false, error: deny });
      continue;
    }
    // The interface drew this file earlier, in a scan, or in a list of
    // duplicates it hashed. Removing it is destructive and immediate, so it
    // must still be the file that was described. A copy that changed in the
    // meantime is left where it is rather than removed on a claim that has
    // stopped being true. Same guard the cleanup planner uses.
    const changed = changedSince({ path, size: t?.size ?? null, mtime: t?.mtime ?? null }, probe);
    if (changed !== null) {
      out.push({ path, ok: false, error: changed });
      continue;
    }
    try {
      await shell.trashItem(path);
      out.push({ path, ok: true });
    } catch (err) {
      out.push({ path, ok: false, error: String((err as Error).message) });
    }
  }
  return out;
});
ipcMain.handle("clipboard:write", (_e, text: string) => clipboard.writeText(String(text)));

ipcMain.handle("fs:stat", async (e, path: string): Promise<ItemStat> => {
  const deny = refused(sessionOf(e), String(path), "scan");
  if (deny) return { ok: false, error: deny };
  try {
    const st = await stat(String(path));
    return {
      ok: true,
      created: Math.floor(st.birthtimeMs / 1000),
      modified: Math.floor(st.mtimeMs / 1000),
      accessed: Math.floor(st.atimeMs / 1000),
      readOnly: (st.mode & 0o200) === 0,
    };
  } catch (e) {
    return { ok: false, error: String((e as NodeJS.ErrnoException).code ?? (e as Error).message) };
  }
});

// Copy, cut and paste of files ----------------------------------------------
// The clip is kept here so every window shares it. A copy is also put on the
// system clipboard, so it can be pasted in Explorer; a cut stays inside the
// app, because the system format for "move" cannot be written from here.

let clip: FileClip | null = null;

function powershell(command: string, env: Record<string, string>): Promise<string> {
  return new Promise((done) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", command],
      { env: { ...process.env, ...env }, timeout: 6000, windowsHide: true },
      (_err, stdout) => done(String(stdout ?? "")),
    );
  });
}

ipcMain.handle("clip:set", async (e, paths: string[], cut: boolean) => {
  // A cut will move these, so each one must be strictly inside a scan. A copy
  // only reads them, and copying something in from Explorer is a normal thing
  // to do, so a copy is not scoped here -- it is the paste destination that is
  // checked, on the other side.
  if (cut && (paths ?? []).some((p) => refused(sessionOf(e), String(p), "target"))) return;
  clip = { paths: paths.map(String), cut: Boolean(cut) };
  if (process.platform !== "win32") return;
  if (cut) clipboard.clear();
  // The paths travel in the environment, never inside the command text.
  else await powershell('Set-Clipboard -LiteralPath ($env:SPACEWISE_PATHS -split "`n")', { SPACEWISE_PATHS: clip.paths.join("\n") });
});

ipcMain.handle("clip:get", async (): Promise<FileClip | null> => {
  let system: string[] = [];
  if (process.platform === "win32") {
    const out = await powershell("Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName }", {});
    system = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  }
  // Something copied in Explorer after our own clip takes over from it.
  if (system.length > 0 && (!clip || system.join("\n").toLowerCase() !== clip.paths.join("\n").toLowerCase())) {
    return { paths: system, cut: false };
  }
  return clip;
});

// A copy that reports how far it is. Small files are copied whole; a large
// one is streamed so the bar keeps moving through it.
const STREAMED = 32 * 1024 * 1024;
async function treeBytes(path: string): Promise<number> {
  const st = await lstat(path);
  if (!st.isDirectory()) return st.isSymbolicLink() ? 0 : st.size;
  let sum = 0;
  for (const name of await readdir(path)) sum += await treeBytes(join(path, name)).catch(() => 0);
  return sum;
}
async function copyTree(src: string, dest: string, onBytes: (n: number) => void): Promise<void> {
  const st = await lstat(src);
  if (st.isSymbolicLink()) {
    await symlink(await readlink(src), dest).catch(() => undefined); // links are kept as links
  } else if (st.isDirectory()) {
    await mkdir(dest);
    for (const name of await readdir(src)) await copyTree(join(src, name), join(dest, name), onBytes);
  } else if (st.size >= STREAMED) {
    const from = createReadStream(src);
    from.on("data", (chunk) => onBytes(chunk.length));
    await pipeline(from, createWriteStream(dest, { flags: "wx" }));
  } else {
    await copyFile(src, dest);
    onBytes(st.size);
  }
}

async function freeName(dir: string, name: string): Promise<string> {
  if (!existsSync(join(dir, name))) return name;
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 1; i < 1000; i++) {
    const candidate = `${stem} - Copy${i === 1 ? "" : ` (${i})`}${ext}`;
    if (!existsSync(join(dir, candidate))) return candidate;
  }
  throw new Error("EEXIST");
}

ipcMain.handle("fs:paste", async (e, paths: string[], cut: boolean, destArg: string): Promise<PasteResult[]> => {
  const s = sessionOf(e);
  const destDir = resolve(String(destArg));
  const out: PasteResult[] = [];
  // The destination must be inside a scan in this window. Pasting into the
  // scanned folder itself is normal, so the root is allowed here.
  const destDeny = refused(s, destDir, "scan");
  if (destDeny) return [{ src: "", dest: destDir, ok: false, error: destDeny }];
  // A move also needs every source strictly inside a scan.
  if (cut) {
    const bad = (paths ?? [])
      .map(String)
      .map((src) => ({ src, why: refused(s, src, "target") }))
      .filter((r) => r.why !== null);
    if (bad.length > 0) return bad.map((r) => ({ src: r.src, dest: "", ok: false, error: String(r.why) }));
  }
  let total = 0;
  for (const p of paths) total += await treeBytes(resolve(String(p))).catch(() => 0);
  let done = 0;
  let told = 0;
  const onBytes = (n: number): void => {
    done += n;
    const now = Date.now();
    if (s && now - told > 120) {
      told = now;
      send(s, "paste:progress", { done, total });
    }
  };
  for (const raw of paths) {
    const src = resolve(String(raw));
    try {
      const inside = (destDir + sep).toLowerCase().startsWith((src + sep).toLowerCase());
      if (inside) throw new Error("EINSIDE"); // a folder cannot go into itself
      if (cut && dirname(src).toLowerCase() === destDir.toLowerCase()) throw new Error("ESAME"); // already there
      const dest = join(destDir, await freeName(destDir, basename(src)));
      if (cut) {
        try {
          await rename(src, dest);
        } catch (e) {
          // Another drive: copy across, then remove the original.
          if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
          await copyTree(src, dest, onBytes);
          await rm(src, { recursive: true, force: true });
        }
      } else {
        await copyTree(src, dest, onBytes);
      }
      out.push({ src, dest, ok: true });
    } catch (e) {
      out.push({ src, dest: "", ok: false, error: String((e as NodeJS.ErrnoException).code ?? (e as Error).message) });
    }
  }
  if (cut && out.some((r) => r.ok)) clip = null;
  return out;
});

// Windows -----------------------------------------------------------------

ipcMain.handle("win:setOverlay", (e, symbolColor: string) => {
  const s = sessionOf(e);
  if (s && process.platform === "win32" && /^#[0-9a-f]{6}$/i.test(symbolColor)) {
    s.win.setTitleBarOverlay({ color: "#00000000", symbolColor, height: BAR_HEIGHT });
  }
});
ipcMain.handle("win:new", (_e, root?: string) => createWindow(root ? String(root) : undefined));
ipcMain.handle("win:close", (e) => sessionOf(e)?.win.close());
ipcMain.handle("win:list", () => windowList());
ipcMain.handle("win:setTitle", (e, title: string) => {
  sessionOf(e)?.win.setTitle(String(title).slice(0, 200));
  announceWindows();
});
ipcMain.handle("win:focus", (_e, id: number) => {
  const w = BrowserWindow.fromId(Number(id));
  if (!w) return;
  if (w.isMinimized()) w.restore();
  w.focus();
});
ipcMain.handle("win:arrange", (e, how: "columns" | "rows" | "cascade") => {
  const me = sessionOf(e);
  const wins = [...sessions.values()].map((s) => s.win).filter((w) => !w.isMinimized());
  if (!me || wins.length === 0) return;
  const area = screen.getDisplayMatching(me.win.getBounds()).workArea;
  wins.forEach((w, i) => {
    if (w.isMaximized()) w.unmaximize();
    if (w.isFullScreen()) w.setFullScreen(false);
    const n = wins.length;
    if (how === "columns") {
      const width = Math.floor(area.width / n);
      w.setBounds({ x: area.x + i * width, y: area.y, width, height: area.height });
    } else if (how === "rows") {
      const height = Math.floor(area.height / n);
      w.setBounds({ x: area.x, y: area.y + i * height, width: area.width, height });
    } else {
      const step = 36;
      w.setBounds({
        x: area.x + i * step,
        y: area.y + i * step,
        width: Math.max(920, Math.floor(area.width * 0.72)),
        height: Math.max(560, Math.floor(area.height * 0.78)),
      });
      w.moveTop();
    }
  });
  me.win.focus();
});
ipcMain.handle("win:toggleFullScreen", (e) => {
  const s = sessionOf(e);
  s?.win.setFullScreen(!s.win.isFullScreen());
});
ipcMain.handle("win:devtools", (e) => sessionOf(e)?.win.webContents.toggleDevTools());

ipcMain.handle("app:info", () => ({
  version: app.getVersion(),
  platform: process.platform,
  home: app.getPath("home"),
}));
ipcMain.handle("app:quit", () => app.quit());

// Updates -----------------------------------------------------------------

autoUpdater.autoDownload = false;
const upd = (status: UpdateStatus): void => broadcast("upd:status", status);
autoUpdater.on("checking-for-update", () => upd({ state: "checking" }));
autoUpdater.on("update-available", (info) => upd({ state: "available", version: info.version }));
autoUpdater.on("update-not-available", () => upd({ state: "none" }));
autoUpdater.on("download-progress", (p) => upd({ state: "downloading", percent: p.percent }));
autoUpdater.on("update-downloaded", (info) => upd({ state: "ready", version: info.version }));
autoUpdater.on("error", (err) => upd({ state: "error", error: String((err as Error)?.message ?? err) }));

ipcMain.handle("upd:check", async () => {
  if (!app.isPackaged) return upd({ state: "dev" });
  try {
    await autoUpdater.checkForUpdates();
  } catch (e) {
    upd({ state: "error", error: String((e as Error).message) });
  }
});
ipcMain.handle("upd:download", () => autoUpdater.downloadUpdate().catch(() => undefined));
ipcMain.handle("upd:install", () => autoUpdater.quitAndInstall());

// App ---------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Starting the app again opens another window in the one running process.
  app.on("second-instance", () => createWindow());
  void app.whenReady().then(() => {
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
