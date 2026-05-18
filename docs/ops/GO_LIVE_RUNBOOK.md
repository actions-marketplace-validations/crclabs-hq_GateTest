# GateTest Go-Live Runbook

## You are here
Code is ready. 909 tests pass. 102 modules load. All the hard stuff is done.
This runbook gets you from "code ready" to "first $29 scan paid" in 9 steps.

Work top-to-bottom. Do not skip. Each step has a clear "done" signal before
you move to the next. Total wall-clock time from Step 1 to Step 9: ~90 minutes,
most of it waiting for DNS and SSL.

---

## Step 1 — Deploy website to Vercel

1. Log into [vercel.com](https://vercel.com) with your GitHub account.
2. Click **Add New… → Project**.
3. Import `crclabs-hq/GateTest` from the repo list (click **Import**).
4. On the configuration screen:
   - **Framework Preset:** Next.js (should auto-detect).
   - **Root Directory:** click **Edit** and set to `website`.
   - **Build Command:** leave default (`next build`).
   - **Output Directory:** leave default.
5. Skip env vars for now (Step 3 handles them).
6. Click **Deploy**.
7. Wait ~2 minutes for the first build. Expect a green check.
8. Copy the deployment URL Vercel shows you (e.g. `gatetest-abc123.vercel.app`).
   You will visit this once in Step 2 to confirm it loads before adding DNS.

**Done signal:** visiting the `*.vercel.app` URL shows the GateTest homepage
(with the pre-launch banner still showing — that is expected until Step 8).

---

## Step 2 — Point DNS

In your DNS provider (Cloudflare, Namecheap, Route 53 — wherever `gatetest.ai`
lives):

1. Add a CNAME record:
   - **Name:** `gatetest.ai` (or `@` depending on provider)
   - **Target:** `cname.vercel-dns.com`
   - **TTL:** default / automatic
2. Add a second CNAME record:
   - **Name:** `www`
   - **Target:** `cname.vercel-dns.com`
3. If your provider does not allow CNAME on the apex (`gatetest.ai`), use an
   ALIAS/ANAME record instead with the same target. Cloudflare handles this
   automatically with "CNAME flattening."

Back in Vercel:

4. Open the GateTest project → **Settings → Domains**.
5. Add `gatetest.ai`. Vercel will verify the DNS and show "Valid Configuration."
6. Add `www.gatetest.ai` and set it to redirect to `gatetest.ai` (apex).
7. Wait ~5 minutes for SSL to provision. The padlock in Vercel's domain list
   goes from grey to green when it's ready.

**Done signal:** `https://gatetest.ai` loads with a valid SSL cert. No browser
warnings.

---

## Step 3 — Set environment variables on Vercel

Open the GateTest project → **Settings → Environment Variables**.
Add each of the variables below. Apply to **Production, Preview, and
Development** unless noted. After adding all of them, **redeploy** from the
Deployments tab (click the latest deploy → ⋯ → Redeploy) so the new env vars
take effect.

| # | Name | Where to get it | Example / format |
|---|------|-----------------|------------------|
| 1 | `STRIPE_SECRET_KEY` | [stripe.com/dashboard/apikeys](https://dashboard.stripe.com/apikeys) — use **test** key for now | `sk_test_51...` |
| 2 | `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | Same dashboard, publishable key | `pk_test_51...` |
| 3 | `NEXT_PUBLIC_BASE_URL` | You set this | `https://gatetest.ai` |
| 4 | `STRIPE_WEBHOOK_SECRET` | Filled in after **Step 6** — leave blank for now or use a placeholder | `whsec_...` |
| 5 | `GATETEST_APP_ID` | From GitHub App settings after **Step 5** | `123456` (6-ish digit integer) |
| 6 | `GATETEST_PRIVATE_KEY` | Paste entire contents of the `.pem` file downloaded in **Step 5**. Keep the `-----BEGIN…` / `-----END…` lines and all newlines intact. In Vercel, use the multi-line text field. | `-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----` |
| 7 | `GATETEST_WEBHOOK_SECRET` | You generate: run `openssl rand -hex 32` in a terminal, copy output | `a1b2c3d4...` (64 hex chars) |
| 8 | `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com) → API Keys → Create | `sk-ant-api03-...` |
| 9 | `GATETEST_ADMIN_PASSWORD` | You pick. Use 1Password/Bitwarden to generate a 20+ char password and save it. | `(long strong password)` |
| 10 | `DATABASE_URL` | From Neon — filled in during **Step 4** | `postgresql://user:pass@ep-xxx.neon.tech/gatetest?sslmode=require` |
| 11 | `SESSION_SECRET` | You generate: `openssl rand -hex 32` | `f0e1d2c3...` (64 hex chars) |

(That's 11 total — the spec said 9 env vars, but `DATABASE_URL` and
`SESSION_SECRET` are required and get populated in Steps 4 and at start. If in
doubt, set all 11.)

**Tips:**
- Generate both `openssl rand -hex 32` secrets now and paste them into a
  scratchpad — you'll re-use `GATETEST_WEBHOOK_SECRET` in Step 5.
- Start with Stripe **test** keys. Swap to `sk_live_` / `pk_live_` only after
  Step 9 passes end-to-end.

**Done signal:** all 11 rows visible in the Vercel env var list, scoped to
Production.

---

## Step 4 — Provision Neon Postgres

1. Go to [neon.tech](https://neon.tech), sign in.
2. **Create project** → name it `gatetest`, region closest to Vercel's
   deployment region (usually `us-east-1` / Washington DC works).
3. Neon shows a connection string on first load. Copy it — it looks like:
   `postgresql://user:pass@ep-something.us-east-1.aws.neon.tech/gatetest?sslmode=require`
4. Paste that value into the Vercel `DATABASE_URL` env var (Step 3, row 10).
5. Redeploy the Vercel project so it picks up `DATABASE_URL`.
6. Initialize the schema:
   - Visit `https://gatetest.ai/api/db/init`, **OR**
   - Log into `https://gatetest.ai/admin` (Step 7) and click **Initialize
     database** in the admin panel.
7. Visit `https://gatetest.ai/admin/health` — the **Database** row should turn
   green.

**Done signal:** `/admin/health` shows Database = green with a table count of
at least 3.

---

## Step 5 — Register GitHub App

1. Go to [github.com/settings/apps](https://github.com/settings/apps) → **New
   GitHub App**.
2. Fill in:
   - **GitHub App name:** `GateTestHQ`
   - **Homepage URL:** `https://gatetest.ai`
   - **Webhook → Active:** checked
   - **Webhook URL:** `https://gatetest.ai/api/webhook`
   - **Webhook secret:** paste the same value you set for
     `GATETEST_WEBHOOK_SECRET` in Step 3
3. **Repository permissions:**
   - Metadata: Read
   - Contents: Read
   - Pull requests: **Read & write**
   - Commit statuses: **Read & write**
   - Checks: **Read & write**
4. **Subscribe to events:** Push, Pull request
5. **Where can this GitHub App be installed?** Any account (or Only on this
   account if you're testing solo).
6. Click **Create GitHub App**.
7. On the new app's settings page:
   - Note the **App ID** (top of page) → paste into Vercel's `GATETEST_APP_ID`.
   - Scroll to **Private keys** → **Generate a private key**. A `.pem` file
     downloads.
   - Open the `.pem` in a text editor, copy the full contents (including
     BEGIN/END lines and all newlines), paste into Vercel's
     `GATETEST_PRIVATE_KEY`.
8. **Install the app** on your own GitHub account (or the account that owns the
   test repo). **Install App** button on the left sidebar → pick account →
   choose "All repositories" or "Only select repositories."
9. Redeploy Vercel to pick up `GATETEST_APP_ID` and `GATETEST_PRIVATE_KEY`.

**Done signal:** `/admin/health` shows **GitHub App** = green and reports a
non-zero installation count.

---

## Step 6 — Configure Stripe webhook

1. Go to [dashboard.stripe.com](https://dashboard.stripe.com) → **Developers →
   Webhooks → Add endpoint**.
2. **Endpoint URL:** `https://gatetest.ai/api/stripe-webhook`
3. **Events to send:** click **Select events** and tick:
   - `checkout.session.completed`
   - `payment_intent.succeeded`
   - `payment_intent.payment_failed`
4. Click **Add endpoint**.
5. On the endpoint's detail page, click **Reveal** on the **Signing secret**
   (starts with `whsec_…`).
6. Copy it, paste into Vercel's `STRIPE_WEBHOOK_SECRET`.
7. Redeploy.

**Done signal:** In Stripe, the endpoint shows "Enabled." In
`/admin/health`, the **Stripe** row is green.

---

## Step 7 — Run the admin health check

1. Visit `https://gatetest.ai/admin`.
2. Log in with `GATETEST_ADMIN_PASSWORD` (Step 3, row 9).
3. Click **Run Full Self-Test**.
4. The panel runs 8 checks: Environment, Database, Stripe, GitHub App,
   Anthropic, Webhook signatures, Session store, Disk writable.
5. Expected result: **all 8 green** (or some **warn**, never red).
6. If any go red:
   - Click the failing item.
   - Read the **How to fix** suggestion (each check has one).
   - Fix (usually a missing/misspelled env var, or a secret that was pasted
     with a leading space).
   - Re-run the self-test.
7. Do not proceed to Step 8 until every row is green or warn.

**Done signal:** 8/8 green-or-warn on `/admin`. Screenshot it for your records.

---

## Step 8 — Remove pre-launch posture (ONLY when Steps 1-7 are all green)

Two one-line reverts and one small component change. Work on the launch
branch you just pulled.

1. **`website/app/components/PreLaunchBanner.tsx`** — either delete the file,
   or open `website/app/layout.tsx` and remove the `<PreLaunchBanner />` import
   and the JSX element.
2. **`website/app/api/checkout/route.ts`** — remove the 503 short-circuit at the
   top of the handler (the block that returns
   `{ error: "Pre-launch — checkout disabled" }` with status 503). The original
   Stripe-session flow is preserved directly below it in comments; uncomment it.
3. **`website/app/components/Pricing.tsx`** — the CTA buttons currently have
   `href="mailto:founders@gatetest.ai"`. Change them back to calling
   `handleCheckout(tier)` on click. Commit `c238b2d` in git log shows the exact
   shape of the original handler — use that as your reference.
4. **Delete `tests/prelaunch-checkout-disabled.test.js`** — it asserts that
   `/api/checkout` returns 503. Once Step 8 is complete it will fail; remove it.
5. Commit:
   ```
   feat(launch): go live — banner off, Stripe checkout enabled
   ```
6. Push. Vercel auto-deploys from `main` (~2 min).

**Done signal:** `https://gatetest.ai` no longer shows the yellow pre-launch
banner. Clicking a pricing CTA now opens a Stripe Checkout page (not an email
client).

---

## Step 9 — First end-to-end test

1. Open `https://gatetest.ai` in an incognito window.
2. Click **Quick Scan — $29**.
3. On the Stripe Checkout page, use the test card:
   - **Card:** `4242 4242 4242 4242`
   - **Expiry:** any future date (e.g. `12/34`)
   - **CVC:** any 3 digits (e.g. `123`)
   - **ZIP:** any 5 digits (e.g. `10001`)
4. Submit. Stripe redirects back to GateTest's success page.
5. Enter a public repo URL — `octocat/Hello-World` is the standard smoke test.
6. Watch the scan run. Typical runtime: 30-90 seconds.
7. Verify in three places:
   - **Stripe dashboard → Payments:** the $29 test payment is listed as
     Succeeded.
   - **Admin panel → Recent scans:** the scan appears with status `completed`.
   - **Browser:** scan results render (summary, findings, PR comment link if
     applicable).

**Done signal:** you see the scan results page render without errors, and the
payment is green in Stripe.

---

## When you're ready for real money

1. Swap Stripe keys in Vercel env vars:
   - `STRIPE_SECRET_KEY` → your `sk_live_...` key.
   - `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` → `pk_live_...`.
   - Update the Stripe webhook signing secret too — the live-mode endpoint has
     a different `whsec_` than test-mode. Re-do Step 6 in **live mode** and
     update `STRIPE_WEBHOOK_SECRET`.
2. Redeploy.
3. Re-run Step 9 with a real card of your own. You can refund yourself from the
   Stripe dashboard after the end-to-end confirms.
4. Update the README badge from "pre-launch" to "live."
5. Announce:
   - Show HN post ("GateTest — $29 repo security scans, powered by Claude")
   - r/programming
   - Twitter / X
   - Your personal network first — they're your best feedback loop.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `503` on `/api/checkout` | Pre-launch short-circuit still in place | Complete **Step 8** — revert the 503 return and the banner. |
| Scan page infinite loop | Known Issue #1 — stale checkout session | Start a fresh checkout session (new incognito window). |
| GitHub API `503` | Circuit breaker engaged | Visit `/admin/health` → GitHub row. Click **Reset circuit breaker**. Wait 60s. Retry. |
| Stripe webhook 400s | `STRIPE_WEBHOOK_SECRET` mismatch | Re-copy from Stripe dashboard (test vs. live are different secrets), paste, redeploy. |
| DNS "Invalid Configuration" in Vercel | Record not propagated yet | Wait 10 more min. Check with `dig gatetest.ai` — should return Vercel IP. |
| Admin login fails | Wrong `GATETEST_ADMIN_PASSWORD` or trailing whitespace | Re-set the env var (watch for spaces), redeploy. |
| `GATETEST_PRIVATE_KEY` errors on app startup | Newlines got collapsed | Re-paste the `.pem` into Vercel; use the multi-line input, not a single-line paste. |
