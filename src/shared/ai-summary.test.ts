import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { SUMMARY_MAX_BYTES, SUMMARY_SYSTEM_PROMPT, buildSummaryPayload, relativeLabel, CHAT_HISTORY_TURNS, CHAT_SYSTEM_PROMPT, buildChatMessage } from "./ai-summary";
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

describe("asking about one folder", () => {
  const base = {
    rootName: "Project",
    item: {
      label: "node_modules",
      bytes: 3_100_000_000,
      files: 41_000,
      risk: "low",
      reason: "It is a dependency folder and it has not been touched in 8 months.",
      consequence: "Every package is downloaded again on the next install.",
    },
    category: {
      label: "Dependency folders",
      whatItContains: "Packages installed by npm, pnpm or yarn.",
      whyItGrows: "Every install adds to it and nothing expires.",
      regeneration: "Restored by installing again, which needs a network.",
    },
    question: "What happens if I remove this?",
    history: [],
    recoverable: true,
  };

  // The whole design in one assertion: the rules' own words are what the model
  // is given, and the model is what puts them into an answer.
  it("sends the rules' own words rather than a bare size", () => {
    const out = buildChatMessage(base, { includeNames: true });
    assert.match(out.text, /has not been touched in 8 months/, "why it was flagged");
    assert.match(out.text, /downloaded again on the next install/, "what happens if it goes");
    assert.match(out.text, /Packages installed by npm/, "what this kind of folder is");
    assert.match(out.text, /needs a network/, "how it comes back");
    assert.match(out.text, /goes to the Recycle Bin/, "and that it is recoverable");
  });

  it("carries the question itself", () => {
    const out = buildChatMessage({ ...base, question: "Is this the same as my pip cache?" }, { includeNames: true });
    assert.match(out.text, /Is this the same as my pip cache\?/);
  });

  // The same guarantee the summary makes, for the same reason.
  it("carries no path, even with names wanted", () => {
    const out = buildChatMessage(
      { ...base, item: { ...base.item, label: relativeLabel("C:\\Users\\me\\Project", "C:\\Users\\me\\Project\\node_modules") } },
      { includeNames: true },
    );
    assert.ok(!out.text.includes("C:\\Users"), "no absolute path");
    assert.match(out.text, /node_modules/, "but the folder can still be named");
  });

  it("withholds the name when names are not wanted", () => {
    const out = buildChatMessage(base, { includeNames: false });
    assert.ok(!out.text.includes("node_modules"), "the name must not travel");
    assert.ok(!out.text.includes("Project"), "nor the folder it is in");
    assert.match(out.text, /withheld/, "and says so, rather than nothing");
    assert.equal(out.namesIncluded, false);
  });

  it("does not pretend a category exists when it does not", () => {
    const out = buildChatMessage({ ...base, category: null }, { includeNames: true });
    assert.ok(!/About this kind of folder/.test(out.text));
  });

  it("carries the last few turns and drops the older ones", () => {
    const history = Array.from({ length: CHAT_HISTORY_TURNS + 2 }, (_, i) => ({
      question: "question " + i,
      answer: "answer " + i,
    }));
    const out = buildChatMessage({ ...base, history }, { includeNames: true });
    assert.match(out.text, new RegExp("question " + (history.length - 1)), "the most recent turn is there");
    assert.ok(!out.text.includes("question 0"), "and the oldest has gone");
  });

  it("flattens a multi-line answer to keep the transcript readable", () => {
    const out = buildChatMessage({ ...base, history: [{ question: "why?", answer: "Because\n\nit is\n   old." }] }, { includeNames: true });
    assert.match(out.text, /Because it is old\./);
  });

  it("keeps within a small allowance, giving up the conversation rather than the facts", () => {
    const history = Array.from({ length: 5 }, (_, i) => ({ question: "question " + i, answer: "answer " + i }));
    const out = buildChatMessage({ ...base, history }, { includeNames: true, maxBytes: 1024 });
    assert.ok(out.bytes <= 1024, `stayed within the allowance, got ${out.bytes}`);
    assert.equal(out.truncated, true, "and said that part of the conversation was left out");
    assert.match(out.text, /What happens if I remove this/, "the question survives, because the answer depends on it");
    assert.match(out.text, /has not been touched in 8 months/, "and so do the rules' own words");
  });
});

describe("what the chat prompt forbids", () => {
  it("forbids deciding whether to delete, and forbids pretending to know more", () => {
    assert.match(CHAT_SYSTEM_PROMPT, /Do not say whether the folder is safe to delete/);
    assert.match(CHAT_SYSTEM_PROMPT, /do not advise deleting it or keeping it/);
    assert.match(CHAT_SYSTEM_PROMPT, /cannot read files/);
    assert.match(CHAT_SYSTEM_PROMPT, /must not imply/);
    assert.match(CHAT_SYSTEM_PROMPT, /treat it as the authority|Treat it as the authority/, "the rules are the authority, not the model");
  });

  it("tells it to answer about harm from the stated consequence", () => {
    assert.match(CHAT_SYSTEM_PROMPT, /would harm the computer/);
    assert.match(CHAT_SYSTEM_PROMPT, /stated consequence/);
  });
});
