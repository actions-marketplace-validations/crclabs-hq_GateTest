/**
 * Live self-scan status endpoint.
 *
 * POST — accept the latest self-scan result from CI (HMAC-signed).
 * GET  — return the latest result for the badge component / public.
 *
 * The CI self-scan job in `.github/workflows/ci.yml` POSTs here after
 * running `node bin/gatetest.js --suite quick --json`. The badge
 * component at `website/app/components/SelfScanBadge.tsx` GETs.
 *
 * See `website/app/lib/self-scan-status.js` for the wire contract,
 * payload validation, and the in-memory storage strategy note.
 */

import { NextRequest, NextResponse } from "next/server";

// CommonJS interop — helper is .js with require-style exports so it
// stays unit-testable via node:test from /tests.
const selfScanStatus = require("@/app/lib/self-scan-status");

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    return NextResponse.json(
      { error: "malformed: cannot read body" },
      { status: 400 },
    );
  }

  const signatureHeader = req.headers.get("x-internal-signature");

  const result = selfScanStatus.processPublishStatus({
    rawBody,
    signatureHeader,
    env: process.env,
  });

  return NextResponse.json(result.body, { status: result.status });
}

export async function GET(): Promise<NextResponse> {
  const payload = selfScanStatus.getLatestStatus();
  return NextResponse.json(payload, {
    status: 200,
    // The badge polls every 60s; CDN caching would lie about freshness.
    headers: { "Cache-Control": "no-store, must-revalidate" },
  });
}
