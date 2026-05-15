# Crontech ↔ GateTest worker contract

> The contract Crontech needs to implement so GateTest's `/api/web/scan`
> can offload headless-browser runtime checks to Crontech's worker
> infrastructure. Vercel-style serverless can't reliably launch
> Chromium; Crontech is the long-running container tier that can.

## The flow

1. **Customer** POSTs `https://gatetest.ai/api/web/scan` with `{url}`.
2. **GateTest serverless** runs static probes inline (headers, TLS,
   cookies, accessibility, SEO, links, performance) and immediately
   responds to the customer with those findings + a scan id +
   `runtime.status: "queued"`.
3. **GateTest** simultaneously POSTs a job to Crontech's
   `/api/jobs/web-runtime-scan` endpoint with HMAC-SHA256 signature.
4. **Crontech worker** pulls the job, launches Playwright/Chromium,
   loads the customer's URL, captures runtime events, ships them
   back to GateTest's callback URL with its own HMAC signature.
5. **GateTest** verifies the callback signature, persists the runtime
   payload on `scan_queue` by event_id.
6. **Customer's UI** polls `/api/web/scan/runtime-status?scanId=...`
   every 3-5 seconds; once `runtime_status` is `completed`, the
   merged report renders.

## What Crontech implements

### Inbound: dispatch from GateTest

```
POST {CRONTECH_BASE_URL}/api/jobs/web-runtime-scan
Headers:
  Authorization:        Bearer {CRONTECH_API_TOKEN}
  X-GateTest-Signature: hex(hmac-sha256(CRONTECH_DISPATCH_SECRET, body))
  X-GateTest-Timestamp: <unix-seconds>
  Content-Type:         application/json
Body:
  {
    "scanId":      "scn_xxxxxxxxxxxxxxxxxx",
    "targetUrl":   "https://customer-site.example",
    "suite":       "web" | "wp",
    "callbackUrl": "https://gatetest.ai/api/web/scan/runtime-callback",
    "deadlineSec": 60
  }
```

**Required Crontech behaviour:**
- Verify `X-GateTest-Signature` against `CRONTECH_DISPATCH_SECRET`
  before doing any work. **Fail-closed** when the header is missing or
  invalid (GateTest does the same on its callback).
- Verify `X-GateTest-Timestamp` is within ±5 minutes of now (replay
  protection).
- Reject duplicate `scanId` (idempotency) — return 200 with the
  existing `jobId`.
- Respond 201 with `{ "jobId": "...", "queuedAt": "..." }` on
  successful enqueue.
- Respond 4xx on validation failure with `{ "error": "..." }`.

### Outbound: callback to GateTest

The Playwright worker runs the URL through Chromium and captures:

- Uncaught JS errors (`page.on('pageerror')`)
- console.error / console.warn messages during initial load
- Network request failures (4xx/5xx, refused, timeout — per resource type)
- CSP violations (heuristic on console output)
- Mixed-content warnings
- Hydration mismatches (React / Vue / Next / Nuxt patterns)
- Browser deprecation warnings

```
POST {callbackUrl}    (always https://gatetest.ai/api/web/scan/runtime-callback)
Headers:
  X-GateTest-Signature: hex(hmac-sha256(CRONTECH_DISPATCH_SECRET, body))
  X-GateTest-Timestamp: <unix-seconds>
  Content-Type:         application/json
Body:
  {
    "scanId":     "scn_xxxxxxxxxxxxxxxxxx",
    "status":     "completed" | "failed",
    "durationMs": 4321,
    "findings": [
      {
        "name":     "runtime-errors:page-error",
        "severity": "error",
        "passed":   false,
        "message":  "Uncaught TypeError: foo is not a function"
      },
      ...
    ],
    "error": "Browser navigation timed out"      // only when status="failed"
  }
```

**Required Crontech behaviour:**
- POST exactly once per scanId. If GateTest's callback returns 5xx,
  retry up to 3 times with exponential backoff (2s, 4s, 8s).
- Use the SAME dispatch secret for the outbound HMAC — same shared
  key, same algorithm. (Symmetric.)
- Cap a single scan at the `deadlineSec` value GateTest sent — if the
  page hasn't finished loading by then, send `status: "failed"` with
  a useful `error` string.

## Finding rule names Crontech can emit

Matches the rule keys produced by `src/modules/runtime-errors.js` on the
GateTest side, so the existing translateFinding() and clusterer both
recognise them:

| `name` (rule key)                      | Customer-facing meaning                       |
| -------------------------------------- | --------------------------------------------- |
| `runtime-errors:navigation`            | Page failed to load entirely                  |
| `runtime-errors:initial-status`        | First-response HTTP >= 400                    |
| `runtime-errors:page-error`            | Uncaught JS error                             |
| `runtime-errors:console-error`         | console.error during load                     |
| `runtime-errors:network`               | Network request failed (per asset)            |
| `runtime-errors:csp-violation`         | CSP blocked a script/style/connect            |
| `runtime-errors:mixed-content`         | HTTP asset on an HTTPS page                   |
| `runtime-errors:hydration`             | SSR hydration mismatch heuristic              |
| `runtime-errors:deprecation`           | Browser deprecation warning                   |
| `runtime-errors:summary`               | Info-level summary line (one per scan)        |

## Environment variables

On the GateTest side (Vercel):

| Variable                       | Purpose                                          |
| ------------------------------ | ------------------------------------------------ |
| `CRONTECH_BASE_URL`            | `https://crontech.ai`                            |
| `CRONTECH_API_TOKEN`           | Bearer token Crontech issues to GateTest         |
| `CRONTECH_DISPATCH_SECRET`     | Shared HMAC secret (used both directions)        |
| `GATETEST_PUBLIC_BASE_URL`     | The base URL Crontech POSTs callbacks to         |

On the Crontech side:

| Variable                          | Purpose                                       |
| --------------------------------- | --------------------------------------------- |
| `GATETEST_DISPATCH_SECRET`        | Same value as `CRONTECH_DISPATCH_SECRET`      |
| `GATETEST_API_TOKEN`              | (Future) GateTest's PAT for any reverse calls |

## Failure semantics — never customer-facing

If Crontech is unavailable or rejects the dispatch:
- GateTest logs the failure on its side.
- The customer's response still ships with the static-probe findings.
- The `runtime.status` field in the API response carries `unavailable`
  with a `reason` string.

If Crontech accepts the dispatch but the worker crashes / times out:
- Crontech POSTs `status: "failed"` with an error string.
- The customer's UI polls and sees the failure; renders a "runtime
  layer unavailable for this scan" note, never a 500.

## Future contract additions (not Phase 1)

- `screenshot` field with a signed S3 URL for the failed page.
- `lighthouseMetrics` field (LCP, CLS, FID, INP) — runs in the same
  Chromium session.
- `axeAudit` field — accessibility findings from axe-core.
- Per-scan budget cap (Crontech bills GateTest per scan or per
  worker-second; GateTest enforces the budget per customer tier).

## Security / Boss Rule notes

- HMAC secrets are symmetric — both sides use the same value. Rotate
  in lockstep when ever rotated. Document in the platform-siblings
  admin panel.
- GateTest fails-closed on its callback: missing secret or invalid
  signature → reject. Same expected on Crontech's dispatch endpoint.
- Crontech billing / pricing for this integration is a Boss Rule
  decision — not specified here.
