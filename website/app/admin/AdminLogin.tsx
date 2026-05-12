"use client";

import { useState } from "react";
import Link from "next/link";

interface AdminLoginProps {
  hasGitHubOAuth: boolean;
  hasPasswordAuth: boolean;
  error?: string;
}

const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  invalid_state: "OAuth state mismatch — please try again.",
  token_exchange_failed: "GitHub rejected the token exchange.",
  user_fetch_failed: "Could not read your GitHub profile.",
  not_authorized: "That GitHub account is not on the admin allowlist.",
};

export default function AdminLogin({
  hasGitHubOAuth,
  hasPasswordAuth,
  error: oauthError,
}: AdminLoginProps) {
  const [password, setPassword] = useState("");
  const [authing, setAuthing] = useState(false);
  const [error, setError] = useState("");

  const oauthMessage = oauthError ? OAUTH_ERROR_MESSAGES[oauthError] || "Sign-in failed." : null;

  async function login() {
    setError("");
    if (!password) {
      setError("Enter a password");
      return;
    }
    setAuthing(true);
    try {
      // pii-ok: login form sends password to /api/admin/auth — that's
      // the only correct destination for a password (canonical
      // login-form pattern, HTTPS in prod).
      const res = await fetch("/api/admin/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }), // pii-ok
        credentials: "same-origin",
      });
      if (res.ok) {
        setPassword("");
        window.location.reload();
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "Invalid password");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setAuthing(false);
    }
  }

  const noAuthConfigured = !hasGitHubOAuth && !hasPasswordAuth;

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-6">
      <div className="max-w-sm w-full">
        <h1 className="text-2xl font-bold mb-2 text-center">Admin Access</h1>

        {noAuthConfigured && (
          <div className="card p-4 mb-6 border-l-4 border-l-yellow-400">
            <p className="text-sm text-muted">
              Admin access is not configured. Set{" "}
              <code className="font-mono text-xs">GATETEST_ADMIN_PASSWORD</code> or configure
              GitHub OAuth environment variables in Vercel.
            </p>
          </div>
        )}

        {hasPasswordAuth && (
          <>
            <p className="text-xs text-muted text-center mb-6">
              Enter the admin password to continue.
            </p>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") login();
              }}
              placeholder="Enter admin password"
              aria-label="Admin password"
              className="w-full px-4 py-3 rounded-xl border border-border bg-surface-solid text-foreground text-sm mb-3"
              autoFocus
            />
            <button
              onClick={login}
              disabled={authing}
              className="btn-primary w-full py-3 text-sm disabled:opacity-50"
            >
              {authing ? "Verifying..." : "Sign In"}
            </button>
            {error && <p className="text-danger text-sm mt-2 text-center">{error}</p>}
          </>
        )}

        {hasGitHubOAuth && hasPasswordAuth && (
          <div className="flex items-center gap-3 my-6">
            <div className="flex-1 border-t border-border" />
            <span className="text-xs text-muted">or</span>
            <div className="flex-1 border-t border-border" />
          </div>
        )}

        {hasGitHubOAuth && (
          <>
            {!hasPasswordAuth && (
              <p className="text-sm text-muted text-center mb-6">
                Sign in with GitHub to continue.
              </p>
            )}
            <a
              href="/api/github/admin-login"
              className="btn-primary w-full py-3 text-sm block text-center"
            >
              Sign in with GitHub
            </a>
            {oauthMessage && (
              <p className="text-danger text-sm mt-2 text-center">{oauthMessage}</p>
            )}
          </>
        )}

        <div className="mt-8 text-center">
          <Link href="/" className="text-sm text-muted hover:text-foreground">
            &larr; Back to site
          </Link>
        </div>
      </div>
    </div>
  );
}
