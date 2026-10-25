# Security

## Threat model

SpaceWise runs with the privileges of the person who launched it, reads file metadata across
the whole disk, and can move files to the Recycle Bin. The things that could go wrong, in
order of how much they would hurt:

1. **Destroying data the user wanted.** The most likely and most serious.
2. **Acting outside the scope the user chose** — following a link, or being tricked into
   operating on a path that is not what it appears to be.
3. **Being turned into a weapon.** A renderer compromise (XSS in a future feature, a
   compromised dependency) escalating to arbitrary filesystem operations.
4. **Leaking what is on the disk.** File names and paths are sensitive.
5. **Supply chain.** A malicious dependency, or a tampered update.

## Controls

### Process and window isolation

| Control | Setting |
| --- | --- |
| Renderer sandbox | `sandbox: true` |
| Context isolation | `contextIsolation: true` |
| Node integration in the renderer | Absent (Electron default is off) |
| Preload surface | One frozen `api` object over `contextBridge`; `ipcRenderer` itself is never exposed |
| Navigation | `will-navigate` is prevented; new windows are denied |
| External links | Only `https:` URLs are opened, and only through `shell.openExternal` |
| Content Security Policy | `default-src 'none'`, `script-src 'self'`, `style-src 'self'`, `object-src 'none'`, `base-uri 'none'`, `form-action 'none'` |

There is **no `'unsafe-inline'` in this build**, and no nonce, because the interface has no
inline styles to authorise. The production renderer is one external script and one external
stylesheet; `index.html` contains neither a `<style>` block nor a `style=` attribute.

An earlier revision of this document claimed the allowance was needed because React sets inline
`style` attributes. **That was wrong, and it is worth being precise about why.** React applies
`style={{...}}` through the CSS object model (`element.style.x = ...`), and a `style-src`
directive does not govern the CSS object model — it governs `<style>` elements and `style`
attributes. Verified rather than assumed, by `npm run smoke`, which asserts all three cases
against the built interface:

| Written by | Refused? | Does SpaceWise do it? |
| --- | --- | --- |
| `<style>` element | yes | no |
| `style="..."` attribute | yes | no |
| `element.style.x = ...` (CSS object model) | **no** | yes, on every styled component |

So the policy now refuses exactly the two things the application never does, and permits the one
it relies on.

**Development differs, and the difference is visible.** The Vite dev server injects styles
through `<style>` elements, so `style-src` in development is `'self' 'unsafe-inline'`. The policy
lives in `index.html` with a `%STYLE_SRC_EXTRA%` placeholder, and a plugin in
`electron.vite.config.ts` fills it in only while serving. A development-only relaxation is
therefore legible in the HTML rather than hidden behind a build flag, and the packaged archive is
checked for the placeholder so a stray build cannot ship one.

This is enforced by a scheduler-free smoke test, not by review. `npm run smoke` loads the built
interface with the real policy and fails if anything is refused, if React does not mount, if the
stylesheet does not apply, if `require()` is reachable, or if the policy stops refusing an
injected `<style>` — the last of which guards against the test silently passing for the wrong
reason.

### Path handling

- Paths are normalised before comparison: separators collapsed, `.` dropped, `..` resolved
  **without ever climbing above the root of the path given**, so `C:\a\..\..\..\evil`
  normalises to `C:\evil` and is then refused for being outside the scope.
- Containment is segment-aware. `C:\ProgramData2` is **not** treated as being inside
  `C:\ProgramData`.
- A bare wildcard (`*`, `?`) is refused outright. There is no code path that expands one.
- Refused, regardless of the rule that produced them: drive roots, anything under
  `\Windows`, `\Program Files`, `\Program Files (x86)`, `\ProgramData`, `\$Recycle.Bin`,
  `\System Volume Information`, `\Recovery`, `\Boot`, `\EFI` — at any depth — plus any path
  containing `.git`, `.ssh`, `.gnupg`, `Cookies`, `Login Data`, `logins.json`, `key3.db` or
  `key4.db`.
- Consequence worth stating plainly: because `\Windows` is refused at any depth,
  `C:\Windows\Temp` cannot be cleaned automatically. That is deliberate. A running installer
  may be using it, and the Refuse is the safe default.

### Time-of-check/time-of-use

The plan captures each item's size and modification time. Immediately before the action, both
are read again. A path that moved, shrank, grew or changed timestamp is dropped and reported
as invalidated rather than acted on. The protected-path check runs again at that point too,
so a plan cannot be assembled that bypasses it.

### Command construction

The one place a shell is invoked is clipboard integration, which calls
`execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", …])` with a
timeout, `windowsHide`, and the file paths passed through the **environment**
(`$env:SPACEWISE_PATHS`), never interpolated into the command text. There is no place where a
user-controlled string reaches a shell.

### Failure reporting

- Unreadable folders are counted and sampled, never silently skipped.
- Deletion results are per path, with removed, failed and skipped counted separately.
- A run that left anything behind is marked `partial` and never reported as complete.
- A file locked by another program is reported as skipped, not as removed.

### Data handling

- No telemetry, analytics or crash reporting.
- The audit log contains the user's own paths and is written only under the application's
  user-data directory. It is never transmitted.
- No credentials of any kind are stored by the application.

### Licensing

- Verification is Ed25519 with a public key compiled in; the private key never ships and
  never enters this repository.
- With no key configured, every licence is refused rather than accepted, and says so rather
  than looking like a mistyped key. One test asserts that behaviour; another asserts that
  whatever key is compiled in is a usable Ed25519 public key, because a truncated key refuses
  every licence and from the inside looks exactly like a customer who has not paid.
- A licence can unlock features. It can never lock access to files, settings or scan
  history; `preservesUserData` is hard-coded `true` and asserted in tests.

## The optional storage summary

This is the only feature that talks to anything outside the machine, so its boundaries are
stated here rather than left to the code.

- **It is off unless asked for, twice over.** The feature needs a licence, and it needs an
  endpoint the person has configured. Until both are true nothing is sent and no address is
  even known.
- **It can never send something it was not shown.** The message is built by one pure function
  (`src/shared/ai-summary.ts`) from the findings the deterministic rules already produced. It
  contains no file contents, no absolute path, and no name at all unless the person ticks the
  box for names. That exact text is displayed, verbatim, above the button that sends it.
- **The same bounds apply to asking about one folder.** The item-anchored chat sends the rules'
  own words about that item -- why it was flagged, what they say happens if it goes, and what
  the category is -- plus the question and the last few turns. It sends nothing else, it obeys
  the same name toggle, and the standing instructions for it forbid saying whether anything is
  safe to delete and forbid implying it has read the folder. The facts shown on screen are the
  facts sent.
- **It cannot select or delete anything.** There is no code path from the summary to an action.
  It returns prose, which is drawn beside the findings and nowhere else.
- **The address it may reach is constrained.** Anything remote must be `https`; plain `http` is
  accepted only on the loopback address, so a model on this machine can be used without a
  certificate and nothing else can be.
- **More than one model can be configured, and any of them may be the one that answers.** If the
  list holds models from different companies, the message can reach the second company because
  the first was unavailable. That is the intended behaviour, and it is why the list is typed by
  the person rather than shipped with the application: it is a list of places they are content
  to send this text. It is recorded here because a fallback that changes who receives the data
  is a privacy decision, not only a reliability one.
- **The key stays in the main process.** The interface is told whether a key exists, never what
  it is, and the settings file is written owner-only.
- **The message is capped in size** (8 KiB) as well as in findings and types, so a scan of a
  million files produces a short message rather than a dump. The ceiling is enforced where the
  message is built and again where it is sent.

The residual: the main process cannot tell whether the text it is handed was the text that was
displayed, so a compromised renderer could send a different message to whatever endpoint the
person configured. It is bounded by the size ceiling, the endpoint is one the person chose, and
it sits inside the same trust boundary as the rest of the interface -- recorded so that it is a
decision rather than an oversight.

## Known weaknesses, stated rather than glossed

1. **The raw path handlers accepted arbitrary renderer-supplied paths.** **Closed, with one
   residual stated rather than hidden.** Every handler that turns a renderer-supplied path into
   a filesystem action now goes through one pure policy in `src/main/scope.ts`, tested in
   `src/main/scope.test.ts`:

   | Handler | What it may name |
   | --- | --- |
   | `shell:showInFolder`, `shell:openPath` | the scanned root, or anything inside it |
   | `fs:stat`, `fs:measure`, opening a snapshot | the scanned root, or anything inside it |
   | destination of `fs:paste`, root of `watch:start` | the scanned root, or anything inside it |
   | `shell:trash`, a cut source in `clip:set` / `fs:paste` | strictly inside a scan, never the root itself |
   | `dup:start` candidates | anything inside a scan; groups that fail are dropped |

   Two rules sit behind that table, and they are not equally strong:

   - **The scope rule is hygiene, not a boundary.** `scan:start` accepts a renderer-supplied
     root and trusts it immediately, and so does `win:new`, which hands its root to the renderer
     as a URL hash that the renderer then scans. Anything that can reach those two can put any
     existing folder in scope. Scoping is still worth having -- it keeps an interface mistake
     inside the window's own subject matter, and it is the precondition for tightening scan
     initiation later -- but it should not be described as having stopped an attacker.
   - **The protected-location rule is the part that holds.** Operating-system folders,
     credential stores (`.ssh`, `.git`, `Cookies`, `Login Data`, ...) and drive roots are refused
     even when the folder *was* scanned, because the stated reason is the location and not the
     scope. A compromised renderer can start a scan of `C:\Windows`; it still cannot act on
     anything inside it. That is the property `scope.test.ts` pins down under a heading of its
     own.

   **The residual.** A *copy* source in `fs:paste` is deliberately unscoped, and so is a copy in
   `clip:set`. Copying a file in from Explorer is a normal thing to do, the source is not
   modified, and the interface cannot tell a real drop from a forged one. The consequence is
   that a compromised renderer could copy a file from any readable location into a folder the
   user scanned. It cannot read those bytes back: the interface surfaces names, sizes and
   metadata, and the duplicate finder reads bytes only to hash them. Low severity, recorded.
2. **No code signing.** An unsigned binary invites tampering and triggers SmartScreen. Until
   a certificate exists, users should verify the published SHA-256 sums.
3. **The update feed is configured, which raises the stakes on item 2.** `electron-updater` now
   points at the GitHub release feed named in `package.json`, and `app-update.yml` is written
   into the package. What keeps this acceptable while the binary is unsigned is that downloads
   are never automatic (`autoDownload = false`) and a check happens only when the person asks
   for one. As it stands, the only thing between a compromised GitHub release and a user
   running it is a SHA-512 in `latest.yml` published from the same place, which is integrity,
   not authenticity. Recorded as a trade made deliberately, not an oversight.
4. **A duplicate was removed on a claim of identity that could go stale.** **Closed for the
   desktop path, with one residual stated.** The finder refuses to judge a file whose length no
   longer matches the scan, and `shell:trash` revalidates every target immediately before it
   removes it -- the same `changedSince` guard the cleanup planner uses, so there is one
   comparison rather than two that could drift apart. A file that changed, disappeared, or
   cannot be fingerprinted is left where it is and reported as left alone.

   The guard is only as good as the agreement between what the scanner recorded and what a
   fresh `lstat` reports. If those differed by a second, every honest deletion would be refused
   as "changed". `src/main/scan-trash-agreement.test.ts` pins that agreement for both listers,
   including either side of a whole second, and fails if the Windows bulk lister is missing on
   Windows, so the production path cannot be skipped while looking tested.

   The **Android path** had the same shape of gap: `phone.erase` took bare paths. There is no
   Android implementation in this repository -- `window.api.phone` is `undefined` on the
   desktop, and the interface already guards on that -- so nothing was exposed in practice.
   Rather than leave a note for whoever writes that build, `erase` now takes the same
   `TrashTarget` the desktop path takes, so the guard is available to it and passing a bare
   path is a type error rather than a forgotten check.
5. **A compromised dependency** is not mitigated beyond npm's lockfile and the fact that the
   runtime dependency list is deliberately tiny (`electron-updater`, `koffi`). No SBOM is
   generated yet.

## Reporting a vulnerability

Do not open a public issue for a data-loss or security problem. Until a private channel
exists, report it to the maintainer directly and allow time for a fix before disclosure.
