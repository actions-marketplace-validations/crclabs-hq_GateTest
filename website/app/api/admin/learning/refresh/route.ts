/**
 * POST /api/admin/learning/refresh
 *
 * Phase 5.2.2 — manually trigger the per-module FP scorer. Reads the
 * dissent aggregate, recomputes module_confidence for every (module,
 * pattern) pair. Designed to be called weekly via Vercel cron AND
 * manually from the operator dashboard (/admin/learning) when an
 * admin wants to force a refresh after a wave of dissent.
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
 
const moduleConfidence = require("@/app/lib/module-confidence.js") as {
  ensureModuleConfidenceTable: (sql: unknown) => Promise<void>;
  refreshModuleConfidence: (opts: { sql: unknown; daysBack?: number }) => Promise<{
    updated: number;
    scanned: number;
  }>;
};
 
const dissentStore = require("@/app/lib/dissent-store.js") as {
  ensureDissentTable: (sql: unknown) => Promise<void>;
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

export async function POST() {
  if (!(await isAuthenticatedAdmin())) {
    return NextResponse.json(
      { ok: false, error: "unauthorised" },
      { status: 401 }
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

  try {
    // Both tables must exist — first-run installs may not have either.
    await dissentStore.ensureDissentTable(sql);
    await moduleConfidence.ensureModuleConfidenceTable(sql);
    const result = await moduleConfidence.refreshModuleConfidence({
      sql,
      daysBack: 30,
    });
    return NextResponse.json({
      ok: true,
      updated: result.updated,
      scanned: result.scanned,
      message: `Refreshed ${result.updated} module-confidence rows from ${result.scanned} dissent aggregate(s).`,
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: `refresh failed: ${err instanceof Error ? err.message : "unknown"}`,
      },
      { status: 500 }
    );
  }
}

// GET returns the last-refresh stats so the operator dashboard can
// display "last refreshed Xh ago / N modules tracked / lowest score".
export async function GET() {
  if (!(await isAuthenticatedAdmin())) {
    return NextResponse.json(
      { ok: false, error: "unauthorised" },
      { status: 401 }
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
  try {
    await moduleConfidence.ensureModuleConfidenceTable(sql);
    // Last-updated row, plus aggregate stats for the dashboard
    // header.
    interface ModuleConfidenceLastRow { updated_at: string; module: string; pattern_hash: string | null; score: string | number; }
    interface ModuleConfidenceStatsRow { tracked: string | number; min_score: string | number; max_score: string | number; lowest_score_module: string; }
    const lastQuery = (sql as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<ModuleConfidenceLastRow[]>);
    const last = await lastQuery`
      SELECT updated_at, module, pattern_hash, score
      FROM module_confidence
      ORDER BY updated_at DESC
      LIMIT 1
    `;
    const statsQuery = (sql as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<ModuleConfidenceStatsRow[]>);
    const stats = await statsQuery`
      SELECT
        COUNT(*) AS tracked,
        MIN(score) AS min_score,
        MAX(score) AS max_score,
        (SELECT module FROM module_confidence ORDER BY score ASC LIMIT 1) AS lowest_score_module
      FROM module_confidence
    `;
    return NextResponse.json({
      ok: true,
      lastUpdated: last[0]?.updated_at || null,
      tracked: Number(stats[0]?.tracked) || 0,
      minScore: stats[0]?.min_score === null || stats[0]?.min_score === undefined ? null : Number(stats[0].min_score),
      maxScore: stats[0]?.max_score === null || stats[0]?.max_score === undefined ? null : Number(stats[0].max_score),
      lowestScoreModule: stats[0]?.lowest_score_module || null,
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: `stats unavailable: ${err instanceof Error ? err.message : "unknown"}`,
      },
      { status: 500 }
    );
  }
}
