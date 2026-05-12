/**
 * Phase 5.1.4 — Intelligence dashboard API.
 *
 * GET /api/dashboard/intelligence?repoUrl=https://github.com/o/r
 *
 * Reads the cross-repo intelligence brain (Phase 5.1.1 schema) and
 * returns a structured "where do I sit" report for the customer:
 *   - their most recent fingerprint
 *   - aggregate stats for codebases that share their stack
 *   - similar past scans (deidentified — only frameworks + counts)
 *   - their delta vs the cohort
 *
 * This is the surface that turns the brain into a sales asset:
 * "you're in the 87th percentile of similar Next 16 + Stripe codebases."
 *
 * Auth: caller must be on the GATETEST_ADMIN_USERNAMES list (admin-only
 * for now; customer-facing variant comes later when we wire it through
 * customer-session). Reading the brain across the whole tenant base is
 * a privacy-relevant action, so this endpoint is admin-only by default.
 */

import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import crypto from "crypto";
import { getDb } from "@/app/lib/db";
import {
  getAdminConfig,
  getAdminUser,
  SESSION_COOKIE_NAME,
} from "@/app/lib/admin-session";
import { ADMIN_COOKIE_NAME } from "@/app/lib/admin-auth";
 
const fingerprintStore = require("@/app/lib/scan-fingerprint-store.js") as {
  hashRepoUrl: (url: string) => string;
  findSimilarFingerprints: (opts: {
    sql: unknown;
    fingerprintSignature: string;
    frameworkVersions?: Record<string, string>;
    excludeRepoUrlHash?: string | null;
    limit?: number;
  }) => Promise<Array<Record<string, unknown>>>;
  getFingerprintStats: (opts: {
    sql: unknown;
    frameworkVersions: Record<string, string>;
    daysBack?: number;
  }) => Promise<{ count: number; medianFindings: number; p90Findings: number; fixSuccessRate: number }>;
};
 
const lookup = require("@/app/lib/cross-repo-lookup.js") as {
  summariseSimilarScans: (rows: Array<Record<string, unknown>>) => Record<string, unknown> | null;
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function isAuthenticatedAdmin(): Promise<boolean> {
  const store = await cookies();
  const adminStatus = getAdminConfig();
  if (adminStatus.ok && adminStatus.config) {
    const sessionCookie = store.get(SESSION_COOKIE_NAME)?.value;
    if (getAdminUser(sessionCookie, adminStatus.config)) return true;
  }
  const adminPassword = process.env.GATETEST_ADMIN_PASSWORD || "";
  if (adminPassword) {
    const passwordCookie = store.get(ADMIN_COOKIE_NAME)?.value || "";
    const expected = crypto
      .createHmac("sha256", adminPassword)
      .update("gatetest-admin-v1")
      .digest("hex");
    if (
      passwordCookie &&
      passwordCookie.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(passwordCookie), Buffer.from(expected))
    )
      return true;
  }
  return false;
}

interface IntelligenceResponse {
  ok: boolean;
  repoUrlHash?: string;
  myLatestFingerprint?: {
    createdAt: string;
    tier: string;
    frameworkVersions: Record<string, string>;
    languageMix: Record<string, number>;
    totalFindings: number;
    totalFixed: number;
    fingerprintSignature: string;
  } | null;
  cohortStats?: {
    count: number;
    sampleSize: number;
    medianFindings: number;
    p90Findings: number;
    fixSuccessRate: number;
    daysBack: number;
  } | null;
  similarPriorScans?: Array<{
    createdAt: string;
    tier: string;
    frameworkVersions: Record<string, string>;
    totalFindings: number;
    totalFixed: number;
  }>;
  similaritySummary?: Record<string, unknown> | null;
  positioning?: {
    findingsPercentile: number; // 0-100 — lower is better (fewer findings than peers)
    relativePosition: "leader" | "above_average" | "median" | "below_average" | "lagging";
    fixSuccessVsCohort: number; // -1.0 to +1.0 (delta vs cohort fix rate)
  } | null;
  error?: string;
}

export async function GET(req: NextRequest): Promise<NextResponse<IntelligenceResponse>> {
  if (!(await isAuthenticatedAdmin())) {
    return NextResponse.json({ ok: false, error: "unauthorised" }, { status: 401 });
  }

  const url = new URL(req.url);
  const repoUrl = url.searchParams.get("repoUrl");
  if (!repoUrl) {
    return NextResponse.json(
      { ok: false, error: "repoUrl query parameter is required" },
      { status: 400 }
    );
  }

  let sql;
  try {
    sql = getDb();
  } catch {
    return NextResponse.json(
      { ok: false, error: "database not configured" },
      { status: 503 }
    );
  }

  const repoUrlHash = fingerprintStore.hashRepoUrl(repoUrl);

  // Look up the customer's most recent fingerprint for this repo.
  let myLatest: Record<string, unknown> | null = null;
  try {
    const rows = (await sql`
      SELECT created_at, tier, framework_versions, language_mix,
             module_findings, fix_outcomes, total_findings, total_fixed,
             fingerprint_signature
      FROM scan_fingerprint
      WHERE repo_url_hash = ${repoUrlHash}
      ORDER BY created_at DESC
      LIMIT 1
    `) as Array<Record<string, unknown>>;
    myLatest = rows[0] || null;
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: `brain unavailable: ${err instanceof Error ? err.message : "unknown"}`,
      },
      { status: 503 }
    );
  }

  if (!myLatest) {
    // No prior scan for this repo — return an empty-ish response with a
    // helpful pointer.
    return NextResponse.json({
      ok: true,
      repoUrlHash,
      myLatestFingerprint: null,
      cohortStats: null,
      similarPriorScans: [],
      similaritySummary: null,
      positioning: null,
    });
  }

  const frameworkVersions = (myLatest.framework_versions as Record<string, string>) || {};
  const languageMix = (myLatest.language_mix as Record<string, number>) || {};

  // Cohort stats — aggregate over the last 30 days for repos sharing
  // this customer's framework stack.
  const cohortStats = await fingerprintStore.getFingerprintStats({
    sql,
    frameworkVersions,
    daysBack: 30,
  });

  // Up to 10 similar past scans. Excludes the customer's own repo.
  let similarRows: Array<Record<string, unknown>> = [];
  try {
    similarRows = await fingerprintStore.findSimilarFingerprints({
      sql,
      fingerprintSignature: String(myLatest.fingerprint_signature || ""),
      frameworkVersions,
      excludeRepoUrlHash: repoUrlHash,
      limit: 10,
    });
  } catch {
    // Brain partial-failure — return empty similar list rather than fail.
    similarRows = [];
  }

  // Build the similarity summary if we have enough samples.
  const similaritySummary = lookup.summariseSimilarScans(similarRows);

  // Positioning: where does this customer sit vs the cohort?
  const myFindings = Number(myLatest.total_findings) || 0;
  const myFixed = Number(myLatest.total_fixed) || 0;
  const myFixRate = myFindings > 0 ? myFixed / myFindings : 0;
  let positioning: IntelligenceResponse["positioning"] = null;
  if (cohortStats && cohortStats.count >= 3) {
    // Compute approximate percentile against cohort median + p90.
    let pct: number;
    if (myFindings <= cohortStats.medianFindings) pct = 30; // better than median
    else if (myFindings <= cohortStats.p90Findings) pct = 70; // average-ish
    else pct = 95; // worse than 90% of peers
    let relativePosition: NonNullable<IntelligenceResponse["positioning"]>["relativePosition"];
    if (pct <= 20) relativePosition = "leader";
    else if (pct <= 40) relativePosition = "above_average";
    else if (pct <= 60) relativePosition = "median";
    else if (pct <= 80) relativePosition = "below_average";
    else relativePosition = "lagging";
    positioning = {
      findingsPercentile: pct,
      relativePosition,
      fixSuccessVsCohort: Math.round((myFixRate - cohortStats.fixSuccessRate) * 100) / 100,
    };
  }

  return NextResponse.json({
    ok: true,
    repoUrlHash,
    myLatestFingerprint: {
      createdAt: String(myLatest.created_at || ""),
      tier: String(myLatest.tier || ""),
      frameworkVersions,
      languageMix,
      totalFindings: myFindings,
      totalFixed: myFixed,
      fingerprintSignature: String(myLatest.fingerprint_signature || ""),
    },
    cohortStats: cohortStats.count > 0
      ? { ...cohortStats, sampleSize: cohortStats.count, daysBack: 30 }
      : null,
    similarPriorScans: similarRows.map((r) => ({
      createdAt: String(r.created_at || ""),
      tier: String(r.tier || ""),
      frameworkVersions: (r.framework_versions as Record<string, string>) || {},
      totalFindings: Number(r.total_findings) || 0,
      totalFixed: Number(r.total_fixed) || 0,
    })),
    similaritySummary: similaritySummary,
    positioning,
  });
}
