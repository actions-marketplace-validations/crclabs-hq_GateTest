/**
 * GET /api/admin/learning/trend
 *
 * Phase 6.2.5 — closed-feedback FP-rate trending data source. Returns
 * a time-bucketed view of dissent + computed FP-rate per bucket, plus
 * a single headline summary ("FP rate down 73% over 90 days").
 *
 * Powers the chart on /admin/learning that proves Phase 5.2's closed
 * feedback loop is working — the visible "look how we self-improve"
 * surface a prospect can see in 5 seconds.
 *
 * Auth: same admin-cookie pattern as every /api/admin/* route.
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
 
const dissentStore = require("@/app/lib/dissent-store.js") as {
  ensureDissentTable: (sql: unknown) => Promise<void>;
};
 
const fpTrend = require("@/app/lib/fp-trend.js") as {
  DEFAULT_DAYS_BACK: number;
  DEFAULT_BUCKET_DAYS: number;
  bucketDissentRows: (rows: unknown[], opts: { bucketDays: number; daysBack: number }) => Array<Record<string, unknown>>;
  computeFpRateTrend: (buckets: Array<Record<string, unknown>>) => Array<Record<string, unknown>>;
  summariseTrend: (buckets: Array<Record<string, unknown>>) => Record<string, unknown>;
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

export async function GET(req: NextRequest) {
  if (!(await isAuthenticatedAdmin())) {
    return NextResponse.json({ ok: false, error: "unauthorised" }, { status: 401 });
  }

  let sql;
  try {
    sql = getDb();
  } catch {
    return NextResponse.json({ ok: false, error: "database not configured" }, { status: 503 });
  }

  // Optional query overrides — defaults match the helper's defaults.
  const url = new URL(req.url);
  const daysBack = Number(url.searchParams.get("daysBack")) || fpTrend.DEFAULT_DAYS_BACK;
  const bucketDays = Number(url.searchParams.get("bucketDays")) || fpTrend.DEFAULT_BUCKET_DAYS;

  try {
    await dissentStore.ensureDissentTable(sql);
    const sqlT = sql as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>;
    interface DissentRow { created_at: string; module: string; kind: string; repo_url_hash: string; }
    const rows = (await sqlT`
      SELECT created_at, module, kind, repo_url_hash
      FROM dissent
      WHERE created_at > NOW() - (${daysBack} || ' days')::interval
      ORDER BY created_at ASC
    `) as DissentRow[];

    const bucketed = fpTrend.bucketDissentRows(rows, { bucketDays, daysBack });
    const trended = fpTrend.computeFpRateTrend(bucketed);
    const summary = fpTrend.summariseTrend(trended);

    return NextResponse.json({
      ok: true,
      meta: { daysBack, bucketDays, totalDissentRows: rows.length },
      buckets: trended,
      summary,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: `trend unavailable: ${err instanceof Error ? err.message : "unknown"}` },
      { status: 500 }
    );
  }
}
