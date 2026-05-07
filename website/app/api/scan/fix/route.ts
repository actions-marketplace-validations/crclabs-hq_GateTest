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
const { classifyAnthropicError, formatAnthropicError } = require("@/app/lib/anthropic-error") as {
  classifyAnthropicError: (status: number, body?: string) => { kind: string; status: number; message: string; action: string | null; raw: string };
  formatAnthropicError: (c: { message: string; action: string | null }) => string;
};
import {
  createBranch,
  fetchBlob,
  fetchFileSha,
  fetchTree,
  openPullRequest,
  postPrComment,
  resolveBaseBranchSha,
  resolveRepoAuth,
  upsertFile,
} from "../../../lib/gluecron-client";
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
  }) => string;
};

// Phase 1.3 — test generation per fix.
 
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
 
const { validateFixesSyntax, summariseSyntaxGate } = require("@/app/lib/cross-fix-syntax-gate") as {
  validateFixesSyntax: (opts: {
    fixes: Array<{ file: string; fixed: string; original: string; issues: string[] }>;
  }) => {
    accepted: Array<{ file: string; fixed: string; original: string; issues: string[]; language: string }>;
    rejected: Array<{ file: string; fixed: string; original: string; issues: string[]; reason: string; language: string }>;
  };
  summariseSyntaxGate: (result: { accepted: unknown[]; rejected: unknown[] }) => string;
};
 
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
 
const { enrichFixContext } = require("@/app/lib/fix-context-enricher") as {
  enrichFixContext: (opts: {
    filePath: string;
    fileContents: string;
    allFiles: string[];
    fetchFile: (path: string) => Promise<string | null>;
  }) => Promise<{ consumers: string[]; dependencies: string[]; stackHints: string[]; summary: string }>;
};

const { mapWithAdaptiveConcurrency } = require("@/app/lib/adaptive-concurrency") as {
  mapWithAdaptiveConcurrency: <T, R>(
    items: T[],
    initialLimit: number,
    fn: (item: T, state: AdaptiveState) => Promise<R>,
    opts?: { rampAfterSuccesses?: number; maxConcurrency?: number },
  ) => Promise<R[]>;
};

// Phase 5.1.3 brain wire-up — every fix prompt enriched with cross-repo
// prior-art ("X% of similar-stack repos had this finding; pattern Y worked
// Z%"). Was Nuclear-tier-only at landing; now flows into the regular fix
// loop so $99/$199 customers also benefit.
const fingerprintLib = require("@/app/lib/scan-fingerprint") as {
  extractFingerprint: (opts: {
    modules?: unknown[];
    dependencies?: Record<string, unknown>;
    files?: string[];
    fixes?: unknown[];
    fixErrors?: string[];
    tier?: string;
    durationMs?: number | null;
  }) => { fingerprintSignature: string; frameworkVersions: Record<string, string> };
};
const fingerprintStore = require("@/app/lib/scan-fingerprint-store") as {
  hashRepoUrl: (repoUrl: string) => string;
  findSimilarFingerprints: (opts: {
    sql: unknown;
    fingerprintSignature: string;
    frameworkVersions?: Record<string, string>;
    excludeRepoUrlHash?: string | null;
    limit?: number;
  }) => Promise<unknown[]>;
};
const crossRepoLookup = require("@/app/lib/cross-repo-lookup") as {
  fetchPriorArt: (opts: {
    fingerprint: { fingerprintSignature: string; frameworkVersions?: Record<string, string> };
    repoUrlHash: string;
    findSimilarFingerprints: unknown;
    sql: unknown;
    limit?: number;
  }) => Promise<{ context: string; sampleSize: number } | null>;
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

async function askClaude(fileContent: string, filePath: string, issues: string[], priorArtContext: string | null = null, contextSummary?: string): Promise<string> {
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

  // Brain context — injected before the rules section so Claude can use
  // it as background but not as a copy-paste source. The cross-repo
  // intelligence module formats this as "X repos with similar stack
  // showed pattern Y" so Claude knows what's COMMON for this stack and
  // avoids the inferior fixes that other repos tried first.
  const priorArtBlock = priorArtContext
    ? `\nCROSS-REPO CONTEXT (informational only — do not copy patterns; use to prioritise + sanity-check your fix):\n${priorArtContext}\n`
    : "";

  const batchHint = enrichedIssues.length > 1
    ? `

BATCH CONTEXT: ${enrichedIssues.length} issues in this single file. Read them ALL before you start writing. Some fixes interact — e.g. an unused-import fix may collide with a missing-import fix on the same line, or two fixes may both need to touch the same function signature. Plan the combined fix once, then write the file once. Do NOT fix issue 1, then issue 2, then issue 3 in isolation — that produces inconsistent state.`
    : "";

  const contextBlock = contextSummary
    ? `\nCODEBASE CONTEXT (use to understand how this file fits the broader architecture; do not copy patterns verbatim):\n${contextSummary}\n`
    : "";

  const prompt = `You are an expert code fixer for GateTest, an AI-powered QA platform with 90 scanning modules.

Fix ALL of the following issues in this file. Every fix must pass GateTest's re-scan.

FILE: ${filePath}
ISSUES TO FIX:
${enrichedIssues.map((i, idx) => `${idx + 1}. ${i}`).join("\n")}
${batchHint}
${priorArtBlock}${contextBlock}
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
    // 32K output budget. Claude Sonnet 4.6 supports up to 64K. The
    // previous 8192 cap silently truncated fixes on files >150KB
    // (the model would return well-formed code right up to the limit
    // then get cut). 32K + the validateClaudeOutput truncation
    // detector (rejects fixes <40% of original length) handles big
    // React components, generated SQL migrations, and verbose Vue
    // single-file components without surprise.
    max_tokens: 32768,
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
  throw new Error(formatAnthropicError(classifyAnthropicError(res.status, errSnippet)));
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
// History: 4 → 2 (2026-04, EPROTO/TLS-alert cascading failures), then back up to
// 4 (2026-05, after the adaptive ramp-up safety net landed in fa2f7ed). The
// adaptive helper ramps 4 → 8 on sustained success and drops to 1 on network
// errors, so we get the throughput when prod is healthy + safety when it's not.
const FIX_CONCURRENCY = 4;
const FIX_CONCURRENCY_MAX = 8;
const FIX_RAMP_AFTER_SUCCESSES = 3;
// Max file size we'll send to Claude. Sized against the 32K-token output
// budget: at ~0.4 tokens/char of source, 32K tokens ≈ 80KB of output.
// 600KB input gives the model headroom for files where the fixed version
// shrinks (removed lines, refactored extracts). Larger inputs WILL get
// truncated; the validateFix() truncation detector + retry loop catch
// those, so this cap is "we'll TRY up to 600KB" not "we GUARANTEE 600KB".
// Files reliably bigger than this need the Phase 5.4 multi-file refactor
// pipeline (chunks the file, fixes per-chunk, stitches back).
const MAX_FILE_BYTES = 600 * 1024;

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
    throw new Error(formatAnthropicError(classifyAnthropicError(res.status, errSnippet)));
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
    throw new Error(formatAnthropicError(classifyAnthropicError(res.status, errSnippet)));
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

  // ── Brain wire-up ──────────────────────────────────────────────
  // Best-effort cross-repo intelligence. Fetch package.json so we can
  // build a fingerprint, look up prior-art from the brain, and pass the
  // resulting context string through to every askClaude call. Failures
  // here NEVER block the fix loop — empty priorArt = behaviour identical
  // to before this commit.
  let priorArtContext: string | null = null;
  let brainSampleSize = 0;
  try {
    // Read package.json (best-effort, single file) for framework versions.
    let dependencies: Record<string, unknown> = {};
    try {
      const pkgRaw = await fetchBlob(owner, repo, "package.json", "", token);
      if (pkgRaw) {
        const pkg = JSON.parse(pkgRaw);
        dependencies = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      }
    } catch {
      // No package.json — non-JS project. Brain will fingerprint on
      // language-mix only (still useful).
    }
    const fingerprint = fingerprintLib.extractFingerprint({
      dependencies,
      files: issues.map((i) => i.file).filter((f): f is string => Boolean(f)),
      tier: input.tier || "full",
    });
    const repoUrlHash = fingerprintStore.hashRepoUrl(repoUrl);
    // SQL connection comes from the same db helper the brain already uses.
    const { getDb } = require("@/app/lib/db") as { getDb: () => unknown };
    const sql = getDb();
    const priorArt = await crossRepoLookup.fetchPriorArt({
      fingerprint,
      repoUrlHash,
      findSimilarFingerprints: fingerprintStore.findSimilarFingerprints,
      sql,
      limit: 10,
    });
    if (priorArt && priorArt.context) {
      priorArtContext = priorArt.context;
      brainSampleSize = priorArt.sampleSize;
    }
  } catch {
    // Brain unavailable — fall through with priorArtContext = null.
  }

  // Phase Nuclear-coupling — when tier=nuclear, diagnose every issue
  // FIRST and enrich the issue text with the diagnoser's rootCause +
  // recommendation BEFORE feeding it into the per-file fix loop. This
  // is what turns $399 from "diagnose, then ship a per-line fix" into
  // "ship a fix that knows what the architect-Claude said the fix
  // should be."
  //
  // Reliability contract: any failure in the diagnosis step falls
  // through with the ORIGINAL issues. The fix loop never gets blocked
  // on the diagnoser; it just gets richer input when the brain is
  // healthy. Tested in tests/diagnosis-enricher.test.js.
  let workingIssues: IssueInput[] = issues;
  let nuclearEnrichmentSummary: string | undefined;
  if (input.tier === "nuclear") {
    try {
       
      const { shipDiagnosisAwareFix } = require("@/app/lib/diagnosis-enricher.js") as {
        shipDiagnosisAwareFix: (opts: {
          issues: IssueInput[];
          askClaudeForDiagnosis: (prompt: string) => Promise<string>;
          hostname?: string;
        }) => Promise<{
          enrichedIssues: IssueInput[];
          diagnoses: unknown[];
          summary: string;
          enrichedCount: number;
        }>;
      };
      const hostname = (() => {
        try { return new URL(repoUrl).hostname; } catch { return "your-domain.com"; }
      })();
      const enrichResult = await shipDiagnosisAwareFix({
        issues,
        askClaudeForDiagnosis: askClaudeForTest, // same Claude wrapper, different prompt
        hostname,
      });
      workingIssues = enrichResult.enrichedIssues as IssueInput[];
      nuclearEnrichmentSummary = enrichResult.summary;
    } catch (err) {
      // Best-effort: log + fall through with original issues. The
      // shipDiagnosisAwareFix helper already has its own try/catch for
      // diagnoser-side errors; this outer guard catches any contract-
      // violation unexpected throw.
      const message = err instanceof Error ? err.message : "unknown";
      nuclearEnrichmentSummary = `nuclear enrichment skipped: ${message}`;
    }
  }

  // Group issues by file (using the possibly-enriched workingIssues)
  const issuesByFile = new Map<string, string[]>();
  for (const issue of workingIssues) {
    if (!issue.file) continue;
    const existing = issuesByFile.get(issue.file) || [];
    existing.push(issue.issue);
    issuesByFile.set(issue.file, existing);
  }

  if (issuesByFile.size === 0) {
    return NextResponse.json({ error: "No fixable issues (issues must have file paths)" }, { status: 400 });
  }

  // Contextual fix intelligence — fetch the repo's full file tree once so the
  // per-file enricher can find consumers and dependencies without re-listing.
  // Best-effort: tree fetch failure falls through with an empty list and the
  // enricher degrades gracefully to no context.
  let repoAllFiles: string[] = [];
  try {
    repoAllFiles = await fetchTree(owner, repo, "HEAD", token);
  } catch {
    // best-effort: context enrichment will degrade gracefully
  }

  type Fix = { file: string; original: string; fixed: string; issues: string[] };
  const fixes: Fix[] = [];
  const errors: string[] = [];

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
    // Handle CREATE_FILE issues — the file doesn't exist, generate it from scratch
    const createIssues = fileIssues.filter((i) => i.startsWith("CREATE_FILE:"));
    if (createIssues.length > 0) {
      try {
        const newContent = await askClaudeCreate(filePath, createIssues.map((i) => i.replace("CREATE_FILE: ", "")));
        if (newContent && newContent.length > 10) {
          fixes.push({ file: filePath, original: "", fixed: newContent, issues: fileIssues });
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

      // Contextual fix intelligence — gather surrounding codebase context so
      // Claude sees architecture before generating the fix. Best-effort: any
      // failure produces empty context and the fix proceeds normally.
      let fixContextSummary: string | undefined;
      try {
        const ctx = await enrichFixContext({
          filePath,
          fileContents: originalContent,
          allFiles: repoAllFiles,
          fetchFile: async (p: string) => fetchBlob(owner, repo, p, "", token),
        });
        if (ctx.summary) fixContextSummary = ctx.summary;
      } catch {
        // best-effort: proceed without context
      }

      // Phase 1: iterative fix loop with up to N attempts. Each attempt's
      // outcome is logged; on quality-fail the next attempt sees explicit
      // feedback about what was introduced. On total failure, all attempts
      // are surfaced in the response so the UI can show the full trail.
      const loopResult = await attemptFixWithRetries({
        askClaude: (currentIssues: string[]) => askClaude(originalContent, filePath, currentIssues, priorArtContext, fixContextSummary),
        validateFix,
        verifyFixQuality,
        originalContent,
        filePath,
        issues: fileIssues,
        maxAttempts: DEFAULT_MAX_ATTEMPTS,
      });

      attemptHistoryByFile[filePath] = {
        attempts: loopResult.attempts,
        summary: summariseAttempts(loopResult.attempts),
        success: loopResult.success,
      };

      // If every attempt was a Claude API error, treat it the same as the
      // outer catch would have — file gets queued for retry, not marked
      // permanently failed, and the rolling network-error counter ticks
      // so concurrency degrades. Other failure modes (validation /
      // quality) just go in errors.
      if (!loopResult.success) {
        const allClaudeErrors = loopResult.attempts.length > 0 && loopResult.attempts.every((a) => a.outcome === "claude-error");
        if (allClaudeErrors) {
          throw new Error(loopResult.attempts[loopResult.attempts.length - 1].claudeError || "Claude API error");
        }
        errors.push(`Skipped ${filePath} (${loopResult.attempts.length} attempt${loopResult.attempts.length > 1 ? "s" : ""}): ${loopResult.finalReason}`);
        return;
      }

      fixes.push({ file: filePath, original: originalContent, fixed: loopResult.fixed!, issues: fileIssues });
      // Reset the rolling network-error counter on any success — only sustained
      // failure across multiple files should drop concurrency.
      state.consecutiveNetworkErrors = 0;
    } catch (err) {
      const raw = err instanceof Error ? err.message : "unknown";
      const isAbortErr = err instanceof Error && (err.name === "AbortError" || /aborted|abort/i.test(raw));
      const isNetworkErr = isAbortErr || /EPROTO|ECONNRESET|ETIMEDOUT|ssl.*alert|handshake|fetch failed|socket hang up|unreachable/i.test(raw);

      if (isNetworkErr) {
        state.consecutiveNetworkErrors += 1;
        // After 3 consecutive API network errors, drop concurrency to 1 — parallel
        // requests against a degraded Anthropic endpoint just poison each other.
        if (state.consecutiveNetworkErrors === 3 && state.activeConcurrency > 1) {
          state.activeConcurrency = 1;
        }
        // After 8 consecutive failures, halt the run — Anthropic is down, keep
        // remaining files as a retryable queue so the UI can resume later.
        if (state.consecutiveNetworkErrors >= 8) {
          state.haltRun = true;
        }
        failedFiles.push({ file: filePath, issues: fileIssues, reason: "api-unavailable" });
        const msg = isAbortErr
          ? `${filePath}: request timed out (file may be too large) — queued for retry`
          : `${filePath}: Anthropic API temporarily unavailable — queued for retry`;
        errors.push(msg);
      } else {
        errors.push(`Failed to fix ${filePath}: ${raw}`);
      }
    }
  }, { rampAfterSuccesses: FIX_RAMP_AFTER_SUCCESSES, maxConcurrency: FIX_CONCURRENCY_MAX });

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

  // Phase 1.2b — cross-file scanner re-validation. Now self-populates
  // originalFileContents from the fix loop's captured pre-fix content when
  // the caller didn't pass it explicitly. The fix loop already fetched each
  // file's original content (stored in fix.original), so we reuse that
  // rather than making a second round-trip. This activates the gate for
  // ALL tiers that have successful fixes, not just callers that pre-fetch
  // the whole workspace. Coverage is limited to fixed files only (cross-file
  // regressions involving unfixed files won't be caught), but that's
  // far better than the prior state of always skipping the gate.
  const effectiveOriginalFileContents =
    Array.isArray(input.originalFileContents) && input.originalFileContents.length > 0
      ? input.originalFileContents
      : fixes
          .filter((f) => typeof f.original === "string" && f.original.length > 0)
          .map((f) => ({ path: f.file, content: f.original }));

  let scannerGateSummary: string | undefined;
  let scannerGateRolledBack: Array<{ file: string; reason: string; newFindings: string[] }> = [];
  let postFixFindingsByModule: Record<string, string[]> | undefined;
  if (
    effectiveOriginalFileContents.length > 0 &&
    input.originalFindingsByModule &&
    typeof input.originalFindingsByModule === "object" &&
    Object.keys(input.originalFindingsByModule).length > 0
  ) {
    const scannerGate = await validateFixesAgainstScanner({
      fixes,
      originalFileContents: effectiveOriginalFileContents,
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
      // Phase 5.2.1 — record FIX_REJECTED dissent for every rolled-back
      // fix so the FP scorer (5.2.2) sees the signal. Best-effort:
      // failures here never block the PR. Each unattributed finding
      // also surfaces as a module-level dissent so we capture
      // module-wide noise patterns even when we can't tie a new finding
      // to a specific fixer's input.
      try {
        // Lazy import to avoid pulling the store into the hot path of
        // routes that never roll anything back.
         
        const dissentStore = require("@/app/lib/dissent-store.js") as {
          DISSENT_KINDS: Record<string, string>;
          ensureDissentTable: (sql: unknown) => Promise<void>;
          recordDissent: (opts: {
            sql: unknown;
            repoUrl: string;
            module: string;
            kind: string;
            patternHash?: string | null;
            notes?: string | null;
            fixPrNumber?: number | null;
          }) => Promise<{ id: number | null }>;
        };
         
        const { getDb } = require("@/app/lib/db") as { getDb: () => unknown };
        const sql = getDb();
        await dissentStore.ensureDissentTable(sql);
        for (const rb of scannerGate.rolledBack) {
          // Map each rolled-back fix to one or more dissent rows. The
          // module is unknown at this layer (the original issue list
          // didn't preserve it), so we use the scanner-gate's reason
          // string as the module signal, prefixed so the operator
          // dashboard can tell rollback dissent apart from explicit FP.
          await dissentStore
            .recordDissent({
              sql,
              repoUrl,
              module: `scanner-gate:${(rb.reason || "regression").slice(0, 32)}`,
              kind: dissentStore.DISSENT_KINDS.FIX_REJECTED,
              notes: `${rb.file} — ${(rb.newFindings || []).slice(0, 3).join("; ")}`.slice(0, 500),
            })
            .catch((err: unknown) => {
              console.error(
                "[scan/fix] dissent recording failed (rollback still applied):",
                err instanceof Error ? err.message : String(err),
              );
              return null;
            });
        }
      } catch {
        // Brain unavailable — never block fix flow.
      }
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

  // Phase 6.2.8 — mutation-driven test strengthening. Runs ONLY on the
  // Nuclear tier ($399). Generates mutation candidates against each
  // fixed source, asks Claude to strengthen the regression test so it
  // catches every mutation. Replaces the weak test with the strong one
  // BEFORE the test gets appended to the fixes array. Non-blocking:
  // any failure leaves the original test intact.
  let strengthenSummary: string | undefined;
  let strengthenedCount = 0;
  if (input.tier === "nuclear" && testGen.tests.length > 0) {
    try {
       
      const { strengthenRegressionTests } = require("@/app/lib/mutation-driven-test-strengthener.js") as {
        strengthenRegressionTests: (opts: {
          fixes: Array<{ file: string; fixed: string; original: string; issues: string[] }>;
          regressionTests: Array<{ path: string; content: string; sourceFile: string }>;
          askClaudeForStrengthen: (prompt: string) => Promise<string>;
        }) => Promise<{
          strengthened: Array<{ path: string; content: string; sourceFile: string; mutationsChecked: number }>;
          skipped: Array<{ sourceFile: string; testPath: string; reason: string; mutationsChecked?: number }>;
          summary: string;
        }>;
      };
      const strengthenResult = await strengthenRegressionTests({
        fixes,
        regressionTests: testGen.tests,
        askClaudeForStrengthen: askClaudeForTest, // same Claude wrapper, different prompt
      });
      // Replace the strengthened tests in-place so the appendix loop
      // below picks up the strong version, not the weak one.
      const strongByPath = new Map(strengthenResult.strengthened.map((s) => [s.path, s]));
      for (const t of testGen.tests) {
        const strong = strongByPath.get(t.path);
        if (strong) {
          t.content = strong.content;
          strengthenedCount += 1;
        }
      }
      for (const s of strengthenResult.skipped) {
        errors.push(`(info) Mutation-strengthen skipped ${s.testPath}: ${s.reason}`);
      }
      strengthenSummary = strengthenResult.summary;
    } catch (err) {
      const message = err instanceof Error ? err.message : "mutation strengthening failed";
      errors.push(`Mutation-driven test strengthening failed: ${message}`);
      strengthenSummary = `mutation-strengthen: failed (${message})`;
    }
  }
  for (const t of testGen.tests) {
    fixes.push({ file: t.path, original: "", fixed: t.content, issues: [`Regression test for ${t.sourceFile}`] });
  }
  for (const s of testGen.skipped) {
    errors.push(`No regression test for ${s.sourceFile}: ${s.reason}`);
  }
  const testGenSummary = testGen.summary;

  // Phase 6.2.7 — property-based test generation per fix. Runs ONLY
  // on the Nuclear tier ($399) so $99/$199 customers don't pay for
  // the extra Claude calls. Property tests sit alongside the
  // regression tests we already write — fuzzers that exercise
  // invariants under random inputs (idempotency, type-shape, edge
  // cases). Non-blocking: any failure here logs into errors[] and
  // ships the fix anyway. This is the differentiator nobody else
  // ships at fix-time.
  let propTestSummary: string | undefined;
  let propTestsWritten = 0;
  if (input.tier === "nuclear") {
    try {
       
      const { generatePropTestsForFixes } = require("@/app/lib/property-test-generator.js") as {
        generatePropTestsForFixes: (opts: {
          fixes: Array<{ file: string; fixed: string; original: string; issues: string[] }>;
          askClaudeForTest: (prompt: string) => Promise<string>;
          maxFixes?: number;
        }) => Promise<{
          tests: Array<{ path: string; content: string; sourceFile: string; language: string }>;
          skipped: Array<{ sourceFile: string; reason: string }>;
          summary: string;
        }>;
      };
      // Only generate prop tests for the ORIGINAL fixes, not the
      // regression-test files we just appended (those start with
      // tests/auto-generated/). Filter by source extension.
      const sourceFixes = fixes.filter((f) => !f.file.startsWith("tests/auto-generated/"));
      const propResult = await generatePropTestsForFixes({
        fixes: sourceFixes,
        askClaudeForTest,
      });
      for (const t of propResult.tests) {
        fixes.push({
          file: t.path,
          original: "",
          fixed: t.content,
          issues: [`Property test for ${t.sourceFile}`],
        });
      }
      for (const s of propResult.skipped) {
        // Property tests are bonus — skip-reasons go in errors as
        // info, not as a "this thing broke" signal.
        errors.push(`(info) No property test for ${s.sourceFile}: ${s.reason}`);
      }
      propTestsWritten = propResult.tests.length;
      propTestSummary = propResult.summary;
    } catch (err) {
      const message = err instanceof Error ? err.message : "property test generation failed";
      errors.push(`Property test generation failed (no property tests added): ${message}`);
      propTestSummary = `property test generation: failed (${message})`;
    }
  }

  // Phase 6.2.10 — performance benchmark before/after on hot-path fixes.
  // Nuclear-tier only ($399). Generates a tinybench file per fix that
  // touches a hot path (loops / await / fetch / regex / DB calls). The
  // file inlines BOTH original and fixed implementations as
  // originalFn / fixedFn so customers run it locally and paste the
  // numbers into the PR. Non-blocking: failures log + ship the fix.
  let benchSummary: string | undefined;
  let benchmarksWritten = 0;
  if (input.tier === "nuclear") {
    try {
       
      const { generateBenchmarksForFixes } = require("@/app/lib/perf-benchmark-generator.js") as {
        generateBenchmarksForFixes: (opts: {
          fixes: Array<{ file: string; fixed: string; original: string; issues: string[] }>;
          askClaudeForBench: (prompt: string) => Promise<string>;
          maxFixes?: number;
        }) => Promise<{
          benchmarks: Array<{ path: string; content: string; sourceFile: string }>;
          skipped: Array<{ sourceFile: string | null; reason: string }>;
          summary: string;
        }>;
      };
      // Source fixes only — exclude the regression-test, property-test,
      // and any other tests/auto-generated/ entries we just appended.
      const sourceFixes = fixes.filter((f) => !f.file.startsWith("tests/auto-generated/"));
      const benchResult = await generateBenchmarksForFixes({
        fixes: sourceFixes,
        askClaudeForBench: askClaudeForTest, // same Claude wrapper, different prompt
      });
      for (const b of benchResult.benchmarks) {
        fixes.push({
          file: b.path,
          original: "",
          fixed: b.content,
          issues: [`Performance benchmark for ${b.sourceFile}`],
        });
      }
      for (const s of benchResult.skipped) {
        errors.push(`(info) No benchmark for ${s.sourceFile || "(unknown)"}: ${s.reason}`);
      }
      benchmarksWritten = benchResult.benchmarks.length;
      benchSummary = benchResult.summary;
    } catch (err) {
      const message = err instanceof Error ? err.message : "benchmark generation failed";
      errors.push(`Benchmark generation failed: ${message}`);
      benchSummary = `benchmark generation: failed (${message})`;
    }
  }

  // Phase 6.2.9 — chaos-test generation. Nuclear-tier only ($399).
  // Generates a node:test file per resilience-relevant fix that mocks
  // fetch / setTimeout / fs to inject failures (slow network, dropped
  // responses, timeouts) and asserts the fix degrades gracefully.
  // Non-blocking: failures log + ship the fix.
  let chaosSummary: string | undefined;
  let chaosTestsWritten = 0;
  if (input.tier === "nuclear") {
    try {
       
      const { generateChaosTestsForFixes } = require("@/app/lib/chaos-test-generator.js") as {
        generateChaosTestsForFixes: (opts: {
          fixes: Array<{ file: string; fixed: string; original: string; issues: string[] }>;
          askClaudeForChaos: (prompt: string) => Promise<string>;
          maxFixes?: number;
        }) => Promise<{
          tests: Array<{ path: string; content: string; sourceFile: string }>;
          skipped: Array<{ sourceFile: string | null; reason: string }>;
          summary: string;
        }>;
      };
      const sourceFixes = fixes.filter((f) => !f.file.startsWith("tests/auto-generated/"));
      const chaosResult = await generateChaosTestsForFixes({
        fixes: sourceFixes,
        askClaudeForChaos: askClaudeForTest,
      });
      for (const t of chaosResult.tests) {
        fixes.push({
          file: t.path,
          original: "",
          fixed: t.content,
          issues: [`Chaos / resilience test for ${t.sourceFile}`],
        });
      }
      for (const s of chaosResult.skipped) {
        errors.push(`(info) No chaos test for ${s.sourceFile || "(unknown)"}: ${s.reason}`);
      }
      chaosTestsWritten = chaosResult.tests.length;
      chaosSummary = chaosResult.summary;
    } catch (err) {
      const message = err instanceof Error ? err.message : "chaos test generation failed";
      errors.push(`Chaos test generation failed: ${message}`);
      chaosSummary = `chaos test generation: failed (${message})`;
    }
  }

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
    // The composer renders header, before/after scan comparison, gate
    // results, per-file attempt history, fixed-files list, regression
    // tests, advisory section, how-it-works, next steps, and footer.
    const totalIssuesFixed = fixes.reduce((sum, f) => sum + f.issues.length, 0);
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
      // Phase 6.1.3 — include before/after content + a precomputed
      // unified-diff string per fix so the customer-facing UI can
      // render inline diffs WITHOUT re-fetching files. Capped at 200KB
      // per file each side to keep the response under Vercel's 4.5MB
      // ceiling even with large fix batches. Anything bigger renders
      // as the "open the PR for the full patch" fallback in DiffViewer.
      fixes: fixes.map((f) => {
        const MAX_BYTES_PER_SIDE = 200 * 1024;
        const before = (f.original || "").slice(0, MAX_BYTES_PER_SIDE);
        const after = (f.fixed || "").slice(0, MAX_BYTES_PER_SIDE);
        return { file: f.file, issues: f.issues, before, after };
      }),
      authSource,
      errors,
      failedFiles,
      syntaxGate: { accepted: syntaxGate.accepted.length, rejected: syntaxGate.rejected.length, summary: syntaxGateSummary },
      scannerGate: scannerGateSummary
        ? { rolledBack: scannerGateRolledBack, summary: scannerGateSummary }
        : { skipped: true, reason: "no successful fixes with original content, or originalFindingsByModule not provided" },
      testGeneration: { testsWritten: testGen.tests.length, skipped: testGen.skipped, summary: testGenSummary },
      propertyTestGeneration: propTestSummary
        ? { testsWritten: propTestsWritten, summary: propTestSummary }
        : { skipped: true, reason: "tier is not nuclear — property tests are a $399-tier value-add" },
      mutationStrengthening: strengthenSummary
        ? { testsStrengthened: strengthenedCount, summary: strengthenSummary }
        : { skipped: true, reason: "tier is not nuclear or no regression tests — mutation strengthening is a $399-tier value-add" },
      perfBenchmarks: benchSummary
        ? { benchmarksWritten, summary: benchSummary }
        : { skipped: true, reason: "tier is not nuclear — perf benchmarks are a $399-tier value-add" },
      chaosTests: chaosSummary
        ? { testsWritten: chaosTestsWritten, summary: chaosSummary }
        : { skipped: true, reason: "tier is not nuclear — chaos tests are a $399-tier value-add" },
      pairReview: pairReviewSummary
        ? { summary: pairReviewSummary }
        : { skipped: true, reason: "tier is not scan_fix — pair review is a $199-tier value-add" },
      architecture: architectureSummary
        ? { summary: architectureSummary }
        : { skipped: true, reason: "tier is not scan_fix or originalFileContents not supplied — architecture annotation is a $199-tier value-add" },
      nuclearEnrichment: nuclearEnrichmentSummary
        ? { summary: nuclearEnrichmentSummary }
        : { skipped: true, reason: "tier is not nuclear — enrichment is a $399-tier value-add" },
      brain: priorArtContext
        ? { used: true, sampleSize: brainSampleSize, summary: `Fix prompts enriched with cross-repo intelligence from ${brainSampleSize} similar-stack scans.` }
        : { used: false, reason: "no similar-stack scans available yet (brain populates as more customers run scans)" },
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
}

