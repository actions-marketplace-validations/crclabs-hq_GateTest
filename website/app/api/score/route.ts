/**
 * GateTest Score API
 *
 * GET /api/score?owner=acme&repo=payments-api
 * Returns the public GateTest score for a repo based on scan history.
 *
 * Score: 0-100 derived from:
 *   - Error findings (−5 each, up to −50)
 *   - Warning findings (−1 each, up to −20)
 *   - Modules that passed cleanly (+1 each)
 *   - Fix delivery (scan_fix / nuclear tier) → +10 bonus
 *   - Recent scan (within 7 days) → no penalty; older → −5/week
 *
 * Badge SVG also available: /api/score?owner=X&repo=Y&format=badge
 */

import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";

function computeScore(scan: {
  errors: number;
  warnings: number;
  modulesPassed: number;
  totalModules: number;
  tier: string;
  scannedAt: string;
}): number {
  let score = 100;

  // Deduct for errors (−5 each, cap −50)
  score -= Math.min(50, scan.errors * 5);
  // Deduct for warnings (−1 each, cap −20)
  score -= Math.min(20, scan.warnings * 1);

  // Bonus for passing modules
  if (scan.totalModules > 0) {
    const passRate = scan.modulesPassed / scan.totalModules;
    score += Math.round(passRate * 10);
  }

  // Fix tier bonus
  if (scan.tier === 'scan_fix' || scan.tier === 'nuclear') {
    score += 5;
  }

  // Staleness penalty
  const daysSince = (Date.now() - new Date(scan.scannedAt).getTime()) / 86400000;
  if (daysSince > 7) score -= Math.floor((daysSince - 7) / 7) * 5;

  return Math.max(0, Math.min(100, Math.round(score)));
}

function scoreGrade(score: number): { grade: string; label: string; color: string } {
  if (score >= 90) return { grade: 'A', label: 'Excellent', color: '#10b981' };
  if (score >= 75) return { grade: 'B', label: 'Good', color: '#3b82f6' };
  if (score >= 60) return { grade: 'C', label: 'Fair', color: '#f59e0b' };
  if (score >= 40) return { grade: 'D', label: 'Poor', color: '#f97316' };
  return { grade: 'F', label: 'Critical', color: '#ef4444' };
}

function buildBadgeSvg(owner: string, repo: string, score: number, grade: string, color: string): string {
  const label = `${owner}/${repo}`;
  const value = `GateTest ${grade} (${score}/100)`;
  const labelW = label.length * 6 + 10;
  const valueW = value.length * 6.5 + 10;
  const totalW = labelW + valueW;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="20">
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r"><rect width="${totalW}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelW}" height="20" fill="#555"/>
    <rect x="${labelW}" width="${valueW}" height="20" fill="${color}"/>
    <rect width="${totalW}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="11">
    <text x="${labelW / 2}" y="15" fill="#010101" fill-opacity=".3">${label}</text>
    <text x="${labelW / 2}" y="14">${label}</text>
    <text x="${labelW + valueW / 2}" y="15" fill="#010101" fill-opacity=".3">${value}</text>
    <text x="${labelW + valueW / 2}" y="14">${value}</text>
  </g>
</svg>`;
}

async function getLatestScan(owner: string, repo: string) {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) return null;

  try {
    const sql = neon(dbUrl);
    const repoName = `${owner}/${repo}`;

    const rows = await sql`
      SELECT
        errors_fixed AS errors,
        warnings_fixed AS warnings,
        tier,
        created_at AS "scannedAt",
        array_length(modules_fired, 1) AS modules_passed
      FROM fixes_log
      WHERE repo_name = ${repoName}
      ORDER BY created_at DESC
      LIMIT 1
    `;

    if (rows.length === 0) return null;
    const r = rows[0] as { errors: number; warnings: number; tier: string; scannedAt: string; modules_passed: number };
    return {
      errors: Number(r.errors) || 0,
      warnings: Number(r.warnings) || 0,
      modulesPassed: Number(r.modules_passed) || 0,
      totalModules: 90,
      tier: r.tier,
      scannedAt: r.scannedAt,
    };
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const owner = (searchParams.get("owner") || "").replace(/[^a-zA-Z0-9_.-]/g, "");
  const repo = (searchParams.get("repo") || "").replace(/[^a-zA-Z0-9_.-]/g, "");
  const format = searchParams.get("format") || "json";

  if (!owner || !repo) {
    return NextResponse.json({ error: "owner and repo are required" }, { status: 400 });
  }

  const scan = await getLatestScan(owner, repo);

  if (!scan) {
    if (format === "badge") {
      const svg = buildBadgeSvg(owner, repo, 0, "?", "#6b7280");
      return new NextResponse(svg, { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "no-cache" } });
    }
    return NextResponse.json({ owner, repo, score: null, grade: null, message: "No scans found for this repo" });
  }

  const score = computeScore(scan);
  const { grade, label, color } = scoreGrade(score);
  const ageDays = Math.round((Date.now() - new Date(scan.scannedAt).getTime()) / 86400000);

  if (format === "badge") {
    const svg = buildBadgeSvg(owner, repo, score, grade, color);
    return new NextResponse(svg, {
      headers: {
        "Content-Type": "image/svg+xml",
        "Cache-Control": "public, max-age=3600",
      },
    });
  }

  return NextResponse.json({
    owner,
    repo,
    score,
    grade,
    label,
    color,
    lastScan: {
      tier: scan.tier,
      scannedAt: scan.scannedAt,
      ageDays,
      errors: scan.errors,
      warnings: scan.warnings,
    },
    badge: `https://gatetest.ai/api/score?owner=${owner}&repo=${repo}&format=badge`,
    readme: `[![GateTest Score](https://gatetest.ai/api/score?owner=${owner}&repo=${repo}&format=badge)](https://gatetest.ai/score/${owner}/${repo})`,
  });
}
