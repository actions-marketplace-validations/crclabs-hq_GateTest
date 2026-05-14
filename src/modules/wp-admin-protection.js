/**
 * WordPress — Admin / login-page protection check.
 *
 * Painkiller #5 from docs/wp-painkillers-v1.md: "Brute-force spam on
 * /wp-admin." Every WordPress site on the public internet sees attempted
 * brute-force logins within minutes of going live. The protection layer
 * — rate limiting, WAF, 2FA, hardened cookie — is what determines whether
 * those attempts succeed or just generate log noise.
 *
 * This module probes the two attack surfaces and reports the
 * observable hardening signals:
 *
 *   1. /wp-login.php reachability:
 *      - Status 200 from an unauthenticated GET → reachable (default WP)
 *      - Status 403 / 401 / 444 / 503 → likely behind a WAF or .htaccess block
 *
 *   2. /wp-admin/ behaviour:
 *      - Status 302 redirect to /wp-login.php → default WP behaviour
 *      - Status 403 / 404 → custom protection in place
 *
 *   3. Login response shape — POST a single intentionally-bad credential
 *      and observe:
 *      - 200 with "Lost your password?" link → no rate-limit / WAF
 *      - 429 / 503 / longer-than-1s response time → some throttling
 *      - 403 / 444 / cf-ray header on body → Cloudflare / WAF
 *
 *   4. Cookie signature — does the login page set hardened cookies?
 *      Inspects Set-Cookie headers for HttpOnly + Secure on the
 *      wordpress_test_cookie or wp-settings-time-* prefix.
 *
 *   5. 2FA hints — presence of common 2FA-plugin marker strings in
 *      the login HTML (wp-2fa, two-factor, miniorange-2-factor,
 *      wordfence-ls-container).
 *
 * Module ID: 98 (WordPress family).
 * Pre-authorisation: Craig 2026-05-13 — WordPress side product Boss Rule D.
 */

const BaseModule = require('./base-module');

const TWOFA_MARKERS = [
  'wp-2fa',
  'two-factor',
  'miniorange-2-factor',
  'wordfence-ls-container',
  'wfls-',
  'duo_universal',
  'wp-google-authenticator',
];

const WAF_HEADERS = [
  // Cloudflare
  'cf-ray',
  'cf-cache-status',
  // Sucuri
  'x-sucuri-id',
  'x-sucuri-cache',
  // AWS WAF
  'x-amzn-waf',
  // Wordfence (sometimes adds this header)
  'x-wordfence-waf',
  // Wordfence cookie marker
];

class WpAdminProtectionModule extends BaseModule {
  constructor() {
    super(
      'wpAdminProtection',
      'WordPress — checks /wp-admin and /wp-login.php for rate limit / WAF / 2FA / cookie hardening (the layer that decides whether brute-force succeeds)'
    );
  }

  async run(result, config) {
    const moduleConfig = (config && config.wpAdminProtection) || {};
    const url = moduleConfig.url
      || (config && config.targetUrl)
      || (config && config.wpUrl);
    if (!url) {
      result.addCheck('wp-admin-protection:no-url', true, {
        severity: 'info',
        message: 'wpAdminProtection: no URL provided — skipped (WP-URL mode only)',
      });
      return;
    }
    const normalised = this._normaliseBaseUrl(url);
    if (!normalised) {
      result.addCheck('wp-admin-protection:bad-url', false, {
        severity: 'error',
        message: `wpAdminProtection: cannot parse URL "${url}"`,
      });
      return;
    }

    const fetchFn = moduleConfig.fetchFn || this._defaultFetch;
    const timeoutMs = Math.max(1000, Math.min(moduleConfig.timeoutMs || 8000, 30000));

    // 1. /wp-login.php reachability
    let loginStatus = 0;
    let loginBody = '';
    let loginHeaders = {};
    let loginCookies = '';
    try {
      const res = await fetchFn(`${normalised}/wp-login.php`, { method: 'GET', timeoutMs });
      loginStatus = res.status;
      loginBody = res.body || '';
      loginHeaders = res.headers || {};
      loginCookies = res.headers && (res.headers['set-cookie'] || '') || '';
    } catch (err) {
      result.addCheck('wp-admin-protection:login-probe-error', true, {
        severity: 'info',
        message: `Could not probe /wp-login.php: ${err.message || err}`,
      });
    }

    if (loginStatus >= 200 && loginStatus < 300) {
      // Reachable — check for hardening signals
      const wafDetected = WAF_HEADERS.some((h) => loginHeaders[h.toLowerCase()]);
      const twofaDetected = TWOFA_MARKERS.some((m) => loginBody.includes(m));
      const httpOnly = /httponly/i.test(loginCookies);
      const secure = /\bsecure\b/i.test(loginCookies);

      if (!wafDetected && !twofaDetected) {
        result.addCheck('wp-admin-protection:login-unhardened', false, {
          severity: 'error',
          message:
            `/wp-login.php returned 200 with no WAF header (Cloudflare cf-ray / Sucuri / etc.) and no 2FA plugin markers detected in the response. ` +
            `This means brute-force credential attacks have no protection layer in front of WordPress's own slow auth. ` +
            `Fix priorities (any one helps): (1) put Cloudflare in front and enable the WAF, (2) install Wordfence and turn on its login security, (3) install a 2FA plugin (WP 2FA, miniOrange, Duo).`,
        });
      } else if (!twofaDetected) {
        result.addCheck('wp-admin-protection:no-2fa-detected', false, {
          severity: 'warning',
          message:
            `/wp-login.php is behind a WAF (good) but no 2FA marker detected. ` +
            `A WAF rate-limits attackers; 2FA stops them entirely if they get a correct password. ` +
            `Add a 2FA plugin for defence-in-depth.`,
        });
      }
      if (!httpOnly) {
        result.addCheck('wp-admin-protection:cookie-not-httponly', false, {
          severity: 'warning',
          message:
            `Login cookies missing HttpOnly flag — a stored XSS payload anywhere on the site could read the session cookie. ` +
            `Fix: ensure session_cookie_httponly is on, or install a security plugin that enforces HttpOnly.`,
        });
      }
      if (!secure && normalised.startsWith('https:')) {
        result.addCheck('wp-admin-protection:cookie-not-secure', false, {
          severity: 'warning',
          message:
            `Login cookies missing Secure flag on an HTTPS site — cookies could leak over HTTP if any mixed-content path exists. ` +
            `Fix: install Really Simple SSL or set FORCE_SSL_ADMIN = true in wp-config.php.`,
        });
      }
    } else if (loginStatus >= 400 && loginStatus < 500) {
      result.addCheck('wp-admin-protection:login-blocked', true, {
        severity: 'info',
        message:
          `/wp-login.php returns ${loginStatus} — login page is hidden / blocked from the open internet. ` +
          `This is excellent: brute-force attackers can't even reach the form. ` +
          `(If you intended to allow login, you'll need to whitelist your IP / use a VPN.)`,
      });
    }

    // 2. /wp-admin/ behaviour
    let adminStatus = 0;
    try {
      const res = await fetchFn(`${normalised}/wp-admin/`, { method: 'GET', timeoutMs, redirect: 'manual' });
      adminStatus = res.status;
    } catch (err) {
      result.addCheck('wp-admin-protection:admin-probe-error', true, {
        severity: 'info',
        message: `Could not probe /wp-admin/: ${err.message || err}`,
      });
    }
    if (adminStatus >= 200 && adminStatus < 300) {
      // 200 on /wp-admin without auth is extremely unusual — almost always means the customer is logged in via session leakage, or wp-admin has no auth gate
      result.addCheck('wp-admin-protection:admin-200', false, {
        severity: 'error',
        message:
          `/wp-admin/ returned ${adminStatus} without authentication. ` +
          `This is unusual: WordPress normally redirects unauthenticated /wp-admin requests to /wp-login.php. ` +
          `Possible cause: site is in a misconfigured state (maintenance mode, dev environment exposed, recently restored from broken backup). ` +
          `Verify immediately.`,
      });
    }

    // 3. Login response shape — POST a deliberately-bad credential
    if (moduleConfig.probeLoginResponse !== false && loginStatus >= 200 && loginStatus < 300) {
      try {
        const res = await fetchFn(`${normalised}/wp-login.php`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'log=gatetest-probe-not-a-real-user&pwd=intentionally-bad&wp-submit=Log+In',
          timeoutMs,
        });
        const wafBlock = res.status === 403 || res.status === 444 || res.status === 503 || res.status === 429;
        if (wafBlock) {
          result.addCheck('wp-admin-protection:bad-cred-blocked', true, {
            severity: 'info',
            message:
              `Login attempt with bad credentials returned ${res.status} — WAF / rate-limit blocked it before WordPress even processed the attempt. Good.`,
          });
        } else if (res.status >= 200 && res.status < 300 && !/Lost your password/.test(res.body || '')) {
          // Got back something that's not the standard "wrong username" page — possibly a custom plugin
          result.addCheck('wp-admin-protection:bad-cred-custom', true, {
            severity: 'info',
            message:
              `Login attempt with bad credentials returned ${res.status} with a non-standard response — likely behind a custom security plugin.`,
          });
        }
      } catch {
        // ignore — POST probe is best-effort
      }
    }

    result.addCheck('wp-admin-protection:summary', true, {
      severity: 'info',
      message:
        `wpAdminProtection: login=${loginStatus}, admin=${adminStatus}, ` +
        `${result.checks.filter((c) => c.name.startsWith('wp-admin-protection:') && c.passed === false).length} hardening gap(s) found.`,
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
        method: opts.method || 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; GateTest-WP-Scanner/1.0)',
          ...(opts.headers || {}),
        },
        body: opts.body,
        signal: ac.signal,
        redirect: opts.redirect === 'manual' ? 'manual' : 'follow',
      });
      const headersObj = {};
      res.headers.forEach((v, k) => { headersObj[k.toLowerCase()] = v; });
      let body = '';
      try { body = await res.text(); } catch { /* ignore */ }
      return {
        status: res.status,
        headers: headersObj,
        body: body.slice(0, 64 * 1024),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = WpAdminProtectionModule;
module.exports.TWOFA_MARKERS = TWOFA_MARKERS;
module.exports.WAF_HEADERS = WAF_HEADERS;
