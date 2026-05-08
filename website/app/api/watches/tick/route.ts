/**
 * Watchdog Tick — runs every N minutes via Vercel Cron.
 *
 * GET /api/watches/tick
 *
 * Finds watches due for their next check, runs a scan, logs the result,
 * and (if auto_fix_enabled) attempts a heal. This is the engine that
 * makes GateTest continuously self-healing for every registered target.
 */

import { NextRequest, NextResponse } from "next/server";
import { getDb } from "../../../lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface WatchRow {
  id: number;
  owner_login: string;
  target_type: string;
  target: string;
  interval_minutes: number;
  enabled: boolean;
  last_checked_at: string | null;
  last_status: string | null;
  last_issue_count: number | null;
  auto_fix_enabled: boolean;
}

// Simple auth — Vercel Cron sets a specific header, or allow manual trigger with admin cookie
function authorizedTick(req: NextRequest): boolean {
  const vercelCronSecret = process.env.CRON_SECRET || "";
  const authHeader = req.headers.get("authorization") || "";
  // Vercel Cron sends "Bearer <CRON_SECRET>"
  if (vercelCronSecret && authHeader === `Bearer ${vercelCronSecret}`) return true;
  // Also allow the request if it comes from vercel cron signature
  if (req.headers.get("x-vercel-cron") === "1") return true;
  // Dev mode fallback
  if (process.env.NODE_ENV !== "production") return true;
  return false;
}

async function scanServer(target: string, baseUrl: string): Promise<ScanResult | null> {
  try {
    const res = await fetch(`${baseUrl}/api/scan/server`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: target }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const issueCount = Number(data.totalIssues || 0);
    return {
      totalIssues: issueCount,
      status: issueCount === 0 ? "healthy" : issueCount > 5 ? "down" : "degraded",
    };
  } catch {
    return null;
  }
}

interface ScanResult {
  totalIssues: number;
  status: string;
  modules?: Array<{ name: string; status: string; details?: string[] }>;
  findingsByModule?: Record<string, string[]>;
}

async function scanRepo(target: string, baseUrl: string): Promise<ScanResult | null> {
  try {
    const repoUrl = `https://github.com/${target}`;
    const res = await fetch(`${baseUrl}/api/scan/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // full tier so we get enough detail to generate meaningful fixes
      body: JSON.stringify({ repoUrl, tier: "full" }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      totalIssues: Number(data.totalIssues || 0),
      status: data.totalIssues === 0 ? "healthy" : "degraded",
      modules: data.modules || [],
      findingsByModule: data.findingsByModule || {},
    };
  } catch {
    return null;
  }
}

// Extract fixable {file, issue, module} triples from scan results.
// Uses unredacted findingsByModule when available — modules[].details has file
// paths stripped for non-fix tiers to prevent copy-paste bypass.
function extractFixableIssues(
  modules: Array<{ name: string; status: string; details?: string[] }>,
  findingsByModule?: Record<string, string[]>
): Array<{ file: string; issue: string; module: string }> {
  const issues: Array<{ file: string; issue: string; module: string }> = [];

  if (findingsByModule && Object.keys(findingsByModule).length > 0) {
    const failedModuleNames = new Set(modules.filter((m) => m.status === "failed").map((m) => m.name));
    for (const [moduleName, details] of Object.entries(findingsByModule)) {
      if (!failedModuleNames.has(moduleName)) continue;
      for (const d of details) {
        const withLine = d.match(/^([\w./\-@+]+?\.[\w]{1,8})(?::\d+)?(?:\s*[-—:]\s*|\s+)(.+)$/);
        if (withLine) { issues.push({ file: withLine[1], issue: withLine[2], module: moduleName }); continue; }
        const fileOnly = d.match(/^([\w./\-@+]+?\.[\w]{1,8})\s*[:—-]\s*(.+)$/);
        if (fileOnly) { issues.push({ file: fileOnly[1], issue: fileOnly[2], module: moduleName }); }
      }
    }
    return issues;
  }

  // Fallback to modules[].details (may be redacted)
  for (const mod of modules) {
    if (mod.status !== "failed") continue;
    for (const d of mod.details || []) {
      const withLine = d.match(/^([\w./\-@+]+?\.[\w]{1,8})(?::\d+)?(?:\s*[-—:]\s*|\s+)(.+)$/);
      if (withLine) { issues.push({ file: withLine[1], issue: withLine[2], module: mod.name }); continue; }
      const fileOnly = d.match(/^([\w./\-@+]+?\.[\w]{1,8})\s*[:—-]\s*(.+)$/);
      if (fileOnly) { issues.push({ file: fileOnly[1], issue: fileOnly[2], module: mod.name }); }
    }
  }
  return issues;
}

export async function GET(req: NextRequest) {
  if (!authorizedTick(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let sql;
  try { sql = getDb(); } catch {
    return NextResponse.json({ error: "Database not configured" }, { status: 503 });
  }

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "https://gatetest.ai";

  // Find watches that are due for a check
  const due = (await sql`
    SELECT id, owner_login, target_type, target, interval_minutes, enabled,
           last_checked_at, last_status, last_issue_count, auto_fix_enabled
    FROM watches
    WHERE enabled = TRUE
      AND (
        last_checked_at IS NULL
        OR last_checked_at < NOW() - (interval_minutes || ' minutes')::INTERVAL
      )
    ORDER BY last_checked_at ASC NULLS FIRST
    LIMIT 10
  `) as unknown as WatchRow[];

  const results: Array<{ id: number; target: string; outcome: string }> = [];

  for (const watch of due) {
    const scanFn = watch.target_type === "server" ? scanServer : scanRepo;
    const scanStart = Date.now();
    const result = await scanFn(watch.target, baseUrl);

    if (!result) {
      await sql`
        INSERT INTO heal_history (watch_id, action, status, details, completed_at)
        VALUES (${watch.id}, 'scan', 'failed', ${JSON.stringify({ reason: "scan API error" })}, NOW())
      `;
      await sql`
        UPDATE watches SET last_checked_at = NOW(), last_status = 'down', updated_at = NOW()
        WHERE id = ${watch.id}
      `;
      results.push({ id: watch.id, target: watch.target, outcome: "scan-failed" });
      continue;
    }

    await sql`
      INSERT INTO heal_history (watch_id, action, status, before_issue_count, after_issue_count, details, completed_at)
      VALUES (${watch.id}, 'scan', 'success', ${watch.last_issue_count || 0}, ${result.totalIssues},
              ${JSON.stringify({ durationMs: Date.now() - scanStart, status: result.status })}, NOW())
    `;

    // Trigger auto-fix for repos if issues found and auto-fix is enabled
    if (watch.auto_fix_enabled && watch.target_type === "repo" && result.totalIssues > 0 && result.modules) {
      try {
        const fixableIssues = extractFixableIssues(result.modules, result.findingsByModule);
        if (fixableIssues.length > 0) {
          const fixRes = await fetch(`${baseUrl}/api/scan/fix`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              repoUrl: `https://github.com/${watch.target}`,
              issues: fixableIssues,
              tier: "full",
            }),
          });
          const fixData = await fixRes.json();
          const prUrl = fixData.prUrl || null;
          await sql`
            INSERT INTO heal_history (watch_id, action, status, pr_url, details, completed_at)
            VALUES (${watch.id}, 'auto_fix_pr', ${prUrl ? "success" : "failed"}, ${prUrl},
                    ${JSON.stringify({ issuesFixed: fixData.issuesFixed || 0, issuesFound: fixableIssues.length })}, NOW())
          `;
        }
      } catch {
        // Non-fatal — scan result is still stored
      }
    }

    await sql`
      UPDATE watches
      SET last_checked_at = NOW(),
          last_status = ${result.status},
          last_issue_count = ${result.totalIssues},
          updated_at = NOW()
      WHERE id = ${watch.id}
    `;

    results.push({ id: watch.id, target: watch.target, outcome: result.status });
  }

  return NextResponse.json({
    checked: due.length,
    results,
    timestamp: new Date().toISOString(),
  });
}
