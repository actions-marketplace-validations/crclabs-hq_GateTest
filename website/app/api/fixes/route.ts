/**
 * /api/fixes — Public "Fixed by GateTest" registry.
 *
 * GET  /api/fixes           → paginated list of delivered fix PRs
 * GET  /api/fixes?stats=1   → aggregate stats (total PRs, errors, warnings, repos)
 * GET  /api/fixes?page=N    → paginated with page number
 * POST /api/fixes           → log a new fix (internal — requires GATETEST_INTERNAL_TOKEN)
 */

import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/app/lib/db";

const { recordFix, listFixes, getFixStats } = require("@/app/lib/fixes-store");

// Internal calls from /api/scan/fix authenticate with this token.
// Falls back to GATETEST_ADMIN_PASSWORD so existing infra doesn't need a new env var.
const INTERNAL_TOKEN = process.env.GATETEST_INTERNAL_TOKEN || process.env.GATETEST_ADMIN_PASSWORD || "";

export async function GET(req: NextRequest) {
  try {
    const sql = getDb();
    const { searchParams } = new URL(req.url);

    if (searchParams.get("stats") === "1") {
      const stats = await getFixStats({ sql });
      return NextResponse.json({ ok: true, stats });
    }

    const page = Number(searchParams.get("page") || "1");
    const result = await listFixes({ sql, page });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  // Auth check — internal only
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!INTERNAL_TOKEN || token !== INTERNAL_TOKEN) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    repoName?: string;
    prUrl?: string;
    tier?: string;
    errorsFixed?: number;
    warningsFixed?: number;
    modulesFired?: string[];
    message?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.repoName || !body.prUrl) {
    return NextResponse.json({ ok: false, error: "repoName and prUrl are required" }, { status: 400 });
  }

  try {
    const sql = getDb();
    const row = await recordFix({
      sql,
      repoName: body.repoName,
      prUrl: body.prUrl,
      tier: body.tier || "full",
      errorsFixed: body.errorsFixed || 0,
      warningsFixed: body.warningsFixed || 0,
      modulesFired: body.modulesFired || [],
      message: body.message || null,
    });
    return NextResponse.json({ ok: true, id: row?.id });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
