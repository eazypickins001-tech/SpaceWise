// Does the published release actually answer the updater?
//
// This is the one check that has to talk to the network, so it is not part of `npm
// test` or `npm run smoke`: those run offline and should stay that way. Run this after
// publishing a release, or when someone reports that updates do not work.
//
//   npm run verify:feed
//
// What it does, in order:
//
//   1. reads the config the packaged build ships, so it asks what the application asks;
//   2. fetches the feed as an anonymous client, which is how the application fetches
//      it. A private repository answers 404 here, and every "Check for updates" is
//      then a lie however correct the updater code is — that is what this catches;
//   3. asks electron-updater for updates while pretending to be an older install. The
//      published version has to come back as available, with the installer named;
//   4. asks again at the published version, where the answer has to be "no update".
//      An updater that offers the version already installed would offer it on every
//      launch, for ever.
//
// It needs a packaged build present, because that is where `app-update.yml` lives:
// `npm run dist:dir` is enough, and there is nothing to install.
const { app } = require("electron");
const { get } = require("node:https");
const { existsSync, readFileSync } = require("node:fs");
const path = require("node:path");
const { autoUpdater } = require("electron-updater");
const semver = require("semver");

const root = path.resolve(__dirname, "..");
const configPath = path.join(root, "release", "win-unpacked", "resources", "app-update.yml");
const problems = [];
const say = (line) => console.log(line);

// A call that never answers must not leave electron running for ever.
setTimeout(() => {
  console.error("verify:feed gave up waiting for the network");
  app.exit(3);
}, 120_000).unref();

const withTimeout = (promise, ms) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`no answer within ${Math.round(ms / 1000)} s`)), ms)),
  ]);

// GitHub answers an asset URL with a redirect to another host, so this follows them.
function fetchText(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    const req = get(url, { headers: { "user-agent": "spacewise-verify-feed" } }, (res) => {
      const code = res.statusCode ?? 0;
      if (code >= 300 && code < 400 && res.headers.location && redirects > 0) {
        res.resume();
        resolve(fetchText(new URL(res.headers.location, url).toString(), redirects - 1));
        return;
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ code, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.setTimeout(30_000, () => req.destroy(new Error("the request timed out")));
  });
}

const field = (text, name) => {
  const m = new RegExp(`^${name}:\\s*(.+)$`, "m").exec(text);
  return m ? m[1].trim() : "";
};

(async () => {
  await app.whenReady();

  if (!existsSync(configPath)) {
    console.error(`No packaged config at ${configPath}`);
    console.error("Build one first — `npm run dist:dir` is enough, and installs nothing.");
    app.exit(2);
    return;
  }

  const config = readFileSync(configPath, "utf8");
  const provider = field(config, "provider");
  const owner = field(config, "owner");
  const repo = field(config, "repo");
  say(`the packaged build asks: provider ${provider}, ${owner}/${repo}`);
  if (provider !== "github" || !owner || !repo) {
    problems.push(`the packaged config is not a usable github provider: ${JSON.stringify({ provider, owner, repo })}`);
  }

  // 1. The feed, as an anonymous client.
  const feedUrl = `https://github.com/${owner}/${repo}/releases/latest/download/latest.yml`;
  let latest = "";
  try {
    const res = await fetchText(feedUrl, 5);
    say(`anonymous GET ${feedUrl}`);
    say(`  → HTTP ${res.code}${res.body ? `, ${res.body.split("\n").length} lines` : ""}`);
    if (res.code !== 200) {
      problems.push(`the feed answered ${res.code}: no unauthenticated client can read it, and neither can the app`);
    } else {
      latest = res.body;
    }
  } catch (err) {
    problems.push(`the feed could not be fetched: ${err && err.message ? err.message : err}`);
  }

  const published = field(latest, "version");
  const installer = /-\s*url:\s*(.+)$/m.exec(latest);
  if (latest) {
    say(`  → published version ${published || "(none found)"}, installer ${installer ? installer[1].trim() : "(none found)"}`);
    if (!published) problems.push("the feed does not say which version it publishes");
    if (!installer) problems.push("the feed does not name an installer");
  }

  // 2. The updater itself, as an older install and as the current one.
  autoUpdater.forceDevUpdateConfig = true; // this is not a packaged application
  autoUpdater.updateConfigPath = configPath;
  autoUpdater.autoDownload = false;
  autoUpdater.logger = null;

  // `updateInfo` is always what the feed says, whether or not it is newer than this
  // install — the answer to "is there an update" is the flag beside it, and a check
  // that reads the version and calls it the offer reports a defect that is not there.
  const ask = async (pretend, what) => {
    autoUpdater.currentVersion = semver.parse(pretend);
    try {
      const result = await withTimeout(autoUpdater.checkForUpdates(), 45_000);
      const info = result && result.updateInfo;
      const available = Boolean(result && result.isUpdateAvailable);
      say(`as ${pretend.padEnd(6)}: update available = ${available} (the feed says ${info ? info.version : "nothing"})`);
      return available;
    } catch (err) {
      problems.push(`${what} (pretending to be ${pretend}): ${err && err.message ? err.message : err}`);
      return null;
    }
  };

  const older = await ask("0.0.1", "the updater could not check");
  if (older === false) problems.push("an older install was offered nothing, so the update never reaches anyone");

  const current = await ask(published || "0.0.2", "the updater could not check");
  if (current === true) problems.push(`an install already at ${published} was offered the same version again`);

  say("");
  if (problems.length > 0) {
    console.error("FEED FAILED");
    for (const p of problems) console.error(`  - ${p}`);
    app.exit(1);
  } else {
    say(`FEED OK — ${published} is published, reachable without credentials, and would reach an older install.`);
    app.exit(0);
  }
})().catch((err) => {
  console.error("FEED FAILED: " + (err && err.message ? err.message : err));
  app.exit(1);
});
