import type { ReactNode } from "react";

// SpaceWise's own icon set. 16px grid, 1.5px strokes, square caps and mitred
// joins, right angles wherever the shape allows it.
const paths: Record<string, ReactNode> = {
  folder: <path d="M1.75 3.75h4.5v2h8v7.5H1.75z" />,
  file: <path d="M3.75 1.75h5.5v3h3v9.5h-8.5z" />,
  drive: (
    <>
      <path d="M1.75 4.75h12.5v6.5H1.75z" />
      <path d="M10.75 7.25h1.5v1.5h-1.5z" fill="currentColor" stroke="none" />
    </>
  ),
  chevron: <path d="M6 3.5 10.5 8 6 12.5" />,
  sun: <path d="M5.75 5.75h4.5v4.5h-4.5zM8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.5 1.5M11.5 11.5 13 13M13 3l-1.5 1.5M4.5 11.5 3 13" />,
  back: <path d="M9.5 3.5 5 8l4.5 4.5M5 8h8.5" />,
  forward: <path d="M6.5 3.5 11 8l-4.5 4.5M11 8H2.5" />,
  scan: (
    <>
      <path d="M1.75 5.5V1.75H5.5M10.5 1.75h3.75V5.5M14.25 10.5v3.75H10.5M5.5 14.25H1.75V10.5" />
      <path d="M6 6h4v4H6z" fill="currentColor" stroke="none" />
    </>
  ),
  rescan: <path d="M13.25 7.5v5.75H2.75V2.75h7M7.75.5 10 2.75 7.75 5" />,
  stop: <path d="M4 4h8v8H4z" fill="currentColor" stroke="none" />,
  search: <path d="M2.75 2.75h7.5v7.5h-7.5zM10.25 10.25l3.5 3.5" />,
  close: <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />,
  trash: <path d="M2.25 4.25h11.5M6 4.25v-2.5h4v2.5M3.75 4.25v10h8.5v-10M6.75 7v4.5M9.25 7v4.5" />,
  reveal: <path d="M9.25 2.75h4v4M13.25 2.75 7.5 8.5M11 9.75v3.5H2.75V5h3.5" />,
  copy: <path d="M5.75 5.75h7.5v7.5h-7.5zM10.25 5.5V2.75h-7.5v7.5H5.5" />,
  cut: <path d="M2.75 2.75h4v4h-4zM9.25 9.25h4v4h-4zM6.75 6.75l2.5 2.5M13.25 2.75 9.5 6.5M2.75 13.25 6.5 9.5" />,
  paste: <path d="M5.75 2.75h4.5v2.5h-4.5zM10.25 3.75h3v9.5H2.75V3.75h3M5.5 8.25h5M5.5 10.75h5" />,
  info: <path d="M2.75 2.75h10.5v10.5H2.75zM8 7.25v4M8 4.5v1" />,
  more: <path d="M7 2h2v2H7zM7 7h2v2H7zM7 12h2v2H7z" fill="currentColor" stroke="none" />,
  windows: <path d="M2.75 2.75h6.5v6.5h-6.5zM6.75 9.25v4h6.5v-6.5h-4" />,
  enter: <path d="M2.75 2.75h10.5v10.5H2.75zM8 5.25v5.5M5.25 8h5.5" />,
  up: <path d="M8 13V3.5M4 7.25 8 3.25l4 4" />,
  warn: <path d="M2.75 2.75h10.5v10.5H2.75zM8 5v4M8 10.5v1" />,
  link: <path d="M6.5 3.25h6.25V9.5M12.75 3.25 3.5 12.5" />,
  check: <path d="M3 8.5 6.5 12 13 4.5" />,
  dot: <path d="M5.5 5.5h5v5h-5z" fill="currentColor" stroke="none" />,
  sortDown: <path d="M4 6h8l-4 5z" fill="currentColor" stroke="none" />,
  sortUp: <path d="M4 10h8L8 5z" fill="currentColor" stroke="none" />,
  open: <path d="M2.75 13.25V2.75h4.5v2h6v8.5zM2.75 7.75h10.5" />,
  download: <path d="M8 1.75v8M4.5 6.25 8 9.75l3.5-3.5M2.75 11.25v2h10.5v-2" />,
  box: <path d="M2.75 5.25h10.5v8H2.75zM2.75 5.25l1.5-2.5h7.5l1.5 2.5M6.25 7.75h3.5" />,
  image: (
    <>
      <path d="M2.75 2.75h10.5v10.5H2.75zM2.75 11.25l3.75-3.75 3 3 1.5-1.5 2.25 2.25" />
      <path d="M9.75 4.75h1.5v1.5h-1.5z" fill="currentColor" stroke="none" />
    </>
  ),
  chat: <path d="M2.75 2.75h10.5v7.5H7.25l-3 3v-3h-1.5z" />,
  grid: <path d="M2.75 2.75h4v4h-4zM9.25 2.75h4v4h-4zM2.75 9.25h4v4h-4zM9.25 9.25h4v4h-4z" />,
  layers: <path d="M2.75 8.75h10.5v4.5H2.75zM4.25 5.75h7.5M5.75 2.75h4.5" />,
};

export type IconName = keyof typeof paths;

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

// The wordmark: SPACE small and spaced above, WISE large below.
export function Wordmark({ size = 18 }: { size?: number }) {
  return (
    <span className="wordmark" style={{ ["--wm" as string]: size + "px" }} role="img" aria-label="SpaceWise">
      <span aria-hidden="true">space</span>
      <span aria-hidden="true">wise</span>
    </span>
  );
}

// The mark: a treemap in miniature with one tile lifted out of its bottom-right
// corner. That gap is the product in one shape — this is what the disk holds, and
// this is the part you can get back. Right angles only, and the ink runs from
// strong to weak so it follows the theme.
//
// Below 28px the field is split once instead of twice. Measured on a contact
// sheet across all four themes: at title-bar size the third tile and the second
// gap turn to mush, and the empty corner stops reading as deliberate. A mark that
// cannot be read at 18px is decoration, so the small size drops detail and keeps
// the silhouette.
export function Mark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" shapeRendering="crispEdges">
      {size >= 28 ? (
        <>
          <path d="M2 2h13v28H2z" fill="var(--t5)" />
          <path d="M17 2h13v17H17z" fill="var(--t4)" />
          <path d="M17 21h5v9H17z" fill="var(--t3)" />
        </>
      ) : (
        <>
          <path d="M2 2h17v28H2z" fill="var(--t5)" />
          <path d="M23 2h7v15H23z" fill="var(--t4)" />
        </>
      )}
    </svg>
  );
}
