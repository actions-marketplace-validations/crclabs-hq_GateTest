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
export const TIERS: Record<string, string[]> = {
  quick: ["syntax", "lint", "secrets", "codeQuality"],
  full: [
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
    "errorSwallow",
  ],
  nuclear: [
    "syntax", "lint", "secrets", "codeQuality", "security",
    "accessibility", "seo", "links", "compatibility", "dataIntegrity",
    "documentation", "performance", "aiReview", "fakeFixDetector",
    "dependencyFreshness", "maliciousDeps", "licenses", "iacSecurity",
    "ciHardening", "migrations", "authFlaws", "flakyTests", "mutationAnalysis",
    "errorSwallow",
  ],
  scan_fix: [
    "syntax", "lint", "secrets", "codeQuality", "security",
    "accessibility", "seo", "links", "compatibility", "dataIntegrity",
    "documentation", "performance", "aiReview", "fakeFixDetector",
    "dependencyFreshness", "maliciousDeps", "licenses", "iacSecurity",
    "ciHardening", "migrations", "authFlaws", "flakyTests", "mutationAnalysis",
    "errorSwallow",
  ],
};
