// Creates a disposable folder tree for trying the Clean up flow end to end.
//
// Everything here is generated filler in a folder on your Desktop. Nothing is a
// system file, nothing is read from anywhere else, and the whole folder can be
// deleted afterwards. The point is to be able to test detection, the review
// sheet, revalidation and the audit log without going anywhere near real data.
//
// Two of the folders below are deliberate decoys. They are named like clutter
// but must NOT be recommended, and if they ever appear in the Clean up tab then
// the "a name is not a verdict" rule has regressed.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const MB = 1024 * 1024;
const base = join(homedir(), "Desktop", "SpaceWise Test Folder");

if (existsSync(base)) {
  console.error("");
  console.error("Refusing to touch a folder that already exists:");
  console.error("  " + base);
  console.error("");
  console.error("Delete it yourself first, then run this again.");
  process.exit(1);
}

const plan = [
  // A real project: these are the three that should be recommended.
  ["app/package.json", Buffer.from('{"name":"spacewise-fixture","private":true}')],
  ["app/dist/bundle.js", Buffer.alloc(12 * MB, 7)],
  ["app/node_modules/some-package/index.js", Buffer.alloc(25 * MB, 9)],
  ["app/node_modules/some-package/package.json", Buffer.from('{"name":"some-package"}')],
  ["app/__pycache__/module.cpython-313.pyc", Buffer.alloc(4 * MB, 3)],

  // Decoy 1: called dist, but there is no manifest beside it anywhere above it.
  ["loose-build/dist/bundle.js", Buffer.alloc(8 * MB, 5)],

  // Decoy 2: called cache, in a place that means nothing.
  ["random/cache/notes.dat", Buffer.alloc(6 * MB, 1)],

  // A plain large file. Shows up as a large file, never as a cleanup candidate.
  ["media/holiday.mp4", Buffer.alloc(40 * MB, 2)],
];

for (const [rel, data] of plan) {
  const target = join(base, rel);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, data);
}

const total = plan.reduce((sum, [, data]) => sum + data.length, 0);

console.log("");
console.log("Fixture created:");
console.log("  " + base);
console.log(`  ${plan.length} files, ${(total / MB).toFixed(1)} MB`);
console.log("");
console.log("Scan that folder, then open the Clean up tab. Expect exactly three");
console.log("recommendations, about 41 MB in total:");
console.log("");
console.log("  app/node_modules      project dependencies   25.0 MB   Regenerable");
console.log("  app/dist              build output           12.0 MB   Regenerable");
console.log("  app/__pycache__       tool caches             4.0 MB   Safe");
console.log("");
console.log("Expect these to be ABSENT, and treat their presence as a bug:");
console.log("");
console.log("  loose-build/dist      no manifest beside it, so nothing proves what it is");
console.log("  random/cache          the word cache is not evidence of anything");
console.log("");
console.log("To test the safety rules, add a file inside app/dist while the review");
console.log("sheet is open. That item should come back as skipped, with a reason,");
console.log("and the run should be reported as partial rather than complete.");
console.log("");
console.log("Delete the folder when you are done. Nothing outside it was touched.");
console.log("");
