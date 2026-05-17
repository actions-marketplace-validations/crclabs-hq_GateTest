/**
 * Self-scan history endpoint.
 *
 * GET — returns the last N (default 30) self-scan results, most-recent-
 * first. Used by a future trend chart on `/how-it-works`. Reads from
 * the same in-memory store as `/api/internal/self-scan-status`.
 *
 * No POST handler — history is appended as a side effect of POSTs to
 * the status endpoint. That keeps the wire surface area tight and
 * means there's only one place where signed publishes are accepted.
 *
 * See `website/app/lib/self-scan-status.js` for the storage strategy.
 */

import { NextResponse } from "next/server";

const selfScanStatus = require("@/app/lib/self-scan-status");

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const history = selfScanStatus.getHistory();
  return NextResponse.json(
    {
      count: history.length,
      limit: selfScanStatus.HISTORY_LIMIT,
      history,
    },
    {
      status: 200,
      headers: { "Cache-Control": "no-store, must-revalidate" },
    },
  );
}
