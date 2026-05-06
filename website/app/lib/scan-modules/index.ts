/**
 * Real Scan Modules — unified, honest module registry.
 *
 * Every module listed here does REAL work. No default fallthrough. No
 * fake "1 check passed" stubs. If a module can't run in this environment
 * (e.g. needs a browser, cannot run in Vercel serverless), it is NOT
 * listed here, because shipping a fake-pass for something we didn't run
 * is deceitful.
 *
 * Both /api/scan/run and app/lib/scan-executor import from this file.
 * One source of truth.
 */

import type { ModuleRunner, ModuleContext } from "./types";
import { TIERS } from "./types";
import {
  syntax,
  lint,
  codeQuality,
  documentation,
} from "./static-quality";
import {
  secrets,
  security,
  dataIntegrity,
  fakeFixDetector,
} from "./security-data";
import {
  accessibility,
  seo,
  links,
  performance,
  compatibility,
} from "./web";
import { aiReview } from "./ai";
import { dependencyFreshness } from "./dependencies";
import { maliciousDeps, licenses } from "./supply-chain";
import { iacSecurity, ciHardening } from "./iac";
import { migrations } from "./migrations";
import { authFlaws } from "./auth-flaws";
import { flakyTests } from "./flaky-tests";
import { mutationAnalysis } from "./mutation-analysis";
import { errorSwallow } from "./infra";

export type { ModuleRunner, ModuleContext, RepoFile, ModuleOutput } from "./types";
export { TIERS } from "./types";

/**
 * The module registry. Every entry is a real runner. Adding a name here
 * without a real implementation is forbidden — the types require a runner.
 */
export const MODULES: Record<string, ModuleRunner> = {
  syntax,
  lint,
  codeQuality,
  documentation,
  secrets,
  security,
  dataIntegrity,
  fakeFixDetector,
  accessibility,
  seo,
  links,
  performance,
  compatibility,
  aiReview,
  dependencyFreshness,
  maliciousDeps,
  licenses,
  iacSecurity,
  ciHardening,
  migrations,
  authFlaws,
  flakyTests,
  mutationAnalysis,
  errorSwallow,
};

export interface ModuleResultEnvelope {
  name: string;
  status: "passed" | "failed" | "skipped";
  checks: number;
  issues: number;
  duration: number;
  details?: string[];
  skipped?: string;
}

/**
 * Run all modules for a tier. Modules execute in parallel because they are
 * independent read-only analyses. Each result is wrapped into an envelope
 * the rest of the app already understands.
 *
 * Honesty contract:
 *   - If a module throws, its status is "failed" with the error message.
 *   - If a module returns `skipped`, its status is "skipped" (NOT "passed")
 *     so the customer sees we did not run it and why.
 *   - A module with issues = 0 is "passed" only if checks > 0.
 */
export async function runTier(
  tier: string,
  ctx: ModuleContext
): Promise<{ modules: ModuleResultEnvelope[]; totalIssues: number }> {
  const names = TIERS[tier] || TIERS.quick;
  const promises = names.map(async (name): Promise<ModuleResultEnvelope> => {
    const runner = MODULES[name];
    const started = Date.now();
    if (!runner) {
      // This should never happen — the types prevent it — but surface
      // loudly if someone edits TIERS without adding a runner.
      return {
        name,
        status: "failed",
        checks: 0,
        issues: 1,
        duration: 0,
        details: [`Module "${name}" is listed in the tier but has no runner`],
      };
    }
    // Skip modules that would start after the deadline — return partial
    // results rather than letting Vercel kill the whole function.
    if (ctx.deadlineMs && Date.now() > ctx.deadlineMs) {
      return {
        name,
        status: "skipped",
        checks: 0,
        issues: 0,
        duration: 0,
        skipped: "scan time budget exceeded",
      };
    }
    try {
      const out = await runner(ctx);
      if (out.skipped) {
        return {
          name,
          status: "skipped",
          checks: out.checks,
          issues: 0,
          duration: Date.now() - started,
          skipped: out.skipped,
          details: out.details.length > 0 ? out.details : undefined,
        };
      }
      const passed = out.issues === 0 && out.checks > 0;
      // Per-module detail cap — was 20 (which silently dropped the bottom of
      // every long report and meant the AI fix loop only ever saw "the top
      // half"). Raised to 200 so every finding reaches the UI / fix path /
      // AI-builder export. 200 × ~22 modules × ~150 bytes = ~660KB worst-case
      // JSON response, comfortably inside Vercel's 4.5MB ceiling. If a single
      // module ever exceeds 200, append an honest overflow line so the
      // customer knows what was held back instead of believing the report
      // is complete.
      const DETAIL_CAP = 200;
      const detailsOut: string[] | undefined = (() => {
        if (!out.details || out.details.length === 0) return undefined;
        if (out.details.length <= DETAIL_CAP) return out.details;
        return [
          ...out.details.slice(0, DETAIL_CAP),
          `info: ${out.details.length - DETAIL_CAP} more finding(s) not shown — re-scan with the CLI for the full list (gatetest --module ${name} --reporter json)`,
        ];
      })();
      return {
        name,
        status: passed ? "passed" : out.checks === 0 ? "skipped" : "failed",
        checks: out.checks,
        issues: out.issues,
        duration: Date.now() - started,
        details: detailsOut,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      return {
        name,
        status: "failed",
        checks: 0,
        issues: 1,
        duration: Date.now() - started,
        details: [`Module error: ${message}`],
      };
    }
  });

  const modules = await Promise.all(promises);
  const totalIssues = modules.reduce((s, m) => s + m.issues, 0);
  return { modules, totalIssues };
}
