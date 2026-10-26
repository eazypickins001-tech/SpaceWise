// Boots the built main process the way the application does, and fails if it
// throws while loading or never opens a window.
//
// This exists because nothing else reaches the main process at all. Every unit
// test exercises a module, and `smoke` exercises the renderer and the scan
// worker; neither loads out/main/index.js. So a main process that throws before
// it ever reaches app.whenReady() passes the entire suite and ships broken.
// That is not hypothetical: a duplicated ipcMain.handle("dup:cancel", ...)
// registration threw at module load, no window was ever created, and the only
// symptom was Electron's own "Error" dialog — which reads like a problem inside
// the feature being used, not a process that never started.
//
// The user data folder is redirected to one of its own, for two reasons: this
// must not read or write the real settings and licence files, and the
// single-instance lock is scoped to that folder, so a copy of the application
// that happens to be running cannot make this fail for the wrong reason. It is
// cleared at the start of a run rather than the end, because at the end
// Chromium still holds those files open and deleting them would fail.
//
// The window this opens is real and briefly visible. That is deliberate: the
// thing being verified is that a window is created at all.
//
//   npm run build && npm run boot
const { app, BrowserWindow } = require("electron");
const { existsSync, mkdirSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const main = path.join(root, "out", "main", "index.js");
const WAIT_MS = 6000;

const userData = path.join(tmpdir(), "spacewise-boot-userdata");
try {
  rmSync(userData, { recursive: true, force: true }); // leftovers from the last run; nothing holds it now
} catch {
  // A stale folder is not a reason to fail the check.
}
mkdirSync(userData, { recursive: true });
app.setPath("userData", userData);

function fail(message) {
  console.error("BOOT FAILED: " + message);
  console.log("BOOT FAILED");
  app.exit(1);
}

// A throw here would otherwise reach Electron's default handler, which opens a
// dialog and waits for a human — leaving this check hanging forever instead of
// failing. Which is what it did the first time it was run.
process.on("uncaughtException", (err) => fail("unexpected exception: " + (err && err.message ? err.message : String(err))));
process.on("unhandledRejection", (err) => fail("unexpected rejection: " + (err && err.message ? err.message : String(err))));

// A missing build and a main process that throws must not look the same.
if (!existsSync(main)) {
  fail("nothing built at " + main + " — run: npm run build");
} else {
  let loaded = true;
  try {
    require(main);
  } catch (err) {
    loaded = false;
    fail("the main process threw while loading: " + (err && err.message ? err.message : String(err)));
  }

  if (loaded) {
    setTimeout(() => {
      const titles = BrowserWindow.getAllWindows().map((w) => w.getTitle());
      if (!titles.includes("SpaceWise")) {
        fail(
          'no window titled "SpaceWise" after ' + WAIT_MS + " ms (windows seen: " + JSON.stringify(titles) + ")" +
            " — the main process loaded but never finished starting",
        );
        return;
      }
      console.log('boot: main process loaded, window "' + titles.join(", ") + '" opened');
      console.log("BOOT PASSED");
      app.exit(0);
    }, WAIT_MS);
  }
}
