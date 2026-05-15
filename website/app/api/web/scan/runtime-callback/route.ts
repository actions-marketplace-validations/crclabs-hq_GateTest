/**
 * Crontech → GateTest runtime callback.
 *
 * Crontech POSTs here after a headless-browser runtime scan finishes
 * (success OR failure). We verify the HMAC signature (fail-closed,
 * Forbidden #15), parse the runtime payload, and persist it on the
 * scan_queue row keyed by the scan id. The next scan/status poll will
 * surface the merged static + runtime results to the customer.
 *
 * Inbound contract (Crontech side):
 *   POST /api/web/scan/runtime-callback
 *   headers:
 *     X-GateTest-Signature: hex(hmac-sha256(secret, body))
 *     X-GateTest-Timestamp: unix-seconds
 *   body (JSON):
 *     {
 *       "scanId": "scn_xxx",
 *       "status": "completed" | "failed",
 *       "durationMs": 4321,
 *       "findings": [                     // empty array when status:failed
 *         { "name": "runtime-errors:page-error", "severity": "error",
 *           "passed": false, "message": "..." },
 *         ...
 *       ],
 *       "error": "..."                    // only when status:failed
 *     }
 *
 * Fail-closed semantics:
 *   - Missing CRONTECH_DISPATCH_SECRET → 503 (we won't process callbacks
 *     when we can't verify them).
 *   - Missing/invalid signature → 401.
 *   - Replay protection: reject timestamps older than 5 minutes.
 *
 * Response: 200 { received: true } on success, 4xx with { error } otherwise.
 */

import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 15;

const REPLAY_WINDOW_SEC = 300; // 5 minutes

interface RuntimeFinding {
  name?: string;
  severity?: string;
  passed?: boolean;
  message?: string;
}

interface RuntimeCallbackBody {
  scanId?: string;
  status?: "completed" | "failed";
  durationMs?: number;
  findings?: RuntimeFinding[];
  error?: string;
}

export async function POST(req: NextRequest) {
  // 1. Read RAW body — JSON.parse after, because the HMAC must be over
  //    the exact bytes Crontech signed.
  const raw = await req.text();

  // 2. Resolve the dispatch secret. Fail-closed when absent.
  const secret = process.env.CRONTECH_DISPATCH_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "Callback verification not configured" },
      { status: 503 }
    );
  }

  // 3. Verify signature.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { verifySignature, SIGNATURE_HEADER, TIMESTAMP_HEADER } = require("@/app/lib/crontech-dispatch") as {
    verifySignature: (body: string, sig: string | null | undefined, secret: string) => boolean;
    SIGNATURE_HEADER: string;
    TIMESTAMP_HEADER: string;
  };

  const sig = req.headers.get(SIGNATURE_HEADER) || req.headers.get(SIGNATURE_HEADER.toLowerCase());
  if (!sig || !verifySignature(raw, sig, secret)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  // 4. Replay protection.
  const tsHeader = req.headers.get(TIMESTAMP_HEADER) || req.headers.get(TIMESTAMP_HEADER.toLowerCase());
  const ts = Number(tsHeader);
  if (!Number.isFinite(ts) || ts <= 0) {
    return NextResponse.json({ error: "Missing or invalid timestamp" }, { status: 401 });
  }
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > REPLAY_WINDOW_SEC) {
    return NextResponse.json({ error: "Timestamp outside replay window" }, { status: 401 });
  }

  // 5. Parse + validate body.
  let body: RuntimeCallbackBody;
  try {
    body = JSON.parse(raw) as RuntimeCallbackBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.scanId || typeof body.scanId !== "string") {
    return NextResponse.json({ error: "scanId is required" }, { status: 400 });
  }
  if (body.status !== "completed" && body.status !== "failed") {
    return NextResponse.json({ error: "status must be 'completed' or 'failed'" }, { status: 400 });
  }
  if (body.status === "completed" && !Array.isArray(body.findings)) {
    return NextResponse.json({ error: "findings[] required when status is completed" }, { status: 400 });
  }

  // 6. Persist runtime payload onto the scan_queue row.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getDb } = require("@/app/lib/db") as { getDb: () => (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown> };
  let sql;
  try {
    sql = getDb();
  } catch {
    // DB not configured locally — still ack so Crontech doesn't retry.
    // Log so the operator can see the dropped payload.
    console.warn(`[runtime-callback] DB unavailable; dropped runtime payload for scan ${body.scanId}`);
    return NextResponse.json({ received: true, persisted: false }, { status: 200 });
  }

  try {
    await sql`
      ALTER TABLE scan_queue
        ADD COLUMN IF NOT EXISTS runtime_status TEXT,
        ADD COLUMN IF NOT EXISTS runtime_payload JSONB,
        ADD COLUMN IF NOT EXISTS runtime_completed_at TIMESTAMPTZ
    `;
    const payload = {
      status: body.status,
      durationMs: body.durationMs ?? null,
      findings: body.status === "completed" ? body.findings : [],
      error: body.status === "failed" ? body.error || "unknown" : null,
    };
    const rows = (await sql`
      UPDATE scan_queue
      SET runtime_status = ${body.status},
          runtime_payload = ${JSON.stringify(payload)}::jsonb,
          runtime_completed_at = NOW()
      WHERE event_id = ${body.scanId}
      RETURNING id
    `) as Array<{ id: number }>;

    if (rows.length === 0) {
      return NextResponse.json(
        { received: true, persisted: false, reason: "scanId not found in queue" },
        { status: 200 }
      );
    }

    return NextResponse.json({ received: true, persisted: true, scanId: body.scanId }, { status: 200 });
  } catch (err) {
    console.warn(
      `[runtime-callback] Failed to persist runtime payload for scan ${body.scanId}: ${err instanceof Error ? err.message : String(err)}`
    );
    // Still 200 so Crontech doesn't retry — we logged the dropped data.
    return NextResponse.json({ received: true, persisted: false }, { status: 200 });
  }
}

export async function GET() {
  return NextResponse.json(
    { hint: "POST runtime scan results here from Crontech with X-GateTest-Signature header." },
    { status: 405 }
  );
}
