// Storage intelligence: what is on the disk, why it is there, and what it costs
// to remove. Every finding carries the evidence that produced it, so the
// interface can explain a recommendation instead of asserting one.
//
// Two rules run through the whole module:
//   1. A name is a hint, never a verdict. Folder names such as `dist`, `build`,
//      `out`, `bin`, `venv` and `vendor` appear in unrelated projects, so those
//      only count as build or dependency output when a sibling file proves the
//      ecosystem (a manifest).
//   2. Measured facts and guidance are kept apart. `bytes` is something the
//      scan observed; `consequence` is advice about what happens afterwards.
import { F_DIR, F_GONE, F_LINK } from "./types";
import type { ScanTable } from "./types";

const MB = 1024 * 1024;

export type Risk = "safe" | "low" | "review" | "danger";

export type CategoryId =
  | "package-cache"
  | "browser-cache"
  | "temp"
  | "tool-cache"
  | "crash-dumps"
  | "dev-dependencies"
  | "build-output"
  | "recycle-bin"
  | "windows-old"
  | "large-files"
  | "old-files";

export interface CategoryDef {
  id: CategoryId;
  label: string;
  risk: Risk;
  whatItContains: string;
  whyItGrows: string;
  regeneration: string;
}

// The catalogue. Risk is deliberately conservative: nothing here is "safe" just
// because of its name, and the two regenerable categories are "low" rather than
// "safe" because regenerating them can need a network and the right lockfile.
export const CATEGORIES: Record<CategoryId, CategoryDef> = {
  "package-cache": {
    id: "package-cache",
    label: "Package manager caches",
    risk: "safe",
    whatItContains: "Downloaded archives and metadata kept by npm, pip, yarn, pnpm, NuGet, Cargo, Gradle and Maven.",
    whyItGrows: "Every install or restore adds archives and never expires old ones.",
    regeneration: "Downloaded again on the next install. Removing them makes that install slower and needs a network.",
  },
  "browser-cache": {
    id: "browser-cache",
    label: "Browser caches",
    risk: "safe",
    whatItContains: "HTTP, GPU and code caches only. Bookmarks, history, passwords and sessions are a separate location and are not matched here.",
    whyItGrows: "Web pages change constantly, so the cache is rewritten continuously.",
    regeneration: "Rebuilt as you browse. The first visit to a site afterwards is slower.",
  },
  temp: {
    id: "temp",
    label: "Temporary files",
    risk: "safe",
    whatItContains: "The user and system temporary folders, where installers and applications unpack working files.",
    whyItGrows: "Programs write here and not every program cleans up after itself.",
    regeneration: "Not needed again. Files still in use are refused by the operating system and reported as skipped.",
  },
  "tool-cache": {
    id: "tool-cache",
    label: "Tool and language caches",
    risk: "safe",
    whatItContains: "Compiler and linter caches such as __pycache__, .pytest_cache, .mypy_cache, .ruff_cache, .turbo and .parcel-cache.",
    whyItGrows: "Each build run writes more entries and the cache is keyed by content that keeps changing.",
    regeneration: "Rebuilt on the next build or test run, which makes that run slower once.",
  },
  "crash-dumps": {
    id: "crash-dumps",
    label: "Crash dumps",
    risk: "safe",
    whatItContains: "Application dumps, and the kernel memory dump at C:\\Windows\\MEMORY.DMP.",
    whyItGrows: "Each crash or bugcheck writes another file, and the kernel dump can be as large as the machine's memory.",
    regeneration: "Not needed again. Keep a dump only while a support case is open.",
  },
  "dev-dependencies": {
    id: "dev-dependencies",
    label: "Project dependencies",
    risk: "low",
    whatItContains: "Installed dependency trees: node_modules, .venv, vendor, Pods.",
    whyItGrows: "Each project keeps its own copy of every dependency, at every version.",
    regeneration: "Rebuilt by the package manager. It needs the lockfile to be present, a network connection, and the same toolchain. Any local edit inside the folder is lost.",
  },
  "build-output": {
    id: "build-output",
    label: "Build output",
    risk: "low",
    whatItContains: "Compiled and bundled output: dist, build, out, target, .next, .nuxt and similar, matched only next to a project manifest.",
    whyItGrows: "Rebuilt and partly replaced on each build, and old artifacts are rarely removed.",
    regeneration: "Rebuilt by running the project's build command. Needs the toolchain and, for a fresh dependency tree, a network connection.",
  },
  "recycle-bin": {
    id: "recycle-bin",
    label: "Recycle Bin",
    risk: "review",
    whatItContains: "Everything you have deleted but not yet emptied.",
    whyItGrows: "Deletions stay here until the bin is emptied or the size limit evicts them.",
    regeneration: "Nothing restores it. Emptying the bin permanently removes every item in it, including anything you may still want back.",
  },
  "windows-old": {
    id: "windows-old",
    label: "Previous Windows installation",
    risk: "review",
    whatItContains: "The Windows.old folder left by a feature update.",
    whyItGrows: "Created once per in-place upgrade and kept for the rollback window.",
    regeneration: "Cannot be regenerated. Removing it makes rolling back to the previous Windows version impossible.",
  },
  "large-files": {
    id: "large-files",
    label: "Large files",
    risk: "review",
    whatItContains: "The biggest individual files in this scan.",
    whyItGrows: "Video, disk images and databases grow without anyone noticing.",
    regeneration: "Depends entirely on the file. Size is not a reason to remove it, so each one needs a decision.",
  },
  "old-files": {
    id: "old-files",
    label: "Not modified recently",
    risk: "review",
    whatItContains: "Files whose last modified date is older than the chosen age.",
    whyItGrows: "Nothing removes files that are no longer edited.",
    regeneration: "Depends entirely on the file. See the note about last access below before treating age as evidence of disuse.",
  },
};

// A folder whose name alone is enough. These are unambiguous in practice.
const BY_NAME: Record<string, CategoryId> = {
  node_modules: "dev-dependencies",
  bower_components: "dev-dependencies",
  ".venv": "dev-dependencies",
  pods: "dev-dependencies",
  "$recycle.bin": "recycle-bin",
  "windows.old": "windows-old",
  crashdumps: "crash-dumps",
  __pycache__: "tool-cache",
  ".pytest_cache": "tool-cache",
  ".mypy_cache": "tool-cache",
  ".ruff_cache": "tool-cache",
  ".tox": "tool-cache",
  ".turbo": "tool-cache",
  ".parcel-cache": "tool-cache",
  ".next": "build-output",
  ".nuxt": "build-output",
  ".svelte-kit": "build-output",
  ".angular": "build-output",
  deriveddata: "build-output",
};

// A folder whose name is common enough that it needs a sibling file to prove
// which ecosystem it belongs to. [folderName, siblingPattern, category]
const WITH_SIBLING: ReadonlyArray<readonly [string, RegExp, CategoryId]> = [
  ["target", /^cargo\.toml$/i, "build-output"],
  ["dist", /^package\.json$/i, "build-output"],
  ["build", /^(package\.json|build\.gradle(\.kts)?|cmakelists\.txt)$/i, "build-output"],
  ["out", /^package\.json$/i, "build-output"],
  ["obj", /\.(cs|fs|vb)proj$/i, "build-output"],
  ["bin", /\.(cs|fs|vb)proj$/i, "build-output"],
  ["venv", /^(requirements.*\.txt|pyproject\.toml|setup\.py)$/i, "dev-dependencies"],
  ["vendor", /^composer\.json$/i, "dev-dependencies"],
];

// Matched against the lowercased, forward-slashed absolute path.
const BY_PATH: ReadonlyArray<readonly [RegExp, CategoryId]> = [
  [/\/appdata\/local\/temp$/, "temp"],
  [/\/windows\/temp$/, "temp"],
  [/\/windows\/softwaredistribution\/download$/, "package-cache"],
  [/\/appdata\/local\/npm-cache$/, "package-cache"],
  [/\/appdata\/local\/pip\/cache$/, "package-cache"],
  [/\/appdata\/local\/yarn\/cache$/, "package-cache"],
  [/\/appdata\/local\/pnpm\/store$/, "package-cache"],
  [/\/appdata\/local\/pnpm-cache$/, "package-cache"],
  [/\/\.nuget\/packages$/, "package-cache"],
  [/\/\.cargo\/registry$/, "package-cache"],
  [/\/\.gradle\/caches$/, "package-cache"],
  [/\/\.m2\/repository$/, "package-cache"],
  [/\/user data\/[^/]+\/(cache|code cache|gpucache)$/, "browser-cache"],
  [/\/user data\/[^/]+\/service worker\/cachestorage$/, "browser-cache"],
  [/\/firefox\/profiles\/[^/]+\/cache2$/, "browser-cache"],
];

// A cheap pre-filter: the path rules only run for a folder whose name is one of
// these, which keeps the path walk off the hot loop for most of the tree.
const PATH_TAILS = new Set([
  "temp",
  "download",
  "cache",
  "npm-cache",
  "store",
  "pnpm-cache",
  "packages",
  "registry",
  "caches",
  "repository",
  "code cache",
  "gpucache",
  "cachestorage",
  "cache2",
]);

// The parts of a scan this module reads. `Disk` satisfies this already, so the
// renderer passes its scan straight in.
export interface ScanView {
  readonly n: number;
  readonly t: ScanTable;
  name(id: number): string;
  path(id: number): string;
  children(id: number): Int32Array;
}

export interface Finding {
  category: CategoryId;
  id: number;
  path: string;
  bytes: number;
  files: number;
  risk: Risk;
  reason: string;
  consequence: string;
}

export interface CategorySummary {
  category: CategoryId;
  def: CategoryDef;
  bytes: number;
  files: number;
  count: number;
  ids: number[];
}

export interface AnalyzeOptions {
  // Folders smaller than this are not reported. Default 1 MiB.
  minBytes?: number;
}

function isDir(view: ScanView, id: number): boolean {
  return (view.t.flags[id] & F_DIR) !== 0;
}

function isLive(view: ScanView, id: number): boolean {
  return (view.t.flags[id] & (F_GONE | F_LINK)) === 0;
}

function filesUnder(view: ScanView, id: number): number {
  return isDir(view, id) ? view.t.files[id] : 1;
}

// Which category, if any, a folder belongs to. Returns the evidence too, so the
// finding can explain itself.
function classify(view: ScanView, id: number): { category: CategoryId; reason: string } | null {
  const name = view.name(id).toLowerCase();

  const byName = BY_NAME[name];
  if (byName) return { category: byName, reason: `The folder is named "${view.name(id)}"` };

  for (const [folder, sibling, category] of WITH_SIBLING) {
    if (name !== folder) continue;
    for (const child of view.children(view.t.parent[id])) {
      if (isDir(view, child)) continue;
      if (sibling.test(view.name(child))) {
        return {
          category,
          reason: `The folder is named "${view.name(id)}" and sits next to ${view.name(child)}, which identifies the project`,
        };
      }
    }
    // The name matched but nothing proved the ecosystem. Not a candidate.
    return null;
  }

  if (PATH_TAILS.has(name)) {
    const path = view.path(id).toLowerCase().replace(/\\/g, "/");
    for (const [pattern, category] of BY_PATH) {
      if (pattern.test(path)) return { category, reason: `The folder is a known location: ${view.path(id)}` };
    }
  }
  return null;
}

// Every explainable storage finding in a scan, largest first. Nested matches are
// not double counted: once a folder is a candidate, everything inside it is
// skipped, so the byte totals stay additive and can be shown as reclaimable.
export function analyzeStorage(view: ScanView, opts: AnalyzeOptions = {}): Finding[] {
  const minBytes = opts.minBytes ?? MB;
  const inside = new Uint8Array(view.n);
  const out: Finding[] = [];

  for (let id = 1; id < view.n; id++) {
    if (inside[view.t.parent[id]]) {
      inside[id] = 1;
      continue;
    }
    if (!isDir(view, id) || !isLive(view, id)) continue;
    const hit = classify(view, id);
    if (!hit) continue;
    inside[id] = 1;
    const bytes = view.t.size[id];
    if (bytes < minBytes) continue;
    const def = CATEGORIES[hit.category];
    out.push({
      category: hit.category,
      id,
      path: view.path(id),
      bytes,
      files: filesUnder(view, id),
      risk: def.risk,
      reason: hit.reason,
      consequence: def.regeneration,
    });
  }
  return out.sort((a, b) => b.bytes - a.bytes);
}

// Findings grouped by category, biggest category first. The byte total here is
// the sum of the findings it contains, which is safe to present as reclaimable
// because the findings are disjoint.
export function summarize(findings: Finding[]): CategorySummary[] {
  const byCategory = new Map<CategoryId, CategorySummary>();
  for (const f of findings) {
    let row = byCategory.get(f.category);
    if (!row) {
      row = { category: f.category, def: CATEGORIES[f.category], bytes: 0, files: 0, count: 0, ids: [] };
      byCategory.set(f.category, row);
    }
    row.bytes += f.bytes;
    row.files += f.files;
    row.count += 1;
    row.ids.push(f.id);
  }
  return [...byCategory.values()].sort((a, b) => b.bytes - a.bytes);
}

export interface OldFileQuery {
  minBytes: number;
  olderThanDays: number;
}

// Files that have not been modified for a while. Deliberately reported for
// review and never described as unused: Windows often has last-access updates
// disabled or batched, so the access time cannot be trusted as evidence that
// nobody opened the file.
export function findOldFiles(view: ScanView, query: OldFileQuery, nowSeconds: number, limit: number): Finding[] {
  const before = nowSeconds - query.olderThanDays * 86400;
  const out: Finding[] = [];
  for (let id = 1; id < view.n; id++) {
    if (isDir(view, id) || !isLive(view, id)) continue;
    const mtime = view.t.mtime[id];
    if (mtime === 0 || mtime > before) continue;
    if (view.t.size[id] < query.minBytes) continue;
    out.push({
      category: "old-files",
      id,
      path: view.path(id),
      bytes: view.t.size[id],
      files: 1,
      risk: "review",
      reason: `Last modified ${Math.round((nowSeconds - mtime) / 86400)} days ago`,
      consequence:
        "Nothing here proves the file is unused. Windows may not record last access at all, so review it before removing anything.",
    });
  }
  out.sort((a, b) => b.bytes - a.bytes);
  return out.slice(0, limit);
}

// The largest files, optionally restricted to one subtree.
export function findLargest(view: ScanView, limit: number, within = 0): Finding[] {
  const picked: number[] = [];
  for (let id = 1; id < view.n; id++) {
    if (isDir(view, id) || !isLive(view, id)) continue;
    if (within > 0 && !contains(view, within, id)) continue;
    picked.push(id);
  }
  picked.sort((a, b) => view.t.size[b] - view.t.size[a] || a - b);
  return picked.slice(0, limit).map((id) => ({
    category: "large-files" as CategoryId,
    id,
    path: view.path(id),
    bytes: view.t.size[id],
    files: 1,
    risk: "review" as Risk,
    reason: "Among the largest files in this scan",
    consequence: "Size alone is not a reason to remove a file.",
  }));
}

function contains(view: ScanView, ancestor: number, id: number): boolean {
  for (let i = id; i >= 0; i = view.t.parent[i]) if (i === ancestor) return true;
  return false;
}

// Total bytes a set of findings would free, counting only what is disjoint. The
// cleanup planner uses this to keep its preview and its estimate in step.
export function reclaimable(findings: Finding[]): number {
  return findings.reduce((sum, f) => sum + f.bytes, 0);
}
