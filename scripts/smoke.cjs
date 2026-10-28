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
const { app, BrowserWindow, ipcMain } = require("electron");
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

function stubChannels() {
  const answer = (channel, value) => ipcMain.handle(channel, () => value);
  answer("drives:list", [STUB.drive]);
  answer("app:info", { version: "0.0.0", platform: "win32", home: "C:\\smoke", build: STUB.build });
  answer("lic:status", { status: "none", plan: "free", pro: false, preservesUserData: true, payload: null, problem: null, daysLeft: null });
  answer("ai:status", { configured: false, baseUrl: "", model: "", hasKey: false, problem: null, unlocked: false });
  answer("protect:list", STUB.folders);
  answer("snap:list", []);
  answer("clean:history", []);
  answer("clip:get", null);
  answer("slow:check", { facts: STUB.facts, findings: STUB.findings });
  // Answered for the same reason, and so that a screen asking for something this
  // harness does not stub shows up as a console error rather than being lost in a
  // list of noise nobody reads twice.
  answer("win:setOverlay", undefined);
  answer("win:setTitle", undefined);
  answer("win:list", []);
  answer("upd:check", undefined);
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

app.on("window-all-closed", () => app.quit());

app
  .whenReady()
  .then(async () => {
    // The screens under test ask the main process for their content. Answer first,
    // so what is read below is the screen drawing an answer rather than an error
    // state that happens to look the same at a glance.
    stubChannels();

    const win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 820,
      webPreferences: { preload, sandbox: true, contextIsolation: true },
    });
    win.webContents.on("console-message", (...args) => onConsole(args));
    win.webContents.on("render-process-gone", (_e, d) => problems.push(`the renderer process died: ${d.reason}`));
    win.webContents.on("preload-error", (_e, file, err) => problems.push(`the preload failed: ${file}: ${err.message}`));

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
