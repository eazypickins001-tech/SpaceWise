// A smoke test for the built interface.
//
// It loads the real production renderer in a hidden window with the real
// preload and the real Content Security Policy, then checks three things a
// build can silently get wrong:
//
//   1. React actually mounted.
//   2. The stylesheet actually applied.
//   3. The policy refused nothing the application needs.
//
// It then opens the sheets a person can reach — Settings from the View menu,
// "Why is it slow?" from the start screen, About and the shortcut list from Help —
// and reads each one back. The three checks above say whether the application is
// there; they say nothing about what it drew. A section that quietly stops
// rendering, a list that comes back empty where content was handed in, an About
// box with no build stamp: every one of those passed this file until this part
// existed.
//
// The main process is not part of this harness, so those screens are fed a fixed
// scripted answer, and what is asserted is what they draw from it.
//
// Then it does the same for the views, which need a finished scan: it starts one from
// the drive row, answers it with a table the built worker really produced, and clicks
// each tab. Nothing else in this file puts a scan in the window.
//
// Then it uses the window rather than looking at it: a row is clicked and sent to the
// Recycle Bin, and two rows are ticked and sent together, with both outcomes checked
// against the disk and the panes that drew them.
//
// It then probes what the policy actually governs, because the reason
// `style-src 'unsafe-inline'` could be dropped is a claim worth testing rather
// than restating:
//
//   - an injected <style> element          must be refused
//   - an injected style="..." attribute    must be refused
//   - a write through the CSS object model must NOT be refused
//
// The third is what React does for style={{...}}, and the interface depends on
// it. A check that cannot fail is not a check, so all three are asserted.
//
// It also starts the built main process in a child and fails if it throws while
// loading or never opens a window. That is the one part of the application the
// unit tests never load, so a main process that dies before app.whenReady()
// otherwise passes everything.
//
//   npm run build && npm run smoke
const { app, BrowserWindow, ipcMain, shell } = require("electron");
const { spawnSync } = require("node:child_process");
const { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { Worker } = require("node:worker_threads");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const html = path.join(root, "out", "renderer", "index.html");
const preload = path.join(root, "out", "preload", "index.js");

if (!existsSync(html) || !existsSync(preload)) {
  console.error("Nothing built yet. Run: npm run build");
  process.exit(2);
}

const problems = [];
const messages = [];

function record(level, message, source) {
  messages.push({ level: String(level), message: String(message), source: source ? path.basename(String(source)) : "" });
}

const refusals = () => messages.filter((m) => /Content Security Policy|Refused to/i.test(m.message));

// Electron changed this event's shape between versions, so accept both.
function onConsole(args) {
  const b = args[1];
  if (typeof b === "object" && b !== null) record(b.level, b.message, b.sourceId);
  else record(b, args[2], args[4]);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The scan coordinator is the one part of the application no unit test can
// reach, because it needs worker threads and a pool of real directory readers.
// It is exercised here instead, against the built file, on a real folder with a
// known answer. This is the check that would catch a mistake in the wiring
// between the pool and the walk, which is exactly what is untestable in source.
function scanOnce(root) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, "..", "out", "main", "scanworker.js"), {
      workerData: { root, snapshotDir: "", quiet: true },
    });
    const timer = setTimeout(() => reject(new Error("the scan worker did not answer within 60 s")), 60_000);
    const stop = (fn, arg) => {
      clearTimeout(timer);
      fn(arg);
    };
    worker.on("message", (msg) => {
      if (msg.type === "done") stop(resolve, msg.table);
      else if (msg.type === "error") stop(reject, new Error(String(msg.error)));
    });
    worker.on("error", (err) => stop(reject, err));
  });
}

async function checkScan() {
  const dir = mkdtempSync(path.join(tmpdir(), "spacewise-scan-"));
  try {
    mkdirSync(path.join(dir, "nested", "deeper"), { recursive: true });
    writeFileSync(path.join(dir, "one.bin"), Buffer.alloc(1000));
    writeFileSync(path.join(dir, "two.bin"), Buffer.alloc(2000));
    writeFileSync(path.join(dir, "nested", "three.bin"), Buffer.alloc(4000));
    writeFileSync(path.join(dir, "nested", "deeper", "four.bin"), Buffer.alloc(8000));

    const table = await scanOnce(dir);
    // The bytes written, not the bytes on disk. `AllocationSize` as reported while
    // enumerating a folder comes from the directory entry, and Windows does not hold
    // it still: measured through a direct GetFileInformationByHandleEx call on a
    // folder written a moment earlier, the same file read 4096 at 1.2 s and 0 at
    // 2.4 s. Asserting on that made this check fail about one run in three, which is
    // worse than not checking at all. The logical total does not move.
    const seen = {
      entries: table.n,
      files: table.files[0],
      dirs: table.dirs,
      written: table.logical[0],
      onDisk: table.size[0],
      errors: table.errors,
    };
    if (seen.files !== 4) problems.push(`the scan found ${seen.files} files, expected 4`);
    if (seen.dirs !== 3) problems.push(`the scan found ${seen.dirs} folders, expected 3`);
    if (seen.entries !== 7) problems.push(`the scan found ${seen.entries} entries, expected 7`);
    if (seen.written !== 15_000) problems.push(`the scan measured ${seen.written} bytes written, expected exactly the 15000 written to the folder`);
    if (seen.errors !== 0) problems.push(`the scan reported ${seen.errors} unreadable locations, expected none`);
    return seen;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The main process is started in a child, not in this one. Loading it here would
// give this harness two windows and two competing lifecycle handlers, and a
// throw in it would take the rest of the checks down with it — hiding the very
// failures worth reporting. The child asserts that it reached app.whenReady()
// and opened a window, and says so on stdout; anything else is a failure,
// including the child dying before it printed anything.
function checkBoot() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // otherwise the child runs as plain Node and cannot load main
  const r = spawnSync(process.execPath, [path.join(__dirname, "boot.cjs")], { encoding: "utf8", timeout: 60_000, env });
  const out = String(r.stdout || "") + String(r.stderr || "");
  const passed = /BOOT PASSED/.test(out);
  if (!passed) {
    // Prefer the line carrying the reason over the bare marker, since the marker
    // on its own says nothing — the whole point of this check is the reason.
    const lines = out.split(/\r?\n/);
    const reason = lines.find((l) => /BOOT FAILED:/.test(l)) || lines.find((l) => /BOOT FAILED/.test(l));
    problems.push("the application did not boot: " + (reason ? reason.trim().replace(/^BOOT FAILED:\s*/, "") : `no word from the boot check (exit code ${r.status})`));
  }
  return passed;
}

// ── the interface past the start screen ──────────────────────────────────────
//
// Everything above looks at the window from the outside: its title, its font,
// its policy. That catches a build that will not mount, and it says nothing about
// whether a sheet draws, because the window was never told to open one. Two
// defects reached a release through exactly that gap, so the sheets are opened
// here and read.
//
// The main process is not part of this harness, so the channels these screens
// call are answered from a fixed script rather than from this computer. That is
// the point: an answer is an input like any other, and what the screen does with
// it — including what it says about a reading it could not take — is the thing
// worth pinning. A live reading would make the result depend on whichever machine
// the smoke test happens to run on.
const UNREAD = "no counter of this kind on this machine";
const STUB = {
  build: "smoke000 · 2000-01-01 00:00",
  drive: { path: "C:\\", label: "System", total: 500_000_000_000, free: 120_000_000_000 },
  folders: ["C:\\smoke\\Never touch this"],
  // 2.4% free, so the sentence has figures to carry, and one reading missing, so
  // the "could not be read" branch has to draw as well.
  facts: {
    space: { totalBytes: 500_000_000_000, freeBytes: 12_000_000_000 },
    memory: null,
    disk: null,
    io: null,
    boot: null,
    startup: null,
    missing: { memory: UNREAD },
  },
  findings: [
    {
      id: "space-full",
      severity: "high",
      values: { percentFree: 2, freeBytes: 12_000_000_000, totalBytes: 500_000_000_000 },
      action: { kind: "windows", page: "storagesense" },
    },
  ],
};

function stubChannels(win, fixture) {
  const answer = (channel, value) => ipcMain.handle(channel, () => value);
  // The drive's path is the fixture, so the scan the window starts can be a real
  // scan of a real folder. Its label stays a volume label, which is what the start
  // screen draws.
  answer("drives:list", [{ ...STUB.drive, path: fixture.dir }]);
  answer("app:info", { version: "0.0.0", platform: "win32", home: "C:\\smoke", build: STUB.build });
  answer("lic:status", { status: "none", plan: "free", pro: false, preservesUserData: true, payload: null, problem: null, daysLeft: null });
  answer("ai:status", { configured: false, baseUrl: "", model: "", hasKey: false, problem: null, unlocked: false });
  answer("protect:list", STUB.folders);
  answer("snap:list", []);
  answer("clean:history", []);
  answer("clip:get", null);
  answer("slow:check", { facts: STUB.facts, findings: STUB.findings });
  answer("dup:cancel", undefined);
  answer("dup:start", undefined);
  answer("fs:measure", { ok: true, kind: "file", name: "measured", size: 1234, mtime: 0 });
  answer("fs:stat", { ok: true, created: 0, modified: 0, accessed: 0, readOnly: false });

  // A scan the window asks for is answered with the table the built worker really
  // produced for the fixture. It arrives on the channel the main process uses, so
  // the renderer takes the same path it takes in the application.
  ipcMain.handle("scan:start", (_e, root) => {
    if (String(root) !== fixture.dir) problems.push(`the window asked to scan "${root}", expected the fixture`);
    setTimeout(() => {
      if (fixture.table) win.webContents.send("scan:done", fixture.table, null);
    }, 60);
    return { ok: true, root: fixture.dir };
  });

  // Deleting is answered with the same call the main process makes, so a file that
  // the interface says it removed really is out of the way, and the Recycle Bin
  // holds it afterwards. What is not copied here is main's own guard — the
  // protection list and the "has this file changed since the scan" recheck — which
  // has its own tests against the real code.
  ipcMain.handle("shell:trash", async (_e, targets) => {
    const out = [];
    for (const t of targets ?? []) {
      try {
        await shell.trashItem(String(t?.path ?? ""));
        out.push({ path: t.path, ok: true });
      } catch (err) {
        out.push({ path: t?.path, ok: false, error: String((err && err.message) || err) });
      }
    }
    return out;
  });

  // Answered for the same reason, and so that a screen asking for something this
  // harness does not stub shows up as a console error rather than being lost in a
  // list of noise nobody reads twice.
  answer("win:setOverlay", undefined);
  answer("win:setTitle", undefined);
  answer("win:list", []);
  answer("upd:check", undefined);
}

// The sheets above need no scan. Every other view does, and until this existed no
// test had ever put one in the window, so the panes were drawn by nothing at all.
// The scan here is a real one, run by the built worker over a folder whose shape is
// known, and it is handed to the window the way the main process hands it over. The
// folder is kept for the life of the run, because the rows the views draw are paths
// that really exist.
const VIEW_FIXTURE = {
  big: 300_000,
  small: 1_000,
  text: 2_000,
  bare: 500, // no extension, so the types view has a row for "no extension"
  deep: 40_000,
};

// The files the interaction pass sends to the Recycle Bin. Named once here, so the
// fixture, the assertions and the report cannot drift apart.
const DOOMED = ["doomed-one.bin", "doomed-two.bin", "doomed-three.bin"];

async function makeFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "spacewise-view-"));
  mkdirSync(path.join(dir, "nested"), { recursive: true });
  writeFileSync(path.join(dir, "big.bin"), Buffer.alloc(VIEW_FIXTURE.big));
  writeFileSync(path.join(dir, "small.bin"), Buffer.alloc(VIEW_FIXTURE.small));
  writeFileSync(path.join(dir, "notes.txt"), Buffer.alloc(VIEW_FIXTURE.text));
  writeFileSync(path.join(dir, "README"), Buffer.alloc(VIEW_FIXTURE.bare));
  writeFileSync(path.join(dir, "nested", "deep.bin"), Buffer.alloc(VIEW_FIXTURE.deep));
  DOOMED.forEach((name, i) => writeFileSync(path.join(dir, name), Buffer.alloc((i + 1) * 1_000)));
  return { dir, table: await scanOnce(dir) };
}

// Each tab is clicked the way a person clicks it, then the pane beside the tab bar
// is read. `wants` is a string or a pattern that has to be in that pane: the tab
// label itself is stripped out first, so a label that happens to match cannot pass
// the check on its own.
async function checkViews(win, fixture) {
  const notes = [];
  const run = (script) => win.webContents.executeJavaScript(script);

  // The scan is started from the drive row, which is the only way in.
  const started = await run(`(() => {
    const b = Array.from(document.querySelectorAll("button")).filter((e) => e.textContent.trim() === "Scan")[0];
    if (!b) return false;
    b.click();
    return true;
  })()`);
  if (!started) {
    problems.push("the start screen has no Scan button for the drive it was given");
    return notes;
  }

  // It lands asynchronously, so wait for the tab bar rather than guessing a delay.
  let labels = [];
  for (let i = 0; i < 40 && labels.length === 0; i++) {
    await sleep(200);
    labels = await run(`Array.from(document.querySelectorAll('[role="tab"]')).map((b) => b.textContent.trim())`);
  }

  const expected = ["Tree", "Largest", "Types", "Clean up", "Duplicates", "Changes"];
  if (labels.length === 0) {
    problems.push("the scan finished and the window never showed a tab bar");
    return notes;
  }
  if (labels.join(" | ") !== expected.join(" | ")) {
    problems.push(`the tab bar reads "${labels.join(", ")}", expected "${expected.join(", ")}"`);
  }
  notes.push({ label: "after a real scan", detail: `the tab bar appeared with ${labels.length} tabs` });

  const readPane = () =>
    run(`(() => {
      const aside = document.querySelector("aside.schedule");
      if (!aside) return { pane: "", selected: "" };
      const copy = aside.cloneNode(true);
      const bar = copy.querySelector(".tabs");
      if (bar) bar.remove();
      const on = Array.from(document.querySelectorAll('[role="tab"]')).filter((b) => b.getAttribute("aria-selected") === "true")[0];
      return { pane: copy.textContent || "", selected: on ? on.textContent.trim() : "" };
    })()`);

  const wanted = [
    ["Tree", "big.bin"],
    ["Largest", "largest files in this scan"],
    ["Types", "no extension"],
    ["Clean up", /Nothing to suggest for this scan|could be reclaimed/],
    ["Duplicates", "identical content"],
    ["Changes", "This view is part of Premium"],
  ];

  for (const [label, wants] of wanted) {
    const clicked = await run(`(() => {
      const b = Array.from(document.querySelectorAll('[role="tab"]')).filter((e) => e.textContent.trim() === ${JSON.stringify(label)})[0];
      if (!b) return false;
      b.click();
      return true;
    })()`);
    if (!clicked) {
      problems.push(`the tab bar has no "${label}" tab`);
      continue;
    }
    await sleep(400);
    const { pane, selected } = await readPane();
    const drew = typeof wants === "string" ? pane.indexOf(wants) >= 0 : wants.test(pane);
    if (selected !== label) problems.push(`the "${label}" tab did not become the selected one (it is "${selected}")`);
    if (!drew) problems.push(`the "${label}" tab drew a pane with ${JSON.stringify(wants)} missing from it`);
    notes.push({ label: `${label} tab`, detail: drew ? `drew its own content, ${pane.length} characters` : "drew the wrong pane" });
  }

  return notes;
}

// Each sheet is opened the way a person opens it — a row in a menu, or the button
// on the start screen — then read, then closed. A sheet that fails to open is
// reported and the rest still runs, so one broken sheet cannot hide the others.
async function checkSheets(win) {
  const notes = [];
  const run = (script) => win.webContents.executeJavaScript(script);

  const openMenu = async (name) => {
    const there = await run(`(() => {
      const b = document.querySelector('[data-menu="' + ${JSON.stringify(name)} + '"]');
      if (!b) return false;
      b.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      return true;
    })()`);
    if (!there) {
      problems.push(`the ${name} menu is not in the menu bar`);
      return false;
    }
    await sleep(250);
    return true;
  };

  const clickRow = (label) =>
    run(`(() => {
      const want = ${JSON.stringify(label)};
      const el = Array.from(document.querySelectorAll('[role="menuitem"]')).filter((e) => e.textContent.trim().indexOf(want) === 0)[0];
      if (!el) return false;
      el.click();
      return true;
    })()`);

  // textContent and not innerText: this window is never shown, and innerText
  // depends on layout having been brought up to date.
  const read = () =>
    run(`(() => {
      const d = Array.from(document.querySelectorAll("dialog")).filter((x) => x.open)[0];
      if (!d) return { open: false };
      const h = d.querySelector("h2");
      return {
        open: true,
        title: h ? h.textContent.trim() : "",
        text: d.textContent || "",
        slowRows: d.querySelectorAll(".slow-row").length,
        slowUnread: d.querySelectorAll(".slow-missing li").length,
        slowActions: d.querySelectorAll(".slow-row button").length,
        keyRows: d.querySelectorAll("table.keys tbody tr").length,
        // A row with a label and no key is the failure worth catching here, and it
        // is not a count: the table grows and shrinks as shortcuts are added.
        keyOrphans: Array.from(d.querySelectorAll("table.keys tbody tr")).filter(
          (r) => !r.querySelector("th") && r.querySelectorAll("kbd").length === 0,
        ).length,
      };
    })()`);

  const closeSheet = async () => {
    const clicked = await run(`(() => {
      const d = Array.from(document.querySelectorAll("dialog")).filter((x) => x.open)[0];
      if (!d) return false;
      const b = Array.from(d.querySelectorAll("footer button")).filter((e) => e.textContent.trim() === "Close")[0];
      if (!b) return false;
      b.click();
      return true;
    })()`);
    await sleep(300);
    return clicked;
  };

  const gone = async (what) => {
    if ((await read()).open) problems.push(`${what} stayed open after Close`);
  };

  const say = (label, detail) => notes.push({ label, detail });

  // The start screen, with the drive the main process would have handed it.
  const start = String(await run(`document.body.textContent || ""`));
  const sawDrive = start.indexOf(STUB.drive.label) >= 0;
  if (!sawDrive) problems.push("the start screen did not list the drive it was given");
  say("start screen", sawDrive ? `listed ${STUB.drive.label}` : "did not list its drive");

  // View → Settings.
  if (await openMenu("view")) {
    if (!(await clickRow("Settings"))) problems.push("the View menu has no Settings row");
    else {
      const s = await read();
      if (!s.open) problems.push("View → Settings opened nothing");
      else {
        const wants = ["Theme", "Language", "Protection", STUB.folders[0]];
        const missing = wants.filter((w) => s.text.indexOf(w) < 0);
        if (missing.length > 0) problems.push(`the settings sheet does not draw: ${missing.join(", ")}`);
        if (s.title !== "Settings") problems.push(`the settings sheet is titled "${s.title}"`);
        say("View → Settings", missing.length === 0 ? "every row, and the protected folder" : `missing ${missing.join(", ")}`);
        if (!(await closeSheet())) problems.push("the settings sheet has no Close button");
        await gone("the settings sheet");
      }
    }
  }

  // "Why is it slow?", from the button on the start screen.
  const asked = await run(`(() => {
    const b = Array.from(document.querySelectorAll("button")).filter((e) => e.textContent.trim() === "Why is it slow?")[0];
    if (!b) return false;
    b.click();
    return true;
  })()`);
  if (!asked) problems.push("the start screen has no \"Why is it slow?\" button");
  else {
    await sleep(700); // the sheet asks the main process, then draws the answer
    const slow = await read();
    if (!slow.open) problems.push("\"Why is it slow?\" opened nothing");
    else {
      if (slow.slowRows !== 1) problems.push(`the diagnosis drew ${slow.slowRows} findings, expected the one it was given`);
      if (slow.text.indexOf("2% free") < 0) problems.push("the diagnosis did not put the measured figures into the sentence");
      if (slow.slowUnread !== 1) problems.push(`the diagnosis listed ${slow.slowUnread} readings it could not take, expected 1`);
      if (slow.text.indexOf(UNREAD) < 0) problems.push("the diagnosis did not name the reading it could not take");
      if (slow.slowActions < 1) problems.push("the diagnosis drew no action for a finding that has one");
      say("Why is it slow?", `${slow.slowRows} finding drawn, ${slow.slowUnread} reading named as unread`);
      if (!(await closeSheet())) problems.push("the diagnosis has no Close button");
      await gone("the diagnosis sheet");
    }
  }

  // Help → About, which is where the build stamp has to appear.
  if (await openMenu("help")) {
    if (!(await clickRow("About"))) problems.push("the Help menu has no About row");
    else {
      const about = await read();
      if (!about.open) problems.push("Help → About opened nothing");
      else {
        if (about.text.indexOf(STUB.build) < 0) problems.push("the About box does not show the build stamp it was handed");
        say("Help → About", about.text.indexOf(STUB.build) >= 0 ? "showed the build stamp" : "showed no build stamp");
        if (!(await closeSheet())) problems.push("the About box has no Close button");
        await gone("the About box");
      }
    }

    // Help → Keyboard shortcuts. The menu is opened again, because choosing a row
    // closes it.
    if (await openMenu("help")) {
      if (!(await clickRow("Keyboard shortcuts"))) problems.push("the Help menu has no Keyboard shortcuts row");
      else {
        const keys = await read();
        if (!keys.open) problems.push("Help → Keyboard shortcuts opened nothing");
        else {
          if (keys.keyRows < 20) problems.push(`the shortcut list drew ${keys.keyRows} rows, expected the whole table`);
          if (keys.keyOrphans > 0) problems.push(`the shortcut list has ${keys.keyOrphans} rows with a label and no key`);
          if (keys.text.indexOf("F11") < 0) problems.push("the shortcut list is missing a key it should list");
          say("Help → Keyboard shortcuts", `${keys.keyRows} rows, none without a key`);
          if (!(await closeSheet())) problems.push("the shortcut list has no Close button");
          await gone("the shortcut list");
        }
      }
    }
  }

  return notes;
}

// The views above only have to draw. This part uses them: a row is clicked and sent
// to the Recycle Bin, and then two rows are ticked and sent together. The deletion is
// real — the harness answers `shell:trash` with the same Electron call the main
// process makes — so what is asserted is that the files left the disk, not that some
// call was made.
async function checkInteraction(win, fixture) {
  const notes = [];
  const run = (script) => win.webContents.executeJavaScript(script);
  const onDisk = (name) => existsSync(path.join(fixture.dir, name));

  const showTab = async (label) => {
    const found = await run(`(() => {
      const b = Array.from(document.querySelectorAll('[role="tab"]')).filter((e) => e.textContent.trim() === ${JSON.stringify(label)})[0];
      if (!b) return false;
      b.click();
      return true;
    })()`);
    await sleep(350);
    return found;
  };

  const clickRow = (name) =>
    run(`(() => {
      const row = Array.from(document.querySelectorAll(".trow")).filter((r) => (r.textContent || "").indexOf(${JSON.stringify(name)}) >= 0)[0];
      if (!row) return false;
      row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      return true;
    })()`);

  // Delete is the key the row list itself owns, so it is pressed on the grid that
  // holds the rows rather than on the window.
  const pressDelete = () =>
    run(`(() => {
      const grid = document.querySelector(".rows");
      if (!grid) return false;
      grid.focus();
      grid.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }));
      return true;
    })()`);

  const dialog = () =>
    run(`(() => {
      const d = Array.from(document.querySelectorAll("dialog")).filter((x) => x.open)[0];
      if (!d) return { open: false, title: "", text: "" };
      const h = d.querySelector("h2");
      return { open: true, title: h ? h.textContent.trim() : "", text: d.textContent || "" };
    })()`);

  const pressIn = (scope, label) =>
    run(`(() => {
      const root = ${scope};
      if (!root) return false;
      const b = Array.from(root.querySelectorAll("button")).filter((e) => e.textContent.trim() === ${JSON.stringify(label)})[0];
      if (!b) return false;
      b.click();
      return true;
    })()`);

  // What the pane on screen is showing, by row. The tree and the lists draw their
  // rows the same way, so one reader serves both. A failure here names the rows it
  // saw rather than only the one it wanted, because "the row is still there" is a
  // claim about the whole list.
  const paneRows = () =>
    run(`Array.from(document.querySelectorAll(".trow")).map((r) => {
      const cell = r.querySelector(".cell-name");
      return (cell ? cell.textContent : "").trim();
    })`);

  const waitGone = async (name) => {
    for (let i = 0; i < 30 && onDisk(name); i++) await sleep(100);
    return !onDisk(name);
  };

  // 1. Click a row. 2. Press Delete, then cancel: nothing may move.
  if (!(await showTab("Tree"))) problems.push("the interaction pass found no Tree tab");
  const clicked = await clickRow(DOOMED[0]);
  if (!clicked) problems.push("the tree has no row for a file the fixture wrote");
  else {
    const selected = await run(`(() => {
      const on = Array.from(document.querySelectorAll('.trow[aria-selected="true"]'));
      return on.length === 1 ? on[0].textContent.trim() : "";
    })()`);
    if (selected.indexOf(DOOMED[0]) < 0) problems.push(`clicking the row for ${DOOMED[0]} selected "${selected}"`);
    else notes.push({ label: "click a row", detail: `selected ${DOOMED[0]}` });

    await pressDelete();
    await sleep(400);
    const asked = await dialog();
    if (!asked.open) problems.push("Delete on a selected file asked nothing");
    else {
      if (asked.title !== "Send to the Recycle Bin?") problems.push(`the confirmation is titled "${asked.title}"`);
      if (asked.text.indexOf(DOOMED[0]) < 0) problems.push("the confirmation does not name the file it is about to send");
      else notes.push({ label: "Delete on a row", detail: "asked, and named the file" });

      if (!(await pressIn(`Array.from(document.querySelectorAll("dialog")).filter((x) => x.open)[0]`, "Cancel"))) {
        problems.push("the confirmation has no Cancel button");
      }
      await sleep(300);
      if (!onDisk(DOOMED[0])) problems.push(`Cancel sent ${DOOMED[0]} to the Recycle Bin anyway`);
      else notes.push({ label: "Cancel", detail: "left the file where it was" });
    }
  }

  // 3. The same again, confirmed: the file has to leave the disk.
  await clickRow(DOOMED[0]);
  await pressDelete();
  await sleep(400);
  const confirm = await dialog();
  if (!confirm.open) problems.push("Delete asked nothing the second time");
  else {
    const confirmed = await pressIn(`Array.from(document.querySelectorAll("dialog")).filter((x) => x.open)[0]`, "Send to Recycle Bin");
    if (!confirmed) problems.push("the confirmation has no button to send the file");
    const gone = await waitGone(DOOMED[0]);
    if (!gone) problems.push(`${DOOMED[0]} is still on disk after the confirmation`);
    else {
      // The file leaves the disk a moment before the call that asked for it comes
      // back to the renderer, so the row is given time to go rather than read once.
      let rows = await paneRows();
      for (let i = 0; i < 20 && rows.some((name) => name.indexOf(DOOMED[0]) >= 0); i++) {
        await sleep(100);
        rows = await paneRows();
      }
      if (rows.some((name) => name.indexOf(DOOMED[0]) >= 0)) {
        problems.push(`${DOOMED[0]} left the disk but the tree still lists it two seconds later: ${JSON.stringify(rows)}`);
      } else {
        notes.push({ label: "Confirm", detail: `${DOOMED[0]} left the disk and the tree` });
      }
    }
  }

  // 4. Two rows ticked, then the pane's own Delete button: both have to go.
  if (!(await showTab("Largest"))) problems.push("the interaction pass found no Largest tab");
  const ticked = await run(`(() => {
    const want = ${JSON.stringify([DOOMED[1], DOOMED[2]])};
    const boxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
    let n = 0;
    for (const name of want) {
      const b = boxes.filter((e) => e.getAttribute("aria-label") === name)[0];
      if (!b) continue;
      b.click();
      n++;
    }
    return n;
  })()`);
  if (ticked !== 2) problems.push(`only ${ticked} of the two files could be ticked in the largest list`);
  else {
    await sleep(250);
    const bar = await run(`(() => {
      const pane = document.querySelector("aside.schedule .pane");
      if (!pane) return null;
      const el = pane.querySelector(".pane-bar");
      const del = Array.from(pane.querySelectorAll(".pane-bar button")).filter((e) => e.textContent.trim() === "Send to Recycle Bin")[0];
      return { text: el ? el.textContent : "", disabled: del ? del.disabled : null };
    })()`);
    if (!bar) problems.push("the largest list drew no pane bar");
    else {
      if (bar.text.indexOf("Selected: 2") < 0) problems.push(`the pane bar reads "${bar.text}", expected two files selected`);
      if (bar.disabled !== false) problems.push("the pane's Delete button is still disabled with two files ticked");
      notes.push({ label: "tick two rows", detail: bar.text.indexOf("Selected: 2") >= 0 ? "the bar reported two selected" : "the bar reported something else" });

      const sent = await pressIn(`document.querySelector("aside.schedule .pane")`, "Send to Recycle Bin");
      if (!sent) problems.push("the pane's Delete button could not be pressed");
      await sleep(400);
      const many = await dialog();
      if (!many.open) problems.push("the pane's Delete asked nothing");
      else {
        if (many.text.indexOf("2 items") < 0) problems.push(`the confirmation reads "${many.text}", expected two items`);
        await pressIn(`Array.from(document.querySelectorAll("dialog")).filter((x) => x.open)[0]`, "Send to Recycle Bin");
        const both = (await waitGone(DOOMED[1])) && (await waitGone(DOOMED[2]));
        if (!both) problems.push(`after a bulk delete, ${DOOMED.filter(onDisk).join(" and ")} are still on disk`);
        else {
          // The list the rows were ticked in has to lose both of them as well.
          const stillListed = async () => {
            const rows = await paneRows();
            return DOOMED.filter((name) => rows.some((row) => row.indexOf(name) >= 0));
          };
          let left = await stillListed();
          for (let i = 0; i < 20 && left.length > 0; i++) {
            await sleep(100);
            left = await stillListed();
          }
          if (left.length > 0) problems.push(`the largest list still shows ${left.join(" and ")} after a bulk delete`);
          else notes.push({ label: "delete two at once", detail: `${DOOMED[1]} and ${DOOMED[2]} left the disk and the list` });
        }
      }
    }
  }

  return notes;
}

app.on("window-all-closed", () => app.quit());

app
  .whenReady()
  .then(async () => {
    // A real scan of a folder with a known shape, kept for the life of the run: the
    // views below draw paths that have to exist on disk to be drawn at all.
    let fixture = null;
    try {
      fixture = await makeFixture();
    } catch (err) {
      problems.push(`the fixture could not be scanned: ${err && err.message ? err.message : String(err)}`);
    }

    const win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 820,
      webPreferences: { preload, sandbox: true, contextIsolation: true },
    });
    win.webContents.on("console-message", (...args) => onConsole(args));
    win.webContents.on("render-process-gone", (_e, d) => problems.push(`the renderer process died: ${d.reason}`));
    win.webContents.on("preload-error", (_e, file, err) => problems.push(`the preload failed: ${file}: ${err.message}`));

    // The screens under test ask the main process for their content. Answer before
    // anything loads, so what is read below is a screen drawing an answer rather than
    // an error state that happens to look the same at a glance. The window is needed
    // for the one channel that answers by sending something back to it.
    stubChannels(win, fixture || { dir: path.join(tmpdir(), "spacewise-no-fixture"), table: null });

    await win.loadFile(html);
    await sleep(1500); // let React mount and the first IPC round trip settle

    const probe = await win.webContents.executeJavaScript(`(() => {
      const body = getComputedStyle(document.body);
      const rootEl = document.getElementById("root");
      return {
        title: document.title,
        rootChildren: rootEl ? rootEl.children.length : -1,
        background: body.backgroundColor,
        fontFamily: body.fontFamily,
        hasApi: typeof window.api === "object" && window.api !== null,
        hasNodeRequire: typeof window.require === "function",
      };
    })()`);

    if (probe.title !== "SpaceWise") problems.push(`title is "${probe.title}", expected "SpaceWise"`);
    if (probe.rootChildren < 1) problems.push("the root element is empty: React did not mount");
    if (!probe.hasApi) problems.push("the preload bridge is missing");
    if (probe.hasNodeRequire) problems.push("require() is reachable from the renderer");

    // A computed style still at its initial value means the stylesheet was not
    // applied, which is exactly what an over-tight policy would cause.
    const styled = Boolean(probe.fontFamily) && !/^(times|serif)/i.test(probe.fontFamily.trim());
    if (!styled) problems.push(`the stylesheet did not apply (font-family is "${probe.fontFamily}")`);

    const duringLoad = refusals().length;

    const stepped = async (script) => {
      const from = refusals().length;
      await win.webContents.executeJavaScript(script);
      await sleep(350);
      return refusals().length > from;
    };

    const refusedStyleElement = await stepped(`(() => {
      const s = document.createElement("style");
      s.textContent = "body{outline:1px solid red}";
      document.head.appendChild(s);
    })()`);

    const refusedAttribute = await stepped(`(() => {
      const el = document.createElement("div");
      el.id = "csp-probe";
      document.body.appendChild(el);
      el.setAttribute("style", "outline:1px solid red");
    })()`);

    // The case the interface relies on.
    const refusedCssom = await stepped(`(() => {
      const el = document.getElementById("csp-probe") || document.body;
      el.style.color = "rgb(1,2,3)";
      el.style.paddingLeft = "7px";
    })()`);

    if (duringLoad > 0) {
      for (const r of refusals().slice(0, duringLoad)) problems.push(`refused during load: ${r.message}`);
    }
    if (!refusedStyleElement) problems.push("an injected <style> was NOT refused, so this check proves nothing");
    if (!refusedAttribute) problems.push("an injected style attribute was NOT refused");
    if (refusedCssom) problems.push("a CSS object model write WAS refused, which the interface needs");

    // The sheets, opened the way a person opens them and read for content.
    const sheets = await checkSheets(win);

    // The tabs, after a scan the window itself asked for.
    const views = fixture ? await checkViews(win, fixture) : [];

    // Then the same window is used: rows are clicked, ticked and deleted for real.
    const moves = fixture ? await checkInteraction(win, fixture) : [];

    // The production scan, on a real folder with a known answer.
    let scan = null;
    try {
      scan = await checkScan();
    } catch (err) {
      problems.push(`the scan worker failed: ${err && err.message ? err.message : String(err)}`);
    }

    // The application actually starting, which no unit test covers.
    const booted = checkBoot();

    const errors = messages.filter((m) => m.level === "error" || m.level === "3");
    const reported = errors.filter((m) => !/Content Security Policy|Refused to/i.test(m.message));

    console.log("");
    console.log("renderer probe");
    console.log("  title            " + probe.title);
    console.log("  mounted          " + (probe.rootChildren > 0 ? "yes (" + probe.rootChildren + " root children)" : "NO"));
    console.log("  stylesheet       " + (styled ? "applied" : "NOT APPLIED") + " (font-family " + probe.fontFamily + ")");
    console.log("  preload bridge   " + (probe.hasApi ? "present" : "MISSING"));
    console.log("  refused at load  " + duringLoad);
    console.log("");
    console.log("  production scan, on a folder with a known answer");
    if (scan) {
      console.log("    entries          " + scan.entries + " (expected 7)");
      console.log("    files / folders  " + scan.files + " / " + scan.dirs + " (expected 4 / 3)");
      console.log("    bytes written    " + scan.written + " (expected exactly 15000)");
      console.log("    on disk          " + scan.onDisk + " (the directory entry's number, not asserted on)");
      console.log("    unreadable       " + scan.errors);
    } else {
      console.log("    did not run");
    }
    console.log("");
    console.log("  the application starts");
    console.log("    main process boots, window opens   " + (booted ? "yes (correct)" : "NO"));
    console.log("");
    console.log("  the interface past the start screen");
    for (const n of sheets) console.log("    " + n.label.padEnd(26) + n.detail);
    if (views.length > 0) {
      console.log("");
      console.log("  the views, from a scan the window asked for");
      for (const n of views) console.log("    " + n.label.padEnd(26) + n.detail);
    }
    if (moves.length > 0) {
      console.log("");
      console.log("  clicking and deleting for real");
      for (const n of moves) console.log("    " + n.label.padEnd(26) + n.detail);
    }
    console.log("");
    console.log("  policy behaviour");
    console.log("    inline <style> element      " + (refusedStyleElement ? "refused (correct)" : "ALLOWED (unexpected)"));
    console.log("    inline style attribute      " + (refusedAttribute ? "refused (correct)" : "ALLOWED (unexpected)"));
    console.log("    CSS object model write      " + (refusedCssom ? "REFUSED (unexpected)" : "allowed (correct, React needs this)"));
    if (reported.length > 0) {
      console.log("");
      console.log("  console errors " + reported.length + ":");
      for (const m of reported.slice(0, 12)) console.log("    " + m.message.slice(0, 160));
    }
    console.log("");

    if (fixture) rmSync(fixture.dir, { recursive: true, force: true });

    if (problems.length > 0) {
      console.error("SMOKE FAILED");
      for (const p of problems) console.error("  - " + p);
      process.exitCode = 1;
    } else {
      console.log("SMOKE PASSED");
    }
    app.quit();
  })
  .catch((err) => {
    console.error("SMOKE FAILED: " + (err && err.message ? err.message : String(err)));
    process.exitCode = 1;
    app.quit();
  });
