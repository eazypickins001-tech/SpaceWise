# SpaceWise

**Understand your storage. Reclaim space safely. Keep your PC organized.**

SpaceWise is a local-first Windows storage intelligence and safe maintenance
application. It scans a drive or folder, shows what is actually consuming space,
explains what can be reclaimed and why, and lets you act on it deliberately.

It is not a one-click cleaner. There is no registry cleaning, no "PC health
score", no scareware, and no telemetry. Nothing is deleted without a rule, a
reason, a preview and a confirmation.

---

## Status

This repository is at **Phase 1–5 of 6**. Be sceptical of anything not listed here.

| Area | State |
| --- | --- |
| Storage scanner (drives, folders, progress, cancel, unreadable paths) | Working, inherited and now covered by tests |
| Treemap + folder tree + file-type breakdown + search/filter | Working |
| Scan snapshots and comparison ("what grew") | Working |
| Duplicate finder (size → hash, content-verified) | Working |
| Storage intelligence (explainable categories with risk + evidence) | Working — drives the **Clean up** tab |
| Safe cleanup planner (validation, revalidation, audit record) | Working — review dialog, per-item results, local audit log |
| Diagnosis ("why is it slow?") | Working — six read-only readings (free space, commit charge against the commit limit, disk health, disk latency, last start-up, startup items), ranked with the evidence behind each and a link to the Windows screen that owns the fix. It changes nothing and makes no speed claim. |
| Licensing (Ed25519, entitlements, offline grace) | Working — Help → Licence. Premium gates the Changes view (`compare.scans`), unlimited duplicate results (`duplicates.unlimited`) and the optional summary (`ai.summary`). |
| Optional AI storage summary | **Off by default.** Written from the findings the rules already made, never selects anything, and the exact message is shown before it is sent. Needs a licence and an endpoint you configure. |
| Content Security Policy | Strict — no inline styles and no inline scripts. Asserted by `npm run smoke`, which also proves it can detect a refusal. |
| Installer + portable build | Published as **`v0.1.1`** (and `v0.1.0` before it) — installer and portable, both built from the tagged commit and checked against `latest.yml` before upload. The repository is public, so the updater can reach the feed: `npm run verify:feed` checks that it answers without credentials and that an older install is offered the published version. |
| Code signing | **Not done.** No certificate. SmartScreen will warn. |

`docs/ENGINEERING_AUDIT.md` records the evidence behind every claim above, including
what was *not* verified.

---

## What it does

- **Scan.** Any folder or drive. Live progress, cancellation, and unreadable paths
  counted and reported rather than hidden. Junctions and symlinks are listed but
  never traversed, so nothing is double counted through a link.
- **See.** A squarified treemap and a sortable folder tree in one window, kept in
  sync. Drill in and back out. Search and filter by name, size, age and type.
- **Understand.** Storage is grouped into categories that explain themselves: what the
  category contains, why it grew, and what removal actually costs you.
- **Compare.** Each scan leaves a snapshot. Scan the same place again later and SpaceWise
  reports what grew, what is new and what is gone.
- **Clean safely.** Every candidate has a rule, a reason, a size and a risk level. Paths
  are validated against the folder you scanned, revalidated immediately before the action,
  and by default sent to the Recycle Bin.

### Two sizes, never confused

Every file is measured twice: what it occupies on disk, and its logical length. They
differ sharply for compressed, sparse and cloud placeholder files. The interface says
which one it is showing, and the tests assert the two are never conflated.

---

## Build and run

Requirements: Windows 10/11, Node.js 22 or newer.

```bat
git clone <this repository>
cd SpaceWise
npm install
npm run dev
```

> **On npm 11.16 and newer**, `npm install` may print `allow-scripts` and skip the
> `electron`, `esbuild` and `koffi` install scripts. If `npm run build` then fails
> because Electron is missing, run `npm approve-scripts --all` and `npm install` again.
> This is recorded in the audit because it makes a fresh clone look healthy when it is not.

```bat
npm run typecheck    :: tsc --noEmit
npm test             :: the test suite
npm run build        :: production build into out/
npm run smoke        :: runs the built interface end to end: every sheet and tab, a delete, a duplicate search, a cleanup review
npm run boot         :: starts the built main process and checks a window opens (needs a build first)
npm run bench        :: measures the performance targets in docs/TESTING.md
npm run dist         :: installer (NSIS) + portable exe into release/
npm run dist:dir     :: unpacked build, much faster, no installer tooling
```

---

## Try it in five minutes

You do not need to point this at your real files to test it. Two scripts exist for that:

```bat
npm run fixture                             :: creates a disposable 95 MB tree on your Desktop
npm run explain -- "C:\path\to\a\folder"    :: prints what SpaceWise would recommend, and why
npm run keygen -- keygen --out ..\offline\private-key.pem   :: vendor key pair (see docs/LICENSING.md)
```

`npm run fixture` writes to `Desktop\SpaceWise Test Folder`, and refuses to run if that folder
already exists. It holds three genuine cleanup candidates (about 41 MB) and **two deliberate
decoys**: a folder called `dist` with no manifest beside it, and a folder called `cache` in an
unremarkable place. If either decoy ever appears in the Clean up tab, that is a bug: the rule
that a name alone is never a verdict has regressed.

`npm run explain` runs the same detection the tab runs, on any folder you name, and prints the
evidence behind each finding. It is the answer to "the interface said nothing, is that right?".

Then, in the running app:

1. Scan `Desktop\SpaceWise Test Folder` (Ctrl+O).
2. Open the **Clean up** tab. Expect three groups: Project dependencies 25 MB, Build output
   12 MB, Tool and language caches 4 MB.
3. Open a row and read the reason and the consequence for it.
4. Tick one or two and press **Review and clean**, then read the review sheet before confirming.
5. To test the safety rules, add a file inside `app\dist` while the review sheet is open, then
   confirm. That item should come back as skipped with a reason, and the run should be reported
   as partial rather than complete.
6. Press **History** to see the run recorded.

Delete the folder when you are done. Nothing outside it is touched, and the only other thing
written is one JSON line per run in the application's user-data folder.

---

## Safety model

Adopted as design from a careful reading of the safety posture in similar tools, and
reimplemented here:

1. **Every target has a rule.** A folder named `cache` is not a candidate. A folder named
   `dist` is a candidate only when a sibling `package.json` proves it is build output.
   `node_modules` is a candidate but is described as *regenerable*, never as free.
2. **Every deletion passes one validation layer.** Scoped to the folder you scanned,
   segment-aware, and it refuses OS folders, drive roots, wildcards, `.git`, SSH and GPG
   keys, and browser credential stores.
3. **Revalidate before acting.** Size and timestamp are captured when the plan is drawn and
   compared again immediately before the action. Anything that changed is skipped and
   reported, which closes the time-of-check/time-of-use gap.
4. **Recycle Bin first.** Permanent deletion is a separate, differently labelled action.
5. **Results are separated.** Removed, failed and skipped are counted apart, and a run that
   left anything behind is reported as partial, never as complete.
6. **It is auditable.** Each run writes a local record of what was planned, what happened and
   what was refused. That record contains your paths, so it stays on your machine.
7. **No registry cleaning, no process killing, no startup modification.**
8. **Offline by default.** Scanning, analysis and cleanup need no network at all.

---

## Privacy

There is no telemetry, no analytics and no crash reporting. The only outbound requests are
an update check (when the update feed is configured) and links you click yourself. Optional
AI explanations, if ever added, will be explicit opt-in, will send the minimum metadata, and
will never upload file contents or full paths by default.

---

## Layout

```
src/main        the Electron main process: windows, IPC, workers, snapshots, licence
src/preload     the typed bridge between main and the interface
src/renderer    the interface: treemap, tree, panels, analysis
src/shared      code both sides use, including the analysis and cleanup rules
docs            engineering audit, architecture, security, testing, licensing, roadmap
```

---

## Documentation

- `docs/USER-GUIDE.md` — for people using the application rather than working on it: installing, scanning, cleaning up safely, and the known limitations
- `docs/ENGINEERING_AUDIT.md` — what was audited, what was measured, what was chosen and why
- `docs/ARCHITECTURE.md` — how the pieces fit together
- `docs/SECURITY.md` — the threat model and the controls
- `docs/TESTING.md` — how to run the tests, and what is still untested
- `docs/LICENSING.md` — the free tier, the premium tier, and how verification works
- `docs/ROADMAP.md` — phases and acceptance criteria
- `THIRD-PARTY-NOTICES.md` — attribution, including the SIL OFL licensed fonts

---

## Licence

MIT. See `LICENSE`.

This project began from the MIT-licensed Diskplot codebase, adapted and extended.
The original copyright notice is preserved, and the changes are described in
`THIRD-PARTY-NOTICES.md`. The bundled Barlow fonts are under the SIL Open Font License 1.1,
which is a separate obligation from the MIT licence on the code.
