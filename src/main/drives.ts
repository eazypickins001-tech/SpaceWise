// Which drive letters the start screen can offer, and which it could not read.
//
// Kept out of index.ts so the rule can be held to a fake filesystem by a test.
// The rule exists because a drive that was slow or unreadable was dropped from
// the list without a word: the person could see the drive in Explorer and not in
// the application, and nothing said why.
//
// What the letters actually answer, measured on Windows rather than assumed: a
// letter with nothing assigned to it fails in about a millisecond with ENOENT,
// while a letter that does hold a device fails with something else -- an empty
// card reader or optical drive gives a bare "UNKNOWN". So ENOENT is the one
// answer that means "there is no drive on this letter", and anything else is a
// letter the system has. Those are listed with their reason, which is also what
// Windows itself does with an empty card reader or optical drive.
import { statfs } from "node:fs/promises";
import type { DriveInfo } from "../shared/types";

export interface DriveStat {
  (path: string): Promise<{ blocks: number; bsize: number; bavail: number }>;
}

// A disconnected network share can hang, so a probe that does not answer is given
// up on rather than waited for.
export const PROBE_TIMEOUT_MS = 1500;

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const TIMED_OUT = "it did not answer in time";

// True for the one answer that means nothing is mounted on the letter.
export function isAbsent(error: unknown): boolean {
  return ((error as NodeJS.ErrnoException)?.code ?? "") === "ENOENT";
}

// What to tell the person about a drive that could not be read.
//
// Only the codes with one plain meaning are turned into a sentence. Anything
// else is reported as itself, because naming a cause the code does not carry is
// how "the system refused" and "they may be in use" got into this product.
export function reasonFor(error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code;
  switch (code) {
    case "ENOTCONN":
      return "the network drive is not connected";
    case "EACCES":
    case "EPERM":
      return "reading it needs permission";
    case "EBUSY":
      return "it is in use by something else";
    case "EIO":
      return "the device reported an input/output error";
    case "ENODEV":
      return "there is no device here";
    default:
      break;
  }
  if (typeof code === "string" && code !== "") return `it could not be read (${code})`;
  const message = (error as Error)?.message;
  return typeof message === "string" && message !== "" ? message : "it could not be read";
}

export async function listDrives(
  stat: DriveStat = statfs as unknown as DriveStat,
  options: { platform?: NodeJS.Platform; timeoutMs?: number } = {},
): Promise<DriveInfo[]> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    const s = await stat("/");
    return [{ path: "/", total: s.blocks * s.bsize, free: s.bavail * s.bsize }];
  }
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;

  const probe = async (letter: string): Promise<DriveInfo | null> => {
    const path = letter + ":\\";
    let s: { blocks: number; bsize: number; bavail: number };
    try {
      s = await Promise.race([
        stat(path),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(TIMED_OUT)), timeoutMs)),
      ]);
    } catch (error) {
      // No letter, nothing to say. Anything else is a drive the person can see:
      // report it with the reason instead of leaving it out.
      if (isAbsent(error)) return null;
      return { path, total: 0, free: 0, unavailable: reasonFor(error) };
    }
    const total = s.blocks * s.bsize;
    if (total <= 0) return { path, total: 0, free: 0, unavailable: "it reports no capacity" };
    return { path, total, free: s.bavail * s.bsize };
  };

  return (await Promise.all([...LETTERS].map(probe))).filter((d): d is DriveInfo => d !== null);
}
