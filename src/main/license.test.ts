// Licence verification tests. A real Ed25519 key pair is generated per run, so
// these exercise genuine signature checks rather than a stubbed one. No key in
// this file is a vendor key and none is committed as one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, generateKeyPairSync } from "crypto";
import { EMBEDDED_PUBLIC_KEY, machineId, parseLicense, signLicense, verifyLicense } from "./license";
import { PRO_FEATURES, featuresFor, hasFeature } from "../shared/entitlements";
import type { LicensePayload } from "../shared/entitlements";

function keyPair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

const DAY = 86400;
const NOW = 1_700_000_000;

function payload(over: Partial<LicensePayload> = {}): LicensePayload {
  return { v: 1, sub: "buyer@example.com", plan: "pro", iat: NOW - DAY, exp: NOW + 30 * DAY, ...over };
}

test("no licence means the free plan, and still leaves the user their data", () => {
  const state = verifyLicense(null, "", { now: NOW, machine: null });
  assert.equal(state.status, "none");
  assert.equal(state.plan, "free");
  assert.equal(state.pro, false);
  assert.equal(state.preservesUserData, true);
  assert.equal(state.problem, null);
});

test("a correctly signed licence is accepted", () => {
  const { publicKey, privateKey } = keyPair();
  const token = signLicense(payload(), privateKey);
  const state = verifyLicense(token, publicKey, { now: NOW, machine: null });
  assert.equal(state.status, "valid");
  assert.equal(state.pro, true);
  assert.equal(state.plan, "pro");
  assert.equal(state.daysLeft, 30, "a 30 day term still has 30 days on the day it starts");
  assert.equal(state.payload?.sub, "buyer@example.com");
});

test("a licence signed with a different key is refused", () => {
  const vendor = keyPair();
  const impostor = keyPair();
  const token = signLicense(payload(), impostor.privateKey);
  const state = verifyLicense(token, vendor.publicKey, { now: NOW, machine: null });
  assert.equal(state.status, "invalid");
  assert.equal(state.pro, false);
  assert.match(state.problem ?? "", /not valid/);
});

test("editing the payload invalidates the signature", () => {
  const { publicKey, privateKey } = keyPair();
  const token = signLicense(payload(), privateKey);
  const [body, sig] = token.split(".");
  const edited = Buffer.from(JSON.stringify(payload({ exp: NOW + 3650 * DAY })), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const state = verifyLicense(`${edited}.${sig}`, publicKey, { now: NOW, machine: null });
  assert.equal(state.status, "invalid", "extending the expiry by hand must not work");
  assert.equal(state.pro, false);
});

test("a corrupted signature is refused", () => {
  const { publicKey, privateKey } = keyPair();
  const [body, sig] = signLicense(payload(), privateKey).split(".");
  const flipped = sig.slice(0, -2) + (sig.endsWith("AA") ? "BB" : "AA");
  assert.equal(verifyLicense(`${body}.${flipped}`, publicKey, { now: NOW, machine: null }).status, "invalid");
});

test("an expired licence drops to free but never takes the user's data", () => {
  const { publicKey, privateKey } = keyPair();
  const token = signLicense(payload({ exp: NOW - 100 * DAY }), privateKey);
  const state = verifyLicense(token, publicKey, { now: NOW, machine: null });
  assert.equal(state.status, "expired");
  assert.equal(state.pro, false);
  assert.equal(state.plan, "free");
  assert.equal(state.preservesUserData, true);
  assert.match(state.problem ?? "", /expired/);
  assert.equal(state.payload?.sub, "buyer@example.com", "the record of who bought it survives");
});

test("a recently expired licence keeps working for the grace window", () => {
  const { publicKey, privateKey } = keyPair();
  const token = signLicense(payload({ exp: NOW - 3 * DAY }), privateKey);
  const state = verifyLicense(token, publicKey, { now: NOW, machine: null, graceDays: 14 });
  assert.equal(state.status, "grace");
  assert.equal(state.pro, true, "an offline laptop does not lose paid features immediately");
  assert.match(state.problem ?? "", /expired 3 day/);
  assert.equal(state.daysLeft, 11);
});

test("the grace window is finite and can be switched off", () => {
  const { publicKey, privateKey } = keyPair();
  const token = signLicense(payload({ exp: NOW - 3 * DAY }), privateKey);
  assert.equal(verifyLicense(token, publicKey, { now: NOW, machine: null, graceDays: 0 }).status, "expired");
  assert.equal(verifyLicense(token, publicKey, { now: NOW, machine: null, graceDays: 14 }).status, "grace");
  const longAgo = signLicense(payload({ exp: NOW - 90 * DAY }), privateKey);
  assert.equal(verifyLicense(longAgo, publicKey, { now: NOW, machine: null, graceDays: 14 }).status, "expired");
});

test("a machine-bound licence only works on that machine", () => {
  const { publicKey, privateKey } = keyPair();
  const machine = machineId(["workstation-a", "win32", "x64"]);
  const token = signLicense(payload({ machine }), privateKey);

  assert.equal(verifyLicense(token, publicKey, { now: NOW, machine }).status, "valid");
  const elsewhere = verifyLicense(token, publicKey, { now: NOW, machine: machineId(["workstation-b", "win32", "x64"]) });
  assert.equal(elsewhere.status, "invalid");
  assert.match(elsewhere.problem ?? "", /different computer/);
});

test("a machine-bound licence is refused when the machine cannot be identified", () => {
  const { publicKey, privateKey } = keyPair();
  const token = signLicense(payload({ machine: machineId(["a"]) }), privateKey);
  const state = verifyLicense(token, publicKey, { now: NOW, machine: null });
  assert.equal(state.status, "invalid");
  assert.match(state.problem ?? "", /could not be identified/);
});

test("an unbound licence works anywhere", () => {
  const { publicKey, privateKey } = keyPair();
  const token = signLicense(payload(), privateKey);
  assert.equal(verifyLicense(token, publicKey, { now: NOW, machine: machineId(["anywhere"]) }).status, "valid");
});

test("a build with no signing key refuses every licence rather than trusting one", () => {
  const { privateKey } = keyPair();
  const token = signLicense(payload(), privateKey);
  const state = verifyLicense(token, "", { now: NOW, machine: null });
  assert.equal(state.status, "invalid");
  assert.equal(state.pro, false);
  assert.match(state.problem ?? "", /no licence signing key/i, "and says why, rather than looking like a bad key");
});

// The shipped build carries a real vendor public key, so what needs guarding is
// no longer that the constant is empty but that it is a usable key. A truncated
// or mistyped key refuses every licence, which from the inside looks exactly like
// a customer who has not paid, and is easy to ship without noticing.
test("the signing key compiled into this build is a usable public key", () => {
  if (EMBEDDED_PUBLIC_KEY.trim() === "") return; // the safe default: refuses everything
  const key = createPublicKey(EMBEDDED_PUBLIC_KEY);
  assert.equal(key.asymmetricKeyType, "ed25519");
});

test("a token that is not a token is refused without throwing", () => {
  const { publicKey } = keyPair();
  for (const bad of ["", "   ", "not-a-licence", "only-one-part", "a.b.c", "!!!.???", "eyJ2IjoxfQ"]) {
    const state = verifyLicense(bad, publicKey, { now: NOW, machine: null });
    assert.ok(state.status === "invalid" || state.status === "none", `${bad} → ${state.status}`);
    assert.equal(state.pro, false);
  }
});

test("a structurally valid but unsupported token is refused", () => {
  const body = Buffer.from(JSON.stringify({ v: 2, sub: "x", plan: "pro", iat: 1, exp: 2 }), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  assert.equal(parseLicense(`${body}.AAAA`), null, "an unknown format version is not parsed");
});

test("a payload missing required fields is refused", () => {
  const body = Buffer.from(JSON.stringify({ v: 1, plan: "pro", iat: 1, exp: 2 }), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  assert.equal(parseLicense(`${body}.AAAA`), null, "no licensee is no licence");
});

test("parsing keeps the signed bytes, so the signature covers exactly what was shown", () => {
  const { privateKey } = keyPair();
  const token = signLicense(payload(), privateKey);
  const parsed = parseLicense(token);
  assert.ok(parsed);
  assert.deepEqual(JSON.parse(parsed.body.toString("utf8")), payload());
});

test("the free tier is genuinely useful on its own", () => {
  const free = featuresFor(verifyLicense(null, "", { now: NOW, machine: null }));
  assert.ok(free.has("scan.run"), "scanning is never behind a paywall");
  assert.ok(free.has("scan.view"));
  assert.ok(free.has("cleanup.manual"));
  assert.ok(free.has("history.local"));
  for (const feature of PRO_FEATURES) assert.equal(free.has(feature), false, `${feature} is premium`);
});

test("a licence adds the premium features without removing the free ones", () => {
  const { publicKey, privateKey } = keyPair();
  const state = verifyLicense(signLicense(payload(), privateKey), publicKey, { now: NOW, machine: null });
  const paid = featuresFor(state);
  assert.ok(paid.has("scan.run"), "the free features are still there");
  assert.ok(paid.has("compare.scans"));
  assert.equal(hasFeature(state, "monitor.growth"), true);
  assert.equal(hasFeature(state, "monitor.growth") && state.pro, true);
});

test("an expired licence still reports the free feature set", () => {
  const { publicKey, privateKey } = keyPair();
  const state = verifyLicense(signLicense(payload({ exp: NOW - 900 * DAY }), privateKey), publicKey, {
    now: NOW,
    machine: null,
  });
  assert.equal(hasFeature(state, "scan.run"), true);
  assert.equal(hasFeature(state, "report.export"), false);
});

test("machineId is stable for the same parts and differs for different ones", () => {
  assert.equal(machineId(["host", "win32"]), machineId(["host", "win32"]));
  assert.notEqual(machineId(["host", "win32"]), machineId(["host", "linux"]));
  assert.match(machineId(["host"]), /^[0-9a-f]{16}$/);
});
