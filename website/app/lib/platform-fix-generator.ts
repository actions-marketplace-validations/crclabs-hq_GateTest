/**
 * Platform Fix Generator
 *
 * Given a list of WebFinding issues and a detected platform, generates
 * ready-to-deploy fix files (vercel.json additions, Netlify _headers,
 * WordPress plugin snippet, nginx.conf, etc.).
 *
 * The goal: non-technical users get a file they can download and deploy
 * in one step — not a list of abstract header names.
 */

import type { Platform } from "./platform-detector";
import type { WebFinding } from "./website-scanner";

export interface PlatformFixFile {
  filename: string;
  language: string;      // for syntax highlighting
  content: string;
  instructions: string;  // plain-English "where to put this"
}

export interface PlatformFixResult {
  platform: Platform;
  files: PlatformFixFile[];
  manualSteps?: string[]; // for platforms where file injection isn't possible
}

// Security headers that are commonly missing and can be auto-fixed
const SECURITY_HEADERS_MAP: Record<string, string> = {
  "content-security-policy":    "Content-Security-Policy",
  "strict-transport-security":  "Strict-Transport-Security",
  "x-frame-options":            "X-Frame-Options",
  "x-content-type-options":     "X-Content-Type-Options",
  "referrer-policy":            "Referrer-Policy",
};

const DEFAULT_HEADER_VALUES: Record<string, string> = {
  "Content-Security-Policy":    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:;",
  "Strict-Transport-Security":  "max-age=31536000; includeSubDomains",
  "X-Frame-Options":            "SAMEORIGIN",
  "X-Content-Type-Options":     "nosniff",
  "Referrer-Policy":            "strict-origin-when-cross-origin",
  "Permissions-Policy":         "camera=(), microphone=(), geolocation=()",
};

function getMissingHeaders(findings: WebFinding[]): string[] {
  return findings
    .filter((f) => f.severity === "critical" || f.severity === "warning")
    .filter((f) => f.title.startsWith("Missing:"))
    .map((f) => {
      for (const [, label] of Object.entries(SECURITY_HEADERS_MAP)) {
        if (f.title.includes(label)) return label;
      }
      return null;
    })
    .filter((h): h is string => h !== null);
}

// ── Vercel ────────────────────────────────────────────────────────────────
function generateVercelFix(findings: WebFinding[]): PlatformFixResult {
  const missing = getMissingHeaders(findings);
  if (missing.length === 0) {
    return { platform: "vercel", files: [], manualSteps: [] };
  }

  const headerEntries = missing
    .map((name) => `      { "key": "${name}", "value": "${DEFAULT_HEADER_VALUES[name] ?? ""}" }`)
    .join(",\n");

  const content = `{
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
${headerEntries}
      ]
    }
  ]
}`;

  return {
    platform: "vercel",
    files: [
      {
        filename: "vercel.json",
        language: "json",
        content,
        instructions:
          'Save this as vercel.json in the root of your repository. If you already have a vercel.json, add the "headers" array into your existing file. Commit and push — Vercel will pick it up automatically.',
      },
    ],
  };
}

// ── Netlify ───────────────────────────────────────────────────────────────
function generateNetlifyFix(findings: WebFinding[]): PlatformFixResult {
  const missing = getMissingHeaders(findings);
  if (missing.length === 0) {
    return { platform: "netlify", files: [], manualSteps: [] };
  }

  const headerLines = missing
    .map((name) => `  ${name}: ${DEFAULT_HEADER_VALUES[name] ?? ""}`)
    .join("\n");

  const content = `/*\n${headerLines}\n`;

  return {
    platform: "netlify",
    files: [
      {
        filename: "_headers",
        language: "text",
        content,
        instructions:
          'Save this as _headers in your website\'s publish directory (the folder Netlify deploys — usually "public", "dist", or "out"). Commit and push — Netlify applies it on the next deploy.',
      },
    ],
  };
}

// ── WordPress ─────────────────────────────────────────────────────────────
function generateWordPressFix(findings: WebFinding[]): PlatformFixResult {
  const missing = getMissingHeaders(findings);
  if (missing.length === 0) {
    return { platform: "wordpress", files: [], manualSteps: [] };
  }

  const phpLines = missing
    .map((name) => `  header('${name}: ${DEFAULT_HEADER_VALUES[name] ?? ""}');`)
    .join("\n");

  const content = `<?php
// Add this to your theme's functions.php file
// or install the "Code Snippets" plugin and paste it there.
add_action('send_headers', function() {
${phpLines}
});
?>`;

  const steps = [
    "Option A (Recommended — no code needed): Install the free 'HTTP Headers' plugin from wordpress.org/plugins/http-headers, activate it, and add each header through its settings panel.",
    "Option B (Code): Go to Appearance → Theme Editor → functions.php and paste the PHP snippet above before the closing ?>. Or use the 'Code Snippets' plugin to add it safely.",
    "Option C (Server access): Add the headers to your .htaccess file (Apache) or nginx site config.",
  ];

  return {
    platform: "wordpress",
    files: [
      {
        filename: "functions.php snippet",
        language: "php",
        content,
        instructions: "Copy this snippet and add it to your WordPress theme's functions.php file, or use the 'Code Snippets' plugin to paste it without editing core files.",
      },
    ],
    manualSteps: steps,
  };
}

// ── Generic nginx ─────────────────────────────────────────────────────────
function generateNginxFix(findings: WebFinding[]): PlatformFixResult {
  const missing = getMissingHeaders(findings);
  if (missing.length === 0) {
    return { platform: "unknown", files: [], manualSteps: [] };
  }

  const addHeaders = missing
    .map((name) => `    add_header ${name} "${DEFAULT_HEADER_VALUES[name] ?? ""}";`)
    .join("\n");

  const content = `# Add these lines inside your server { } block in nginx.conf
# or in /etc/nginx/sites-available/yourdomain.conf

server {
    # ... your existing config ...

${addHeaders}

    # ... rest of your config ...
}`;

  return {
    platform: "unknown",
    files: [
      {
        filename: "nginx.conf snippet",
        language: "nginx",
        content,
        instructions: "Copy these add_header lines into your nginx server block, then run 'sudo nginx -t' to verify syntax and 'sudo systemctl reload nginx' to apply.",
      },
    ],
    manualSteps: [
      "For Apache: add Header set directives to your .htaccess or VirtualHost config.",
      "For Cloudflare: use Cloudflare's 'Transform Rules' to add response headers without touching your server.",
      "For Wix / Squarespace: these platforms do not support custom security headers yet. Migrating to Vercel, Netlify, or a self-hosted solution is the only way to fully control headers.",
    ],
  };
}

// ── Manual steps for no-code platforms ────────────────────────────────────
function generateManualSteps(platform: Platform, findings: WebFinding[]): PlatformFixResult {
  const missing = getMissingHeaders(findings);

  const platformGuides: Partial<Record<Platform, string[]>> = {
    wix: [
      "Wix does not support custom HTTP security headers through the editor.",
      "Workaround: Use Wix's 'Velo' developer platform. Go to Dev Mode → Add HTTP Functions → create a response middleware that adds headers.",
      "Alternatively, put your Wix site behind Cloudflare (free plan) and use Cloudflare Transform Rules to add the missing headers.",
      `Missing headers: ${missing.join(", ")}`,
    ],
    squarespace: [
      "Squarespace does not support custom HTTP security headers.",
      "Workaround: Put your Squarespace site behind Cloudflare (free plan) and use Cloudflare Transform Rules > Modify Response Header.",
      "Go to: Cloudflare Dashboard → your domain → Rules → Transform Rules → Modify Response Header → Create rule.",
      `Add these headers: ${missing.join(", ")}`,
    ],
    webflow: [
      "Webflow supports custom response headers on paid hosting plans.",
      "Go to: Project Settings → Hosting → Custom Headers → add each header.",
      "If on the free plan, put your site behind Cloudflare and add headers via Transform Rules.",
      `Headers to add: ${missing.join(", ")}`,
    ],
    framer: [
      "Framer supports custom headers on Pro plans.",
      "Go to: Site Settings → SEO → Custom Code, or contact Framer support for header configuration.",
      "Alternatively, route through Cloudflare and use Transform Rules to add headers.",
      `Headers to add: ${missing.join(", ")}`,
    ],
    shopify: [
      "Shopify does not allow modifying HTTP security headers directly.",
      "For most headers, use a Shopify app like 'Security Headers' from the Shopify App Store.",
      "For CSP specifically, Shopify's built-in Content Security Policy can be customised in the theme's settings.",
      `Headers to configure: ${missing.join(", ")}`,
    ],
    "cloudflare-pages": [
      "Cloudflare Pages supports headers via a _headers file in your build output.",
      "Create a _headers file in your project root with the same format as Netlify (/* at the top, then header: value lines).",
      "Commit and push — Cloudflare Pages applies it on the next deployment.",
      `Missing: ${missing.join(", ")}`,
    ],
    "github-pages": [
      "GitHub Pages does not support custom HTTP security headers.",
      "To add security headers, migrate to Netlify or Vercel (both have free plans and are just as easy to deploy to).",
      "Alternatively, put your GitHub Pages site behind Cloudflare and add headers via Transform Rules.",
      `Headers needed: ${missing.join(", ")}`,
    ],
  };

  const steps = platformGuides[platform] ?? [
    "Check your hosting provider's documentation for how to add custom HTTP response headers.",
    `Headers to add: ${missing.join(", ")}`,
  ];

  return { platform, files: [], manualSteps: steps };
}

// ── Main entry point ───────────────────────────────────────────────────────
export function generatePlatformFix(platform: Platform, findings: WebFinding[]): PlatformFixResult {
  switch (platform) {
    case "vercel":          return generateVercelFix(findings);
    case "netlify":         return generateNetlifyFix(findings);
    case "wordpress":       return generateWordPressFix(findings);
    case "unknown":         return generateNginxFix(findings);
    default:                return generateManualSteps(platform, findings);
  }
}
