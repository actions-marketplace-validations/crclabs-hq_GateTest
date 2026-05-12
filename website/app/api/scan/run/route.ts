/**
 * Scan Run API — Runs the scan and returns results directly.
 *
 * POST /api/scan/run
 * Body: { sessionId, repoUrl, tier }
 *
 * NO WEBHOOK DEPENDENCY. The client calls this directly after checkout.
 * Returns the scan result in one response. Simple. Fast. Reliable.
 *
 * Also updates Stripe payment intent metadata and captures payment.
 *
 * Honesty contract: every module listed in scan-modules/index.ts does real
 * work. Modules that cannot run return status "skipped" with a reason —
 * never a fake pass.
 */

import { NextRequest, NextResponse } from "next/server";
import https from "https";
import { isAdminRequest } from "@/app/lib/admin-auth";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createLimiter, PRESETS } = require("@lib/rate-limit") as {
  createLimiter: (opts: { windowMs: number; maxRequests: number }) => {
    guard: (req: NextRequest) => Promise<{ allowed: boolean; status?: number; body?: Record<string, unknown>; headers?: Record<string, string> }>;
  };
  PRESETS: Record<string, { windowMs: number; maxRequests: number }>;
};

const _scanRunLimiter = createLimiter(PRESETS.scanRun);
import { fetchBlob, fetchTree, resolveRepoAuth } from "@/app/lib/gluecron-client";
import { runTier, type RepoFile, TIERS } from "@/app/lib/scan-modules";
// Wire contract reference: Gluecron.com/GATETEST_HOOK.md — each repo keeps its
// own copy per the HTTP-only coupling rule.
import { sendGluecronCallback } from "@/app/lib/gluecron-callback";
import { extractIssuesFromModules } from "@/app/lib/issue-extractor";

/** Safe set of tier names — anything outside this set falls back to "quick". */
const KNOWN_TIERS = new Set(Object.keys(TIERS));

// 5-minute function budget — needs Vercel Pro; Hobby cap is 60s.
export const maxDuration = 300;

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const MAX_FILES_TO_READ = 50;
// Leave 30s headroom for Stripe metadata writes and response serialisation.
const SCAN_TIME_BUDGET_MS = 260_000;

function stripeApi(
  method: string,
  path: string,
  body?: string
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const options: https.RequestOptions = {
      hostname: "api.stripe.com",
      port: 443,
      path,
      method,
      headers: {
        Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    };
    if (body) {
      options.headers = {
        ...options.headers,
        "Content-Length": String(Buffer.byteLength(body)),
      };
    }
    const req = https.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8"))); }
        catch { resolve({}); }
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

interface ModuleResult {
  name: string;
  status: "passed" | "failed" | "skipped";
  checks: number;
  issues: number;
  duration: number;
  details?: string[];
  skipped?: string;
}

interface ScanRepoResult {
  modules: ModuleResult[];
  totalIssues: number;
  duration: number;
  authSource?: string | null;
  error?: string;
}

async function scanRepo(owner: string, repo: string, tier: string): Promise<ScanRepoResult> {
  const startTime = Date.now();
  const deadline = startTime + SCAN_TIME_BUDGET_MS;
  // Normalise tier — unknown strings fall back to "quick" explicitly rather
  // than relying on runTier's silent TIERS[tier] || TIERS.quick fallback.
  const normalisedTier = KNOWN_TIERS.has(tier) ? tier : "quick";

  // Resolve Gluecron auth. Gluecron is PAT-only; resolveRepoAuth pings
  // the repo endpoint to confirm the token has access before we attempt
  // the tree fetch.
  const auth = await resolveRepoAuth(owner, repo);
  const token = auth.token || undefined;

  if (!token) {
    return {
      modules: [],
      totalIssues: 0,
      duration: Date.now() - startTime,
      authSource: auth.source,
      error: `Cannot access ${owner}/${repo}${auth.error ? ` (${auth.error})` : ""}`,
    };
  }

  const files = await fetchTree(owner, repo, "HEAD", token);
  if (files.length === 0) {
    return {
      modules: [],
      totalIssues: 0,
      duration: Date.now() - startTime,
      authSource: auth.source,
      error: `Cannot access ${owner}/${repo} — empty tree`,
    };
  }

  const sourceExts = [".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".java", ".rb", ".md", ".json", ".yml", ".yaml"];
  const sourceFiles = files.filter(
    (f) => sourceExts.some((ext) => f.endsWith(ext)) &&
      !f.includes("node_modules") && !f.includes(".next") && !f.includes("dist/")
  );

  // Read source files (up to MAX_FILES_TO_READ) in parallel for speed.
  // Bail early if we are already close to the time budget — better to return
  // whatever we have than to let Vercel kill the function mid-response.
  if (Date.now() > deadline) {
    return { modules: [], totalIssues: 0, duration: Date.now() - startTime, authSource: auth.source, error: "scan timed out fetching file tree" };
  }
  const readPromises = sourceFiles.slice(0, MAX_FILES_TO_READ).map(async (filePath): Promise<RepoFile | null> => {
    try {
      const content = await fetchBlob(owner, repo, filePath, "HEAD", token);
      if (content) {
        return { path: filePath, content };
      }
      return null;
    } catch { return null; }
  });
  const fileContents: RepoFile[] = (await Promise.all(readPromises)).filter((f): f is RepoFile => f !== null);

  // Run the tier through the unified module registry — every module does real work.
  const { modules, totalIssues } = await runTier(normalisedTier, {
    owner,
    repo,
    files,
    fileContents,
    token,
    deadlineMs: deadline,
  });

  return {
    modules,
    totalIssues,
    duration: Date.now() - startTime,
    authSource: auth.source,
  };
}

export async function POST(req: NextRequest) {
  // Outer guard — Node 24 changed unhandledRejection from 'warn' to 'throw'.
  // Any await that escapes the inner try/catch blocks (e.g. an unexpected throw
  // from extractIssuesFromModules or the final NextResponse.json call) must not
  // crash the Vercel function. This outer try/catch is the last resort; the
  // inner guards below are the first line of defence.
  try {
  return await _postImpl(req);
  } catch (outerErr) { // error-ok — outermost guard; inner guards should catch first
    const msg = outerErr instanceof Error ? outerErr.message : String(outerErr);
    console.error("[GateTest] scan/run POST crashed unexpectedly:", msg);
    return NextResponse.json(
      { status: "failed", error: "Scan failed — please try again or contact support." },
      { status: 500 }
    );
  }
}

async function _postImpl(req: NextRequest): Promise<ReturnType<typeof NextResponse.json>> {
  let input: {
    sessionId?: string;
    repoUrl?: string;
    tier?: string;
    source?: string;
    sha?: string;
    ref?: string;
  };
  try {
    input = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const { sessionId, repoUrl, source, sha, ref } = input;
  // Tier from URL/body is UNTRUSTED — a customer can edit the URL to claim
  // a higher tier than they paid for. The authoritative tier is the one
  // stamped on the Stripe payment intent at checkout. We override `tier`
  // below once we've fetched the PI metadata. Admin and non-Stripe paths
  // continue to honour the input tier as before.
  let tier = input.tier;

  if (!repoUrl) {
    return NextResponse.json({ error: "Missing repo URL" }, { status: 400 });
  }

  // Accept gluecron.com URLs first; fall back to github.com for URLs
  // still in customer bookmarks during the migration window.
  const gluecronMatch = repoUrl.match(/gluecron\.com\/([^/]+)\/([^/?#]+)/);
  const githubMatch = repoUrl.match(/github\.com\/([^/]+)\/([^/?#]+)/);
  const repoMatch = gluecronMatch || githubMatch;
  if (!repoMatch) {
    return NextResponse.json({ error: "Invalid repo URL (expected gluecron.com/<owner>/<repo>)" }, { status: 400 });
  }

  const owner = repoMatch[1];
  const repo = repoMatch[2].replace(/\.git$/, "");

  // Admin bypass: if the request carries a valid admin cookie, we skip all
  // Stripe interaction entirely. Admin scans never create or capture charges.
  const isAdmin = isAdminRequest(req);

  // Rate-limit AFTER body parsing + admin check, BEFORE any Gluecron/Stripe calls.
  // Admin requests bypass the limiter — they are internal and authenticated.
  if (!isAdmin) {
    const _rlScanRun = await _scanRunLimiter.guard(req);
    if (!_rlScanRun.allowed) {
      return NextResponse.json(_rlScanRun.body, {
        status: _rlScanRun.status ?? 429,
        headers: _rlScanRun.headers as Record<string, string>,
      });
    }
  }

  // ── Idempotency guard + authoritative tier resolution ────────────
  // /api/scan/run can be invoked multiple times for the same session
  // (browser refresh, back-button, network retry, client re-render,
  // or a concurrent stripe-webhook after() invocation). Without this
  // check a second call would re-run the scan AND re-capture — in
  // the worst case double-charging or overwriting a valid result.
  // The Stripe metadata's `scan_status` is the canonical replay marker.
  //
  // We ALSO use this PI-fetch to resolve the authoritative tier. The URL
  // `tier` param is untrusted (customer can edit it); the PI metadata's
  // `tier` was stamped at checkout creation and cannot be tampered with.
  // If the URL claims a different tier than the customer paid for, we
  // log the attempt and silently honour the paid tier.
  if (!isAdmin && sessionId && STRIPE_SECRET_KEY) {
    try {
      const existing = (await stripeApi(
        "GET",
        `/v1/checkout/sessions/${sessionId}`
      )) as { payment_intent?: string };
      if (existing.payment_intent) {
        const pi = (await stripeApi(
          "GET",
          `/v1/payment_intents/${existing.payment_intent}`
        )) as { metadata?: Record<string, string>; status?: string };

        // Authoritative tier override — silently corrects URL manipulation.
        const paidTier = pi.metadata?.tier;
        if (paidTier && paidTier !== tier) {
          console.warn(
            `[GateTest] Tier mismatch on session ${sessionId.slice(0, 12)}... — URL claimed ${tier || "<none>"}, paid ${paidTier}. Using paid tier.`
          );
          tier = paidTier;
        }

        const prevStatus = pi.metadata?.scan_status;
        if (prevStatus === "complete" || prevStatus === "failed") {
          // Already processed — return the cached state derived from
          // metadata rather than re-running the scan or re-capturing.
          return NextResponse.json({
            status: prevStatus,
            modules: [],
            totalModules: Number(pi.metadata?.total_modules || 0),
            completedModules: Number(pi.metadata?.total_modules || 0),
            totalIssues: Number(pi.metadata?.total_issues || 0),
            totalFixed: 0,
            duration: Number(pi.metadata?.scan_duration || 0),
            repoUrl,
            tier,
            cached: true,
          });
        }
      }
    } catch (err) { // error-ok — idempotency lookup failure must not block the scan
      // Don't block a scan on an idempotency-check lookup failure — log
      // and fall through to the normal scan path.
      console.error("[GateTest] Idempotency check failed:", err);
    }
  }

  // Run the scan — wrap in try/catch so any unexpected throw from scanRepo
  // (e.g. an unhandled rejection inside a module) returns a 500 JSON response
  // instead of crashing the Vercel function (Node 24 unhandledRejection = throw).
  let result: Awaited<ReturnType<typeof scanRepo>>;
  try {
    result = await scanRepo(owner, repo, tier || "quick");
  } catch (err) { // error-ok — top-level scan crash guard; preserves Stripe hold for customer retry
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[GateTest] scanRepo crashed unexpectedly:", msg);
    return NextResponse.json(
      { status: "failed", error: "Scan failed — please try again or contact support." },
      { status: 500 }
    );
  }

  // If we have a session ID AND this is NOT an admin request, update Stripe
  // and capture payment. Admins never touch billing.
  if (!isAdmin && sessionId && STRIPE_SECRET_KEY) {
    try {
      const session = (await stripeApi("GET", `/v1/checkout/sessions/${sessionId}`)) as {
        payment_intent?: string;
      };

      if (session.payment_intent) {
        // Store result in Stripe metadata
        const moduleData = result.modules.map((m) =>
          `${m.name}:${m.status}:${m.checks}:${m.issues}:${m.duration}`
        ).join("|");

        const chunks: string[] = [];
        let current = "";
        for (const entry of moduleData.split("|")) {
          if ((current + "|" + entry).length > 490) { chunks.push(current); current = entry; }
          else { current = current ? current + "|" + entry : entry; }
        }
        if (current) chunks.push(current);

        const params = new URLSearchParams({
          "metadata[scan_status]": result.error ? "failed" : "complete",
          "metadata[total_issues]": String(result.totalIssues),
          "metadata[total_modules]": String(result.modules.length),
          "metadata[scan_duration]": String(result.duration),
          "metadata[scan_completed]": new Date().toISOString(),
          "metadata[modules_list]": result.modules.map((m) => m.name).join(","),
        });
        chunks.forEach((chunk, i) => params.set(`metadata[modules_${i}]`, chunk));

        await stripeApi("POST", `/v1/payment_intents/${session.payment_intent}`, params.toString());

        // Capture or cancel payment
        if (!result.error) {
          await stripeApi("POST", `/v1/payment_intents/${session.payment_intent}/capture`);
        } else {
          await stripeApi("POST", `/v1/payment_intents/${session.payment_intent}/cancel`);
        }
      }
    } catch (err) { // error-ok — Stripe metadata update is best-effort; scan result already computed
      console.error("[GateTest] Stripe update failed:", err);
    }
  }

  // Async scan-result callback to Gluecron. Fires only when the inbound
  // request was originated by Gluecron (source === "gluecron") AND both
  // env vars are configured. Failure here MUST NOT break the sync response.
  if (
    source === "gluecron" &&
    process.env.GLUECRON_CALLBACK_URL &&
    process.env.GLUECRON_CALLBACK_SECRET
  ) {
    try {
      await sendGluecronCallback({
        repository: `${owner}/${repo}`,
        sha: sha || "",
        ref,
        scanResult: result,
      });
    } catch (err) { // error-ok — callback failure must not break the synchronous scan response
      console.error("[GateTest] Gluecron callback failed:", err);
    }
  }

  // Build structured fixable-issue list from module details for the Fix Agent.
  // Uses the shared extractor (issue-extractor.ts) which handles Dockerfile
  // findings, package.json sub-key shapes, and all severity-prefix variants
  // that the old inline regex silently dropped (~39% of findings).
  // failedOnly: false — include skipped modules' details so nothing is lost.
  const { fixable: fixableIssues } = extractIssuesFromModules(
    result.modules.map((m) => ({ name: m.name, status: m.status, details: m.details })),
    { failedOnly: false }
  );

  return NextResponse.json({
    status: result.error ? "failed" : "complete",
    modules: result.modules,
    totalModules: result.modules.length,
    completedModules: result.modules.length,
    totalIssues: result.totalIssues,
    totalFixed: 0,
    duration: result.duration,
    repoUrl,
    tier,
    admin: isAdmin,
    authSource: result.authSource,
    error: result.error,
    fixableIssues,
  });
}
