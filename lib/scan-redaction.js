/**
 * Scan Redaction — Shadow Scan Preview + Tiered Feature Redaction.
 *
 * Enables $29 Quick customers to see module *names* and issue *counts* for
 * all static-analysis modules (the "shadow preview"), while keeping the
 * actual finding details behind the paid tier gate.
 *
 * How AI_COST_MODULES was determined:
 *   grep -rn "anthropic\|ANTHROPIC_API_KEY\|askClaude\|api.anthropic" \
 *        website/app/lib/scan-modules/ --include="*.ts"
 *   Result: only website/app/lib/scan-modules/ai.ts calls api.anthropic.com
 *   (the aiReview module). All other modules in FULL_MODULES are pure
 *   static-analysis (regex / AST / pattern scans) with zero API cost.
 *
 * Pure JS, CommonJS, Node stdlib only. Directly testable under
 * `node --test` without any transform. Style mirrors contextual-grounding.js.
 *
 * Four exports:
 *   1. AI_COST_MODULES    — Set of module names that incur Anthropic API cost
 *   2. computeShadowTier  — Maps paid tier → actual tier to run
 *   3. redactScanResult   — Redacts per-module details for unpaid modules
 *   4. summariseShadowResult — One-line human-readable summary string
 */

'use strict';

/**
 * Module names that call the Anthropic API and therefore incur real cost per
 * scan invocation.
 *
 * Inspection method:
 *   grep -rn "anthropic\|ANTHROPIC_API_KEY\|askClaude\|api.anthropic" \
 *        website/app/lib/scan-modules/ --include="*.ts"
 *
 * Any new module added to FULL_MODULES that calls Claude / Anthropic must be
 * added here so it is excluded from the $29 shadow run.
 *
 * @type {Set<string>}
 */
const AI_COST_MODULES = new Set([
  'aiReview',
  // If 'agentic' or similar are added to scan-modules/index.ts in future,
  // add them here.
]);

/**
 * Map a paid tier to the tier name that the scan should ACTUALLY run.
 *
 * For 'quick', we return 'quick_shadow' — a synthetic tier defined in
 * website/app/lib/scan-modules/types.ts that runs all static-analysis
 * modules from FULL_MODULES MINUS any in AI_COST_MODULES. This gives us
 * the "free" shadow scan data needed to show redacted previews.
 *
 * For all paid tiers ('full', 'scan_fix', 'nuclear'), we return the same
 * tier — they get everything they paid for with no shadow indirection.
 *
 * For unknown tier strings, we fall back to 'quick' defensively (the
 * default lowest-access tier), never to a higher tier.
 *
 * @param {string} paidTier
 * @returns {string}
 */
function computeShadowTier(paidTier) {
  switch (paidTier) {
    case 'quick':     return 'quick_shadow';
    case 'full':      return 'full';
    case 'scan_fix':  return 'scan_fix';
    case 'nuclear':   return 'nuclear';
    default:          return 'quick';
  }
}

/**
 * Redact scan result details for modules the customer did not pay for.
 *
 * For each module in result.modules:
 *   - If the module is in tierModules → keep verbatim (customer paid for it)
 *   - If NOT in tierModules → keep name/status/checks/issues but replace
 *     details with [] and add redacted:true + upgradeHint
 *
 * Also appends shadowSummary to the returned object.
 *
 * Does NOT mutate the input — returns a shallow clone with a new modules array.
 *
 * @param {Object}   opts
 * @param {Object}   opts.result       — scan response: { modules, totalIssues, ... }
 * @param {string}   opts.paidTier     — the tier the customer paid for ('quick', etc.)
 * @param {string[]} opts.tierModules  — module names included in the paid tier
 * @returns {Object} — shallow clone of result with redacted modules + shadowSummary
 */
function redactScanResult({ result, paidTier, tierModules }) {
  const paidSet = new Set(tierModules || []);

  let hiddenIssues = 0;
  let hiddenModules = 0;
  let paidIssues = 0;
  let paidModules = 0;

  const redactedModules = (result.modules || []).map((mod) => {
    if (paidSet.has(mod.name)) {
      // Customer paid for this module — return verbatim.
      paidModules++;
      paidIssues += mod.issues || 0;
      return mod;
    }

    // Customer did NOT pay for this module — redact details.
    hiddenModules++;
    hiddenIssues += mod.issues || 0;

    // Shallow-clone the module entry, replacing details.
    return Object.assign({}, mod, {
      details: [],
      redacted: true,
      upgradeHint: 'Upgrade to Full Scan to see and fix this module\'s findings.',
    });
  });

  const upgradeHint = hiddenIssues > 0
    ? `${hiddenIssues} of ${(paidIssues + hiddenIssues)} issues hidden — upgrade to Full Scan ($99) to see and fix all findings.`
    : 'Upgrade to Full Scan to unlock all module findings.';

  const shadowSummary = {
    hiddenIssues,
    hiddenModules,
    paidModules,
    paidIssues,
    paidTier,
    upgradeHint,
  };

  // Shallow-clone the top-level result.
  return Object.assign({}, result, {
    modules: redactedModules,
    shadowSummary,
  });
}

/**
 * One-line human-readable summary for logs and admin UI.
 *
 * Example:
 *   "shadow: 31 issues hidden across 18 modules (paid quick=12 issues across 4 modules)"
 *
 * @param {{ hiddenIssues:number, hiddenModules:number, paidModules:number, paidIssues:number, paidTier:string }} redactionSummary
 * @returns {string}
 */
function summariseShadowResult(redactionSummary) {
  const {
    hiddenIssues = 0,
    hiddenModules = 0,
    paidModules = 0,
    paidIssues = 0,
    paidTier = 'unknown',
  } = redactionSummary || {};

  return (
    `shadow: ${hiddenIssues} issues hidden across ${hiddenModules} modules` +
    ` (paid ${paidTier}=${paidIssues} issues across ${paidModules} modules)`
  );
}

module.exports = {
  AI_COST_MODULES,
  computeShadowTier,
  redactScanResult,
  summariseShadowResult,
};
