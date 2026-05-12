/**
 * GET /api/admin/learning
 *
 * Phase 5.2.4 — operator dashboard data source. Returns the current
 * state of the learning system:
 *
 *   - Recent dissent (top 50) — what customers said was wrong
 *   - Per-module confidence scores — sorted ascending so worst rises
 *   - Dissent kinds breakdown over the last 30 days
 *   - Last-refresh metadata so the operator knows the data is fresh
 *
 * Auth: same admin-cookie pattern as every /api/admin/* route.
 */

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import crypto from "crypto";
import { getDb } from "@/app/lib/db";
import {
  getAdminConfig,
  getAdminUser,
  SESSION_COOKIE_NAME,
} from "@/app/lib/admin-session";
import { ADMIN_COOKIE_NAME } from "@/app/lib/admin-auth";
 
const dissentStore = require("@/app/lib/dissent-store.js") as {
  ensureDissentTable: (sql: unknown) => Promise<void>;
  aggregateDissentByModulePattern: (opts: { sql: unknown; daysBack?: number }) => Promise<Array<Record<string, unknown>>>;
  dissentKindsSummary: (opts: { sql: unknown; daysBack?: number }) => Promise<Array<{ kind: string; n: number }>>;
};
 
const moduleConfidence = require("@/app/lib/module-confidence.js") as {
  ensureModuleConfidenceTable: (sql: unknown) => Promise<void>;
  recommendedAction: (score: number) => string;
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

export async function GET() {
  if (!(await isAuthenticatedAdmin())) {
    return NextResponse.json({ ok: false, error: "unauthorised" }, { status: 401 });
  }

  let sql;
  try {
    sql = getDb();
  } catch {
    return NextResponse.json({ ok: false, error: "database not configured" }, { status: 503 });
  }

  try {
    await dissentStore.ensureDissentTable(sql);
    await moduleConfidence.ensureModuleConfidenceTable(sql);

    interface ConfidenceRow { module: string; pattern_hash: string | null; score: string | number; dissent_count: number; distinct_repos: number; updated_at: string; }
    interface DissentRow { id: number; created_at: string; module: string; pattern_hash: string | null; kind: string; fix_pr_number: number | null; }

    const sqlT = sql as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>;

    const [confidenceRows, kindsBreakdown, dissentAgg, recentRaw] = await Promise.all([
      sqlT`
        SELECT module, pattern_hash, score, dissent_count, distinct_repos, updated_at
        FROM module_confidence
        ORDER BY score ASC, dissent_count DESC
        LIMIT 50
      ` as Promise<ConfidenceRow[]>,
      dissentStore.dissentKindsSummary({ sql, daysBack: 30 }),
      dissentStore.aggregateDissentByModulePattern({ sql, daysBack: 30 }),
      sqlT`
        SELECT id, created_at, module, pattern_hash, kind, fix_pr_number
        FROM dissent
        ORDER BY created_at DESC
        LIMIT 50
      ` as Promise<DissentRow[]>,
    ]);

    const trackedModules = (confidenceRows || []).map((r) => ({
      module: r.module,
      patternHash: r.pattern_hash || null,
      score: Number(r.score),
      action: moduleConfidence.recommendedAction(Number(r.score)),
      dissentCount: r.dissent_count,
      distinctRepos: r.distinct_repos,
      updatedAt: r.updated_at,
    }));

    const recentDissent = (recentRaw || []).map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      module: r.module,
      patternHash: r.pattern_hash,
      kind: r.kind,
      fixPrNumber: r.fix_pr_number,
    }));

    return NextResponse.json({
      ok: true,
      trackedModules,
      kindsBreakdown,
      dissentByModule: dissentAgg,
      recentDissent,
      meta: {
        windowDays: 30,
      },
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: `learning data unavailable: ${err instanceof Error ? err.message : "unknown"}`,
      },
      { status: 500 }
    );
  }
}
