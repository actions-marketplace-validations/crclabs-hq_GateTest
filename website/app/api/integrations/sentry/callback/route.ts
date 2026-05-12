/**
 * GET /api/integrations/sentry/callback
 *
 * Phase 5.3.1 — Sentry OAuth flow END. Sentry redirects back here with
 * a `code` and the `state` we set on the connect step. We verify state,
 * exchange the code for tokens, encrypt them, store them in
 * external_integrations, and redirect the customer to /dashboard.
 */

import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/app/lib/db";
 
const sentry = require("@/app/lib/sentry-client.js") as {
  exchangeOAuthCode: (opts: {
    code: string; clientId: string; clientSecret: string; redirectUri: string;
  }) => Promise<{ accessToken: string; refreshToken: string | null; expiresAt: string | null; scope: string | null; orgId: string | null }>;
};
 
const integrations = require("@/app/lib/external-integrations-store.js") as {
  VENDORS: Record<string, string>;
  ensureExternalIntegrationsTable: (sql: unknown) => Promise<void>;
  connectIntegration: (opts: {
    sql: unknown; repoUrl: string; vendor: string; orgId: string;
    accessToken: string; refreshToken?: string | null; expiresAt?: string | null; scope?: string | null;
  }) => Promise<{ id: number | null }>;
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const clientId = process.env.SENTRY_CLIENT_ID || "";
  const clientSecret = process.env.SENTRY_CLIENT_SECRET || "";
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "https://gatetest.ai";

  if (!clientId || !clientSecret) {
    return NextResponse.json(
      { ok: false, error: "Sentry integration not configured" },
      { status: 503 }
    );
  }

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    // User declined or Sentry returned an error — redirect to dashboard with toast.
    return NextResponse.redirect(`${baseUrl}/dashboard?integration_error=sentry:${encodeURIComponent(error)}`);
  }
  if (!code || !state) {
    return NextResponse.json({ ok: false, error: "missing code or state" }, { status: 400 });
  }

  // Verify state matches the cookie we set in /connect.
  const expectedState = req.cookies.get("gatetest_sentry_oauth_state")?.value;
  if (!expectedState || expectedState !== state) {
    return NextResponse.json({ ok: false, error: "state mismatch — possible CSRF" }, { status: 400 });
  }
  // Decode the repoUrl from the state.
  const repoUrlEncoded = state.split(":")[1] || "";
  let repoUrl: string;
  try {
    repoUrl = Buffer.from(repoUrlEncoded, "base64url").toString("utf-8");
  } catch {
    return NextResponse.json({ ok: false, error: "malformed state" }, { status: 400 });
  }
  if (!repoUrl) {
    return NextResponse.json({ ok: false, error: "no repoUrl in state" }, { status: 400 });
  }

  const redirectUri = `${baseUrl}/api/integrations/sentry/callback`;
  let tokens;
  try {
    tokens = await sentry.exchangeOAuthCode({
      code, clientId, clientSecret, redirectUri,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: `Sentry token exchange failed: ${err instanceof Error ? err.message : "unknown"}` },
      { status: 502 }
    );
  }

  if (!tokens.orgId) {
    return NextResponse.json(
      { ok: false, error: "Sentry did not return an organisation slug" },
      { status: 502 }
    );
  }

  let sql;
  try {
    sql = getDb();
  } catch {
    return NextResponse.json(
      { ok: false, error: "database not configured" },
      { status: 503 }
    );
  }

  try {
    await integrations.ensureExternalIntegrationsTable(sql);
    await integrations.connectIntegration({
      sql,
      repoUrl,
      vendor: integrations.VENDORS.SENTRY,
      orgId: tokens.orgId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      scope: tokens.scope,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: `failed to store credentials: ${err instanceof Error ? err.message : "unknown"}` },
      { status: 500 }
    );
  }

  // Success — clear the state cookie and redirect to dashboard.
  const res = NextResponse.redirect(`${baseUrl}/dashboard?integration_connected=sentry`);
  res.cookies.set("gatetest_sentry_oauth_state", "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 0,
    path: "/api/integrations/sentry",
  });
  return res;
}
