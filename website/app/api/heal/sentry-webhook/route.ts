/**
 * Sentry → Auto-Heal Webhook
 *
 * POST /api/heal/sentry-webhook
 *
 * Receives Sentry issue alert webhooks. When a new production error fires,
 * this route:
 *   1. Verifies the HMAC-SHA256 signature (fails closed if unset)
 *   2. Extracts file, line, error type, message, and stack frames
 *   3. Asks Claude to diagnose root cause and generate a patch
 *   4. Persists the diagnosis in heal_log for the dashboard
 *   5. If GATETEST_GITHUB_TOKEN is present, opens a GitHub issue with
 *      the diagnosis + patch — error → fix in < 60s
 *
 * Configure in Sentry: Project Settings → Integrations → Webhooks → add URL.
 * Set SENTRY_WEBHOOK_SECRET_HEAL to the secret Sentry shows.
 */

import { NextRequest, NextResponse } from "next/server";
import { createHmac } from "crypto";
import { neon } from "@neondatabase/serverless";

const SENTRY_WEBHOOK_SECRET = process.env.SENTRY_WEBHOOK_SECRET_HEAL || "";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const GITHUB_TOKEN = process.env.GATETEST_GITHUB_TOKEN || process.env.GITHUB_TOKEN || "";

// ─────────────────────────────────────────────────────────────────────────────
// Signature verification
// ─────────────────────────────────────────────────────────────────────────────

function verifySignature(body: string, header: string | null): boolean {
  if (!SENTRY_WEBHOOK_SECRET) return false;
  if (!header) return false;
  const expected = createHmac("sha256", SENTRY_WEBHOOK_SECRET)
    .update(body, "utf-8")
    .digest("hex");
  return header === expected;
}

// ─────────────────────────────────────────────────────────────────────────────
// Payload extraction
// ─────────────────────────────────────────────────────────────────────────────

interface SentryFrame {
  filename?: string;
  absPath?: string;
  lineno?: number;
  function?: string;
  inApp?: boolean;
}

interface HealTarget {
  errorType: string;
  message: string;
  culprit: string;
  file: string;
  lineno: number | null;
  functionName: string;
  frames: SentryFrame[];
  issueUrl: string;
  issueTitle: string;
  repoName: string | null;
  sentryIssueId: string;
}

function extractHealTarget(payload: Record<string, unknown>): HealTarget | null {
  const data = payload.data as Record<string, unknown> | undefined;
  const issue = (data?.issue || payload.issue) as Record<string, unknown> | undefined;
  if (!issue) return null;

  const meta = (issue.metadata || {}) as Record<string, string>;
  const title = String(issue.title || "");
  const culprit = String(issue.culprit || "");
  const permalink = String(issue.permalink || issue.url || "");
  const issueId = String(issue.id || "");

  // Extract frames from the latest event if present
  const event = issue.lastEvent as Record<string, unknown> | undefined;
  const exception = (event?.exception as Record<string, unknown> | undefined)?.values as unknown[] | undefined;
  let frames: SentryFrame[] = [];
  if (exception && exception.length > 0) {
    const exc = exception[exception.length - 1] as Record<string, unknown>;
    frames = ((exc.stacktrace as Record<string, unknown> | undefined)?.frames as SentryFrame[]) || [];
  }

  const inAppFrames = frames.filter(f => f.inApp !== false && f.filename);
  const topFrame: SentryFrame = inAppFrames[inAppFrames.length - 1] || frames[frames.length - 1] || {};

  const projectSlug = (issue.project as Record<string, string> | undefined)?.slug || null;

  return {
    errorType: meta.type || title.split(":")[0] || "Error",
    message: meta.value || title,
    culprit,
    file: topFrame.filename || topFrame.absPath || meta.filename || culprit.split(" in ")[0] || "",
    lineno: topFrame.lineno || null,
    functionName: topFrame.function || meta.function || culprit.split(" in ")[1] || "",
    frames: inAppFrames.slice(-5),
    issueUrl: permalink,
    issueTitle: title,
    repoName: projectSlug,
    sentryIssueId: issueId,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Claude diagnosis via raw fetch
// ─────────────────────────────────────────────────────────────────────────────

async function diagnoseWithClaude(target: HealTarget): Promise<{ diagnosis: string; patch: string; confidence: string }> {
  const frameContext = target.frames
    .map(f => `  ${f.filename || "?"}:${f.lineno || "?"}  in ${f.function || "?"}`)
    .join("\n");

  const userContent = `A production error just fired. Diagnose root cause and provide a fix.

ERROR
Type: ${target.errorType}
Message: ${target.message}
File: ${target.file}${target.lineno ? `:${target.lineno}` : ""}
Function: ${target.functionName}
Culprit: ${target.culprit}

STACK FRAMES (innermost last)
${frameContext || "  (no frame data)"}

Reply with:
DIAGNOSIS: <2-3 sentences on root cause>
PATCH:
\`\`\`
<minimal code fix or precise description>
\`\`\`
CONFIDENCE: <LOW|MEDIUM|HIGH>`;

  const body = JSON.stringify({
    model: "claude-opus-4-7",
    max_tokens: 1024,
    messages: [{ role: "user", content: userContent }],
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": ANTHROPIC_API_KEY,
      },
      body,
      signal: controller.signal,
    });

    if (!res.ok) return { diagnosis: "Diagnosis unavailable", patch: "", confidence: "LOW" };

    const json = await res.json() as { content?: { type: string; text: string }[] };
    const text = (json.content || []).filter(b => b.type === "text").map(b => b.text).join("");

    const diagMatch = text.match(/DIAGNOSIS:\s*([\s\S]*?)(?=PATCH:|CONFIDENCE:|$)/i);
    const patchMatch = text.match(/PATCH:\s*```[\w]*\n([\s\S]*?)```/i) ||
      text.match(/PATCH:\s*([\s\S]*?)(?=CONFIDENCE:|$)/i);
    const confMatch = text.match(/CONFIDENCE:\s*(LOW|MEDIUM|HIGH)/i);

    return {
      diagnosis: diagMatch?.[1]?.trim() || text.slice(0, 400),
      patch: patchMatch?.[1]?.trim() || "",
      confidence: confMatch?.[1]?.toUpperCase() || "LOW",
    };
  } finally {
    clearTimeout(timer);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GitHub issue creation
// ─────────────────────────────────────────────────────────────────────────────

async function createGitHubIssue(target: HealTarget, diagnosis: string, patch: string): Promise<string | null> {
  if (!GITHUB_TOKEN || !target.repoName) return null;

  const body = [
    `## 🔥 Production Error — Auto-diagnosed by GateTest`,
    ``,
    `**Sentry Issue:** ${target.issueUrl || "N/A"}`,
    `**File:** \`${target.file}${target.lineno ? `:${target.lineno}` : ""}\``,
    `**Function:** \`${target.functionName}\``,
    ``,
    `### Root Cause`,
    diagnosis,
    ``,
    `### Suggested Fix`,
    "```",
    patch || "(see diagnosis above)",
    "```",
    ``,
    `---`,
    `*Auto-generated by [GateTest](https://gatetest.ai) self-heal — Sentry issue \`${target.sentryIssueId}\`*`,
  ].join("\n");

  try {
    const res = await fetch(`https://api.github.com/repos/${target.repoName}/issues`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "GateTest/1.0",
      },
      body: JSON.stringify({
        title: `[GateTest Auto-Heal] ${target.issueTitle}`,
        body,
        labels: ["bug", "gatetest-auto-heal"],
      }),
    });
    if (!res.ok) return null;
    const json = await res.json() as { html_url?: string };
    return json.html_url || null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DB persistence (non-blocking)
// ─────────────────────────────────────────────────────────────────────────────

async function persistHealLog(target: HealTarget, diagnosis: string, patch: string, confidence: string, githubUrl: string | null, durationMs: number) {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) return;
  try {
    const sql = neon(dbUrl);
    await sql`
      CREATE TABLE IF NOT EXISTS heal_log (
        id          BIGSERIAL PRIMARY KEY,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        sentry_id   TEXT,
        repo_name   TEXT,
        error_type  TEXT,
        file_path   TEXT,
        diagnosis   TEXT,
        patch       TEXT,
        confidence  TEXT,
        github_url  TEXT,
        duration_ms INT
      )
    `;
    await sql`
      INSERT INTO heal_log (sentry_id, repo_name, error_type, file_path, diagnosis, patch, confidence, github_url, duration_ms)
      VALUES (
        ${target.sentryIssueId}, ${target.repoName}, ${target.errorType},
        ${target.file}, ${diagnosis}, ${patch},
        ${confidence}, ${githubUrl}, ${durationMs}
      )
    `;
  } catch { /* non-blocking */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const sig = req.headers.get("sentry-hook-signature");

  if (!verifySignature(rawBody, sig)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Only process new error issues
  const action = payload.action as string | undefined;
  if (action !== "created" && action !== "triggered") {
    return NextResponse.json({ ok: true, skipped: true, reason: `action=${action}` });
  }

  const target = extractHealTarget(payload);
  if (!target) {
    return NextResponse.json({ ok: true, skipped: true, reason: "no issue data" });
  }

  if (!ANTHROPIC_API_KEY) {
    return NextResponse.json({ ok: true, skipped: true, reason: "ANTHROPIC_API_KEY not set" });
  }

  const t0 = Date.now();
  let diagnosis = "";
  let patch = "";
  let confidence = "LOW";
  let githubIssueUrl: string | null = null;

  try {
    ({ diagnosis, patch, confidence } = await diagnoseWithClaude(target));
    githubIssueUrl = await createGitHubIssue(target, diagnosis, patch);
    await persistHealLog(target, diagnosis, patch, confidence, githubIssueUrl, Date.now() - t0);
  } catch {
    // Non-blocking — signature was verified, Sentry must not retry on our failures
  }

  return NextResponse.json({
    ok: true,
    healed: true,
    file: target.file,
    diagnosis: diagnosis.slice(0, 200),
    confidence,
    githubIssueUrl,
    durationMs: Date.now() - t0,
  });
}
