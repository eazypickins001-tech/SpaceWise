# Third-party notices

SpaceWise is distributed under the MIT Licence (see `LICENSE`). It contains code and assets
from other projects, under the terms below.

---

## 1. Diskplot — MIT

Substantial portions of this application's source are adapted from **Diskplot**.

```
MIT License

Copyright (c) 2026 Rodrigo Sanguanini
```

Retrieved from `https://github.com/rodrigokiller/diskplot` at commit
`8787cf6b01840cddd263915ffaf286c78c678b05` (version 0.4.0).

What was taken:

- the Electron main-process structure, the typed preload bridge and its
  `domain:action` IPC channel convention;
- the columnar scan model and its builders (`parent`, `size`, `logical`, `mtime`, `flags`,
  `files`, `nameOff`, `names`, `childStart`, `childList`, `ext`);
- the scan, directory and duplicate worker threads;
- the snapshot store and comparison;
- the squarified treemap layout and canvas renderer, the tree view, the panels, the icon set
  and the design tokens;
- top-files, by-type, clutter and duplicate-candidate analysis.

What was changed:

- identity: product name, application id, package name, window titles, environment variable
  prefixes (`DISKPLOT_*` → `SPACEWISE_*`) and the internal event namespace;
- the Android/Capacitor surface was removed (application, mobile views, Gradle, landing page);
- the Content Security Policy was tightened;
- new modules were added for storage intelligence, safe cleanup planning, audit records and
  licensing, with the first test suite the codebase has had.

The upstream copyright notice above is preserved in full and must remain with any
redistribution of this code.

---

## 2. Barlow and Barlow Semi Condensed — SIL Open Font License 1.1

**This is a separate licence obligation from the MIT licence on the code.**

The interface bundles the Barlow and Barlow Semi Condensed web fonts via the
`@fontsource/barlow` and `@fontsource/barlow-semi-condensed` packages. The built renderer
includes the font binary files (`.woff` / `.woff2`), so SpaceWise *distributes font software*.

Copyright (c) 2017 The Barlow Project Authors (https://github.com/jpt/barlow).

The fonts are licensed under the **SIL Open Font License, Version 1.1**. That licence permits
bundling, embedding, commercial use and redistribution, and requires that:

- the copyright notice and this licence accompany the font software (satisfied here);
- the fonts are not sold on their own;
- any modified version does not use the Reserved Font Name "Barlow" (this project does not
  modify the fonts).

Full licence text: https://scripts.sil.org/OFL

---

## 3. Runtime dependencies

| Package | Licence | Purpose |
| --- | --- | --- |
| `electron` | MIT | Application runtime (bundles Chromium and Node.js, which carry their own notices in `LICENSES.chromium.html` inside the Electron package) |
| `electron-updater` | MIT | Update checking and installation |
| `koffi` | MIT | Prebuilt FFI used for batched Win32 directory listing |

## 4. Build-time dependencies

Not distributed with the application, listed for completeness: React and React DOM (MIT),
Vite (MIT), electron-vite (MIT), `@vitejs/plugin-react` (MIT), TypeScript (Apache-2.0),
electron-builder (MIT), tsx (MIT), `@fontsource/*` (OFL-1.1, see above).

## 5. Design adopted from a separate project

The **concept** of the safety model used in `src/shared/cleanup.ts` and
`src/shared/storage-intelligence.ts` — safety tiers, a protected-path layer applied to every
deletion, and a per-run record of what was removed — was informed by a reading of
**CrapCleaner** (MIT, Copyright (c) 2026 Patrick Jr.).

**No CrapCleaner source code was copied.** Its implementation is Python; these modules are
original TypeScript written for this project. The attribution is recorded here because the
debt is real even though the code is not.

---

## Notices that must accompany a binary release

1. `LICENSE` (MIT, this project).
2. This file, including the Diskplot MIT notice and the SIL OFL notice and disclaimer.
3. The Chromium/Node notices shipped inside the Electron package as
   `LICENSES.chromium.html`.

No software in this distribution is under a copyleft licence that would affect the licensing
of SpaceWise itself.

---

## Missing notices — action required

An SBOM has not been generated. The dependency list above was read from `package.json` and
the installed packages' own `license` fields, not produced by a tool. Before a commercial
release, generate a full inventory with a tool such as `npx license-checker --summary` (for
the Node tree) and commit its output here. This is tracked as a release blocker in
`docs/ROADMAP.md`.
