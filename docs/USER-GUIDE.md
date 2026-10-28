# SpaceWise — user guide

For anyone using the application, rather than working on it. Developers wanting the test
harness, the benchmarks or the manual checklist should read `TESTING.md`; the design decisions
and their reasons are in `ARCHITECTURE.md` and `SECURITY.md`.

---

## What it is

SpaceWise tells you what is filling up a drive or folder, and helps you get some of it back
without losing anything you meant to keep.

It scans a folder, shows the contents as a map of rectangles sized by what each thing occupies,
and lets you look closer. When there is something worth clearing, it builds a plan, shows you
exactly what it would do, and moves what you approve to the **Recycle Bin** — where you can
still get it back.

**What it deliberately does not do.** It does not touch the registry. It does not disable
startup programs, stop services or "optimise" your PC. It does not clean anything on a schedule
or in the background. It does not claim to make your computer faster. Nothing is deleted without
you approving that specific item, and there is no "one-click clean everything" button — that
button is the reason tools like this lose people's work.

It works with no internet connection. Scanning, analysis and cleanup never need one.

---

## Installing

The installer is **`SpaceWise-Setup-0.1.1-x64.exe`** (about 107 MB). There is also a portable
build that runs without installing anything, described below.

1. Run the installer. It installs for **your account only**, so it does not need administrator
   rights, and it lets you choose the folder. The default is under your own user folder, in
   `AppData\Local\Programs\SpaceWise`. It creates a **desktop shortcut and a Start Menu
   entry**, both called SpaceWise. If you would rather not have the desktop one, delete it —
   the Start Menu entry is enough to launch it, and the application does not care either way.
2. **Windows will warn you the first time you run it.** It will show a blue box saying
   *"Windows protected your PC"*, because the application is not signed with a paid certificate
   yet. Click **More info**, then **Run anyway**. This is what an unsigned application looks
   like, and it is worth knowing that it is exactly what an unwanted application looks like too
   — only run an installer you got from somewhere you trust.
3. There is no licence to accept, no account to create, and nothing to sign in to.

**The portable version** is `SpaceWise-0.1.1-x64.exe`. It needs no installation and leaves no
installer behind — useful for a USB stick or a machine you do not want to change. It also
creates no shortcut and no Start Menu entry, because it does not install anything; if you want
a shortcut, use the installer. Your settings
and scan history are still kept in your user folder, so it is not fully self-contained.

### Updating

Version checks are **manual**: the application never downloads or installs anything on its own.
You ask it to check, and you approve the download and the install separately. Updates are not
cryptographically signed at present, so only accept an update you were expecting.

---

## Your first scan

Open SpaceWise and pick something to scan:

- **Ctrl+O** opens a folder picker.
- **Drag a folder onto the window**.
- **Click a drive** in the opening screen to scan the whole thing.

Clicking a whole drive is the honest starting point if you do not know what is filling it up.
The first scan of a large drive takes a while — the application works out the size of every
file, and it is reading real disk metadata, not guessing.

You can **cancel at any point**. Cancelling returns what it has already measured and marks the
result as incomplete, rather than pretending it is the whole picture. **F5** rescans.

---

## Reading what you see

**The map.** Each rectangle is a file or folder. Bigger means more space. Click one to zoom in,
and the path at the top tells you where you are. Folders too small to draw are gathered into one
block rather than dropped, so the map always accounts for the whole folder.

**Two sizes, and the difference matters.** Every file has two figures:

- **Logical size** — what the file "is", the number you would see in a file's properties.
- **On-disk size** — what it actually occupies, rounded up to disk clusters.

A folder of ten thousand tiny files can occupy far more than the sum of its file sizes, because
each file rounds up to its own cluster. SpaceWise shows the on-disk figure wherever it is about
space you could get back, and says which figure it is showing. When the two differ a lot, that is
usually the answer to "why is this folder eating my drive".

**What it cannot see.** A file locked by another program, or a folder your account cannot open,
is not silently skipped — it is counted as unreadable and listed, and the total is marked as
having gaps. If you scan `C:\Windows` as an ordinary user, expect a number of these.

---

## Cleaning up safely

Open the **Clean up** tab after a scan. The order is always the same:

1. **Pick.** SpaceWise proposes candidates — temporary files, caches, build output, logs and
   similar. **Nothing is ticked for you.** Every item is your decision.
2. **Plan.** You see what would happen, item by item, with what each one would free.
3. **Revalidate.** Immediately before anything moves, each item is checked again: still there,
   still the same size, still the same age. If any of that changed, that item is **refused** and
   left exactly where it is. This is what stops a stale plan from deleting something you edited
   while the window was open.
4. **Confirm.** You see the final list.
5. **Report.** Removed, failed and skipped are listed separately. A run that left anything behind
   is marked incomplete — never reported as a tidy success.

Files go to the **Recycle Bin**, so a mistake is recoverable. Afterwards, the run is recorded in
History, including anything that was refused and why.

Protected locations — the Windows folder, Program Files, and credential stores such as browser
passwords and SSH keys — are refused outright, even if you scanned a drive that contains them.

---

## Finding duplicates

The **Duplicates** tab groups files with identical contents. It works in two passes: it compares
the start and end of each file first, and only reads the whole file for the ones that already
match. That keeps it fast without weakening it.

The figure it reports is **what you would actually get back**: the total of the copies, minus the
one it keeps. It uses the on-disk size, so it does not overstate what a folder of small files
will yield.

**Two things it will not offer.** A name whose contents are shared with another name on disk (a
hard link) is left out, because deleting one of those names frees nothing — the other name still
holds the file. And a file that cannot be examined is left alone rather than assumed to be safe.
Your scan total still counts a hard-linked file once per name, which is standard for storage
tools; the duplicates figure does not.

---

## Watching your storage over time

Every scan is saved locally, so you can see how a folder changed since last time. Comparing two
scans is a paid feature (see below); the saved history itself is free.

---

## Why Is My PC Slow?

If the computer feels slow, the opening screen has a button for it. It reads six things and tells
you what it found. It changes nothing, and it never reports something it could not measure.

1. Open SpaceWise. On the opening screen, click **Why Is My PC Slow?** — it has a row of its own
   below the scan buttons.
2. Read the list. It is ordered worst first, and each line says how much weight to give it:
   **Most important**, **Worth a look**, or **For information**.
3. Use the button on a line if it has one. **Look at the largest files** takes you to the files
   using the space. **Open Windows Settings** opens the Windows screen that owns that fix.
4. Read the bottom line. Anything that could not be read is named there, with the reason Windows
   gave — a reading that failed is never counted as a pass.

**What it reads.** How full the system drive is. How much memory is committed, against what the
system can commit. Whether a disk reports itself healthy, plus its wear and error counters. How
long disk transfers are taking. What Windows measured the last start-up at. How many items start
when you sign in.

Two of those live in places Windows keeps for administrators — the start-up measurement is one —
and SpaceWise runs as you, so a reading may say it needs administrator rights. It says that rather
than guessing, and it never asks for elevation to get it. Some machines' storage drivers report no
physical disk at all; that is named too, never counted as healthy.

**What it will not do.** It does not stop a service, disable a start-up item, end a program, change
the registry or clean anything, and it gives your PC no score. It will never tell you it made the
machine faster.

Some of these readings need administrator rights. If Windows refuses, that is exactly what the
bottom of the list says.

---

## The optional written summary

There is one feature that can talk to something outside your computer, and it is **off until you
set it up**. It writes a short description of your scan in words. It is genuinely optional.

Before it sends anything you are asked for three things, in the **Storage summary** sheet on the
Clean up tab:

- an **address**. Anything on the internet must be `https`. A model running on your own computer
  may use `http://127.0.0.1` with whatever port it listens on, and then nothing leaves the machine.
- one or more **model names**, one per line, as your endpoint spells them. If the first cannot
  answer — a provider having a bad day, a rate limit, a model withdrawn — the next is tried
  automatically and you are told nothing about it. The first that answers is the one used, and
  the result says which that was. Listing two or three is the difference between a feature that
  works when one provider is down and one that does not.
- an **API key**, if your endpoint wants one. It is stored in your own user folder, never in the
  program.

Then it shows you **the exact text it will send**, word for word, above the button that sends it.
It is short: how many files, how big, which folders hold the most, and a breakdown by type. It
does **not** include your file contents, and it does not include file names unless you tick the
box for names — and even then, folders are named relative to the folder you scanned, never as a
full path. A folder outside the scan is reduced to its last few characters, and a whole drive is
described as a drive.

**It cannot delete, select or recommend deleting anything.** It writes prose, which is displayed
beside your findings. There is no path from that text to an action. The message is capped in size,
so a scan of a million files produces a short message rather than a dump.

**Asking about one folder.** Next to any finding in the Clean up tab there is an **Ask** button.
It opens a sheet that states, from the application's own rules, what the folder is, why it was
flagged and what happens if it goes — and that part needs nothing from the assistant and is
shown whether or not you have configured one. Below it you can ask follow-up questions in
words, and the assistant answers using those same facts. It cannot see inside the folder, it
will not tell you whether to delete anything, and the verdicts stay with the rules.

This also needs a paid licence.

---

## Free and paid

**Everything that touches your files is free, and is not time-limited.** Scanning, the map, the
folder tree, the type breakdown, reviewed cleanup with the full safety model, local history and
duplicate detection are all free. Putting the safety model behind a paywall would make the free
version dangerous, so it is not behind one.

A licence adds:

- **Comparing scans** — what changed between two scans of the same folder.
- **Unlimited duplicate results** — without a licence the duplicate list shows the twenty sets
  worth the most and tells you how many it left out and what they hold. A licence lifts that cap.
- **The optional written summary**, and the **Ask** button beside a finding.

Everything the Licence sheet lists is attached to code, so nothing advertised there is decoration.
An earlier version advertised three features that did not exist; those were removed rather than
left as promises, and one that had no code behind it was built instead.

A printable version of this guide, for handing to someone, is `docs/user-guide.html`.

**Where to put a licence.** The **Licence** sheet, from the menu. Paste the key you were given.

**When a licence expires**, it keeps working for a fortnight's grace, so a machine that has been
offline does not lose features it paid for. After that the paid features stop, with a clear
message — and your files, your settings, your scan history and the free features are all
untouched. An expired licence never locks you out of your own data.

---

## Where your data lives

Everything SpaceWise keeps is in your own user folder, at **`%APPDATA%\SpaceWise`**:

| File | What it is |
| --- | --- |
| `snapshots\` | One file per scan, so history and comparison work |
| `cleanup-audit.jsonl` | A record of every cleanup, one line per action |
| `license.key` | Your licence, if you have one |
| `ai-summary.json` | Your summary endpoint and key, if you set one up |

Delete that folder and the application forgets everything — it will not touch your actual files.
Nothing here is uploaded anywhere, and there is no account, no telemetry and no analytics.

---

## Uninstalling

**Settings → Apps → Installed apps → SpaceWise → Uninstall**, or run the uninstaller in the
folder you installed it to.

Uninstalling removes the application. **It leaves `%APPDATA%\SpaceWise` alone**, so your scan
history and licence survive a reinstall. Delete that folder yourself if you want it gone.

---

## Known limitations

Stated plainly, because finding out later is worse.

- **The application is not signed.** Windows shows the *"Windows protected your PC"* warning on
  first run. Nothing else is affected, and no feature is blocked.
- **Updates are not signed and are never automatic.** You approve each step by hand.
- **Hard-linked files are counted once per name** in scan totals. This is standard for storage
  tools, and it makes folders such as `WinSxS` look larger than the space they uniquely occupy.
  The duplicates figure is not affected.
- **A compressed or sparse file shows the space it takes, which can be nothing.** Windows can store
  a file in fewer clusters than its length — or in none at all, for a hole or a fully compressed
  file. SpaceWise reports what the drive says the file occupies, so a 12 MB text file on a
  compressed volume can read as a few kilobytes or as 0 B, and a file occupying nothing does not
  appear under Largest. That is the space it is using, not a measurement failure.
- **The main paths are checked automatically; the rest of the interaction is not.** `npm run smoke`
  opens every sheet, scans a small fixture folder, clicks every tab, clicks a row and sends it to
  the Recycle Bin, ticks two rows and deletes them together, runs a duplicate search and removes one
  copy, and carries out a cleanup review — checking each time that the files really left the disk and
  the lists. What no test does is open a right-click menu, drag a folder in, use the arrow keys or the
  file clipboard, or open the cleanup history and the optional summary.
- **The map's arithmetic is measured; its painting is not verified automatically.**
- **No installer, upgrade or uninstall test on a clean machine has been run.**
- **Large drives take time.** The scan rate was measured at between roughly thirty thousand and
  seventy-five thousand files per second on a development machine, depending on what else that
  machine was doing, and the application spreads the work across your processor's cores. A drive
  with a million files is tens of seconds at best, and longer on a busy machine.

---

## If something goes wrong

- **A folder shows as unreadable.** Your account cannot open it. That is expected for parts of
  `C:\Windows` and for other users' folders. It does not stop the scan.
- **A cleanup item was refused.** Something about it changed while the window was open. It was
  left alone deliberately; rescan and try again.
- **A duplicate was not offered.** Either it is genuinely not identical, or its contents are
  shared with another name on disk, or it could not be examined. All three are deliberate.
- **The summary did not work.** Check the address is `https` for anything remote, and that the
  model name is one your endpoint recognises. The message shown above the button is exactly what
  was sent, so it is the thing to check.
- **Something moved that you wanted.** Restore it from the Recycle Bin. Files are only ever moved
  there, never deleted outright, until you empty the bin yourself.
