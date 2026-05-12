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
];

export const TIERS: Record<string, string[]> = {
  quick: ["syntax", "lint", "secrets", "codeQuality"],
  full: FULL_MODULES,
  /** $199 Scan + Fix — same scan depth as full; richer fix deliverables. */
  scan_fix: FULL_MODULES,
  /** $399 Nuclear — same scan depth as full; adds diagnosis, correlation,
   *  mutation, chaos, and executive summary in the fix/report path. */
  nuclear: FULL_MODULES,
};
