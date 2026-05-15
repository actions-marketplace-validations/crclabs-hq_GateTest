/**
 * Public API — Health endpoint.
 *
 * GET /api/v1/health
 *
 * Unauthenticated. Returns the API version + uptime so integrators can
 * confirm the platform is reachable before they start exchanging tokens.
 *
 * Contract: this endpoint MUST stay stable. Partners use it for liveness
 * probes; breaking the response shape would break their monitoring.
 *
 * Response shape (locked):
 *   {
 *     status:    "ok",
 *     version:   "v1",
 *     timestamp: ISO-8601 string,
 *   }
 */

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(
    {
      status: "ok",
      version: "v1",
      timestamp: new Date().toISOString(),
    },
    {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        "X-GateTest-API-Version": "v1",
      },
    }
  );
}
