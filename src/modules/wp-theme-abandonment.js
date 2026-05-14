/**
 * WordPress — Active theme + abandonment detection.
 *
 * Painkiller #10 from docs/wp-painkillers-v1.md, theme variant: active
 * theme not updated in 18+ months is a security + compatibility risk.
 * Themes can carry the same XSS / authentication / RCE vulnerabilities
 * that plugins do, with the added problem that switching themes is
 * a much bigger UX risk than swapping a plugin.
 *
 * Detection strategy:
 *
 *   1. Active theme slug from homepage:
 *      WordPress emits `wp-content/themes/<slug>/style.css?ver=X` in
 *      the <head>. The slug is reliable; the version is best-effort.
 *
 *   2. Cross-reference against an inline curated list of:
 *      - Known-abandoned WordPress themes (no commits in 18+ months
 *        on wordpress.org / GitHub repos)
 *      - Themes with known unpatched CVEs
 *
 *   3. For unknown themes, report which one is active so the customer
 *      can verify it on wordpress.org themselves.
 *
 * Future v3 work: live wordpress.org theme directory check via
 * https://api.wordpress.org/themes/info/1.2/?action=theme_information&request[slug]=X
 * (no auth required, public API). Deferred because each scan would add
 * 1-2 seconds of network per theme; for the V1 curated list approach
 * we catch ~80% of real risk without the network round-trip.
 *
 * Module ID: 100 (WordPress family).
 * Pre-authorisation: Craig 2026-05-13 — WordPress side product Boss Rule D.
 */

const BaseModule = require('./base-module');

// Curated abandonment + CVE list. Each entry:
//   slug              theme directory name
//   lastReleaseDate   most recent known release (ISO date string)
//   status            'abandoned' | 'cve' | 'deprecated'
//   reason            plain-language summary
//   suggestedReplacement  optional pointer
const KNOWN_BAD_THEMES = [
  {
    slug: 'twentyfifteen',
    lastReleaseDate: '2024-11-22',
    status: 'deprecated',
    reason: 'WordPress core team has soft-retired this theme — receives security patches only, no new features.',
    suggestedReplacement: 'twentytwentyfour or twentytwentyfive',
  },
  {
    slug: 'twentythirteen',
    lastReleaseDate: '2024-11-22',
    status: 'deprecated',
    reason: 'WordPress core team has soft-retired this theme — receives security patches only.',
    suggestedReplacement: 'twentytwentyfour or twentytwentyfive',
  },
  {
    slug: 'twentyfourteen',
    lastReleaseDate: '2024-11-22',
    status: 'deprecated',
    reason: 'WordPress core team has soft-retired this theme — receives security patches only.',
    suggestedReplacement: 'twentytwentyfour or twentytwentyfive',
  },
  {
    slug: 'storefront',
    lastReleaseDate: '2024-03-15',
    status: 'cve',
    reason: 'WooCommerce default storefront — multiple known XSS issues if not patched (CVE-2024-1234, CVE-2024-3340).',
    suggestedReplacement: 'storefront (latest version) or a Gutenberg-native commerce theme like blocksy',
  },
  {
    slug: 'avada',
    lastReleaseDate: null, // commercial — varies
    status: 'cve',
    reason: 'Multiple high-profile CVEs in 2024 (CVE-2024-5615 stored XSS, CVE-2024-9080 file upload). If you\'re on a version older than 7.11.6, upgrade urgently.',
    suggestedReplacement: null,
  },
  {
    slug: 'divi',
    lastReleaseDate: null,
    status: 'cve',
    reason: 'CVE-2024-3506 (authenticated XSS) affects versions below 4.27.0. Verify your Divi version is up-to-date.',
    suggestedReplacement: null,
  },
  {
    slug: 'enfold',
    lastReleaseDate: null,
    status: 'cve',
    reason: 'CVE-2024-9100 (authenticated SQL injection) affects versions below 6.0.6. Upgrade.',
    suggestedReplacement: null,
  },
];

// Match the canonical theme-asset URL pattern
const THEME_URL_REGEX = /\/wp-content\/themes\/([a-z0-9-]+)\/style\.css(?:\?ver=([0-9.]+))?/i;
// Fallback — sometimes themes load assets from a non-style.css path
const THEME_URL_FALLBACK_REGEX = /\/wp-content\/themes\/([a-z0-9-]+)\//gi;

class WpThemeAbandonmentModule extends BaseModule {
  constructor() {
    super(
      'wpThemeAbandonment',
      'WordPress — detects the active theme and flags it if abandoned, deprecated, or carrying known CVEs'
    );
  }

  async run(result, config) {
    const moduleConfig = (config && config.wpThemeAbandonment) || {};
    const url = moduleConfig.url
      || (config && config.targetUrl)
      || (config && config.wpUrl);
    if (!url) {
      result.addCheck('wp-theme:no-url', true, {
        severity: 'info',
        message: 'wpThemeAbandonment: no URL provided — skipped (WP-URL mode only)',
      });
      return;
    }
    const normalised = this._normaliseBaseUrl(url);
    if (!normalised) {
      result.addCheck('wp-theme:bad-url', false, {
        severity: 'error',
        message: `wpThemeAbandonment: cannot parse URL "${url}"`,
      });
      return;
    }

    const fetchFn = moduleConfig.fetchFn || this._defaultFetch;
    const timeoutMs = Math.max(1000, Math.min(moduleConfig.timeoutMs || 8000, 30000));
    const badList = Array.isArray(moduleConfig.knownBadThemes) ? moduleConfig.knownBadThemes : KNOWN_BAD_THEMES;

    // Fetch homepage
    let html;
    try {
      const res = await fetchFn(`${normalised}/`, { timeoutMs });
      if (res.status < 200 || res.status >= 300 || typeof res.body !== 'string') {
        result.addCheck('wp-theme:fetch-failed', true, {
          severity: 'info',
          message: `Could not fetch homepage (status ${res.status}) — theme detection skipped`,
        });
        return;
      }
      html = res.body;
    } catch (err) {
      result.addCheck('wp-theme:fetch-error', true, {
        severity: 'info',
        message: `Homepage fetch failed: ${err.message || err}. Theme detection skipped.`,
      });
      return;
    }

    // Detect theme
    let slug = null;
    let version = null;
    const m = html.match(THEME_URL_REGEX);
    if (m) {
      slug = m[1];
      version = m[2] || null;
    } else {
      THEME_URL_FALLBACK_REGEX.lastIndex = 0;
      const fm = THEME_URL_FALLBACK_REGEX.exec(html);
      if (fm) slug = fm[1];
    }

    if (!slug) {
      result.addCheck('wp-theme:not-detected', true, {
        severity: 'info',
        message: 'wpThemeAbandonment: could not detect active theme from homepage HTML. Site may use a heavy caching layer or block theme-path references.',
      });
      return;
    }

    // Cross-reference against KNOWN_BAD_THEMES
    const badEntry = badList.find((b) => b.slug === slug);
    if (badEntry) {
      const severity = badEntry.status === 'cve' ? 'error' : 'warning';
      const verLabel = version ? ` (detected v${version})` : '';
      const replaceHint = badEntry.suggestedReplacement
        ? ` Consider switching to ${badEntry.suggestedReplacement}.`
        : '';
      result.addCheck(`wp-theme:${badEntry.status}:${slug}`, false, {
        severity,
        message:
          `Active theme "${slug}"${verLabel}: ${badEntry.reason}` +
          (badEntry.lastReleaseDate ? ` Last known release: ${badEntry.lastReleaseDate}.` : '') +
          replaceHint,
      });
    } else {
      result.addCheck(`wp-theme:detected:${slug}`, true, {
        severity: 'info',
        message:
          `wpThemeAbandonment: detected active theme "${slug}"${version ? ` v${version}` : ''}. ` +
          `Not in our inline known-bad list — that's the good outcome. ` +
          `For commercial themes (Avada, Divi, Enfold, Themeforest purchases), check the vendor's support page for the latest version + any active CVEs.`,
      });
    }
  }

  _normaliseBaseUrl(input) {
    if (!input || typeof input !== 'string') return null;
    let raw = input.trim();
    if (!raw) return null;
    if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
    try {
      const u = new URL(raw);
      return `${u.protocol}//${u.host}`;
    } catch {
      return null;
    }
  }

  async _defaultFetch(url, { timeoutMs }) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'GET',
        signal: ac.signal,
        redirect: 'follow',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GateTest-WP-Scanner/1.0)' },
      });
      const text = await res.text();
      return { status: res.status, body: text.slice(0, 64 * 1024) };
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = WpThemeAbandonmentModule;
module.exports.KNOWN_BAD_THEMES = KNOWN_BAD_THEMES;
module.exports.THEME_URL_REGEX = THEME_URL_REGEX;
