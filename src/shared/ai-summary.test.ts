import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { SUMMARY_MAX_BYTES, SUMMARY_SYSTEM_PROMPT, buildSummaryPayload, relativeLabel } from "./ai-summary";
import type { SummaryInput } from "./ai-summary";

const ROOT = "C:\\Users\\me\\Projects";

// Sizes are exact binary multiples so the expected text is obvious rather than a
// rounding puzzle.
const MB = 1024 * 1024;

const input = (over: Partial<SummaryInput> = {}): SummaryInput => ({
  rootName: "Projects",
  files: 11_072,
  dirs: 1_320,
  bytes: 400 * MB,
  errors: 0,
  facts: [
    { label: "app/node_modules", bytes: 25 * MB, category: "Project dependencies", risk: "safe" },
    { label: "app/dist", bytes: 12 * MB, category: "Build output", risk: "safe" },
    { label: "app/.cache", bytes: 4 * MB, category: "Tool and language caches", risk: "review" },
  ],
  types: [
    { ext: ".js", bytes: 120 * MB, count: 4102 },
    { ext: ".map", bytes: 40 * MB, count: 900 },
  ],
  duplicates: { sets: 14, copies: 31, bytes: 2 * MB },
  ...over,
});

describe("what leaves the machine", () => {
  it("names nothing at all when names are not wanted", () => {
    const { text, namesIncluded } = buildSummaryPayload(input(), { includeNames: false });
    assert.equal(namesIncluded, false);
    for (const fact of input().facts) {
      assert.ok(!text.includes(fact.label), `the label ${fact.label} must not be in the text`);
    }
    assert.ok(!text.includes("node_modules"), "not even as a bare word");
    assert.ok(!text.includes("/"), "no path separators");
    assert.ok(!text.includes("\\"), "no path separators");
  });

  it("still says something useful without names", () => {
    const { text } = buildSummaryPayload(input(), { includeNames: false });
    assert.match(text, /Project dependencies/);
    assert.match(text, /Build output/);
    assert.match(text, /25\.0 MB/, "the categories carry their sizes");
    assert.match(text, /400\.0 MB/, "and the total is there");
  });

  it("never includes the folder's full path, even when names are wanted", () => {
    const { text } = buildSummaryPayload(input(), { includeNames: true });
    assert.ok(!text.includes(ROOT), "the absolute path must never be in the text");
    assert.ok(!text.includes("Users"), "nor any segment of it above the last");
    assert.ok(!text.includes("C:\\"));
    assert.match(text, /Folder {8}Projects/, "only the last segment, for context");
  });

  it("uses relative labels when names are wanted", () => {
    const { text, namesIncluded } = buildSummaryPayload(input(), { includeNames: true });
    assert.equal(namesIncluded, true);
    assert.match(text, /app\/node_modules/);
    assert.match(text, /app\/dist/);
  });

  it("says plainly that the message is the whole message", () => {
    for (const includeNames of [true, false]) {
      const { text } = buildSummaryPayload(input(), { includeNames });
      assert.match(text, /This is the whole message/);
      assert.match(text, /No file contents are included/);
    }
  });
});

describe("a path cannot escape through a label", () => {
  it("makes a path inside the folder relative", () => {
    assert.equal(relativeLabel(ROOT, ROOT + "\\app\\dist"), "app/dist");
    assert.equal(relativeLabel(ROOT, ROOT + "\\app"), "app");
  });

  it("calls the folder itself the folder itself, rather than naming it", () => {
    assert.equal(relativeLabel(ROOT, ROOT), "(the folder itself)");
    assert.equal(relativeLabel(ROOT, ROOT + "\\"), "(the folder itself)");
  });

  it("falls back to the last segment for anything outside the folder", () => {
    assert.equal(relativeLabel(ROOT, "D:\\elsewhere\\thing.bin"), "thing.bin");
    assert.equal(relativeLabel(ROOT, "C:\\Users\\me\\Other\\thing.bin"), "thing.bin");
  });

  it("never hands back a drive letter on its own", () => {
    assert.ok(!relativeLabel(ROOT, "C:\\").includes(":"));
  });

  it("is not fooled by a folder whose name merely starts the same way", () => {
    // "Projects-old" is not inside "Projects".
    assert.equal(relativeLabel(ROOT, "C:\\Users\\me\\Projects-old\\x"), "x");
  });
});

describe("the message stays small", () => {
  it("caps how many findings it lists", () => {
    const many = Array.from({ length: 500 }, (_, i) => ({
      label: `dir${i}`,
      bytes: 1000,
      category: "Build output",
      risk: "safe",
    }));
    const payload = buildSummaryPayload(input({ facts: many }), { includeNames: true, maxFacts: 5 });
    assert.equal(payload.factsListed, 5);
    assert.equal(payload.truncated, true);
    assert.match(payload.text, /and 495 more/);
  });

  it("caps how many types it lists", () => {
    const types = Array.from({ length: 100 }, (_, i) => ({ ext: `.e${i}`, bytes: 1000, count: 5 }));
    const payload = buildSummaryPayload(input({ types }), { includeNames: false, maxTypes: 3 });
    assert.equal(payload.truncated, true);
    assert.match(payload.text, /and 97 more types/);
  });

  it("holds the line on the size of the text itself", () => {
    const facts = Array.from({ length: 5000 }, (_, i) => ({
      label: `a/very/long/folder/name/number/${i}/inside/the/scan`,
      bytes: 123_456,
      category: "Build output",
      risk: "safe",
    }));
    const payload = buildSummaryPayload(input({ facts }), { includeNames: true, maxFacts: 5000, maxBytes: 2048 });
    assert.ok(payload.bytes <= 2048, `expected at most 2048 bytes, got ${payload.bytes}`);
    assert.match(payload.text, /left out to keep this message short/);
    assert.equal(payload.truncated, true);
  });

  it("stays small for a scan of a million files", () => {
    const types = Array.from({ length: 400 }, (_, i) => ({ ext: `.x${i}`, bytes: 1024, count: 2500 }));
    const facts = Array.from({ length: 20_000 }, () => ({
      label: "some/deep/path/inside/the/scan/that/is/quite/long/indeed",
      bytes: 4096,
      category: "Build output",
      risk: "safe",
    }));
    const payload = buildSummaryPayload(input({ files: 1_000_000, dirs: 90_000, facts, types }), {
      includeNames: true,
    });
    assert.ok(payload.bytes <= SUMMARY_MAX_BYTES, `a million files must not become a wall of text: ${payload.bytes} bytes`);
  });

  it("does without a duplicates line when there were none", () => {
    const { text } = buildSummaryPayload(input({ duplicates: null }), { includeNames: false });
    assert.ok(!text.includes("Duplicates"));
  });
});

describe("what the summary is told to do", () => {
  it("forbids presenting anything as safe to delete", () => {
    assert.match(SUMMARY_SYSTEM_PROMPT, /Do not tell the person that anything is safe to delete/);
  });

  it("forbids implying it has read the files", () => {
    assert.match(SUMMARY_SYSTEM_PROMPT, /cannot read files/);
  });

  it("forbids inventing a list of things to delete", () => {
    assert.match(SUMMARY_SYSTEM_PROMPT, /do not present a list of things to delete/);
  });

  it("tells it not to guess when names were withheld", () => {
    assert.match(SUMMARY_SYSTEM_PROMPT, /withholds names/);
  });

  it("keeps the answer short", () => {
    assert.match(SUMMARY_SYSTEM_PROMPT, /At most 150 words/);
  });
});
