// What only the phone build has: cleaning suggestions in the style of
// Android's storage settings, and the list of installed apps.
import { useEffect, useMemo, useState } from "react";
import type { AppEntry } from "../../../shared/types";
import type { Disk } from "../lib/disk";
import type { Fmt, T } from "../lib/i18n";
import { cleanGroups, daysSince } from "../lib/phone";
import type { CleanKey } from "../lib/phone";
import { Icon } from "./Icon";
import type { IconName } from "./Icon";
import { Sheet, files } from "./Mobile";
import { VirtualRows } from "./ui";

const ICON: Record<CleanKey, IconName> = {
  large: "file",
  oldDownloads: "download",
  apks: "box",
  screenshots: "image",
  messaging: "chat",
  trashed: "trash",
};
const IMAGE = new Set(["jpg", "jpeg", "png", "webp", "gif", "bmp"]);
const MONTH = 30 * 86400000;

// An app nobody has opened for a month, that has been there for longer than that.
export function unused(a: AppEntry, now = Date.now()): boolean {
  if (a.system || now - a.installed < MONTH) return false;
  const d = daysSince(a.lastUsed, now);
  return d === null || d >= 30;
}

export function appTotal(a: AppEntry): number {
  return a.appBytes + a.dataBytes + a.cacheBytes;
}

export function lastUse(a: AppEntry, t: T): string {
  const d = daysSince(a.lastUsed);
  if (d === null) return t("apps.usedNever");
  if (d === 0) return t("apps.usedToday");
  if (d === 1) return t("apps.usedYesterday");
  if (d > 365) return t("apps.usedLong");
  return t("apps.usedDays", { count: d });
}

// A trashed file keeps its name behind a ".trashed-<time>-" prefix.
function shownName(name: string): string {
  return name.replace(/^\.trashed-\d+-/, "");
}

// Clean up -----------------------------------------------------------------

function Suggestion(p: { icon: IconName; title: string; hint: string; size?: string; action?: { label: string; run: () => void }; onOpen?: () => void }) {
  return (
    <div className={"m-suggest" + (p.onOpen ? " opens" : "")} role={p.onOpen ? "button" : undefined} onClick={p.onOpen}>
      <Icon name={p.icon} size={22} className="glyph" />
      <span className="m-row-text">
        <span className="name">{p.title}</span>
        <span className="meta">{p.hint}</span>
      </span>
      {p.size && <span className="m-row-size">{p.size}</span>}
      {p.action ? (
        <button
          className="btn"
          onClick={(e) => {
            e.stopPropagation();
            p.action!.run();
          }}
        >
          {p.action.label}
        </button>
      ) : (
        <span className="m-row-go">{p.onOpen && <Icon name="chevron" size={16} />}</span>
      )}
    </div>
  );
}

export function CleanPane(p: {
  disk: Disk;
  version: number;
  fmt: Fmt;
  t: T;
  open: CleanKey | null;
  onOpen: (k: CleanKey | null) => void;
  apps: AppEntry[] | null;
  usage: boolean | null;
  onRequestUsage: () => void;
  onClearCaches: () => void;
  onDupes: () => void;
  onUnusedApps: () => void;
  onTrash: (ids: number[]) => void;
}) {
  const { disk, fmt, t } = p;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const found = useMemo(() => cleanGroups(disk), [disk, p.version]);
  const group = p.open ? found.groups.find((g) => g.key === p.open) : undefined;
  // A category whose last file went away closes by itself.
  const { open, onOpen } = p;
  useEffect(() => {
    if (open && !group) onOpen(null);
  }, [open, group, onOpen]);

  if (p.open && group) return <CleanList {...p} kind={p.open} ids={group.ids} />;

  const cache = p.apps ? p.apps.reduce((a, x) => a + x.cacheBytes, 0) : 0;
  const idle = p.apps ? p.apps.filter((a) => unused(a)) : [];
  return (
    <div className="pane m-scroll">
      <div className="pane-note">
        {found.bytes > 0 ? <strong>{t("clean.lead", { bytes: fmt.bytes(found.bytes) })}</strong> : t("clean.none")}
      </div>
      {found.groups.map((g) => (
        <Suggestion
          key={g.key}
          icon={ICON[g.key]}
          title={t(`clean.${g.key}`)}
          hint={files(g.ids.length, fmt, t) + " · " + t(`clean.${g.key}.hint`)}
          size={fmt.bytes(g.bytes)}
          onOpen={() => p.onOpen(g.key)}
        />
      ))}
      <Suggestion icon="copy" title={t("clean.dupes")} hint={t("clean.dupes.hint")} action={{ label: t("clean.search"), run: p.onDupes }} />
      {p.usage === false && (
        <Suggestion icon="grid" title={t("clean.usage")} hint={t("clean.usage.hint")} action={{ label: t("clean.allow"), run: p.onRequestUsage }} />
      )}
      {p.usage && cache > 0 && (
        <Suggestion
          icon="layers"
          title={t("clean.cache")}
          hint={t("clean.cache.hint")}
          size={fmt.bytes(cache)}
          action={{ label: t("clean.free"), run: p.onClearCaches }}
        />
      )}
      {p.usage && idle.length > 0 && (
        <Suggestion
          icon="grid"
          title={t("clean.unused")}
          hint={t("clean.unused.hint", { count: idle.length })}
          size={fmt.bytes(idle.reduce((a, x) => a + appTotal(x), 0))}
          onOpen={p.onUnusedApps}
        />
      )}
    </div>
  );
}

type Order = "size" | "oldest" | "name";
const ROW_H = 64;

function CleanList(p: {
  disk: Disk;
  version: number;
  fmt: Fmt;
  t: T;
  kind: CleanKey;
  ids: number[];
  onOpen: (k: CleanKey | null) => void;
  onTrash: (ids: number[]) => void;
}) {
  const { disk, fmt, t } = p;
  const [order, setOrder] = useState<Order>("size");
  const [chosen, setChosen] = useState<Set<number>>(() => new Set());
  // Whatever left the disk leaves the selection too.
  useEffect(() => setChosen((c) => new Set([...c].filter((id) => !disk.isGone(id)))), [disk, p.version]);

  const ids = useMemo(() => {
    const list = p.ids.filter((id) => !disk.isGone(id));
    if (order === "oldest") list.sort((a, b) => disk.t.mtime[a] - disk.t.mtime[b]);
    else if (order === "name") {
      const c = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
      list.sort((a, b) => c.compare(shownName(disk.name(a)), shownName(disk.name(b))));
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.ids, order, disk, p.version]);
  const bytes = [...chosen].reduce((a, id) => a + disk.size(id), 0);
  const all = ids.length > 0 && chosen.size === ids.length;
  const toggle = (id: number): void =>
    setChosen((c) => {
      const next = new Set(c);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const erase = p.kind === "trashed";

  return (
    <div className="pane">
      <div className="m-subbar">
        <button className="m-icon" aria-label={t("menu.back")} title={t("menu.back")} onClick={() => p.onOpen(null)}>
          <Icon name="back" size={22} />
        </button>
        <strong>{t(`clean.${p.kind}`)}</strong>
        <select className="select" aria-label={t("clutter.sort")} value={order} onChange={(e) => setOrder(e.target.value as Order)}>
          <option value="size">{t("sort.size")}</option>
          <option value="oldest">{t("sort.oldest")}</option>
          <option value="name">{t("sort.name")}</option>
        </select>
      </div>
      <label className="m-all">
        <input type="checkbox" checked={all} onChange={() => setChosen(all ? new Set() : new Set(ids))} />
        <span>{t("clean.selectAll")}</span>
        <span className="meta">{chosen.size > 0 ? t("clean.selected", { count: fmt.count(chosen.size), bytes: fmt.bytes(bytes) }) : files(ids.length, fmt, t)}</span>
      </label>
      <VirtualRows
        count={ids.length}
        label={t(`clean.${p.kind}`)}
        rowHeight={ROW_H}
        render={(i, top) => {
          const id = ids[i];
          const on = chosen.has(id);
          const ext = disk.ext(id);
          const parent = disk.parent(id);
          return (
            <label key={id} className={"m-row m-pick" + (on ? " sel" : "")} style={{ top, height: ROW_H }}>
              <input type="checkbox" checked={on} onChange={() => toggle(id)} />
              {IMAGE.has(ext) && window.api.phone ? (
                <img className="m-thumb" src={window.api.phone.thumb(disk.path(id))} alt="" loading="lazy" decoding="async" />
              ) : (
                <span className="m-thumb">
                  <Icon name={p.kind === "apks" ? "box" : "file"} size={22} />
                </span>
              )}
              <span className="m-row-text">
                <span className="name">{shownName(disk.name(id))}</span>
                <span className="meta">
                  {fmt.date(disk.t.mtime[id])}
                  {parent > 0 ? " · " + disk.name(parent) : ""}
                </span>
              </span>
              <span className="m-row-size">{fmt.bytes(disk.size(id))}</span>
            </label>
          );
        }}
      />
      <div className="m-actbar">
        {!erase && (
          <button className="btn primary" disabled={chosen.size === 0} onClick={() => p.onTrash([...chosen])}>
            <Icon name="trash" />
            {t("clean.toTrash")}
            {chosen.size > 0 && <span className="m-actsize">{fmt.bytes(bytes)}</span>}
          </button>
        )}
        {erase && (
          <button className="btn danger" disabled={chosen.size === 0} onClick={() => p.onTrash([...chosen])}>
            <Icon name="trash" />
            {t("clean.erase")}
            {chosen.size > 0 && <span className="m-actsize">{fmt.bytes(bytes)}</span>}
          </button>
        )}
      </div>
    </div>
  );
}

// Apps ---------------------------------------------------------------------

type AppOrder = "size" | "unused" | "name";

export function AppsPane(p: {
  apps: AppEntry[] | null;
  usage: boolean | null;
  fmt: Fmt;
  t: T;
  idleOnly: boolean;
  onIdleOnly: (v: boolean) => void;
  onRequestUsage: () => void;
  onSelect: (a: AppEntry) => void;
}) {
  const { fmt, t } = p;
  const [order, setOrder] = useState<AppOrder>("size");
  const list = useMemo(() => {
    const all = (p.apps ?? []).filter((a) => !p.idleOnly || unused(a));
    if (order === "size") all.sort((a, b) => appTotal(b) - appTotal(a));
    else if (order === "unused") all.sort((a, b) => (a.lastUsed || 0) - (b.lastUsed || 0));
    else {
      const c = new Intl.Collator(undefined, { sensitivity: "base" });
      all.sort((a, b) => c.compare(a.label, b.label));
    }
    return all;
  }, [p.apps, p.idleOnly, order]);

  if (p.usage === false)
    return (
      <div className="pane m-scroll">
        <div className="m-ask">
          <h2>{t("apps.needTitle")}</h2>
          <p>{t("apps.needLead")}</p>
          <button className="btn primary" onClick={p.onRequestUsage}>
            <Icon name="grid" />
            {t("apps.allow")}
          </button>
        </div>
      </div>
    );
  if (!p.apps) return <div className="pane" />;

  return (
    <div className="pane">
      <div className="m-subbar m-subbar-wrap">
        <span className="m-lead">{t("apps.lead", { count: fmt.count(list.length), bytes: fmt.bytes(list.reduce((a, x) => a + appTotal(x), 0)) })}</span>
        <button className="m-chip" role="switch" aria-checked={p.idleOnly} onClick={() => p.onIdleOnly(!p.idleOnly)}>
          {p.idleOnly && <Icon name="check" size={16} />}
          {t("apps.unusedOnly")}
        </button>
        <select className="select" aria-label={t("clutter.sort")} value={order} onChange={(e) => setOrder(e.target.value as AppOrder)}>
          <option value="size">{t("sort.size")}</option>
          <option value="unused">{t("apps.sortUnused")}</option>
          <option value="name">{t("sort.name")}</option>
        </select>
      </div>
      {list.length === 0 ? (
        <div className="pane-empty">{t("apps.none")}</div>
      ) : (
        <VirtualRows
          count={list.length}
          label={t("tab.apps")}
          rowHeight={ROW_H}
          render={(i, top) => {
            const a = list[i];
            return (
              <div key={a.pkg} role="row" className="m-row m-app" style={{ top, height: ROW_H }} onClick={() => p.onSelect(a)}>
                <img className="m-appicon" src={a.icon} alt="" />
                <span className="m-row-text">
                  <span className="name">{a.label}</span>
                  <span className="meta">{lastUse(a, t)}</span>
                </span>
                <span className="m-row-size">{fmt.bytes(appTotal(a))}</span>
                <span className="m-row-go">
                  <Icon name="chevron" size={16} />
                </span>
              </div>
            );
          }}
        />
      )}
    </div>
  );
}

export function AppSheet(p: { app: AppEntry; fmt: Fmt; t: T; onClose: () => void }) {
  const { app: a, fmt, t } = p;
  const phone = window.api.phone!;
  return (
    <Sheet
      label={a.label}
      onClose={p.onClose}
      head={
        <>
          <img className="m-appicon" src={a.icon} alt="" />
          <span className="m-sheet-title">
            <strong>{a.label}</strong>
            <span>
              {fmt.bytes(appTotal(a))} · {lastUse(a, t)}
            </span>
          </span>
        </>
      }
    >
      <div className="m-sheet-actions">
        {!a.system && (
          <button className="btn danger" onClick={() => void phone.uninstall(a.pkg)}>
            <Icon name="trash" />
            {t("apps.uninstall")}
          </button>
        )}
        <button className="btn" onClick={() => void phone.appInfo(a.pkg)}>
          <Icon name="info" />
          {t("apps.info")}
        </button>
      </div>
      {a.system && <p className="m-note">{t("apps.system")}</p>}
      <dl className="props">
        <dt>{t("apps.app")}</dt>
        <dd>{fmt.bytes(a.appBytes)}</dd>
        <dt>{t("apps.data")}</dt>
        <dd>{fmt.bytes(a.dataBytes)}</dd>
        <dt>{t("apps.cache")}</dt>
        <dd>{fmt.bytes(a.cacheBytes)}</dd>
        <dt>{t("apps.total")}</dt>
        <dd>{fmt.bytes(appTotal(a))}</dd>
        <dt>{t("apps.installed")}</dt>
        <dd>{fmt.date(Math.floor(a.installed / 1000))}</dd>
      </dl>
    </Sheet>
  );
}
