/**
 * GET /api/admin/learning/cron
 *
 * Phase 5.2.2 — Vercel cron entry-point for the weekly per-module FP
 * scorer refresh. Same auth pattern as /api/watches/tick and
 * /api/scan/worker/tick.
 *
 * Vercel cron schedules a GET; this route auths the cron secret and
 * runs refreshModuleConfidence over the last 30 days of dissent.
 */

import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/app/lib/db";
 
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

function authorizedCron(req: NextRequest): boolean {
  const vercelCronSecret = process.env.CRON_SECRET || "";
  const authHeader = req.headers.get("authorization") || "";
  if (vercelCronSecret && authHeader === `Bearer ${vercelCronSecret}`) return true;
  if (req.headers.get("x-vercel-cron") === "1") return true;
  if (process.env.NODE_ENV !== "production") return true;
  return false;
}

export async function GET(req: NextRequest) {
  if (!authorizedCron(req)) {
    return NextResponse.json({ ok: false, error: "unauthorised" }, { status: 401 });
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
    await dissentStore.ensureDissentTable(sql);
    await moduleConfidence.ensureModuleConfidenceTable(sql);
    const result = await moduleConfidence.refreshModuleConfidence({
      sql,
      daysBack: 30,
    });
    return NextResponse.json({
      ok: true,
      cron: "module-confidence-refresh",
      updated: result.updated,
      scanned: result.scanned,
      ranAt: new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: `cron refresh failed: ${err instanceof Error ? err.message : "unknown"}`,
      },
      { status: 500 }
    );
  }
}
