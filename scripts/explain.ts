// Prints what SpaceWise would recommend for a folder, and why.
//
// This is the answer to "the interface said nothing, is that right?". It walks a
// real directory with the same walk and the same directory lister the
// application uses, runs the same detection the Clean up tab runs, and prints
// each finding with the evidence that produced it. Nothing is written or removed.
//
//   npm run explain -- "C:\some\folder"
//
// It used to carry a walker of its own, which was a mistake: that walker
// followed junctions (which the application never does), recorded no size on
// disk, and skipped unreadable entries in silence. So it could disagree with the
// application it exists to explain.
import { resolve } from "node:path";
import { makeLister } from "../src/main/lister";
import type { EntrySink } from "../src/main/lister";
import { Walker } from "../src/main/walk";
import type { DirBatch, ListDirs } from "../src/main/walk";
import { finishTable } from "../src/shared/table";
import type { ScanFacts } from "../src/shared/table";
import { analyzeStorage, summarize } from "../src/shared/storage-intelligence";
import { tableView } from "../src/shared/test-fixtures";

const MB = 1024 * 1024;

const target = process.argv[2];
if (!target) {
  console.error("usage: npm run explain -- <folder>");
  process.exit(2);
}
const root = resolve(target);

// The production lister, driven synchronously. Entries for the whole batch are
// gathered and handed back together, which is the shape the walk expects.
const encoder = new TextEncoder();

const list: ListDirs = (dirs) => {
  const counts = new Uint32Array(dirs.length);
  const failed: [number, string][] = [];
  const flags: number[] = [];
  const sizes: number[] = [];
  const logical: number[] = [];
  const mtimes: number[] = [];
  const nameLens: number[] = [];
  const nameParts: Uint8Array[] = [];

  const sink: EntrySink = {
    add(name, flag, onDisk, length, mtime) {
      const bytes = encoder.encode(name);
      nameLens.push(bytes.length);
      nameParts.push(bytes);
      flags.push(flag);
      sizes.push(onDisk);
      logical.push(length);
      mtimes.push(mtime);
    },
  };
  const lister = makeLister(sink);

  for (let d = 0; d < dirs.length; d++) {
    const before = flags.length;
    let result: number | string;
    try {
      result = lister(dirs[d]);
    } catch (err) {
      result = (err as NodeJS.ErrnoException).code ?? "EUNKNOWN";
    }
    if (typeof result === "string") {
      // Drop whatever a failed listing left half written, so a folder that
      // cannot be read contributes nothing rather than contributing nonsense.
      flags.length = sizes.length = logical.length = mtimes.length = nameLens.length = before;
      nameParts.length = before;
      failed.push([d, result]);
    } else {
      counts[d] = result;
    }
  }

  let total = 0;
  for (const part of nameParts) total += part.length;
  const names = new Uint8Array(total);
  let at = 0;
  for (const part of nameParts) {
    names.set(part, at);
    at += part.length;
  }

  const batch: DirBatch = {
    counts,
    failed,
    nameLens: Uint16Array.from(nameLens),
    names,
    sizes: Float64Array.from(sizes),
    logical: Float64Array.from(logical),
    mtimes: Uint32Array.from(mtimes),
    flags: Uint8Array.from(flags),
  };
  return Promise.resolve(batch);
};

async function main(): Promise<void> {
  const startedAt = Date.now();
  const walker = new Walker({ root, list, batch: 32, concurrency: 1 });
  walker.start();
  const outcome = await walker.done;

  const facts: ScanFacts = {
    startedAt,
    durationMs: Date.now() - startedAt,
    dirs: walker.dirs(),
    errors: walker.errors(),
    errorSamples: [...walker.issues()],
    incomplete: outcome.stopped,
  };
  const table = finishTable(walker.raw(), facts);
  const findings = analyzeStorage(tableView(table));

  console.log("");
  console.log(`Scanned   ${root}`);
  console.log(`Entries   ${table.n} (${table.files[0]} files)   Total ${(table.size[0] / MB).toFixed(1)} MB`);
  // Reported rather than hidden: the application counts these, so this must too.
  if (facts.errors > 0) console.log(`Errors    ${facts.errors} location(s) could not be read`);
  console.log("");

  if (findings.length === 0) {
    console.log("No cleanup recommendations. Nothing here matched a rule.");
  } else {
    const bytes = findings.reduce((s, f) => s + f.bytes, 0);
    console.log(`${findings.length} recommendation(s), ${(bytes / MB).toFixed(1)} MB:`);
    console.log("");
    for (const f of findings) {
      console.log(`  ${f.path.slice(root.length + 1)}`);
      console.log(`    ${(f.bytes / MB).toFixed(1)} MB   ${f.category}   risk: ${f.risk}`);
      console.log(`    why: ${f.reason}`);
      console.log(`    after: ${f.consequence}`);
      console.log("");
    }
    console.log("By category:");
    for (const g of summarize(findings)) {
      console.log(`  ${g.def.label.padEnd(28)} ${(g.bytes / MB).toFixed(1)} MB   ${g.count} location(s)`);
    }
  }
  console.log("");
}

void main().catch((err) => {
  console.error(String((err as Error)?.message ?? err));
  process.exit(1);
});
