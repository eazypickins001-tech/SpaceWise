# Licensing

## The free tier is the product

Scanning, the treemap, the folder tree, the file-type breakdown, search and filters, manual
cleanup with the full safety model, local scan history, and basic duplicate detection are
free and are not time-limited. None of them degrade after 30 days, and none of them are
crippled. If the premium tier never sold a single copy, the application would still be
genuinely worth using.

This is a deliberate choice, not a marketing line: the safety model is the most important
part of the product, and putting it behind a paywall would make the free version dangerous.

| Feature key | Tier |
| --- | --- |
| `scan.run`, `scan.view` | Free |
| `cleanup.manual` | Free |
| `history.local` | Free |
| `duplicates.basic` | Free |
| `compare.scans` | Premium |
| `duplicates.unlimited` | Premium |
| `ai.summary` | Premium |

The keys live in `src/main/license.ts` as `FREE_FEATURES` and `PRO_FEATURES`, so the boundary
is one place rather than scattered through the interface.

## What a licence is

A licence is a small JSON document encoded as `base64url(payload).base64url(signature)`,
signed with **Ed25519**. Only the public key is compiled into the application. The private
key is held by the vendor, is not in this repository, and must never be.

```json
{
  "v": 1,
  "sub": "buyer@example.com",
  "plan": "pro",
  "iat": 1760000000,
  "exp": 1791536000,
  "machine": "a1b2c3d4e5f60718",
  "seats": 1
}
```

| Field | Meaning |
| --- | --- |
| `v` | Format version. An unknown version is refused rather than guessed at. |
| `sub` | Who it was issued to. Displayed in the interface. |
| `plan` | Only `pro` is defined today. |
| `iat`, `exp` | Unix seconds. |
| `machine` | Optional binding. Omitted means the licence is portable. |
| `seats` | Reserved. Not enforced today. |

## How verification behaves

Verification is **fully offline**. There is no activation server to be down, no phone-home,
and no way for a network outage to take features away from someone who paid.

| Situation | Result |
| --- | --- |
| No licence | Free tier. No error shown. |
| Valid signature, before expiry | Premium. |
| Valid signature, expired within the grace window | Premium, with a visible notice. Default grace: **14 days**. |
| Valid signature, past expiry and grace | Free tier. Files, settings and history are untouched. |
| Signature does not verify | Refused as invalid. Never treated as valid. |
| Bound to a different machine | Refused, with a message saying so. |
| No public key compiled in | **Every** licence is refused. A build cannot accidentally ship a key that verifies anything. |

The grace window exists so that a laptop which has been offline for a fortnight does not lose
paid features for a reason the user cannot act on. It is configurable and can be set to zero.

## What expiry can never do

`preservesUserData` is hard-coded `true` on every licence state, including the refused ones,
and a test asserts it. Expiry removes premium features. It does not:

- hide, lock or delete any of the user's files;
- disable scanning, viewing, analysis or manual cleanup;
- delete settings or scan history;
- leave the application unusable or nagging.

## Vendor workflow

The tooling is in `scripts/make-license-key.ts`.

1. **Generate the key pair once**, on a machine that is not the build machine:

   ```bat
   npm run keygen -- keygen --out ..\offline\spacewise-private-key.pem
   ```

   It refuses to overwrite an existing key. It prints the public key and tells you to move the
   private key off the machine. It also prints the exact line to paste.

2. **Put the public key into the build.** `EMBEDDED_PUBLIC_KEY` in `src/main/license.ts` is a
   template string, so a multi-line PEM goes in as-is. Rebuild and ship. While it is empty,
   *every licence is refused* — that is deliberate, so a placeholder key can never verify
   anything. This step has been done; the only thing it was ever waiting on was the owner's
   private key.

   **Check a build before releasing it.** No private key is needed to run this, only to have
   one on hand:

   ```bat
   npm run verify:licence -- --key ..\offline\spacewise-private-key.pem
   ```

   It signs throwaway licences and verifies them against the key compiled into the build in
   this working tree, so a mistyped, truncated or missing key is caught here rather than by a
   customer whose paid licence is silently refused. A build in that state looks completely
   healthy from the inside.

3. **Issue a licence:**

   ```bat
   npm run keygen -- sign --key ..\offline\spacewise-private-key.pem --sub buyer@example.com --days 365
   ```

   Add `--machine <id>` to bind it to one computer. `npm run keygen -- machine` prints the id
   for the machine it runs on, so the customer runs that and sends you the result. Everything
   the tool prints is safe to send to a customer.

4. **The customer pastes the key** into Help → Licence. Verification is offline and immediate.

The signer calls the same `signLicense` the application verifies against, so the two cannot
drift apart.

**Rotating the key invalidates every licence already issued.** Treat it as a break-glass action.
Before the first sale, consider shipping a set of accepted public keys rather than one.

## What is gated, and how

Two features are gated today: **comparing scans** (the Changes view), the "advanced scan
comparison" the brief lists as premium, and the **optional storage summary** (`ai.summary`),
which is off by default and off unless a licence is present. Gating them makes the boundary
real rather than decorative.

It is gated in one place — `App.tsx` chooses between the pane and a `PremiumGate` — and the gate
is a panel that names the view and offers a way to enter a key, not a hidden tab. Nothing
disappears silently, because a vanishing view reads as a bug.

Everything else in the free tier stays free: scanning, the treemap, the folder tree, the type
breakdown, reviewed cleanup with the full safety model, local history and duplicate detection.

## Unresolved

- **The key exists, and the private half is the whole business.** The pair has been generated,
  the public half is compiled in, and a licence unlocks the premium features today. Whoever
  holds that private key can mint licences, so the file must stay off the build machine and
  out of this repository; if it leaks, the only remedy is rotating the key, which invalidates
  every licence already sold.
- **No payments provider is integrated.** Nothing sells a licence yet.
- **No activation, deactivation or revocation.** With no server, a licence cannot be revoked
  once issued. Seat limits are therefore not enforced; `seats` is reserved in the payload.
- **No trial period.** The free tier is intended to make a time-limited trial unnecessary.
- **All three premium features are wired.** `compare.scans` gates the Changes view and
  `duplicates.unlimited` lifts the free tier's cap on how many duplicate sets are listed (both
  through `hasFeature`, so the entitlements table is the single source of truth); `ai.summary`
  gates the optional storage summary. Three further ids -- `monitor.growth`, `report.export`,
  `filters.advanced` -- were once declared and shown as Premium without being attached to
  anything; they were removed rather than advertised, and unlock nothing today.
- If an optional AI feature is ever added, its provider cost must be shown to the user and its
  key must live behind a backend, never in the client.
