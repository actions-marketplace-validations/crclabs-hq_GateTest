/**
 * GET /api/scan/history?repo=<url>&limit=<n>
 *
 * Returns scan history for a given repo URL, newest first.
 * Used by the dashboard history section so customers can see improvement
 * over time ("last week: 54 errors, today: 12 errors").
 *
 * Auth: admin cookie (same pattern as all /api/admin/* routes).
 * Graceful: returns { history: [] } when DB is not configured.
 */

import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createHmac, timingSafeEqual } from "crypto";
import {
  getAdminConfig,
  getAdminUser,
  SESSION_COOKIE_NAME,
} from "@/app/lib/admin-session";
import { ADMIN_COOKIE_NAME } from "@/app/lib/admin-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function checkPwCookie(v: string | undefined): boolean {
  const pw = process.env.GATETEST_ADMIN_PASSWORD || "";
  if (!pw || !v) return false;
  const exp = createHmac("sha256", pw).update("gatetest-admin-v1").digest("hex");
  const a = Buffer.from(v);
  const b = Buffer.from(exp);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

async function isAuthenticatedAdmin(): Promise<boolean> {
  const store = await cookies();
  const adminStatus = getAdminConfig();
  if (adminStatus.ok && adminStatus.config) {
    const sessionCookie = store.get(SESSION_COOKIE_NAME)?.value;
    if (getAdminUser(sessionCookie, adminStatus.config)) return true;
  }
  if (checkPwCookie(store.get(ADMIN_COOKIE_NAME)?.value)) return true;
  return false;
}

export async function GET(req: NextRequest) {
  if (!(await isAuthenticatedAdmin())) {
    return NextResponse.json({ error: "unauthorised" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const repoUrl = searchParams.get("repo") || "";
  const limitRaw = parseInt(searchParams.get("limit") || "20", 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 && limitRaw <= 100 ? limitRaw : 20;

  if (!repoUrl) {
    return NextResponse.json({ error: "repo parameter is required" }, { status: 400 });
  }

  try {
    const { getDb } = await import("@/app/lib/db");
    const scanHistoryStore = require("@/app/lib/scan-history-store.js") as {
      getRepoHistory: (sql: unknown, repoUrl: string, limit: number) => Promise<Array<Record<string, unknown>>>;
    };
    const sql = getDb();
    const history = await scanHistoryStore.getRepoHistory(sql, repoUrl, limit);
    return NextResponse.json({ history });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    // DATABASE_URL not set or table doesn't exist yet — return empty gracefully
    if (
      msg.includes("DATABASE_URL") ||
      msg.includes("does not exist") ||
      msg.includes("relation")
    ) {
      return NextResponse.json({ history: [] });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
