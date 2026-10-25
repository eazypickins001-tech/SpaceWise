// The text a summary is written from.
//
// This is the entire privacy surface of the optional AI summary, so it is a
// pure function in shared code with its own tests, and the interface shows its
// exact output before anything is sent. Three rules it holds to, and they are
// asserted rather than described:
//
//   1. The scanned folder's full path is never in the text, only its last
//      segment, and only when names are asked for.
//   2. A file or folder name is included only if the person has asked for it.
//      Without names the summary still works: it is written from sizes,
//      categories and counts.
//   3. The text is bounded in length and in how many facts it carries, so a
//      scan of a million files produces a short message, not a dump.
//
// Nothing here reads a file. There is no code path by which file contents could
// reach this function.

export interface SummaryFact {
  // Already relative to the scanned folder. See `relativeLabel`.
  label: string;
  bytes: number;
  category: string;
  risk: string;
}

export interface SummaryType {
  ext: string;
  bytes: number;
  count: number;
}

export interface SummaryInput {
  // The last segment of the scanned folder, for context. Never the full path.
  rootName: string;
  files: number;
  dirs: number;
  bytes: number;
  errors: number;
  // What the rules already found, biggest first. These are the only findings
  // that exist: the summary describes them, it does not look for more.
  facts: SummaryFact[];
  types: SummaryType[];
  duplicates?: { sets: number; copies: number; bytes: number } | null;
}

export interface PayloadOptions {
  includeNames: boolean;
  maxFacts?: number;
  maxTypes?: number;
  // A hard ceiling on the text itself.
  maxBytes?: number;
}

export interface Payload {
  text: string;
  namesIncluded: boolean;
  factsListed: number;
  bytes: number;
  truncated: boolean;
}

export const SUMMARY_MAX_BYTES = 8 * 1024;

// TextEncoder rather than Buffer: this module runs in the renderer too, where
// there is no Buffer and no Node at all.
const ENCODER = new TextEncoder();
function byteLength(text: string): number {
  return ENCODER.encode(text).length;
}

export function bytesText(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 bytes";
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function countText(n: number): string {
  const whole = Math.max(0, Math.round(Number.isFinite(n) ? n : 0));
  return String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// A path with the scanned folder stripped off. A path that is not inside the
// folder is reduced to its last segment, and a bare drive letter becomes
// "(a drive)", so no part of a path the person did not scan can travel in the
// message and no absolute path can escape through this function.
export function relativeLabel(root: string, path: string): string {
  const cut = (value: string): string => value.replace(/[\\/]+$/, "").toLowerCase();
  const r = cut(root);
  const p = String(path ?? "");
  const inside =
    r !== "" &&
    (cut(p) === r || cut(p).startsWith(r + "\\") || cut(p).startsWith(r + "/"));

  const parts = (inside ? p.slice(root.replace(/[\\/]+$/, "").length) : p).split(/[\\/]+/).filter(Boolean);

  if (inside) return parts.length === 0 ? "(the folder itself)" : parts.join("/");

  const last = parts[parts.length - 1] ?? "";
  if (last === "") return "(unknown)";
  return /^[a-z]:$/i.test(last) ? "(a drive)" : last;
}

// The single place that decides what leaves the machine.
export function buildSummaryPayload(input: SummaryInput, options: PayloadOptions): Payload {
  const maxFacts = Math.max(0, options.maxFacts ?? 12);
  const maxTypes = Math.max(0, options.maxTypes ?? 8);
  const maxBytes = Math.max(256, options.maxBytes ?? SUMMARY_MAX_BYTES);
  const includeNames = options.includeNames;

  const lines: string[] = [];
  lines.push("SpaceWise storage summary");
  lines.push("");
  if (includeNames) lines.push(`Folder        ${input.rootName}`);
  lines.push(`Files         ${countText(input.files)}`);
  lines.push(`Folders       ${countText(input.dirs)}`);
  lines.push(`On disk       ${bytesText(input.bytes)}`);
  if (input.errors > 0) lines.push(`Unreadable    ${countText(input.errors)}`);

  let factsListed = 0;
  let truncated = false;

  const types = input.types.slice(0, maxTypes);
  if (types.length > 0) {
    lines.push("");
    lines.push("Storage by type");
    for (const t of types) {
      lines.push(`  ${t.ext || "(none)"}  ${bytesText(t.bytes)}  ${countText(t.count)} files`);
    }
    if (input.types.length > types.length) {
      truncated = true;
      lines.push(`  ...and ${countText(input.types.length - types.length)} more types`);
    }
  }

  lines.push("");
  if (includeNames) {
    lines.push("What the rules already found");
    const facts = input.facts.slice(0, maxFacts);
    for (const f of facts) {
      lines.push(`  ${f.label}`);
      lines.push(`    ${bytesText(f.bytes)}  ${f.category}  risk: ${f.risk}`);
    }
    factsListed = facts.length;
    if (input.facts.length > facts.length) {
      truncated = true;
      lines.push(`  ...and ${countText(input.facts.length - facts.length)} more`);
    }
  } else {
    // Without names, group by what the rules said the thing is. That is still a
    // useful summary and it cannot name anything.
    lines.push("What the rules already found, by category");
    const byCategory = new Map<string, { bytes: number; count: number }>();
    for (const f of input.facts) {
      const at = byCategory.get(f.category) ?? { bytes: 0, count: 0 };
      at.bytes += f.bytes;
      at.count += 1;
      byCategory.set(f.category, at);
    }
    const ranked = [...byCategory.entries()].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, maxFacts);
    for (const [category, at] of ranked) {
      lines.push(`  ${category}  ${bytesText(at.bytes)}  ${countText(at.count)} location(s)`);
    }
    factsListed = ranked.length;
    if (byCategory.size > ranked.length) {
      truncated = true;
      lines.push(`  ...and ${countText(byCategory.size - ranked.length)} more categories`);
    }
  }

  if (input.duplicates && input.duplicates.sets > 0) {
    lines.push("");
    lines.push("Duplicates");
    lines.push(`  ${countText(input.duplicates.sets)} sets, ${countText(input.duplicates.copies)} extra copies, ${bytesText(input.duplicates.bytes)} could be freed`);
  }

  lines.push("");
  lines.push("This is the whole message. No file contents are included, and nothing is deleted by asking for a summary.");

  let text = lines.join("\n");
  if (byteLength(text) > maxBytes) {
    // Cut on a line boundary so the result stays readable, then say so.
    const kept: string[] = [];
    let used = 0;
    for (const line of lines) {
      const cost = byteLength(line) + 1;
      if (used + cost > maxBytes - 64) break;
      kept.push(line);
      used += cost;
    }
    kept.push("");
    kept.push("(The rest was left out to keep this message short.)");
    text = kept.join("\n");
    truncated = true;
  }

  return {
    text,
    namesIncluded: includeNames,
    factsListed,
    bytes: byteLength(text),
    truncated,
  };
}

// What the summary is told to do, and not to do. The instructions about
// deletion are the safety stance of the product, so they live here next to the
// payload and are asserted in the tests rather than left in a prompt somewhere.
export const SUMMARY_SYSTEM_PROMPT = [
  "You are describing the results of a local disk scan to the person who ran it.",
  "You can see only the summary text given to you. You cannot read files, and you must not imply that you have.",
  "Explain what the numbers likely represent and which categories are worth the person's attention.",
  "Do not tell the person that anything is safe to delete, and do not present a list of things to delete.",
  "The scan's own rules decided what was worth reporting; your job is to describe and prioritise, not to decide.",
  "Never claim a file is unused, unnecessary or a duplicate unless the summary says so in those words.",
  "If the summary withholds names, say that plainly instead of guessing at what the folders are.",
  "Be brief. At most 150 words, in plain sentences, no headings and no bullet lists.",
].join(" ");
