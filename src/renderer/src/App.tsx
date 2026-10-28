import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { F_DIR } from "../../shared/types";
import { reduceTable } from "../../shared/reduce";
import type { AppEntry, DriveInfo, ItemStat, ScanProgress, WatchBatch, ScanTable, SnapshotMeta, UpdateStatus, WindowInfo } from "../../shared/types";
import { Disk } from "./lib/disk";
import type { Graftable } from "./lib/disk";
import { NO_FILTER, compare, isFiltering, runFilter, topFiles } from "./lib/analysis";
import type { Comparison, Filter } from "./lib/analysis";
import { initialLang, makeFmt, makeT } from "./lib/i18n";
import type { Fmt, Lang, T } from "./lib/i18n";
import { Icon, Mark, Wordmark } from "./components/Icon";
import { Menu, ROW } from "./components/ui";
import { AppBar, BarButton, BrandTitle, FolderList, ItemSheet, SearchBar, SettingsSheet, Tabs, files } from "./components/Mobile";
import type { MenuEntry } from "./components/ui";
import { Treemap } from "./components/Treemap";
import { TreeView } from "./components/TreeView";
import { ChangesPane, DupesPane, ListPane, TypesPane } from "./components/Panels";
import { CleanupPane } from "./components/Cleanup";
import { DesktopSettings } from "./components/Settings";
import { SlowSheet } from "./components/Slow";
import { LicenseDialog, PremiumGate } from "./components/License";
import { NO_LICENSE, hasFeature } from "../../shared/entitlements";
import type { LicenseState } from "../../shared/entitlements";
import type { DupState } from "./components/Panels";
import { AppSheet, AppsPane, CleanPane } from "./components/Phone";
import type { CleanKey } from "./lib/phone";

type Family = "grid" | "paper";
type Mode = "system" | "light" | "dark";
const FAMILIES = ["grid", "paper"] as const;
const MODES = ["system", "light", "dark"] as const;
const LEVELS = [2, 3, 4, 5, 6, 0] as const; // 0 means every level
const BAR_ALL = ["file", "view", "window", "help"] as const;
const can = window.api.can;
const BAR = BAR_ALL.filter((n) => n !== "window" || can.windows);
// Android: an app bar, tabs and bottom sheets in place of the desktop window chrome.
const MOBILE = !can.windows;
type BarName = (typeof BAR_ALL)[number];
// Shown in menus and in the shortcut list. The Mac spells the modifier its own way.
const MOD = navigator.platform.toLowerCase().includes("mac") ? "Cmd" : "Ctrl";
type Tab = "plan" | "folders" | "clean" | "apps" | "tree" | "largest" | "types" | "cleanup" | "dupes" | "changes" | "found";
// Where a new scan opens: the plan on a phone, the tree beside it on the desktop.
const HOME: Tab = MOBILE ? "plan" : "tree";
type Phase = { is: "start" } | { is: "scanning"; root: string } | { is: "failed"; root: string; error: string } | { is: "ready" };

const MB = 1024 * 1024;
// Where the Help menu, the About box and the phone's settings sheet point.
//   Leave SITE empty and its Help entry is not drawn at all rather than sitting
//   there doing nothing. CONTACT is a real address and is always drawn.
const SITE = "https://dominixai.com";
const CONTACT = "denorgerald@gmail.com";
const REPO = "https://github.com/eazypickins001-tech/SpaceWise";
// The MIT project SpaceWise grew out of, so the attribution in the About box
// points at something that exists rather than at nothing.
const UPSTREAM = "https://github.com/rodrigokiller/diskplot";
const DUP_IDLE: DupState = { status: "idle", progress: null, groups: [] };

function load<V extends string>(key: string, allowed: readonly V[], fallback: V): V {
  try {
    const v = localStorage.getItem(key) as V | null;
    return v && allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // A preference that fails to save is not worth interrupting anyone.
  }
}

export function App() {
  const [lang, setLang] = useState<Lang>(initialLang);
  const [family, setFamily] = useState<Family>(() => load("family", FAMILIES, "grid"));
  const [mode, setMode] = useState<Mode>(() => load("mode", MODES, "light"));
  const [systemDark, setSystemDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  const dark = mode === "system" ? systemDark : mode === "dark";
  // The value the stylesheet keys on.
  const theme = family === "grid" ? (dark ? "grid-dark" : "grid") : dark ? "dark" : "light";
  const t = useMemo(() => makeT(lang), [lang]);
  const fmt = useMemo(() => makeFmt(lang, t), [lang, t]);

  const [phase, setPhase] = useState<Phase>({ is: "start" });
  const [drives, setDrives] = useState<DriveInfo[] | null>(null);
  const [access, setAccess] = useState(true);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [disk, setDisk] = useState<Disk | null>(null);
  const [version, setVersion] = useState(0);
  // Read once from the main process, and refreshed whenever the licence dialog
  // changes it. Nothing here blocks: an unreadable licence is simply the free plan.
  const [licence, setLicence] = useState<LicenseState>(NO_LICENSE);
  useEffect(() => {
    // A licence that cannot be read is simply the free plan; it is never a
    // reason to leave the interface in an error state.
    void window.api
      .licenseStatus()
      .then(setLicence)
      .catch(() => setLicence(NO_LICENSE));
  }, []);
  const [zoom, setZoom] = useState(0);
  const [selected, setSelected] = useState(-1);
  const [hover, setHover] = useState(-1);
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set([0]));
  const [reveal, setReveal] = useState(0);
  const [tab, setTab] = useState<Tab>(HOME);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  // Android only: the installed apps, whether usage access is granted, and where the user is.
  const [apps, setApps] = useState<AppEntry[] | null>(null);
  const [usage, setUsage] = useState<boolean | null>(null);
  const [appPkg, setAppPkg] = useState<string | null>(null);
  const [idleOnly, setIdleOnly] = useState(false);
  const [cleanOpen, setCleanOpen] = useState<CleanKey | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>(NO_FILTER);
  const [snapshots, setSnapshots] = useState<SnapshotMeta[]>([]);
  const [against, setAgainst] = useState<string | null>(null);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [dups, setDups] = useState<DupState>(DUP_IDLE);
  const [panelWidth, setPanelWidth] = useState(() => {
    try {
      const w = Number(localStorage.getItem("panel"));
      return w >= 320 && w <= 1200 ? w : 580;
    } catch {
      return 580;
    }
  });
  const [planArea, setPlanArea] = useState(0);
  const [levels, setLevels] = useState(() => Number(load("levels", ["2", "3", "4", "5", "6", "0"] as const, "2")));
  // Where the plan has been, for Back and Forward.
  const [trail, setTrail] = useState<{ back: number[]; forward: number[] }>({ back: [], forward: [] });

  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuEntry[]; from?: BarName; first?: boolean } | null>(null);
  // Which bar entry the keyboard is on after Alt, or -1.
  const [barFocus, setBarFocus] = useState(-1);
  const [windows, setWindows] = useState<WindowInfo[]>([]);
  const [propsOf, setPropsOf] = useState<number | null>(null);
  const [itemStat, setItemStat] = useState<ItemStat | null>(null);
  const [trash, setTrash] = useState<number[] | null>(null);
  const [dialog, setDialog] = useState<"issues" | "about" | "keys" | "licence" | "settings" | "slow" | null>(null);
  const [notice, setNotice] = useState<{ text: string; bad?: boolean; progress?: number; action?: { label: string; run: () => void } } | null>(null);
  const [stopping, setStopping] = useState(false);
  // What the scan is measured against for a percentage: the drive's used
  // space, or the last scan of the same folder. Null when there is nothing to go by.
  const [scanBase, setScanBase] = useState<number | null>(null);
  // The scan's numbers, shown under the schedule while it runs.
  const [dockOpen, setDockOpen] = useState(true);
  // Items added a moment ago, so the plan and the tree can point them out.
  const [fresh, setFresh] = useState<Set<number>>(() => new Set());
  const freshTimer = useRef(0);
  const markFresh = (ids: number[]): void => {
    if (ids.length === 0) return;
    setFresh(new Set(ids.slice(0, 500)));
    window.clearTimeout(freshTimer.current);
    freshTimer.current = window.setTimeout(() => setFresh(new Set()), 1700);
  };
  // Live sync: the wish (remembered) and whether it had to give up on this scan.
  const [sync, setSync] = useState(() => load("sync", ["on", "off"] as const, "off") === "on");
  const [syncLost, setSyncLost] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  const [appVersion, setAppVersion] = useState("");
  // Which build this is. The version number never changes between builds, so
  // without this "is this the copy I just built?" has no answer on screen.
  const [appBuild, setAppBuild] = useState("");
  // Folders this person protects from cleanup. Kept here only so the settings
  // sheet can draw them; the rule itself lives in the main process, where the
  // deletion happens.
  const [protectedFolders, setProtectedFolders] = useState<string[]>([]);
  const askedUpdate = useRef(false);
  const view = useRef({ disk, zoom, selected, expanded, trail, menu, barFocus });
  view.current = { disk, zoom, selected, expanded, trail, menu, barFocus };
  const searchRef = useRef<HTMLInputElement>(null);

  // Preferences ------------------------------------------------------------

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const on = (): void => setSystemDark(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  // A layout effect, so the colours are in place before the plan redraws.
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    void window.api.setOverlay(theme.endsWith("dark") ? "#c9d4cf" : "#33403c");
  }, [theme]);
  useEffect(() => {
    document.documentElement.lang = lang === "pt" ? "pt-BR" : "en";
  }, [lang]);

  // Windows ----------------------------------------------------------------

  useEffect(() => {
    void window.api.listWindows().then(setWindows);
    return window.api.onWindows(setWindows);
  }, []);
  const titleRoot = disk ? disk.t.root : phase.is === "scanning" ? phase.root : "";
  useEffect(() => {
    void window.api.setTitle(titleRoot ? titleRoot + " - SpaceWise" : "SpaceWise");
  }, [titleRoot]);

  // Start ------------------------------------------------------------------

  // Android asks for access in its own settings screen; check again on return.
  useEffect(() => {
    const check = (): void => {
      void window.api.access().then((ok) => {
        setAccess(ok);
        if (ok) void window.api.listDrives().then(setDrives);
      });
    };
    check();
    return window.api.onResume(check);
  }, []);

  const refreshDrives = useCallback(() => {
    void window.api.listDrives().then(setDrives);
  }, []);
  useEffect(() => {
    refreshDrives();
    void window.api.info().then((i) => {
      setAppVersion(i.version);
      setAppBuild(i.build);
    });
    void window.api.protectedFolders().then(setProtectedFolders);
    const timer = setTimeout(() => void window.api.checkUpdate(), 4000);
    return () => clearTimeout(timer);
  }, [refreshDrives]);

  const startScan = useCallback((root: string) => {
    setMenu(null);
    setProgress(null);
    setNotice(null);
    setSyncLost(false);
    setDockOpen(true);
    setFresh(new Set());
    setDisk(null);
    setTab(HOME);
    setCleanOpen(null);
    setPhase({ is: "scanning", root });
    const norm = (p: string): string => p.replace(/[\\/]+$/, "").toLowerCase();
    const drive = drives?.find((d) => norm(d.path) === norm(root));
    if (drive && can.driveTotals) setScanBase(drive.total - drive.free);
    else {
      setScanBase(null);
      void window.api.listSnapshots(root).then((all) => all.length > 0 && setScanBase(all[0].total));
    }
    void window.api.cancelDuplicates();
    // The preview goes one level past what the plan opens, so it stays small and quick.
    void window.api.startScan(root, levels === 0 ? 6 : levels + 1).then((r) => {
      if (!r.ok) setPhase({ is: "failed", root, error: r.error === "ENOENT" ? "missing" : (r.error ?? "") });
      else if (r.root) setPhase({ is: "scanning", root: r.root });
    });
  }, [drives, levels]);

  useEffect(() => {
    const m = /^#scan=(.+)$/.exec(window.location.hash);
    if (m) startScan(decodeURIComponent(m[1]));
  }, [startScan]);

  const pickFolder = useCallback(() => {
    void window.api.pickFolder().then((path) => path && startScan(path));
  }, [startScan]);

  // Stop a scan that already shows something: keep it on screen as it is.
  const stopHere = useCallback(() => {
    setStopping(true);
    void window.api.stopScan();
  }, []);

  const toStart = useCallback(() => {
    setStopping(false);
    void window.api.cancelScan();
    setPhase({ is: "start" });
    refreshDrives();
  }, [refreshDrives]);

  // Scan events ------------------------------------------------------------

  useEffect(() => {
    const offP = window.api.onScanProgress(setProgress);
    // A new table has new ids. Carry the view over by name so the plan does
    // not jump back to the top every time the live preview refreshes.
    const adopt = (table: ScanTable): void => {
      const d = new Disk(table);
      const old = view.current;
      let zoom = 0;
      let selected = -1;
      const expanded = new Set([0]);
      if (old.disk && old.disk.t.root === table.root) {
        const z = d.follow(old.disk.trail(old.zoom));
        if (z > 0 && d.isDir(z) && d.size(z) > 0) zoom = z;
        if (old.selected > 0) selected = d.follow(old.disk.trail(old.selected));
        for (const id of old.expanded) {
          const e = id > 0 ? d.follow(old.disk.trail(id)) : -1;
          if (e > 0) expanded.add(e);
        }
      }
      const carry = (ids: number[]): number[] =>
        old.disk && old.disk.t.root === table.root
          ? ids.map((id) => (id === 0 ? 0 : d.follow(old.disk!.trail(id)))).filter((id) => id >= 0 && d.isDir(id))
          : [];
      setDisk(d);
      setTrail({ back: carry(old.trail.back), forward: carry(old.trail.forward) });
      setVersion(0);
      setZoom(zoom);
      setSelected(selected);
      setHover(-1);
      setExpanded(expanded);
    };
    const offL = window.api.onScanPartial(adopt);
    const offD = window.api.onScanDone((table) => {
      adopt(table);
      setStopping(false);
      if (table.incomplete) setNotice({ text: t("scan.stopped"), action: { label: t("menu.rescan"), run: () => startScan(table.root) } });
      setQuery("");
      setFilter(NO_FILTER);
      setComparison(null);
      setAgainst(null);
      setDups(DUP_IDLE);
      setPhase({ is: "ready" });
      void window.api.listSnapshots(table.root).then((all) => {
        const older = table.incomplete ? [] : all.filter((s) => s.date < table.startedAt);
        setSnapshots(older);
        if (older.length > 0) setAgainst(older[0].file);
      });
    });
    const offC = window.api.onPasteProgress((p) =>
      setNotice({ text: t("clip.progress", { done: fmt.bytes(p.done), total: fmt.bytes(p.total) }), progress: p.total > 0 ? p.done / p.total : 0 }),
    );
    const offE = window.api.onScanError((error) => setPhase((p) => ({ is: "failed", root: p.is === "scanning" ? p.root : "", error })));
    const offU = window.api.onUpdateStatus((s: UpdateStatus) => {
      const asked = askedUpdate.current;
      if (s.state === "available")
        setNotice({ text: t("upd.available", { version: s.version }), action: { label: t("upd.download"), run: () => void window.api.downloadUpdate() } });
      else if (s.state === "downloading") setNotice({ text: t("upd.downloading", { pct: Math.round(s.percent) + "%" }) });
      else if (s.state === "ready")
        setNotice({ text: t("upd.ready", { version: s.version }), action: { label: t("upd.install"), run: () => void window.api.installUpdate() } });
      else if (asked && s.state === "none") setNotice({ text: t("upd.none") });
      else if (asked && s.state === "dev") setNotice({ text: t("upd.dev") });
      else if (asked && s.state === "error") setNotice({ text: t("upd.error", { why: s.error }), bad: true });
      if (s.state !== "checking") askedUpdate.current = false;
    });
    return () => {
      offP();
      offL();
      offD();
      offC();
      offE();
      offU();
    };
  }, [t, fmt, startScan]);

  // Comparison with an older scan --------------------------------------------

  useEffect(() => {
    if (!disk || !against) {
      setComparison(null);
      return;
    }
    let live = true;
    void window.api.loadSnapshot(against).then((r) => {
      if (live && r.ok && r.snapshot) setComparison(compare(disk, r.snapshot));
    });
    return () => {
      live = false;
    };
  }, [disk, against]);

  // Search and filters -----------------------------------------------------

  useEffect(() => {
    const timer = setTimeout(() => setFilter((f) => (f.query === query ? f : { ...f, query })), 160);
    return () => clearTimeout(timer);
  }, [query]);
  const filtering = isFiltering(filter);
  const found = useMemo(
    () => (disk && filtering ? runFilter(disk, filter, 5000) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [disk, filter, filtering, version],
  );
  useEffect(() => {
    if (filtering) setTab("found");
    else setTab((cur) => (cur === "found" ? HOME : cur));
  }, [filtering]);
  const clearFilters = (): void => {
    setQuery("");
    setFilter(NO_FILTER);
  };
  const closeSearch = (): void => {
    setSearching(false);
    clearFilters();
  };

  const largest = useMemo(
    () => (disk && tab === "largest" ? topFiles(disk, 500) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [disk, tab, version],
  );

  // Navigation -------------------------------------------------------------

  const select = useCallback(
    (id: number) => {
      setSelected(id);
      if (!disk || id < 0) return;
      setExpanded((prev) => {
        let next = prev;
        for (let p = disk.parent(id); p >= 0; p = disk.parent(p)) {
          if (!next.has(p)) {
            if (next === prev) next = new Set(prev);
            next.add(p);
          }
        }
        return next;
      });
      setReveal((n) => n + 1);
    },
    [disk],
  );
  const selectInTree = useCallback((id: number) => setSelected(id), []);

  const openAt = useCallback(
    (id: number) => {
      if (!disk || id < 0 || !disk.isDir(id) || disk.size(id) <= 0) return false;
      setZoom(id);
      setExpanded((prev) => {
        const next = new Set(prev);
        for (const a of disk.ancestors(id)) next.add(a);
        return next;
      });
      return true;
    },
    [disk],
  );
  const zoomTo = useCallback(
    (id: number) => {
      const from = view.current.zoom;
      if (id !== from && openAt(id)) setTrail((h) => ({ back: [...h.back.slice(-49), from], forward: [] }));
    },
    [openAt],
  );
  const step = useCallback(
    (dir: "back" | "forward") => {
      const stack = trail[dir];
      if (stack.length === 0) return;
      const to = stack[stack.length - 1];
      const from = view.current.zoom;
      const rest = stack.slice(0, -1);
      if (!openAt(to)) return;
      setTrail(dir === "back" ? { back: rest, forward: [...trail.forward, from] } : { back: [...trail.back, from], forward: rest });
    },
    [trail, openAt],
  );

  const toggle = useCallback((id: number, open?: boolean) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      const want = open ?? !next.has(id);
      if (want) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  // Actions on items -------------------------------------------------------

  const flash = (text: string): void => {
    setToast(text);
    setTimeout(() => setToast(null), 1600);
  };

  // Copy, cut and paste work on the finished scan only: while it is still
  // running the table is replaced every second.
  const copyItem = (id: number, cut: boolean): void => {
    if (!disk || phase.is !== "ready" || id < 0 || (cut && id === 0)) return;
    void window.api.setClip([disk.path(id)], cut).then(() => flash(t(cut ? "clip.cut" : "clip.copied")));
  };
  const pasteInto = async (dir: number): Promise<void> => {
    if (!disk || phase.is !== "ready" || dir < 0 || !disk.isDir(dir)) return;
    const clip = await window.api.getClip();
    if (!clip || clip.paths.length === 0) return flash(t("clip.empty"));
    setNotice({ text: t("clip.working") });
    const results = await window.api.paste(clip.paths, clip.cut, disk.path(dir));
    let failed = 0;
    let why = "";
    let done = 0;
    let last = -1;
    for (const r of results) {
      if (!r.ok) {
        failed++;
        why = why || (r.error ?? "");
        continue;
      }
      if (clip.cut) {
        // The original left its place, if that place is part of this scan.
        const src = disk.findPath(r.src);
        if (src > 0) {
          if (disk.contains(src, view.current.zoom)) setZoom(Math.max(0, disk.parent(src)));
          if (view.current.selected >= 0 && disk.contains(src, view.current.selected)) setSelected(-1);
          disk.remove(src);
        }
      }
      const measured = await window.api.measure(r.dest);
      const seen = disk.findPath(r.dest);
      if (seen >= 0) last = seen;
      else if (measured.ok) last = disk.graft(dir, measured);
      done++;
    }
    setHover(-1);
    setVersion((v) => v + 1);
    if (last >= 0) {
      select(last);
      markFresh([last]);
    }
    if (failed > 0) {
      // Three codes have sentences of their own; anything else is shown exactly as
      // the system returned it, rather than dressed up as "the system refused".
      const known = ["EINSIDE", "ESAME", "EEXIST"].includes(why) ? (why as "EINSIDE" | "ESAME" | "EEXIST") : null;
      setNotice({ text: t("clip.failed", { count: failed, why: known ? t(`clip.${known}`) : why || t("clip.other") }), bad: true });
    } else {
      setNotice(null);
      flash(t("clip.pasted", { count: done }));
    }
  };
  // Where a paste lands: the selected folder, or the folder of the selected file.
  const pasteTarget = (): number => {
    if (!disk) return -1;
    const s = view.current.selected;
    if (s >= 0 && !disk.isGone(s)) return disk.isDir(s) ? s : disk.parent(s);
    return view.current.zoom;
  };
  const showProps = (id: number): void => {
    if (!disk || id < 0) return;
    setItemStat(null);
    setPropsOf(id);
    void window.api.stat(disk.path(id)).then(setItemStat);
  };

  const context = useCallback(
    (id: number, x: number, y: number) => {
      if (!disk) return;
      if (MOBILE) return setSelected(id);
      const path = disk.path(id);
      const dir = disk.isDir(id);
      const done = phase.is === "ready";
      // Everything that moves or removes a file is refused while the scan is
      // still running, and each one says so rather than going grey in silence.
      const waiting = t("act.whyScanning");
      const items: MenuEntry[] = can.reveal
        ? [
            { label: t("act.open"), icon: "open", run: () => void window.api.openPath(path) },
            { label: t("act.reveal"), icon: "reveal", run: () => void window.api.showInFolder(path) },
          ]
        : [];
      if (dir) items.push({ label: t("act.zoom"), icon: "enter", keys: "Enter", run: () => zoomTo(id) });
      if (items.length > 0) items.push({ kind: "sep" });
      if (can.fileClipboard)
        items.push(
        { label: t("act.copy"), icon: "copy", keys: MOD + "+C", disabled: !done, why: done ? undefined : waiting, run: () => copyItem(id, false) },
        {
          label: t("act.cut"),
          icon: "cut",
          keys: MOD + "+X",
          disabled: !done || id === 0,
          why: !done ? waiting : id === 0 ? t("act.whyRoot") : undefined,
          run: () => copyItem(id, true),
        },
        {
          label: t(dir ? "act.pasteHere" : "act.paste"),
          icon: "paste",
          keys: MOD + "+V",
          disabled: !done,
          why: done ? undefined : waiting,
          run: () => void pasteInto(dir ? id : disk.parent(id)),
        },
        );
      items.push(
        { label: t("act.copyPath"), keys: MOD + "+Shift+C", run: () => void window.api.copyText(path).then(() => flash(t("copied"))) },
        { kind: "sep" },
        { label: t("act.properties"), icon: "info", keys: "Alt+Enter", run: () => showProps(id) },
      );
      if (can.trash && id > 0)
        items.push({ kind: "sep" }, { label: t("act.trash"), icon: "trash", keys: "Del", danger: true, disabled: !done, why: done ? undefined : waiting, run: () => setTrash([id]) });
      setMenu({ x, y, items });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [disk, t, zoomTo, phase.is],
  );

  const askTrash = useCallback((ids: number[]) => setTrash(ids), []);

  // A cleanup run reports paths, not node ids, so the window matches them back
  // to the tree it is showing and takes only what really went off screen.
  const onCleanupRemoved = useCallback(
    (ids: number[]) => {
      if (!disk) return;
      for (const id of ids) {
        if (disk.contains(id, zoom)) setZoom(Math.max(0, disk.parent(id)));
        if (selected >= 0 && disk.contains(id, selected)) setSelected(-1);
        disk.remove(id);
      }
      setHover(-1);
      setVersion((v) => v + 1);
    },
    [disk, zoom, selected],
  );

  // On Android a file can also skip the trash and go for good.
  const confirmTrash = async (erase = false): Promise<void> => {
    if (!disk || !trash) return;
    const ids = trash;
    setTrash(null);
    // What each file looked like when it was scanned. A list of duplicates is a
    // claim about identity, and it can go stale, so the main process compares
    // this before it removes anything and leaves a changed file where it is.
    const targets = ids.map((id) => ({ path: disk.path(id), size: disk.t.logical[id], mtime: disk.t.mtime[id] }));
    const phone = window.api.phone;
    const results = await (erase && phone ? phone.erase(targets) : window.api.trash(targets));
    let failed = 0;
    // Why each one was left where it was. Main records a reason for every
    // refusal; this used to discard it and print "they may be in use", which was
    // a guess, and was wrong -- the answers were already here.
    const reasons = new Map<string, number>();
    results.forEach((r, i) => {
      if (!r.ok) {
        failed++;
        reasons.set(r.error, (reasons.get(r.error) ?? 0) + 1);
        return;
      }
      const id = ids[i];
      if (disk.contains(id, zoom)) setZoom(Math.max(0, disk.parent(id)));
      if (selected >= 0 && disk.contains(id, selected)) setSelected(-1);
      disk.remove(id);
    });
    setHover(-1);
    setVersion((v) => v + 1);
    if (failed > 0) {
      const why = [...reasons.entries()].map(([text, n]) => (n === failed ? text : `${n} × ${text}`)).join("; ");
      setNotice({ text: t("trash.failed", { count: failed, why }), bad: true });
    }
  };

  // Live sync ----------------------------------------------------------------
  // While it is on, Windows reports the folders that change and only those
  // are read again; the table is patched in place.

  const synced = sync && !syncLost && phase.is === "ready" && disk !== null && !disk.t.incomplete;
  useEffect(() => {
    if (!synced || !disk) return;
    const d = disk;
    const decoder = new TextDecoder();
    let queue: Promise<void> = Promise.resolve();
    let alive = true;

    const apply = async (b: WatchBatch): Promise<void> => {
      if (!alive) return;
      const failed = new Map(b.failed);
      const adds: { parent: number; item: Graftable }[] = [];
      const newDirs: { parent: number; path: string }[] = [];
      let changed = false;
      const drop = (id: number): void => {
        if (d.contains(id, view.current.zoom)) setZoom(Math.max(0, d.parent(id)));
        if (view.current.selected >= 0 && d.contains(id, view.current.selected)) setSelected(-1);
        d.remove(id);
        changed = true;
      };
      let e = 0;
      let off = 0;
      for (let k = 0; k < b.paths.length; k++) {
        const count = b.counts[k];
        const dir = d.findPath(b.paths[k]);
        const code = failed.get(k);
        if (code !== undefined) {
          if (code === "ENOENT" && dir > 0) drop(dir); // the folder itself is gone
          continue;
        }
        if (dir < 0 || !d.isDir(dir) || d.isLink(dir)) {
          for (let j = 0; j < count; j++) off += b.nameLens[e++];
          continue;
        }
        const have = new Map<string, number>();
        for (const c of d.children(dir)) have.set(d.name(c).toLowerCase(), c);
        const base = b.paths[k].endsWith(d.sep) ? b.paths[k] : b.paths[k] + d.sep;
        for (let j = 0; j < count; j++, e++) {
          const name = decoder.decode(b.names.subarray(off, off + b.nameLens[e]));
          off += b.nameLens[e];
          const isDir = (b.flags[e] & F_DIR) !== 0;
          const key = name.toLowerCase();
          let cur = have.get(key);
          have.delete(key);
          if (cur !== undefined && d.isDir(cur) !== isDir) {
            drop(cur); // a file became a folder, or the reverse
            cur = undefined;
          }
          if (cur === undefined) {
            if (isDir) newDirs.push({ parent: dir, path: base + name });
            else adds.push({ parent: dir, item: { kind: "file", name, size: b.sizes[e], logical: b.logical[e], mtime: b.mtimes[e], flags: b.flags[e] } });
          } else if (!isDir && (d.size(cur) !== b.sizes[e] || d.logical(cur) !== b.logical[e] || d.t.mtime[cur] !== b.mtimes[e])) {
            d.resize(cur, b.sizes[e], b.logical[e], b.mtimes[e]);
            changed = true;
          }
        }
        for (const id of have.values()) drop(id); // listed before, not there now
      }
      // A new folder has to be measured all the way down.
      for (const nd of newDirs) {
        const measured = await window.api.measure(nd.path);
        if (!alive) return;
        if (measured.ok) adds.push({ parent: nd.parent, item: measured });
      }
      // Measuring takes time; a paste may have added the same item meanwhile.
      const names = new Map<number, Set<string>>();
      const fresh = adds.filter((a) => {
        if (d.isGone(a.parent)) return false;
        if (newDirs.length === 0) return true;
        let set = names.get(a.parent);
        if (!set) {
          set = new Set();
          for (const c of d.children(a.parent)) set.add(d.name(c).toLowerCase());
          names.set(a.parent, set);
        }
        const key = a.item.name.toLowerCase();
        if (set.has(key)) return false;
        set.add(key);
        return true;
      });
      if (fresh.length > 0) {
        markFresh(d.graftAll(fresh));
        changed = true;
      }
      if (changed) {
        setHover(-1);
        setVersion((v) => v + 1);
      }
    };

    const offChanges = window.api.onWatchChanges((b) => {
      queue = queue.then(() => apply(b)).catch(() => undefined);
    });
    const offLost = window.api.onWatchLost(() => {
      setSyncLost(true);
      setNotice({ text: t("live.lost"), bad: true, action: { label: t("menu.rescan"), run: () => startScan(d.t.root) } });
    });
    void window.api.startWatch(d.t.root);
    return () => {
      alive = false;
      offChanges();
      offLost();
      void window.api.stopWatch();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [synced, disk]);

  const toggleSync = (): void => {
    const next = !(sync && !syncLost);
    // Switching it off records where the disk stands now.
    if (!next && synced && disk) {
      // A save that failed returns null; say so rather than implying the state
      // made it into the history.
      void window.api
        .saveSnapshot(reduceTable(disk.t, Date.now()))
        .then((meta) => setNotice(meta ? { text: t("live.saved") } : { text: t("live.saveFailed"), bad: true }));
    }
    setSyncLost(false);
    setSync(next);
    save("sync", next ? "on" : "off");
  };

  // Adding and removing a protected folder. Each call answers with the list the
  // main process now holds, so what is drawn cannot disagree with what is
  // enforced.
  const addProtected = async (): Promise<void> => {
    const path = await window.api.pickFolder();
    if (path) setProtectedFolders(await window.api.addProtectedFolder(path));
  };
  const removeProtected = (path: string): void => {
    void window.api.removeProtectedFolder(path).then(setProtectedFolders);
  };

  // Menus ------------------------------------------------------------------

  const ready = phase.is === "ready" && disk !== null;
  // During a scan the plan is already on screen, filling in as folders are measured.
  const live = phase.is === "scanning" && disk !== null;
  // Anything that moves around the plan works during a scan as well.
  const nav = ready || live;
  // Why Live sync is unavailable, or undefined when it can be switched on. The
  // toolbar button and the View menu entry both read this one value, so the
  // control cannot be greyed out in one place and silently inert in the other,
  // and neither can be greyed out without saying why.
  const liveWhy = !disk ? t("live.whyNoScan") : disk.t.incomplete ? t("live.whyIncomplete") : undefined;
  const menus: Record<BarName, () => MenuEntry[]> = {
    file: () => [
      { label: t("menu.chooseFolder"), icon: "folder", keys: MOD + "+O", run: pickFolder },
      { label: t("menu.rescan"), icon: "rescan", keys: "F5", disabled: !ready, run: () => disk && startScan(disk.t.root) },
      { label: t("menu.start"), icon: "drive", disabled: phase.is === "start", run: toStart },
      { kind: "sep" },
      { label: t("menu.exit"), keys: "Alt+F4", run: () => void window.api.quit() },
    ],
    view: () => [
      { label: t("menu.zoomOut"), icon: "up", keys: "Backspace", disabled: !nav || zoom === 0, run: () => disk && zoomTo(disk.parent(zoom)) },
      { label: t("menu.zoomRoot"), disabled: !nav || zoom === 0, run: () => zoomTo(0) },
      { label: t("menu.back"), icon: "back", keys: "Alt+Left", disabled: !nav || trail.back.length === 0, run: () => step("back") },
      { label: t("menu.forward"), icon: "forward", keys: "Alt+Right", disabled: !nav || trail.forward.length === 0, run: () => step("forward") },
      ...(can.watch
        ? [
            { kind: "sep" } as MenuEntry,
            {
              label: t("live.title"),
              checked: sync && !syncLost,
              disabled: liveWhy !== undefined,
              why: liveWhy,
              run: toggleSync,
            } as MenuEntry,
          ]
        : []),
      { kind: "sep" },
      { label: t("menu.settings"), icon: "grid", keys: MOD + ",", run: () => setDialog("settings") },
      { kind: "sep" },
      { label: t("menu.fullscreen"), keys: "F11", run: () => void window.api.toggleFullScreen() },
    ],
    window: () => [
      { label: t("menu.newWindow"), icon: "windows", keys: MOD + "+N", run: () => void window.api.newWindow() },
      { label: t("menu.closeWindow"), keys: MOD + "+W", run: () => void window.api.closeWindow() },
      { kind: "sep" },
      { label: t("menu.sideBySide"), disabled: windows.length < 2, run: () => void window.api.arrangeWindows("columns") },
      { label: t("menu.stacked"), disabled: windows.length < 2, run: () => void window.api.arrangeWindows("rows") },
      { label: t("menu.cascade"), disabled: windows.length < 2, run: () => void window.api.arrangeWindows("cascade") },
      { kind: "sep" },
      ...windows.map((w): MenuEntry => ({ label: w.title, checked: w.focused, run: () => void window.api.focusWindow(w.id) })),
    ],
    help: () => [
      { label: t("menu.shortcuts"), keys: "F1", run: () => setDialog("keys") },
      { kind: "sep" },
      // Drawn only once a website is configured: an entry that opens nothing is
      // worse than no entry at all.
      ...(SITE
        ? [{ label: t("menu.website"), icon: "reveal", run: () => void window.api.openExternal(SITE) } as MenuEntry]
        : []),
      { label: t("menu.source"), icon: "reveal", run: () => void window.api.openExternal(REPO) },
      { label: t("menu.support"), icon: "info", run: () => void window.api.openExternal("mailto:" + CONTACT) },
      { kind: "sep" },
      ...(can.update
        ? [
            {
              label: t("menu.update"),
              run: () => {
                askedUpdate.current = true;
                void window.api.checkUpdate();
              },
            } as MenuEntry,
          ]
        : []),
      { label: t("menu.licence"), run: () => setDialog("licence") },
      { label: t("menu.about"), run: () => setDialog("about") },
    ],
  };
  const openMenu = (name: BarName, first = false): void => {
    const el = document.querySelector<HTMLElement>(`[data-menu="${name}"]`);
    if (!el) return;
    const r = el.getBoundingClientRect();
    setBarFocus(-1);
    setMenu({ x: r.left, y: r.bottom, items: menus[name](), from: name, first });
  };
  const openRef = useRef(openMenu);
  openRef.current = openMenu;

  // The menu bar from the keyboard: Alt alone moves onto it, the arrows walk
  // it, Alt with a letter opens that menu, Escape leaves. Registered in the
  // capture phase so these keys never reach the shortcuts below.
  useEffect(() => {
    let altAlone = false;
    const byKey = (key: string): BarName | undefined => BAR.find((n) => t(`menu.${n}.key`) === key.toLowerCase());
    const swallow = (e: KeyboardEvent): void => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    const down = (e: KeyboardEvent): void => {
      if (e.key === "Alt") {
        if (!e.repeat) altAlone = true;
        e.preventDefault(); // keep Windows from opening the system menu
        return;
      }
      altAlone = false;
      const { menu: open, barFocus: at } = view.current;
      if (open) return; // an open menu reads its own keys
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.length === 1) {
        const name = byKey(e.key);
        if (name) {
          swallow(e);
          openRef.current(name, true);
        }
        return;
      }
      if (at < 0) return;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") setBarFocus((at + (e.key === "ArrowLeft" ? -1 : 1) + BAR.length) % BAR.length);
      else if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") openRef.current(BAR[at], true);
      else if (e.key === "Escape") setBarFocus(-1);
      else if (e.key.length === 1 && byKey(e.key)) openRef.current(byKey(e.key)!, true);
      else {
        setBarFocus(-1);
        return;
      }
      swallow(e);
    };
    const up = (e: KeyboardEvent): void => {
      if (e.key !== "Alt" || !altAlone) return;
      altAlone = false;
      e.preventDefault();
      if (view.current.menu) setMenu(null);
      else setBarFocus((f) => (f >= 0 ? -1 : 0));
    };
    const leave = (): void => {
      altAlone = false;
      setBarFocus(-1);
    };
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    window.addEventListener("mousedown", leave, true);
    window.addEventListener("blur", leave);
    return () => {
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
      window.removeEventListener("mousedown", leave, true);
      window.removeEventListener("blur", leave);
    };
  }, [t]);

  // Keyboard ---------------------------------------------------------------

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      // A dialog keeps the keyboard to itself.
      if (document.querySelector("dialog[open]")) return;
      if (e.key === "F1") {
        e.preventDefault();
        setDialog("keys");
      } else if (mod && key === "n") {
        e.preventDefault();
        void window.api.newWindow();
      } else if (mod && key === "w") {
        e.preventDefault();
        void window.api.closeWindow();
      } else if (e.key === "F5") {
        e.preventDefault();
        if (ready && disk) startScan(disk.t.root);
      } else if (e.key === "F11") {
        e.preventDefault();
        void window.api.toggleFullScreen();
      } else if (e.key === "F12") {
        void window.api.toggleDevTools();
      } else if (mod && key === "o") {
        e.preventDefault();
        pickFolder();
      } else if (mod && key === ",") {
        e.preventDefault();
        setDialog("settings");
      } else if (mod && key === "f") {
        e.preventDefault();
        // The search field sits in the toolbar that a running scan hides, so
        // focusing it there silently did nothing. Search the finished scan, and
        // when there is not one yet, say so rather than pretending to respond:
        // the results would be read off a table that is replaced every second.
        if (ready) {
          searchRef.current?.focus();
          searchRef.current?.select();
        } else {
          flash(t(disk ? "search.whyScanning" : "search.whyNoScan"));
        }
      } else if (e.key === "Escape") {
        if (typing && query) clearFilters();
        else if (phase.is === "scanning") (live ? stopHere : toStart)();
      } else if (!typing && nav && disk) {
        if (e.altKey && e.key === "ArrowLeft") step("back");
        else if (e.altKey && e.key === "ArrowRight") step("forward");
        else if (e.altKey && e.key === "Enter" && selected >= 0) showProps(selected);
        else if (e.key === "Backspace" && zoom > 0) zoomTo(disk.parent(zoom));
        else if (mod && e.shiftKey && key === "c" && selected >= 0) {
          void window.api.copyText(disk.path(selected)).then(() => flash(t("copied")));
        } else if (mod && key === "c" && selected >= 0) {
          // Leave the system copy alone when text is selected.
          if (!window.getSelection()?.toString()) copyItem(selected, false);
        } else if (mod && key === "x" && selected > 0) copyItem(selected, true);
        else if (mod && key === "v") void pasteInto(pasteTarget());
        else if (can.trash && ready && e.key === "Delete" && selected > 0 && !(e.target as HTMLElement).closest?.(".rows")) setTrash([selected]);
        else return;
        e.preventDefault();
      }
    };
    // The side buttons of a mouse go back and forward, as in a browser.
    const onMouse = (e: MouseEvent): void => {
      if (!nav) return;
      if (e.button === 3) step("back");
      else if (e.button === 4) step("forward");
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mouseup", onMouse);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mouseup", onMouse);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, nav, disk, zoom, selected, phase, query, t, startScan, pickFolder, zoomTo, toStart, step]);

  // Apps, on Android: read when Clean up or Apps is open, and again on return
  // from the system screens that change them (uninstall, caches, usage access).
  const appsJob = useRef({ running: false, again: false });
  const loadApps = useCallback((): void => {
    const phone = window.api.phone;
    const job = appsJob.current;
    if (!phone) return;
    if (job.running) {
      job.again = true;
      return;
    }
    job.running = true;
    void phone
      .apps()
      .then((r) => {
        setUsage(r.granted);
        setApps(r.granted ? r.apps : null);
      })
      .catch(() => setUsage(false))
      .finally(() => {
        job.running = false;
        if (job.again) {
          job.again = false;
          loadApps();
        }
      });
  }, []);
  const wantApps = window.api.phone !== undefined && (tab === "clean" || tab === "apps");
  useEffect(() => {
    if (wantApps && usage === null) loadApps();
  }, [wantApps, usage, loadApps]);
  useEffect(() => (wantApps ? window.api.onResume(loadApps) : undefined), [wantApps, loadApps]);
  // An app uninstalled from its sheet takes the sheet with it.
  const appSel = appPkg && apps ? apps.find((a) => a.pkg === appPkg) : undefined;
  useEffect(() => {
    if (appPkg && apps && !appSel) setAppPkg(null);
  }, [appPkg, apps, appSel]);
  const clearCaches = (): void => {
    void window.api.phone?.clearAppCaches().then((done) => {
      if (done) flash(t("clean.cacheDone"));
      loadApps();
    });
  };

  // Android's back button: the innermost thing first, the app itself last.
  useEffect(() => {
    const back = (): void => {
      const v = view.current;
      if (settingsOpen) return setSettingsOpen(false);
      if (searching) return closeSearch();
      if (appPkg) return setAppPkg(null);
      if (tab === "clean" && cleanOpen) return setCleanOpen(null);
      if (v.disk && v.selected >= 0 && v.selected !== v.zoom) return setSelected(-1);
      if (v.menu) return setMenu(null);
      const open = document.querySelector<HTMLDialogElement>("dialog[open]");
      if (open) return open.close();
      if (phase.is === "scanning") return (live ? stopHere : toStart)();
      if (v.disk && v.zoom > 0) return zoomTo(v.disk.parent(v.zoom));
      if (phase.is !== "start") return toStart();
      void window.api.quit();
    };
    window.addEventListener("spacewise:back", back);
    return () => window.removeEventListener("spacewise:back", back);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, live, stopHere, toStart, zoomTo, settingsOpen, searching, appPkg, tab, cleanOpen]);

  // Splitter ---------------------------------------------------------------

  const dragSplit = (e: React.MouseEvent): void => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = panelWidth;
    let latest = startW;
    const move = (ev: MouseEvent): void => {
      latest = Math.max(320, Math.min(window.innerWidth - 360, startW + startX - ev.clientX));
      setPanelWidth(latest);
    };
    const up = (): void => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      save("panel", String(latest));
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  // Derived ----------------------------------------------------------------

  const crumbs = useMemo(() => (disk && nav ? disk.ancestors(zoom) : []), [disk, nav, zoom]);
  const scale = useMemo(() => {
    if (!disk || planArea <= 0 || disk.size(zoom) <= 0) return null;
    const perPixel = disk.size(zoom) / planArea;
    for (let unit = 1024; unit < 2 ** 50; unit *= 1024) {
      for (const m of [1, 2, 5, 10, 20, 50, 100, 200, 500]) {
        const side = Math.sqrt((unit * m) / perPixel);
        if (side >= 12) return { side: Math.min(32, Math.round(side)), bytes: unit * m };
      }
    }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disk, zoom, planArea, version]);

  const scanPct = progress && scanBase ? Math.min(0.99, progress.bytes / scanBase) : null;
  const pane = { disk: disk!, version, selected, hover, fmt, t, onSelect: select, onHover: setHover, onZoom: zoomTo, onContext: context };
  const grew = comparison !== null && comparison.rows.some((id) => comparison.delta[id] > 0);
  const tabs: Tab[] = ["tree", "largest", "types", "cleanup", "dupes", "changes"];
  if (filtering) tabs.push("found");

  // Pieces both layouts place: the plan, and the panes that are not the tree.
  const plan = disk && (
    <Treemap
      disk={disk}
      version={version}
      theme={theme}
      zoom={zoom}
      fresh={fresh}
      levels={levels === 0 ? Infinity : levels}
      selected={selected}
      hover={hover}
      comparison={comparison}
      showDelta={tab === "changes"}
      fmt={fmt}
      t={t}
      onHover={setHover}
      onSelect={select}
      onZoom={zoomTo}
      onContext={context}
      onArea={setPlanArea}
    />
  );
  const panes = disk && (
    <>
      {tab === "largest" && (
        <ListPane
          {...pane}
          ids={largest}
          note={t("largest.note", { count: fmt.count(largest.length) })}
          onTrash={can.trash ? askTrash : undefined}
        />
      )}
      {tab === "types" && (
        <TypesPane {...pane} activeExt={filter.extId} onPick={(extId) => setFilter((f) => ({ ...f, extId }))} />
      )}
      {tab === "cleanup" && <CleanupPane {...pane} onRemoved={onCleanupRemoved} onLicence={() => setDialog("licence")} />}
      {tab === "clean" && (
        <CleanPane
          disk={disk}
          version={version}
          fmt={fmt}
          t={t}
          open={cleanOpen}
          onOpen={setCleanOpen}
          apps={apps}
          usage={usage}
          onRequestUsage={() => void window.api.phone?.requestUsageAccess()}
          onClearCaches={clearCaches}
          onDupes={() => setTab("dupes")}
          onUnusedApps={() => {
            setIdleOnly(true);
            setTab("apps");
          }}
          onTrash={askTrash}
        />
      )}
      {tab === "apps" && (
        <AppsPane
          apps={apps}
          usage={usage}
          fmt={fmt}
          t={t}
          idleOnly={idleOnly}
          onIdleOnly={setIdleOnly}
          onRequestUsage={() => void window.api.phone?.requestUsageAccess()}
          onSelect={(a) => setAppPkg(a.pkg)}
        />
      )}
      {tab === "dupes" && (
        <DupesPane
          {...pane}
          state={dups}
          setState={setDups}
          onTrash={can.trash ? askTrash : undefined}
          unlimited={hasFeature(licence, "duplicates.unlimited")}
          onLicence={() => setDialog("licence")}
        />
      )}
      {tab === "changes" &&
        (hasFeature(licence, "compare.scans") ? (
          <ChangesPane {...pane} comparison={comparison} snapshots={snapshots} against={against} onAgainst={setAgainst} />
        ) : (
          <PremiumGate what={t("tab.changes")} t={t} onOpen={() => setDialog("licence")} />
        ))}
      {tab === "found" && found && (
        <ListPane
          {...pane}
          ids={found.ids}
          empty={t("found.none")}
          onTrash={can.trash ? askTrash : undefined}
          note={
            <>
              <strong>{t("found.summary", { count: fmt.count(found.total), bytes: fmt.bytes(found.bytes) })}</strong>
              {filter.extId >= 0 && " " + t("found.type", { ext: disk.t.exts[filter.extId] || "?" }) + "."}
              {found.total > found.ids.length && " " + t("found.capped", { shown: fmt.count(found.ids.length) })}
            </>
          }
        />
      )}
    </>
  );

  // The phone layout -------------------------------------------------------
  const norm = (p: string): string => p.replace(/[\\/]+$/, "").toLowerCase();
  const driveLabel = disk ? drives?.find((d) => norm(d.path) === norm(disk.t.root))?.label : undefined;
  const more = <BarButton icon="more" label={t("m.more")} onClick={() => setSettingsOpen(true)} />;
  const mobileHeader = !MOBILE ? null : searching && disk && nav ? (
    <SearchBar
      t={t}
      value={query}
      onChange={setQuery}
      onClose={closeSearch}
      filters={
        <>
          <select
            className={"select" + (filter.minBytes > 0 ? " on" : "")}
            aria-label={t("filter.size")}
            value={filter.minBytes}
            onChange={(e) => setFilter((f) => ({ ...f, minBytes: Number(e.target.value) }))}
          >
            <option value={0}>{t("filter.size")}</option>
            {[1, 10, 100, 1024].map((mb) => (
              <option key={mb} value={mb * MB}>
                {t("filter.size")} {fmt.bytes(mb * MB)}
              </option>
            ))}
          </select>
          <select
            className={"select" + (filter.olderThanDays > 0 ? " on" : "")}
            aria-label={t("filter.age")}
            value={filter.olderThanDays}
            onChange={(e) => setFilter((f) => ({ ...f, olderThanDays: Number(e.target.value) }))}
          >
            <option value={0}>{t("filter.age")}</option>
            {([30, 180, 365, 730] as const).map((d) => (
              <option key={d} value={d}>
                {t("filter.age")} {t(`filter.days${d}`)}
              </option>
            ))}
          </select>
        </>
      }
    />
  ) : (
    <AppBar
      t={t}
      back={disk && nav && zoom > 0 ? () => zoomTo(disk.parent(zoom)) : undefined}
      title={
        disk && nav ? (zoom === 0 ? (driveLabel ?? disk.t.root) : disk.name(zoom)) : phase.is === "scanning" ? t("scan.dockTitle") : <BrandTitle />
      }
      subtitle={
        disk && nav
          ? live
            ? t("scan.dockTitle") + (scanPct !== null ? " " + Math.round(scanPct * 100) + "%" : "") + " · " + files(progress?.files ?? 0, fmt, t)
            : fmt.bytes(disk.size(zoom)) + " · " + files(disk.files(zoom), fmt, t) + (disk.t.incomplete ? " · " + t("scan.stoppedShort") : "")
          : phase.is === "scanning" || phase.is === "failed"
            ? phase.root
            : undefined
      }
      progress={phase.is === "scanning" ? (scanPct ?? null) : undefined}
      actions={
        live ? (
          <BarButton icon="stop" label={t(stopping ? "scan.stopping" : "scan.cancel")} onClick={stopHere} />
        ) : ready ? (
          <>
            <BarButton icon="search" label={t("m.search")} onClick={() => setSearching(true)} />
            {more}
          </>
        ) : (
          more
        )
      }
    />
  );
  // A phone gets its own cleaning and the apps; a narrow window elsewhere keeps the clutter pane.
  const mobileTabs: Tab[] = window.api.phone
    ? ["plan", "folders", "clean", "apps", "largest", "types", "dupes", "changes"]
    : ["plan", "folders", "largest", "types", "cleanup", "dupes", "changes"];
  if (filtering) mobileTabs.push("found");

  return (
    <div
      className={"app" + (dropping ? " dropping" : "") + (can.windows ? "" : " mobile")}
      style={{ ["--row" as string]: ROW + "px" }}
      onDragOver={(e) => {
        e.preventDefault();
        setDropping(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDropping(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDropping(false);
        const file = e.dataTransfer.files[0];
        if (file && can.drop) {
          const path = window.api.pathForFile(file);
          if (path) startScan(path);
        }
      }}
    >
      {mobileHeader}
      {!MOBILE && (
        <header className="titlebar">
          <div className="brand">
            <Mark />
            <Wordmark />
          </div>
          <nav className={"menus" + (barFocus >= 0 || menu?.from ? " keys" : "")}>
            {BAR.map((name, i) => {
              const label = t(`menu.${name}`);
              const at = label.toLowerCase().indexOf(t(`menu.${name}.key`));
              return (
                <button
                  key={name}
                  data-menu={name}
                  data-menu-owner=""
                  tabIndex={-1}
                  className={"menu-button" + (barFocus === i ? " focus" : "")}
                  aria-haspopup="menu"
                  aria-expanded={menu?.from === name}
                  onMouseDown={(e) => {
                    // The button keeps neither focus nor the click: it only toggles.
                    e.preventDefault();
                    if (menu?.from === name) setMenu(null);
                    else openMenu(name);
                  }}
                  onMouseEnter={() => {
                    if (menu?.from && menu.from !== name) openMenu(name);
                  }}
                >
                  {at < 0 ? (
                    label
                  ) : (
                    <>
                      {label.slice(0, at)}
                      <u>{label[at]}</u>
                      {label.slice(at + 1)}
                    </>
                  )}
                </button>
              );
            })}
          </nav>
          <div className="titlebar-path">{nav && disk ? disk.path(zoom) : phase.is === "scanning" ? phase.root : ""}</div>
          <button
            className="menu-button titlebar-tool"
            tabIndex={-1}
            title={t("menu.toggleMode")}
            aria-label={t("menu.toggleMode")}
            onClick={() => {
              const next = dark ? "light" : "dark";
              setMode(next);
              save("mode", next);
            }}
          >
            <Icon name="sun" />
          </button>
        </header>
      )}

      {notice && (
        <div className={"notice" + (notice.bad ? " bad" : "")} role="status">
          <span className="grow">{notice.text}</span>
          {notice.progress !== undefined && (
            <span className="share" style={{ width: 220 }}>
              <span className="track">
                <span className="fill" style={{ width: Math.round(notice.progress * 100) + "%", display: "block" }} />
              </span>
            </span>
          )}
          {notice.action && (
            <button className="btn" onClick={notice.action.run}>
              {notice.action.label}
            </button>
          )}
          <button className="btn quiet icon" aria-label={t("issues.close")} onClick={() => setNotice(null)}>
            <Icon name="close" />
          </button>
        </div>
      )}

      {phase.is === "start" && (
        <StartSheet
          drives={drives}
          access={access}
          t={t}
          fmt={fmt}
          onScan={startScan}
          onPick={pickFolder}
          onSlow={() => setDialog("slow")}
        />
      )}

      {((phase.is === "scanning" && !live) || phase.is === "failed") && (
        <ScanSheet phase={phase} progress={progress} pct={scanPct} t={t} fmt={fmt} onStop={toStart} onRetry={() => startScan(phase.root)} />
      )}

      {MOBILE && (ready || live) && disk && (
        <>
          <Tabs tabs={mobileTabs} tab={tab} onTab={setTab} label={(k) => t(`tab.${k}`)} marked={grew ? "changes" : null} />
          <main className="m-body">
            {tab === "plan" && plan}
            {tab === "folders" && (
              <FolderList
                disk={disk}
                version={version}
                zoom={zoom}
                selected={selected}
                fresh={fresh}
                fmt={fmt}
                t={t}
                onOpen={zoomTo}
                onSelect={setSelected}
              />
            )}
            {panes}
          </main>
        </>
      )}

      {!MOBILE && (ready || live) && disk && (
        <>
          {live && (
            <div className="toolrow livebar" role="status">
              {scanPct !== null && <span className="live-progress" style={{ width: Math.round(scanPct * 100) + "%" }} />}
              <button className="btn icon" disabled={trail.back.length === 0} title={t("menu.back") + " (Alt+Left)"} aria-label={t("menu.back")} onClick={() => step("back")}>
                <Icon name="back" />
              </button>
              <button
                className="btn icon"
                disabled={trail.forward.length === 0}
                title={t("menu.forward") + " (Alt+Right)"}
                aria-label={t("menu.forward")}
                onClick={() => step("forward")}
              >
                <Icon name="forward" />
              </button>
              <button className="btn icon" disabled={zoom === 0} title={t("menu.zoomOut") + " (Backspace)"} aria-label={t("menu.zoomOut")} onClick={() => zoomTo(disk.parent(zoom))}>
                <Icon name="up" />
              </button>
              <Icon name="scan" />
              <strong>{t("scan.title", { root: zoom === 0 ? disk.t.root : disk.name(zoom) })}</strong>
              <span className="live-now">
                <bdi>{progress?.current ?? ""}</bdi>
              </span>
              <span className="live-count">
                {fmt.count(progress?.files ?? 0)} {t("scan.files").toLowerCase()}, {fmt.bytes(progress?.bytes ?? 0)}
                {scanPct !== null && <strong> {Math.round(scanPct * 100)}%</strong>}
              </span>
              <button
                className={"btn icon" + (dockOpen ? " on" : "")}
                aria-pressed={dockOpen}
                title={t("scan.details")}
                aria-label={t("scan.details")}
                onClick={() => setDockOpen((o) => !o)}
              >
                <Icon name="info" />
              </button>
              <button className="btn" disabled={stopping} onClick={stopHere}>
                <Icon name="stop" />
                {t(stopping ? "scan.stopping" : "scan.cancel")}
              </button>
            </div>
          )}
          <div className="toolrow" style={live ? { display: "none" } : undefined}>
            <button className="btn" title={t("menu.start")} onClick={toStart}>
              <Icon name="drive" />
              {t("tool.drives")}
            </button>
            <button className="btn" onClick={() => startScan(disk.t.root)} title="F5">
              <Icon name="rescan" />
              {t("menu.rescan")}
            </button>
            {can.watch && (
              <button
                className={"btn" + (synced ? " on" : "")}
                aria-pressed={synced}
                disabled={liveWhy !== undefined}
                title={liveWhy ?? t("live.title")}
                aria-description={liveWhy}
                onClick={toggleSync}
              >
                <span className="pulse" />
                {t("live.button")}
              </button>
            )}
            <button
              className="btn icon"
              disabled={trail.back.length === 0}
              title={t("menu.back") + " (Alt+Left)"}
              aria-label={t("menu.back")}
              onClick={() => step("back")}
            >
              <Icon name="back" />
            </button>
            <button
              className="btn icon"
              disabled={trail.forward.length === 0}
              title={t("menu.forward") + " (Alt+Right)"}
              aria-label={t("menu.forward")}
              onClick={() => step("forward")}
            >
              <Icon name="forward" />
            </button>
            <button
              className="btn icon"
              disabled={zoom === 0}
              title={t("menu.zoomOut") + " (Backspace)"}
              aria-label={t("menu.zoomOut")}
              onClick={() => zoomTo(disk.parent(zoom))}
            >
              <Icon name="up" />
            </button>
            <div className="crumbs">
              {crumbs.map((id, i) => (
                <span key={id} style={{ display: "contents" }}>
                  {i > 0 && <Icon name="chevron" size={10} className="crumb-sep" />}
                  <button className={"crumb" + (id === zoom ? " here" : "")} onClick={() => zoomTo(id)}>
                    {id === 0 ? disk.t.root : disk.name(id)}
                  </button>
                </span>
              ))}
            </div>
            <select
              className={"select" + (filter.minBytes > 0 ? " on" : "")}
              aria-label={t("filter.size")}
              value={filter.minBytes}
              onChange={(e) => setFilter((f) => ({ ...f, minBytes: Number(e.target.value) }))}
            >
              <option value={0}>{t("filter.size")}</option>
              {[1, 10, 100, 1024].map((mb) => (
                <option key={mb} value={mb * MB}>
                  {t("filter.size")} {fmt.bytes(mb * MB)}
                </option>
              ))}
            </select>
            <select
              className={"select" + (filter.olderThanDays > 0 ? " on" : "")}
              aria-label={t("filter.age")}
              value={filter.olderThanDays}
              onChange={(e) => setFilter((f) => ({ ...f, olderThanDays: Number(e.target.value) }))}
            >
              <option value={0}>{t("filter.age")}</option>
              {([30, 180, 365, 730] as const).map((d) => (
                <option key={d} value={d}>
                  {t("filter.age")} {t(`filter.days${d}`)}
                </option>
              ))}
            </select>
            <label className="field">
              <Icon name="search" />
              <input
                ref={searchRef}
                value={query}
                placeholder={t("search.placeholder")}
                aria-label={t("search.placeholder")}
                spellCheck={false}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            {filtering && (
              <button className="btn icon" title={t("filter.clear")} aria-label={t("filter.clear")} onClick={clearFilters}>
                <Icon name="close" />
              </button>
            )}
          </div>

          <div className="work">
            {plan}
            <div className="splitter" onMouseDown={dragSplit} role="separator" aria-orientation="vertical" />
            <aside className="schedule" style={{ width: panelWidth }}>
              <div className="tabs" role="tablist">
                {tabs.map((name) => (
                  <button key={name} role="tab" className="tab" aria-selected={tab === name} onClick={() => setTab(name)}>
                    {t(`tab.${name}`)}
                    {name === "changes" && grew && <span className="badge" />}
                  </button>
                ))}
              </div>
              {tab === "tree" && (
                <TreeView
                  disk={disk}
                  version={version}
                  selected={selected}
                  hover={hover}
                  expanded={expanded}
                  reveal={reveal}
                  fresh={fresh}
                  wide={!window.api.compact && panelWidth >= 560}
                  fmt={fmt}
                  t={t}
                  onToggle={toggle}
                  onSelect={selectInTree}
                  onHover={setHover}
                  onZoom={zoomTo}
                  onContext={context}
                  onTrash={can.trash ? askTrash : undefined}
                />
              )}
              {panes}
              {live && dockOpen && <ScanDock progress={progress} pct={scanPct} t={t} fmt={fmt} onClose={() => setDockOpen(false)} />}
            </aside>
          </div>

          <footer className="titleblock">
            <div className="tb-cell">
              <span className="k">{t("block.root")}</span>
              <span className="v">{disk.t.root}</span>
            </div>
            <div className="tb-cell">
              <span className="k">{t("block.total")}</span>
              <span className="v">{fmt.bytes(disk.size(0))}</span>
            </div>
            <div className="tb-cell">
              <span className="k">{t("block.files")}</span>
              <span className="v">{fmt.count(disk.files(0))}</span>
            </div>
            <div className="tb-cell">
              <span className="k">{t("block.folders")}</span>
              <span className="v">{fmt.count(disk.t.dirs)}</span>
            </div>
            <div className="tb-cell">
              <span className="k">{t("block.scanned")}</span>
              <span className="v">
                {live ? t("scan.running") : disk.t.incomplete ? t("scan.stoppedShort") : synced ? t("live.short") : fmt.when(disk.t.startedAt)}
                <small>{t("block.in", { time: fmt.duration(disk.t.durationMs) })}</small>
              </span>
            </div>
            {disk.t.errors > 0 ? (
              <button className="tb-cell link" onClick={() => setDialog("issues")}>
                <span className="k">{t("block.issues")}</span>
                <span className="v">{fmt.count(disk.t.errors)}</span>
              </button>
            ) : (
              <div className="tb-cell">
                <span className="k">{t("block.issues")}</span>
                <span className="v">0</span>
              </div>
            )}
            <div className="tb-cell grow">
              <span className="k">{t("block.selected")}</span>
              <span className="v">
                {selected >= 0 && !disk.isGone(selected) ? (
                  <>
                    {selected === 0 ? disk.t.root : disk.name(selected)}
                    <small>{fmt.bytes(disk.size(selected))}</small>
                  </>
                ) : (
                  ""
                )}
              </span>
            </div>
            {scale && (
              <div className="tb-cell scale" title={t("block.scale")}>
                <span className="scale-box" style={{ width: scale.side, height: scale.side }} />
                <span>
                  <span className="k" style={{ display: "block" }}>
                    {t("block.scale")}
                  </span>
                  <span className="v">{fmt.bytes(scale.bytes)}</span>
                </span>
              </div>
            )}
          </footer>
        </>
      )}

      {MOBILE && disk && nav && selected >= 0 && selected !== zoom && !disk.isGone(selected) && (
        <ItemSheet
          disk={disk}
          id={selected}
          fmt={fmt}
          t={t}
          onClose={() => setSelected(-1)}
          onOpen={(id) => {
            setSelected(-1);
            zoomTo(id);
          }}
          onCopy={(path) => void window.api.copyText(path).then(() => flash(t("copied")))}
          onTrash={can.trash && ready ? () => setTrash([selected]) : undefined}
        />
      )}
      {MOBILE && appSel && <AppSheet app={appSel} fmt={fmt} t={t} onClose={() => setAppPkg(null)} />}
      {MOBILE && settingsOpen && (
        <SettingsSheet
          t={t}
          version={appVersion}
          family={family}
          families={FAMILIES.map((v) => ({ value: v, label: t(v === "grid" ? "menu.themeGrid" : "menu.themePaper") }))}
          onFamily={(v) => {
            setFamily(v);
            save("family", v);
          }}
          mode={mode}
          modes={MODES.map((v) => ({ value: v, label: t(v === "system" ? "menu.modeSystemAndroid" : v === "light" ? "menu.modeLight" : "menu.modeDark") }))}
          onMode={(v) => {
            setMode(v);
            save("mode", v);
          }}
          levels={levels}
          levelChoices={LEVELS.map((v) => ({ value: v as number, label: v === 0 ? t("menu.levelsAll") : String(v) }))}
          onLevels={(v) => {
            setLevels(v);
            save("levels", String(v));
          }}
          lang={lang}
          langs={[
            { value: "en" as Lang, label: "English" },
            { value: "pt" as Lang, label: "Português" },
          ]}
          onLang={(v) => {
            setLang(v);
            save("lang", v);
          }}
          onRescan={ready && disk ? () => startScan(disk.t.root) : undefined}
          onDrives={phase.is !== "start" ? toStart : undefined}
          onSite={SITE ? () => void window.api.openExternal(SITE) : undefined}
          onSource={() => void window.api.openExternal(REPO)}
          onSupport={() => void window.api.openExternal("mailto:" + CONTACT)}
          contact={CONTACT}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {menu && (
        <Menu
          x={menu.x}
          y={menu.y}
          items={menu.items}
          first={menu.first}
          onClose={() => setMenu(null)}
          onSide={
            menu.from
              ? (dir) => openMenu(BAR[(BAR.indexOf(menu.from!) + dir + BAR.length) % BAR.length], true)
              : undefined
          }
        />
      )}
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}

      {trash && disk && window.api.phone && (
        <PhoneTrash
          // A file already in the trash is shown by its own name, without Android's prefix.
          what={trash.length === 1 ? disk.path(trash[0]).replace(/\/\.trashed-\d+-([^/]*)$/, "/$1") : t("trash.many", { count: trash.length })}
          bytes={fmt.bytes(trash.reduce((a, id) => a + disk.size(id), 0))}
          eraseOnly={window.api.phone.sdk < 30 || trash.some((id) => disk.isDir(id) || disk.name(id).startsWith(".trashed-"))}
          t={t}
          onCancel={() => setTrash(null)}
          onConfirm={(erase) => void confirmTrash(erase)}
        />
      )}
      {trash && disk && !window.api.phone && (
        <Dialog onClose={() => setTrash(null)}>
          <header>
            <h2>{t("trash.title")}</h2>
          </header>
          <div className="body">
            <p className="what">{trash.length === 1 ? disk.path(trash[0]) : t("trash.many", { count: trash.length })}</p>
            <p>{t("trash.size", { bytes: fmt.bytes(trash.reduce((a, id) => a + disk.size(id), 0)) })}</p>
          </div>
          <footer>
            <button className="btn" onClick={() => setTrash(null)}>
              {t("act.cancel")}
            </button>
            <button className="btn danger" autoFocus onClick={() => void confirmTrash()}>
              <Icon name="trash" />
              {t("trash.confirm")}
            </button>
          </footer>
        </Dialog>
      )}

      {dialog === "issues" && disk && (
        <Dialog onClose={() => setDialog(null)}>
          <header>
            <h2>{t("issues.title", { count: fmt.count(disk.t.errors) })}</h2>
          </header>
          <div className="body">
            <p>{t("issues.lead")}</p>
            <ul className="issue-list">
              {disk.t.errorSamples.map((s, i) => (
                <li key={i}>
                  <span className="p">{s.path}</span>
                  <span className="c">{s.code}</span>
                </li>
              ))}
            </ul>
            {disk.t.errors > disk.t.errorSamples.length && (
              <p>{t("issues.more", { count: fmt.count(disk.t.errors - disk.t.errorSamples.length) })}</p>
            )}
          </div>
          <footer>
            <button className="btn" autoFocus onClick={() => setDialog(null)}>
              {t("issues.close")}
            </button>
          </footer>
        </Dialog>
      )}

      {propsOf !== null && disk && !disk.isGone(propsOf) && (
        <Dialog onClose={() => setPropsOf(null)}>
          <header>
            <h2>{t("props.title")}</h2>
          </header>
          <div className="body">
            <dl className="props">
              <dt>{t("props.name")}</dt>
              <dd>{propsOf === 0 ? disk.t.root : disk.name(propsOf)}</dd>
              {propsOf > 0 && (
                <>
                  <dt>{t("props.location")}</dt>
                  <dd>{disk.path(disk.parent(propsOf))}</dd>
                </>
              )}
              <dt>{t("props.kind")}</dt>
              <dd>
                {disk.isLink(propsOf)
                  ? t("props.link")
                  : disk.isDir(propsOf)
                    ? t("props.folder")
                    : t("props.file") + (disk.ext(propsOf) ? " ." + disk.ext(propsOf) : "")}
              </dd>
              <dt>{t("props.onDisk")}</dt>
              <dd>
                {fmt.bytes(disk.size(propsOf))} ({t("props.bytes", { count: fmt.count(disk.size(propsOf)) })})
              </dd>
              <dt>{t("props.length")}</dt>
              <dd>
                {fmt.bytes(disk.logical(propsOf))} ({t("props.bytes", { count: fmt.count(disk.logical(propsOf)) })})
              </dd>
              {disk.isDir(propsOf) && (
                <>
                  <dt>{t("props.contains")}</dt>
                  <dd>{t("tip.files", { count: fmt.count(disk.files(propsOf)) })}</dd>
                </>
              )}
              {propsOf > 0 && (
                <>
                  <dt>{t("props.ofParent")}</dt>
                  <dd>{fmt.pct(disk.size(propsOf) / (disk.size(disk.parent(propsOf)) || 1))}</dd>
                  <dt>{t("props.ofScan")}</dt>
                  <dd>{fmt.pct(disk.size(propsOf) / (disk.size(0) || 1))}</dd>
                </>
              )}
              {itemStat?.ok && (
                <>
                  <dt>{t("props.created")}</dt>
                  <dd>{fmt.stamp(itemStat.created)}</dd>
                  <dt>{t("props.modified")}</dt>
                  <dd>{fmt.stamp(itemStat.modified)}</dd>
                  <dt>{t("props.accessed")}</dt>
                  <dd>{fmt.stamp(itemStat.accessed)}</dd>
                  <dt>{t("props.readOnly")}</dt>
                  <dd>{t(itemStat.readOnly ? "props.yes" : "props.no")}</dd>
                </>
              )}
            </dl>
            {itemStat && !itemStat.ok && <p style={{ marginTop: 12 }}>{t("props.gone")}</p>}
          </div>
          <footer>
            {can.reveal && (
              <button className="btn" onClick={() => void window.api.showInFolder(disk.path(propsOf))}>
                <Icon name="reveal" />
                {t("act.reveal")}
              </button>
            )}
            <button className="btn" autoFocus onClick={() => setPropsOf(null)}>
              {t("issues.close")}
            </button>
          </footer>
        </Dialog>
      )}

      {dialog === "keys" && (
        <Dialog wide onClose={() => setDialog(null)}>
          <header>
            <h2>{t("keys.title")}</h2>
          </header>
          <div className="body">
            <p className="dim" style={{ fontSize: 12.5, marginBottom: 10 }}>
              {t("keys.lead")}
            </p>
            <table className="keys">
              <tbody>
                {(
                  [
                    [t("keys.scan")],
                    [t("keys.scanFolder"), MOD + "+O"],
                    [t("keys.rescan"), "F5"],
                    [t("keys.stop"), "Esc"],
                    [t("keys.move")],
                    [t("keys.open"), "Enter"],
                    [t("keys.double"), t("keys.doubleKey")],
                    [t("keys.wheel"), t("keys.wheelKey")],
                    [t("keys.up"), "Backspace"],
                    [t("keys.backForward"), "Alt+Left", "Alt+Right"],
                    [t("keys.find"), MOD + "+F"],
                    [t("keys.items")],
                    [t("keys.copyCutPaste"), MOD + "+C", MOD + "+X", MOD + "+V"],
                    [t("keys.copyPath"), MOD + "+Shift+C"],
                    [t("keys.trash"), "Delete"],
                    [t("keys.select"), t("keys.selectKey")],
                    [t("keys.properties"), "Alt+Enter"],
                    [t("keys.windowGroup")],
                    [t("keys.newWindow"), MOD + "+N"],
                    [t("keys.closeWindow"), MOD + "+W"],
                    [t("keys.menuBar"), "Alt"],
                    [t("keys.fullscreen"), "F11"],
                    [t("keys.settings"), MOD + ","],
                    [t("keys.thisList"), "F1"],
                  ] as string[][]
                ).map((row, i) =>
                  row.length === 1 ? (
                    <tr key={i}>
                      <th colSpan={2}>{row[0]}</th>
                    </tr>
                  ) : (
                    <tr key={i}>
                      <td>{row[0]}</td>
                      <td>
                        {row.slice(1).map((k, j) => (
                          <span key={k}>
                            {j > 0 && " "}
                            <kbd>{k}</kbd>
                          </span>
                        ))}
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
          <footer>
            <button className="btn" autoFocus onClick={() => setDialog(null)}>
              {t("issues.close")}
            </button>
          </footer>
        </Dialog>
      )}

      {dialog === "licence" && <LicenseDialog state={licence} t={t} onClose={() => setDialog(null)} onChanged={setLicence} />}

      {dialog === "settings" && (
        <DesktopSettings
          t={t}
          family={family}
          families={FAMILIES.map((v) => ({ value: v, label: t(v === "grid" ? "menu.themeGrid" : "menu.themePaper") }))}
          onFamily={(v) => {
            setFamily(v);
            save("family", v);
          }}
          mode={mode}
          modes={MODES.map((v) => ({
            value: v,
            label: t(v === "system" ? "menu.modeSystem" : v === "light" ? "menu.modeLight" : "menu.modeDark"),
          }))}
          onMode={(v) => {
            setMode(v);
            save("mode", v);
          }}
          lang={lang}
          langs={[
            { value: "en" as Lang, label: "English" },
            { value: "pt" as Lang, label: "Português" },
          ]}
          onLang={(v) => {
            setLang(v);
            save("lang", v);
          }}
          levels={levels}
          levelChoices={LEVELS.map((v) => ({ value: v as number, label: v === 0 ? t("menu.levelsAll") : String(v) }))}
          onLevels={(v) => {
            setLevels(v);
            save("levels", String(v));
          }}
          protectedFolders={protectedFolders}
          onAddProtected={() => void addProtected()}
          onRemoveProtected={removeProtected}
          onClose={() => setDialog(null)}
        />
      )}

      {dialog === "slow" && (
        <SlowSheet
          t={t}
          fmt={fmt}
          hasScan={ready}
          onClose={() => setDialog(null)}
          onLargest={() => {
            setDialog(null);
            setTab("largest");
          }}
        />
      )}

      {dialog === "about" && (
        <Dialog onClose={() => setDialog(null)}>
          <div className="body" style={{ paddingTop: 16 }}>
            <div className="about">
              <Mark size={44} />
              <div>
                <div className="name">
                  <Wordmark size={30} />
                </div>
                <div>{t("about.line", { version: appVersion })}</div>
                <div className="dim" style={{ fontSize: 12 }}>
                  {t("about.build", { build: appBuild || "—" })}
                </div>
                <div>
                  {t("about.contact")}{" "}
                  <a
                    href={"mailto:" + CONTACT}
                    onClick={(e) => {
                      e.preventDefault();
                      void window.api.openExternal("mailto:" + CONTACT);
                    }}
                  >
                    {CONTACT}
                  </a>
                </div>
                <div className="dim" style={{ fontSize: 12, marginTop: 6 }}>
                  {t("about.upstream")}{" "}
                  <a
                    href={UPSTREAM}
                    onClick={(e) => {
                      e.preventDefault();
                      void window.api.openExternal(UPSTREAM);
                    }}
                  >
                    Diskplot
                  </a>
                </div>
              </div>
            </div>
          </div>
          <footer>
            <button className="btn" onClick={() => void window.api.openExternal("mailto:" + CONTACT)}>
              {t("menu.support")}
            </button>
            <button className="btn" onClick={() => void window.api.openExternal(REPO)}>
              GitHub
            </button>
            <button className="btn" autoFocus onClick={() => setDialog(null)}>
              {t("issues.close")}
            </button>
          </footer>
        </Dialog>
      )}
    </div>
  );
}

// Android keeps files in its trash from version 11 on, and never folders; past
// that, or for what is already in the trash, only deleting for good is offered.
function PhoneTrash(p: { what: string; bytes: string; eraseOnly: boolean; t: T; onCancel: () => void; onConfirm: (erase: boolean) => void }) {
  const { t } = p;
  return (
    <Dialog onClose={p.onCancel}>
      <header>
        <h2>{t(p.eraseOnly ? "trash.eraseTitle" : "trash.androidTitle")}</h2>
      </header>
      <div className="body">
        <p className="what">{p.what}</p>
        <p>{t(p.eraseOnly ? "trash.eraseBody" : "trash.androidBody", { bytes: p.bytes })}</p>
      </div>
      <footer className="m-dialog-actions">
        <button className="btn" onClick={p.onCancel}>
          {t("act.cancel")}
        </button>
        {!p.eraseOnly && (
          <button className="btn" onClick={() => p.onConfirm(true)}>
            {t("clean.erase")}
          </button>
        )}
        <button className="btn danger" autoFocus onClick={() => p.onConfirm(p.eraseOnly)}>
          <Icon name="trash" />
          {t(p.eraseOnly ? "clean.erase" : "clean.toTrash")}
        </button>
      </footer>
    </Dialog>
  );
}

function Dialog({ children, onClose, wide }: { children: React.ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current!;
    if (!el.open) el.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className={wide ? "wide" : undefined}
      onClose={onClose}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {children}
    </dialog>
  );
}

function StartSheet(p: {
  drives: DriveInfo[] | null;
  access: boolean;
  t: T;
  fmt: Fmt;
  onScan: (root: string) => void;
  onPick: () => void;
  onSlow: () => void;
}) {
  const { t, fmt } = p;
  if (!p.access)
    return (
      <main className="sheet">
        <div className="sheet-inner">
          <h1>{t("access.title")}</h1>
          <p className="lead">{t("access.lead")}</p>
          <div className="sheet-foot">
            <button className="btn primary" onClick={() => void window.api.requestAccess()}>
              <Icon name="folder" />
              {t("access.allow")}
            </button>
          </div>
          <p className="lead" style={{ marginTop: 24, fontSize: 13.5 }}>
            {t("access.note")}
          </p>
        </div>
      </main>
    );
  return (
    <main className="sheet">
      <div className="sheet-inner">
        <h1>{t("start.title")}</h1>
        <p className="lead">{t("start.lead")}</p>
        <div className="drives">
          <div className="drives-head">
            <span>{t("start.drive")}</span>
            <span />
            <span className="num">{t("start.used")}</span>
            <span className="num">{t("start.free")}</span>
            <span className="num">{t("start.capacity")}</span>
            <span />
          </div>
          {p.drives?.length === 0 && (
            <div className="drive" style={{ gridTemplateColumns: "1fr" }}>
              <span>{t("start.noDrives")}</span>
            </div>
          )}
          {p.drives?.map((d) => {
            // A drive that is there but could not be read is listed with the
            // reason. It used to be filtered out, so a drive the person could see
            // in Explorer was simply absent here and nothing explained why.
            if (d.unavailable)
              return (
                <div className="drive" key={d.path}>
                  <span className="letter">
                    <Icon name="drive" size={20} />
                    {d.label ?? d.path.replace(/[\\/]$/, "")}
                  </span>
                  <span className="dim" style={{ gridColumn: "2 / -1" }} title={d.unavailable}>
                    {d.unavailable}
                  </span>
                </div>
              );
            const used = d.total - d.free;
            const frac = d.total > 0 ? used / d.total : 0;
            return (
              <div className="drive" key={d.path} onDoubleClick={() => p.onScan(d.path)}>
                <span className="letter">
                  <Icon name="drive" size={20} />
                  {d.label ?? d.path.replace(/[\\/]$/, "")}
                </span>
                <span
                  className={"meter" + (frac > 0.9 ? " full" : "")}
                  role="meter"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(frac * 100)}
                  aria-label={t("start.used")}
                >
                  <i style={{ width: frac * 100 + "%" }} />
                </span>
                <span className="num">{fmt.bytes(used)}</span>
                <span className="num">{fmt.bytes(d.free)}</span>
                <span className="num">{fmt.bytes(d.total)}</span>
                <span className="go">
                  <button className="btn primary" onClick={() => p.onScan(d.path)}>
                    <Icon name="scan" />
                    {t("start.scan")}
                  </button>
                </span>
              </div>
            );
          })}
        </div>
        {p.drives?.some((d) => d.unavailable) && (
          <p className="lead" style={{ marginTop: 12, fontSize: 13 }}>
            {t("start.someUnreadable")}
          </p>
        )}
        <div className="sheet-foot">
          <button className="btn" onClick={p.onPick}>
            <Icon name="folder" />
            {t("start.folder")}
          </button>
          {can.drop && <span>{t("start.drop")}</span>}
        </div>
        {/* On a row of its own, because it does not choose what to scan: it asks the
            machine a question. Sharing the row with the folder button made it read as
            a second, lesser way to start a scan. */}
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid currentColor" }}>
          <button className="btn quiet" style={{ width: "100%" }} onClick={p.onSlow}>
            <Icon name="info" />
            {t("slow.title")}
          </button>
        </div>
      </div>
    </main>
  );
}

// Where the centred scan sheet last stood. When the plan takes over, the
// dock starts there and travels to its place under the schedule.
let sheetRect: DOMRect | null = null;

function ScanDock(p: { progress: ScanProgress | null; pct: number | null; t: T; fmt: Fmt; onClose: () => void }) {
  const { t, fmt } = p;
  const pr = p.progress;
  const ref = useRef<HTMLDivElement>(null);
  const max = pr && pr.top.length > 0 ? pr.top[0].bytes || 1 : 1;

  useLayoutEffect(() => {
    const el = ref.current;
    const from = sheetRect;
    sheetRect = null;
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const to = el.getBoundingClientRect();
    const frames = from
      ? [
          {
            transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width}, ${Math.min(2.2, from.height / to.height)})`,
            opacity: 0.5,
          },
          { transform: "none", opacity: 1 },
        ]
      : [
          { transform: "translateY(24px)", opacity: 0 },
          { transform: "none", opacity: 1 },
        ];
    el.animate(frames, { duration: from ? 520 : 240, easing: "cubic-bezier(0.16, 1, 0.3, 1)" });
  }, []);

  return (
    <div className="dock" ref={ref}>
      <div className="dock-head">
        {t("scan.dockTitle")}
        {p.pct !== null && <span>{Math.round(p.pct * 100)}%</span>}
        <span className="path">
          <bdi>{pr?.current ?? ""}</bdi>
        </span>
        <button className="btn quiet icon" style={{ height: 24 }} aria-label={t("issues.close")} title={t("issues.close")} onClick={p.onClose}>
          <Icon name="close" />
        </button>
      </div>
      <div className="dock-nums">
        <div>
          <div className="k">{t("scan.bytes")}</div>
          <div className="v">{fmt.bytes(pr?.bytes ?? 0)}</div>
        </div>
        <div>
          <div className="k">{t("scan.files")}</div>
          <div className="v">{fmt.count(pr?.files ?? 0)}</div>
        </div>
        <div>
          <div className="k">{t("scan.folders")}</div>
          <div className="v">{fmt.count(pr?.dirs ?? 0)}</div>
        </div>
        <div>
          <div className="k">{t("scan.rate")}</div>
          <div className="v">{fmt.count(pr && pr.elapsedMs > 0 ? (pr.files / pr.elapsedMs) * 1000 : 0)}</div>
        </div>
      </div>
      <div className="sofar" style={{ margin: 0 }}>
        {pr?.top.slice(0, 6).map((row) => (
          <div className="sofar-row" key={row.name}>
            <span className="n">
              <Icon name={row.dir ? "folder" : "file"} />
              {row.name}
            </span>
            <span className="bar" style={{ transform: `scaleX(${Math.max(0.004, row.bytes / max)})` }} />
            <span className="s">{fmt.bytes(row.bytes)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ScanSheet(p: {
  phase: { is: "scanning"; root: string } | { is: "failed"; root: string; error: string };
  progress: ScanProgress | null;
  pct: number | null;
  t: T;
  fmt: Fmt;
  onStop: () => void;
  onRetry: () => void;
}) {
  const { t, fmt, phase } = p;
  const pr = p.progress;
  const max = pr && pr.top.length > 0 ? pr.top[0].bytes || 1 : 1;
  const card = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (phase.is === "scanning" && card.current) sheetRect = card.current.getBoundingClientRect();
  });
  return (
    <main className="sheet scan">
      <div className="sheet-inner" ref={card}>
        <h1>
          {t("scan.title", { root: phase.root })}
          {p.pct !== null && phase.is === "scanning" && <span style={{ color: "var(--ink-2)", fontWeight: 400 }}> {Math.round(p.pct * 100)}%</span>}
        </h1>
        {phase.is === "failed" ? (
          <div className="problem" role="alert">
            <h2>{t("scan.failed")}</h2>
            <p>{phase.error === "missing" ? t("scan.missing") : phase.error}</p>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn primary" onClick={p.onRetry}>
                <Icon name="rescan" />
                {t("menu.rescan")}
              </button>
              <button className="btn" onClick={p.onStop}>
                {t("scan.back")}
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="current">
              <bdi>{pr?.current ?? ""}</bdi>
            </div>
            <div className="counters">
              <div>
                <div className="k">{t("scan.bytes")}</div>
                <div className="v">{fmt.bytes(pr?.bytes ?? 0)}</div>
              </div>
              <div>
                <div className="k">{t("scan.files")}</div>
                <div className="v">{fmt.count(pr?.files ?? 0)}</div>
              </div>
              <div>
                <div className="k">{t("scan.folders")}</div>
                <div className="v">{fmt.count(pr?.dirs ?? 0)}</div>
              </div>
              <div>
                <div className="k">{t("scan.rate")}</div>
                <div className="v">{fmt.count(pr && pr.elapsedMs > 0 ? (pr.files / pr.elapsedMs) * 1000 : 0)}</div>
              </div>
              <div className="stop">
                <button className="btn" onClick={p.onStop}>
                  <Icon name="stop" />
                  {t("scan.cancel")}
                </button>
              </div>
            </div>
            <div className="sofar">
              <h2>{t("scan.sofar")}</h2>
              {pr?.top.map((row) => (
                <div className="sofar-row" key={row.name}>
                  <span className="n">
                    <Icon name={row.dir ? "folder" : "file"} />
                    {row.name}
                  </span>
                  <span className="bar" style={{ transform: `scaleX(${Math.max(0.004, row.bytes / max)})` }} />
                  <span className="s">{fmt.bytes(row.bytes)}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </main>
  );
}
