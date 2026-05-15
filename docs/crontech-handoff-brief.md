# Crontech-side implementation brief — copy/paste this into the Crontech Claude session

> **Instructions for Craig:** Open a Claude Code session in the Crontech repo, paste everything below (from `## Task` to the end of this file). The Crontech Claude has all the context it needs.

---

## Task

GateTest shipped its side of a worker-tier integration with Crontech in PR #80 (branch `feat/crontech-headless-worker`). GateTest needs Crontech to run Playwright/Chromium for `/api/web/scan` runtime checks — Vercel-style serverless can't launch Chromium reliably.

This is the **interim** integration. Crontech's own 7-day plan (Day 2: *"Onboard GateTest as canary customer via the wizard"*) ends with GateTest deploying as a Crontech tenant through BLK-009 customer-deploys. That eventually obsoletes this worker handoff because Chromium will be local. **But the interim worker is still worth shipping** so the runtime-errors capability is real in production before the full migration lands.

## Crontech stack reminders (this code MUST honor)

- **Bun** 1.3+, ESM imports only (no `require()`).
- **Hono** for HTTP routing, **tRPC v11** for typed procedures, **Drizzle ORM** for DB.
- **Biome** for lint/format (NOT ESLint/Prettier). `bunx biome check .` must pass.
- **`bun:test`** for tests (NOT `node:test`).
- Strict TS: no `any`, no `@ts-ignore`, `exactOptionalPropertyTypes: true`, `noUncheckedIndexedAccess: true`.
- Schemas live in `packages/schemas/`. Drizzle schemas in `packages/db/`.
- Quality gates: `bun run check` 61/61 packages, `bun run check-links` 0 dead, `bun run check-buttons` 0 dead, `bun run db:validate` clean, `bun run test` green.
- **Polite tone** — never name competitors in public copy (build-time enforcement via `apps/web/src/data/products/forbidden.ts`).

## Where it should live

Best fit candidates (Crontech Claude can choose):

- **`services/web-runtime-worker/`** — new service alongside `customer-deploys`, `preview-deploys`, `cron-scheduler`. Cleanest because the work is bounded (one job type).
- **`services/orchestrator/`** — already does build-sandboxing in Docker-isolated containers. The Playwright capture could be one of its job types.
- **`services/edge-runtime/`** — if Crontech wants this to eventually run in V8 isolates (planned BLK).

Recommended: standalone `services/web-runtime-worker/` for now; refactor into orchestrator if the patterns converge.

## Mounting

Two options for the inbound endpoint — Crontech Claude picks:

1. **Hono route** at `apps/api/src/routes/jobs/web-runtime-scan.ts` — simpler, matches existing webhook patterns (`apps/api/src/webhooks/{gluecron,github}-push.ts`).
2. **tRPC procedure** at `apps/api/src/trpc/procedures/gateTest.scheduleWebRuntimeScan.ts` — more type-safe but adds friction for a webhook from outside the tRPC client.

Recommended: **Hono route**. GateTest dispatches via raw fetch (it doesn't import Crontech's tRPC client), so a Hono route keeps the contract clean.

---

## The contract you must implement

### 1. Inbound endpoint — receives a job from GateTest

```
POST {CRONTECH_BASE_URL}/api/jobs/web-runtime-scan

Headers:
  Authorization:        Bearer {token-you-issue-to-gatetest}
  X-GateTest-Signature: hex(hmac-sha256(GATETEST_DISPATCH_SECRET, raw_body))
  X-GateTest-Timestamp: <unix-seconds>
  Content-Type:         application/json

Body:
  {
    "scanId":      "scn_xxxxxxxxxxxxxxxxxx",   // 18-hex-char token
    "targetUrl":   "https://customer-site.example",
    "suite":       "web" | "wp",
    "callbackUrl": "https://gatetest.ai/api/web/scan/runtime-callback",
    "deadlineSec": 60
  }

Success response:  201 { "jobId": "crontech-job-...", "queuedAt": "ISO-8601" }
Failure response:  4xx { "error": "..." }
```

**Required behavior:**
- Verify `X-GateTest-Signature` against `GATETEST_DISPATCH_SECRET` BEFORE doing any work (fail-closed — missing/invalid → 401).
- Reject timestamps older than ±5 minutes (replay protection).
- Verify `Authorization` Bearer matches the API token Crontech issued to GateTest.
- Idempotency: a duplicate `scanId` returns 200 with the existing `jobId`.
- Enqueue the job into Crontech's worker pool, return 201 with the job id.

Validate body with **Zod** in `packages/schemas/` (e.g. `webRuntimeScanRequest.schema.ts`).

### 2. Worker — runs Playwright, captures runtime events

```
For each queued job, in a Crontech worker container with chromium available:

1. Launch playwright.chromium with { headless: true, timeout: 15000 }
2. Open a new context: { ignoreHTTPSErrors: false, viewport 1280x800, userAgent "GateTest/1.0 (+https://gatetest.ai/bot)" }
3. Attach listeners for:
   - page.on('pageerror')      → "runtime-errors:page-error"   (severity: error)
   - page.on('console')        → "runtime-errors:console-error"/("console-warning"), plus CSP/mixed-content/hydration heuristics
   - page.on('requestfailed')  → "runtime-errors:network"      (severity: error for document/script, warning for asset)
   - page.on('response')       → status >= 400 → "runtime-errors:network"
4. Navigate to body.targetUrl with timeout: body.deadlineSec * 1000, waitUntil: 'networkidle'
5. If navigation throws  → status: "failed", error: err.message
6. If navigation succeeds → collect findings into the callback payload
7. Close the browser
8. POST the result to body.callbackUrl (see section 3)
```

**Heuristic rules (mirror these from GateTest's `src/modules/runtime-errors.js`):**
```ts
const CSP_HINT          = /content security policy|csp directive|refused to (?:execute|load|connect|frame)/i;
const MIXED_CONTENT     = /mixed content/i;
const HYDRATION_HINTS   = [
  /hydration mismatch/i,
  /text content does not match/i,
  /hydration failed/i,
  /did not match.*server/i,
  /minified react error/i,
  /uncaught \(in promise\)/i,
  /\[vue warn\]/i,
  /\[nuxt\]/i,
];
```

Console-error text matching `CSP_HINT` also produces a `runtime-errors:csp-violation` finding (in addition to the `console-error`). Same for mixed-content and hydration.

### 3. Outbound callback — POST results back to GateTest

```
POST {body.callbackUrl}          (always https://gatetest.ai/api/web/scan/runtime-callback)

Headers:
  X-GateTest-Signature: hex(hmac-sha256(GATETEST_DISPATCH_SECRET, raw_body))
  X-GateTest-Timestamp: <unix-seconds>
  Content-Type:         application/json

Body (success):
  {
    "scanId":     "<same as inbound>",
    "status":     "completed",
    "durationMs": 4321,
    "findings": [
      { "name": "runtime-errors:page-error",     "severity": "error",   "passed": false, "message": "Uncaught TypeError: foo is not a function" },
      { "name": "runtime-errors:console-error",  "severity": "warning", "passed": false, "message": "console.error during load: ..." },
      { "name": "runtime-errors:network",        "severity": "error",   "passed": false, "message": "GET https://...js → net::ERR_ABORTED (script)" },
      { "name": "runtime-errors:csp-violation",  "severity": "error",   "passed": false, "message": "CSP violation: Refused to execute inline script..." },
      { "name": "runtime-errors:mixed-content",  "severity": "warning", "passed": false, "message": "Mixed content blocked: http://img.example/x.png" },
      { "name": "runtime-errors:hydration",      "severity": "warning", "passed": false, "message": "Possible hydration mismatch: ..." },
      { "name": "runtime-errors:summary",        "severity": "info",    "passed": true,  "message": "runtime checked https://...  → 2 page errors, 5 console errors, 1 network failure, 0 CSP, 0 mixed-content, 0 hydration hints." }
    ]
  }

Body (failure):
  {
    "scanId":     "<same as inbound>",
    "status":     "failed",
    "durationMs": 16000,
    "findings":   [],
    "error":      "Browser navigation timed out after 60s"
  }
```

**Retry policy:** If GateTest's callback returns 5xx, retry up to 3 times with exponential backoff (2s, 4s, 8s). Drop on 4xx (don't retry — GateTest considers it a permanent reject).

**Same secret both directions:** the outbound HMAC uses the SAME `GATETEST_DISPATCH_SECRET` value. Symmetric.

---

## Env vars Crontech needs

| Variable                       | Value                                                         |
| ------------------------------ | ------------------------------------------------------------- |
| `GATETEST_DISPATCH_SECRET`     | Shared HMAC secret. Generate with `openssl rand -hex 32`. Must match `CRONTECH_DISPATCH_SECRET` on the GateTest/Vercel side. |
| `GATETEST_API_TOKEN`           | (Future) GateTest's PAT for any reverse calls Crontech makes  |
| `GATETEST_CALLBACK_TIMEOUT_MS` | Default 10000. How long to wait for the GateTest callback to ack. |

---

## Drop-in HMAC code (Bun / ESM)

Crontech uses this verbatim — same algorithm GateTest uses, so digests match exactly. Bun supports `node:crypto` 1:1.

```ts
import crypto from "node:crypto";

export function signBody(body: string, secret: string): string {
  if (typeof body !== "string") throw new TypeError("signBody: body must be a string");
  if (typeof secret !== "string" || !secret) throw new Error("signBody: secret is required");
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

export function verifySignature(
  body: string,
  providedSignature: string | null | undefined,
  secret: string
): boolean {
  if (typeof body !== "string") return false;
  if (typeof providedSignature !== "string" || !providedSignature) return false;
  if (typeof secret !== "string" || !secret) return false;
  const expected = signBody(body, secret);
  if (expected.length !== providedSignature.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(providedSignature));
  } catch {
    return false;
  }
}
```

---

## Playwright capture loop (Bun / TS, strict)

```ts
import { chromium, type Browser, type BrowserContext } from "playwright";

interface CapturedRuntime {
  pageErrors: Array<{ message: string; stack: string | null }>;
  consoleErrors: Array<{ text: string }>;
  consoleWarnings: Array<{ text: string }>;
  requestFailures: Array<{ url: string; method: string; reason: string; resourceType: string }>;
  cspViolations: Array<{ text: string }>;
  mixedContent: Array<{ text: string }>;
  hydration: Array<{ text: string }>;
  deprecations: Array<{ text: string }>;
  navigationFailure: string | null;
  status: number | null;
}

interface Finding {
  name: string;
  severity: "error" | "warning" | "info";
  passed: boolean;
  message: string;
}

const CSP_HINT = /content security policy|csp directive|refused to (?:execute|load|connect|frame)/i;
const MIXED = /mixed content/i;
const HYDRATION = [
  /hydration mismatch/i,
  /text content does not match/i,
  /hydration failed/i,
  /did not match.*server/i,
  /minified react error/i,
  /uncaught \(in promise\)/i,
  /\[vue warn\]/i,
  /\[nuxt\]/i,
];

export async function captureRuntime(
  targetUrl: string,
  deadlineSec: number
): Promise<CapturedRuntime> {
  const captured: CapturedRuntime = {
    pageErrors: [], consoleErrors: [], consoleWarnings: [],
    requestFailures: [], cspViolations: [], mixedContent: [],
    hydration: [], deprecations: [],
    navigationFailure: null, status: null,
  };

  const browser: Browser = await chromium.launch({ headless: true, timeout: 15000 });
  const ctx: BrowserContext = await browser.newContext({
    ignoreHTTPSErrors: false,
    viewport: { width: 1280, height: 800 },
    userAgent: "GateTest/1.0 (+https://gatetest.ai/bot)",
  });
  const page = await ctx.newPage();

  page.on("pageerror", (err) => {
    captured.pageErrors.push({
      message: typeof err.message === "string" ? err.message : String(err),
      stack: typeof err.stack === "string" ? err.stack.split("\n").slice(0, 5).join("\n") : null,
    });
  });

  page.on("console", (msg) => {
    const text = msg.text();
    const type = msg.type();
    if (type === "error") {
      captured.consoleErrors.push({ text: text.slice(0, 500) });
      if (CSP_HINT.test(text)) captured.cspViolations.push({ text: text.slice(0, 500) });
      if (MIXED.test(text)) captured.mixedContent.push({ text: text.slice(0, 500) });
      if (HYDRATION.some((re) => re.test(text))) captured.hydration.push({ text: text.slice(0, 500) });
    } else if (type === "warning") {
      captured.consoleWarnings.push({ text: text.slice(0, 500) });
      if (CSP_HINT.test(text)) captured.cspViolations.push({ text: text.slice(0, 500) });
      if (MIXED.test(text)) captured.mixedContent.push({ text: text.slice(0, 500) });
      if (/deprecated/i.test(text)) captured.deprecations.push({ text: text.slice(0, 500) });
    }
  });

  page.on("requestfailed", (req) => {
    const failure = req.failure();
    captured.requestFailures.push({
      url: req.url().slice(0, 300),
      method: req.method(),
      reason: failure ? failure.errorText : "unknown",
      resourceType: req.resourceType(),
    });
  });

  page.on("response", (resp) => {
    const status = resp.status();
    const url = resp.url();
    if (status >= 400 && url !== targetUrl) {
      captured.requestFailures.push({
        url: url.slice(0, 300),
        method: resp.request().method(),
        reason: `HTTP ${status}`,
        resourceType: resp.request().resourceType(),
      });
    }
  });

  try {
    const resp = await page.goto(targetUrl, {
      timeout: deadlineSec * 1000,
      waitUntil: "networkidle",
    });
    captured.status = resp ? resp.status() : null;
  } catch (err) {
    captured.navigationFailure = err instanceof Error ? err.message : String(err);
  }

  try { await ctx.close(); } catch { /* ignore */ }
  try { await browser.close(); } catch { /* ignore */ }

  return captured;
}

export function capturedToFindings(captured: CapturedRuntime, targetUrl: string): Finding[] {
  const findings: Finding[] = [];
  if (captured.navigationFailure) {
    findings.push({
      name: "runtime-errors:navigation",
      severity: "error",
      passed: false,
      message: `Page failed to load: ${captured.navigationFailure}`,
    });
    return findings;
  }
  if (captured.status !== null && captured.status >= 400) {
    findings.push({
      name: "runtime-errors:initial-status",
      severity: "error",
      passed: false,
      message: `Initial page load returned HTTP ${captured.status}.`,
    });
  }
  for (const e of captured.pageErrors.slice(0, 10)) {
    findings.push({ name: "runtime-errors:page-error", severity: "error", passed: false, message: `Uncaught JS error: ${e.message}` });
  }
  for (const e of captured.consoleErrors.slice(0, 10)) {
    findings.push({ name: "runtime-errors:console-error", severity: "warning", passed: false, message: `console.error during load: ${e.text}` });
  }
  for (const f of captured.requestFailures.slice(0, 15)) {
    findings.push({
      name: "runtime-errors:network",
      severity: f.resourceType === "document" || f.resourceType === "script" ? "error" : "warning",
      passed: false,
      message: `${f.method} ${f.url} → ${f.reason} (${f.resourceType})`,
    });
  }
  for (const v of captured.cspViolations.slice(0, 5)) {
    findings.push({ name: "runtime-errors:csp-violation", severity: "error", passed: false, message: `CSP violation: ${v.text}` });
  }
  for (const m of captured.mixedContent.slice(0, 5)) {
    findings.push({ name: "runtime-errors:mixed-content", severity: "warning", passed: false, message: `Mixed content blocked: ${m.text}` });
  }
  for (const h of captured.hydration.slice(0, 5)) {
    findings.push({ name: "runtime-errors:hydration", severity: "warning", passed: false, message: `Possible hydration mismatch: ${h.text}` });
  }
  for (const d of captured.deprecations.slice(0, 5)) {
    findings.push({ name: "runtime-errors:deprecation", severity: "info", passed: false, message: `Browser deprecation: ${d.text}` });
  }
  findings.push({
    name: "runtime-errors:summary",
    severity: "info",
    passed: true,
    message:
      `runtime checked ${targetUrl} → ` +
      `${captured.pageErrors.length} page error(s), ` +
      `${captured.consoleErrors.length} console error(s), ` +
      `${captured.requestFailures.length} network failure(s), ` +
      `${captured.cspViolations.length} CSP violation(s), ` +
      `${captured.mixedContent.length} mixed-content event(s), ` +
      `${captured.hydration.length} hydration hint(s).`,
  });
  return findings;
}
```

---

## Deliverables — what Crontech Claude should produce

1. **Inbound Hono route** at (recommended) `apps/api/src/routes/jobs/web-runtime-scan.ts` with HMAC + timestamp + Bearer validation, Zod-validated body.
2. **Zod schema** for the request/response in `packages/schemas/web-runtime-scan.ts`.
3. **Drizzle migration** + table for queued jobs (idempotent — `CREATE TABLE IF NOT EXISTS`, `--> statement-breakpoint` between DDL statements, `_journal.json` entry). Suggested table: `web_runtime_jobs` keyed by `scan_id` with status / target_url / callback_url / attempts / next_run_at / completed_at columns.
4. **Worker loop** (in `services/web-runtime-worker/` or wired into `services/orchestrator/`) that:
   - Claims rows in `web_runtime_jobs` with `FOR UPDATE SKIP LOCKED` pattern
   - Runs the Playwright capture (deps from `services/orchestrator/` or its own sandbox)
   - POSTs the callback with retry (2s, 4s, 8s on 5xx; drop on 4xx)
   - Updates row status accordingly
5. **`bun:test`** tests for the HMAC helpers + payload shape + retry logic.
6. **Docs**: update `apps/web/src/data/services/integrations.ts` (or wherever Crontech tracks integrations) with the new GateTest integration.
7. **Quality gates green**: `bun run check`, `bunx biome check .`, `bun run check-links`, `bun run check-buttons`, `bun run db:validate`, `bun run test`.

## What Crontech Claude should NOT do

- Don't store any of the customer's runtime data beyond what's needed to retry the callback. After GateTest acks the callback, drop the local copy from `web_runtime_jobs` (or mark `completed_at` and let a TTL reaper sweep it).
- Don't expose the runtime payload publicly — it gets POSTed only to the GateTest callback URL.
- Don't add any external API integrations (no third-party analytics, no Sentry, no Datadog) without Craig's authorization.
- Don't change Crontech's pricing / billing model to bill GateTest — that's a Boss Rule item for Craig.
- Don't name "Vercel" / "Cloudflare" / "Render" / "Mailgun" / "Twilio" in any customer-facing copy — the build-time `apps/web/src/data/products/forbidden.ts` enforcer will block the PR.
- Don't use `any`, `@ts-ignore`, or `@ts-expect-error`. Strict TS only.

## Status checking (sanity)

After implementation, this is the smoke test that should pass:

```bash
# From the GateTest side, hit /api/web/scan with a real URL
curl -X POST https://gatetest.ai/api/web/scan \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}'

# Response should include `runtime: { status: "queued", jobId: "...", pollUrl: "..." }`
# Within 30 seconds, polling pollUrl should show `runtime: { status: "completed", payload: { findings: [...] } }`
```

When that round-trips successfully, the worker-tier integration is wired.

## The bigger picture — this is the interim, not the destination

This worker-tier integration is **Phase 1** of GateTest moving onto Crontech. The 7-day plan in Crontech's CLAUDE.md has Day 2 as *"Onboard GateTest as canary customer via the wizard"* — i.e. GateTest deploys to Crontech as a tenant through BLK-009. When that lands, Chromium will be local to the GateTest process and this HTTP handoff becomes obsolete.

But shipping the worker tier first means runtime-errors capture is real in production immediately — without waiting for the full migration. The HMAC contract + Playwright capture code we ship here is reusable as the in-process module when the full migration completes.

---

## Reference

The contract spec, dispatcher implementation, callback handler, and tests already shipped on the GateTest side in PR #80 (branch `feat/crontech-headless-worker`). Full files:
- `website/app/lib/crontech-dispatch.js`
- `website/app/api/web/scan/runtime-callback/route.ts`
- `website/app/api/web/scan/runtime-status/route.ts`
- `docs/crontech-worker-contract.md`
- `tests/crontech-dispatch.test.js`
