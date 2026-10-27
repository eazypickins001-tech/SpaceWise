import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { Disk } from "../lib/disk";
import type { Fmt, T } from "../lib/i18n";
import { Icon } from "./Icon";
import { VirtualRows } from "./ui";

type SortCol = "size" | "name" | "files" | "modified";

interface Props {
  disk: Disk;
  version: number;
  selected: number;
  hover: number;
  expanded: Set<number>;
  reveal: number;
  fresh: Set<number>;
  wide: boolean;
  fmt: Fmt;
  t: T;
  onToggle: (id: number, open?: boolean) => void;
  onSelect: (id: number) => void;
  onHover: (id: number) => void;
  onZoom: (id: number) => void;
  onContext: (id: number, x: number, y: number) => void;
  onTrash?: (ids: number[]) => void;
}

const PICK = "30px";
const NARROW = PICK + " minmax(0, 1fr) 74px 104px 64px";
const WIDE = NARROW + " 88px";

export const TreeView = memo(function TreeView(p: Props) {
  const { disk, expanded, fmt, t } = p;
  const GRID = p.wide ? WIDE : NARROW;
  const [sort, setSort] = useState<{ col: SortCol; asc: boolean }>({ col: "size", asc: false });
  const cache = useRef(new Map<number, Int32Array>());

  const { ids, depths } = useMemo(() => {
    cache.current.clear();
    const tb = disk.t;
    const kids = (dir: number): Int32Array => {
      const base = disk.children(dir);
      if (sort.col === "size" && !sort.asc) return base;
      let sorted = cache.current.get(dir);
      if (!sorted) {
        sorted = base.slice();
        const sign = sort.asc ? 1 : -1;
        if (sort.col === "name") {
          const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
          const names = new Map<number, string>();
          for (const id of sorted) names.set(id, disk.name(id));
          sorted.sort((a, b) => sign * collator.compare(names.get(a)!, names.get(b)!));
        } else {
          const col = sort.col === "size" ? tb.size : sort.col === "files" ? tb.files : tb.mtime;
          sorted.sort((a, b) => sign * (col[a] - col[b]) || a - b);
        }
        cache.current.set(dir, sorted);
      }
      return sorted;
    };
    const ids: number[] = [];
    const depths: number[] = [];
    const walk = (id: number, depth: number): void => {
      ids.push(id);
      depths.push(depth);
      if (disk.isDir(id) && expanded.has(id)) for (const c of kids(id)) walk(c, depth + 1);
    };
    walk(0, 0);
    return { ids, depths };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disk, p.version, expanded, sort]);

  // Which rows are ticked for a bulk delete. Nothing is ticked to begin with,
  // the root is never offered, and whatever leaves the disk leaves the
  // selection with it.
  const [picked, setPicked] = useState<Set<number>>(() => new Set());
  useEffect(
    () =>
      setPicked((c) => {
        const next = new Set([...c].filter((id) => id > 0 && !disk.isGone(id)));
        return next.size === c.size ? c : next;
      }),
    [disk, p.version],
  );
  const deletable = useMemo(() => ids.filter((id) => id > 0), [ids]);
  const pickedBytes = [...picked].reduce((sum, id) => sum + disk.size(id), 0);
  const allPicked = deletable.length > 0 && deletable.every((id) => picked.has(id));
  const togglePick = (id: number): void =>
    setPicked((c) => {
      const next = new Set(c);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const pickAll = (): void => setPicked(new Set(deletable));
  const trashPicked = (): void => {
    if (picked.size > 0) p.onTrash?.([...picked]);
  };

  const revealIndex = useMemo(
    () => (p.reveal > 0 ? ids.indexOf(p.selected) : -1),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [p.reveal, ids],
  );
  const [keyTick, setKeyTick] = useState(0);
  const keyIndex = useRef(-1);

  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const at = ids.indexOf(p.selected);
    const go = (i: number): void => {
      const next = Math.max(0, Math.min(ids.length - 1, i));
      p.onSelect(ids[next]);
      keyIndex.current = next;
      setKeyTick((n) => n + 1);
    };
    const id = p.selected;
    switch (e.key) {
      case "ArrowDown":
        go(at + 1);
        break;
      case "ArrowUp":
        go(at - 1);
        break;
      case "PageDown":
        go(at + 15);
        break;
      case "PageUp":
        go(at - 15);
        break;
      case "Home":
        go(0);
        break;
      case "End":
        go(ids.length - 1);
        break;
      case "ArrowRight":
        if (id >= 0 && disk.isDir(id)) {
          if (!expanded.has(id)) p.onToggle(id, true);
          else go(at + 1);
        }
        break;
      case "ArrowLeft":
        if (id >= 0 && disk.isDir(id) && expanded.has(id)) p.onToggle(id, false);
        else if (id > 0) go(ids.indexOf(disk.parent(id)));
        break;
      case "Enter":
        if (id >= 0) p.onZoom(disk.isDir(id) ? id : disk.parent(id));
        break;
      case "Delete":
        if (picked.size > 0) p.onTrash?.([...picked]);
        else if (id > 0) p.onTrash?.([id]);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const head = (col: SortCol, label: string, num: boolean) => (
    <button
      className={(num ? "num " : "") + (sort.col === col ? "sorted" : "")}
      onClick={() => setSort((s) => ({ col, asc: s.col === col ? !s.asc : col === "name" }))}
    >
      {label}
      {sort.col === col && <Icon name={sort.asc ? "sortUp" : "sortDown"} size={12} />}
    </button>
  );

  return (
    <div className="pane">
      <div className="pane-bar">
        <button className="btn quiet" onClick={pickAll} disabled={deletable.length === 0 || allPicked}>
          {t("cleanup.selectAll")}
        </button>
        <span className="dim" style={{ marginLeft: "auto", marginRight: 8 }}>
          {t("cleanup.selected", { count: fmt.count(picked.size), bytes: fmt.bytes(pickedBytes) })}
        </span>
        <button className="btn" disabled={picked.size === 0 || !p.onTrash} onClick={trashPicked}>
          <Icon name="trash" />
          {t("act.trash")}
        </button>
      </div>
      <div className="thead" style={{ gridTemplateColumns: GRID }}>
        <button disabled style={{ cursor: "default" }} aria-hidden="true" />
        {head("name", t("col.name"), false)}
        {head("size", t("col.size"), true)}
        <button disabled style={{ cursor: "default" }}>
          {t("col.share")}
        </button>
        {head("files", t("col.files"), true)}
        {p.wide && head("modified", t("col.modified"), true)}
      </div>
      <VirtualRows
        count={ids.length}
        label={t("tab.tree")}
        reveal={
          keyTick > 0 && keyIndex.current >= 0 && keyIndex.current < ids.length && ids[keyIndex.current] === p.selected
            ? { index: keyIndex.current, tick: p.reveal * 100000 + keyTick }
            : { index: revealIndex, tick: p.reveal * 100000 + keyTick }
        }
        onKeyDown={onKey}
        onLeave={() => p.onHover(-1)}
        render={(i, top) => {
          const id = ids[i];
          const dir = disk.isDir(id);
          const parent = disk.parent(id);
          const share = parent >= 0 && disk.size(parent) > 0 ? disk.size(id) / disk.size(parent) : 1;
          const open = dir && expanded.has(id);
          return (
            <div
              key={id}
              role="row"
              aria-selected={id === p.selected}
              className={"trow" + (id === p.selected ? " sel" : id === p.hover ? " hot" : "") + (p.fresh.has(id) ? " new" : "")}
              style={{ top, gridTemplateColumns: GRID }}
              onMouseEnter={() => p.onHover(id)}
              onMouseDown={() => p.onSelect(id)}
              onDoubleClick={() => (dir ? p.onZoom(id) : p.onZoom(parent))}
              onContextMenu={(e) => {
                e.preventDefault();
                p.onSelect(id);
                p.onContext(id, e.clientX, e.clientY);
              }}
            >
              <div className="pick">
                {id > 0 && (
                  <input
                    type="checkbox"
                    checked={picked.has(id)}
                    aria-label={disk.name(id)}
                    onMouseDown={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => e.stopPropagation()}
                    onChange={() => togglePick(id)}
                  />
                )}
              </div>
              <div className="cell-name" style={{ paddingLeft: depths[i] * 14 }}>
                {dir && disk.children(id).length > 0 ? (
                  <button
                    className={"twist" + (open ? " open" : "")}
                    tabIndex={-1}
                    aria-label={disk.name(id)}
                    aria-expanded={open}
                    onMouseDown={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => e.stopPropagation()}
                    onClick={() => p.onToggle(id)}
                  >
                    <Icon name="chevron" size={12} />
                  </button>
                ) : (
                  <span className="twist" />
                )}
                <Icon name={dir ? "folder" : "file"} className="glyph" />
                <span className="text">{id === 0 ? disk.t.root : disk.name(id)}</span>
                {disk.isLink(id) && <Icon name="link" size={12} className="flag" />}
                {disk.hasError(id) && <Icon name="warn" size={12} className="flag" />}
              </div>
              <div className="num">{fmt.bytes(disk.size(id))}</div>
              <div className="share">
                <span className="track">
                  <span className="fill" style={{ width: Math.max(share * 100, share > 0 ? 2 : 0) + "%", display: "block" }} />
                </span>
                <span className="pct">{fmt.pct(share)}</span>
              </div>
              <div className="num dim">{dir ? fmt.count(disk.files(id)) : ""}</div>
              {p.wide && <div className="num dim">{fmt.date(disk.t.mtime[id])}</div>}
            </div>
          );
        }}
      />
    </div>
  );
});
