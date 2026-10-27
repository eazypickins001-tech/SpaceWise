// Storage intelligence decides what the product is willing to call a cleanup
// candidate. These tests pin the two rules that matter most: a name alone never
// makes a folder a candidate, and nested candidates are never double counted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { F_LINK } from "./types";
import { analyzeStorage, summarize } from "./storage-intelligence";
import { view } from "./test-fixtures";

const MB = 1024 * 1024;

test("node_modules is reported as project dependencies, not as harmless", () => {
  const v = view("C:\\work\\app", {
    name: "",
    children: [{ name: "node_modules", children: [{ name: "x.js", size: 40 * MB }] }],
  });
  const found = analyzeStorage(v);
  assert.equal(found.length, 1);
  assert.equal(found[0].category, "dev-dependencies");
  assert.equal(found[0].risk, "low", "regenerating needs a network and the lockfile, so it is not 'safe'");
  assert.equal(found[0].bytes, 40 * MB);
  assert.match(found[0].reason, /node_modules/);
  assert.match(found[0].consequence, /lockfile/);
});

test("a folder called dist is not a candidate without proof of the ecosystem", () => {
  const v = view("C:\\work\\app", {
    name: "",
    children: [{ name: "dist", children: [{ name: "bundle.js", size: 50 * MB }] }],
  });
  assert.deepEqual(analyzeStorage(v), [], "a generic name on its own must not produce a recommendation");
});

test("a folder called dist next to package.json is build output", () => {
  const v = view("C:\\work\\app", {
    name: "",
    children: [
      { name: "package.json", size: 900 },
      { name: "dist", children: [{ name: "bundle.js", size: 50 * MB }] },
    ],
  });
  const found = analyzeStorage(v);
  assert.equal(found.length, 1);
  assert.equal(found[0].category, "build-output");
  assert.match(found[0].reason, /package\.json/, "the sibling that proved it is named in the reason");
});

test("the sibling check reads the parent folder, not the folder itself", () => {
  // package.json sits inside dist. That proves nothing about a build output.
  const v = view("C:\\work\\app", {
    name: "",
    children: [{ name: "dist", children: [{ name: "package.json", size: 900 }] }],
  });
  assert.deepEqual(analyzeStorage(v), []);
});

test("a folder called cache somewhere unremarkable is left alone", () => {
  const v = view("C:\\photos\\holiday", {
    name: "",
    children: [{ name: "cache", children: [{ name: "a.dat", size: 90 * MB }] }],
  });
  assert.deepEqual(analyzeStorage(v), [], "the word cache is not evidence of anything by itself");
});

test("nested candidates are counted once, at the outermost folder", () => {
  const v = view("C:\\work\\app", {
    name: "",
    children: [
      {
        name: "node_modules",
        children: [
          { name: "top.js", size: 70 * MB },
          { name: "node_modules", children: [{ name: "deep.js", size: 30 * MB }] },
        ],
      },
    ],
  });
  const found = analyzeStorage(v);
  assert.equal(found.length, 1, "the inner tree is not a second candidate");
  assert.equal(found[0].bytes, 100 * MB, "the outer total already includes the inner bytes");
  assert.equal(found.reduce((sum, f) => sum + f.bytes, 0), 100 * MB, "the reclaimable figure is not inflated by nesting");
});

test("a candidate below the size floor is not reported", () => {
  const v = view("C:\\work\\app", {
    name: "",
    children: [{ name: "node_modules", children: [{ name: "tiny.js", size: 2000 }] }],
  });
  assert.deepEqual(analyzeStorage(v), []);
  assert.equal(analyzeStorage(v, { minBytes: 1000 }).length, 1, "a lower floor lets it through");
});

test("the user temporary folder is recognised by its location", () => {
  const v = view("C:\\Users\\X\\AppData\\Local", {
    name: "",
    children: [{ name: "Temp", children: [{ name: "tmp1.bin", size: 12 * MB }] }],
  });
  const found = analyzeStorage(v);
  assert.equal(found.length, 1);
  assert.equal(found[0].category, "temp");
  assert.equal(found[0].risk, "safe");
  assert.match(found[0].reason, /known location/);
});

test("a browser cache is recognised by its profile layout", () => {
  const v = view("C:\\Users\\X\\AppData\\Local\\Google\\Chrome", {
    name: "",
    children: [
      {
        name: "User Data",
        children: [{ name: "Default", children: [{ name: "Cache", children: [{ name: "f_0001", size: 30 * MB }] }] }],
      },
    ],
  });
  const found = analyzeStorage(v);
  assert.equal(found.length, 1);
  assert.equal(found[0].category, "browser-cache");
});

test("an empty browser profile folder is not a cache", () => {
  const v = view("C:\\Users\\X\\AppData\\Local\\Google\\Chrome", {
    name: "",
    children: [{ name: "User Data", children: [{ name: "Cache", children: [{ name: "small", size: 100 }] }] }],
  });
  assert.deepEqual(analyzeStorage(v), [], "the path does not reach a profile folder");
});

test("a link is never a cleanup candidate", () => {
  const v = view("C:\\work\\app", {
    name: "",
    children: [{ name: "node_modules", size: 80 * MB, flags: F_LINK }],
  });
  assert.deepEqual(analyzeStorage(v), [], "removing a junction is not the same as removing its target");
});

test("Windows.old and the Recycle Bin are marked for review, not auto-selected", () => {
  const v = view("C:\\", {
    name: "",
    children: [
      { name: "Windows.old", children: [{ name: "setup.exe", size: 9 * 1024 * MB }] },
      { name: "$Recycle.Bin", children: [{ name: "deleted.dat", size: 3 * 1024 * MB }] },
    ],
  });
  const found = analyzeStorage(v);
  const byCat = Object.fromEntries(found.map((f) => [f.category, f]));
  assert.equal(byCat["windows-old"].risk, "review");
  assert.equal(byCat["recycle-bin"].risk, "review");
  assert.match(byCat["recycle-bin"].consequence, /permanently removes/);
});

test("every finding can explain itself", () => {
  const v = view("C:\\", {
    name: "",
    children: [
      { name: "node_modules", children: [{ name: "a", size: 5 * MB }] },
      { name: "Windows.old", children: [{ name: "b", size: 5 * MB }] },
      { name: "__pycache__", children: [{ name: "c", size: 5 * MB }] },
    ],
  });
  for (const f of analyzeStorage(v)) {
    assert.ok(f.reason.trim().length > 0, `${f.category} has a reason`);
    assert.ok(f.consequence.trim().length > 0, `${f.category} says what happens next`);
    assert.ok(f.bytes > 0);
    assert.ok(f.path.length > 0);
  }
});

test("summarize groups by category, biggest first, with additive totals", () => {
  const v = view("C:\\", {
    name: "",
    children: [
      { name: "a", children: [{ name: "node_modules", children: [{ name: "x", size: 10 * MB }] }] },
      { name: "b", children: [{ name: "node_modules", children: [{ name: "y", size: 30 * MB }] }] },
      { name: "c", children: [{ name: "__pycache__", children: [{ name: "z", size: 2 * MB }] }] },
    ],
  });
  const rows = summarize(analyzeStorage(v));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].category, "dev-dependencies");
  assert.equal(rows[0].bytes, 40 * MB);
  assert.equal(rows[0].count, 2);
  assert.equal(rows[0].ids.length, 2);
  assert.equal(rows[1].category, "tool-cache");
  assert.equal(rows[0].def.risk, "low");
});
