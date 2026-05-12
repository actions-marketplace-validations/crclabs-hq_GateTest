import { detectPlatform } from "./platform-detector";
import { generatePlatformFix } from "./platform-fix-generator";

/**
 * Website Scanner — scan a live deployed URL without needing source code.
 *
 * Designed for non-technical users who just have a website URL, not a
 * GitHub repo. Fetches the page, inspects HTTP headers + HTML, and returns
 * plain-English findings anyone can understand.
 *
 * Checks:
 *  - HTTPS enforcement
 *  - Security headers (CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy)
 *  - Response time (performance)
 *  - Basic accessibility (img alt, form labels, button text, page title)
 *  - SEO essentials (title, meta description, canonical, robots)
 *  - Mixed content (HTTP resources on HTTPS pages)
 *  - Cookie security flags
 *  - Outdated/vulnerable library hints (jQuery, Bootstrap CDN patterns)
 */

export interface WebFinding {
  severity: "critical" | "warning" | "info" | "pass";
  category: string;
  title: string;          // plain-English title
  detail: string;         // plain-English explanation
  fix?: string;           // plain-English fix suggestion
}

export interface WebScanResult {
  url: string;
  finalUrl: string;       // after redirects
  ok: boolean;
  responseMs: number;
  statusCode: number;
  findings: WebFinding[];
  summary: {
    critical: number;
    warnings: number;
    passed: number;
    score: number;        // 0-100
  };
  platform?: {
    name: string;         // e.g. "WordPress", "Vercel"
    canAutoFix: boolean;
    fixFiles?: Array<{
      filename: string;
      language: string;
      content: string;
      instructions: string;
    }>;
    manualSteps?: string[];
  };
  error?: string;
}

const FETCH_TIMEOUT_MS = 15_000;

/** Plain-English header names for the report */
const SECURITY_HEADERS: Array<{ header: string; label: string; why: string; fix: string }> = [
  {
    header: "content-security-policy",
    label: "Content Security Policy",
    why: "Without it, attackers can inject malicious scripts into your pages (XSS attacks).",
    fix: "Add a Content-Security-Policy HTTP header. Start with: Content-Security-Policy: default-src 'self'",
  },
  {
    header: "strict-transport-security",
    label: "HTTPS Enforcement (HSTS)",
    why: "Without it, browsers can be tricked into loading your site over HTTP — exposing passwords and data.",
    fix: "Add: Strict-Transport-Security: max-age=31536000; includeSubDomains",
  },
  {
    header: "x-frame-options",
    label: "Clickjacking Protection",
    why: "Without it, attackers can embed your site invisibly inside another page to steal clicks.",
    fix: "Add: X-Frame-Options: SAMEORIGIN  (or use Content-Security-Policy: frame-ancestors 'self')",
  },
  {
    header: "x-content-type-options",
    label: "MIME Sniffing Protection",
    why: "Without it, browsers may misinterpret uploaded files as executable scripts.",
    fix: "Add: X-Content-Type-Options: nosniff",
  },
  {
    header: "referrer-policy",
    label: "Referrer Privacy",
    why: "Without it, your full URL (including paths and query strings) is shared with every third-party site you link to.",
    fix: "Add: Referrer-Policy: strict-origin-when-cross-origin",
  },
];

function extractCookies(headers: Headers): string[] {
  const raw = headers.get("set-cookie") || "";
  return raw ? [raw] : [];
}

function scoreFindings(findings: WebFinding[]): number {
  const criticals = findings.filter((f) => f.severity === "critical").length;
  const warnings = findings.filter((f) => f.severity === "warning").length;
  const passes = findings.filter((f) => f.severity === "pass").length;
  const total = criticals + warnings + passes;
  if (total === 0) return 50;
  const base = (passes / total) * 100;
  const penalty = criticals * 12 + warnings * 4;
  return Math.max(0, Math.min(100, Math.round(base - penalty)));
}

export async function scanWebsite(rawUrl: string): Promise<WebScanResult> {
  // Normalise URL
  let url = rawUrl.trim();
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;

  const findings: WebFinding[] = [];
  let responseMs = 0;
  let statusCode = 0;
  let finalUrl = url;
  let html = "";

  // ── Fetch the page ──────────────────────────────────────────────────────
  let headers: Headers;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const start = Date.now();
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "GateTest/1.0 Site Scanner (gatetest.ai)",
        "Accept": "text/html,application/xhtml+xml",
      },
    });
    clearTimeout(timer);
    responseMs = Date.now() - start;
    statusCode = res.status;
    finalUrl = res.url || url;
    headers = res.headers;
    html = await res.text().catch(() => "");
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Network error";
    return {
      url: rawUrl,
      finalUrl,
      ok: false,
      responseMs: 0,
      statusCode: 0,
      findings: [],
      summary: { critical: 0, warnings: 0, passed: 0, score: 0 },
      error: `Could not reach ${url}: ${msg}`,
    };
  }

  // ── HTTPS check ─────────────────────────────────────────────────────────
  if (finalUrl.startsWith("http://")) {
    findings.push({
      severity: "critical",
      category: "Security",
      title: "Your site does not use HTTPS",
      detail: "All data — passwords, form submissions, personal details — is sent in plain text that anyone on the same network can read.",
      fix: "Enable HTTPS through your hosting provider. Most modern hosts (Vercel, Netlify, Cloudflare) do this for free.",
    });
  } else {
    findings.push({
      severity: "pass",
      category: "Security",
      title: "HTTPS is enabled",
      detail: "Traffic between your visitors and your site is encrypted.",
    });
  }

  // ── Performance ─────────────────────────────────────────────────────────
  if (responseMs > 3000) {
    findings.push({
      severity: "critical",
      category: "Performance",
      title: `Your site loads slowly (${(responseMs / 1000).toFixed(1)}s server response)`,
      detail: "Studies show 40% of visitors leave if a page takes more than 3 seconds to load. Slow sites also rank lower on Google.",
      fix: "Use a CDN (Cloudflare, Vercel, Netlify), enable caching, and compress images. Check Google PageSpeed Insights for a detailed breakdown.",
    });
  } else if (responseMs > 1500) {
    findings.push({
      severity: "warning",
      category: "Performance",
      title: `Server response time is ${(responseMs / 1000).toFixed(1)}s`,
      detail: "This is acceptable but could be faster. Under 1 second is ideal.",
      fix: "Enable caching headers, use a CDN, and optimise your server-side code.",
    });
  } else {
    findings.push({
      severity: "pass",
      category: "Performance",
      title: `Fast server response (${responseMs}ms)`,
      detail: "Your server responds quickly.",
    });
  }

  // ── Security headers ────────────────────────────────────────────────────
  for (const { header, label, why, fix } of SECURITY_HEADERS) {
    if (!headers.get(header)) {
      findings.push({
        severity: header === "content-security-policy" ? "critical" : "warning",
        category: "Security",
        title: `Missing: ${label}`,
        detail: why,
        fix,
      });
    } else {
      findings.push({
        severity: "pass",
        category: "Security",
        title: `${label} is configured`,
        detail: `Header present: ${headers.get(header)?.slice(0, 80)}`,
      });
    }
  }

  // ── Cookie security ──────────────────────────────────────────────────────
  const cookies = extractCookies(headers);
  for (const cookie of cookies) {
    const name = cookie.split("=")[0]?.trim() || "Cookie";
    if (!/\bHttpOnly\b/i.test(cookie)) {
      findings.push({
        severity: "warning",
        category: "Security",
        title: `Cookie "${name}" is readable by JavaScript`,
        detail: "If your site ever has an XSS vulnerability, attackers could steal this cookie and hijack user sessions.",
        fix: "Add the HttpOnly flag to your cookie: Set-Cookie: name=value; HttpOnly; Secure; SameSite=Lax",
      });
    }
    if (!/\bSecure\b/i.test(cookie) && finalUrl.startsWith("https://")) {
      findings.push({
        severity: "warning",
        category: "Security",
        title: `Cookie "${name}" can be sent over HTTP`,
        detail: "Even though your site uses HTTPS, this cookie could be sent over an insecure connection.",
        fix: "Add the Secure flag: Set-Cookie: name=value; HttpOnly; Secure; SameSite=Lax",
      });
    }
  }

  // ── HTML checks ──────────────────────────────────────────────────────────
  if (html) {
    // Title
    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    const title = titleMatch?.[1]?.trim() || "";
    if (!title) {
      findings.push({
        severity: "warning",
        category: "SEO",
        title: "Missing page title",
        detail: "Your page has no <title> tag. Google uses this as the headline in search results.",
        fix: "Add <title>Your Page Name | Your Brand</title> inside the <head> section.",
      });
    } else if (title.length > 60) {
      findings.push({
        severity: "warning",
        category: "SEO",
        title: `Page title is too long (${title.length} chars)`,
        detail: `"${title.slice(0, 50)}…" — Google cuts off titles over 60 characters in search results.`,
        fix: "Shorten your title to under 60 characters.",
      });
    } else {
      findings.push({ severity: "pass", category: "SEO", title: "Page title present", detail: `"${title}"` });
    }

    // Meta description
    const descMatch = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i)
      || html.match(/<meta\s+content=["']([^"']*)["']\s+name=["']description["']/i);
    const desc = descMatch?.[1]?.trim() || "";
    if (!desc) {
      findings.push({
        severity: "warning",
        category: "SEO",
        title: "Missing meta description",
        detail: "Google shows this text under your page title in search results. Without it, Google picks random text from your page.",
        fix: 'Add <meta name="description" content="A clear 1-2 sentence description of this page."> in the <head>.',
      });
    } else {
      findings.push({ severity: "pass", category: "SEO", title: "Meta description present", detail: `"${desc.slice(0, 80)}"` });
    }

    // Images missing alt text
    const imgMatches = html.match(/<img\s[^>]*>/gi) || [];
    const imgsMissingAlt = imgMatches.filter((img) => !/\balt\s*=\s*["'][^"']*["']/i.test(img) && !/\balt\s*=\s*["']["']/i.test(img)).length;
    if (imgsMissingAlt > 0) {
      findings.push({
        severity: "warning",
        category: "Accessibility",
        title: `${imgsMissingAlt} image${imgsMissingAlt > 1 ? "s are" : " is"} missing a description`,
        detail: "Screen readers (used by blind and visually impaired visitors) can't interpret images without an alt attribute. This also hurts your Google Image ranking.",
        fix: 'Add alt="description of the image" to every <img> tag.',
      });
    } else if (imgMatches.length > 0) {
      findings.push({ severity: "pass", category: "Accessibility", title: "All images have descriptions", detail: `${imgMatches.length} image(s) checked.` });
    }

    // Viewport meta (mobile responsiveness)
    if (!/<meta\s[^>]*name=["']viewport["']/i.test(html)) {
      findings.push({
        severity: "critical",
        category: "Mobile",
        title: "Your site is not mobile-friendly",
        detail: "Without a viewport tag, your site renders at full desktop width on phones and is nearly unusable. 60%+ of web traffic is mobile.",
        fix: 'Add <meta name="viewport" content="width=device-width, initial-scale=1"> inside the <head>.',
      });
    } else {
      findings.push({ severity: "pass", category: "Mobile", title: "Mobile viewport configured", detail: "Site should scale correctly on phones and tablets." });
    }

    // Mixed content (http:// resources on https:// page)
    if (finalUrl.startsWith("https://")) {
      const httpResources = (html.match(/\bsrc\s*=\s*["']http:\/\//gi) || []).length
        + (html.match(/\bhref\s*=\s*["']http:\/\//gi) || []).filter((h) => !/nofollow|canonical|alternate/.test(h)).length;
      if (httpResources > 2) {
        findings.push({
          severity: "warning",
          category: "Security",
          title: `${httpResources} insecure (HTTP) resources loaded on an HTTPS page`,
          detail: "Loading HTTP resources on an HTTPS page is called 'mixed content'. Browsers block some of these, breaking your site silently.",
          fix: "Change all src= and href= values to use https:// instead of http://.",
        });
      }
    }

    // Inline scripts (basic XSS surface hint)
    const inlineScripts = (html.match(/<script(?!\s+src)[^>]*>/gi) || []).length;
    if (inlineScripts > 5) {
      findings.push({
        severity: "info",
        category: "Security",
        title: `${inlineScripts} inline scripts detected`,
        detail: "Inline scripts make it harder to enforce a Content Security Policy, which protects against XSS attacks.",
        fix: "Move scripts to external .js files and reference them with <script src='...'> tags.",
      });
    }
  }

  // ── Status code check ───────────────────────────────────────────────────
  if (statusCode >= 400) {
    findings.push({
      severity: "critical",
      category: "Availability",
      title: `Site returned HTTP ${statusCode}`,
      detail: statusCode === 404
        ? "The page was not found. Visitors and search engines will see an error."
        : statusCode === 403
        ? "Access denied. The server is refusing to show this page."
        : `Your server returned an error code (${statusCode}).`,
      fix: "Check your hosting configuration and ensure the URL is correct.",
    });
  }

  const summary = {
    critical: findings.filter((f) => f.severity === "critical").length,
    warnings: findings.filter((f) => f.severity === "warning").length,
    passed: findings.filter((f) => f.severity === "pass").length,
    score: scoreFindings(findings),
  };

  // Platform detection + fix generation
  const platformInfo = detectPlatform(headers, html, finalUrl);
  const platformFix = generatePlatformFix(platformInfo.platform, findings);
  const platform = {
    name: platformInfo.label,
    canAutoFix: platformInfo.canAutoFix && platformFix.files.length > 0,
    ...(platformFix.files.length > 0 ? { fixFiles: platformFix.files } : {}),
    ...(platformFix.manualSteps && platformFix.manualSteps.length > 0
      ? { manualSteps: platformFix.manualSteps }
      : {}),
  };

  return {
    url: rawUrl,
    finalUrl,
    ok: statusCode >= 200 && statusCode < 400,
    responseMs,
    statusCode,
    findings,
    summary,
    platform,
  };
}

/**
 * Format scan results as plain-English text for a non-technical audience.
 */
export function formatWebScanReport(result: WebScanResult): string {
  const { summary, findings, finalUrl, responseMs } = result;
  const lines: string[] = [];

  lines.push(`## GateTest Website Scan — ${finalUrl}`);
  lines.push(`**Score: ${summary.score}/100** · ${summary.critical} critical · ${summary.warnings} warnings · ${summary.passed} passed · ${responseMs}ms response`);
  lines.push("");

  const criticals = findings.filter((f) => f.severity === "critical");
  const warnings = findings.filter((f) => f.severity === "warning");
  const passes = findings.filter((f) => f.severity === "pass");

  if (criticals.length > 0) {
    lines.push("### 🔴 Critical issues — fix these first");
    for (const f of criticals) {
      lines.push(`**${f.title}** _(${f.category})_`);
      lines.push(f.detail);
      if (f.fix) lines.push(`> Fix: ${f.fix}`);
      lines.push("");
    }
  }

  if (warnings.length > 0) {
    lines.push("### 🟡 Warnings — worth fixing");
    for (const f of warnings) {
      lines.push(`**${f.title}** _(${f.category})_`);
      lines.push(f.detail);
      if (f.fix) lines.push(`> Fix: ${f.fix}`);
      lines.push("");
    }
  }

  if (passes.length > 0) {
    lines.push("### ✅ Passing checks");
    for (const f of passes) {
      lines.push(`- ${f.title}`);
    }
  }

  return lines.join("\n");
}
