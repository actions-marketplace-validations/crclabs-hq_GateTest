/**
 * Scan executor — shared scan-runner used by the webhook async handler.
 *
 * Delegates the actual module execution to the unified module registry in
 * app/lib/scan-modules — the same code path that /api/scan/run uses. That
 * way there's exactly one place where modules are defined and honesty
 * rules (real work or honest skip) are enforced.
 *
 * Idempotency: the caller passes a jobId (derived from the Stripe session id)
 * and we check whether the payment intent metadata already records this job
 * before capturing/cancelling. This guarantees a Stripe webhook retry cannot
 * double-capture a customer.
 */

import https from "https";
import { getDb } from "./db";
import { fetchBlob, fetchTree, resolveRepoAuth } from "./gluecron-client";
import { runTier, type RepoFile, TIERS } from "./scan-modules";

/** Safe set of tier names — anything outside this set falls back to "quick". */
const KNOWN_TIERS = new Set(Object.keys(TIERS));

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const MAX_FILES_TO_READ = 50;

export interface ScanModuleResult {
  name: string;
  status: "passed" | "failed" | "skipped";
  checks: number;
  issues: number;
  duration: number;
  details?: string[];
  skipped?: string;
}

export interface ScanResult {
  status: "complete" | "failed";
  modules: ScanModuleResult[];
  totalModules: number;
  completedModules: number;
  totalIssues: number;
  totalFixed: number;
  duration: number;
  authSource?: string | null;
  error?: string;
}

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
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
        } catch {
          resolve({});
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error("Stripe request timed out"));
    });
    if (body) req.write(body);
    req.end();
  });
}

function emptyResult(startTime: number, error: string, authSource?: string | null): ScanResult {
  return {
    status: "failed",
    modules: [],
    totalModules: 0,
    completedModules: 0,
    totalIssues: 0,
    totalFixed: 0,
    duration: Date.now() - startTime,
    authSource: authSource ?? null,
    error,
  };
}

/**
 * Execute a scan from directly-provided files (no GitHub fetch).
 * Used by platforms like Zoobicon that POST file contents to the API.
 */
export async function runScanDirect(
  files: RepoFile[],
  tier: string,
  projectName?: string
): Promise<ScanResult> {
  const startTime = Date.now();

  if (!files || files.length === 0) {
    return emptyResult(startTime, "No files provided");
  }

  const capped = files.slice(0, MAX_FILES_TO_READ);
  const filePaths = capped.map((f) => f.path);
  const normalisedTier = KNOWN_TIERS.has(tier) ? tier : "quick";

  const { modules, totalIssues } = await runTier(normalisedTier, {
    owner: projectName || "direct",
    repo: projectName || "upload",
    files: filePaths,
    fileContents: capped,
  });

  return {
    status: "complete",
    modules,
    totalModules: modules.length,
    completedModules: modules.length,
    totalIssues,
    totalFixed: 0,
    duration: Date.now() - startTime,
    authSource: "direct",
  };
}

/**
 * Execute the scan for a repo + tier. Returns a ScanResult (never throws).
 */
export async function runScan(
  repoUrl: string,
  tier: string
): Promise<ScanResult> {
  const startTime = Date.now();

  // Accept Gluecron URLs first; fall back to GitHub URLs so customer-supplied
  // links work in either form during the migration window.
  const gluecronMatch = repoUrl.match(/gluecron\.com\/([^/]+)\/([^/?#]+)/);
  const githubMatch = repoUrl.match(/github\.com\/([^/]+)\/([^/?#]+)/);
  const repoMatch = gluecronMatch || githubMatch;
  if (!repoMatch) {
    return emptyResult(startTime, "Invalid repository URL (expected gluecron.com/<owner>/<repo>)");
  }

  const owner = repoMatch[1];
  const repo = repoMatch[2].replace(/\.git$/, "");

  const auth = await resolveRepoAuth(owner, repo);
  const token = auth.token || undefined;

  if (!token) {
    return emptyResult(
      startTime,
      `Cannot access repository ${owner}/${repo}${auth.error ? ` (${auth.error})` : ""}`,
      auth.source
    );
  }

  // Gluecron uses a defaultBranch by convention — we fetch the tree at HEAD
  // and let Gluecron resolve the ref server-side.
  const files = await fetchTree(owner, repo, "HEAD", token);
  if (files.length === 0) {
    return emptyResult(
      startTime,
      `Cannot access repository ${owner}/${repo} — empty tree returned`,
      auth.source
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

  // Read file contents in parallel via the Gluecron contents endpoint.
  const readPromises = sourceFiles
    .slice(0, MAX_FILES_TO_READ)
    .map(async (filePath): Promise<RepoFile | null> => {
      try {
        const content = await fetchBlob(owner, repo, filePath, "HEAD", token);
        if (content) {
          return { path: filePath, content };
        }
        return null;
      } catch {
        return null;
      }
    });
  const fileContents: RepoFile[] = (await Promise.all(readPromises)).filter((f): f is RepoFile => f !== null);

  const normalisedTier = KNOWN_TIERS.has(tier) ? tier : "quick";
  const { modules, totalIssues } = await runTier(normalisedTier, {
    owner,
    repo,
    files,
    fileContents,
    token,
  });

  return {
    status: "complete",
    modules,
    totalModules: modules.length,
    completedModules: modules.length,
    totalIssues,
    totalFixed: 0,
    duration: Date.now() - startTime,
    authSource: auth.source,
  };
}

/**
 * Run a scan job and update Stripe, idempotently. Safe to call multiple times
 * with the same jobId — the second call is a no-op because metadata.scan_job_id
 * is already recorded on the payment intent.
 */
export async function runScanJob(params: {
  jobId: string;
  paymentIntentId: string;
  repoUrl: string;
  tier: string;
  scanId?: string;
  customerEmail?: string;
  tierPriceUsd?: number;
}): Promise<{ skipped: boolean; reason?: string; result?: ScanResult }> {
  const { jobId, paymentIntentId, repoUrl, tier, scanId, customerEmail, tierPriceUsd } = params;

  if (!STRIPE_SECRET_KEY) {
    return { skipped: true, reason: "stripe_not_configured" };
  }

  // Idempotency check — has this exact job already been processed?
  try {
    const pi = (await stripeApi(
      "GET",
      `/v1/payment_intents/${paymentIntentId}`
    )) as { metadata?: Record<string, string>; status?: string };
    const existingJob = pi.metadata?.scan_job_id;
    const terminalStatuses = ["succeeded", "canceled"];
    if (
      existingJob === jobId ||
      (pi.status && terminalStatuses.includes(pi.status))
    ) {
      return { skipped: true, reason: "already_processed" };
    }
  } catch (err) { // error-ok — idempotency check failure must not block the scan
    console.error("[GateTest] Idempotency check failed:", err);
    // Proceed — we'd rather run the scan than double-cancel a live hold.
  }

  // Stamp the job id FIRST. If anything below fails, a retry will still see
  // this stamp and skip. We re-stamp the final status at the end.
  try {
    await stripeApi(
      "POST",
      `/v1/payment_intents/${paymentIntentId}`,
      new URLSearchParams({
        "metadata[scan_job_id]": jobId,
        "metadata[scan_status]": "running",
      }).toString()
    );
  } catch (err) { // error-ok — job-stamp failure is not fatal; scan still runs
    console.error("[GateTest] Failed to stamp job id:", err);
  }

  let result: ScanResult;
  try {
    result = await runScan(repoUrl, tier);
  } catch (err) {
    result = {
      status: "failed",
      modules: [],
      totalModules: 0,
      completedModules: 0,
      totalIssues: 0,
      totalFixed: 0,
      duration: 0,
      error: `Scan crashed: ${(err as Error).message}`,
    };
  }

  // Write results to Stripe metadata.
  try {
    const modulesSummary = result.modules
      .map((m) => `${m.name}:${m.status}:${m.checks}:${m.issues}:${m.duration}`)
      .join("|");

    const updateParams = new URLSearchParams({
      "metadata[scan_job_id]": jobId,
      "metadata[scan_status]": result.status,
      "metadata[total_issues]": String(result.totalIssues),
      "metadata[total_modules]": String(result.totalModules),
      "metadata[total_fixed]": String(result.totalFixed),
      "metadata[scan_duration]": String(result.duration),
      "metadata[scan_completed]": new Date().toISOString(),
      "metadata[modules_list]": result.modules.map((m) => m.name).join(","),
    });

    const chunks: string[] = [];
    let current = "";
    for (const entry of modulesSummary.split("|")) {
      if ((current + "|" + entry).length > 490) {
        chunks.push(current);
        current = entry;
      } else {
        current = current ? current + "|" + entry : entry;
      }
    }
    if (current) chunks.push(current);
    chunks.forEach((chunk, i) => {
      updateParams.set(`metadata[modules_${i}]`, chunk);
    });

    if (result.error) {
      updateParams.set("metadata[scan_error]", result.error.slice(0, 500));
    }

    await stripeApi(
      "POST",
      `/v1/payment_intents/${paymentIntentId}`,
      updateParams.toString()
    );
  } catch (err) { // error-ok — metadata update is best-effort; capture/cancel still proceeds
    console.error("[GateTest] Stripe metadata update failed:", err);
  }

  // Update the database with scan results
  if (scanId) {
    try {
      const sql = getDb();
      const score = result.totalIssues === 0
        ? 100
        : Math.max(0, 100 - result.totalIssues * 5);
      const dbStatus = result.status === "complete" && !result.error ? "completed" : "failed";
      const resultsJson = JSON.stringify(result.modules);
      const modulesRun = result.modules.map((m) => m.name);
      const summaryText = result.error || `${result.totalModules} modules, ${result.totalIssues} issues`;
      const durationMs = result.duration;

      await sql`UPDATE scans SET
        status = ${dbStatus},
        results = ${resultsJson}::jsonb,
        score = ${score},
        duration_ms = ${durationMs},
        modules_run = ${modulesRun},
        completed_at = NOW(),
        started_at = COALESCE(started_at, created_at),
        summary = ${summaryText}
      WHERE id = ${scanId}`;

      // Update customer stats
      if (customerEmail && result.status === "complete" && !result.error) {
        const spent = tierPriceUsd || 0;
        await sql`UPDATE customers SET
          total_scans = total_scans + 1,
          total_spent_usd = total_spent_usd + ${spent}
        WHERE email = ${customerEmail}`;
      }
    } catch (dbErr) { // error-ok — DB update is best-effort; Stripe metadata is the source of truth
      console.error("[GateTest] DB update failed (scan-executor):", dbErr);
    }
  }

  // Capture on success, cancel on failure. Both are idempotent on Stripe's
  // side for a PI already in a terminal state — Stripe returns an error we
  // log and swallow.
  try {
    if (result.status === "complete" && !result.error) {
      await stripeApi(
        "POST",
        `/v1/payment_intents/${paymentIntentId}/capture`
      );
    } else {
      await stripeApi(
        "POST",
        `/v1/payment_intents/${paymentIntentId}/cancel`
      );
    }
  } catch (err) { // error-ok — Stripe PI already in terminal state is idempotent; log and move on
    console.error("[GateTest] Stripe capture/cancel failed:", err);
  }

  return { skipped: false, result };
}
