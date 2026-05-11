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

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL || "https://gatetest.ai";

interface ScanTier {
  name: string;
  priceInCents: number;
  modules: string;
  description: string;
  subscription?: boolean; // true = recurring monthly
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
    modules: "all-90",
    description:
      "All 90 modules — security, supply chain, auth, CI hardening, AI review, and more. AI auto-fix PR included.",
  },
  // Phase 2.3 — $199 Scan + Fix tier. Wired in once Phase 2.1 (pair-review),
  // 2.2 (architecture annotator), and 2.4 (4/3 real-repo proofs validated:
  // gatetest, Crontech, Gluecron, MarcoReid) shipped per the loosened Boss
  // Rule. Same 90-module scan as Full, plus depth deliverables: pair-review
  // critique on every fix and architecture-annotator design observations
  // attached as separate PR comments.
  scan_fix: {
    name: "Scan + Fix",
    priceInCents: 19900,
    modules: "all-90+pair-review+architecture",
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
    modules: "all-90+nuclear-stack",
    description:
      "Everything in Scan + Fix, PLUS: real Claude diagnosis on every finding (no templated snippets), cross-finding attack-chain correlation (textbook session-forgery / supply-chain vectors no per-finding scanner can see), mutation testing (proves your tests catch bugs), chaos / fuzz pass on entry points, and a CTO-readable executive summary report.",
  },

  // Continuous scanning tiers — recurring monthly subscriptions.
  // Scan runs automatically on every push via the GitHub App.
  // Uses Stripe subscription mode (not manual-capture payment).
  continuous_quick: {
    name: "Continuous Quick",
    priceInCents: 4900,
    modules: "syntax, lint, secrets, codeQuality",
    description: "Automated scan on every push — quick suite (4 modules). Gate blocks merge on any error.",
    subscription: true,
  },
  continuous_full: {
    name: "Continuous Full",
    priceInCents: 14900,
    modules: "all-90",
    description: "Automated scan on every push — all 90 modules. AI auto-fix PR opened on failure. The stack that replaces ESLint + SonarQube + Snyk.",
    subscription: true,
  },
  continuous_nuclear: {
    name: "Continuous Nuclear",
    priceInCents: 29900,
    modules: "all-90+nuclear-stack",
    description: "Automated scan on every push — full Nuclear stack with Claude diagnosis, attack-chain correlation, mutation testing, and executive summary report per run.",
    subscription: true,
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
    // Build Stripe Checkout Session params. Subscription tiers use
    // mode=subscription with a recurring price; one-time tiers use
    // mode=payment with manual capture (hold-then-charge model).
    //
    // Apple Pay / Google Pay / Stripe Link ride on the card payment method
    // type automatically when the Stripe account has them enabled.
    const isSubscription = Boolean(tier.subscription);

    const params = new URLSearchParams({
      "payment_method_types[0]": "card",
      "payment_method_types[1]": "link",
      mode: isSubscription ? "subscription" : "payment",
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

    if (isSubscription) {
      // Recurring price — no manual capture for subscriptions.
      params.set("line_items[0][price_data][recurring][interval]", "month");
      params.set("subscription_data[metadata][tier]", input.tier || "");
      params.set("subscription_data[metadata][repo_url]", input.repoUrl);
      params.set("subscription_data[metadata][modules]", tier.modules);
    } else {
      // One-time payment with manual capture (hold-then-charge).
      params.set("payment_intent_data[capture_method]", "manual");
      params.set("payment_intent_data[metadata][tier]", input.tier || "");
      params.set("payment_intent_data[metadata][repo_url]", input.repoUrl);
      params.set("payment_intent_data[metadata][modules]", tier.modules);
      // submit_type=pay shows "Pay" not "Subscribe" on the button.
      params.set("submit_type", "pay");
    }

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
