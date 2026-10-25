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

// ---------------------------------------------------------------------------
// Asking about one folder
// ---------------------------------------------------------------------------

// A question about a single finding, rather than the whole scan.
//
// The division of labour matters and is enforced by what is sent: everything
// below the question is text this application's own rules produced -- why the
// item was flagged, what the rules say happens if it goes, and what this kind of
// folder is and how it comes back. The model is given the facts and asked to
// explain them. It is never asked to decide, because it cannot see the folder
// and a confident guess about someone's files is the one answer that could cost
// them something.
export interface ChatItem {
  label: string;
  bytes: number;
  files: number;
  risk: string;
  reason: string;
  consequence: string;
}

export interface ChatCategory {
  label: string;
  whatItContains: string;
  whyItGrows: string;
  regeneration: string;
}

export interface ChatTurn {
  question: string;
  answer: string;
}

export interface ChatInput {
  rootName: string;
  item: ChatItem;
  category: ChatCategory | null;
  question: string;
  history: ChatTurn[];
  // Whether removal goes to the Recycle Bin, which is a fact about the
  // application rather than about the folder. A rule the person can act on.
  recoverable: boolean;
}

export interface ChatPayload {
  text: string;
  namesIncluded: boolean;
  bytes: number;
  truncated: boolean;
}

export const CHAT_SYSTEM_PROMPT = [
  "You are helping someone understand one folder found by a local disk scan.",
  "Everything above the question was produced by this application's own rules. Treat it as the authority: explain it, and do not contradict it or add facts that are not there.",
  "You cannot read files and you must not imply that you have. You know only what you were given.",
  "Do not say whether the folder is safe to delete, and do not advise deleting it or keeping it. The risk and the consequence are already stated by the application; repeat those instead of deciding.",
  "If asked whether removing it would harm the computer, answer from the stated consequence and how the folder comes back, and say plainly that it goes to the Recycle Bin when the application says so.",
  "If the name was withheld, say that plainly rather than guessing at what the folder is.",
  "Be brief. At most 120 words, in plain sentences, no headings and no bullet lists.",
].join(" ");

// How much of the conversation is carried back. Enough to make a follow-up
// sentence make sense, not enough to grow without limit.
export const CHAT_HISTORY_TURNS = 3;

export function buildChatMessage(input: ChatInput, options: PayloadOptions): ChatPayload {
  // A floor, so that the facts and the question always fit whatever a caller
  // asks for. They are the part the answer depends on; everything else gives way.
  const maxBytes = Math.max(1024, options.maxBytes ?? SUMMARY_MAX_BYTES);
  const names = options.includeNames;
  const bytesOf = (parts: string[]): number => new TextEncoder().encode(parts.join("\n")).length;

  const label = names ? input.item.label : "(the name is withheld)";
  const head: string[] = [
    "SpaceWise: a question about one folder",
    "",
    "Folder        " + label,
    "In the        " + (names ? input.rootName : "(the name is withheld)"),
    "Size on disk  " + bytesText(input.item.bytes) + " in " + countText(input.item.files),
    "Risk          " + input.item.risk,
    "",
    "Why the rules flagged it",
    "  " + input.item.reason,
    "",
    "What the rules say happens if it goes",
    "  " + input.item.consequence,
  ];
  if (input.recoverable) {
    head.push("  It goes to the Recycle Bin, so it can be brought back.");
  }
  if (input.category) {
    head.push(
      "",
      "About this kind of folder",
      "  " + input.category.label + ": " + input.category.whatItContains,
      "  Why it grows: " + input.category.whyItGrows,
      "  How it comes back: " + input.category.regeneration,
    );
  }

  const tail: string[] = [
    "",
    "Question",
    "  " + oneLine(input.question),
    "",
    "This is the whole message. No file contents are included, and nothing is deleted by asking.",
  ];

  // The conversation is added from the most recent backwards, and only while it
  // actually fits. Measuring beats counting turns: with a fixed number the
  // message could still be too large, and with a count that always fits nothing
  // would ever need dropping, which would make the flag below meaningless.
  const turns: ChatTurn[] = [];
  for (let i = input.history.length - 1; i >= 0 && turns.length < CHAT_HISTORY_TURNS; i--) {
    const candidate = [input.history[i], ...turns];
    const block = ["", "Earlier in this conversation"];
    for (const turn of candidate) {
      block.push("  They asked: " + oneLine(turn.question));
      block.push("  You answered: " + oneLine(turn.answer));
    }
    if (bytesOf([...head, ...block, ...tail]) > maxBytes) break;
    turns.unshift(input.history[i]);
  }

  const lines = [...head];
  if (turns.length > 0) {
    lines.push("", "Earlier in this conversation");
    for (const turn of turns) {
      lines.push("  They asked: " + oneLine(turn.question));
      lines.push("  You answered: " + oneLine(turn.answer));
    }
  }
  lines.push(...tail);

  const text = lines.join("\n");
  // Not "the message was cut": the facts and the question are always whole. It
  // means part of the conversation was left out of the message.
  const dropped = input.history.length - turns.length;
  return { text, namesIncluded: names, bytes: bytesOf([text]), truncated: dropped > 0 };
}

// Answers and questions arrive with line breaks; a transcript reads better flat.
function oneLine(value: string, limit = 400): string {
  const flat = String(value ?? "").replace(/\s+/g, " ").trim();
  return flat.length > limit ? flat.slice(0, limit) + "…" : flat;
}
