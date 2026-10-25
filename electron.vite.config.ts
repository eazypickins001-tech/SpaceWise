import { resolve } from "path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";

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
