# Roadmap

Status as of the `v0.1.1` release. Each phase states what was required, what exists, and what is
honestly still missing. Where a line here disagrees with the code or with `docs/TESTING.md`, those
are right and this file is the thing to fix.

---

## Phase 0 — Audit: **complete**

The environment inventory, the four candidate repositories, their licences, the commands
actually run, and the architecture decision are recorded with evidence in
`docs/ENGINEERING_AUDIT.md`.

Decided: adopt Diskplot (MIT) as the foundation; adopt the safety model of a second candidate
as design, reimplemented; exclude both Rust candidates as unbuildable on the audit machine.

---

## Phase 1 — Reliable scanner: **substantially complete, one gap**

Required: scan a folder or drive; correct sizes on a known dataset; progress and cancellation;
inaccessible files handled without crashing; largest files and folders; a file-type breakdown;
a responsive interface.

| Criterion | State |
| --- | --- |
| Scan a selected folder / drive | Working (inherited) |
| Correct sizes on a **known** test dataset | **Substantially verified.** The lister is tested against hard links, junctions, paths over 260 characters, unusual names and empty files, and asserts that what a file occupies is never less than its length. `npm run smoke` runs the built scan worker on a known tree and checks the exact entry, file, folder and byte counts. Not covered: an unreadable folder driven through `scanworker`. |
| Progress and cancellation | Working (inherited); latency unmeasured |
| Inaccessible files handled | Working; counted and sampled, not fatal |
| Largest files and folders | Working, and now covered by new tests |
| File-type breakdown | Working (inherited) |
| Responsive interface | Working by design (workers); unmeasured |
| Aggregation correctness | **Tested** — `walk.test.ts` walks a fake disk and a real one and pins the totals, including the logical-versus-on-disk invariant |

Remaining: an unreadable folder driven through the built `scanworker`, and the totals of a tree that
contains links and long paths *through that worker*. The awkward entries themselves are pinned at
the lister level (`lister.test.ts`), and the walk is tested against a fake disk and a real one, so
what is missing is the combination rather than any one piece.

---

## Phase 2 — Storage visualisation: **working, inherited**

Treemap and tree in sync, drill-down, breadcrumb, search, sorting, reveal in Explorer, empty
and error states. Inherited from the foundation and building cleanly. The treemap's layout
arithmetic is now tested against known input; the drawing is not (see below).

Remaining: the treemap's *paint*. `treemap.test.ts` pins the layout — known input, known rectangles
— but drawing it needs a canvas, and no check reaches that. Recorded in `docs/TESTING.md`.

---

## Phase 3 — Safe cleanup: **complete and reachable**

| Criterion | State |
| --- | --- |
| Recommendations are explainable | **Done and tested** — every finding carries its evidence, and the tab shows the reason and the consequence for each one |
| Preview matches the items selected | **Done** — the review sheet lists exactly the planned paths, and everything refused is listed with its reason |
| Paths are revalidated | **Done and tested** — size, mtime and protected-list rechecks, verified against a real filesystem |
| Explicit confirmation required | **Done** — nothing is preselected, and the review sheet names the action in words before a second click |
| Failed and successful actions reported separately | **Done and tested** — removed, failed and skipped are listed per item, with a `partial` flag |
| Cleanup is auditable | **Done** — one local record per run at `cleanup-audit.jsonl` in the user-data folder |
| Never silently overwrite or permanently delete by default | **Done** — Recycle Bin is the default; permanent deletion is an opt-in checkbox that is never remembered |
| Wired into the interface | **Done** — the Clean up tab runs plan → review → execute → report |

The `ClutterPane` this replaced was deleted rather than left beside the new tab, along with
the `findClutter` detector it used, so there is exactly one cleanup surface.

What this phase still does not have: keyboard-driven selection in the tab, and no way to exclude a
folder from *future scans*. What it does now have is the narrower promise that a folder can be
protected from cleanup permanently — Settings → Protection applies to every run from then on, not
only to the one in front of you.

---

## Phase 4 — Duplicates and history: **working, inherited**

Content-verified duplicate groups (size → hash), snapshot save and compare. Both inherited.
Duplicate detection is now tested against planted byte-identical files (`dupfind.test.ts`), and the
reclaimable figure is separated from the raw sum: `reclaimableBytes` in `shared/dupes.ts` counts the
space the copies occupy on disk, and only while two or more of them are left. The free tier's cap of
the 20 largest sets is applied when the list is drawn, so clearing a visible set brings the next one
in rather than hiding it for good.

---

## Phase 5 — Premium readiness: **complete, except that nothing sells it**

| Criterion | State |
| --- | --- |
| Premium boundaries are clear | **Done** — one feature table in `shared/entitlements.ts`, shown in the interface |
| Licensing is independently testable | **Done** — `license.test.ts` and `license-store.test.ts`, over real Ed25519 signatures; what a licence unlocks is asserted in `license.test.ts`, beside the licences that produce it |
| Expiry does not block access to user files | **Done and asserted** |
| Free functionality remains useful | **Done and asserted** |
| External service dependencies and costs documented | **Done** — `docs/LICENSING.md`; there are no external services |
| A premium feature is actually gated | **Done** — the Changes view, behind a panel that explains itself |
| Activate, show status, remove | **Done** — Help → Licence |
| Vendor key tooling | **Done** — `npm run keygen`, verified end to end against the app's verifier |
| Licence key generated and embedded | **Done** — `EMBEDDED_PUBLIC_KEY` carries the real vendor public key, the build accepts licences signed with the matching private key, and an owner licence was issued. The private key is not in this repository and must never be: rotating it invalidates every licence already issued |
| Payment provider | **Not done, deliberately deferred** — nothing sells a licence yet. The owner's decision is to have testers use the app first, and to take payments and signing together when selling begins |
| More than one feature gated | **Done** — `compare.scans`, `duplicates.unlimited` and `ai.summary` each gate something |

`EMBEDDED_PUBLIC_KEY` now carries a real vendor public key, so a licence unlocks the premium
features. `npm run verify:licence` proves a build accepts the licences signed with that key;
while the constant was empty it refused everything, which was the designed safe default rather
than a bug.

---

## Phase 6 — Release candidate: **partially complete**

| Criterion | State |
| --- | --- |
| Windows build succeeds | **Verified** — `npm run build` exits 0 |
| Packaging succeeds | **Verified** — `npm run dist` builds the NSIS installer and the portable exe; the installer is checked against `latest.yml` before upload, and two releases have shipped from that path (`v0.1.0`, `v0.1.1`) |
| Critical tests pass | **Verified** — `npm test`: 342 tests, 0 failures. `npm run smoke` passes, and `npm run verify:feed` proves the published release reaches an updater. Re-run all three rather than trusting these numbers |
| Known limitations documented | **Done** — in the README, `docs/TESTING.md` and `docs/SECURITY.md` |
| Licence notices preserved | **Done** — `THIRD-PARTY-NOTICES.md` including the SIL OFL font notice |
| Code signing | **Blocked** — needs a certificate |
| A user can install, scan, inspect, clean and reopen unaided | **Partly verified** — the installer exists and has shipped, and the built interface is driven end to end by `npm run smoke`: every sheet and tab, a delete, a bulk delete, a duplicate search and a cleanup review, removing real files. **Not done:** nobody has walked the whole journey by hand on a clean machine. The owner is doing that next, on another machine |

---

## Ordered next work

Done since this list was written: the licence is wired into the interface; `style-src` no
longer allows `'unsafe-inline'`; the raw path handlers share one tested policy, so item S-1 is
closed apart from the copy-source residual in `docs/SECURITY.md`; the cleanup history shows
its stored refusal reasons; duplicate detection has planted-file tests and reports what it
would really free; the treemap layout is tested; the walk has been extracted and is tested
against a fake disk and a real one; the optional storage summary is built, in the shape
the entitlement table already reserved for it; the Android erase contract was changed to
take the same guarded target the desktop path takes, so that build cannot be written without
the recheck being available to it; the scan has now been measured on a two-million-file tree
(9.5 to 17.2 s, with the folder-shape caveat recorded in `docs/TESTING.md`); `SITE` points at
`https://dominixai.com`; the first releases are published — `v0.1.0`, then `v0.1.1` with the two
faults the driving checks found; and publishing them exposed the next problem, which is now closed:
the repository was private, so the application could not reach its own feed at all. It is public,
and `npm run verify:feed` proves the feed is readable without credentials, that an older install is
offered the published version, and that an install already on it is not offered it again.

1. **Walk the whole journey by hand on a clean machine** — install, scan, inspect, clean, reopen,
   update, uninstall — and write down anything that surprises anyone. The owner is doing this on
   another machine. Nothing in the product has to change for it, which is the point: the checks
   cover the interface, and this covers the machine.
2. **Put it in front of testers.** No repository work; the exercise is what they find. The release
   to install is `v0.1.1`, and the app now checks for updates itself (Help → Check for updates), so
   a fault found by a tester can reach them without a reinstall.
3. **A code-signing certificate**, wired into the release job — before selling, and not before
   testing. The consequence of going without is the SmartScreen warning on first run; it matters
   more once the update feed delivers, because the download is checked by a hash published from the
   same place as the binary (integrity, not authenticity) and the installer an update runs is exactly
   the unsigned kind SmartScreen distrusts. See `SECURITY.md`.
4. **A payment path**, taken together with item 3. Nothing sells a licence today; licensing itself
   is finished and verified, so this is the only thing between the premium tier and a sale.

## Explicitly out of scope

Registry cleaning, service or startup modification, process termination, unattended scheduled
cleanup, and any "speed up your PC" claim. These are not deferred; they are refused.
