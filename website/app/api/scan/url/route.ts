/**
 * Website URL Scan API — scans a live deployed URL without source code.
 *
 * POST /api/scan/url
 * Body: { url: string }
 *
 * Free scan — no GitHub account, no payment required.
 * Designed for non-technical users who just have a website URL.
 *
 * Returns: WebScanResult with plain-English findings + score 0-100.
 */

import { NextRequest, NextResponse } from "next/server";
import { scanWebsite } from "@/app/lib/website-scanner";

export const maxDuration = 30;

export async function POST(req: NextRequest) {
  let url: string;
  try {
    const body = (await req.json()) as { url?: unknown };
    if (!body.url || typeof body.url !== "string") {
      return NextResponse.json({ error: "url is required" }, { status: 400 });
    }
    url = body.url.trim();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!url) {
    return NextResponse.json({ error: "url must not be empty" }, { status: 400 });
  }

  // Basic sanity — must be an http(s) URL or a bare domain
  if (
    !/^https?:\/\//i.test(url) &&
    !/^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z]{2,})+/.test(url)
  ) {
    return NextResponse.json(
      { error: "Please enter a website URL like https://example.com" },
      { status: 400 }
    );
  }

  try {
    const result = await scanWebsite(url);
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Scan failed";
    return NextResponse.json(
      { error: `Could not scan ${url}: ${msg}` },
      { status: 500 }
    );
  }
}
