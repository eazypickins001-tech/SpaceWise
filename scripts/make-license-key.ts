// Vendor-side licence tooling.
//
//   npm run keygen -- keygen [--out offline/private-key.pem]
//   npm run keygen -- public --key offline/private-key.pem
//   npm run keygen -- machine
//   npm run keygen -- sign --key offline/private-key.pem --sub buyer@example.com --days 365
//   npm run keygen -- sign --key ... --sub ... --days 365 --machine <id>
//
// The private key is the whole business. It is generated here, kept by you, and
// must never be committed, copied into the application, or put in CI. If it
// leaks, anyone can mint licences and the only fix is to rotate the key, which
// invalidates every licence already sold.
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, hostname, platform } from "node:os";
import { dirname, resolve } from "node:path";
import { signLicense } from "../src/main/license";
import type { LicensePayload } from "../src/shared/entitlements";

const argv = process.argv.slice(2);
const command = argv[0];

function flag(name: string): string | undefined {
  const i = argv.indexOf("--" + name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function required(name: string): string {
  const v = flag(name);
  if (!v) {
    console.error(`Missing --${name}`);
    process.exit(2);
  }
  return v;
}

// The same fingerprint the application computes, so a bound licence matches.
function machineIdOf(parts: string[]): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (const s of parts) {
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
      h2 = Math.imul(h2 + c, 2246822519) >>> 0;
    }
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

// Signing uses the same function the application verifies against, so the two
// cannot drift apart. It is covered by the licence tests.

switch (command) {
  case "keygen": {
    const out = resolve(flag("out") ?? "spacewise-private-key.pem");
    if (existsSync(out)) {
      console.error(`Refusing to overwrite ${out}. Move it aside first.`);
      process.exit(1);
    }
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const priv = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const pub = publicKey.export({ type: "spki", format: "pem" }).toString();
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, priv, { mode: 0o600 });

    console.log("");
    console.log("Private key written to:");
    console.log("  " + out);
    console.log("");
    console.log("MOVE IT OFF THIS MACHINE, and never commit it. Everything below this");
    console.log("line is safe to share and safe to commit.");
    console.log("");
    console.log("Paste this into EMBEDDED_PUBLIC_KEY in src/main/license.ts:");
    console.log("");
    console.log(pub.trim());
    console.log("");
    console.log("The key is a multi-line PEM. In the source it goes in as a template string:");
    console.log("");
    console.log('  export const EMBEDDED_PUBLIC_KEY = `' + pub.trim() + '`;');
    console.log("");
    break;
  }

  case "public": {
    const priv = readFileSync(resolve(required("key")), "utf8");
    console.log(createPublicKey(priv).export({ type: "spki", format: "pem" }).toString().trim());
    break;
  }

  case "machine": {
    console.log(machineIdOf([hostname(), platform(), arch()]));
    break;
  }

  case "sign": {
    const keyPath = resolve(required("key"));
    const sub = required("sub");
    const days = Number(required("days"));
    if (!Number.isFinite(days) || days <= 0) {
      console.error("--days must be a positive number");
      process.exit(2);
    }
    const priv = existsSync(keyPath) ? readFileSync(keyPath, "utf8") : "";
    if (priv.trim() === "") {
      console.error(`No private key at ${keyPath}`);
      process.exit(1);
    }
    const now = Math.floor(Date.now() / 1000);
    const machine = flag("machine");
    const payload: LicensePayload = {
      v: 1,
      sub,
      plan: "pro",
      iat: now,
      exp: now + Math.round(days * 86400),
      ...(machine ? { machine } : {}),
      ...(flag("seats") ? { seats: Number(flag("seats")) } : {}),
    };
    console.log("");
    console.log(signLicense(payload, priv));
    console.log("");
    console.log(`Issued to ${sub}, expires ${new Date(payload.exp * 1000).toISOString()}` +
      (machine ? `, bound to machine ${machine}` : ", not bound to a machine"));
    console.log("");
    break;
  }

  default:
    console.error("usage:");
    console.error("  npm run keygen -- keygen [--out <path>]");
    console.error("  npm run keygen -- public --key <private.pem>");
    console.error("  npm run keygen -- machine");
    console.error("  npm run keygen -- sign --key <private.pem> --sub <who> --days <n> [--machine <id>] [--seats <n>]");
    process.exit(2);
}
