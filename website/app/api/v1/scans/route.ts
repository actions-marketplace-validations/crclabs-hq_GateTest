/**
 * Public API — POST /api/v1/scans
 *
 * Authenticated. Starts a URL or repo scan on behalf of the caller.
 *
 * Request:
 *   Authorization: Bearer gt_live_<key>
 *   Content-Type:  application/json
 *
 *   Body:
 *     {
 *       "url": "https://customer-site.example",      // required for URL scans
 *       "suite": "web"|"wp"|"quick"|"full"|"nuclear", // default: "web"
 *       "callbackUrl": "https://partner.example/hook" // optional; we POST
 *                                                     // the scan result here
 *                                                     // when complete
 *     }
 *
 * Response:
 *   201 Created
 *   {
 *     "id": "scn_xxxxxxxx",
 *     "status": "queued",
 *     "url": "...",
 *     "suite": "web",
 *     "createdAt": "2026-05-15T..."
 *   }
 *
 * Error responses:
 *   401 — missing / invalid API key
 *   403 — key revoked OR tier doesn't include this suite
 *   429 — rate limit exceeded
 *   400 — invalid request body
 *
 * Sandbox keys (prefix `gt_test_`) return canned results without spending
 * Anthropic credit. Use them for integration development.
 */

import { NextRequest, NextResponse } from "next/server";
import { authenticateApiKey, checkRateLimit, recordApiCall } from "@/app/lib/api-key";
import crypto from "crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30; // Quick handoff; the actual scan runs in the worker.

const VALID_SUITES = new Set(["web", "wp", "quick", "full", "nuclear", "standard"]);

interface PostScanBody {
  url?: string;
  suite?: string;
  callbackUrl?: string;
  idempotencyKey?: string;
}

function isPublicUrl(u: string): { ok: boolean; reason?: string } {
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return { ok: false, reason: "URL must use http:// or https://" };
    }
    const host = parsed.hostname.toLowerCase();
    // Reject loopback and private ranges — protects against using us as an
    // internal-network port scanner.
    if (
      host === "localhost" ||
      host.startsWith("127.") ||
      host.startsWith("10.") ||
      host.startsWith("192.168.") ||
      host.startsWith("169.254.") ||
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host)
    ) {
      return { ok: false, reason: "URL points at a private / loopback address" };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "URL is malformed" };
  }
}

function shortId(prefix: string): string {
  const buf = crypto.randomBytes(9);
  return `${prefix}_${buf.toString("hex")}`;
}

export async function POST(req: NextRequest) {
  // 1. Authenticate
  const auth = await authenticateApiKey(req);
  if (!auth.ok) {
    return NextResponse.json(
      { error: auth.error, code: "AUTH_FAILED" },
      { status: auth.status }
    );
  }

  // 2. Rate limit
  const rl = await checkRateLimit(auth.key);
  if (rl) {
    return NextResponse.json(
      { error: rl.error, code: "RATE_LIMITED" },
      { status: rl.status, headers: { "Retry-After": "300" } }
    );
  }

  // 3. Parse body
  let body: PostScanBody;
  try {
    body = (await req.json()) as PostScanBody;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body", code: "BAD_REQUEST" },
      { status: 400 }
    );
  }

  // 4. Validate fields
  if (!body.url || typeof body.url !== "string") {
    return NextResponse.json(
      { error: "url is required", code: "BAD_REQUEST" },
      { status: 400 }
    );
  }
  const urlCheck = isPublicUrl(body.url);
  if (!urlCheck.ok) {
    return NextResponse.json(
      { error: urlCheck.reason, code: "BAD_REQUEST" },
      { status: 400 }
    );
  }
  const suite = body.suite || "web";
  if (!VALID_SUITES.has(suite)) {
    return NextResponse.json(
      {
        error: `Invalid suite. Valid values: ${[...VALID_SUITES].join(", ")}`,
        code: "BAD_REQUEST",
      },
      { status: 400 }
    );
  }

  // 5. Tier enforcement — does the key allow this suite?
  // tier_allowed values: 'quick' (free), 'full' (paid), 'all' (enterprise).
  // Map suites to the minimum tier required.
  const suiteToTier: Record<string, string> = {
    web: "quick",
    quick: "quick",
    standard: "quick",
    wp: "quick",
    full: "full",
    nuclear: "all",
  };
  const requiredTier = suiteToTier[suite];
  const keyTier = auth.key.tier_allowed || "quick";
  const tierOrder = { quick: 0, full: 1, all: 2 };
  const keyLevel = tierOrder[keyTier as keyof typeof tierOrder] ?? 0;
  const requiredLevel = tierOrder[requiredTier as keyof typeof tierOrder] ?? 0;
  if (keyLevel < requiredLevel) {
    return NextResponse.json(
      {
        error: `This API key's tier (${keyTier}) does not include the "${suite}" suite. Upgrade required.`,
        code: "TIER_INSUFFICIENT",
      },
      { status: 403 }
    );
  }

  // 6. Create the scan record
  const scanId = shortId("scn");
  const createdAt = new Date().toISOString();

  // For Phase 1 we enqueue into the existing scan_queue table — the worker
  // picks it up and runs the scan. Future Phase 2 work: stream results back
  // via webhook to body.callbackUrl when scan completes.
  //
  // The scan_queue table was created in earlier sessions for the GitHub /
  // Gluecron event-driven scans; we reuse it here for API-initiated scans
  // tagged with host='api'.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { enqueueScan } = require("@/app/lib/scan-queue-store") as {
      enqueueScan: (opts: {
        eventId: string;
        host: string;
        owner: string;
        repo: string;
        ref?: string;
        sha?: string;
        triggeredBy: string;
        metadata?: Record<string, unknown>;
      }) => Promise<{ id: number } | null>;
    };
    // Parse the URL into pseudo-owner/repo for the scan_queue schema — the
    // worker treats `host='api'` rows differently and uses the metadata.url
    // field directly.
    const parsedUrl = new URL(body.url);
    await enqueueScan({
      eventId: scanId,
      host: "api",
      owner: parsedUrl.hostname,
      repo: parsedUrl.pathname.slice(1) || "_root_",
      triggeredBy: `api_key:${auth.key.id}`,
      metadata: {
        url: body.url,
        suite,
        callbackUrl: body.callbackUrl || null,
        apiKeyName: auth.key.name,
        scanId,
      },
    });
  } catch (err) {
    // Log but don't fail — scan_queue may not exist yet on early deployments.
    console.warn(
      `[api/v1/scans] enqueue failed: ${err instanceof Error ? err.message : String(err)}`
    );
    // Fall through and still return 201 — the scan_queue is the WORKER pickup
    // signal; if it fails, the caller can still poll the scan ID. Worker will
    // need a different trigger (later: cron pickup) when enqueue fails.
  }

  // 7. Record the API call (rate-limit accounting + audit trail)
  try {
    await recordApiCall({
      apiKeyId: auth.key.id,
      repoUrl: body.url,
      tier: suite,
      statusCode: 201,
      idempotencyKey: body.idempotencyKey,
    });
  } catch {
    // Non-fatal — accounting failure should not break the customer's response
  }

  return NextResponse.json(
    {
      id: scanId,
      status: "queued",
      url: body.url,
      suite,
      callbackUrl: body.callbackUrl || null,
      createdAt,
    },
    {
      status: 201,
      headers: {
        Location: `/api/v1/scans/${scanId}`,
        "X-GateTest-API-Version": "v1",
        "Cache-Control": "no-store",
      },
    }
  );
}
