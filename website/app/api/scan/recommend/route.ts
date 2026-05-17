/**
 * Pre-scan suite recommender.
 *
 * Customer pastes a URL. Before they pay or click Scan, this endpoint
 * probes the URL once, classifies the stack, and returns a "we
 * recommend X scan / Y tier because Z" suggestion. UI surfaces it so
 * customers don't have to know which scan is right.
 *
 * Single HTTP GET to the customer's URL. Same private-network blocklist
 * as the scan endpoints. No customer data persisted.
 */

import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 15;

interface RecommendRequest { url?: string }

function parseUrl(input: string): URL | null {
  if (!input || typeof input !== "string") return null;
  let raw = input.trim();
  if (!raw) return null;
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  try {
    const u = new URL(raw);
    if (
      u.hostname === "localhost" ||
      u.hostname.startsWith("127.") ||
      u.hostname.startsWith("10.") ||
      u.hostname.startsWith("192.168.") ||
      u.hostname.startsWith("169.254.") ||
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(u.hostname)
    ) return null;
    return u;
  } catch { return null; }
}

export async function POST(req: NextRequest) {
  let body: RecommendRequest;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = parseUrl(body.url || "");
  if (!parsed) {
    return NextResponse.json({
      error: "Please paste a valid public URL. Localhost and internal addresses are blocked.",
    }, { status: 400 });
  }
  const targetUrl = `${parsed.protocol}//${parsed.host}`;

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { detectStackForUrl } = require("@/app/lib/url-stack-detector") as {
    detectStackForUrl: (u: string) => Promise<
      | { ok: true; profile: Record<string, unknown>; probe: { status: number; responseMs: number; finalUrl: string; redirected: boolean } }
      | { ok: false; error: string }
    >;
  };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { recommendForProfile } = require("@/app/lib/suite-recommender") as {
    recommendForProfile: (opts: { profile: Record<string, unknown> }) => {
      suite: 'web' | 'wp';
      tier: 'quick' | 'full' | 'scan_fix' | 'nuclear';
      emphasis: string[];
      reasoning: string[];
      ctaUrl: string;
      suiteDescription: string;
      tierDescription: string;
      priceUsd: number;
    };
  };

  const detection = await detectStackForUrl(targetUrl);
  if (!detection.ok) {
    return NextResponse.json({
      targetUrl,
      detected: null,
      recommendation: {
        // Safe fallback when we can't probe (e.g. Cloudflare blocked us)
        suite: "web",
        tier: "quick",
        emphasis: ["webHeaders", "tlsSecurity"],
        reasoning: ["Couldn't probe the URL — recommending the generic web Quick scan as a safe starting point."],
        ctaUrl: "/api/checkout?tier=quick",
        suiteDescription: "Generic web suite",
        tierDescription: "Top issues, free preview, fast feedback",
        priceUsd: 29,
      },
      error: detection.error,
    }, { status: 200 });
  }

  const recommendation = recommendForProfile({ profile: detection.profile });

  return NextResponse.json({
    targetUrl,
    detected: detection.profile,
    probe: detection.probe,
    recommendation,
  }, { status: 200 });
}

export async function GET() {
  return NextResponse.json(
    { hint: "POST { url: 'https://yoursite.com' } to get a pre-scan recommendation." },
    { status: 405 }
  );
}
