/**
 * Stripe Checkout API — Creates a payment session with manual capture.
 *
 * Flow:
 * 1. Customer selects a scan tier and provides repo URL
 * 2. This route creates a Stripe Checkout Session with capture_method: manual
 * 3. Customer completes payment → Stripe holds the funds
 * 4. GateTest runs the scan (and AI fix on Full Scan)
 * 5. Scan succeeds → capture the payment
 * 6. Scan fails → cancel the payment intent (hold released)
 *
 * Environment variables:
 *   STRIPE_SECRET_KEY — Stripe secret key (sk_live_... or sk_test_...)
 *   NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY — For client-side (pk_live_... or pk_test_...)
 */

import { NextRequest, NextResponse } from "next/server";
import https from "https";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createLimiter, PRESETS } = require("@lib/rate-limit") as {
  createLimiter: (opts: { windowMs: number; maxRequests: number }) => {
    guard: (req: NextRequest) => Promise<{ allowed: boolean; status?: number; body?: Record<string, unknown>; headers?: Record<string, string> }>;
  };
  PRESETS: Record<string, { windowMs: number; maxRequests: number }>;
};

const _checkoutLimiter = createLimiter(PRESETS.checkout);

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || "https://gatetest.ai";

interface ScanTier {
  name: string;
  priceInCents: number;
  modules: string;
  description: string;
}

const TIERS: Record<string, ScanTier> = {
  quick: {
    name: "Quick Scan",
    priceInCents: 2900,
    modules: "syntax, lint, secrets, codeQuality",
    description: "4 modules — syntax, linting, secrets, code quality",
  },
  full: {
    name: "Full Scan",
    priceInCents: 9900,
    modules: "all-102",
    description:
      "All 102 modules — security, supply chain, auth, CI hardening, AI review, and more. AI auto-fix PR included.",
  },
  // Phase 2.3 — $199 Scan + Fix tier. Wired in once Phase 2.1 (pair-review),
  // 2.2 (architecture annotator), and 2.4 (4/3 real-repo proofs validated:
  // gatetest, Crontech, Gluecron, MarcoReid) shipped per the loosened Boss
  // Rule. Same full-module scan as Full, plus depth deliverables: pair-review
  // critique on every fix and architecture-annotator design observations
  // attached as separate PR comments.
  scan_fix: {
    name: "Scan + Fix",
    priceInCents: 19900,
    modules: "all-102+pair-review+architecture",
    description:
      "Everything in Full Scan, plus a second-Claude pair-review critique on every fix (correctness/completeness/readability/test-coverage rubric) and a separate architecture-annotator report on codebase-shape design observations. Same PR, deeper deliverable.",
  },
  // Phase 3.6 — $399 Nuclear tier. Wired in once 3.1 (Claude diagnoser),
  // 3.2 (cross-finding correlator), 3.3 (mutation testing), 3.4 (chaos),
  // 3.5 (executive summary), and 3.7 (4/3 real-repo proofs validated)
  // all shipped. Stripe product already exists at $399 (Craig confirmed
  // via screenshot earlier this session).
  nuclear: {
    name: "Nuclear",
    priceInCents: 39900,
    modules: "all-102+nuclear-stack",
    description:
      "Everything in Scan + Fix, PLUS: real Claude diagnosis on every finding (no templated snippets), cross-finding attack-chain correlation (textbook session-forgery / supply-chain vectors no per-finding scanner can see), mutation testing (proves your tests catch bugs), chaos / fuzz pass on entry points, and a CTO-readable executive summary report.",

  },
};

function stripeRequest(
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
        const raw = Buffer.concat(chunks).toString("utf-8");
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new Error(`Stripe API error: ${raw}`));
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

export async function POST(req: NextRequest) {
  if (!STRIPE_SECRET_KEY) {
    return NextResponse.json(
      { error: "Payments not configured yet" },
      { status: 503 }
    );
  }

  let input: { tier?: string; repoUrl?: string };
  try {
    input = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  // Rate-limit AFTER body parsing, BEFORE any Stripe API call.
  const _rlCheckout = await _checkoutLimiter.guard(req);
  if (!_rlCheckout.allowed) {
    return NextResponse.json(_rlCheckout.body, {
      status: _rlCheckout.status ?? 429,
      headers: _rlCheckout.headers as Record<string, string>,
    });
  }

  const tier = TIERS[input.tier || ""];
  if (!tier) {
    return NextResponse.json(
      { error: `Invalid tier. Options: ${Object.keys(TIERS).join(", ")}` },
      { status: 400 }
    );
  }

  // Accept gluecron.com URLs first, fall back to github.com during the
  // dual-host migration window. Either host's URL shape is valid.
  if (
    !input.repoUrl ||
    !(input.repoUrl.includes("github.com") || input.repoUrl.includes("gluecron.com"))
  ) {
    return NextResponse.json(
      { error: "A valid GitHub or Gluecron repository URL is required" },
      { status: 400 }
    );
  }

  try {
    // Create Stripe Checkout Session with manual capture
    const params = new URLSearchParams({
      "payment_method_types[0]": "card",
      mode: "payment",
      "payment_intent_data[capture_method]": "manual",
      "payment_intent_data[metadata][tier]": input.tier || "",
      "payment_intent_data[metadata][repo_url]": input.repoUrl,
      "payment_intent_data[metadata][modules]": tier.modules,
      "metadata[tier]": input.tier || "",
      "metadata[repo_url]": input.repoUrl,
      "metadata[modules]": tier.modules,
      "line_items[0][price_data][currency]": "usd",
      "line_items[0][price_data][unit_amount]": String(tier.priceInCents),
      "line_items[0][price_data][product_data][name]": `GateTest ${tier.name}`,
      "line_items[0][price_data][product_data][description]": tier.description,
      "line_items[0][quantity]": "1",
      success_url: `${BASE_URL}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE_URL}/checkout/cancel`,
    });

    const session = await stripeRequest(
      "POST",
      "/v1/checkout/sessions",
      params.toString()
    );

    if (session.error) {
      return NextResponse.json(
        { error: (session.error as Record<string, string>).message },
        { status: 400 }
      );
    }

    return NextResponse.json({
      checkoutUrl: session.url,
      sessionId: session.id,
    });
  } catch (err) {
    // Never leak Stripe API internals / stack traces to the browser.
    // Log server-side with full context; return a generic user-facing message.
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[GateTest] Checkout failed:", message);
    return NextResponse.json(
      { error: "Checkout failed. Please try again or contact support." },
      { status: 500 }
    );
  }
}

// GET — return available tiers
export async function GET() {
  return NextResponse.json({
    tiers: Object.entries(TIERS).map(([key, tier]) => ({
      id: key,
      name: tier.name,
      price: `$${(tier.priceInCents / 100).toFixed(0)}`,
      priceInCents: tier.priceInCents,
      modules: tier.modules,
      description: tier.description,
    })),
    paymentModel: "hold-then-charge",
    note: "Card is held at checkout. Charged only after successful scan delivery. Hold released if scan fails.",
  });
}
