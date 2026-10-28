import { execFileSync } from "node:child_process";
import { resolve } from "path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";

// What this particular build is, stamped in at build time.
//
// The version number sat at 0.1.0 through every change made before the first
// release, so "did my change make it into the copy I am running?" could not be
// answered by looking at it. The About box now prints this, which answers it
// in one glance and cannot drift, because it is taken from the commit that was
// on disk when the bundle was built.
function buildStamp(): string {
  const git = (args: string[]): string => execFileSync("git", args, { encoding: "utf8" }).trim();
  try {
    const commit = git(["rev-parse", "--short", "HEAD"]);
    // electron-vite writes a temporary copy of this very config while it builds,
    // so an unfiltered `git status` reports the tree dirty on every single build
    // and the marker would mean nothing. Its own scratch file is not a change
    // anybody made; everything else still counts.
    const SCRATCH = /electron\.vite\.config\.\d+\.mjs$/;
    const dirty = git(["status", "--porcelain"])
      .split("\n")
      .some((line) => line.trim() !== "" && !SCRATCH.test(line.trim()));
    const at = new Date().toISOString().slice(0, 16).replace("T", " ");
    return `${commit}${dirty ? "+dirty" : ""} · ${at}`;
  } catch {
    return "unknown";
  }
}

// The interface ships under a strict Content Security Policy with no inline
// styles: the production build emits a single stylesheet file, so `style-src`
// needs nothing beyond 'self'. The development server is different, because it
// injects styles through <style> elements. The allowance is therefore added only
// while serving, and the placeholder in index.html keeps that difference visible
// in the HTML rather than hidden in a build flag.
const devStyleAllowance = (): Plugin => ({
  name: "spacewise-dev-csp",
  transformIndexHtml(html, ctx) {
    return html.replace("%STYLE_SRC_EXTRA%", ctx.server ? " 'unsafe-inline'" : "");
  },
});

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define: { __BUILD__: JSON.stringify(buildStamp()) },
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/main/index.ts"),
          scanworker: resolve("src/main/scanworker.ts"),
          dirworker: resolve("src/main/dirworker.ts"),
          dupworker: resolve("src/main/dupworker.ts"),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    plugins: [react(), devStyleAllowance()],
  },
});
