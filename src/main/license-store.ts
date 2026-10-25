// Where a licence is kept, and how the interface asks about it.
//
// The rule that shapes this file: a token is verified *before* it is written. An
// invalid key is never left lying in the user-data folder where a later run
// might read it back and mistake it for a real one. A signature that verified
// but has expired is kept, because the record of what someone bought should
// outlive the term.
//
// The public key is passed in rather than read from the module constant, so the
// whole thing can be tested against a throwaway key pair.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { arch, hostname, platform } from "os";
import { dirname } from "path";
import { DEFAULT_GRACE_DAYS, NO_LICENSE } from "../shared/entitlements";
import type { LicenseState } from "../shared/entitlements";
import { machineId, verifyLicense } from "./license";

export interface LicenseStore {
  // Absolute path of the token file.
  file: string;
  // The vendor's public key. Empty in a build with no key configured, which
  // makes every licence invalid rather than accidentally accepted.
  publicKey: string;
}

// A stable, non-identifying fingerprint of this machine. Only the hash is ever
// written into a licence, so nothing about the machine is recoverable from it.
export function currentMachineId(): string {
  return machineId([hostname(), platform(), arch()]);
}

function verify(store: LicenseStore, token: string | null, now: number): LicenseState {
  return verifyLicense(token, store.publicKey, {
    now: Math.floor(now / 1000),
    machine: currentMachineId(),
    graceDays: DEFAULT_GRACE_DAYS,
  });
}

function readToken(file: string): string | null {
  try {
    if (!existsSync(file)) return null;
    const raw = readFileSync(file, "utf8").trim();
    return raw === "" ? null : raw;
  } catch {
    return null;
  }
}

// Reads whatever is stored and says what it means right now.
export function licenseStatus(store: LicenseStore, now = Date.now()): LicenseState {
  return verify(store, readToken(store.file), now);
}

// What the interface calls when someone pastes a key. Returns the resulting
// state, so the caller can show exactly why a key was refused.
export function activateLicense(store: LicenseStore, token: string, now = Date.now()): LicenseState {
  const trimmed = String(token ?? "").trim();
  const state = verify(store, trimmed === "" ? null : trimmed, now);
  // A good signature is worth keeping even once the term has ended: the payload
  // records who bought what, and expiry is a feature switch, not a deletion.
  if (state.status === "valid" || state.status === "grace" || state.status === "expired") {
    try {
      mkdirSync(dirname(store.file), { recursive: true });
      writeFileSync(store.file, trimmed + "\n");
    } catch {
      // A licence that cannot be saved still works for this session.
    }
  }
  return state;
}

export function clearLicense(store: LicenseStore): LicenseState {
  try {
    rmSync(store.file, { force: true });
  } catch {
    // Already gone.
  }
  return { ...NO_LICENSE };
}
