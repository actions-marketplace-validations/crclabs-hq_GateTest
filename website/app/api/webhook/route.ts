/**
 * GitHub App webhook endpoint — dual-host ingress (Phase 1).
 *
 * GateTest is dual-host as of 2026-04-22: push / PR events can arrive
 * from Gluecron (via the Signal Bus at /api/events/push) OR from a
 * GitHub App webhook (this path). Both paths enqueue into the shared
 * `scan_queue` — downstream scan execution is host-agnostic because
 * `gluecron-client.ts` falls back to the GitHub REST API when a GitHub
 * PAT is configured.
 *
 * This replaces the 410 Gone placeholder that was in place during the
 * Gluecron-only migration (Known Issue #8, 2026-04-19 → 2026-04-22).
 * The Bible's strategic direction remains Gluecron-first long-term, but
 * GitHub is the distribution channel NOW — turning it off before
 * Gluecron has paying customers was a commercial misstep.
 *
 * TODO(phase-2): Post commit-status + PR comment back to GitHub after the
 * scan completes. The worker currently calls the Gluecron callback only;
 * a GitHub-host branch needs GitHubBridge in src/core/github-bridge.js.
 *
 * Wire contract: see website/app/lib/github-events.js for the full
 * contract, HMAC format, and event-handling rules. Unit tests live at
 * tests/github-events.test.js.
 */

import { NextRequest, NextResponse } from "next/server";

import { getDb } from "@/app/lib/db";

// CommonJS interop — helpers are .js using require-style exports.
 
const githubEvents = require("@/app/lib/github-events");
 
const queueStore = require("@/app/lib/scan-queue-store");

export async function POST(req: NextRequest) {
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    return NextResponse.json({ error: "malformed: cannot read body" }, { status: 400 });
  }

  const eventType = req.headers.get("x-github-event");
  const delivery = req.headers.get("x-github-delivery");
  const signatureHeader = req.headers.get("x-hub-signature-256");

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

  await githubEvents.processGitHubEvent({
    rawBody,
    eventType,
    delivery,
    signatureHeader,
    env: process.env,
    sql,
    queueStore,
    fetchImpl: typeof fetch === "function" ? fetch : undefined,
    baseUrl,
  });

  return NextResponse.json({ status: "processing" });
}



// GET health shim — lets ops dashboards confirm the webhook is live.
export async function GET() {
  return NextResponse.json({
    status: "ok",
    app: "GateTest",
    mode: "dual-host",
    hosts: ["github", "gluecron"],
    events: "/api/webhook (github) | /api/events/push (gluecron)",
  });
}
