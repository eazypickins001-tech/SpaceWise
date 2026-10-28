// The store behind "cleanup must never touch these folders".
//
// It is a rule file the main process reads at the moment of deletion, so the two
// things worth pinning are that a damaged file can never widen anything, and that
// only absolute paths are ever stored — a rule that looks like protection while
// protecting nothing is worse than no rule.
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { MAX_PROTECTED, addProtected, cleanEntries, readProtected, removeProtected, writeProtected } from "./protection";

const dir = mkdtempSync(join(tmpdir(), "spacewise-protect-"));
after(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
const file = (): string => join(dir, `p-${n++}.json`);

test("a missing file means nothing is protected yet", () => {
  assert.deepEqual(readProtected(join(dir, "not-there.json")), []);
});

test("a damaged file cannot widen anything, and does not throw", () => {
  const f = file();
  writeFileSync(f, "{ this is not json");
  assert.deepEqual(readProtected(f), []);
  writeFileSync(f, JSON.stringify({ not: "an array" }));
  assert.deepEqual(readProtected(f), []);
});

test("only absolute paths are stored, normalised, one entry per folder", () => {
  assert.deepEqual(cleanEntries(["C:/work/app/", "c:\\work\\app", "relative\\path", "", "D:\\data"]), [
    "C:\\work\\app",
    "D:\\data",
  ]);
});

test("a UNC share is absolute too", () => {
  assert.deepEqual(cleanEntries(["\\\\server\\share\\folder"]), ["\\\\server\\share\\folder"]);
});

test("the list is bounded", () => {
  const many = Array.from({ length: MAX_PROTECTED + 20 }, (_, i) => `C:\\f${i}`);
  assert.equal(cleanEntries(many).length, MAX_PROTECTED);
});

test("adding writes the folder and answers with the list", () => {
  const f = file();
  assert.deepEqual(addProtected(f, "C:\\work\\app"), ["C:\\work\\app"]);
  assert.deepEqual(addProtected(f, "D:\\data"), ["C:\\work\\app", "D:\\data"]);
  assert.deepEqual(readProtected(f), ["C:\\work\\app", "D:\\data"]);
});

test("adding the same folder again changes nothing, whatever the spelling", () => {
  const f = file();
  addProtected(f, "C:\\work\\app");
  assert.deepEqual(addProtected(f, "c:/WORK/app/"), ["C:\\work\\app"]);
});

test("a relative path is refused rather than stored as a share", () => {
  const f = file();
  assert.deepEqual(addProtected(f, "work\\app"), []);
});

test("removing matches case-insensitively", () => {
  const f = file();
  writeProtected(f, ["C:\\work\\app", "D:\\data"]);
  assert.deepEqual(removeProtected(f, "c:\\WORK\\app"), ["D:\\data"]);
});

test("removing something that is not there changes nothing", () => {
  const f = file();
  writeProtected(f, ["C:\\work\\app"]);
  assert.deepEqual(removeProtected(f, "E:\\elsewhere"), ["C:\\work\\app"]);
});
