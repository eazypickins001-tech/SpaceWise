// Vendor-side release check: does this build accept the licences I sign?
//
//   npm run verify:licence -- --key ..\offline\private-key.pem
//
// It uses the application's own verification function and the public key that is
// actually compiled into this build, so it answers the one question a hand test
// answers slowly and a broken build answers silently: is the embedded key the
// pair of the key I sell licences with?
//
// The private key is read from the path given and is never copied anywhere. This
// script is the reason a release with an empty or wrong EMBEDDED_PUBLIC_KEY
// cannot pass unnoticed -- that state looks completely healthy from the inside.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { EMBEDDED_PUBLIC_KEY, machineId, signLicense, verifyLicense } from "../src/main/license";
import type { LicensePayload } from "../src/shared/entitlements";

const argv = process.argv.slice(2);
const at = argv.indexOf("--key");
const keyPath = at >= 0 ? argv[at + 1] : undefined;
if (!keyPath) {
  console.error("usage: npm run verify:licence -- --key <private-key.pem>");
  process.exit(2);
}

const priv = readFileSync(resolve(keyPath), "utf8");
const now = Math.floor(Date.now() / 1000);
const machine = machineId([]);
const payload: LicensePayload = { v: 1, sub: "release-check@spacewise.invalid", plan: "pro", iat: now, exp: now + 86400 * 365 };

let failures = 0;
function check(what: string, ok: boolean, detail?: string): void {
  console.log("  " + (ok ? "ok  " : "FAIL") + "  " + what + (detail ? "  -- " + detail : ""));
  if (!ok) failures++;
}

console.log("");
console.log("This build's embedded public key, against the vendor private key");
console.log("");

check("a public key is embedded at all", EMBEDDED_PUBLIC_KEY.trim() !== "", EMBEDDED_PUBLIC_KEY.trim() === "" ? "empty: every licence will be refused" : "");

const token = signLicense(payload, priv);
const good = verifyLicense(token, EMBEDDED_PUBLIC_KEY, { machine, now });
check("a signed licence is accepted by this build", good.plan === "pro", "plan=" + good.plan);

check("a tampered licence is refused", (() => {
  const parts = token.split(".");
  const body = JSON.parse(Buffer.from(parts[0], "base64url").toString());
  body.plan = "pro";
  body.sub = "someone-else@example.com";
  const forged = Buffer.from(JSON.stringify(body)).toString("base64url") + "." + parts[1];
  return verifyLicense(forged, EMBEDDED_PUBLIC_KEY, { machine, now }).plan === "free";
})());

// Just past expiry is deliberately still accepted, with a warning, so a paying
// customer is not locked out the second their licence lapses.
const grace = verifyLicense(signLicense({ ...payload, exp: now - 10 }, priv), EMBEDDED_PUBLIC_KEY, { machine, now });
check("just-expired still works, on grace", grace.status === "grace" && grace.plan === "pro", "status=" + grace.status);

const longGone = verifyLicense(signLicense({ ...payload, exp: now - 400 * 86400 }, priv), EMBEDDED_PUBLIC_KEY, { machine, now });
check("a long-expired licence is refused", longGone.plan === "free");

const elsewhere = verifyLicense(signLicense({ ...payload, machine: "deadbeefdeadbeef" }, priv), EMBEDDED_PUBLIC_KEY, { machine, now });
check("a licence bound to another computer is refused", elsewhere.plan === "free");

// What the build looked like before a key was embedded. Still refused, which is
// the safe default rather than a special case.
check("an empty public key refuses everything", verifyLicense(token, "", { machine, now }).plan === "free");

console.log("");
if (failures === 0) {
  console.log("This build can be licensed with that key. Safe to ship.");
} else {
  const empty = EMBEDDED_PUBLIC_KEY.trim() === "";
  console.log(failures + " check(s) failed.");
  if (empty) {
    console.log("EMBEDDED_PUBLIC_KEY is empty, so every licence is refused. Run:");
    console.log("  npm run keygen -- public --key <private-key.pem>");
    console.log("and paste the output into src/main/license.ts, then rebuild.");
  } else {
    console.log("The embedded public key is not the pair of this private key. Every");
    console.log("licence signed with this key will be refused by this build.");
  }
}
console.log("");
process.exit(failures === 0 ? 0 : 1);
