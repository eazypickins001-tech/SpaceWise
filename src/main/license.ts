// Licensing. Verification is entirely offline: a licence is a small JSON
// document signed with Ed25519, and the application holds only the public key.
// The private key never ships and never enters this repository.
//
// Three rules this module exists to enforce:
//   1. A licence can unlock features. It can never lock away someone's own
//      files, their settings, or their scan history. `preservesUserData` is
//      therefore always true and is asserted in the tests.
//   2. An unverifiable licence is treated as absent, never as valid.
//   3. Expiry is soft by a defined, visible margin, so a laptop that has been
//      offline for a fortnight does not lose the features it paid for.
import { createPublicKey, sign, verify } from "crypto";
import type { KeyObject } from "crypto";
import { DEFAULT_GRACE_DAYS, NO_LICENSE } from "../shared/entitlements";
import type { LicensePayload, LicenseState } from "../shared/entitlements";

// Everything about *what a plan unlocks* lives in src/shared/entitlements.ts, so
// the interface can read it without pulling in node:crypto. This module owns the
// part that has to be privileged: the signature.

export interface VerifyOptions {
  now: number;
  // The identifier this installation reports, or null when it cannot be built.
  machine: string | null;
  // Days a licence keeps working past its expiry date. See rule 3.
  graceDays?: number;
}

// The embedded public key. Set at release time by the vendor key generator;
// left empty here so a build cannot accidentally ship a placeholder key that
// verifies anything. With no key, every licence is refused.
export const EMBEDDED_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAs3I+F4EqSJDLzwosrCvA9HqlplIIjz0V2Z25vu1XTOI=
-----END PUBLIC KEY-----`;

const B64 = /^[A-Za-z0-9_-]+$/;

function fromBase64Url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}
function toBase64Url(b: Buffer): string {
  return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function refused(status: "invalid" | "expired", problem: string, payload: LicensePayload | null): LicenseState {
  return {
    status,
    plan: "free",
    pro: false,
    preservesUserData: true,
    payload,
    problem,
    daysLeft: null,
  };
}

// Splits and structurally checks a token without verifying the signature.
export function parseLicense(token: string): { payload: LicensePayload; body: Buffer; signature: Buffer } | null {
  const parts = token.trim().split(".");
  if (parts.length !== 2) return null;
  const [rawBody, rawSig] = parts;
  if (!B64.test(rawBody) || !B64.test(rawSig)) return null;
  const body = fromBase64Url(rawBody);
  const signature = fromBase64Url(rawSig);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const p = parsed as Record<string, unknown>;
  if (p.v !== 1) return null;
  if (typeof p.sub !== "string" || p.sub.trim() === "") return null;
  if (p.plan !== "pro") return null;
  if (typeof p.iat !== "number" || typeof p.exp !== "number") return null;
  if (p.machine !== undefined && typeof p.machine !== "string") return null;
  return { payload: p as unknown as LicensePayload, body, signature };
}

export function verifyLicense(token: string | null, publicKeyPem: string, opts: VerifyOptions): LicenseState {
  if (token === null || token.trim() === "") return { ...NO_LICENSE };
  if (publicKeyPem.trim() === "") {
    return refused("invalid", "No licence signing key is configured in this build.", null);
  }

  const parsed = parseLicense(token);
  if (!parsed) return refused("invalid", "That licence key is not in a format this version understands.", null);
  const { payload, body, signature } = parsed;

  let key: KeyObject;
  try {
    key = createPublicKey(publicKeyPem);
  } catch {
    return refused("invalid", "The licence signing key in this build is unreadable.", null);
  }

  // Ed25519: the algorithm is implied by the key, so the digest argument is null.
  let ok = false;
  try {
    ok = verify(null, body, key, signature);
  } catch {
    ok = false;
  }
  if (!ok) return refused("invalid", "That licence key is not valid. It may have been mistyped or altered.", payload);

  if (payload.machine !== undefined) {
    if (opts.machine === null) {
      return refused("invalid", "This licence is tied to one computer and this one could not be identified.", payload);
    }
    if (payload.machine !== opts.machine) {
      return refused("invalid", "This licence was issued for a different computer.", payload);
    }
  }

  const graceDays = opts.graceDays ?? DEFAULT_GRACE_DAYS;
  const secondsLeft = payload.exp - opts.now;

  if (secondsLeft > 0) {
    return {
      status: "valid",
      plan: "pro",
      pro: true,
      preservesUserData: true,
      payload,
      problem: null,
      daysLeft: Math.floor(secondsLeft / 86400),
    };
  }

  const graceLeft = payload.exp + graceDays * 86400 - opts.now;
  if (graceLeft > 0) {
    return {
      status: "grace",
      plan: "pro",
      pro: true,
      preservesUserData: true,
      payload,
      problem: `This licence expired ${Math.abs(Math.floor(secondsLeft / 86400))} day(s) ago. It keeps working for ${Math.ceil(
        graceLeft / 86400,
      )} more day(s).`,
      daysLeft: Math.ceil(graceLeft / 86400),
    };
  }

  return refused(
    "expired",
    "This licence has expired. Scanning, analysis and your saved history still work; the premium features do not.",
    payload,
  );
}

// Used by the vendor-side key generator, never by the shipped application.
export function signLicense(payload: LicensePayload, privateKeyPem: string): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const signature = sign(null, body, privateKeyPem);
  return `${toBase64Url(body)}.${toBase64Url(signature)}`;
}

// A stable, non-identifying machine fingerprint. It is a hash of the parts it is
// given, so nothing about the machine is recoverable from it. `machineId()` is
// pure; the caller decides which parts to feed in.
export function machineId(parts: readonly string[]): string {
  const h = new BunLike();
  for (const part of parts) h.push(part);
  return h.hex();
}

// A tiny FNV-1a-based digest, used only so this module stays dependency-free and
// testable without a platform. The licence itself is protected by Ed25519, not
// by this: a forged machine id gains nothing without a valid signature.
class BunLike {
  private h1 = 0x811c9dc5;
  private h2 = 0x01000193;
  push(s: string): void {
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      this.h1 = Math.imul(this.h1 ^ c, 16777619) >>> 0;
      this.h2 = Math.imul(this.h2 + c, 2246822519) >>> 0;
    }
  }
  hex(): string {
    return this.h1.toString(16).padStart(8, "0") + this.h2.toString(16).padStart(8, "0");
  }
}
