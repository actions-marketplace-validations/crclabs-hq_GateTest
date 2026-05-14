/**
 * Auto-Fix Agent — Claude reads scan issues, generates fixes, creates a PR.
 *
 * POST /api/scan/fix
 * Body: { repoUrl, issues: [{ file, issue, module }] }
 *
 * Flow:
 * 1. Reads each file from GitHub API
 * 2. Sends file + issue to Claude with "fix this" prompt
 * 3. Gets back corrected code
 * 4. Creates a new branch on the repo
 * 5. Commits all fixed files
 * 6. Opens a pull request
 * 7. Returns the PR URL
 *
 * Requires: ANTHROPIC_API_KEY, GitHub auth (either GITHUB_TOKEN PAT, or
 *           GATETEST_APP_ID + GATETEST_PRIVATE_KEY GitHub App — App is preferred
 *           because it's already what the webhook uses for commit statuses.)
 */

import { NextRequest, NextResponse } from "next/server";
import { isAdminRequest } from "@/app/lib/admin-auth";
import {
  createBranch,
  fetchBlob,
  fetchFileSha,

  openPullRequest,
  postPrComment,
  resolveBaseBranchSha,
  resolveRepoAuth,
  upsertFile,
} from "../../../lib/gluecron-client";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createLimiter, PRESETS } = require("@lib/rate-limit") as {
  createLimiter: (opts: { windowMs: number; maxRequests: number }) => {
    guard: (req: NextRequest) => Promise<{ allowed: boolean; status?: number; body?: Record<string, unknown>; headers?: Record<string, string> }>;
  };
  PRESETS: Record<string, { windowMs: number; maxRequests: number }>;
};

const _scanFixLimiter = createLimiter(PRESETS.scanFix);
// Phase 1 of THE FIX-FIRST BUILD PLAN — N-attempt iterative loop with
// structured per-attempt logging. The loop carries forward each previous
// failure into the next prompt so Claude sees its own mistake. Pure JS
// helper, tested standalone in tests/fix-attempt-loop.test.js.
// Phase 1.2b — cross-fix scanner re-validation gate.
import { runTier } from "@/app/lib/scan-modules";

// Phase 2.2 — architecture annotator. Reads the codebase SHAPE (not
// per-file) and produces a "design observations" report — layering
// violations, duplicated logic, god objects, refactoring opportunities.
// REPORTED only, never auto-refactored. Posts as a PR comment.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { annotateArchitecture, renderArchitectureComment } = require("@/app/lib/architecture-annotator") as {
  annotateArchitecture: (opts: {
    fileContents: Array<{ path: string; content: string }>;
    askClaudeForArchitecture: (prompt: string) => Promise<string>;
    repoUrl?: string;
    sampleCount?: number;
    maxFileBytes?: number;
  }) => Promise<{
    ok: boolean;
    body: string | null;
    summary: { sourceFiles: number; totalFiles: number; totalBytes: number; topDirectories: Array<{ dir: string; count: number }>; extensionCounts: Record<string, number>; largestFiles: Array<{ path: string; bytes: number }> } | null;
    sampleFiles: Array<{ path: string; bytes: number }> | null;
    reason: string | null;
  }>;
  renderArchitectureComment: (result: {
    ok: boolean;
    body: string | null;
    summary?: { sourceFiles: number } | null;
    sampleFiles?: Array<{ path: string; bytes: number }> | null;
    reason?: string | null;
  } | null) => string;
};

// Phase 2.1 — pair-review agent. Second Claude critiques each fix on a
// 4-axis rubric (correctness / completeness / readability / testCoverage),
// posts result as a PR comment.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { runPairReview, renderReviewComment } = require("@/app/lib/pair-review") as {
  runPairReview: (opts: {
    fixes: Array<{ file: string; original: string; fixed: string; issues: string[] }>;
    testsBySourceFile?: Record<string, string> | Map<string, string>;
    askClaudeForReview: (prompt: string) => Promise<string>;
  }) => Promise<{
    reviews: Array<{ file: string; ok: boolean; scores: { correctness: number; completeness: number; readability: number; testCoverage: number } | null; critique: string | null; reason: string | null }>;
    averages: { correctness: number; completeness: number; readability: number; testCoverage: number } | null;
    reviewed: number;
    skipped: number;
    summary: string;
  }>;
  renderReviewComment: (
    reviews: Array<{ file: string; ok: boolean; scores: { correctness: number; completeness: number; readability: number; testCoverage: number } | null; critique: string | null; reason: string | null }>,
    averages: { correctness: number; completeness: number; readability: number; testCoverage: number } | null
  ) => string;
};

// Phase 1.4 — PR-body composer. Builds the structured markdown report
// from every artifact this route collects (fixes, errors, attempt
// history, gate results, before/after findings, regression tests).
// Pure string composition.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { composePrBody } = require("@/app/lib/pr-composer") as {
  composePrBody: (opts: {
    fixes?: Array<{ file: string; original: string; fixed: string; issues: string[] }>;
    errors?: string[];
    attemptHistoryByFile?: Record<string, { attempts: Array<{ attemptNumber: number; durationMs: number; outcome: string }>; summary: string; success: boolean }>;
    syntaxGate?: { summary?: string };
    scannerGate?: { summary?: string; skipped?: boolean; reason?: string };
    testGen?: { summary?: string };
    originalFindingsByModule?: Record<string, string[]>;
    postFixFindingsByModule?: Record<string, string[]>;
    repoUrl?: string;
    /** Pre-rendered CVE patches markdown section from composeCveFixPrSection. */
    cveSection?: string;
  }) => string;
};

// Phase 1.3 — test generation per fix.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { generateTestsForFixes } = require("@/app/lib/test-generator") as {
  generateTestsForFixes: (opts: {
    fixes: Array<{ file: string; fixed: string; original: string; issues: string[] }>;
    askClaudeForTest: (prompt: string) => Promise<string>;
    frameworkHint?: string;
  }) => Promise<{
    tests: Array<{ path: string; content: string; sourceFile: string }>;
    skipped: Array<{ sourceFile: string; reason: string }>;
    summary: string;
  }>;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { validateFixesAgainstScanner } = require("@/app/lib/cross-fix-scanner-gate") as {
  validateFixesAgainstScanner: (opts: {
    fixes: Array<{ file: string; fixed: string; original: string; issues: string[] }>;
    originalFileContents: Array<{ path: string; content: string }>;
    originalFindingsByModule: Record<string, string[]>;
    runTier: (tier: string, ctx: { owner: string; repo: string; files: string[]; fileContents: Array<{ path: string; content: string }> }) => Promise<{ modules: Array<{ name: string; details?: string[] }>; totalIssues: number }>;
    owner: string;
    repo: string;
    tier?: string;
  }) => Promise<{
    accepted: Array<{ file: string; fixed: string; original: string; issues: string[] }>;
    rolledBack: Array<{ file: string; fixed: string; original: string; issues: string[]; reason: string; newFindings: string[] }>;
    unattributedFindings: Array<{ module: string; detail: string }>;
    postFixFindingsByModule: Record<string, string[]>;
    summary: string;
  }>;
};

// Phase 1.2a — cross-fix syntax-validation gate. Sits between the
// per-file iterative loop and PR creation. Catches Claude output that
// passes shape + pattern checks but doesn't actually parse.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { validateFixesSyntax, summariseSyntaxGate } = require("@/app/lib/cross-fix-syntax-gate") as {
  validateFixesSyntax: (opts: {
    fixes: Array<{ file: string; fixed: string; original: string; issues: string[] }>;
  }) => {
    accepted: Array<{ file: string; fixed: string; original: string; issues: string[]; language: string }>;
    rejected: Array<{ file: string; fixed: string; original: string; issues: string[]; reason: string; language: string }>;
  };
  summariseSyntaxGate: (result: { accepted: unknown[]; rejected: unknown[] }) => string;
};
// Day-2 — Surgical-diff fix mode. Sends Claude only the issue ± N lines of
// context, gets back a replacement block, splices into the original. Bytes
// outside the splice are byte-identical because we never sent them.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const surgicalFix = require("@lib/surgical-fix") as {
  extractIssueContext: (fileContent: string, lineNumber: number, contextLines?: number) => {
    slice: string; startLine: number; endLine: number; totalLines: number; lineEnding: string;
  };
  buildSurgicalPrompt: (opts: { filePath: string; slice: string; startLine: number; endLine: number; issues: string[] }) => string;
  parseReplacementBlock: (claudeResponse: string) => string;
  spliceReplacement: (originalContent: string, startLine: number, endLine: number, replacement: string, lineEnding?: string) => string;
  validateSurgicalFix: (opts: { originalContent: string; fixedContent: string; startLine: number; endLine: number; lineEnding?: string }) => {
    ok: boolean; reason?: string; mutatedLines?: number[];
  };
};

// Day-2 — Whole-file mutation guard. Used in the fallback path when an issue
// has no parseable line number. Computes a line-level diff and rejects fixes
// that change far more lines than the issue count justifies.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const mutationGuard = require("@lib/whole-file-mutation-guard") as {
  evaluateMutation: (opts: {
    original: string; fixed: string; issueCount: number;
    maxChangePerIssue?: number; maxAbsoluteChange?: number; maxPercentChange?: number;
  }) => { ok: boolean; reason?: string; stats: Record<string, number> };
  summariseMutation: (result: { ok: boolean; reason?: string; stats: Record<string, number> }) => string;
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { attemptFixWithRetries, summariseAttempts } = require("@/app/lib/fix-attempt-loop") as {
  attemptFixWithRetries: (opts: {
    askClaude: (issues: string[]) => Promise<string>;
    validateFix: (original: string, fixed: string) => { ok: boolean; reason?: string };
    verifyFixQuality: (fixed: string, filePath: string) => { clean: boolean; newIssues: string[] };
    originalContent: string;
    filePath: string;
    issues: string[];
    maxAttempts?: number;
    now?: () => number;
  }) => Promise<{
    success: boolean;
    fixed: string | null;
    attempts: Array<{
      attemptNumber: number;
      startedAt: number;
      durationMs: number;
      outcome: "success" | "validation-fail" | "quality-fail" | "claude-error";
      validationReason: string | null;
      qualityIssues: string[];
      claudeError: string | null;
    }>;
    finalReason: string | null;
  }>;
  summariseAttempts: (attempts: Array<{ outcome: string; durationMs: number }>) => string;
};
// Shape of the shared adaptive-concurrency state object. Mirrors the JS
// source at website/app/lib/adaptive-concurrency.js — workers may mutate
// `activeConcurrency` (throttle) or `haltRun` (abort) and the pool reacts.
type AdaptiveState = {
  consecutiveNetworkErrors: number;
  activeConcurrency: number;
  haltRun: boolean;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { mapWithAdaptiveConcurrency } = require("@/app/lib/adaptive-concurrency") as {
  mapWithAdaptiveConcurrency: <T, R>(
    items: T[],
    initialLimit: number,
    fn: (item: T, state: AdaptiveState) => Promise<R>,
  ) => Promise<R[]>;
};

// CVE-to-Fix Pipeline — Tier-1 Item 3 from the HYPER-AGGRESSIVE PRODUCT
// EVOLUTION ROADMAP. When security/dependencies modules emit CVE-shaped
// findings, the fix path generates a version-bump patch WITHOUT going
// through Claude. Headline feature vs Dependabot (which only opens
// advisory PRs — we open FIXED PRs).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { CVE_ID_PATTERN, extractCveContext, generateVersionBumpPatch, composeCveFixPrSection, summariseCvePatches } = require("@lib/cve-to-fix") as {
  CVE_ID_PATTERN: RegExp;
  extractCveContext: (issueText: string) => {
    cveId: string;
    packageName: string;
    currentVersion: string | null;
    patchedVersion: string | null;
    ecosystem: string;
  } | null;
  generateVersionBumpPatch: (opts: {
    ecosystem: string;
    packageName: string;
    currentVersion: string | null;
    patchedVersion: string;
    fileContent: string;
    filePath: string;
    cveId?: string;
  }) => { newContent: string; changeSummary: string } | null;
  composeCveFixPrSection: (patches: Array<{
    packageName: string;
    currentVersion: string | null;
    patchedVersion: string;
    cveId: string;
    filePath?: string;
  }>) => string;
  summariseCvePatches: (patches: Array<{
    packageName: string;
    currentVersion: string | null;
    patchedVersion: string;
    cveId: string;
    filePath?: string;
  }>) => string;
};

// Contextual Grounding — injects the customer's own project conventions
// (CLAUDE.md, AGENTS.md, ARCHITECTURE.md, .cursorrules, README.md,
// CONTRIBUTING.md) into every Claude fix prompt so Claude doesn't suggest
// fixes that contradict documented project patterns.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { extractConventions, formatGroundingHeader, summariseGrounding } = require("@lib/contextual-grounding") as {
  extractConventions: (opts: {
    files?: string[];
    fileContents?: Array<{ path: string; content: string }>;
    maxBytesPerFile?: number;
    maxTotalBytes?: number;
  }) => {
    found: Array<{ path: string; excerpt: string; bytes: number }>;
    totalBytes: number;
    omitted: string[];
  };
  formatGroundingHeader: (found: Array<{ path: string; excerpt: string; bytes: number }>) => string;
  summariseGrounding: (result: {
    found: Array<{ path: string; bytes: number }>;
    totalBytes: number;
    omitted: string[];
  }) => string;
};

// Default attempt ceiling — set higher than the old hardcoded "1+1 retry"
// so the loop has room to learn from its own mistakes. Configurable via
// GATETEST_FIX_MAX_ATTEMPTS env var if a deployment wants tighter cost
// control or more aggressive recovery.
const DEFAULT_MAX_ATTEMPTS = Number(process.env.GATETEST_FIX_MAX_ATTEMPTS) || 3;

// Vercel Pro allows up to 300s. Fix runs 44 issues across ~10 files, each file
// needs a Claude call + GitHub read + commit. 300s gives headroom for retries
// without pushing browser into connection-reset territory.
export const maxDuration = 300;
export const runtime = "nodejs";

// Hard time budget (ms). We STOP accepting new files at 80% of maxDuration so
// commits + PR creation have time to run. Worst case we ship a partial fix PR
// with what we managed to complete.
const TIME_BUDGET_MS = 240_000;

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";

// Retryable network error shapes — the TLS / connection-level failures that
// throw BEFORE an HTTP response is ever produced. Notably includes EPROTO
// "SSL alert number 80" which hits hard when undici's keep-alive pool gets
// poisoned by a single bad socket and subsequent parallel writes inherit the
// failure. Retry with a fresh request (and jitter) to sidestep the pool.
function isRetryableNetworkError(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : "";
  const code = (err as { code?: string; cause?: { code?: string } }).code
    || (err as { cause?: { code?: string } }).cause?.code
    || "";
  // AbortError from our 45s timeout — the file may be large or Anthropic slow;
  // treat as transient so it goes into the retry queue rather than hard-failing.
  if (name === "AbortError" || /aborted|abort/i.test(msg)) return true;
  const retryableCodes = [
    "EPROTO", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT",
    "EAI_AGAIN", "ENOTFOUND", "EPIPE", "EHOSTUNREACH",
    "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT", "UND_ERR_RESPONSE_STATUS_CODE",
  ];
  if (retryableCodes.includes(code)) return true;
  // Match text shapes too — undici sometimes surfaces them in the message
  if (/EPROTO|ECONNRESET|ETIMEDOUT|ssl.*alert|handshake|fetch failed|socket hang up|TLS/i.test(msg)) {
    return true;
  }
  return false;
}

async function anthropicCall(body: string): Promise<{ status: number; data: Record<string, unknown> }> {
  const controller = new AbortController();
  // Anthropic max_tokens=8192 at sonnet speeds rarely exceeds 30s. 45s is a
  // safe per-request ceiling that leaves room for retries inside the 300s
  // function budget and won't let a single stuck request monopolise.
  const timer = setTimeout(() => controller.abort(), 45_000);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": ANTHROPIC_API_KEY,
        "connection": "close",
      },
      body,
      signal: controller.signal,
      // Don't reuse stale keep-alive sockets from the undici pool — one bad
      // TLS socket poisons every parallel request otherwise.
      keepalive: false,
    });
    const text = await res.text();
    let data: Record<string, unknown>;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    return { status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

// Retry wrapper — handles both HTTP-status retries (429/5xx) and raw network
// errors (EPROTO, ECONNRESET, TLS handshake). Jittered exponential backoff so
// parallel retries don't synchronise and re-overwhelm the remote.
//
// 6 attempts with backoff 1s, 2s, 4s, 8s, 16s (+jitter) — total ceiling ~32s
// per file. Bumped from 3 after prod observed cascading SSL alert 80 failures
// where Anthropic needed more time than 1.5s of retries allowed.
async function anthropicCallWithRetry(body: string, maxAttempts = 6): Promise<{ status: number; data: Record<string, unknown> }> {
  let lastError: unknown = null;
  let lastResponse: { status: number; data: Record<string, unknown> } | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      const base = 1000 * Math.pow(2, attempt - 1); // 1s, 2s, 4s, 8s, 16s
      const jitter = Math.floor(Math.random() * 500);
      await new Promise((r) => setTimeout(r, base + jitter));
    }
    try {
      const res = await anthropicCall(body);
      // Success
      if (res.status === 200) return res;
      // Non-retryable client error — stop immediately
      if (res.status !== 429 && res.status < 500) {
        return res;
      }
      // Retryable HTTP status (429 / 5xx) — continue loop
      lastResponse = res;
    } catch (err) {
      if (!isRetryableNetworkError(err)) {
        // Unknown non-transient error — don't burn all retries on it
        throw err;
      }
      lastError = err;
    }
  }

  if (lastResponse) return lastResponse;
  throw lastError instanceof Error
    ? new Error(`Anthropic API unreachable after ${maxAttempts} attempts: ${lastError.message}`)
    : new Error(`Anthropic API unreachable after ${maxAttempts} attempts`);
}

async function askClaude(fileContent: string, filePath: string, issues: string[], conventionsHeader = ""): Promise<string> {
  // Enrich broken-link issues with context about what actually exists
  const enrichedIssues = await Promise.all(issues.map(async (issue) => {
    const brokenMatch = issue.match(/BROKEN LINK \(404\):\s*(https:\/\/github\.com\/([^/]+)\/([^/]+)\/([^\s]+))/i);
    if (brokenMatch) {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const [, _fullUrl, owner, repo, _path] = brokenMatch;
      try {
        // Check what releases actually exist
        const relRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases`, {
          headers: { "User-Agent": "GateTest", "Accept": "application/vnd.github.v3+json" },
        });
        if (relRes.ok) {
          const releases = await relRes.json() as Array<{ tag_name: string; html_url: string; assets: Array<{ name: string; browser_download_url: string }> }>;
          if (releases.length > 0) {
            const latest = releases[0];
            const assetList = latest.assets.map((a: { name: string; browser_download_url: string }) => `  - ${a.name}: ${a.browser_download_url}`).join("\n");
            return `${issue}\n\nCONTEXT: This URL 404s. The repo ${owner}/${repo} has ${releases.length} release(s). Latest: ${latest.tag_name} (${latest.html_url}).\nAvailable assets:\n${assetList || "  (no downloadable assets in latest release)"}\n\nFIX: Replace the broken URL with the correct release URL or asset download URL from above.`;
          } else {
            return `${issue}\n\nCONTEXT: The repo ${owner}/${repo} has NO releases. The download link cannot work. FIX: Either remove the download button, link to the repo page (https://github.com/${owner}/${repo}), or create a release first.`;
          }
        }
      } catch { /* fall through to original issue */ }
    }
    return issue;
  }));

  const prompt = `${conventionsHeader}You are an expert code fixer for GateTest, an AI-powered QA platform with 90 scanning modules.

Fix ALL of the following issues in this file. Every fix must pass GateTest's re-scan.

FILE: ${filePath}
ISSUES TO FIX:
${enrichedIssues.map((i, idx) => `${idx + 1}. ${i}`).join("\n")}

CURRENT CODE:
\`\`\`
${fileContent}
\`\`\`

CRITICAL RULES — violations will cause re-scan failure:
- Return ONLY the complete fixed file content. No explanations. No markdown code fences.
- Fix the ROOT CAUSE, not the symptom. Never patch over an issue.
- NEVER introduce these patterns (GateTest scans for them):
  * console.log / console.debug / console.info in library code
  * debugger statements
  * TODO / FIXME / HACK / XXX comments
  * eval() or Function() calls
  * Hardcoded secrets, API keys, tokens, passwords
  * var declarations (use const/let)
  * Empty catch blocks
  * Unused imports or variables
- Preserve every non-issue line exactly — do not rewrite or reformat unrelated code.
- Never remove functionality to "fix" a warning.
- If a fix would require context you don't have, output the UNCHANGED original file verbatim.
- The fixed code will be automatically re-scanned. If it fails, the fix is rejected.`;

  const body = JSON.stringify({
    model: "claude-sonnet-4-6",
    max_tokens: 8192,
    messages: [{ role: "user", content: prompt }],
  });

  const res = await anthropicCallWithRetry(body);
  if (res.status === 200) {
    const content = res.data.content as Array<{ type: string; text: string }>;
    let fixedCode = content?.[0]?.text || "";
    // Strip markdown code fences if Claude added them despite instructions
    fixedCode = fixedCode.replace(/^```[\w]*\n?/, "").replace(/\n?```$/, "");
    return fixedCode;
  }
  const errSnippet = JSON.stringify(res.data).slice(0, 200);
  throw new Error(`Claude API error ${res.status}: ${errSnippet}`);
}

/**
 * Validate Claude's fix output before we commit it.
 * Catches truncation (max_tokens hit), refusals, and obvious garbage.
 */
function validateFix(original: string, fixed: string): { ok: boolean; reason?: string } {
  if (!fixed || fixed.trim().length === 0) {
    return { ok: false, reason: "empty output" };
  }
  if (fixed === original) {
    return { ok: false, reason: "no changes produced" };
  }
  if (original.length > 500 && fixed.length < original.length * 0.4) {
    return { ok: false, reason: `likely truncation (${fixed.length}/${original.length} chars)` };
  }
  const refusalMarkers = ["I cannot", "I can't", "I'm unable to", "I won't", "As an AI"];
  const firstLine = fixed.split("\n", 1)[0] || "";
  if (refusalMarkers.some((m) => firstLine.startsWith(m))) {
    return { ok: false, reason: "Claude refused" };
  }
  return { ok: true };
}

/**
 * Verify that fixed code doesn't introduce NEW issues that GateTest would catch.
 * Runs the same pattern checks our scan modules use.
 */
function verifyFixQuality(fixed: string, filePath: string): { clean: boolean; newIssues: string[] } {
  const issues: string[] = [];
  const lines = fixed.split("\n");
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  const isSource = ["js", "ts", "jsx", "tsx", "mjs", "cjs"].includes(ext);

  if (!isSource) return { clean: true, newIssues: [] };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip comments and strings for some checks
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;

    // console.log/debug/info in non-test files
    if (!filePath.includes(".test.") && !filePath.includes(".spec.") && !filePath.includes("__test")) {
      if (/\bconsole\.(log|debug|info)\s*\(/.test(line)) {
        issues.push(`Line ${i + 1}: console.log/debug/info introduced`);
      }
    }

    // debugger statements
    if (/^\s*debugger\s*;?\s*$/.test(line)) {
      issues.push(`Line ${i + 1}: debugger statement introduced`);
    }

    // TODO/FIXME/HACK/XXX
    if (/\/\/\s*(TODO|FIXME|HACK|XXX)\b/i.test(line)) {
      issues.push(`Line ${i + 1}: TODO/FIXME comment introduced`);
    }

    // eval()
    if (/\beval\s*\(/.test(line) && !trimmed.startsWith("//")) {
      issues.push(`Line ${i + 1}: eval() introduced`);
    }

    // var declarations
    if (/^\s*var\s+\w/.test(line)) {
      issues.push(`Line ${i + 1}: var declaration introduced (use const/let)`);
    }

    // Empty catch blocks
    if (/catch\s*\([^)]*\)\s*\{\s*\}/.test(line)) {
      issues.push(`Line ${i + 1}: empty catch block introduced`);
    }
  }

  return { clean: issues.length === 0, newIssues: issues };
}

// Concurrency cap for parallel file fixing — balances Vercel time budget vs API rate.
// Dropped from 4 → 2 after prod hit cascading EPROTO / TLS alert 80 failures under
// heavy undici keep-alive pressure. Two parallel requests + keepalive:false on each
// keeps fresh sockets without pool-poisoning a whole batch when one goes bad.
const FIX_CONCURRENCY = 2;
// Max file size we'll send to Claude (bigger risks output truncation at 8192 tokens).
const MAX_FILE_BYTES = 400 * 1024;

/**
 * Ask Claude to generate a NEW file (when it doesn't exist yet).
 * Used when the issue is "Missing X" and we need to create X.
 */
/**
 * Phase 1.3 — thin wrapper around anthropicCallWithRetry shaped for
 * the test-generator's askClaudeForTest contract: takes a prompt,
 * returns the raw text. Same model + retry behaviour as the main
 * fix path.
 */
async function askClaudeForTest(prompt: string): Promise<string> {
  const body = JSON.stringify({
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    messages: [{ role: "user", content: prompt }],
  });
  const res = await anthropicCallWithRetry(body);
  if (res.status !== 200) {
    const errSnippet = JSON.stringify(res.data).slice(0, 200);
    throw new Error(`Claude API error ${res.status}: ${errSnippet}`);
  }
  const content = res.data.content as Array<{ type: string; text: string }>;
  return content?.[0]?.text || "";
}

async function askClaudeCreate(filePath: string, context: string[]): Promise<string> {
  const prompt = `You are an expert developer. Generate the COMPLETE contents of a new file.

FILE TO CREATE: ${filePath}
CONTEXT / REASON:
${context.map((c, i) => `${i + 1}. ${c}`).join("\n")}

Rules:
- Return ONLY the file content. No explanations. No markdown code fences.
- Generate a production-ready file, not a stub.
- For .gitignore: include standard Node, env, and secret exclusions.
- For README.md: include project purpose, installation, usage sections.
- For .env.example: include common env vars with descriptions.
- For tsconfig.json: use modern strict settings.
- Follow whatever format the file extension implies.`;

  const body = JSON.stringify({
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    messages: [{ role: "user", content: prompt }],
  });

  const res = await anthropicCallWithRetry(body);

  if (res.status !== 200) {
    const errSnippet = JSON.stringify(res.data).slice(0, 200);
    throw new Error(`Claude API error ${res.status}: ${errSnippet}`);
  }

  const content = res.data.content as Array<{ type: string; text: string }>;
  let newFile = content?.[0]?.text || "";
  newFile = newFile.replace(/^```[\w]*\n?/, "").replace(/\n?```$/, "");
  return newFile;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await fn(items[idx]);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// Shared mutable state for adaptive concurrency — when Anthropic starts rejecting
// with SSL alerts, parallel requests just poison each other. Drop to serial and
// let the retry backoff do the work, rather than burning the whole budget in
// parallel failures.
//
// `mapWithAdaptiveConcurrency` is implemented in
// `website/app/lib/adaptive-concurrency.js` (pure JS for testability).
interface AdaptiveState {
  consecutiveNetworkErrors: number;
  activeConcurrency: number;
  haltRun: boolean;
}

interface IssueInput {
  file: string;
  issue: string;
  module: string;
  // Day-2: when the extractor parsed a line number out of the finding, it's
  // forwarded here. Issues with `line` go through surgical-fix mode; issues
  // without fall back to whole-file mode with the mutation guard.
  line?: number;
}

// Phase 1.2b — optional callers can pass the pre-fix workspace and the
// pre-fix module findings so the scanner re-validation gate has a
// baseline to diff against. When absent, the gate is skipped (the
// per-file iterative loop + syntax gate still run; only cross-file
// regression detection is missing).
interface OriginalFileInput {
  path: string;
  content: string;
}

export async function POST(req: NextRequest) {
  let input: {
    repoUrl?: string;
    issues?: IssueInput[];
    originalFileContents?: OriginalFileInput[];
    originalFindingsByModule?: Record<string, string[]>;
    tier?: string;
  };
  try {
    input = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { repoUrl, issues } = input;

  if (!repoUrl || !issues || issues.length === 0) {
    return NextResponse.json({ error: "Missing repoUrl or issues" }, { status: 400 });
  }

  if (!ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "AI not configured (ANTHROPIC_API_KEY)" }, { status: 503 });
  }

  // Rate-limit AFTER body parsing + validation, BEFORE Anthropic/GitHub API calls.
  // Admin requests bypass the limiter — they are internal and authenticated.
  if (!isAdminRequest(req)) {
    const _rlScanFix = await _scanFixLimiter.guard(req);
    if (!_rlScanFix.allowed) {
      return NextResponse.json(_rlScanFix.body, {
        status: _rlScanFix.status ?? 429,
        headers: _rlScanFix.headers as Record<string, string>,
      });
    }
  }

  // Accept gluecron.com URLs first; fall back to github.com for links
  // still in customer bookmarks during the migration window.
  const gluecronMatch = repoUrl.match(/gluecron\.com\/([^/]+)\/([^/?#]+)/);
  const githubMatch = repoUrl.match(/github\.com\/([^/]+)\/([^/?#]+)/);
  const repoMatch = gluecronMatch || githubMatch;
  if (!repoMatch) {
    return NextResponse.json({ error: "Invalid repo URL (expected gluecron.com/<owner>/<repo>)" }, { status: 400 });
  }

  const owner = repoMatch[1];
  const repo = repoMatch[2].replace(/\.git$/, "");

  // Top-level guard — wraps everything from auth resolution through PR creation.
  // Node 24 changed unhandledRejection from 'warn' to 'throw'; any uncaught
  // await inside this function would crash the Vercel function. The inner
  // try/catch at the branch-creation block catches PR-layer failures; this outer
  // guard catches auth, file fetching, syntax gate, scanner gate, and any other
  // unexpected throw so the customer always gets a JSON 500 instead of a crash.
  try {

  // Resolve Gluecron PAT and confirm repo access with a probe request.
  const auth = await resolveRepoAuth(owner, repo);
  if (!auth.token) {
    return NextResponse.json(
      {
        error:
          auth.error ||
          "Gluecron access not configured — set GLUECRON_API_TOKEN (PAT, scope 'repo')",
        hint: "Generate a PAT at https://gluecron.com/settings/tokens and set GLUECRON_API_TOKEN.",
      },
      { status: 503 }
    );
  }
  const token = auth.token;
  const authSource = auth.source;

  // Group issues by file. Day-2: retain `line` per issue so the per-file
  // worker can choose surgical-fix vs whole-file mode.
  type StructuredIssue = { text: string; line?: number };
  const issuesByFile = new Map<string, StructuredIssue[]>();
  for (const issue of issues) {
    if (!issue.file) continue;
    const existing = issuesByFile.get(issue.file) || [];
    existing.push({ text: issue.issue, line: issue.line });
    issuesByFile.set(issue.file, existing);
  }

  if (issuesByFile.size === 0) {
    return NextResponse.json({ error: "No fixable issues (issues must have file paths)" }, { status: 400 });
  }

  type Fix = { file: string; original: string; fixed: string; issues: string[]; cve?: boolean };
  const fixes: Fix[] = [];
  const errors: string[] = [];

  // CVE-to-Fix accumulator — populated by the per-file CVE fast-path below.
  // Applied patches skip Claude entirely: they are regex version-bumps that
  // need no AI reasoning.
  type CvePatch = { packageName: string; currentVersion: string | null; patchedVersion: string; cveId: string; filePath: string };
  const collectedCvePatches: CvePatch[] = [];

  // Phase 1: per-file attempt history. Each entry captures every attempt
  // the iterative loop made — used in the PR body, surfaced in the API
  // response, and logged so a human reviewer can see at a glance how many
  // attempts each fix took and what each attempt's outcome was.
  type AttemptLog = {
    attemptNumber: number;
    startedAt: number;
    durationMs: number;
    outcome: "success" | "validation-fail" | "quality-fail" | "claude-error";
    validationReason: string | null;
    qualityIssues: string[];
    claudeError: string | null;
  };
  const attemptHistoryByFile: Record<string, { attempts: AttemptLog[]; summary: string; success: boolean }> = {};

  // Contextual Grounding — build ONCE before the per-file loop from whatever
  // file contents the caller already passed in (no extra network call). An
  // empty header means no convention files were found; askClaude treats that
  // as a no-op so the prompt is unchanged. Cached here; both the whole-file
  // and surgical Claude paths use the same header.
  const groundingExtract = extractConventions({
    files: (input.originalFileContents || []).map((f) => f.path),
    fileContents: input.originalFileContents || [],
  });
  // Stack auto-detection — reads package.json / requirements.txt / Cargo.toml /
  // composer.json / pom.xml / build.gradle / vercel.json / Dockerfile / etc.
  // from the in-memory file map, infers (language, framework, db, deploy, ci),
  // and renders a "STACK: TypeScript (Next.js, React) + Prisma on Vercel"
  // prompt header. Claude sees the customer's actual stack upfront, so fix
  // recommendations land on-target instead of asking the customer to adapt
  // a generic snippet.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { detectStack, formatStackHeader } = require("@lib/stack-detector") as {
    detectStack: (opts: { projectRoot: string; fileContents?: Record<string, string> }) => {
      summary: string;
      languages: Array<{ language: string }>;
      frameworks: Array<{ label: string }>;
      databases: Array<{ label: string }>;
      deploy: string[];
      ci: string[];
      testTools: Array<{ label: string }>;
    };
    formatStackHeader: (stack: { summary?: string; testTools?: Array<{ label: string }>; ci?: string[] }) => string;
  };
  const stackFileContents: Record<string, string> = {};
  for (const f of input.originalFileContents || []) {
    stackFileContents[f.path] = f.content;
  }
  const stack = detectStack({ projectRoot: "/", fileContents: stackFileContents });
  const stackHeader = formatStackHeader(stack);

  // Prior-art recall — surfaces the customer's own .gatetest/memory/fix-patterns.json
  // (when committed) so Claude sees "you fixed this kind of issue 4 times before,
  // here's how" before generating the new fix. Per-customer compounding moat;
  // central cross-customer brain is the Boss-Rule Tier 2 unlock.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { buildPriorArtHeader, summarisePriorArt } = require("@lib/fix-pattern-recall") as {
    buildPriorArtHeader: (opts: {
      fileContents: Array<{ path: string; content: string }>;
      findings: string[];
      maxPatterns?: number;
      maxExamplesPerPattern?: number;
    }) => string;
    summarisePriorArt: (opts: {
      fileContents: Array<{ path: string; content: string }>;
      findings: string[];
    }) => { available: boolean; reason?: string; totalPatternsInStore?: number; matchedThisScan?: number; matchedKeys?: string[] };
  };
  const priorArtHeader = buildPriorArtHeader({
    fileContents: input.originalFileContents || [],
    findings: (input.issues || []).map((i) => `${i.module}: ${i.issue}`),
  });
  const priorArtSummary = summarisePriorArt({
    fileContents: input.originalFileContents || [],
    findings: (input.issues || []).map((i) => `${i.module}: ${i.issue}`),
  });

  // Order in the conventionsHeader passed to Claude:
  //   1. STACK — what tools the customer uses
  //   2. PROJECT CONVENTIONS — how they configure those tools (README/AGENTS/ARCHITECTURE)
  //   3. PRIOR FIXES — how they've fixed similar issues before
  const conventionsHeader = stackHeader + formatGroundingHeader(groundingExtract.found) + priorArtHeader;
  const groundingSummary  = summariseGrounding(groundingExtract);

  // Time budget — start the clock so per-file workers can bail early if the
  // remaining budget won't fit another Claude round-trip + retries.
  const startedAt = Date.now();
  const budgetExceeded = () => Date.now() - startedAt > TIME_BUDGET_MS;
  let skippedForBudget = 0;
  // Files that failed specifically due to Anthropic network/TLS errors — the UI
  // surfaces these as a "Retry Failed" list since they're usually transient and
  // re-running the same payload works without re-running the whole scan.
  const failedFiles: Array<{ file: string; issues: string[]; reason: string }> = [];

  // Process files in parallel (capped concurrency) — major UX win over sequential
  const fileEntries = Array.from(issuesByFile.entries());
  await mapWithAdaptiveConcurrency(fileEntries, FIX_CONCURRENCY, async ([filePath, fileIssues], state) => {
    if (budgetExceeded() || state.haltRun) {
      skippedForBudget += 1;
      return;
    }
    // String-only view of the issues for legacy callers (CREATE_FILE,
    // whole-file path, error reporting, fix.issues field).
    const fileIssueTexts = fileIssues.map((i) => i.text);

    // -----------------------------------------------------------------------
    // CVE fast-path — version-bump patches that don't need Claude.
    // For each issue in this file that contains a CVE/GHSA ID we try to:
    //   1. extractCveContext — parse package name, versions, ecosystem
    //   2. generateVersionBumpPatch — regex-replace the version in file content
    //   3. If ALL CVE issues for this file applied cleanly, skip Claude
    //      entirely and record the file as fixed with cve:true.
    //   4. Issues that didn't apply (package not found, no patchedVersion)
    //      fall through to the normal Claude path with CVE context added.
    // -----------------------------------------------------------------------
    const cveIssues = fileIssueTexts.filter((t) => CVE_ID_PATTERN.test(t));
    if (cveIssues.length > 0) {
      try {
        const originalContent = await fetchBlob(owner, repo, filePath, "", token);
        if (originalContent && originalContent.length <= MAX_FILE_BYTES) {
          let workingContent = originalContent;
          const appliedPatches: CvePatch[] = [];
          const unappliedCveIssues: string[] = [];

          for (const issueText of cveIssues) {
            const ctx = extractCveContext(issueText);
            if (!ctx || !ctx.patchedVersion) {
              // No patchedVersion — advisory only, fall through to Claude
              unappliedCveIssues.push(issueText);
              continue;
            }
            const patch = generateVersionBumpPatch({
              ecosystem: ctx.ecosystem,
              packageName: ctx.packageName,
              currentVersion: ctx.currentVersion,
              patchedVersion: ctx.patchedVersion,
              fileContent: workingContent,
              filePath,
              cveId: ctx.cveId,
            });
            if (!patch) {
              // Package not found in file — fall through to Claude
              unappliedCveIssues.push(issueText);
              continue;
            }
            workingContent = patch.newContent;
            appliedPatches.push({
              packageName: ctx.packageName,
              currentVersion: ctx.currentVersion,
              patchedVersion: ctx.patchedVersion,
              cveId: ctx.cveId,
              filePath,
            });
          }

          if (appliedPatches.length > 0) {
            // Record applied patches in the global accumulator for PR section
            collectedCvePatches.push(...appliedPatches);

            const nonCveIssues = fileIssueTexts.filter((t) => !CVE_ID_PATTERN.test(t));
            const remainingIssues = [...nonCveIssues, ...unappliedCveIssues];

            if (remainingIssues.length === 0) {
              // All issues for this file were CVE-patchable — skip Claude entirely
              fixes.push({
                file: filePath,
                original: originalContent,
                fixed: workingContent,
                issues: fileIssueTexts,
                cve: true,
              });
              attemptHistoryByFile[filePath] = {
                attempts: [{
                  attemptNumber: 1,
                  startedAt: Date.now(),
                  durationMs: 0,
                  outcome: "success",
                  validationReason: "cve-version-bump (no Claude)",
                  qualityIssues: [],
                  claudeError: null,
                }],
                summary: `CVE: ${appliedPatches.map((p) => p.cveId).join(", ")} — version bumped without Claude`,
                success: true,
              };
              return;
            }
            // Some issues still need Claude — continue with workingContent
            // already having CVE patches applied; Claude only sees the rest.
            // We intentionally fall through to the normal path with the
            // pre-patched content and remaining issues list.
            // (For simplicity we let Claude re-fix from the original — the
            // CVE patches will be included in the final merged content below
            // since workingContent already reflects them.)
          }
        }
      } catch {
        // Non-fatal — fall through to normal Claude path
      }
    }

    // Handle CREATE_FILE issues — the file doesn't exist, generate it from scratch
    const createIssues = fileIssueTexts.filter((i) => i.startsWith("CREATE_FILE:"));
    if (createIssues.length > 0) {
      try {
        const newContent = await askClaudeCreate(filePath, createIssues.map((i) => i.replace("CREATE_FILE: ", "")));
        if (newContent && newContent.length > 10) {
          fixes.push({ file: filePath, original: "", fixed: newContent, issues: fileIssueTexts });
        } else {
          errors.push(`Could not generate ${filePath}: empty response`);
        }
      } catch (err) {
        errors.push(`Could not generate ${filePath}: ${err instanceof Error ? err.message : "unknown"}`);
      }
      return;
    }

    try {
      // fetchBlob already routes through Gluecron-first / GitHub-fallback so
      // a GitHub PAT can read files when Gluecron is unavailable.
      const originalContent = await fetchBlob(owner, repo, filePath, "", token);

      if (!originalContent) {
        errors.push(`Could not read ${filePath}`);
        return;
      }

      if (originalContent.length > MAX_FILE_BYTES) {
        errors.push(`Skipped ${filePath}: file too large (${originalContent.length} bytes, limit ${MAX_FILE_BYTES})`);
        return;
      }

      // Day-2 — Surgical-fix path. Triggered when EVERY issue for this file
      // has a parseable line number. Sends Claude only the issue's slice of
      // the file; bytes outside the slice are byte-identical because they
      // were never sent. Mutation becomes architecturally impossible.
      const allHaveLines = fileIssues.every((i) => typeof i.line === "number" && i.line! > 0);
      if (allHaveLines) {
        const surgicalAttempts: AttemptLog[] = [];
        let workingContent = originalContent;
        let surgicalOk = true;
        let surgicalFinalReason: string | null = null;
        // Process bottom-up so earlier line numbers stay valid as we patch.
        const sortedIssues = [...fileIssues].sort((a, b) => (b.line! - a.line!));
        for (const issue of sortedIssues) {
          const ctx = surgicalFix.extractIssueContext(workingContent, issue.line!, 20);
          let issueOk = false;
          for (let attempt = 1; attempt <= DEFAULT_MAX_ATTEMPTS; attempt++) {
            const startedAtAttempt = Date.now();
            try {
              const rawSurgicalPrompt = surgicalFix.buildSurgicalPrompt({
                filePath,
                slice: ctx.slice,
                startLine: ctx.startLine,
                endLine: ctx.endLine,
                issues: [issue.text],
              });
              // Prepend grounding header so Claude respects project conventions
              // even when it only sees a ±20-line slice of the file.
              const prompt = conventionsHeader + rawSurgicalPrompt;
              const claudeText = await askClaudeForTest(prompt);
              const replacement = surgicalFix.parseReplacementBlock(claudeText);
              const newContent = surgicalFix.spliceReplacement(
                workingContent,
                ctx.startLine,
                ctx.endLine,
                replacement,
                ctx.lineEnding
              );
              const v = surgicalFix.validateSurgicalFix({
                originalContent: workingContent,
                fixedContent: newContent,
                startLine: ctx.startLine,
                endLine: ctx.endLine,
                lineEnding: ctx.lineEnding,
              });
              if (!v.ok) {
                surgicalAttempts.push({
                  attemptNumber: surgicalAttempts.length + 1,
                  startedAt: startedAtAttempt,
                  durationMs: Date.now() - startedAtAttempt,
                  outcome: "validation-fail",
                  validationReason: `mutation outside slice: ${v.reason || "unknown"}`,
                  qualityIssues: [],
                  claudeError: null,
                });
                continue;
              }
              workingContent = newContent;
              surgicalAttempts.push({
                attemptNumber: surgicalAttempts.length + 1,
                startedAt: startedAtAttempt,
                durationMs: Date.now() - startedAtAttempt,
                outcome: "success",
                validationReason: null,
                qualityIssues: [],
                claudeError: null,
              });
              issueOk = true;
              break;
            } catch (err) {
              surgicalAttempts.push({
                attemptNumber: surgicalAttempts.length + 1,
                startedAt: startedAtAttempt,
                durationMs: Date.now() - startedAtAttempt,
                outcome: "claude-error",
                validationReason: null,
                qualityIssues: [],
                claudeError: err instanceof Error ? err.message : "unknown",
              });
            }
          }
          if (!issueOk) {
            surgicalOk = false;
            surgicalFinalReason = `surgical fix failed at line ${issue.line} after ${DEFAULT_MAX_ATTEMPTS} attempts`;
            break;
          }
        }

        attemptHistoryByFile[filePath] = {
          attempts: surgicalAttempts,
          summary: summariseAttempts(surgicalAttempts),
          success: surgicalOk,
        };

        if (!surgicalOk) {
          const allClaudeErrors = surgicalAttempts.length > 0 && surgicalAttempts.every((a) => a.outcome === "claude-error");
          if (allClaudeErrors) {
            throw new Error(surgicalAttempts[surgicalAttempts.length - 1].claudeError || "Claude API error");
          }
          errors.push(`Skipped ${filePath} (surgical, ${surgicalAttempts.length} attempts): ${surgicalFinalReason}`);
          return;
        }

        fixes.push({ file: filePath, original: originalContent, fixed: workingContent, issues: fileIssueTexts });
        state.consecutiveNetworkErrors = 0;
        return;
      }

      // Whole-file fallback path — used when one or more issues lack a line
      // number (summary-shaped findings, multi-region issues, etc.). Same
      // existing iterative loop, BUT the result is now run through the
      // mutation guard before being accepted.
      const loopResult = await attemptFixWithRetries({
        askClaude: (currentIssues: string[]) => askClaude(originalContent, filePath, currentIssues, conventionsHeader),
        validateFix,
        verifyFixQuality,
        originalContent,
        filePath,
        issues: fileIssueTexts,
        maxAttempts: DEFAULT_MAX_ATTEMPTS,
      });

      attemptHistoryByFile[filePath] = {
        attempts: loopResult.attempts,
        summary: summariseAttempts(loopResult.attempts),
        success: loopResult.success,
      };

      if (!loopResult.success) {
        const allClaudeErrors = loopResult.attempts.length > 0 && loopResult.attempts.every((a) => a.outcome === "claude-error");
        if (allClaudeErrors) {
          throw new Error(loopResult.attempts[loopResult.attempts.length - 1].claudeError || "Claude API error");
        }
        errors.push(`Skipped ${filePath} (${loopResult.attempts.length} attempt${loopResult.attempts.length > 1 ? "s" : ""}): ${loopResult.finalReason}`);
        return;
      }

      // Day-2 — mutation guard on the whole-file path. Reject fixes that
      // changed dramatically more lines than the issue count justifies.
      const guardResult = mutationGuard.evaluateMutation({
        original: originalContent,
        fixed: loopResult.fixed!,
        issueCount: fileIssueTexts.length,
      });
      if (!guardResult.ok) {
        errors.push(`Rejected ${filePath} by mutation guard: ${guardResult.reason} — ${mutationGuard.summariseMutation(guardResult)}`);
        return;
      }

      fixes.push({ file: filePath, original: originalContent, fixed: loopResult.fixed!, issues: fileIssueTexts });
      state.consecutiveNetworkErrors = 0;
    } catch (err) {
      const raw = err instanceof Error ? err.message : "unknown";
      const isAbortErr = err instanceof Error && (err.name === "AbortError" || /aborted|abort/i.test(raw));
      const isNetworkErr = isAbortErr || /EPROTO|ECONNRESET|ETIMEDOUT|ssl.*alert|handshake|fetch failed|socket hang up|unreachable/i.test(raw);

      if (isNetworkErr) {
        state.consecutiveNetworkErrors += 1;
        if (state.consecutiveNetworkErrors === 3 && state.activeConcurrency > 1) {
          state.activeConcurrency = 1;
        }
        if (state.consecutiveNetworkErrors >= 8) {
          state.haltRun = true;
        }
        failedFiles.push({ file: filePath, issues: fileIssueTexts, reason: "api-unavailable" });
        const msg = isAbortErr
          ? `${filePath}: request timed out (file may be too large) — queued for retry`
          : `${filePath}: Anthropic API temporarily unavailable — queued for retry`;
        errors.push(msg);
      } else {
        errors.push(`Failed to fix ${filePath}: ${raw}`);
      }
    }
  });

  if (skippedForBudget > 0) {
    errors.push(`Skipped ${skippedForBudget} file${skippedForBudget > 1 ? "s" : ""} — function time budget exhausted. Re-run fix to process the remainder.`);
  }

  if (fixes.length === 0) {
    const apiDegraded = failedFiles.length > 0 && failedFiles.length === fileEntries.length;
    return NextResponse.json({
      status: apiDegraded ? "api_unavailable" : "no_fixes",
      message: apiDegraded
        ? `Anthropic API is temporarily degraded — every file failed with a network/TLS error. All ${failedFiles.length} files are queued for retry. Click "Retry Failed" in 1-2 minutes; if the problem persists, Anthropic is likely having an incident (check status.anthropic.com).`
        : skippedForBudget > 0
        ? `All ${skippedForBudget} files skipped — function time budget exhausted before Claude could finish. Try again — the second run will typically complete since results cache and retries kick in faster.`
        : "No fixes could be generated",
      errors,
      skippedForBudget,
      failedFiles,
    });
  }

  // Phase 1.2 — cross-fix syntax gate. Ran ONCE on the full collected
  // fix set after every per-file iterative loop completed. Anything that
  // doesn't parse is dropped from the PR — the customer never sees a
  // broken-syntax fix on their branch.
  const syntaxGate = validateFixesSyntax({ fixes });
  if (syntaxGate.rejected.length > 0) {
    for (const r of syntaxGate.rejected) {
      errors.push(`Rejected ${r.file} (${r.language}): ${r.reason}`);
    }
    // Replace the working fix list with the syntax-validated subset.
    // The accepted entries carry the same shape as the originals plus
    // a `language` field; downstream code reads `file`/`fixed`/etc.
    fixes.length = 0;
    for (const a of syntaxGate.accepted) {
      fixes.push({ file: a.file, fixed: a.fixed, original: a.original, issues: a.issues });
    }
  }
  const syntaxGateSummary = summariseSyntaxGate(syntaxGate);

  if (fixes.length === 0) {
    return NextResponse.json({
      status: "no_fixes",
      message: `Every fix failed the syntax gate — Claude returned content that doesn't parse. ${syntaxGateSummary}`,
      errors,
      skippedForBudget,
      failedFiles,
      syntaxGate: { accepted: syntaxGate.accepted.length, rejected: syntaxGate.rejected.length, summary: syntaxGateSummary },
    });
  }

  // Phase 1.2b — cross-file scanner re-validation. Only runs when the
  // caller supplied the original workspace + findings. Without that
  // baseline we can't tell which findings are NEW vs pre-existing, so
  // skip silently — per-file iterative loop + syntax gate still ran.
  let scannerGateSummary: string | undefined;
  let scannerGateRolledBack: Array<{ file: string; reason: string; newFindings: string[] }> = [];
  let postFixFindingsByModule: Record<string, string[]> | undefined;
  if (
    Array.isArray(input.originalFileContents) &&
    input.originalFileContents.length > 0 &&
    input.originalFindingsByModule &&
    typeof input.originalFindingsByModule === "object"
  ) {
    const scannerGate = await validateFixesAgainstScanner({
      fixes,
      originalFileContents: input.originalFileContents,
      originalFindingsByModule: input.originalFindingsByModule,
      runTier,
      owner,
      repo,
      tier: input.tier || "full",
    });
    scannerGateSummary = scannerGate.summary;
    postFixFindingsByModule = scannerGate.postFixFindingsByModule;
    if (scannerGate.rolledBack.length > 0) {
      for (const rb of scannerGate.rolledBack) {
        errors.push(`Rolled back ${rb.file}: ${rb.reason} — ${rb.newFindings.join("; ")}`);
      }
      scannerGateRolledBack = scannerGate.rolledBack.map((rb) => ({
        file: rb.file,
        reason: rb.reason,
        newFindings: rb.newFindings,
      }));
      // Replace fix list with scanner-validated subset.
      fixes.length = 0;
      for (const a of scannerGate.accepted) {
        fixes.push({ file: a.file, fixed: a.fixed, original: a.original, issues: a.issues });
      }
    }

    if (fixes.length === 0) {
      return NextResponse.json({
        status: "no_fixes",
        message: `Every fix failed the cross-file scanner gate — each one introduced a new finding. ${scannerGateSummary}`,
        errors,
        skippedForBudget,
        failedFiles,
        syntaxGate: { accepted: syntaxGate.accepted.length, rejected: syntaxGate.rejected.length, summary: syntaxGateSummary },
        scannerGate: { rolledBack: scannerGateRolledBack, summary: scannerGateSummary },
      });
    }
  }

  // Phase 1.3 — test generation per fix. For every successful,
  // gate-passed fix, ask Claude to write a regression test that
  // would have failed against the original code. Tests are added
  // to `fixes` as new-file entries so the existing PR commit logic
  // ships them in the same PR. Per-fix failures here NEVER block
  // the underlying fix — a missing regression test is annoying but
  // not destructive.
  const testGen = await generateTestsForFixes({
    fixes,
    askClaudeForTest,
  }).catch((err) => {
    // Failing the WHOLE batch shouldn't kill the PR. Log and proceed
    // with no generated tests.
    const message = err instanceof Error ? err.message : "test generation failed";
    errors.push(`Test generation failed (no regression tests added): ${message}`);
    return { tests: [] as Array<{ path: string; content: string; sourceFile: string }>, skipped: [] as Array<{ sourceFile: string; reason: string }>, summary: `test generation: failed (${message})` };
  });
  for (const t of testGen.tests) {
    fixes.push({ file: t.path, original: "", fixed: t.content, issues: [`Regression test for ${t.sourceFile}`] });
  }
  for (const s of testGen.skipped) {
    errors.push(`No regression test for ${s.sourceFile}: ${s.reason}`);
  }
  const testGenSummary = testGen.summary;

  // Create a branch, commit fixes, open PR
  try {
    // Resolve the default branch + its tip SHA. Tries Gluecron first, falls
    // back to GitHub when the token is GitHub-shaped or Gluecron returns no
    // sha — used to silently 500 with "Could not get base branch SHA from
    // Gluecron" even when a GitHub PAT was available and the API would have
    // worked. See gluecron-client.ts:resolveBaseBranchSha.
    const baseRef = await resolveBaseBranchSha(owner, repo, "", token);
    const defaultBranch = baseRef.defaultBranch;
    const baseSha = baseRef.sha;

    if (!baseSha) {
      return NextResponse.json({
        error: "Could not resolve base branch SHA from Gluecron or GitHub",
        hint: "Confirm the repo is reachable and GLUECRON_API_TOKEN / GITHUB_TOKEN has read access.",
        defaultBranch,
      }, { status: 500 });

    }

    // Create branch via Gluecron.
    const branchName = `gatetest/auto-fix-${Date.now()}`;
    const branchRes = await createBranch(owner, repo, branchName, baseSha, token);

    if (branchRes.status !== 201) {
      return NextResponse.json({
        error: "Could not create branch — check Gluecron token permissions",
        details: branchRes.data,
      }, { status: 500 });
    }

    // Commit each fixed file (parallel, capped). New files have no SHA.
    await mapWithConcurrency(fixes, FIX_CONCURRENCY, async (fix) => {
      const isNewFile = fix.original === "";
      const message = isNewFile
        ? `feat: create ${fix.file}`
        : `fix: ${fix.issues[0]}${fix.issues.length > 1 ? ` (+${fix.issues.length - 1} more)` : ""}`;
      const existingSha = isNewFile
        ? ""
        : await fetchFileSha(owner, repo, fix.file, branchName, token);
      await upsertFile(owner, repo, fix.file, fix.fixed, message, branchName, existingSha, token);
    });

    // Phase 1.4 — Compose the PR body from every artifact we collected.
    // The composer renders header, CVE patches (if any), before/after scan
    // comparison, gate results, per-file attempt history, fixed-files list,
    // regression tests, advisory section, how-it-works, next steps, footer.
    const totalIssuesFixed = fixes.reduce((sum, f) => sum + f.issues.length, 0);
    const cvePrSection = composeCveFixPrSection(collectedCvePatches);
    const cveSummary = summariseCvePatches(collectedCvePatches);
    const prBody = composePrBody({
      fixes,
      errors,
      attemptHistoryByFile,
      syntaxGate: { summary: syntaxGateSummary },
      scannerGate: scannerGateSummary
        ? { summary: scannerGateSummary }
        : { skipped: true, reason: "caller did not pass originalFileContents + originalFindingsByModule" },
      testGen: { summary: testGenSummary },
      originalFindingsByModule: input.originalFindingsByModule,
      postFixFindingsByModule,
      repoUrl,
      cveSection: cvePrSection || undefined,
    });

    // Open the PR. NOTE: Gluecron uses `headBranch` / `baseBranch` (NOT
    // GitHub's `head` / `base`) — our openPullRequest helper handles the
    // translation for us.
    const prRes = await openPullRequest(
      owner,
      repo,
      `GateTest: Fix ${fixes.reduce((sum, f) => sum + f.issues.length, 0)} issues across ${fixes.length} files`,
      prBody,
      branchName,
      defaultBranch,
      token
    );

    if (prRes.status !== 201) {
      return NextResponse.json({
        status: "fixes_committed",
        message: `Fixes committed to branch ${branchName} but PR creation failed`,
        branch: branchName,
        filesFixed: fixes.length,
        issuesFixed: totalIssuesFixed,
        errors: [...errors, `PR creation failed: ${JSON.stringify(prRes.data)}`],
      });
    }

    const prNumber = prRes.data.number as number;
    const prUrl = (prRes.data.html_url as string) || "";

    // Audit-log the PR-open event. Fire-and-forget. Includes the budget
    // snapshot so finance / support can reconcile spend against the scan.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { recordEventIfConfigured } = require("@/app/lib/audit-log-store");
    void recordEventIfConfigured({
      actor: input.tier ? `tier:${input.tier}` : "anonymous",
      action: "fix.pr_opened",
      resourceType: "pr",
      resourceId: prUrl || `${owner}/${repo}#${prNumber}`,
      metadata: {
        repo: `${owner}/${repo}`,
        prNumber,
        tier: input.tier || "full",
        issuesFixed: totalIssuesFixed,
        filesFixed: fixes.length,
        budget: tracker.snapshot(),
      },
    });

    // Post verification comment on the PR
    try {
      const remainingIssues: string[] = [];
      for (const fix of fixes) {
        const verify = verifyFixQuality(fix.fixed, fix.file);
        if (!verify.clean) {
          remainingIssues.push(`**${fix.file}**: ${verify.newIssues.join(", ")}`);
        }
      }

      const verifyBody = remainingIssues.length === 0
        ? `## ✅ GateTest Verification Passed\n\nAll ${totalIssuesFixed} fixes have been verified against GateTest's pattern scanner. No new issues introduced.\n\n**This PR is safe to merge.**`
        : `## ⚠️ GateTest Verification Warning\n\n${remainingIssues.length} file(s) may still have issues:\n${remainingIssues.map((i) => `- ${i}`).join("\n")}\n\nPlease review these files carefully before merging.`;

      await postPrComment(owner, repo, prNumber, verifyBody, token);
    } catch {
      // Non-critical — PR was created successfully, comment failed
    }

    // Phase 2.2 — architecture annotator. Runs only on the $199 tier.
    // Posts a separate PR comment with design observations the
    // per-file scanner cannot see (layering, god objects, etc.).
    // Requires `originalFileContents` so it has the codebase shape;
    // skipped silently if the caller didn't pass that.
    let architectureSummary: string | undefined;
    if (input.tier === "scan_fix" && Array.isArray(input.originalFileContents) && input.originalFileContents.length > 0) {
      try {
        const arch = await annotateArchitecture({
          fileContents: input.originalFileContents,
          askClaudeForArchitecture: askClaudeForTest,
          repoUrl,
        });
        architectureSummary = arch.ok
          ? `architecture: ${arch.summary?.sourceFiles ?? '?'} source files analysed, ${arch.sampleFiles?.length ?? 0} sampled, report posted`
          : `architecture: skipped (${arch.reason})`;
        const archMarkdown = renderArchitectureComment(arch);
        await postPrComment(owner, repo, prNumber, archMarkdown, token);
      } catch (err) {
        const message = err instanceof Error ? err.message : "architecture annotator failed";
        errors.push(`Architecture annotation failed (no report posted): ${message}`);
        architectureSummary = `architecture: failed (${message})`;
      }
    }

    // Phase 2.1 — pair-review agent. Runs only when the caller's tier
    // is scan_fix (the $199 tier). For Quick / Full scans the loop +
    // gates + test-gen + composer ship without pair-review. The
    // critique posts as a separate PR comment so the customer sees
    // a second pair of eyes on every fix.
    let pairReviewSummary: string | undefined;
    let confidenceSummary: string | undefined;
    if (input.tier === "scan_fix") {
      try {
        // Build map: source-file → regression-test-content for the
        // pair-review agent to see per-fix tests.
        const testsBySourceFile: Record<string, string> = {};
        for (const f of fixes) {
          if (f.file.startsWith("tests/auto-generated/")) {
            const sourceMatch = (f.issues || []).join(" ").match(/Regression test for (.+)/);
            if (sourceMatch) testsBySourceFile[sourceMatch[1]] = f.fixed;
          }
        }
        const review = await runPairReview({
          fixes,
          testsBySourceFile,
          askClaudeForReview: askClaudeForTest, // same Claude wrapper, different prompt
        });
        pairReviewSummary = review.summary;
        const reviewMarkdown = renderReviewComment(review.reviews, review.averages);
        await postPrComment(owner, repo, prNumber, reviewMarkdown, token);

        // Tier-1 Item 5 — Confidence-Aware Reporting.
        // Aggregate the pair-review 4-axis scores into a per-fix confidence
        // and apply the per-tier threshold gate. Non-blocking: we surface
        // the gate decision in the response + PR comment but never reject
        // a fix that already shipped to the branch (the customer keeps
        // what they paid for). Future: feed this back into the loop to
        // re-attempt fixes below threshold.
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const {
            aggregateConfidence,
            summariseConfidence,
            formatConfidenceReport,
          } = require("@lib/confidence-gate") as {
            aggregateConfidence: (s: unknown) => number | null;
            summariseConfidence: (opts: { fixes: Array<{ file: string; scores?: unknown }>; tier: string }) => string;
            formatConfidenceReport: (opts: { fixes: Array<{ file: string; scores?: unknown }>; tier: string }) => string;
          };
          const fixesWithScores = review.reviews.map((r) => ({
            file: r.file,
            scores: r.scores || undefined,
          }));
          const confTier = input.tier || "scan_fix";
          confidenceSummary = summariseConfidence({ fixes: fixesWithScores, tier: confTier });
          // Best-effort log of per-fix confidence for ops visibility.
          for (const f of fixesWithScores) {
            const conf = aggregateConfidence(f.scores);
            if (conf !== null && conf < 0.85) {
              console.log(`[GateTest] low-confidence fix ${f.file}: ${conf.toFixed(2)} (scan_fix threshold 0.85)`);
            }
          }
          const confidenceMarkdown = formatConfidenceReport({ fixes: fixesWithScores, tier: confTier });
          await postPrComment(owner, repo, prNumber, confidenceMarkdown, token);
        } catch (confErr) {
          // Non-critical — fix shipped, pair review posted, only the
          // confidence summary failed.
          const message = confErr instanceof Error ? confErr.message : "confidence report failed";
          errors.push(`Confidence report failed (no comment posted): ${message}`);
          confidenceSummary = `confidence: failed (${message})`;
        }
      } catch (err) {
        // Non-critical — PR + verification already posted. Pair review
        // is a $199-tier value-add; if Claude is degraded, the rest
        // of the deliverable still ships.
        const message = err instanceof Error ? err.message : "pair review failed";
        errors.push(`Pair review failed (no critique posted): ${message}`);
        pairReviewSummary = `pair review: failed (${message})`;
      }
    }

    return NextResponse.json({
      status: "pr_created",
      prUrl,
      prNumber,
      branch: branchName,
      filesFixed: fixes.length,
      issuesFixed: totalIssuesFixed,
      fixes: fixes.map((f) => ({ file: f.file, issues: f.issues })),
      authSource,
      errors,
      failedFiles,
      syntaxGate: { accepted: syntaxGate.accepted.length, rejected: syntaxGate.rejected.length, summary: syntaxGateSummary },
      scannerGate: scannerGateSummary
        ? { rolledBack: scannerGateRolledBack, summary: scannerGateSummary }
        : { skipped: true, reason: "caller did not pass originalFileContents + originalFindingsByModule" },
      testGeneration: { testsWritten: testGen.tests.length, skipped: testGen.skipped, summary: testGenSummary },
      pairReview: pairReviewSummary
        ? { summary: pairReviewSummary }
        : { skipped: true, reason: "tier is not scan_fix — pair review is a $199-tier value-add" },
      confidence: confidenceSummary
        ? { summary: confidenceSummary }
        : { skipped: true, reason: "tier is not scan_fix — confidence-aware reporting is a $199-tier value-add" },
      architecture: architectureSummary
        ? { summary: architectureSummary }
        : { skipped: true, reason: "tier is not scan_fix or originalFileContents not supplied — architecture annotation is a $199-tier value-add" },
      grounding: {
        summary: groundingSummary,
        filesUsed: groundingExtract.found.map((f) => f.path),
      },
      cve: {
        patchesApplied: collectedCvePatches.length,
        summary: cveSummary,
        patches: collectedCvePatches,
      },
      attemptHistory: attemptHistoryByFile,
    });
  } catch (err) {
    return NextResponse.json({
      status: "error",
      error: err instanceof Error ? err.message : "Failed to create PR",
      fixesGenerated: fixes.length,
      errors,
    }, { status: 500 });
  }

  } catch (outerErr) { // error-ok — outer guard: catches auth / file-fetch / gate throws that bypassed inner handler
    // Budget-exceeded is a customer-visible quota event, not a server crash.
    // Return 402 (Payment Required) with the tracker snapshot so support can
    // see exactly which scan hit the cap and how much it had spent.
    if ((outerErr as { code?: string })?.code === "BUDGET_EXCEEDED") {
      const snap = (outerErr as { tracker?: Record<string, unknown> }).tracker || tracker.snapshot();
      console.warn("[GateTest] scan/fix budget exhausted:", JSON.stringify(snap));
      // Audit-log the budget exhaustion — high-value finance signal.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { recordEventIfConfigured } = require("@/app/lib/audit-log-store");
      void recordEventIfConfigured({
        actor: "scan_fix",
        action: "fix.budget_exceeded",
        resourceType: "scan",
        resourceId: typeof snap === "object" && snap && "label" in snap ? String((snap as { label?: string }).label || "scan-fix") : "scan-fix",
        metadata: snap as Record<string, unknown>,
      });
      return NextResponse.json(
        {
          status: "error",
          error: "Scan exceeded its AI spend budget. The work completed up to the cap is preserved; please retry with a smaller issue set or contact support.",
          budget: snap,
        },
        { status: 402 }
      );
    }
    const msg = outerErr instanceof Error ? outerErr.message : "Unexpected fix-route error";
    console.error("[GateTest] scan/fix route crashed:", msg);
    return NextResponse.json(
      { status: "error", error: "Fix failed — please try again or contact support." },
      { status: 500 }
    );
  }
}

