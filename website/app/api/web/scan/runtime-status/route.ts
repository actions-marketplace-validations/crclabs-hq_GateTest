/**
 * Runtime-status poll endpoint.
 *
 * The customer's /scan/status (or /web result page) polls this every
 * few seconds while the Crontech worker is running their URL through a
 * real Chromium. When the runtime-callback lands, this returns the
 * finished payload.
 *
 * Public + unauthenticated by scan id — the scan id is a randomly
 * generated 18-hex-char token, hard to guess. Same threat-model as
 * Stripe checkout session ids.
 */

import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const scanId = req.nextUrl.searchParams.get("scanId");
  if (!scanId || !/^scn_[0-9a-f]{18}$/.test(scanId)) {
    return NextResponse.json({ error: "Invalid or missing scanId" }, { status: 400 });
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getDb } = require("@/app/lib/db") as { getDb: () => (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown> };

  let sql;
  try {
    sql = getDb();
  } catch {
    return NextResponse.json(
      { scanId, runtime: { status: "unavailable", reason: "DB not configured" } },
      { status: 200 }
    );
  }

  try {
    const rows = (await sql`
      SELECT runtime_status, runtime_payload, runtime_completed_at
      FROM scan_queue
      WHERE event_id = ${scanId}
      LIMIT 1
    `) as Array<{ runtime_status: string | null; runtime_payload: unknown; runtime_completed_at: string | null }>;

    if (rows.length === 0) {
      return NextResponse.json(
        { scanId, runtime: { status: "queued", reason: "Not yet started" } },
        { status: 200 }
      );
    }

    const row = rows[0];
    if (!row.runtime_status) {
      return NextResponse.json(
        { scanId, runtime: { status: "queued" } },
        { status: 200 }
      );
    }

    return NextResponse.json(
      {
        scanId,
        runtime: {
          status: row.runtime_status,
          completedAt: row.runtime_completed_at,
          payload: row.runtime_payload,
        },
      },
      { status: 200 }
    );
  } catch (err) {
    return NextResponse.json(
      {
        scanId,
        runtime: {
          status: "unavailable",
          reason: err instanceof Error ? err.message : "Unknown DB error",
        },
      },
      { status: 200 }
    );
  }
}
