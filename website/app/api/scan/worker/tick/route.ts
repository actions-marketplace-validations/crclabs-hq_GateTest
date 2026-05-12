/**
 * Signal Bus E1 — cron-driven worker tick.
 *
 * Triggered by:
 *   1. Vercel cron: `* * * * *` from vercel.json
 *   2. Inline kick from /api/events/push and /api/webhook after enqueue
 *   3. Admin-auth'd manual trigger (for debugging)
 *
 * Responsibility:
 *   - Reclaim rows stuck in status='running' (> 5 minutes) via reclaimStuck
 *   - Claim the next ready row via claimNextJob (FOR UPDATE SKIP LOCKED)
 *   - Run the scan via scan-executor.runScan
 *   - On success: markDone + host-aware callback
 *       GitHub jobs → sendGithubCallback (commit status + PR comment)
 *       Gluecron jobs → sendGluecronCallback (existing Signal Bus hook)
 *   - On failure: markFailed(willRetry). If dead-lettered, also fire
 *     a callback so neither host waits forever.
 *   - NEVER throws to Vercel — all errors are caught and returned as JSON.
 *
 * See website/app/lib/scan-worker.js for pure helpers.
 * Tests: tests/scan-worker-tick.test.js
 */

import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/app/lib/db";
import { isAdminRequest } from "@/app/lib/admin-auth";
import { runScan } from "@/app/lib/scan-executor";
import { sendGluecronCallback } from "@/app/lib/gluecron-callback";
import { sendGithubCallback } from "@/app/lib/github-callback";

// CommonJS interop.
 
const scanWorker = require("@/app/lib/scan-worker");
 
const queueStore = require("@/app/lib/scan-queue-store");

interface CallbackArgs {
  repository: string;
  sha: string;
  ref?: string | null;
  pullRequestNumber?: number | null;
  host?: string;
  scanResult: unknown;

}

async function dispatchCallback(args: CallbackArgs): Promise<void> {
  if (args.host === "github") {
    await sendGithubCallback({
      repository: args.repository,
      sha: args.sha,
      ref: args.ref ?? null,
      pullRequestNumber: args.pullRequestNumber ?? null,
      scanResult: args.scanResult as object,

    });
  } else {
    await sendGluecronCallback({
      repository: args.repository,
      sha: args.sha,
      ref: args.ref ?? undefined,
      scanResult: args.scanResult as { error?: string; totalIssues?: number; status?: string } | null,
    });
  }
}

export async function POST(req: NextRequest) {
  try {
    const cronHeader = req.headers.get("x-vercel-cron-secret");
    const isAdmin = isAdminRequest(req);

    const authed = scanWorker.isAuthorisedTick({
      cronHeader,
      isAdmin,
      env: process.env,
    });
    if (!authed) {
      return NextResponse.json({ error: "unauthorised" }, { status: 401 });
    }

    let sql;
    try {
      sql = getDb();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "db not configured";
      return NextResponse.json({ error: msg }, { status: 503 });
    }

    const result = await scanWorker.runWorkerTick({
      sql,
      queueStore,
      runScan,
      sendCallback: (args: CallbackArgs) => dispatchCallback(args),
    });

    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "worker tick crashed";
    console.error("[scan-worker/tick] crashed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 200 });
  }
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    endpoint: "/api/scan/worker/tick",
    method: "POST",
    triggers: ["vercel-cron", "inline-kick-from-events-push", "admin"],
    callback: { github: "commit-status + pr-comment", gluecron: "signal-bus-hook" },
  });
}
