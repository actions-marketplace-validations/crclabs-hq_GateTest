/**
 * Signal Bus E1 — inbound push-event receiver.
 *
 * Wire contract (GateTest's OWN copy — do NOT import from Gluecron,
 * HTTP-only coupling rule):
 *
 *   POST /api/events/push
 *   Headers:
 *     X-Signal-Signature: sha256=<hmac(GLUECRON_EMITTER_SECRET, rawBody)>
 *     Content-Type: application/json
 *   Body:
 *     {
 *       eventId: "<uuid-v4>",              // idempotency key
 *       eventType: "push.received",
 *       repository: "owner/name",
 *       sha: "<40-hex>",
 *       ref: "refs/heads/main",
 *       pullRequestNumber: <int|null>,
 *       emittedAt: "<ISO-8601>"
 *     }
 *
 *   Responses:
 *     202 { queued: true, eventId }
 *     200 { duplicate: true, eventId }
 *     429 queue full, Retry-After: 30
 *     401 invalid signature
 *     400 malformed
 *     503 GLUECRON_EMITTER_SECRET missing
 *
 * Design rationale (Signal Bus E1):
 *   - Gluecron POSTs here on every push; we enqueue immediately and 202
 *     back so Gluecron can keep moving. No blocking scan work inline.
 *   - Idempotency is handled at the DB level — INSERT ... ON CONFLICT
 *     (event_id) DO NOTHING. A retried POST with the same eventId is a
 *     no-op, and we return 200 { duplicate: true }.
 *   - v1 ships inline-kick + Vercel cron together: we fire a best-effort
 *     POST to /api/scan/worker/tick so a push during a cron gap runs
 *     promptly. The 1-minute cron is the fallback; the inline kick is
 *     the optimisation. Kick failure is logged and discarded.
 *   - Serverless rule compliance: no in-memory state, every handler
 *     is stateless, all persistence goes through scan-queue-store.
 *
 * See website/app/lib/events-push.js for the pure helpers that back
 * this route; tests live at tests/events-push.test.js.
 */

import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/app/lib/db";

// CommonJS interop — the helpers are .js and our lib/* use require-style.
 
const eventsPush = require("@/app/lib/events-push");
 
const queueStore = require("@/app/lib/scan-queue-store");

export async function POST(req: NextRequest) {
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    return NextResponse.json({ error: "malformed: cannot read body" }, { status: 400 });
  }

  const signatureHeader = req.headers.get("x-signal-signature");

  let sql;
  try {
    sql = getDb();
  } catch (err) {
    const msg = err instanceof Error ? err.message : "database not configured";
    return NextResponse.json({ error: msg }, { status: 503 });
  }

  const baseUrl =
    process.env.NEXT_PUBLIC_BASE_URL ||
    (req.nextUrl.origin ? req.nextUrl.origin : "");

  const result = await eventsPush.processPushEvent({
    rawBody,
    signatureHeader,
    env: process.env,
    sql,
    queueStore,
    fetchImpl: (url: string, init: RequestInit) => fetch(url, init),
    baseUrl,
  });

  const res = NextResponse.json(result.body, { status: result.status });
  if (result.headers) {
    for (const [k, v] of Object.entries(result.headers)) {
      res.headers.set(k, v as string);
    }
  }
  return res;
}
