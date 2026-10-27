# Roadmap

Status as of the Phase 1–3 checkpoint. Each phase states what was required, what exists, and
what is honestly still missing.

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
| Correct sizes on a **known** test dataset | **Partially verified.** A real-filesystem test now walks a fixture tree and asserts the root total to the byte, and the cleanup pipeline end to end. Hard links, junctions, long paths and unreadable directories are still uncovered. |
| Progress and cancellation | Working (inherited); latency unmeasured |
| Inaccessible files handled | Working; counted and sampled, not fatal |
| Largest files and folders | Working, and now covered by new tests |
| File-type breakdown | Working (inherited) |
| Responsive interface | Working by design (workers); unmeasured |
| Aggregation correctness | **Now tested** — 15 tests, including the logical-vs-on-disk invariant |

Remaining: extend the fixture tree to hard links, junctions, >260-character paths, unreadable
directories and unusual filenames, and assert the totals there too. A plain tree is now
covered; the awkward cases are not.

---

## Phase 2 — Storage visualisation: **working, inherited**

Treemap and tree in sync, drill-down, breadcrumb, search, sorting, reveal in Explorer, empty
and error states. Inherited from the foundation and building cleanly. Not independently
re-verified.

Remaining: a treemap layout unit test (known input → known rectangles). The layout code is
untested even upstream.

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

What this phase still does not have: no keyboard-driven selection, no way to exclude a folder
from *future* scans (only from the current cleanup), and no per-item reason shown for the
refusals inside the history view (the reasons are in the stored record, only the counts are
drawn).

---

## Phase 4 — Duplicates and history: **working, inherited**

Content-verified duplicate groups (size → hash), snapshot save and compare. Both inherited.
Duplicate detection is not yet tested against planted byte-identical files, and the
"reclaimable" figure for duplicates is not yet separated from the raw sum of duplicate sizes.

---

## Phase 5 — Premium readiness: **verification and the boundary are done; the key is not**

| Criterion | State |
| --- | --- |
| Premium boundaries are clear | **Done** — one feature table in `shared/entitlements.ts`, shown in the interface |
| Licensing is independently testable | **Done** — `license.test.ts`, `license-store.test.ts` and `entitlements.test.ts`, over real Ed25519 signatures |
| Expiry does not block access to user files | **Done and asserted** |
| Free functionality remains useful | **Done and asserted** |
| External service dependencies and costs documented | **Done** — `docs/LICENSING.md`; there are no external services |
| A premium feature is actually gated | **Done** — the Changes view, behind a panel that explains itself |
| Activate, show status, remove | **Done** — Help → Licence |
| Vendor key tooling | **Done** — `npm run keygen`, verified end to end against the app's verifier |
| Licence key generated and embedded | **Not done — needs the owner's private key**, which cannot be created for them |
| Payment provider | **Not done** |
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
| Packaging succeeds | `dist:dir` verified; the NSIS installer target is configured but not yet run end to end |
| Critical tests pass | **Verified** — 138/138 with 0 failures at the last run. Re-run it rather than trusting the number here; this line is a moving target |
| Known limitations documented | **Done** — in the README, `docs/TESTING.md` and `docs/SECURITY.md` |
| Licence notices preserved | **Done** — `THIRD-PARTY-NOTICES.md` including the SIL OFL font notice |
| Code signing | **Blocked** — needs a certificate |
| A user can install, scan, inspect, clean and reopen unaided | **Partly verified** — the app runs, and the cleanup pipeline is tested against a real tree. Not done: the NSIS installer has never been built or run, and nobody has walked the journey by hand end to end |

---

## Ordered next work

Done since this list was written: the licence is wired into the interface; `style-src` no
longer allows `'unsafe-inline'`; the raw path handlers share one tested policy, so item S-1 is
closed apart from the copy-source residual in `docs/SECURITY.md`; the cleanup history shows
its stored refusal reasons; duplicate detection has planted-file tests and reports what it
would really free; the treemap layout is tested; the walk has been extracted and is tested
against a fake disk and a real one; the optional storage summary is built, in the shape
the entitlement table already reserved for it; and the Android erase contract was changed to
take the same guarded target the desktop path takes, so that build cannot be written without
the recheck being available to it.

1. **Measure a multi-million-file volume.** Every other target in `docs/TESTING.md` now has a
   measured value, including cancel latency. This one needs a volume of that size, which this
   machine does not have, and it is the only claim left that rests on an extrapolation.
2. **Publish the first release.** The feed is wired and `app-update.yml` ships inside the
   package, but the repository has no releases yet, so a version check reaches GitHub and finds
   nothing. Until one exists the updater is correct but unexercised end to end.
3. **Buy a code-signing certificate** and wire signing into the release job. Declined for now,
   deliberately: the consequence is the SmartScreen warning on first run and nothing else is
   blocked. It matters more the moment the update feed is used in anger — see `SECURITY.md`.
4. Set `SITE` and `AUTHOR_SITE` in `App.tsx` once a website and an author page exist. `REPO` is
   set, so the Source button works; these two are still empty, so their buttons are inert.

## Explicitly out of scope

Registry cleaning, service or startup modification, process termination, unattended scheduled
cleanup, and any "speed up your PC" claim. These are not deferred; they are refused.
