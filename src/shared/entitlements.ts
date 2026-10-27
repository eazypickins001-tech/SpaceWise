// What a plan unlocks.
//
// This module is deliberately free of any Node dependency, because both the main
// process (which verifies the signature) and the interface (which has to know
// what is unlocked) read it. The signing and verification themselves live in
// src/main/license.ts, which needs node:crypto and is therefore main-only.

export type PlanId = "free" | "pro";

export interface LicensePayload {
  // Format version. Bump when the shape changes; unknown versions are refused.
  v: 1;
  // Who the licence was issued to. Shown in the interface.
  sub: string;
  plan: Exclude<PlanId, "free">;
  // Seconds since the Unix epoch.
  iat: number;
  exp: number;
  // Optional binding to one machine. Absent means the licence is portable.
  machine?: string;
  seats?: number;
}

export type LicenseStatus = "none" | "valid" | "grace" | "expired" | "invalid";

export interface LicenseState {
  status: LicenseStatus;
  plan: PlanId;
  pro: boolean;
  // Always true. Kept explicit so no future code path can quietly break it:
  // a licence may unlock features and may never lock away someone's own files,
  // their settings or their scan history.
  preservesUserData: true;
  payload: LicensePayload | null;
  // Why a licence was refused, in words a person can act on.
  problem: string | null;
  daysLeft: number | null;
}

// Days a licence keeps working past its expiry date, so a machine that has been
// offline for a fortnight does not lose the features it paid for.
export const DEFAULT_GRACE_DAYS = 14;

// The free tier is the product. Scanning, the treemap, the folder tree, the
// type breakdown, reviewed cleanup with the full safety model, local history and
// duplicate detection are all free and are not time-limited. Putting the safety
// model behind a paywall would make the free version dangerous.
export const FREE_FEATURES = new Set([
  "scan.run",
  "scan.view",
  "cleanup.manual",
  "history.local",
  "duplicates.basic",
]);

// Only what the application actually gates. Three ids -- monitor.growth,
// report.export, filters.advanced -- were once declared here and shown to the
// user as Premium without being attached to any code. They were removed rather
// than advertised, and return when the code that enforces them does.
export const PRO_FEATURES = new Set(["compare.scans", "duplicates.unlimited", "ai.summary"]);

export function featuresFor(state: LicenseState): Set<string> {
  return state.pro ? new Set([...FREE_FEATURES, ...PRO_FEATURES]) : new Set(FREE_FEATURES);
}

export function hasFeature(state: LicenseState, feature: string): boolean {
  return featuresFor(state).has(feature);
}

export const NO_LICENSE: LicenseState = {
  status: "none",
  plan: "free",
  pro: false,
  preservesUserData: true,
  payload: null,
  problem: null,
  daysLeft: null,
};
