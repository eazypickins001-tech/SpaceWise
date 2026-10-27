# SpaceWise Engineering Audit

Phase 0 deliverable. Every command, exit code and result in this document was run on the
development machine described below. Nothing here is assumed, and nothing is reported as
passing unless it was observed to pass.

- Audit date: 2026-10-24
- Auditor: automated engineering session (Command Code)
- Audit workspace: `_spacewise-audit\` -- a sibling of the product repository, and outside it
- Product repository: `SpaceWise\` -- the directory this document sits in

---

## 1. Environment inventory

| Item | Value |
| --- | --- |
| Windows edition | Microsoft Windows 11 Pro |
| Windows version | 10.0.22000 (Build 22000) |
| Architecture | x64-based PC |
| Physical memory | 8,094 MB (8 GB) |
| System drive | `C:` — 196,685,590,528 bytes total, 53,957,672,960 bytes free (~50.2 GB) |
| Other volumes | `E:` reported as DriveType 2 (removable, no media present) |
| Git | `git version 2.50.0.windows.1` |
| Node.js | `v22.17.0` |
| npm | `11.16.0` |
| Python | `3.13.2` |
| Rust / Cargo | **Not installed.** `cargo` and `rustc` are not on `PATH`. |
| MSVC / Windows SDK | **Not installed.** `cl`, `msbuild`, `cmake`, `make` and `clang` are all absent. |
| Approx. network throughput | ~1.3–2.0 MB/s observed during package downloads |

### Environmental limitations that shaped the decision

1. **No Rust toolchain and no MSVC linker.** Rust targets for Windows require a linker.
   Without MSVC (or MinGW) the `x86_64-pc-windows-msvc` toolchain cannot link, and the
   `x86_64-pc-windows-gnu` toolchain would require a MinGW install that is also absent.
   Installing Visual Studio Build Tools is a multi-gigabyte download and was not attempted
   during this audit. **Any Rust candidate is therefore unbuildable on this machine as
   found.** This is an environment limitation, not a defect in those projects.
2. **npm 11.16 script-approval gate.** `npm install` completed but reported
   `allowScripts` for `electron`, `esbuild`, `koffi` and `electron-winstaller`, so their
   install scripts did not run. `npm install` alone does **not** produce a working tree
   here; `npm approve-scripts` (or an equivalent) is required. This is recorded because a
   fresh clone on this machine will otherwise appear to install correctly and then fail.
3. **Slow link.** A 168 MB download interrupted once and a 131 MB PySide6 wheel took ~1
   minute. Verification steps were chosen with this in mind; `node_modules` was copied
   between audit and product trees rather than re-downloaded.
4. **No code-signing certificate.** No Authenticode certificate is present on this
   machine. No signing step was attempted, and no claim of signing is made anywhere.

---

## 2. Candidate repositories

All four were cloned with `git clone --depth 50` into isolated directories under
`_spacewise-audit\`. No existing repository was modified, reset, or overwritten.

| # | Repository | Commit audited | Version | Language / stack | Files (`git ls-files`) |
| --- | --- | --- | --- | --- | --- |
| 1 | `rodrigokiller/diskplot` | `8787cf6b01840cddd263915ffaf286c78c678b05` | 0.4.0 | Electron + React 19 + strict TS | 141 |
| 2 | `PatrickJnr/crapcleaner` | `09e6e59138da670907eaadb05d3230d6b5b9593f` | 1.4.2 | Python + PySide6 | 302 |
| 3 | `xangelix/edirstat` | `0ba84593c3338c3873279406f3c3ae5ba0c92048` | 2.2.0 | Rust + egui | 223 |
| 4 | `skyflyt/treelens` | `a199d0511eb0301f1aa8e6fa30653beccf53ca91` | 0.7.0 | Rust + Tauri 2 | 69 |

### 2.1 diskplot — summary

Windows-first disk-space visualiser. Squarified treemap plus a sortable tree in one window,
scan snapshot comparison, developer clutter detection, duplicate detection, search and
filters, Recycle-Bin deletion, English + Brazilian Portuguese.

Architecture worth noting:

- Electron main process owns privileged work; renderer is React + TypeScript.
- A typed, narrow `api` object exposed over `contextBridge`; all IPC channels follow
  `domain:action` (`scan:start`, `snap:load`, `shell:trash`, …).
- `sandbox: true` and `contextIsolation: true` on every `BrowserWindow`.
- The scan result is not a tree of objects. It is a set of typed arrays
  (`parent`, `size`, `logical`, `mtime`, `flags`, `files`, `nameOff`, `names`,
  `childStart`, `childList`, `ext`) with all names in one UTF-8 buffer — roughly 60 bytes
  per file. This is what lets a multi-million-file scan move between threads without
  copying, and what makes search a single native substring scan.
- Scanning runs in `worker_threads` (`scanworker`, `dirworker`), duplicate hashing in
  `dupworker`.
- On Windows, directory listing is batched through the Win32 API using `koffi`
  (prebuilt FFI). **This matters here: it needs no C++ compiler.**
- Junctions and symlinks are listed but never followed; unreadable folders are counted
  and sampled, never fatal.

### 2.2 crapcleaner — summary

A local disk cleaner and storage analyser with an unusually rigorous safety posture, and
the most complete test suite of the four.

- Explicitly refuses registry cleaning; a test (`tests/test_no_registry_cleaner.py`)
  enforces its absence.
- Safety tiers (`SAFE`, `LOW_RISK`, `REVIEW`, `DANGEROUS`), a protected-path layer applied
  to both automated cleanup and manual deletions, Recycle Bin by default, and a
  manifest of exactly what each run removed.
- Capability registry (`crapcleaner/system/capabilities.py`) as single source of truth per
  platform, with per-OS backends.
- **92 test files.** `pytest` passes on this machine (§4.2).

### 2.3 edirstat — summary

Rust + egui disk usage analyser with a work-stealing walker, NTFS `$MFT` reader,
arena-based zero-copy tree, BLAKE3 deduplication, compressed snapshots and 19 locales.
Technically strong. **Build blocked here** (no Rust/MSVC). Additional build risk: its
`Cargo.toml` patches `winit` from a third-party git branch
(`xangelix/winit`, branch `blur-fix`), which is a supply-chain and reproducibility
consideration for a commercial product.

### 2.4 treelens — summary

Rust + Tauri 2, Windows-only by design, with an NTFS `$MFT` fast path, squarified treemap,
virtualised directory list, age-heat overlay and a recycle-bin-only deletion model.
Its `PLAN.md` is an unusually good engineering spec and was read in full — it is the
source of several safety rules adopted into SpaceWise (§7). **Build blocked here** (no
Rust/MSVC, and Tauri additionally needs the WebView2 build chain).

---

## 3. License and provenance audit

Not one of the four candidates is usable on the strength of its own `LICENSE` file alone.
The findings below come from reading the actual license files and dependency manifests.

| Candidate | Project license | Findings |
| --- | --- | --- |
| diskplot | MIT, Copyright (c) 2026 Rodrigo Sanguanini | Runtime deps are MIT: `electron-updater` (MIT), `koffi` (MIT, `LICENSE.txt`). Electron itself is MIT and bundles Chromium/Node with their own notices (`LICENSES.chromium.html`, emitted by the Electron package). **Bundled assets carry a different license** — see below. |
| crapcleaner | MIT, Copyright (c) 2026 Patrick Jr. | Single runtime dependency `PySide6`, which is LGPL-3.0 (with the Qt commercial option). PyInstaller bundling of LGPL Qt is workable but requires the LGPL notice and a relinking/object-file-replacement statement. Not a blocker; a real obligation. |
| edirstat | MIT, Copyright (c) 2026 Cody Neiman | Large transitive Rust dependency graph; ships font subsets (Google Noto) with their own OFL terms; uses `cargo-about` to generate third-party license output. Distribution is intentionally paid on Itch.io for prebuilt binaries — legal to reuse under MIT, but the project's own commercial positioning should be considered before adopting. |
| treelens | MIT, Copyright (c) 2026 Skylar Pearce | Rust/Tauri; WebView2 runtime is redistributed by Microsoft under its own terms. |

### 3.1 Bundled-asset finding (the one that actually matters)

diskplot ships **Barlow** and **Barlow Semi Condensed** via `@fontsource/barlow` and
`@fontsource/barlow-semi-condensed`. Reading `node_modules/@fontsource/barlow/LICENSE`
confirms:

> This Font Software is licensed under the SIL Open Font License, Version 1.1.

The OFL is permissive for embedding and commercial redistribution, but it requires the
copyright notice and license text to be carried with the font software. **These fonts are
built into the renderer bundle** in this environment (`out/renderer/assets/barlow-*.woff*`
appear in the production build output, §4.4), so SpaceWise distributes OFL font software
and must ship the OFL notice. This is recorded in `THIRD-PARTY-NOTICES.md`.

**Conclusion: MIT on a repository does not make the distributed artefact MIT-only.**
diskplot is MIT + OFL-1.1 (font assets). That is fully compatible with commercial
redistribution, provided both notices are preserved.

---

## 4. Build and test verification (evidence)

### 4.1 diskplot — `npm install`

```
cd _spacewise-audit\diskplot
npm install --no-audit --no-fund
```

Result: `added 420 packages in 2m`, with the `allowScripts` gate blocking five install
scripts (electron, esbuild ×2, koffi, electron-winstaller). `npm rebuild` and
`npm approve-scripts --all` were then run, and the binaries were fetched.

Verified afterwards:
- `node_modules/electron/dist/electron.exe` — present
- `node_modules/@esbuild/win32-x64/` — present

### 4.2 crapcleaner — install and test

```
python -m venv .venv
.venv\Scripts\python -m pip install -e .
.venv\Scripts\python -m pip install pytest pytest-cov ruff mypy pyyaml
.venv\Scripts\python -m pytest -q
```

Result (full run, uninterrupted):

```
1351 passed, 5 skipped in 1119.39s (0:18:39)
```

**This is real, verified evidence of a healthy suite.** One caveat recorded for honesty:
an earlier attempt used `pip install -r requirements-dev.txt`, which re-resolves
`PySide6>=6.5` loosely; that install was interrupted mid-download and briefly left
`shiboken6 6.11.1` alongside `PySide6 6.12.0`, which makes Qt fail to load
(`ImportError: DLL load failed while importing QtWidgets`). Forcing
`shiboken6==6.12.0` repaired it and the suite above is the clean result. The lesson is
recorded because it affects anyone reproducing this build: **do not pin `PySide6>=6.5`
loosely in a project that packages Qt.**

### 4.3 edirstat and treelens — build not attempted

```
> cargo --version
'cargo' is not recognized as an internal or external command
> rustc --version
'rustc' is not recognized as an internal or external command
```

No Rust toolchain and no MSVC linker are present. A build could not be run, so **no claim
of build or test success is made for either project.** A toolchain install (Rust + Visual
Studio Build Tools, several GB) is a prerequisite before either can be evaluated on merit.

### 4.4 diskplot — typecheck, test, build

```
npm run typecheck   →  tsc --noEmit            → exit 0 (pass)
npm test            →  tsx --test src/shared/*.test.ts src/main/*.test.ts
                       TAP: 1..0  # tests 0  # pass 0  # fail 0   → "passes", running zero tests
npm run build       →  electron-vite build     → exit 0 (success, all three environments)
```

**Critical finding: diskplot has no test files at all.** `npm test` exits successfully
because the glob matches nothing. `dir /s src\*.test.ts` and `src\*.spec.ts` return no
files. The documented test command is aspirational. This is the single largest quality
gap in the otherwise best-fitting candidate, and it is why SpaceWise's first engineering
task after adoption was to write a real test suite rather than to add features (§6).

Build output observed (production, `npm run build`):

```
out/main/index.js                 19.08 kB
out/main/scanworker.js            12.67 kB
out/main/dirworker.js              6.26 kB
out/main/dupworker.js              2.77 kB
out/main/chunks/snapshots-*.js     3.99 kB
out/preload/index.js               3.87 kB
out/renderer/assets/index-*.css   31.68 kB
out/renderer/assets/index-*.js   881.34 kB
```

---

## 5. Security audit

Performed by reading the source of the adopted foundation. Runtime exploitation testing
was not performed and is not claimed.

### 5.1 Process and window hardening (diskplot, adopted)

| Control | Status | Evidence |
| --- | --- | --- |
| Context isolation | Present | `webPreferences.contextIsolation: true`, `src/main/index.ts` |
| Renderer sandbox | Present | `webPreferences.sandbox: true` |
| Node integration in renderer | Absent (Electron default `false`) | no override present |
| Preload surface | Typed, narrow, explicit allow-list | `src/preload/index.ts` exposes one frozen `api` object; no raw `ipcRenderer` |
| Navigation lockdown | Present | `will-navigate` → `preventDefault()`; `setWindowOpenHandler` → `{ action: "deny" }` |
| External link policy | Restricted to `https:` | `shell:openExternal` guard in main; window-open handler re-checks |
| Content Security Policy | Present, now tightened | see §5.3 |

### 5.2 Findings and their disposition

1. **IPC handlers accept arbitrary absolute paths from the renderer.**
   `shell:showInFolder`, `shell:trash`, `fs:measure`, `fs:paste` and `fs:stat` take
   renderer-supplied paths with no root scoping. Because the renderer is first-party
   application code, this is not a classic injection vector — but it does mean a
   renderer compromise (XSS in a future feature, a malicious plugin) escalates straight
   to arbitrary file operation. **Recorded as a known limitation.** SpaceWise's cleanup
   path adds an explicit validated-root layer (§6, Phase 3) rather than relying on the
   renderer being trustworthy.
2. **Shell command construction.** `clip:set` builds a PowerShell command but passes the
   file paths through the *environment* (`$env:SPACEWISE_PATHS`), never by string
   interpolation into the command text. No command injection was found. Logged as a
   positive finding worth preserving.
3. **Time-of-check/time-of-use.** `fs:paste` checks a destination and then writes with
   `createWriteStream(dest, { flags: "wx" })` (exclusive create) and resolves a free name
   first, which closes the common overwrite race. It uses `rename` when possible and
   falls back to copy + `rm` on `EXDEV`. Reasonable.
4. **Recycle Bin.** `shell:trash` calls Electron `shell.trashItem` per path and reports
   per-path success/failure rather than throwing. Failures are surfaced, not swallowed.
   Good, and matches SpaceWise's "recoverable by default" principle.
5. **Junction / symlink handling.** `F_LINK` nodes are recorded and never traversed.
   Cycle risk is avoided by construction rather than by a visited-set. Good.
6. **Silent error suppression.** Unreadable folders increment a counter and populate
   `errorSamples`; the UI reports them. Not suppressed. Good.
7. **Registry cleaning / unsafe optimisation.** None present in diskplot.
8. **Telemetry.** None. The only outbound calls are the update check via
   `electron-updater` and user-initiated external links.
9. **Powershell invocation.** `execFile("powershell.exe", ["-NoProfile","-NonInteractive",
   "-Command", …])` with a 6-second timeout and `windowsHide`. `-NoProfile` is correct.

### 5.3 Change made during adoption

The upstream CSP was `default-src 'self'; img-src 'self' data:; font-src 'self';
style-src 'self' 'unsafe-inline'`. It was **tightened** to:

```
default-src 'none'; script-src 'self'; style-src 'self';
font-src 'self'; img-src 'self' data:; connect-src 'self';
base-uri 'none'; form-action 'none'; object-src 'none'
```

The `style-src` allowance was later **removed as well**, once it was tested instead of
assumed. The stated reason for keeping it -- that React sets inline `style` attributes --
was wrong: React writes through the CSS object model, which a `style-src` directive does
not govern. `npm run smoke` now asserts all three cases (an injected `<style>` is refused,
an injected `style` attribute is refused, a CSS object model write is not) against the
built interface, so the reason is pinned by a test rather than by a comment. The
development server still needs the allowance, because Vite injects `<style>` elements;
that is filled in through a placeholder in `index.html` and applies only while serving.

---

## 6. Functional and performance audit

**Honest scope statement.** The full functional and performance protocol in the brief
(synthetic dataset with known sizes, hard links, junctions, long paths, unreadable paths,
cancellation timing, duplicate content verification, memory ceilings at large file
counts) was **not** executed during this phase. diskplot ships no test files, so there was
no existing harness to extend, and writing that harness is Phase 1 work rather than audit
work. What follows is what *was* established.

### 6.1 Established by reading and by build

- **Size semantics.** `ScanTable` carries two columns per node: `size` (bytes on disk,
  from the platform) and `logical` (real byte length). The README states "size on disk" is
  shown by default. SpaceWise inherits this distinction and must keep it explicit — the
  brief's requirement not to confuse logical and allocated size is satisfied by the data
  model, and is asserted in the Phase 1 tests.
- **Aggregation correctness.** `finishTable` (`src/shared/table.ts`) sums sizes, logical
  sizes and file counts upward in a single reverse pass, relying on the invariant that
  every parent index is lower than its children. `previewTable` does the same for a
  partial scan. Both are pure functions over typed arrays and are directly testable.
- **Memory shape.** Roughly 60 bytes per file, stated by the project and consistent with
  the column list. This was not measured at scale on this machine (8 GB RAM, 50 GB free).
- **Cancellation.** Two-step: `scan:stop` asks the worker for a final partial table,
  `scan:cancel` retires the worker, and `retire()` posts `cancel` and only calls
  `terminate()` after a 4-second grace period, to avoid tearing down a thread mid-native
  call. Cancellation *latency* was not measured.
- **Unreadable paths.** Counted, sampled, and surfaced in the UI; not fatal.

### 6.2 Not verified (explicitly listed, not glossed over)

- Reported vs. known file/folder totals on a controlled dataset.
- Hard-link double counting (diskplot's README acknowledges `WinSxS` looks larger than it
  is; SpaceWise inherits this and must surface it, not hide it).
- Symlink/junction traversal-loop behaviour under an adversarial link graph.
- Duplicate detection correctness against planted byte-identical files.
- Memory ceiling at multi-million file counts.
- Scan cancellation latency measurement.
- Whether a scan of a protected path (`C:\System Volume Information`) degrades gracefully.

These become Phase 1 acceptance tests (§9).

---

## 7. Architecture comparison

Scored 1–5 against criteria that matter for *this* product. Scores are the auditor's
judgement informed by the evidence above, not measurements.

| Criterion | A. diskplot (Electron/TS) | B. treelens (Rust/Tauri) | C. edirstat (Rust/egui) | D. crapcleaner (Python/PySide6) |
| --- | --- | --- | --- | --- |
| Windows reliability | 4 | 4 | 4 | 4 |
| Code quality / maintainability | 4 | 5 | 4 | 4 |
| Scanning accuracy | 4 | 4 | 5 | 3 |
| Security & cleanup safety | 3 | 4 | 4 | **5** |
| UI quality | **5** | 4 | 3 | 3 |
| Test coverage | **1** | 3 | 3 | **5** |
| Perf. at large file counts | 4 | **5** | **5** | 2 |
| Ease of adding premium features | **5** | 4 | 3 | 3 |
| Packaging / update support | **5** | 4 | 3 | 4 |
| Licensing clarity | 5 | 5 | 4 | 3 (LGPL Qt) |
| Integration effort (lower is better) | **5** | 2 | 2 | 3 |
| Long-term maintenance risk | 4 | 4 | 4 | 4 |
| **Buildable on this machine, today** | **Yes** | **No** | **No** | Yes |

### Chosen foundation: **A, diskplot (adapted)**

### Why

1. **It is the only candidate that both fits the product and builds here.** Option B and
   option C fail the most basic gate: no Rust toolchain and no MSVC linker. Choosing an
   unbuildable foundation would mean shipping something unverified, which the brief
   explicitly forbids.
2. **The security architecture is already the shape the brief demands**, and was verified
   in source: context isolation, renderer sandbox, a narrow typed preload bridge,
   `domain:action` IPC, navigation lockdown, and an explicit external-link policy. Option
   D's safety *semantics* are stronger, but its UI is not a storage-visualisation product
   and its Qt bundling carries LGPL obligations.
3. **The data model is genuinely good.** Columnar typed arrays with a shared UTF-8 name
   buffer are the right answer for multi-million-file scans and keep every analysis
   function a pure, testable transform — which directly serves the brief's insistence on
   measured, explainable findings.
4. **Windows speed without a compiler.** The `koffi` batched Win32 directory listing gets
   the important performance property (one syscall returns hundreds of entries) with a
   prebuilt FFI, so no MSVC is required for the shipped app.
5. **Packaging and premium boundaries are cheap to add.** `electron-builder` already
   produces NSIS + portable targets, and a main-process licence check plus entitlements is
   a small, well-bounded addition.

### What was explicitly *not* done

Per the brief's warning, entire repositories were not merged. **crapcleaner's code is not
copied into SpaceWise.** Its safety model — safety tiers, a protected-path layer applied
to every deletion, a manifest of what each run removed, and a test that enforces the
absence of registry cleaning — is adopted as *design*, reimplemented in TypeScript for
SpaceWise, and credited. That keeps the shipped component set to one upstream lineage
plus original code, which is the smaller maintainable set.

---

## 8. Components: reuse, rewrite, exclude

### Reused as-is (MIT, notice preserved)

| Component | Path in SpaceWise |
| --- | --- |
| Scan engine, columnar table builder, partial-preview builder | `src/shared/table.ts` |
| Typed IPC bridge | `src/preload/index.ts` |
| Scan / directory / duplicate workers | `src/main/scanworker.ts`, `dirworker.ts`, `dupworker.ts` |
| Snapshot store and reader | `src/main/snapshots.ts` |
| Squarified treemap layout and canvas renderer | `src/renderer/src/lib/treemap.ts`, `components/Treemap.tsx` |
| Tree view, panels, icon set, design tokens | `src/renderer/src/components/*`, `styles.css` |
| Snapshot comparison, top-files, by-type, clutter detection | `src/renderer/src/lib/analysis.ts` — clutter detection was removed after this audit, with `ClutterPane`; see `ROADMAP.md` |
| Scan-history reduction format | `src/shared/reduce.ts` |
| Design system (paper/grid themes, 16px icon grid) | `styles.css`, `components/Icon.tsx` |

### Excluded during adoption

| Excluded | Reason |
| --- | --- |
| `android/`, `src/mobile/`, `capacitor.config.json`, `vite.mobile.config.ts`, `@capacitor/*` | Android surface. Not a Windows product; removes a whole platform's maintenance burden. |
| `site/`, `scripts/build-site.mjs` | Upstream marketing landing page and its generator. Not part of the application; upstream branding. |
| `scripts/gradle.mjs`, `scripts/release.mjs` | Android Gradle wrapper and an upstream-specific GitHub release script. |
| `CLAUDE.md`, `DESIGN.md`, `PRODUCT.md`, `notes/` | Upstream-internal documents carrying upstream branding and product decisions. |
| `.github/` workflows | Referenced Android/Capacitor steps. SpaceWise CI is written fresh. |
| `package-lock.json` | Regenerated against SpaceWise's dependency set. |

`src/renderer/src/components/Mobile.tsx`, `Phone.tsx` and `lib/phone.ts` are **kept** but
are inert: they are gated on `api.compact` / `api.phone`, both of which are `false` /
`undefined` on desktop. Removing them would mean carving up a 2,196-line `App.tsx` for no
functional gain; they are recorded here so a future maintainer is not surprised by them.

### Rewritten / added (original SpaceWise work)

| Module | Purpose |
| --- | --- |
| `src/shared/table.test.ts` | First real tests for the adopted aggregation core (upstream had none) |
| `src/shared/storage-intelligence.ts` (+ `.test.ts`) | Explainable storage categories with risk, evidence and recovery notes |
| `src/shared/cleanup.ts` (+ `.test.ts`) | Cleanup plan, path validation and revalidation, audit record types |
| `src/main/license.ts` (+ `.test.ts`) | Ed25519 licence verification, entitlements, offline grace |
| `src/main/audit-log.ts` | Local, append-only cleanup and scan audit records |

---

## 9. Known risks and unresolved blockers

| # | Item | Severity | Status |
| --- | --- | --- | --- |
| 1 | Upstream had **zero tests**; adopted core was unverified | High | Partly closed — tests added in Phase 1 |
| 2 | `shell:trash` / `fs:*` IPC accept unscoped renderer paths | Medium | **Closed**, with the copy-source residual recorded — one policy in `src/main/scope.ts`, tested |
| 3 | `style-src 'unsafe-inline'` in CSP | Low | **Closed** — the allowance was removed; asserted by `npm run smoke` |
| 4 | No code-signing certificate; SmartScreen will warn | Medium | **Blocker for "commercial-ready" claims** — requires a purchased certificate, which requires the owner's decision and money |
| 5 | No GitHub repository, domain, or release feed exists yet | Medium | **Partly closed** — `REPO` points at the GitHub repository now; `SITE` and `AUTHOR_SITE` are still empty because no website or author page exists, so those two buttons remain inert |
| 6 | Licence **signing** private key does not exist yet | Medium | Open — vendor-side keygen tool provided; published key must be embedded |
| 7 | Update feed (`electron-updater`) unconfigured | Medium | **Closed** — a GitHub provider is configured and `app-update.yml` ships inside the package. Downloads stay manual, which is what makes it safe while unsigned; see `SECURITY.md` |
| 8 | Rust candidates unverified | Low | Environmental, not a defect. Documented so the decision can be revisited if a toolchain is installed |
| 9 | Hard links counted once per name (inherited) | Low | Inherited and disclosed in UI copy |
| 10 | Large-scale memory and cancellation latency unmeasured | Medium | Open — Phase 1 benchmark target |

### Blockers requiring the owner's input (not worked around)

Per the brief, work stopped short of anything destructive, credential-bound or external:

- A **code-signing certificate** (money + identity verification).
- A **GitHub repository / release feed** (account, publishing decision).
- The **Ed25519 licence signing private key** (must be generated and stored by the vendor,
  never committed).
- An **AI provider key**, if optional AI summaries are pursued (explicitly out of scope
  until the core is reliable).

---

## 10. Decision summary

- **Foundation:** diskplot (MIT, commit `8787cf7`), adapted — Electron main process for
  privileged work, React + TypeScript renderer, typed preload bridge, worker-thread
  scanning, columnar arena scan model.
- **Adopted as design, reimplemented:** crapcleaner's safety model (tiers, protected
  paths on every deletion, removal manifests, enforced no-registry-cleaning).
- **Rejected:** Rust/Tauri/egui candidates — not buildable on this machine; not adopted
  without evidence.
- **Distributed artefact is MIT + OFL-1.1** (Barlow fonts). Both notices are shipped.
- **Next:** `docs/ROADMAP.md` phases 1–6, beginning with the test suite the foundation
  lacked.
