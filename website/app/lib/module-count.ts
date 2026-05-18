// Single source of truth for the public module count.
//
// Why this exists: every customer-facing surface (Hero, Pricing,
// compare/* pages, OG metadata, Stripe receipts, GitHub Marketplace
// listing) historically hardcoded its own count. Counts drifted —
// landing said 67, OG said 90, comparison-row said 22, while the
// CLI shipped 102. Customers caught the contradiction.
//
// Now: everyone imports TOTAL_MODULES (or the helper text builders)
// from here. There is exactly one number to update when modules
// land or retire.
//
// Verification — keep these in sync (manual but cheap, asserted by
// integration tests / build-time guard once the lazy lookup lands):
//   1. `node bin/gatetest.js --list | grep -cE '^  [a-zA-Z]'`
//   2. `totalModuleCount()` from website/app/components/howitworks/modules-data.ts
//   3. TOTAL_MODULES constant below.
//
// Last verified: 2026-05-18 (102 modules).

import { totalModuleCount } from "@/app/components/howitworks/modules-data";

/**
 * The number GateTest publishes. Computed at module-load time from the
 * `modules-data.ts` catalogue (the same data that drives /how-it-works).
 * If the catalogue and the CLI ever drift, the catalogue is the public
 * source of truth — fix the catalogue, the website auto-updates.
 */
export const TOTAL_MODULES: number = totalModuleCount();

/** Plain helper: "102 modules". */
export function modulesLabel(): string {
  return `${TOTAL_MODULES} modules`;
}

/** Plain helper: "All 102 modules". */
export function allModulesLabel(): string {
  return `All ${TOTAL_MODULES} modules`;
}
