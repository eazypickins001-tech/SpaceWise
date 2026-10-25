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
//   npm run build && npm run smoke
const { app, BrowserWindow } = require("electron");
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
    const seen = { entries: table.n, files: table.files[0], dirs: table.dirs, bytes: table.size[0], errors: table.errors };
    if (seen.files !== 4) problems.push(`the scan found ${seen.files} files, expected 4`);
    if (seen.dirs !== 3) problems.push(`the scan found ${seen.dirs} folders, expected 3`);
    if (seen.entries !== 7) problems.push(`the scan found ${seen.entries} entries, expected 7`);
    if (!(seen.bytes >= 15_000)) problems.push(`the scan measured ${seen.bytes} bytes, expected at least the 15000 written`);
    if (seen.errors !== 0) problems.push(`the scan reported ${seen.errors} unreadable locations, expected none`);
    return seen;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

app.on("window-all-closed", () => app.quit());

app
  .whenReady()
  .then(async () => {
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

    // The production scan, on a real folder with a known answer.
    let scan = null;
    try {
      scan = await checkScan();
    } catch (err) {
      problems.push(`the scan worker failed: ${err && err.message ? err.message : String(err)}`);
    }

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
      console.log("    bytes on disk    " + scan.bytes + " (at least 15000)");
      console.log("    unreadable       " + scan.errors);
    } else {
      console.log("    did not run");
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
