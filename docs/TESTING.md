# Testing

## Running the suite

```bat
npm test          :: node --test via tsx, over src/shared/*.test.ts and src/main/*.test.ts
npm run typecheck :: tsc --noEmit
npm run build     :: electron-vite build, then required before the smoke test
npm run smoke     :: loads the built interface and checks it actually works
npm run boot      :: starts the built main process and checks a window opens
```

No test framework beyond Node's built-in runner and `node:assert`. There is no test
dependency to keep updated, and the tests run in about two seconds.

### The smoke test

`npm test` covers logic. It cannot tell you whether the built interface runs, because it never
loads it. `npm run smoke` does: it opens the real production renderer in a hidden window with the
real preload and the real Content Security Policy, then fails if

- React did not mount, or the title is wrong;
- the stylesheet did not apply (a computed style is still at its initial value);
- `require()` is reachable from the renderer, or the preload bridge is missing;
- anything at all was refused by the policy during load;
- the **production scan** gives the wrong answer. The smoke test also runs the built scan worker
  on a temporary folder with four files and a known layout, and fails if the entry count, the
  file and folder counts, the bytes written or the unreadable count disagree. That is the one
  part of the application no unit test can reach, because it needs worker threads. It asserts the
  bytes *written*, not the bytes on disk: `AllocationSize` as reported while enumerating a folder
  lives in the directory entry, and Windows does not hold it still — a direct
  `GetFileInformationByHandleEx` call against a folder written a moment earlier read 4096 at 1.2 s
  and 0 at 2.4 s for the same file. Asserting on that failed about one run in three, and a check
  that fails by itself is worse than no check at all.
- the **sheets draw**, and so do the **views**. It opens the sheets a person can reach — Settings
  from the View menu, "Why is it slow?" from the start screen, About and the shortcut list from Help
  — and reads each one back: that every settings row and the protected folder are there, that the
  diagnosis puts the measured figures into its sentence, that a reading it could not take is named as
  such rather than dropped, that the About box shows the build stamp, and that every sheet closes.
  It then starts a scan the way the window does — the Scan button on the drive row — answers it with
  a table the built worker really produced for a fixture folder, and clicks each tab. The tree must
  list a file that exists, Largest must carry its own note, Types must have a row for an extensionless
  file, Clean up must either say what could be reclaimed or say there is nothing to suggest,
  Duplicates must explain what it compares, and Changes must say it is gated. The tab's own label is
  stripped out of the pane before it is searched, so a label that happens to match cannot pass the
  check on its own, and the tab bar itself is compared against the six tabs it should have. The main
  process is not part of the harness, so these screens are answered from a fixed script; the live
  answer is exercised by `npm run bench` instead. Before any of this existed, a section that quietly
  stopped rendering passed every check in this file.
- the **rows work when they are used**. It then clicks a row in the tree, presses Delete, reads the
  confirmation — it has to name the file — and cancels, and the file must still be there. It does the
  same again and confirms, and the file has to leave the disk *and* the tree. Then it ticks two rows
  in the largest list, checks the pane bar says two are selected, presses the pane's own Delete,
  expects a confirmation about two items, and requires both files to leave the disk and the list.
  The deletion is real: the harness answers `shell:trash` with the same Electron call the main
  process makes, so what is asserted is that the files are gone, not that a call was made. It was
  falsified before it was trusted: with the view left un-refreshed while the file still left the
  disk, both assertions fail and name the rows that were left behind.
- the **duplicate search and the cleanup review work end to end**. It starts a search from the
  Duplicates pane and requires the result to reach the list: one set, two copies named, and the file
  of exactly the same size with different content **not** named as a copy. The saving has to be at
  least the bytes in one copy — not equal to the set's figure, because those are different
  quantities on purpose: a set is priced by the length its copies share, and a saving by the space
  they occupy on disk. It then removes one copy from that list and requires the set to leave it,
  since one copy is not a duplicate. Finally it ticks a category in the Clean up tab, asks for a
  plan, reads the review — which has to name the action, the count and the folder — confirms it, and
  requires the folder to leave the disk and the report to say how much was freed. Both searches are
  answered from a fixed script, because the product's hashing and planning run in the main process
  and are tested against the real code; the removal is real, and `shell:trash` is answered with the
  same call the main process makes.
- the **application does not start**. It also starts the built main process in a child and fails
  if it throws while loading or never opens a window. Nothing else loads `out/main/index.js`, so
  a main process that dies before `app.whenReady()` used to pass the entire suite; a duplicated
  `ipcMain.handle()` registration did exactly that, and the only symptom was Electron's own
  "Error" dialog. `npm run boot` runs that check on its own when you want it without the rest.

The window it uses is hidden but deliberately not throttled (`setBackgroundThrottling(false)`). A
window Chromium believes is occluded defers its work, and the virtualised lists then measure
themselves a few rows tall — which made these checks read half-drawn panes and fail about one run in
three, depending on how busy the machine was. A hidden window is enough for the policy checks; it is
not enough for checks that have to read what was drawn.

It also asserts what the policy *should* refuse, because a check that cannot fail is not a check:

| Written by | Expected | Why it is asserted |
| --- | --- | --- |
| `<style>` element | refused | proves the check can detect a refusal |
| `style="..."` attribute | refused | not used anywhere in the application |
| `element.style.x = ...` | **allowed** | React needs it; the interface breaks without it |

That last row is the reason `'unsafe-inline'` could be removed from `style-src`, and the test
encodes the reason rather than leaving it in a comment.

`npm test` covers `src/shared`, `src/main` and `src/renderer/src/lib`. The renderer's `lib` is
included because the modules there that matter -- the treemap layout above all -- are pure
arithmetic over the scan table with no DOM in them, so they can be tested like anything else.

It needs a build first, so the order is `npm run build && npm run smoke`. It is not part of
`npm test` because it launches Electron.

## What is covered

Last verified run on this machine: **339 tests, 339 passed, 0 failed** (~16 s).

| File | What it pins down |
| --- | --- |
| `src/shared/table.test.ts` | Size, logical-size and file-count rollup; newest-change propagation; extension indexing rules; child ordering; partial-preview behaviour; link flags; transferable buffers; the "only the first `n` entries are real" contract; the empty-folder case |
| `src/shared/storage-intelligence.test.ts` | Category classification; the "a name alone is not evidence" rule; sibling-manifest proof as positive and negative cases; no double counting of nested candidates; size floor; location-based matching for temp and browser caches; links excluded; risk levels for the review-tier categories; every finding is explainable; grouping and additive totals |
| `src/shared/cleanup.test.ts` | Path normalisation including `..`; segment-aware containment; scope validation; wildcard, drive-root, OS-folder and credential-store refusal; plan building with explained refusals; the size-change, mtime-change and disappearance revalidation cases; outcome accounting with the `partial` flag; audit record assembly; the run loop stating its total and reporting each item, and what a run that is stopped leaves behind; action labelling |
| `src/main/license.test.ts` | Real Ed25519 sign/verify round trips; wrong-key, edited-payload and corrupted-signature refusal; expiry, grace window and the switch to turn grace off; machine binding, mismatch and an unidentifiable machine; the empty-key build refusing everything; malformed and unsupported tokens; free vs premium entitlements; machine fingerprint stability |
| `src/main/audit-log.test.ts` | Append and read against a real temporary directory; newest-first ordering; the run cap and size trim; a damaged or truncated line not destroying the rest of the history; a partial run stored as partial |
| `src/main/cleanup-pipeline.test.ts` | The whole pipeline against a **real** filesystem: walk a fixture tree into a scan table, detect only the provable candidates, assert the totals to the byte, plan, then revalidate after a file changes and after a folder is deleted, and build a truthful record |
| `src/main/lister.test.ts` | The **real** directory lister, both implementations: entry counts, exact logical lengths, allocated size, a junction reported as a link and never as a folder, a hard link counted per name, non-ASCII and spaced names surviving the Win32 buffer, `.`/`..` never appearing, a missing folder and a file-as-folder returning an error rather than a silent zero, and a path over 260 characters |
| `src/main/license-store.test.ts` | Persistence against a real file: a valid key is stored and read back, an invalid key is refused and **never written**, a damaged or empty token file leaves the free tier working, an expired licence is kept but unlocks nothing, the grace window, removal, and re-activation replacing rather than appending |
| `src/main/scope.test.ts` | The policy every path-taking IPC handler shares: the scanned root and anything inside it are reachable, while a sibling folder, a traversal, a wildcard and an empty path are not; the scanned root may be a subject but never a target; and an operating-system folder or a credential store is refused **even when it is the scanned root**. That last group is the part that still holds under a compromised renderer, so it is asserted separately and named as such |
| `src/main/dupfind.test.ts` | The duplicate finder against planted files: byte-identical copies grouped, and files differing in the first byte, the last byte, or **only in the middle** all kept apart. The middle case is what the two passes exist for, so the test first asserts that the cheap head-and-tail pass genuinely cannot tell those two apart, and only then that the full read can. Also the boundary at exactly twice the edge (where one pass suffices), the single byte left unread at the edge plus one, an unreadable file skipped rather than fatal, and a file whose length no longer matches the scan refused rather than judged on part of itself. Also a hard link to the same file: one file under two names is not a duplicate and must not be offered, the figure the interface would print for it is zero rather than its size, and when a genuinely duplicated file sits beside a linked one, only the names that each hold their own bytes are counted, so the saving is one copy and not three |
| `src/shared/changed-since.test.ts` | The single guard behind every destructive action decided earlier: an unchanged file passes, and a file that is gone, unreadable, the wrong length or the wrong age does not. Also that the cleanup planner now refuses an item it cannot fingerprint rather than waving it through, which it previously did |
| `src/main/scan-trash-agreement.test.ts` | The invariant the guard rests on: the length and modification time the scanner records are exactly what a fresh `lstat` reports, for the portable lister, the Windows bulk lister and the one that actually ships, at ordinary sizes and either side of a whole second |
| `src/main/probe.test.ts` | The contract between the scanner and every deletion guard, held to a real disk. A modification time is whole seconds in the table, in the lister and in `fs:stat`, and the probe the guards share must agree — it returned milliseconds, so it disagreed with every target a scan produced and refused every file, which is why nothing could be moved to the Recycle Bin. The planner could not catch that: `buildPlan` fills each item's size and mtime from this same probe, so it was comparing the probe with itself. Also that the guard still refuses a file whose size really changed, and one that is gone |
| `src/main/walk.test.ts` | The scan walk, against a fake disk and a real one: counts through nested folders, parents linked so the tree has a shape, links listed but never followed, a folder that cannot be listed flagged and explained while the rest of the walk carries on, a file that cannot be read recorded rather than dropped, batching still covering everything, stopping handing over what was measured and marking itself incomplete, and a real temporary tree walked with the production lister |
| `src/shared/ai-summary.test.ts` | What the optional summary would send. With names withheld the message contains no name, no separator and no part of a path; the scanned folder's full path never appears even when names are wanted; a path outside the scan is reduced to its last segment and a bare drive letter becomes "(a drive)"; the message is capped in findings, in types and in total size, and a million-file scan stays under the ceiling. Also that the standing instructions forbid presenting anything as safe to delete |
| `src/main/ai.test.ts` | The only outbound code in the application, exercised against a real HTTP server on the loopback address: https is required for anything remote while a model on this machine may use `http://127.0.0.1`, the message and the standing instructions are sent and nothing else is, the reply is bounded and trimmed, an oversized message is refused without sending anything, a bad status and an unreadable reply are both reported, and the key is never handed to the interface. Also the refusal path: the endpoint's own message is carried through rather than replaced by a status code, a wall of text is bounded, a reply that is not JSON is still used, and a refusal that came from upstream is tried again while one about the request itself is not. Also the model list: several models, one per line or comma-separated, blanks and repeats dropped, the next model asked when one refuses or answers with nothing but its reasoning, and a list that fails entirely reported as such rather than as one broken model |
| `src/shared/dupes.test.ts` | What a duplicate search is worth: every copy but one counted, the largest copy on disk kept, the figure taken from on-disk size rather than shared length, and copies that are already gone freeing nothing |
| `src/renderer/src/lib/treemap.test.ts` | The squarified layout, which is pure arithmetic and now tested directly: each child's area matches its share of the bytes, no two cells at the same depth overlap, every cell stays inside its box, a folder past the level limit becomes one block, the remainder folds into a single rest cell named after its folder, and the work stays bounded by the box rather than the file count |
| `src/main/external.test.ts` | What the interface may ask the operating system to open: https, and a `mailto` carrying an address, and nothing else — plain http, `file://`, `javascript:`, a UNC path and any other scheme refused, and an empty address refused rather than opened as a location |
| `src/main/drives.test.ts` | Which drives the start screen lists, against a fake filesystem: a letter with nothing on it left out, and a drive that hung, failed with a code or reported no capacity listed **with** the reason rather than dropped. Pins that only `ENOENT` means nothing is mounted, that all 26 letters are still probed, and that a code with one plain meaning becomes a sentence while any other code stays itself |

Highlights worth knowing about:

- The size rollup is tested for the property that matters most: **on-disk size and logical
  size stay independent**. A sparse-file case asserts they never collapse into one number.
- The cleanup tests stage a **time-of-check/time-of-use** race using a fake filesystem, which
  is the only practical way to test it deterministically.
- The licensing tests generate a fresh Ed25519 key pair per run. No vendor private key exists in
  this repository, and none could: signing needs it and verifying does not. Because the shipped
  build now carries a real vendor *public* key, the test that used to assert the constant stayed
  empty would be guarding the wrong thing, so it now asserts what still matters — that an empty
  key refuses everything and says why, and that whatever is compiled in is a usable key.

## What is *not* covered yet

This list is the honest gap: what no test reaches today. Where something on it has since been
partly closed, it says so and says what is left.

- **The rest of the interaction is still not driven.** Rows are clicked, ticked and deleted, a
  duplicate search is run and acted on, and a cleanup review is carried out — all for real. What
  nothing does is open a context menu, drop a folder on the window, walk the rows with the arrow
  keys, use the file clipboard, or open the cleanup history and the optional summary. A component
  that throws once *those* open over real scan data would still ship unnoticed.
- **No test picks a folder or drags one in.** The Scan button on a drive row is now clicked (`npm
  run smoke`), but the "Scan a folder…" dialog, a folder dropped on the window and the unreadable
  rows of the drive list are untested end to end; every other test starts a scan by calling the
  worker directly.
- **Unreadable directories are covered in the walk and the lister, but not through
  `scanworker`.** The folder the smoke test scans has no denied entries in it.
- **The treemap is never painted.** Its layout arithmetic is measured and pinned by tests, but
  the paint itself needs a canvas and has no automated check at all.
- **No clean-machine install, upgrade or uninstall test**, and nothing checks that an update
  actually applies. `v0.1.1` is published, and `v0.1.0` before it, but the repository is private: a request for its
  `latest.yml` without credentials returns 404, so the application cannot even reach the feed. No
  updater path has therefore been exercised end to end.
- **No signed-build verification**, because there is no signing certificate. Signing is
  deliberately deferred, and the consequence is recorded in `SECURITY.md`.

## Manual Windows checklist

Run this on a machine you can afford to experiment on. Nothing here deletes anything by itself.

### Scan correctness

1. Scan a folder whose size Windows Explorer also reports. Compare the totals. They should
   agree within the accounting differences of on-disk versus logical size, and the interface
   should state which it is showing.
2. Scan a folder containing a junction (for example under `C:\Users\<you>\AppData`). The
   junction appears as an entry, is not descended into, and its target's bytes are not
   counted twice.
3. Scan `C:\Windows\System32` as a standard user. Access-denied paths are counted, listed and
   do not stop the scan or crash the application.
4. Cancel a long scan. The interface stops promptly and the partial result is marked
   incomplete rather than presented as complete.
5. Scan a small folder twice. The totals match.

### Interface

6. Drill into the treemap and back out. The tree, the breadcrumb and the treemap stay in
   agreement about the current folder.
7. Search for a known filename; confirm it is found and that selecting the result reveals it
   in Explorer.
8. Resize the window during a scan. The layout holds and the values keep updating.

### Cleanup (only on disposable data)

9. Build a fixture folder named `dist` **without** a `package.json`. It must not appear as a
   cleanup candidate.
10. Add a `package.json` beside it. Now it appears, with its size and a risk level.
11. Build a plan. Check the preview lists exactly the paths you selected and nothing else.
12. While the review is open, add a file inside one selected folder. Confirm that item is
    marked invalidated and is not acted on.
13. Run the action and confirm: every item is reported individually, the Recycle Bin
    contains what was moved, and the run is not reported as complete if anything was skipped.
14. Confirm the audit record exists and lists what was planned, what happened and what was
    refused.

### Release

15. Install from the NSIS installer: shortcut created, application starts, product name and
    version correct.
16. Scan, cancel, clean, close, reopen. State survives a restart; scan history is still there.
17. Uninstall. User files are untouched. The audit log under the user-data directory is the
    only thing the uninstaller leaves behind.
18. Confirm no unexpected network requests. A scan must complete with the network disabled.

## Performance targets

Partly measured. `npm run bench` measures what can be measured without the interface, and
prints what it could not measure as unmeasured rather than guessing at it.

Last run: 4 logical CPUs, Node v22.17.0, warm cache.

| Scenario | Target | Measured | |
| --- | --- | --- | --- |
| Walk a project folder, warm cache | — | 29,283 files/s over 11,072 files and 1,320 folders | |
| The same rate over 100k files | under 2 s | ~3.4 s | see the caveats |
| Treemap layout, 2,460 cells at 1200x800, 5 levels | under 30 ms | 24.5 ms | met |
| Finalise a 2,000,000-node table | — | 998 ms | |
| Memory at 2,000,000 nodes | under 400 MB RSS | 294 MB | met |
| Cancel a running scan, thread retired | within 4 s | 207 ms and 369 ms on two runs | met |
| A multi-million-file volume | tens of seconds | **9.5–17.2 s** over **2,000,000 files in 10,111 folders** — walk 17.2 s, with the live preview 13.8 s, with the history snapshot 9.5 s | met, with the fourth caveat |
| Treemap paint | under 16 ms | **not measured** | needs a canvas; the figure above is the layout arithmetic only |
| Cancel acknowledged on screen | ~200 ms | **not measured** | that half is about the interface, not the scanner |

Four caveats, because without them these numbers read as more than they are:

- **They move with the machine.** Two runs while other work was going on gave 148 ms and
  378 ms for the same walk of the same folder, and the 100k figure fell anywhere between
  1.3 s and 5.0 s. Re-run `npm run bench` on a quiet machine before quoting it.
- The benchmark drives the **production directory lister** and the real table builders, but not
  the worker pool. The application spreads directories across `availableParallelism()` workers,
  so its wall clock should be better than these figures and never worse. Treat them as a floor.
- 11,072 files is not 100,000. That row is the measured rate extended, not a measurement, and
  the bench script labels it that way in its own output.
- **The two-million-file figure comes from a synthetic tree, not a real volume.** It was 200 files
  in each of 10,000 folders, written on this machine minutes before it was scanned, so the metadata
  was already in cache. That shape flatters the bulk lister, which reads a whole folder per call. The
  same lister walked a real project folder at 29,283 files/s, which across two million files would be
  about 68 s. The truth for a real volume lies between the two figures, and it is the **folder
  shape**, not the file count, that decides which end — many small folders is the slow end.

Cancel latency is the one target that needs the built scanner rather than the library, so the
benchmark starts the built coordinator, asks it to cancel as soon as it says anything at all,
and times until the thread is gone. A run in which the scan finished before the cancel landed
is reported as unmeasured rather than counted, so the figure is always a real interruption.

Do not publish any comparison against another tool until every row has a measured value, on the
same machine, with the same dataset, warm cache.
