/**
 * Shared types for the real-scan module system.
 *
 * Each module is a function (owner, repo, files, fileContents) → ModuleOutput.
 * No fallthrough defaults. Every module does real work or it does not exist.
 */

export interface RepoFile {
  path: string;
  content: string;
}

export interface ModuleOutput {
  checks: number;
  issues: number;
  details: string[];
  /** Optional skip reason when the module was asked to run but had nothing to inspect. */
  skipped?: string;
}

export interface ModuleContext {
  owner: string;
  repo: string;
  files: string[];
  fileContents: RepoFile[];
  /** Optional caller-provided token — used by modules that call external APIs. */
  token?: string;
  /** Unix ms deadline. Modules that start after this point return skipped instead of running. */
  deadlineMs?: number;
}

export type ModuleRunner = (ctx: ModuleContext) => Promise<ModuleOutput>;

/** Tier → module names. Every name listed here MUST resolve to a real runner. */

/** Full module list — shared by "full", "scan_fix", and "nuclear". The scan
 * portion is identical across all three paid tiers; the differentiation comes
 * from the fix-path deliverables (pair-review, architecture annotator, Claude
 * diagnoser, correlator, executive summary) which are gated in the fix route.
 */
const FULL_MODULES: string[] = [
  "syntax",
  "lint",
  "secrets",
  "codeQuality",
  "security",
  "accessibility",
  "seo",
  "links",
  "compatibility",
  "dataIntegrity",
  "documentation",
  "performance",
  "aiReview",
  "fakeFixDetector",
  "dependencyFreshness",
  "maliciousDeps",
  "licenses",
  "iacSecurity",
  "ciHardening",
  "migrations",
  "authFlaws",
  "flakyTests",
  "mutationAnalysis",
];

/** Modules that incur Anthropic API cost when they run. Must stay in sync
 *  with AI_COST_MODULES in lib/scan-redaction.js — the shadow-preview tier
 *  filters these out so $29 customers don't trigger Claude calls for
 *  modules they didn't pay for. */
const AI_COST_MODULE_NAMES = new Set(["aiReview", "fakeFixDetector"]);

/** Quick-shadow tier — runs the FULL static-scan suite but skips the
 *  AI-cost modules. Used by scan-redaction to show $29 customers a COUNT
 *  of issues from modules they didn't pay for (with module names but
 *  redacted details) as an upsell mechanic, without burning Anthropic
 *  budget on a $29 transaction. */
const QUICK_SHADOW_MODULES: string[] = FULL_MODULES.filter(
  (name) => !AI_COST_MODULE_NAMES.has(name)
);

export const TIERS: Record<string, string[]> = {
  quick: ["syntax", "lint", "secrets", "codeQuality"],
  full: FULL_MODULES,
  /** $199 Scan + Fix — same scan depth as full; richer fix deliverables. */
  scan_fix: FULL_MODULES,
  /** $399 Nuclear — same scan depth as full; adds diagnosis, correlation,
   *  mutation, chaos, and executive summary in the fix/report path. */
  nuclear: FULL_MODULES,
  /** Synthetic tier used by the shadow-preview mechanic — runs full static
   *  scan minus AI-cost modules. Not customer-facing; selected by
   *  computeShadowTier() in lib/scan-redaction.js when paidTier === "quick". */
  quick_shadow: QUICK_SHADOW_MODULES,
};
