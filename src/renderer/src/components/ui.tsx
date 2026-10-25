import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { Icon } from "./Icon";
import type { IconName } from "./Icon";

// Rows are sized for a mouse on the desktop and for a finger on Android.
export const ROW = window.api.can.windows ? 26 : 44;

// Fixed height rows, only the visible ones mounted.
export function VirtualRows(props: {
  count: number;
  render: (index: number, top: number) => ReactNode;
  reveal?: { index: number; tick: number };
  onKeyDown?: (e: ReactKeyboardEvent<HTMLDivElement>) => void;
  onLeave?: () => void;
  label: string;
  rowHeight?: number;
}) {
  const R = props.rowHeight ?? ROW;
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  const [height, setHeight] = useState(400);

  useLayoutEffect(() => {
    const el = ref.current!;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const tick = props.reveal?.tick;
  useLayoutEffect(() => {
    const el = ref.current;
    const index = props.reveal?.index ?? -1;
    if (!el || index < 0) return;
    const y = index * R;
    if (y < el.scrollTop) el.scrollTop = Math.max(0, y - R * 2);
    else if (y + R > el.scrollTop + el.clientHeight) el.scrollTop = y - el.clientHeight + R * 3;
    // Only when asked to reveal, not on every index change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);

  const first = Math.max(0, Math.floor(top / R) - 6);
  const last = Math.min(props.count, Math.ceil((top + height) / R) + 6);
  const rows: ReactNode[] = [];
  for (let i = first; i < last; i++) rows.push(props.render(i, i * R));

  return (
    <div
      ref={ref}
      className="rows"
      tabIndex={0}
      role="grid"
      aria-label={props.label}
      aria-rowcount={props.count}
      onScroll={(e) => setTop(e.currentTarget.scrollTop)}
      onKeyDown={props.onKeyDown}
      onMouseLeave={props.onLeave}
    >
      <div style={{ height: props.count * R }} />
      {rows}
    </div>
  );
}

export type MenuEntry =
  | { kind?: "item"; label: string; icon?: IconName; keys?: string; checked?: boolean; danger?: boolean; disabled?: boolean; run: () => void }
  | { kind: "sep" }
  | { kind: "title"; label: string };

// A square drop menu, used by the menu bar and by right click.
//
// It never takes keyboard focus. The highlighted row is its own state and the
// keys are read from the window while it is open, so a click on the bar or on
// the page cannot leave it open with the keyboard pointing somewhere else.
export function Menu(props: {
  x: number;
  y: number;
  items: MenuEntry[];
  onClose: () => void;
  onSide?: (dir: -1 | 1) => void; // left and right arrows, for the menu bar
  first?: boolean; // opened from the keyboard: start on the first row
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: props.x, y: props.y });
  const usable = props.items.map((it, i) => (it.kind === undefined || it.kind === "item" ? (it.disabled ? -1 : i) : -1)).filter((i) => i >= 0);
  const [active, setActive] = useState(-1);
  const live = useRef({ props, active, usable });
  live.current = { props, active, usable };

  useLayoutEffect(() => {
    const r = ref.current!.getBoundingClientRect();
    setPos({
      x: Math.max(4, Math.min(props.x, window.innerWidth - r.width - 4)),
      y: Math.max(4, Math.min(props.y, window.innerHeight - r.height - 4)),
    });
    setActive(props.first ? (live.current.usable[0] ?? -1) : -1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.x, props.y, props.items]);

  useEffect(() => {
    const down = (e: MouseEvent): void => {
      const target = e.target as HTMLElement;
      if (ref.current?.contains(target)) return;
      // The bar button that opened this menu closes it itself.
      if (target.closest?.("[data-menu-owner]")) return;
      live.current.props.onClose();
    };
    const close = (): void => live.current.props.onClose();
    const key = (e: KeyboardEvent): void => {
      const { props: p, active: at, usable: rows } = live.current;
      const move = (to: number): void => setActive(rows[(to + rows.length) % rows.length] ?? -1);
      const here = rows.indexOf(at);
      switch (e.key) {
        case "Escape":
          p.onClose();
          break;
        case "ArrowDown":
          move(here + 1);
          break;
        case "ArrowUp":
          move(here === -1 ? rows.length - 1 : here - 1);
          break;
        case "Home":
          move(0);
          break;
        case "End":
          move(rows.length - 1);
          break;
        case "ArrowLeft":
        case "ArrowRight":
          if (!p.onSide) return;
          p.onSide(e.key === "ArrowLeft" ? -1 : 1);
          break;
        case "Enter":
        case " ": {
          const it = p.items[at];
          if (!it || (it.kind !== undefined && it.kind !== "item")) return;
          p.onClose();
          it.run();
          break;
        }
        case "Tab":
          break; // swallowed: focus stays where it was
        default:
          return;
      }
      // While a menu is open its keys belong to it and to nothing else.
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener("mousedown", down, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("mousedown", down, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, []);

  return (
    <div ref={ref} className="menu" role="menu" style={{ left: pos.x, top: pos.y }} onMouseLeave={() => setActive(-1)}>
      {props.items.map((it, i) => {
        if (it.kind === "sep") return <div key={i} className="menu-sep" role="separator" />;
        if (it.kind === "title")
          return (
            <div key={i} className="menu-title">
              {it.label}
            </div>
          );
        return (
          <button
            key={i}
            role="menuitem"
            tabIndex={-1}
            className={"menu-item" + (it.danger ? " danger" : "") + (i === active ? " active" : "")}
            disabled={it.disabled}
            onMouseEnter={() => setActive(it.disabled ? -1 : i)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              props.onClose();
              it.run();
            }}
          >
            <span className="mark">{it.checked ? <Icon name="dot" /> : it.icon ? <Icon name={it.icon} /> : null}</span>
            <span className="label">{it.label}</span>
            {it.keys && <kbd>{it.keys}</kbd>}
          </button>
        );
      })}
    </div>
  );
}
