// Directory listing, extracted from the scan worker so it can be tested.
//
// Two implementations. On Windows, a single call to GetFileInformationByHandleEx
// returns hundreds of entries with their sizes already in them, so no file is
// opened one by one. That gives the size on disk as well as the logical length.
// Anywhere else, or if the bulk path cannot load, it falls back to readdir plus
// lstat.
//
// Three things decided here are worth pinning down with tests, because getting
// any of them wrong makes every number the product reports wrong:
//
//   1. A junction or a symlink is recorded as a link and is never descended
//      into. A cloud placeholder is an ordinary file and is measured honestly.
//   2. Folders are opened with the \\?\ prefix, so a path deeper than 260
//      characters is still readable.
//   3. Names are UTF-8 regardless of what the filesystem handed over.
//
// The lister holds no state: the worker passes its own column writer in, which
// is what makes this module testable outside a worker thread.
import { lstatSync, readdirSync } from "fs";
import { sep } from "path";
import { F_DIR, F_ERR, F_LINK } from "../shared/types";

// Where entries go. The scan worker supplies its own column writer.
export interface EntrySink {
  add(name: string, flag: number, onDisk: number, length: number, mtime: number): void;
}

// Returns the number of entries, or an error code.
export type Lister = (dir: string) => number | string;

export function portableLister(sink: EntrySink): Lister {
  return (dir) => {
    const base = dir.endsWith(sep) ? dir : dir + sep;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return (e as NodeJS.ErrnoException).code ?? "EUNKNOWN";
    }
    for (const ent of entries) {
      if (ent.isSymbolicLink()) sink.add(ent.name, F_LINK, 0, 0, 0);
      else if (ent.isDirectory()) sink.add(ent.name, F_DIR, 0, 0, 0);
      else {
        try {
          const st = lstatSync(base + ent.name);
          // `blocks` is how many 512-byte units are really allocated, and it is
          // the honest answer for a sparse or compressed file. It is 0 on
          // Windows, where the logical length is the best that can be had
          // without the bulk path: the two numbers then agree, and the bulk path
          // is what actually runs there.
          const allocated = typeof st.blocks === "number" && st.blocks > 0 ? st.blocks * 512 : st.size;
          sink.add(ent.name, 0, allocated, st.size, Math.max(0, Math.floor(st.mtimeMs / 1000)));
        } catch {
          sink.add(ent.name, F_ERR, 0, 0, 0);
        }
      }
    }
    return entries.length;
  };
}

// The bulk path. Returns null when it cannot be used, so the caller falls back.
export function bulkLister(sink: EntrySink): Lister | null {
  if (process.platform !== "win32") return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require("koffi");
    const k32 = koffi.load("kernel32.dll");
    const CreateFileW = k32.func("__stdcall", "CreateFileW", "intptr_t", ["str16", "uint32", "uint32", "void *", "uint32", "uint32", "intptr_t"]);
    const GetInfo = k32.func("__stdcall", "GetFileInformationByHandleEx", "bool", ["intptr_t", "int", "void *", "uint32"]);
    const CloseHandle = k32.func("__stdcall", "CloseHandle", "bool", ["intptr_t"]);
    const GetLastError = k32.func("__stdcall", "GetLastError", "uint32", []);

    const FILE_LIST_DIRECTORY = 1;
    const SHARE_ALL = 7;
    const OPEN_EXISTING = 3;
    const BACKUP_SEMANTICS = 0x02000000; // needed to open a folder
    const FULL_DIR_INFO = 14; // FileFullDirectoryInfo
    const ATTR_DIRECTORY = 0x10;
    const ATTR_REPARSE = 0x400;
    const TAG_MOUNT_POINT = 0xa0000003;
    const TAG_SYMLINK = 0xa000000c;
    const EPOCH_GAP = 11644473600; // seconds from 1601 to 1970
    const buf = Buffer.allocUnsafe(256 * 1024);

    return (given) => {
      const dir = given.replaceAll("/", "\\");
      // The \\?\ form lifts the 260 character limit.
      const long = dir.startsWith("\\\\") ? (dir.startsWith("\\\\?\\") ? dir : "\\\\?\\UNC\\" + dir.slice(2)) : "\\\\?\\" + dir;
      const h = CreateFileW(long, FILE_LIST_DIRECTORY, SHARE_ALL, null, OPEN_EXISTING, BACKUP_SEMANTICS, 0) as number | bigint;
      if (h === -1 || h === -1n) {
        const code = GetLastError() as number;
        return code === 5 ? "EPERM" : code === 2 || code === 3 ? "ENOENT" : code === 32 ? "EBUSY" : "EWIN" + code;
      }
      let count = 0;
      try {
        while (GetInfo(h, FULL_DIR_INFO, buf, buf.length)) {
          let off = 0;
          for (;;) {
            const next = buf.readUInt32LE(off);
            const nameBytes = buf.readUInt32LE(off + 60);
            // Skip "." and "..".
            const dots =
              buf[off + 68] === 0x2e &&
              buf[off + 69] === 0 &&
              (nameBytes === 2 || (nameBytes === 4 && buf[off + 70] === 0x2e && buf[off + 71] === 0));
            if (!dots) {
              const attrs = buf.readUInt32LE(off + 56);
              const name = buf.toString("utf16le", off + 68, off + 68 + nameBytes);
              const isDir = (attrs & ATTR_DIRECTORY) !== 0;
              let link = false;
              if (attrs & ATTR_REPARSE) {
                // For a reparse point this field carries the tag. Junctions and
                // symlinks are not followed; cloud placeholders are ordinary.
                const tag = buf.readUInt32LE(off + 64);
                link = tag === TAG_MOUNT_POINT || tag === TAG_SYMLINK;
              }
              if (link) sink.add(name, F_LINK, 0, 0, 0);
              else if (isDir) sink.add(name, F_DIR, 0, 0, 0);
              else {
                const length = buf.readUInt32LE(off + 40) + buf.readUInt32LE(off + 44) * 4294967296;
                const onDisk = buf.readUInt32LE(off + 48) + buf.readUInt32LE(off + 52) * 4294967296;
                const ticks = buf.readUInt32LE(off + 24) + buf.readUInt32LE(off + 28) * 4294967296;
                sink.add(name, 0, onDisk, length, Math.max(0, Math.floor(ticks / 1e7 - EPOCH_GAP)));
              }
              count++;
            }
            if (next === 0) break;
            off += next;
          }
        }
      } finally {
        CloseHandle(h);
      }
      return count;
    };
  } catch {
    return null;
  }
}

export function makeLister(sink: EntrySink): Lister {
  return bulkLister(sink) ?? portableLister(sink);
}
