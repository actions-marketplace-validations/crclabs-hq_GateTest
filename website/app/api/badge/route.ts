/**
 * Badge API — Generates SVG shield badges for README files.
 *
 * GET /api/badge?status=passing       → green "GateTest | passing" badge
 * GET /api/badge?status=failing       → red "GateTest | failing" badge
 * GET /api/badge?status=scanning      → yellow "GateTest | scanning" badge
 * GET /api/badge?modules=102          → "GateTest | 102 modules" badge
 * GET /api/badge                      → default "GateTest | quality gate" badge
 *
 * Returns SVG with Cache-Control headers for CDN caching.
 */

import { NextRequest, NextResponse } from "next/server";

const COLORS: Record<string, string> = {
  passing: "#22c55e",
  failing: "#ef4444",
  scanning: "#eab308",
  blocked: "#ef4444",
  default: "#10b981",
};

function generateBadge(label: string, message: string, color: string): string {
  const labelWidth = label.length * 6.8 + 12;
  const messageWidth = message.length * 6.8 + 12;
  const totalWidth = labelWidth + messageWidth;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="20" role="img" aria-label="${label}: ${message}">
  <title>${label}: ${message}</title>
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r">
    <rect width="${totalWidth}" height="20" rx="3" fill="#fff"/>
  </clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelWidth}" height="20" fill="#555"/>
    <rect x="${labelWidth}" width="${messageWidth}" height="20" fill="${color}"/>
    <rect width="${totalWidth}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="11">
    <text aria-hidden="true" x="${labelWidth / 2}" y="15" fill="#010101" fill-opacity=".3">${label}</text>
    <text x="${labelWidth / 2}" y="14">${label}</text>
    <text aria-hidden="true" x="${labelWidth + messageWidth / 2}" y="15" fill="#010101" fill-opacity=".3">${message}</text>
    <text x="${labelWidth + messageWidth / 2}" y="14">${message}</text>
  </g>
</svg>`;
}

export async function GET(req: NextRequest) {
  const status = req.nextUrl.searchParams.get("status");
  const modules = req.nextUrl.searchParams.get("modules");
  const label = req.nextUrl.searchParams.get("label") || "GateTest";

  let message: string;
  let color: string;

  if (status) {
    message = status;
    color = COLORS[status] || COLORS.default;
  } else if (modules) {
    message = `${modules} modules`;
    color = COLORS.default;
  } else {
    message = "quality gate";
    color = COLORS.default;
  }

  const svg = generateBadge(label, message, color);

  return new NextResponse(svg, {
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control": "public, max-age=300, s-maxage=300",
    },
  });
}
