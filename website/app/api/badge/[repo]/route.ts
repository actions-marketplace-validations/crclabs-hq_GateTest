/**
 * Quality Badge API — embeddable SVG badge for README files.
 *
 * GET /api/badge?repo=owner/name
 * GET /api/badge?repo=owner/name&style=flat
 *
 * Returns an SVG badge showing the latest scan grade (A+ to F).
 * Designed to be embedded in GitHub READMEs:
 *   ![GateTest](https://gatetest.ai/api/badge?repo=crclabs-hq/GateTest)
 *
 * Uses the scan database to look up the latest completed scan for the repo.
 * If no scan exists, returns a "not scanned" badge.
 */

import { NextRequest, NextResponse } from "next/server";
import { getDb } from "../../../lib/db";

export const dynamic = "force-dynamic";

interface GradeInfo {
  letter: string;
  color: string;
  bgColor: string;
}

function scoreToGrade(score: number): GradeInfo {
  if (score >= 95) return { letter: "A+", color: "#fff", bgColor: "#059669" };
  if (score >= 90) return { letter: "A", color: "#fff", bgColor: "#059669" };
  if (score >= 85) return { letter: "A-", color: "#fff", bgColor: "#10b981" };
  if (score >= 80) return { letter: "B+", color: "#fff", bgColor: "#0d9488" };
  if (score >= 75) return { letter: "B", color: "#fff", bgColor: "#0891b2" };
  if (score >= 70) return { letter: "B-", color: "#fff", bgColor: "#2563eb" };
  if (score >= 65) return { letter: "C+", color: "#fff", bgColor: "#7c3aed" };
  if (score >= 60) return { letter: "C", color: "#fff", bgColor: "#9333ea" };
  if (score >= 55) return { letter: "C-", color: "#fff", bgColor: "#c026d3" };
  if (score >= 50) return { letter: "D+", color: "#fff", bgColor: "#d97706" };
  if (score >= 40) return { letter: "D", color: "#fff", bgColor: "#ea580c" };
  if (score >= 30) return { letter: "D-", color: "#fff", bgColor: "#dc2626" };
  return { letter: "F", color: "#fff", bgColor: "#991b1b" };
}

function renderBadge(label: string, value: string, valueColor: string, valueBg: string): string {
  const labelWidth = label.length * 6.8 + 12;
  const valueWidth = value.length * 7.5 + 14;
  const totalWidth = labelWidth + valueWidth;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="20" role="img" aria-label="${label}: ${value}">
  <title>${label}: ${value}</title>
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r"><rect width="${totalWidth}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelWidth}" height="20" fill="#555"/>
    <rect x="${labelWidth}" width="${valueWidth}" height="20" fill="${valueBg}"/>
    <rect width="${totalWidth}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="11">
    <text aria-hidden="true" x="${labelWidth / 2}" y="15" fill="#010101" fill-opacity=".3">${label}</text>
    <text x="${labelWidth / 2}" y="14" fill="#fff">${label}</text>
    <text aria-hidden="true" x="${labelWidth + valueWidth / 2}" y="15" fill="#010101" fill-opacity=".3">${value}</text>
    <text x="${labelWidth + valueWidth / 2}" y="14" fill="${valueColor}">${value}</text>
  </g>
</svg>`;
}

export async function GET(req: NextRequest) {
  const repo = req.nextUrl.searchParams.get("repo") || "";

  if (!repo) {
    const svg = renderBadge("GateTest", "no repo", "#fff", "#999");
    return new NextResponse(svg, {
      headers: {
        "Content-Type": "image/svg+xml",
        "Cache-Control": "no-cache, no-store, must-revalidate",
      },
    });
  }

  let score: number | null = null;
  try {
    const sql = getDb();
    const rows = await sql`
      SELECT score FROM scans
      WHERE repo_url LIKE ${"%" + repo}
        AND status = 'completed'
        AND score IS NOT NULL
      ORDER BY created_at DESC
      LIMIT 1
    `;
    if (rows.length > 0) {
      score = rows[0].score as number;
    }
  } catch {
    // DB not available — show "not scanned"
  }

  let svg: string;
  if (score !== null) {
    const grade = scoreToGrade(score);
    svg = renderBadge("GateTest", `${grade.letter} (${score})`, grade.color, grade.bgColor);
  } else {
    svg = renderBadge("GateTest", "not scanned", "#fff", "#999");
  }

  return new NextResponse(svg, {
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control": "public, max-age=300, s-maxage=300",
    },
  });
}
