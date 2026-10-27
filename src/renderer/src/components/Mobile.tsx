// The phone layout: a top app bar with the folder in view, tabs that switch
// one view at a time, and bottom sheets for the selected item and for the
// settings. Used on Android; the desktop keeps its own window chrome.
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { Disk } from "../lib/disk";
import type { Fmt, T } from "../lib/i18n";
import type { ItemStat } from "../../../shared/types";
import { Icon, Mark, Wordmark } from "./Icon";
import type { IconName } from "./Icon";
import { VirtualRows } from "./ui";

// "1 file", "2 files".
export function files(n: number, fmt: Fmt, t: T): string {
  return n === 1 ? t("tip.file") : t("tip.files", { count: fmt.count(n) });
}

// Top app bar ---------------------------------------------------------------

export function AppBar(p: {
  t: T;
  title: ReactNode;
  subtitle?: ReactNode;
  back?: () => void; // shown as the navigation button when there is somewhere to go back to
  actions: ReactNode;
  progress?: number | null; // 0 to 1 along the foot of the bar while a scan runs
}) {
  return (
    <header className="m-bar">
      {p.back ? (
        <button className="m-icon" aria-label={p.t("menu.back")} title={p.t("menu.back")} onClick={p.back}>
          <Icon name="back" size={22} />
        </button>
      ) : (
        <span className="m-mark">
          <Mark size={24} />
        </span>
      )}
      <div className="m-title">
        <h1>{p.title}</h1>
        {p.subtitle && <p>{p.subtitle}</p>}
      </div>
      <div className="m-actions">{p.actions}</div>
      {p.progress !== undefined && p.progress !== null && <span className="m-progress" style={{ transform: `scaleX(${p.progress})` }} />}
    </header>
  );
}

export function BarButton(p: { icon: IconName; label: string; onClick: () => void; pressed?: boolean }) {
  return (
    <button className="m-icon" aria-label={p.label} title={p.label} aria-pressed={p.pressed} onClick={p.onClick}>
      <Icon name={p.icon} size={22} />
    </button>
  );
}

export function BrandTitle() {
  return <Wordmark size={22} />;
}

// The search field takes the place of the title while a search is open.
export function SearchBar(p: { t: T; value: string; onChange: (v: string) => void; onClose: () => void; filters: ReactNode }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <>
      <header className="m-bar m-search">
        <button className="m-icon" aria-label={p.t("menu.back")} title={p.t("menu.back")} onClick={p.onClose}>
          <Icon name="back" size={22} />
        </button>
        <input
          ref={ref}
          value={p.value}
          placeholder={p.t("search.placeholder")}
          aria-label={p.t("search.placeholder")}
          spellCheck={false}
          enterKeyHint="search"
          onChange={(e) => p.onChange(e.target.value)}
        />
        {p.value && <BarButton icon="close" label={p.t("filter.clear")} onClick={() => p.onChange("")} />}
      </header>
      <div className="m-filters">{p.filters}</div>
    </>
  );
}

// Tabs ----------------------------------------------------------------------

export function Tabs<K extends string>(p: { tabs: K[]; tab: K; onTab: (k: K) => void; label: (k: K) => string; marked?: K | null }) {
  const row = useRef<HTMLDivElement>(null);
  // Keep the chosen tab in view when the row scrolls sideways.
  useEffect(() => {
    row.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [p.tab]);
  return (
    <nav className="m-tabs" role="tablist" ref={row}>
      {p.tabs.map((k) => (
        <button key={k} role="tab" aria-selected={p.tab === k} onClick={() => p.onTab(k)}>
          {p.label(k)}
          {p.marked === k && <span className="badge" />}
        </button>
      ))}
    </nav>
  );
}

// Folder list ---------------------------------------------------------------
// The contents of the folder in view, largest first. A folder opens on tap,
// the same way it opens on the plan, so both views always show one place.

const ROW_H = 64;

export function FolderList(p: {
  disk: Disk;
  version: number;
  zoom: number;
  selected: number;
  fresh: Set<number>;
  fmt: Fmt;
  t: T;
  onOpen: (id: number) => void;
  onSelect: (id: number) => void;
}) {
  const { disk, fmt, t } = p;
  const kids = disk.children(p.zoom);
  const total = disk.size(p.zoom) || 1;
  const press = useRef<{ id: number; timer: number } | null>(null);

  if (kids.length === 0)
    return (
      <div className="pane">
        <div className="pane-empty">{t("m.empty")}</div>
      </div>
    );

  // A long press selects a folder instead of opening it.
  const down = (id: number): void => {
    press.current = {
      id,
      timer: window.setTimeout(() => {
        press.current = null;
        p.onSelect(id);
      }, 450),
    };
  };
  const cancel = (): void => {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
  };
  const up = (id: number): void => {
    if (!press.current || press.current.id !== id) return;
    cancel();
    if (disk.isDir(id) && disk.children(id).length > 0) p.onOpen(id);
    else p.onSelect(id);
  };

  return (
    <div className="pane">
      <VirtualRows
        count={kids.length}
        label={t("tab.folders")}
        rowHeight={ROW_H}
        render={(i, top) => {
          const id = kids[i];
          const dir = disk.isDir(id);
          const share = disk.size(id) / total;
          const opens = dir && disk.children(id).length > 0;
          return (
            <div
              key={id}
              role="row"
              className={"m-row" + (id === p.selected ? " sel" : "") + (p.fresh.has(id) ? " new" : "")}
              style={{ top, height: ROW_H }}
              onPointerDown={() => down(id)}
              onPointerUp={() => up(id)}
              onPointerLeave={cancel}
              onPointerCancel={cancel}
              onContextMenu={(e) => e.preventDefault()}
            >
              <Icon name={dir ? "folder" : "file"} size={22} className="glyph" />
              <span className="m-row-text">
                <span className="name">{disk.name(id)}</span>
                <span className="meta">
                  {fmt.pct(share)}
                  {dir ? " · " + files(disk.files(id), fmt, t) : disk.t.mtime[id] ? " · " + fmt.date(disk.t.mtime[id]) : ""}
                </span>
              </span>
              <span className="m-row-size">{fmt.bytes(disk.size(id))}</span>
              <span className="m-row-go">{opens && <Icon name="chevron" size={16} />}</span>
              <span className="m-row-share" style={{ transform: `scaleX(${Math.max(share, 0.004)})` }} />
            </div>
          );
        }}
      />
    </div>
  );
}

// Bottom sheets -------------------------------------------------------------

// Dragging the grip or the head of a sheet: down closes, up expands.
function useDrag(onEnd: (dy: number) => void) {
  const start = useRef<number | null>(null);
  const [dy, setDy] = useState(0);
  const bind = {
    onPointerDown: (e: React.PointerEvent) => {
      start.current = e.clientY;
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (start.current !== null) setDy(e.clientY - start.current);
    },
    onPointerUp: (e: React.PointerEvent) => {
      if (start.current === null) return;
      const d = e.clientY - start.current;
      start.current = null;
      setDy(0);
      onEnd(d);
    },
    onPointerCancel: () => {
      start.current = null;
      setDy(0);
    },
  };
  return { dy, dragging: start.current !== null, bind };
}

export function Sheet(p: { label: string; modal?: boolean; onClose: () => void; onExpand?: () => void; children: ReactNode; head: ReactNode }) {
  const { dy, dragging, bind } = useDrag((d) => {
    if (d > 70) p.onClose();
    else if (d < -40) p.onExpand?.();
  });
  // Pulling up only gives a little: the sheet itself does not travel past its content.
  const shift = dy > 0 ? dy : dy / 4;
  return (
    <>
      {p.modal && <div className="m-scrim" onClick={p.onClose} />}
      <section
        className={"m-sheet" + (p.modal ? " modal" : "") + (dragging ? " dragging" : "")}
        role="dialog"
        aria-modal={p.modal ? true : undefined}
        aria-label={p.label}
        style={{ transform: `translateY(${shift}px)` }}
      >
        <div className="m-grip" {...bind}>
          <span />
        </div>
        <div className="m-sheet-head" {...bind}>
          {p.head}
        </div>
        <div className="m-sheet-body">{p.children}</div>
      </section>
    </>
  );
}

// The selected file or folder: what it is, how much it weighs, what can be done with it.
export function ItemSheet(p: {
  disk: Disk;
  id: number;
  fmt: Fmt;
  t: T;
  onClose: () => void;
  onOpen: (id: number) => void;
  onCopy: (path: string) => void;
  onTrash?: () => void;
}) {
  const { disk, id, fmt, t } = p;
  const [more, setMore] = useState(false);
  const [stat, setStat] = useState<ItemStat | null>(null);
  const dir = disk.isDir(id);
  const parent = disk.parent(id);
  const share = parent >= 0 ? disk.size(id) / (disk.size(parent) || 1) : 1;

  useEffect(() => {
    setMore(false);
    setStat(null);
  }, [id]);
  useEffect(() => {
    if (more && !stat) void window.api.stat(disk.path(id)).then(setStat);
  }, [more, stat, disk, id]);

  return (
    <Sheet
      label={disk.name(id)}
      onClose={p.onClose}
      onExpand={() => setMore(true)}
      head={
        <>
          <Icon name={dir ? "folder" : "file"} size={24} className="glyph" />
          <span className="m-sheet-title">
            <strong>{id === 0 ? disk.t.root : disk.name(id)}</strong>
            <span>
              {fmt.bytes(disk.size(id))} · {t("m.ofFolder", { pct: fmt.pct(share) })}
              {dir ? " · " + files(disk.files(id), fmt, t) : ""}
            </span>
          </span>
        </>
      }
    >
      <div className="m-sheet-actions">
        {dir && disk.children(id).length > 0 && (
          <button className="btn primary" onClick={() => p.onOpen(id)}>
            <Icon name="enter" />
            {t("act.zoom")}
          </button>
        )}
        <button className="btn" onClick={() => p.onCopy(disk.path(id))}>
          <Icon name="copy" />
          {t("act.copyPath")}
        </button>
        <button className="btn" aria-expanded={more} onClick={() => setMore((m) => !m)}>
          <Icon name="info" />
          {t("act.details")}
        </button>
        {p.onTrash && id > 0 && (
          <button className="btn danger" onClick={p.onTrash}>
            <Icon name="trash" />
            {t("act.delete")}
          </button>
        )}
      </div>
      {more && (
        <dl className="props">
          {id > 0 && (
            <>
              <dt>{t("props.location")}</dt>
              <dd>{disk.path(parent)}</dd>
            </>
          )}
          <dt>{t("props.kind")}</dt>
          <dd>{disk.isLink(id) ? t("props.link") : dir ? t("props.folder") : t("props.file") + (disk.ext(id) ? " ." + disk.ext(id) : "")}</dd>
          <dt>{t("props.onDisk")}</dt>
          <dd>{t("props.bytes", { count: fmt.count(disk.size(id)) })}</dd>
          <dt>{t("props.length")}</dt>
          <dd>{t("props.bytes", { count: fmt.count(disk.logical(id)) })}</dd>
          {id > 0 && (
            <>
              <dt>{t("props.ofScan")}</dt>
              <dd>{fmt.pct(disk.size(id) / (disk.size(0) || 1))}</dd>
            </>
          )}
          {stat?.ok && (
            <>
              <dt>{t("props.modified")}</dt>
              <dd>{fmt.stamp(stat.modified)}</dd>
              <dt>{t("props.created")}</dt>
              <dd>{fmt.stamp(stat.created)}</dd>
            </>
          )}
        </dl>
      )}
    </Sheet>
  );
}

export interface Choice<V> {
  value: V;
  label: string;
}

function Chips<V extends string | number>(p: { label: string; value: V; choices: Choice<V>[]; onPick: (v: V) => void }) {
  return (
    <div className="m-group" role="radiogroup" aria-label={p.label}>
      <h2>{p.label}</h2>
      <div className="m-chips">
        {p.choices.map((c) => (
          <button key={String(c.value)} role="radio" aria-checked={c.value === p.value} className="m-chip" onClick={() => p.onPick(c.value)}>
            {c.value === p.value && <Icon name="check" size={16} />}
            {c.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export interface SettingsProps<F, M, L> {
  t: T;
  version: string;
  family: F;
  families: Choice<F>[];
  onFamily: (v: F) => void;
  mode: M;
  modes: Choice<M>[];
  onMode: (v: M) => void;
  levels: number;
  levelChoices: Choice<number>[];
  onLevels: (v: number) => void;
  lang: L;
  langs: Choice<L>[];
  onLang: (v: L) => void;
  onRescan?: () => void;
  onDrives?: () => void;
  // Drawn only when a website is configured, the rule the desktop Help menu
  // follows: an entry that opens nothing is worse than no entry.
  onSite?: () => void;
  onSource: () => void;
  onSupport: () => void;
  // Shown as the contact address, and what the support button writes to.
  contact: string;
  onClose: () => void;
}

// Everything that used to sit in the desktop menus, as one sheet.
export function SettingsSheet<F extends string, M extends string, L extends string>(p: SettingsProps<F, M, L>) {
  const { t } = p;
  const act = (run: () => void) => () => {
    p.onClose();
    run();
  };
  return (
    <Sheet modal label={t("m.settings")} onClose={p.onClose} head={<strong className="m-sheet-heading">{t("m.settings")}</strong>}>
      {(p.onRescan || p.onDrives) && (
        <div className="m-list">
          {p.onRescan && (
            <button onClick={act(p.onRescan)}>
              <Icon name="rescan" size={20} />
              {t("menu.rescan")}
            </button>
          )}
          {p.onDrives && (
            <button onClick={act(p.onDrives)}>
              <Icon name="drive" size={20} />
              {t("m.other")}
            </button>
          )}
        </div>
      )}
      <Chips label={t("menu.theme")} value={p.family} choices={p.families} onPick={p.onFamily} />
      <Chips label={t("menu.mode")} value={p.mode} choices={p.modes} onPick={p.onMode} />
      <Chips label={t("menu.levels")} value={p.levels} choices={p.levelChoices} onPick={p.onLevels} />
      <Chips label={t("menu.language")} value={p.lang} choices={p.langs} onPick={p.onLang} />
      <div className="m-list">
        {p.onSite && (
          <button onClick={act(p.onSite)}>
            <Icon name="reveal" size={20} />
            {t("menu.website")}
          </button>
        )}
        <button onClick={act(p.onSource)}>
          <Icon name="reveal" size={20} />
          {t("menu.source")}
        </button>
        <button onClick={act(p.onSupport)}>
          <Icon name="info" size={20} />
          {t("menu.support")}
        </button>
      </div>
      <p className="m-about">
        <BrandTitle />
        <span>
          {t("about.line", { version: p.version })}
          <br />
          {t("about.contact")}{" "}
          <a
            href={"mailto:" + p.contact}
            onClick={(e) => {
              e.preventDefault();
              p.onSupport();
            }}
          >
            {p.contact}
          </a>
        </span>
      </p>
    </Sheet>
  );
}
