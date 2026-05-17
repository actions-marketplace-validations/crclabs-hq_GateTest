'use strict';

/**
 * Suite + tier recommender.
 *
 * Given a URL-stack profile (from url-stack-detector.js), pick the
 * best scan suite, tier, and emphasis modules for that customer. The
 * /api/scan/recommend endpoint surfaces this as a pre-scan suggestion
 * so customers don't have to know which checks apply to their stack.
 *
 * Suite vs tier:
 *   - **Suite**  = `web` | `wp` (which module set runs)
 *   - **Tier**   = `quick` ($29) | `full` ($99) | `scan_fix` ($199)
 *                  | `nuclear` ($399) — depth of fixes / depth of analysis
 *   - **Emphasis** = a list of high-priority modules for this customer's
 *                  stack, surfaced in the UI as "what we'll pay special
 *                  attention to."
 *
 * Pure JS. Deterministic. No I/O.
 */

const SUITE_DESCRIPTIONS = {
  web: {
    label: 'Generic web suite',
    modules: ['webHeaders', 'tlsSecurity', 'cookieSecurity', 'accessibility', 'seo', 'links', 'performance', 'liveCrawler', 'runtimeErrors', 'explorer'],
  },
  wp: {
    label: 'WordPress suite',
    modules: ['wpExposedFiles', 'wpVersionLeak', 'wpXmlrpcExposed', 'wpPluginCveCheck', 'wpMalwarePatterns', 'wpUserEnumerate', 'wpAdminProtection', 'wpPhpVersionEol', 'wpThemeAbandonment', 'wpBackupValidation', 'webHeaders', 'tlsSecurity', 'cookieSecurity', 'accessibility', 'seo', 'links', 'performance', 'liveCrawler', 'runtimeErrors', 'explorer'],
  },
};

const TIER_DESCRIPTIONS = {
  quick:    { label: 'Quick',     priceUsd: 29,  description: 'Top issues, free preview, fast feedback' },
  full:     { label: 'Full',      priceUsd: 99,  description: 'Every clustered issue + fix instructions + health score' },
  scan_fix: { label: 'Scan + Fix', priceUsd: 199, description: 'Full + pair-review + architecture annotation' },
  nuclear:  { label: 'Nuclear',   priceUsd: 399, description: 'Full + Claude diagnosis + attack-chain correlation + mutation + chaos + executive summary' },
};

/**
 * Pick suite, tier, emphasis modules for a customer's profile.
 *
 * @param {Object} input
 * @param {Object} input.profile  output of url-stack-detector.classify()
 * @returns {{
 *   suite: 'web' | 'wp',
 *   tier: 'quick' | 'full' | 'scan_fix' | 'nuclear',
 *   emphasis: string[],
 *   reasoning: string[],
 *   ctaUrl: string,
 *   suiteDescription: string,
 *   tierDescription: string,
 *   priceUsd: number,
 * }}
 */
function recommendForProfile({ profile }) {
  const p = profile || {};
  const reasoning = [];
  const emphasis = new Set();

  // ── Suite selection ────────────────────────────────────────────────
  let suite = 'web';
  if (p.cms === 'WordPress') {
    suite = 'wp';
    reasoning.push('WordPress detected — using the WordPress-specific suite (10 extra probes for malware, exposed files, XML-RPC, plugin CVEs, etc.).');
    emphasis.add('wpExposedFiles');
    emphasis.add('wpXmlrpcExposed');
    emphasis.add('wpPluginCveCheck');
    emphasis.add('wpAdminProtection');
  } else {
    reasoning.push('No WordPress markers found — using the generic web suite.');
  }

  // ── Tier selection ─────────────────────────────────────────────────
  // Default to Quick (free preview). Promote up when the surface
  // suggests deeper checks justify the higher tier.
  let tier = 'quick';

  if (p.hasEcommerce || p.cms === 'Shopify') {
    tier = 'full';
    reasoning.push('E-commerce surface detected — recommend Full scan to cover payment-page security, broken checkout flows, and cart-related JS errors.');
    emphasis.add('tlsSecurity');
    emphasis.add('cookieSecurity');
    emphasis.add('runtimeErrors');
    emphasis.add('explorer');
  }

  if (p.hasAdminPath) {
    tier = tier === 'quick' ? 'full' : tier;
    reasoning.push('Admin / login path referenced in HTML — recommend deeper scan to surface brute-force exposure, missing rate-limit, and login-form CSRF.');
    emphasis.add('wpAdminProtection');
    emphasis.add('cookieSecurity');
    emphasis.add('webHeaders');
  }

  if (p.hasApi) {
    tier = tier === 'quick' ? 'full' : tier;
    reasoning.push('API endpoints detected — Full or higher recommended for proper API security and CORS / auth checks.');
    emphasis.add('webHeaders');
    emphasis.add('runtimeErrors');
  }

  // ── Framework-specific emphasis ────────────────────────────────────
  if (p.framework === 'Next.js' || p.framework === 'Nuxt' || p.framework === 'Remix' || p.framework === 'SvelteKit') {
    emphasis.add('runtimeErrors');     // hydration mismatches show up here
    emphasis.add('explorer');
    reasoning.push(`${p.framework} detected — runtime browser capture will flag hydration mismatches, console errors during load, and CSP violations.`);
  }
  if (p.framework === 'React' || p.framework === 'Vue' || p.framework === 'Angular') {
    emphasis.add('runtimeErrors');
  }
  if (p.isStatic) {
    reasoning.push('Site looks static / no-framework — most modules still apply (headers, TLS, links, SEO), but runtime-errors will be near-empty.');
    emphasis.add('webHeaders');
    emphasis.add('seo');
    emphasis.add('links');
  }

  // ── CDN-specific notes ─────────────────────────────────────────────
  if (p.cdn === 'Cloudflare') {
    reasoning.push('Cloudflare in front — headers are largely controlled there, not at your origin. Customer report will surface this so they fix headers in the right place.');
  } else if (p.cdn === 'Vercel') {
    reasoning.push('Vercel in front — header config typically lives in next.config.ts headers() or vercel.json.');
  }

  // ── Suggest Nuclear when many surfaces stack ───────────────────────
  const surfaceFlags = [p.cms === 'WordPress', p.hasEcommerce, p.hasAdminPath, p.hasApi].filter(Boolean).length;
  if (surfaceFlags >= 3) {
    tier = 'nuclear';
    reasoning.push('Multiple high-risk surfaces (admin + API + e-commerce / WordPress) — Nuclear recommended for cross-finding attack-chain correlation.');
  }

  // ── Fallback emphasis when none yet ────────────────────────────────
  if (emphasis.size === 0) {
    emphasis.add('webHeaders');
    emphasis.add('tlsSecurity');
    emphasis.add('seo');
  }

  const suiteDesc = SUITE_DESCRIPTIONS[suite] || SUITE_DESCRIPTIONS.web;
  const tierDesc = TIER_DESCRIPTIONS[tier];
  const ctaUrl = suite === 'wp' && tier === 'quick'
    ? '/api/checkout?tier=wp_health'
    : `/api/checkout?tier=${tier}`;

  return {
    suite,
    tier,
    emphasis: Array.from(emphasis),
    reasoning,
    ctaUrl,
    suiteDescription: suiteDesc.label,
    tierDescription: tierDesc.description,
    priceUsd: tierDesc.priceUsd,
  };
}

module.exports = {
  SUITE_DESCRIPTIONS,
  TIER_DESCRIPTIONS,
  recommendForProfile,
};
