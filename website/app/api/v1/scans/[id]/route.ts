/**
 * Public API — GET /api/v1/scans/:id
 *
 * Returns the current status + (when complete) findings of a scan.
 *
 * Auth: Bearer API key.
 * Tier check: the key must own the scan (api_key_id stored on enqueue).
 *
 * Response shapes by status:
 *
 *   queued / running:
 *     {
 *       id, status: "queued"|"running", url, suite, createdAt,
 *       progress?: { modulesCompleted, modulesTotal }
 *     }
 *
 *   completed:
 *     {
 *       id, status: "completed", url, suite, createdAt, completedAt,
 *       healthScore?: 73,             // (Phase 2 — not wired yet)
 *       summary: { errors, warnings, info, modulesRun, durationMs },
 *       findings: [
 *         { module, severity, title, body, file?, line? },
 *         ...
 *       ]
 *     }
 *
 *   failed:
 *     { id, status: "failed", url, suite, createdAt, error: "..." }
 *
 * 404 if the scan ID doesn't exist or belongs to a different API key.
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateApiKey, recordApiCall } from "@/app/lib/api-key";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const auth = await authenticateApiKey(req);
  if (!auth.ok) {
    return NextResponse.json(
      { error: auth.error, code: "AUTH_FAILED" },
      { status: auth.status }
    );
  }

  const { id } = await ctx.params;
  if (!id || !id.startsWith("scn_")) {
    return NextResponse.json(
      { error: "Invalid scan ID format", code: "BAD_REQUEST" },
      { status: 400 }
    );
  }

  // Look up scan in the scan_queue table. The triggeredBy field carries
  // "api_key:<id>" so we can confirm ownership.
  let row: Record<string, unknown> | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getScanByEventId } = require("@/app/lib/scan-queue-store") as {
      getScanByEventId: (eventId: string) => Promise<Record<string, unknown> | null>;
    };
    row = await getScanByEventId(id);
  } catch (err) {
    console.warn(
      `[api/v1/scans/:id] lookup failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!row) {
    return NextResponse.json(
      { error: "Scan not found", code: "NOT_FOUND" },
      { status: 404 }
    );
  }

  const triggeredBy = String(row.triggered_by || row.triggeredBy || "");
  if (!triggeredBy.endsWith(`:${auth.key.id}`)) {
    // The scan exists but wasn't created by this API key. We hide existence
    // (return 404 not 403) to avoid leaking scan IDs across customers.
    return NextResponse.json(
      { error: "Scan not found", code: "NOT_FOUND" },
      { status: 404 }
    );
  }

  // Map internal status to public API status
  const internalStatus = String(row.status || "queued").toLowerCase();
  const statusMap: Record<string, string> = {
    pending: "queued",
    queued: "queued",
    running: "running",
    in_progress: "running",
    completed: "completed",
    succeeded: "completed",
    failed: "failed",
    error: "failed",
  };
  const publicStatus = statusMap[internalStatus] || "queued";

  const metadata = (row.metadata || {}) as Record<string, unknown>;
  const result = (row.result || {}) as Record<string, unknown>;

  const response: Record<string, unknown> = {
    id,
    status: publicStatus,
    url: metadata.url,
    suite: metadata.suite || "web",
    callbackUrl: metadata.callbackUrl || null,
    createdAt: row.created_at,
  };

  if (publicStatus === "completed") {
    response.completedAt = row.updated_at || row.completed_at;
    response.summary = result.summary || null;
    response.findings = Array.isArray(result.findings) ? result.findings : [];
    if (typeof result.healthScore === "number") {
      response.healthScore = result.healthScore;
    }
  } else if (publicStatus === "failed") {
    response.error = result.error || row.error_message || "Scan failed";
  }

  // Record the API call for rate-limit accounting
  try {
    await recordApiCall({
      apiKeyId: auth.key.id,
      repoUrl: metadata.url as string | undefined,
      tier: metadata.suite as string | undefined,
      statusCode: 200,
    });
  } catch {
    /* non-fatal */
  }

  return NextResponse.json(response, {
    status: 200,
    headers: {
      "X-GateTest-API-Version": "v1",
      "Cache-Control": publicStatus === "completed" ? "private, max-age=60" : "no-store",
    },
  });
}
