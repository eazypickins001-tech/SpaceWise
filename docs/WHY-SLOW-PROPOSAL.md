# Proposal — “Why is it slow?”

**Status: proposal. Nothing in this document is built, and nothing here is a claim about the
product as it ships today.** It exists so the decision can be made on the record before any code,
the way the audit and the roadmap treat every other change of scope.

---

## 1. The problem with the problem

“My machine feels slow” is a symptom, not a fault. It decomposes into slow boot and sign-in, slow
application launch, lag during use, and slow disk reads. Of those, **storage explains a minority**,
and only a specific minority:

| Cause | Storage-shaped? | Can SpaceWise fix it? |
| --- | --- | --- |
| System drive nearly full (about 10–15% free or less) | yes | yes, by freeing space |
| Page file thrashing because there is little RAM | yes, partly | no, but it can say so |
| A tired or failing disk | yes | no, but it can say so |
| Huge temp and cache trees re-scanned by antivirus | yes | yes, by removing them |
| Dozens of startup applications | no | no, but it can name them |
| Drivers, thermals, power plan, Windows Update, RAM pressure, malware | no | no, but it can point at them |

The rest of the market answers this question with a button that says “+312% faster”. That number is
produced by comparing two unrelated measurements, and the whole genre is discredited because of it.
The one asset this product has that they do not is that **it has never lied about a number**.

## 2. The line this has to stay behind

`docs/ROADMAP.md` currently lists as *explicitly out of scope*: registry cleaning, service or
startup modification, process termination, unattended scheduled cleanup, and any “speed up your PC”
claim. That list is a promise, not an oversight, and it is the reason the safety model reads as
credible.

This proposal keeps every item on it. If it cannot be done without breaking one of them, it is not
in scope.

## 3. The principle

> **Attribute, do not assert. Measure, explain, then either do the provably safe part or hand the
> person the exact Windows screen.**

Three consequences, which govern everything below:

1. Every statement in this surface names where it came from — the scan, or a named Windows API,
   with the sampling window if it is a rate.
2. Anything that cannot be measured is not displayed. No inferred “startup impact” scores, no
   “speed score”, no before/after comparison across machines.
3. The only actions offered are the ones already in the safety model, or the act of walking someone
   to the right Windows screen.

## 4. What is measurable on Windows, read-only

Every signal here is a read. None of them writes, stops or disables anything. Where a source can be
unavailable (permissions, platform, an OEM image that omits a counter), the check reports itself as
unavailable rather than as “fine”.

| Signal | How it is read | What it can honestly say | Caveat |
| --- | --- | --- | --- |
| Free space on the system volume | already available from `fs.statfs` | How full the drive is against the threshold where Windows starts to struggle | Threshold is a heuristic, and will be labelled as one |
| Page file and commit charge | `Win32_PageFileUsage`, `Win32_OperatingSystem`, `Win32_PerfFormattedData_PerfOS_Memory` | Committed bytes against physical RAM — i.e. is the disk being used as memory | Requires a sample, not an instant |
| Disk health | `Get-PhysicalDisk` + `Get-StorageReliabilityCounter`, `Win32_DiskDrive.Status` | Wear, reported errors, `Pred Fail` | Consumer drives often report little; “no data” is not “healthy” |
| Disk latency and queue | perf counters `AvgDiskSecPerTransfer`, `CurrentDiskQueueLength` | Whether I/O is the bottleneck *while measured* | Meaningful only during activity; the window must be shown |
| Boot time and what delayed it | `Microsoft-Windows-Diagnostics-Performance/Operational`, event 100 and its 101–110 breakdown | “Windows measured the last boot at 43 s; two applications accounted for 12 s of it” | May need elevation on some builds; degrade to “unavailable” |
| Startup inventory | `Win32_StartupCommand`, the `StartupApproved` keys and the Startup folders, read only | Which items start with the desktop, and where each lives | Task Manager's “impact” figure is not exposed to scripts, so it is **not** shown |
| Pending update / restart required | the documented registry keys, read only | “Windows is waiting to restart to finish installing updates” | Read only; never triggered from here |
| Active power plan / battery saver | `powercfg /getactivescheme`, power setting values | “Power saver is on” | — |
| Processor throttling | `Win32_Processor` clock against maximum, `%ProcessorPerformance` | A hint, at best, that the machine is thermally limited | Deliberately weak — must be labelled as a hint |
| Storage Sense state | the documented registry values, read only | Whether Windows is already cleaning unattended | — |

**What is not measurable, and therefore not claimed:** which application “feels” slow, what a
startup item costs in seconds, whether a change made anything faster, and any single “score”.

## 5. Surfaces

One new sheet, opened from two places: a **“My PC feels slow”** entry on the opening screen, and
**Help → Why is it slow?** It reads the scan already in memory plus the read-only queries above.

**The sheet is a ranked list of findings.** Each row has exactly three parts:

1. **What** — the condition, in plain words. *“Your system drive is 96% full.”*
2. **Evidence** — the number and where it came from. *“7.4 GB free of 186 GB; Windows struggles
   below about 15%.”*
3. **What helps** — one of two things:
   - **A SpaceWise action**, which goes no further than opening the existing flow with the right
     filter already applied. Freeing space opens **Largest** or **Clean up**; it never removes
     anything by itself.
   - **A Windows screen**, opened with `ms-settings:`. Nothing is changed from here.

There is no third kind of row, no toggle, and no “fix all” button.

**What it says when the answer is not storage.** This is the part no optimizer will ever ship, and
it is the reason to build it: *“Nothing SpaceWise can measure explains the slowness. The likely
causes are outside storage — open Startup apps, or check for a pending restart.”*

## 6. The one enabling change to existing code

`src/main/external.ts` allows `https` and a `mailto` carrying an address, and nothing else, and it
is tested. Opening a Windows settings page needs that list extended — **not** by allowing a scheme,
but by naming an explicit set of pages:

```
ms-settings:storagesense   ms-settings:startupapps   ms-settings:batterysaver
ms-settings:windowsupdate  ms-settings:powersleep     ms-settings:privacy
```

A closed allow-list, matched exactly, tested the same way the current two are. A compromised
renderer must not be able to open an arbitrary scheme, which is why this is a list and not a
pattern. Page availability varies slightly by Windows build, so an unopenable page is reported to
the person rather than silently failing.

## 7. Claims policy

This is the section that decides whether the feature helps or damages the product.

- **The words “fast”, “faster”, “speed up” and “optimise” do not appear in the interface**, except
  when quoting Windows' own measurement.
- Every figure is one of: from the scan; from a named API, with its sampling window; or absent.
- **No before/after claim.** If the product ever offers one, it must be a re-measurement on the same
  machine with both numbers shown, and that is a separate decision.
- The diagnosis is **local only**. It never leaves the machine, and it is not included in the
  optional summary unless the person explicitly asks for it, under the rules already in
  `docs/SECURITY.md`.

## 8. Scope for a first version

Deliberately one read-only pass, six checks, no new destructive action:

1. **Free space** against the threshold, per volume.
2. **Memory pressure** — commit charge against RAM, plus page-file usage.
3. **Disk health** — status and reliability counters, with “no data” handled honestly.
4. **I/O latency** — sampled over a stated window, only while something is running.
5. **Boot attribution** — last boot time and the components Windows blamed.
6. **Startup inventory** — what starts with the desktop, read only.

Then: one sheet, ranked by severity, each row with its evidence and one of the two actions above;
links into the existing storage flows; a **Why is it slow?** section in `docs/USER-GUIDE.md` and the
hand-out HTML; a row in `docs/TESTING.md`; and the allow-list change with its tests.

The evidence-ranking logic is pure and belongs in a tested module, the way `scope.ts`, `probe.ts`,
`drives.ts` and `external.ts` already are. The Windows queries belong behind one interface, so a
test can answer with fixed data and no machine is required to run the suite.

## 9. Risks, stated plainly

- **Support burden.** The moment the product discusses speed, people expect speed. The claims policy
  above exists to keep that honest, not to avoid it.
- **Scope creep.** Every “fix” added to this sheet erodes the reason the safety model is believed.
  Startup disabling is the obvious next request and the one to refuse.
- **Noisy measurements.** Perf counters mislead when sampled carelessly. A sampling window that is
  shown is the only defence.
- **Elevation.** Some sources may need administrator rights. The feature must work unprivileged and
  say which checks it could not run, rather than demanding elevation.
- **Privacy.** Process and application names appear in this sheet. They stay local, on the same
  terms as the rest of the app.

## 10. Decisions needed before implementation

1. **Does the product line change?** Recommendation: no. “Understand your storage. Reclaim space
   safely.” still describes it; the new sheet supports that promise rather than replacing it.
2. **Startup disabling — ever?** Recommendation: no. Point at Task Manager, do not touch it.
3. **Elevation — offer it?** Recommendation: no. Report what could not be read.
4. **Desktop only?** Recommendation: yes. The phone build has none of these sources.
