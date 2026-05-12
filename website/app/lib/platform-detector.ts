/**
 * Platform Detector — identifies what technology stack a website runs on
 * from its HTTP response headers and HTML content.
 *
 * Supports: WordPress, Wix, Squarespace, Webflow, Framer, Shopify,
 *           Vercel, Netlify, Cloudflare Pages, GitHub Pages, generic
 *           static hosts, and custom/unknown stacks.
 *
 * The platform determines which fix instructions are shown in URL scan
 * results — e.g., Vercel users get a downloadable vercel.json, WordPress
 * users get a plugin recommendation + code snippet.
 */

export type Platform =
  | "wordpress"
  | "wix"
  | "squarespace"
  | "webflow"
  | "framer"
  | "shopify"
  | "vercel"
  | "netlify"
  | "cloudflare-pages"
  | "github-pages"
  | "ghost"
  | "drupal"
  | "joomla"
  | "unknown";

export interface PlatformInfo {
  platform: Platform;
  label: string;
  confidence: "high" | "medium" | "low";
  canAutoFix: boolean; // true = we can generate a downloadable fix file
  fixFileType?: "vercel.json" | "netlify.toml" | "_headers" | "plugin";
}

const PLATFORM_LABELS: Record<Platform, string> = {
  wordpress: "WordPress",
  wix: "Wix",
  squarespace: "Squarespace",
  webflow: "Webflow",
  framer: "Framer",
  shopify: "Shopify",
  vercel: "Vercel",
  netlify: "Netlify",
  "cloudflare-pages": "Cloudflare Pages",
  "github-pages": "GitHub Pages",
  ghost: "Ghost",
  drupal: "Drupal",
  joomla: "Joomla",
  unknown: "Unknown Platform",
};

export function detectPlatform(headers: Headers, html: string, finalUrl: string): PlatformInfo {
  const h = (name: string) => (headers.get(name) || "").toLowerCase();
  const htmlLower = html.slice(0, 50_000).toLowerCase(); // only scan first 50KB

  // ── Vercel ───────────────────────────────────────────────────────────────
  if (h("x-vercel-id") || h("server") === "vercel" || h("x-vercel-cache")) {
    return { platform: "vercel", label: "Vercel", confidence: "high", canAutoFix: true, fixFileType: "vercel.json" };
  }

  // ── Netlify ──────────────────────────────────────────────────────────────
  if (h("x-nf-request-id") || h("server").includes("netlify") || h("netlify-cache-tag")) {
    return { platform: "netlify", label: "Netlify", confidence: "high", canAutoFix: true, fixFileType: "_headers" };
  }

  // ── Cloudflare Pages ─────────────────────────────────────────────────────
  if (h("cf-ray") || h("cf-cache-status")) {
    return { platform: "cloudflare-pages", label: "Cloudflare Pages", confidence: "high", canAutoFix: false };
  }

  // ── GitHub Pages ─────────────────────────────────────────────────────────
  if (h("server") === "github.com" || finalUrl.includes(".github.io")) {
    return { platform: "github-pages", label: "GitHub Pages", confidence: "high", canAutoFix: false };
  }

  // ── WordPress ─────────────────────────────────────────────────────────────
  if (
    htmlLower.includes("/wp-content/") ||
    htmlLower.includes("/wp-includes/") ||
    htmlLower.includes('name="generator" content="wordpress') ||
    (h("link") || "").includes("api.w.org")
  ) {
    return { platform: "wordpress", label: "WordPress", confidence: "high", canAutoFix: true, fixFileType: "plugin" };
  }

  // ── Wix ──────────────────────────────────────────────────────────────────
  if (
    h("x-wix-renderer-server") ||
    htmlLower.includes("static.wixstatic.com") ||
    htmlLower.includes("wix.com/_api/") ||
    htmlLower.includes("wixcode")
  ) {
    return { platform: "wix", label: "Wix", confidence: "high", canAutoFix: false };
  }

  // ── Squarespace ──────────────────────────────────────────────────────────
  if (
    h("server").includes("squarespace") ||
    htmlLower.includes("squarespace.com") ||
    htmlLower.includes("static1.squarespace.com")
  ) {
    return { platform: "squarespace", label: "Squarespace", confidence: "high", canAutoFix: false };
  }

  // ── Webflow ───────────────────────────────────────────────────────────────
  if (
    h("x-powered-by").includes("webflow") ||
    htmlLower.includes("webflow.com") ||
    htmlLower.includes("data-wf-page") ||
    htmlLower.includes("data-wf-site")
  ) {
    return { platform: "webflow", label: "Webflow", confidence: "high", canAutoFix: false };
  }

  // ── Framer ────────────────────────────────────────────────────────────────
  if (htmlLower.includes("framerusercontent.com") || htmlLower.includes("framer.com/m/")) {
    return { platform: "framer", label: "Framer", confidence: "high", canAutoFix: false };
  }

  // ── Shopify ───────────────────────────────────────────────────────────────
  if (
    h("x-shopid") ||
    h("x-shopify-stage") ||
    htmlLower.includes("cdn.shopify.com") ||
    htmlLower.includes("myshopify.com")
  ) {
    return { platform: "shopify", label: "Shopify", confidence: "high", canAutoFix: false };
  }

  // ── Ghost ─────────────────────────────────────────────────────────────────
  if (
    h("x-ghost-cache-status") ||
    htmlLower.includes('name="generator" content="ghost')
  ) {
    return { platform: "ghost", label: "Ghost", confidence: "high", canAutoFix: false };
  }

  // ── Drupal ────────────────────────────────────────────────────────────────
  if (h("x-drupal-cache") || htmlLower.includes('name="generator" content="drupal')) {
    return { platform: "drupal", label: "Drupal", confidence: "high", canAutoFix: false };
  }

  // ── Joomla ────────────────────────────────────────────────────────────────
  if (htmlLower.includes('name="generator" content="joomla')) {
    return { platform: "joomla", label: "Joomla", confidence: "high", canAutoFix: false };
  }

  return { platform: "unknown", label: PLATFORM_LABELS.unknown, confidence: "low", canAutoFix: false };
}
