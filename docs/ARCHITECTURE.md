# Architecture

## Shape of the application

```
                 +--------------------------------------------------+
                 |  Renderer (React + TypeScript, sandboxed)        |
                 |  treemap, tree, panels, analysis, cleanup review  |
                 +---------------------+----------------------------+
                                       |  contextBridge: one typed `api`
                                       |  channels are `domain:action`
                 +---------------------v----------------------------+
                 |  Preload (context isolated, no Node exposed)      |
                 +---------------------+----------------------------+
                                       |  ipcRenderer.invoke / on
                 +---------------------v----------------------------+
                 |  Main process (privileged)                        |
                 |  windows, dialogs, shell, snapshots, licence,     |
                 |  audit log, worker supervision                    |
                 +---------+----------------------------------------+
                           |  worker_threads, transferable buffers
        +------------------+------------------+------------------+
        |                  |                  |                  |
   scanworker         dirworker          dupworker          (future)
   full scan          re-list folders    hash candidates
```

The load-bearing rule: **the scan result is never serialised as an object tree.** A scan is
a set of typed arrays. The renderer receives them as transferred `ArrayBuffer`s, so a
multi-million-file scan crosses a thread boundary without being copied node by node.

## The scan model

`src/shared/types.ts` defines `ScanTable`: parallel columns (`parent`, `size`, `logical`,
`mtime`, `flags`, `files`, `ext`) plus one UTF-8 name buffer and a flattened child index.
Node 0 is the root, and every parent index is lower than its children, which is what makes a
single reverse pass a complete size rollup.

Roughly 60 bytes per file, dominated by the columns rather than by per-node objects. That is
the reason the analysis functions can all be pure loops.

`src/shared/table.ts` turns the raw scanner output into that table:

- `finishTable` sums bytes, logical bytes and file counts upward, propagates the newest
  change time, indexes extensions, and builds the children lists sorted largest first.
- `previewTable` does the same for a scan still running, keeping the folder at the cut as a
  solid block so its weight still shows on the plan.
- `tableBuffers` returns the columns for transfer to another thread.

Both rollup functions are pure and are the most heavily tested code in the repository.

### Two size columns

`size` is what the file occupies on disk. `logical` is its byte length. They diverge for
compressed, sparse and cloud placeholder files. Both are aggregated, both are available to
the interface, and a test asserts they are never conflated.

## Scanning

- One coordinator thread spawns one worker per core.
- On Windows the workers list directories in batches through the Win32 API via `koffi`
  (prebuilt FFI, so no C++ compiler is needed to build or ship). Elsewhere they fall back to
  `readdir` plus `lstat`.
- Errors are recorded per node and sampled into `errorSamples`; they never abort a scan.
- Junctions and symlinks are recorded as `F_LINK` and are never traversed. Cycle avoidance is
  by construction rather than by a visited set.
- Cancellation is two-stage: `scan:stop` asks the worker for a final partial table, and
  `scan:cancel` retires it. `retire()` posts a cancel message and only terminates the thread
  after a grace period, because tearing a worker down mid-native-call can take the process
  with it.

### The lister

`src/main/lister.ts` holds the two directory-listing implementations and the choice between
them: the Win32 bulk path through `koffi`, and the `readdir` plus `lstat` fallback. It is a
separate module with no worker dependency, taking an `EntrySink` instead of writing into the
worker's own columns, purely so it can be tested outside a worker thread. It decides the size
of every file and whether a reparse point is followed, which is why it is now the most heavily
tested part of the scanning side.

Three properties, each pinned by a test:

- a junction or symlink is reported as a link and is never descended into;
- a path over 260 characters is still readable, via the `\\?\` prefix;
- a hard link is reported once per name. That is inherited behaviour and is disclosed in the
  interface rather than hidden, because it makes folders such as `WinSxS` look larger than the
  bytes they uniquely own.

The two implementations are not identical, and the tests state where rather than pretending
otherwise. On Windows the bulk path reports the real allocation, rounded up to a cluster, while
the fallback has only the logical length; and listing a path that is a file returns an error on
the fallback but an empty result on the bulk path. Neither difference is reachable in normal
use, because the coordinator only ever dispatches folders and Windows always gets the bulk path.

## Snapshots and comparison

Each scan writes a reduced snapshot (every folder, plus files above a floor). Comparison
walks the current tree and the snapshot together, matching children by name, and reports the
deepest node that still explains a change rather than the whole chain of ancestors above it.
A comparison can show **what** changed; it cannot show **which application** caused it, and
the interface does not imply otherwise.

## Storage intelligence

`src/shared/storage-intelligence.ts` answers "what is this, and what does removing it cost".

It exposes a `ScanView` (which the renderer's `Disk` class already satisfies), and returns
`Finding`s that each carry the category, the measured bytes, a risk level, the specific
evidence that triggered the match, and the consequence of removal. Categories declare what
they contain, why they grow and how they regenerate.

Two rules are enforced by construction and pinned by tests:

1. **A name is a hint, never a verdict.** `dist`, `build`, `out`, `bin`, `obj`, `venv` and
   `vendor` only count when a sibling file proves the ecosystem. A folder named `cache` in an
   unremarkable location produces nothing at all.
2. **Nested candidates are counted once, at the outermost folder.** The bytes a plan reports
   as reclaimable are therefore additive, not inflated.

## Safe cleanup

`src/shared/cleanup.ts` is pure. It never touches the disk; it decides what may be touched,
through an injected `FsProbe`:

```
validatePath  →  is it inside the scanned folder, and not protected?
buildPlan     →  resolve each path, capture size+mtime, record every refusal
revalidate    →  compare size+mtime again immediately before the action
summarize     →  removed / failed / skipped counted apart, `partial` if anything survived
buildAudit    →  one record: planned, estimated, what happened, what was refused
```

Nothing permanently deletes by default, and a bare wildcard is refused outright.

The interface side is `src/renderer/src/components/Cleanup.tsx`. It owns the entire flow —
selection, planning, the review sheet, the results sheet — so the rest of the window only has
to render the tab and tell it how to take removed nodes off the tree. `src/main/audit-log.ts`
writes one JSON line per run to `cleanup-audit.jsonl` in the application's user-data folder,
capped at 200 runs.

The main process supplies the only two things that need a real filesystem: an `FsProbe` built
on `lstatSync` (never `statSync`, so a junction is fingerprinted as the link rather than as its
target), and the call to `shell.trashItem`. Every plan must name a root the window actually
scanned.

## Licensing

`src/main/license.ts`. A licence is a small JSON payload signed with Ed25519; only the public
key is compiled into the application and the private key never enters the repository. Because
verification is entirely offline, an offline machine keeps working. Expiry is soft by a
configurable grace window. `preservesUserData` is hard-coded true.

See `docs/LICENSING.md`.

## Deliberate non-goals

- No registry cleaning, service or startup modification, or process termination.
- No scheduled unattended cleanup. A scheduled run would scan and report only.
- No database. Snapshots and the audit log are files under the application's user-data
  directory, which is the simplest thing that supports the required behaviour.

## Known structural debt

- `src/renderer/src/App.tsx` is ~2,200 lines and holds the phone/tablet layout. The phone
  components are inert on desktop (`api.compact` is false) but they make the file harder to
  work in. Splitting them out is a roadmap item, not a functional gap.
- Every IPC handler that turns a renderer-supplied path into a filesystem action goes through
  `src/main/scope.ts`, which is pure and tested on its own. The cleanup planner keeps its own
  stricter rules on top (per-item revalidation, a protected list, `lstat` for junctions).
  The scope rule is hygiene rather than a boundary, because `scan:start` trusts the root it is
  given; the protected-location rule inside it is the part that holds. See `docs/SECURITY.md`.
- The cleanup audit log is written on every run and is readable from the History button in the
  Clean up tab, but the view draws only per-run counts. The refusals it stores are not shown.
