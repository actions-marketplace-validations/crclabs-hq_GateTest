/**
 * POST /api/scan/preview
 *
 * Free, no-auth, deliberately limited preview scan. Runs the three fastest
 * modules (syntax / lint / secrets) against a public repo and returns the
 * top 5 findings. Designed to be invoked by Claude (or any MCP client) on
 * behalf of a user inside a chat — the result feeds the upgrade pitch:
 *
 *   "Found 47 errors. Here's a sample of 5. Want me to fix all 47?
 *    That's $199. Tap to confirm with Apple/Google Pay."
 *
 * RELIABILITY CONTRACT:
 *   - Hard 12s deadline (Vercel-safe even on cold start).
 *   - Per-IP rate limit (1 preview per 10 seconds, in-memory best-effort
 *     since serverless doesn't share state — cold starts effectively reset
 *     the counter; that's an acceptable abuse-vs-reliability trade).
 *   - Hosted infra-only: never executes code, never reads private repos
 *     (uses the same Gluecron-or-GitHub-token auth as /api/scan/run).
 *   - Always returns 200 with { ok, findings, total } on success OR
 *     { ok: false, error, hint } on any failure — never 500-with-stacktrace.
 *
 * NO PAYMENT. No login. Designed to make every Claude invocation cheap
 * enough to be a marketing channel.
 */

import { NextRequest, NextResponse } from "next/server";
import { runTier, type RepoFile } from "@/app/lib/scan-modules";
import {
  fetchTree,
  fetchBlob,
  resolveRepoAuth,
} from "@/app/lib/gluecron-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

const HARD_DEADLINE_MS = 12_000;
const MAX_FILES_TO_READ = 60;
const TOP_FINDINGS = 5;

// Best-effort per-IP throttle. Map is reset on every cold start so this is
// not a hard limit — it's a "don't accidentally hammer Anthropic / Gluecron
// from one tab" guard. Real abuse protection comes from Vercel's edge layer.
const PREVIEW_RATE_LIMIT_MS = 10_000;
const recentPreviews = new Map<string, number>();

function tooSoon(ip: string): boolean {
  const now = Date.now();
  const last = recentPreviews.get(ip) || 0;
  if (now - last < PREVIEW_RATE_LIMIT_MS) return true;
  recentPreviews.set(ip, now);
  // Cap map size — drop the oldest entries periodically.
  if (recentPreviews.size > 5000) {
    const entries = [...recentPreviews.entries()].sort((a, b) => a[1] - b[1]);
    for (const [k] of entries.slice(0, 1000)) recentPreviews.delete(k);
  }
  return false;
}

interface PreviewFinding {
  module: string;
  severity: "error" | "warning" | "info";
  file: string | null;
  line: number | null;
  message: string;
}

function classifySeverity(raw: string): PreviewFinding["severity"] {
  if (typeof raw !== "string") return "warning";
  if (/^(error|err|critical|high)\b[:]/i.test(raw)) return "error";
  if (/^(warning|warn|medium)\b[:]/i.test(raw)) return "warning";
  if (/^(info|note|low|summary)\b[:]/i.test(raw)) return "info";
  if (/\b(error|fail|vulnerab|exploit|injection|secret|credential|api[_\- ]?key|hardcoded)\b/i.test(raw))
    return "error";
  return "warning";
}

function parseDetail(raw: string, moduleName: string): PreviewFinding {
  const safeRaw = typeof raw === "string" ? raw : String(raw ?? "");
  let rest = safeRaw
    .replace(/^(?:\[[^\]]+\]\s*|(?:error|warn(?:ing)?|info|note|summary)\s*:\s*)/i, "")
    .trim();
  let file: string | null = null;
  let line: number | null = null;
  const m = rest.match(
    /^([A-Za-z0-9_./\-@+]+?\.[A-Za-z0-9]{1,8}):(\d+)(?::\d+)?(?:\s*[-—:]\s*|\s+)(.+)$/
  );
  if (m) {
    file = m[1];
    line = Number(m[2]);
    rest = m[3];
  }
  return {
    module: moduleName,
    severity: classifySeverity(safeRaw),
    file,
    line,
    message: rest.trim(),
  };
}

export async function POST(req: NextRequest) {
  // Per-IP throttle — best effort.
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown";
  if (tooSoon(ip)) {
    return NextResponse.json(
      {
        ok: false,
        error: "rate limit — wait 10 seconds between previews",
        hint: "Free preview is throttled to 1 request per 10s per IP. Upgrade to Quick ($29) to remove the limit.",
      },
      { status: 429 }
    );
  }

  let input: { repoUrl?: string };
  try {
    input = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid JSON body", hint: "POST { repoUrl: 'https://github.com/owner/repo' }" },
      { status: 400 }
    );
  }

  const repoUrl = (input?.repoUrl || "").trim();
  if (!repoUrl) {
    return NextResponse.json(
      { ok: false, error: "repoUrl is required", hint: "Provide a public GitHub or Gluecron repo URL" },
      { status: 400 }
    );
  }

  const gluecronMatch = repoUrl.match(/gluecron\.com\/([^/]+)\/([^/?#]+)/);
  const githubMatch = repoUrl.match(/github\.com\/([^/]+)\/([^/?#]+)/);
  const repoMatch = gluecronMatch || githubMatch;
  if (!repoMatch) {
    return NextResponse.json(
      { ok: false, error: "expected a github.com or gluecron.com URL", hint: "e.g. https://github.com/vercel/next.js" },
      { status: 400 }
    );
  }
  const owner = repoMatch[1];
  const repo = repoMatch[2].replace(/\.git$/, "");

  const startTime = Date.now();
  const deadline = startTime + HARD_DEADLINE_MS;

  let auth;
  try {
    auth = await resolveRepoAuth(owner, repo);
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: "could not authenticate repo access",
        hint: err instanceof Error ? err.message : "auth provider unreachable",
      },
      { status: 503 }
    );
  }
  const token = auth.token || undefined;
  if (!token) {
    return NextResponse.json(
      {
        ok: false,
        error: `cannot access ${owner}/${repo}`,
        hint: auth.error || "Repo may be private or unreachable. Free preview only works on public repos.",
      },
      { status: 403 }
    );
  }

  let files: string[] = [];
  try {
    files = await fetchTree(owner, repo, "HEAD", token);
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: "could not read repo file tree",
        hint: err instanceof Error ? err.message : "tree fetch failed",
      },
      { status: 502 }
    );
  }
  if (files.length === 0) {
    return NextResponse.json(
      {
        ok: false,
        error: `${owner}/${repo} appears to be empty or unreachable`,
        hint: "Confirm the URL is correct and the repo is public.",
      },
      { status: 404 }
    );
  }

  const sourceExts = [".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".java", ".rb", ".md", ".json", ".yml", ".yaml"];
  const sourceFiles = files.filter(
    (f) =>
      sourceExts.some((ext) => f.endsWith(ext)) &&
      !f.includes("node_modules") &&
      !f.includes(".next") &&
      !f.includes("dist/")
  );

  if (Date.now() > deadline) {
    return NextResponse.json({
      ok: false,
      error: "preview timed out fetching file tree",
      hint: "Try again — large repos sometimes need a warm cache. Or upgrade to Quick ($29) which has a longer budget.",
    });
  }

  const fileContents: RepoFile[] = [];
  const readPromises = sourceFiles.slice(0, MAX_FILES_TO_READ).map(async (filePath): Promise<RepoFile | null> => {
    try {
      const content = await fetchBlob(owner, repo, filePath, "HEAD", token);
      return content ? { path: filePath, content } : null;
    } catch {
      return null;
    }
  });
  const readResults = await Promise.all(readPromises);
  for (const r of readResults) if (r) fileContents.push(r);

  if (Date.now() > deadline) {
    return NextResponse.json({
      ok: false,
      error: "preview timed out reading files",
      hint: "Try again with a smaller repo, or upgrade to Quick ($29) for the full scan.",
    });
  }

  let scanResult;
  try {
    scanResult = await runTier("quick", {
      owner,
      repo,
      files,
      fileContents,
      token,
      deadlineMs: deadline,
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: "scan engine error",
        hint: err instanceof Error ? err.message : "unknown",
      },
      { status: 500 }
    );
  }

  const findings: PreviewFinding[] = [];
  for (const m of scanResult.modules) {
    if (!m.details || m.details.length === 0) continue;
    for (const d of m.details) findings.push(parseDetail(d, m.name));
  }

  // Sort: errors first, then warnings, then info; within each, file/line.
  const severityRank = { error: 0, warning: 1, info: 2 } as const;
  findings.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);
  const top = findings.slice(0, TOP_FINDINGS);

  return NextResponse.json({
    ok: true,
    repo: `${owner}/${repo}`,
    durationMs: Date.now() - startTime,
    moduleSummary: scanResult.modules.map((m) => ({
      module: m.name,
      status: m.status,
      issues: m.issues || 0,
    })),
    findings: top,
    total: scanResult.totalIssues,
    truncated: findings.length > TOP_FINDINGS,
    nextStep: {
      tier: "quick",
      price: "$29",
      message:
        findings.length > TOP_FINDINGS
          ? `Showing top ${TOP_FINDINGS} of ${scanResult.totalIssues}. Upgrade to Quick ($29) to see them all + tighter scan limits.`
          : "Upgrade to Full ($99) to scan all 90 modules + auto-fix.",
      checkoutHint: `POST /api/checkout { tier, repoUrl } to start checkout`,
    },
  });
}

export async function GET() {
  return NextResponse.json({
    description: "Free preview scan endpoint. POST with { repoUrl } to use.",
    rateLimit: `1 per ${PREVIEW_RATE_LIMIT_MS / 1000}s per IP`,
    deadline: `${HARD_DEADLINE_MS / 1000}s hard timeout`,
    modulesRun: ["syntax", "lint", "secrets", "codeQuality"],
    tier: "free",
    upgradePath: ["quick ($29)", "full ($99)", "scan_fix ($199)", "nuclear ($399)"],
  });
}
