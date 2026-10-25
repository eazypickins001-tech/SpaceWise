// The licence store, against a real temporary file and a throwaway key pair.
//
// The behaviour worth protecting here is that an invalid key is never written:
// a token file that exists is a token file that once verified, so nothing later
// can read a bad key back and treat it as real.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activateLicense, clearLicense, licenseStatus } from "./license-store";
import type { LicenseStore } from "./license-store";
import { signLicense } from "./license";
import { hasFeature } from "../shared/entitlements";
import type { LicensePayload } from "../shared/entitlements";

const DAY = 86400;
// Fixed so the assertions are about the rules, not about today's date.
const NOW = 1_700_000_000_000;
const NOW_S = NOW / 1000;

function keys(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

function payload(over: Partial<LicensePayload> = {}): LicensePayload {
  return { v: 1, sub: "buyer@example.com", plan: "pro", iat: NOW_S - DAY, exp: NOW_S + 30 * DAY, ...over };
}

function withStore<T>(publicKey: string, fn: (store: LicenseStore, dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "spacewise-licence-"));
  try {
    return fn({ file: join(dir, "license.key"), publicKey }, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("with nothing stored the plan is free, and no error is shown", () => {
  withStore(keys().publicKey, (store) => {
    const state = licenseStatus(store, NOW);
    assert.equal(state.status, "none");
    assert.equal(state.pro, false);
    assert.equal(state.problem, null, "not having bought something is not a problem");
    assert.equal(state.preservesUserData, true);
  });
});

test("a valid key is stored, and read back on the next run", () => {
  const { publicKey, privateKey } = keys();
  withStore(publicKey, (store, dir) => {
    const token = signLicense(payload(), privateKey);
    const activated = activateLicense(store, token, NOW);
    assert.equal(activated.status, "valid");
    assert.equal(activated.pro, true);
    assert.ok(existsSync(store.file), "it was written");
    assert.equal(readFileSync(store.file, "utf8").trim(), token, "and it was written unchanged");

    // A later run, reading from disk with no token in hand.
    const later = licenseStatus(store, NOW);
    assert.equal(later.status, "valid");
    assert.equal(later.payload?.sub, "buyer@example.com");
    assert.equal(hasFeature(later, "compare.scans"), true);
    void dir;
  });
});

test("an invalid key is refused and nothing is written", () => {
  const { publicKey } = keys();
  const impostor = keys();
  withStore(publicKey, (store) => {
    const state = activateLicense(store, signLicense(payload(), impostor.privateKey), NOW);
    assert.equal(state.status, "invalid");
    assert.equal(state.pro, false);
    assert.equal(existsSync(store.file), false, "a bad key must never be left on disk");
    assert.equal(licenseStatus(store, NOW).status, "none", "and the plan stays free");
  });
});

test("a mistyped key is refused without throwing", () => {
  withStore(keys().publicKey, (store) => {
    for (const junk of ["", "   ", "not-a-key", "a.b.c", "!!!!"]) {
      const state = activateLicense(store, junk, NOW);
      assert.ok(state.status === "invalid" || state.status === "none", `${junk} → ${state.status}`);
      assert.equal(state.pro, false);
    }
    assert.equal(existsSync(store.file), false);
  });
});

test("a build with no public key refuses a perfectly good licence", () => {
  // This is the shipped default, and it is why the placeholder must stay empty.
  const { privateKey } = keys();
  withStore("", (store) => {
    const state = activateLicense(store, signLicense(payload(), privateKey), NOW);
    assert.equal(state.status, "invalid");
    assert.equal(existsSync(store.file), false, "nothing is trusted and nothing is stored");
  });
});

test("a licence that has expired is kept, and unlocks nothing", () => {
  const { publicKey, privateKey } = keys();
  withStore(publicKey, (store) => {
    const token = signLicense(payload({ exp: NOW_S - 400 * DAY }), privateKey);
    const state = activateLicense(store, token, NOW);
    assert.equal(state.status, "expired");
    assert.ok(existsSync(store.file), "the record of the purchase outlives the term");
    assert.equal(state.payload?.sub, "buyer@example.com");

    const later = licenseStatus(store, NOW);
    assert.equal(later.pro, false);
    assert.equal(later.preservesUserData, true);
    assert.equal(hasFeature(later, "scan.run"), true, "the free tier is untouched");
    assert.equal(hasFeature(later, "compare.scans"), false);
  });
});

test("a licence inside the grace window still unlocks, with a notice", () => {
  const { publicKey, privateKey } = keys();
  withStore(publicKey, (store) => {
    const state = activateLicense(store, signLicense(payload({ exp: NOW_S - 3 * DAY }), privateKey), NOW);
    assert.equal(state.status, "grace");
    assert.equal(state.pro, true);
    assert.match(state.problem ?? "", /expired 3 day/);
  });
});

test("removing a licence clears the file and returns to free", () => {
  const { publicKey, privateKey } = keys();
  withStore(publicKey, (store) => {
    activateLicense(store, signLicense(payload(), privateKey), NOW);
    assert.ok(existsSync(store.file));
    const cleared = clearLicense(store);
    assert.equal(cleared.status, "none");
    assert.equal(cleared.pro, false);
    assert.equal(existsSync(store.file), false);
    assert.equal(licenseStatus(store, NOW).status, "none");
  });
});

test("clearing when there is nothing to clear is not an error", () => {
  withStore(keys().publicKey, (store) => {
    const cleared = clearLicense(store);
    assert.equal(cleared.status, "none");
  });
});

test("a damaged token file leaves the free tier working rather than crashing", () => {
  withStore(keys().publicKey, (store) => {
    writeFileSync(store.file, "");
    assert.equal(licenseStatus(store, NOW).status, "none", "an empty file is no licence");

    writeFileSync(store.file, "garbage that is not a token\n");
    const state = licenseStatus(store, NOW);
    assert.equal(state.status, "invalid");
    assert.equal(state.pro, false, "and it certainly does not unlock anything");
  });
});

test("re-activating replaces the stored key rather than appending to it", () => {
  const { publicKey, privateKey } = keys();
  withStore(publicKey, (store) => {
    activateLicense(store, signLicense(payload({ sub: "first@example.com" }), privateKey), NOW);
    activateLicense(store, signLicense(payload({ sub: "second@example.com" }), privateKey), NOW);
    const raw = readFileSync(store.file, "utf8").trim();
    assert.equal(raw.split("\n").length, 1, "one token, not two");
    assert.equal(licenseStatus(store, NOW).payload?.sub, "second@example.com");
  });
});
