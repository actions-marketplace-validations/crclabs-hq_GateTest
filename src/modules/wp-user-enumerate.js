/**
 * WordPress — User-enumeration / username-leak detector.
 *
 * Painkiller #5 (brute-force enabler) from docs/wp-painkillers-v1.md.
 * When an attacker knows your admin username, brute-forcing the password
 * is HALF as much work. Most WordPress installs leak usernames through
 * multiple default-on paths:
 *
 *   1. `/?author=1` redirect: visiting this URL on a default WP install
 *      redirects to /author/<username>/ — leaking the username.
 *
 *   2. `/wp-json/wp/v2/users`: the REST API endpoint returns a JSON array
 *      of all users with their `slug` and `name` fields. On many sites
 *      this is publicly readable without authentication.
 *
 *   3. `/author/admin/`: if a user with slug "admin" exists, this URL
 *      returns 200 and you've confirmed `admin` is a valid username.
 *
 *   4. Author RSS feeds: `/author/<slug>/feed/` mirrors the author URL
 *      check; sometimes accessible even when the author page itself
 *      is blocked.
 *
 * Each leak is independently fixable via a plugin or a 3-line snippet
 * in functions.php. Module reports any that succeed.
 *
 * Module ID: 97 (WordPress family).
 * Pre-authorisation: Craig 2026-05-13 — WordPress side product Boss Rule D.
 */

const BaseModule = require('./base-module');

class WpUserEnumerateModule extends BaseModule {
  constructor() {
    super(
      'wpUserEnumerate',
      'WordPress — checks if usernames can be enumerated via /?author=1, /wp-json/wp/v2/users, or /author/admin/'
    );
  }

  async run(result, config) {
    const moduleConfig = (config && config.wpUserEnumerate) || {};
    const url = moduleConfig.url
      || (config && config.targetUrl)
      || (config && config.wpUrl);
    if (!url) {
      result.addCheck('wp-user-enum:no-url', true, {
        severity: 'info',
        message: 'wpUserEnumerate: no URL provided — skipped (WP-URL mode only)',
      });
      return;
    }
    const normalised = this._normaliseBaseUrl(url);
    if (!normalised) {
      result.addCheck('wp-user-enum:bad-url', false, {
        severity: 'error',
        message: `wpUserEnumerate: cannot parse URL "${url}"`,
      });
      return;
    }

    const fetchFn = moduleConfig.fetchFn || this._defaultFetch;
    const timeoutMs = Math.max(1000, Math.min(moduleConfig.timeoutMs || 8000, 30000));

    // ── Vector 1: /?author=1 redirect ─────────────────────────────────────
    let authorRedirectUsername = null;
    try {
      const res = await fetchFn(`${normalised}/?author=1`, { timeoutMs, redirect: 'manual' });
      if (res.status >= 300 && res.status < 400 && res.location) {
        // Look for /author/<slug>/ in the Location header
        const m = res.location.match(/\/author\/([^/?#]+)/i);
        if (m) authorRedirectUsername = decodeURIComponent(m[1]);
      } else if (res.status === 200 && typeof res.body === 'string') {
        // Some setups don't redirect but include the author slug in the body
        const m = res.body.match(/\/author\/([a-z0-9._-]+)\/?/i);
        if (m) authorRedirectUsername = m[1];
      }
    } catch (err) {
      result.addCheck('wp-user-enum:author-probe-error', true, {
        severity: 'info',
        message: `Could not probe /?author=1: ${err.message || err}`,
      });
    }
    if (authorRedirectUsername) {
      result.addCheck('wp-user-enum:author-redirect', false, {
        severity: 'error',
        message:
          `/?author=1 leaks the admin username "${authorRedirectUsername}". ` +
          `Attackers now know half of your admin credential. ` +
          `Fix: install a security plugin (Wordfence, iThemes Security) that blocks ` +
          `author archives, OR add this to functions.php: ` +
          `add_action('template_redirect', function() { if (isset($_GET['author'])) wp_redirect(home_url(), 301); });`,
      });
    }

    // ── Vector 2: /wp-json/wp/v2/users REST API ───────────────────────────
    try {
      const res = await fetchFn(`${normalised}/wp-json/wp/v2/users`, { timeoutMs });
      if (res.status >= 200 && res.status < 300 && typeof res.body === 'string') {
        // Try to parse as JSON
        let users = null;
        try { users = JSON.parse(res.body); } catch { /* not JSON */ }
        if (Array.isArray(users) && users.length > 0) {
          const slugs = users
            .map((u) => (u && (u.slug || u.name)))
            .filter((s) => typeof s === 'string')
            .slice(0, 10);
          result.addCheck('wp-user-enum:rest-api', false, {
            severity: 'error',
            message:
              `/wp-json/wp/v2/users is publicly readable. ` +
              `${users.length} username(s) exposed: ${slugs.join(', ')}${users.length > slugs.length ? ', ...' : ''}. ` +
              `Fix: install a security plugin that blocks unauthenticated REST API access, ` +
              `OR add to functions.php: ` +
              `add_filter('rest_endpoints', function($endpoints) { unset($endpoints['/wp/v2/users']); unset($endpoints['/wp/v2/users/(?P<id>[\\\\d]+)']); return $endpoints; });`,
          });
        }
      }
    } catch (err) {
      result.addCheck('wp-user-enum:rest-probe-error', true, {
        severity: 'info',
        message: `Could not probe /wp-json/wp/v2/users: ${err.message || err}`,
      });
    }

    // ── Vector 3: /author/admin/ existence check ──────────────────────────
    const commonUsernames = Array.isArray(moduleConfig.commonUsernames)
      ? moduleConfig.commonUsernames
      : ['admin', 'administrator', 'webmaster'];
    const foundUsers = [];
    for (const name of commonUsernames) {
      try {
        const res = await fetchFn(`${normalised}/author/${encodeURIComponent(name)}/`, { timeoutMs });
        if (res.status >= 200 && res.status < 300) {
          foundUsers.push(name);
        }
      } catch {
        // Per-probe error is fine; skip
      }
    }
    if (foundUsers.length > 0) {
      result.addCheck('wp-user-enum:common-usernames', false, {
        severity: 'warning',
        message:
          `Common username(s) confirmed via /author/<slug>/ probes: ${foundUsers.join(', ')}. ` +
          `Attackers can target these accounts directly. ` +
          `Fix: rename these users in WordPress admin → Users (delete and recreate, or use a username-change plugin), ` +
          `OR block author archives entirely.`,
      });
    }

    // ── Summary ───────────────────────────────────────────────────────────
    const totalLeaks =
      (authorRedirectUsername ? 1 : 0) +
      (foundUsers.length > 0 ? 1 : 0);
    const restLeak = result.checks.some((c) => c.name === 'wp-user-enum:rest-api');
    const allLeaks = totalLeaks + (restLeak ? 1 : 0);

    result.addCheck('wp-user-enum:summary', true, {
      severity: 'info',
      message:
        allLeaks === 0
          ? `wpUserEnumerate: no username leaks detected via the 3 known vectors. Good.`
          : `wpUserEnumerate: ${allLeaks} username-leak vector(s) active. Lock these down to make brute-force attacks materially harder.`,
    });
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

  async _defaultFetch(url, opts) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), opts.timeoutMs || 8000);
    try {
      const res = await fetch(url, {
        method: 'GET',
        signal: ac.signal,
        redirect: opts.redirect === 'manual' ? 'manual' : 'follow',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GateTest-WP-Scanner/1.0)' },
      });
      let body = '';
      try { body = await res.text(); } catch { /* ignore */ }
      return {
        status: res.status,
        location: res.headers.get('location') || null,
        body: body.slice(0, 32 * 1024),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = WpUserEnumerateModule;
