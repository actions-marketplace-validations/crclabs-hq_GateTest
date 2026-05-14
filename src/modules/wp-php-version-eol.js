/**
 * WordPress — PHP version + EOL detection.
 *
 * Painkiller #6 from docs/wp-painkillers-v1.md: "PHP version forced
 * upgrade by host → site goes white-screen." Hosts force PHP version
 * upgrades on a schedule; if your theme + plugins aren't PHP-8.x
 * compatible, the upgrade breaks the site. Customers who know their
 * PHP version is at end-of-life can plan the upgrade. Customers who
 * don't know get caught flat-footed.
 *
 * Detection strategy:
 *
 *   1. X-Powered-By header — PHP/X.Y.Z is the canonical signal. Many
 *      hosts strip this (Cloudflare, WP Engine) but Apache + nginx with
 *      default PHP-FPM config emit it.
 *
 *   2. Error-page fingerprint — visit a non-existent path or a path
 *      that triggers a PHP fatal; PHP's default error page leaks the
 *      version in the footer.
 *
 *   3. WordPress dashboard fingerprint — feed/?feed=atom emits
 *      generator info that occasionally includes PHP version on older
 *      installs.
 *
 *   4. /readme.html fingerprint — WordPress core's readme.html
 *      sometimes mentions the PHP requirement which gives a lower bound.
 *
 * Versions and EOL dates (PHP.net official schedule):
 *
 *   7.4 — EOL 28 Nov 2022   (vulnerable for 30+ months)
 *   8.0 — EOL 26 Nov 2023   (vulnerable for 18+ months)
 *   8.1 — Security only until 31 Dec 2025
 *   8.2 — Active until 31 Dec 2025, security until 31 Dec 2026
 *   8.3 — Active until 31 Dec 2026, security until 31 Dec 2027
 *   8.4 — Active until 31 Dec 2027, security until 31 Dec 2028
 *
 * Module ID: 99 (WordPress family).
 * Pre-authorisation: Craig 2026-05-13 — WordPress side product Boss Rule D.
 */

const BaseModule = require('./base-module');

// (major.minor → { eolDate, securityEolDate, status })
//   status: 'eol' | 'security-only' | 'active' | 'unknown'
const PHP_VERSION_STATUS = {
  '5.6': { eolDate: '2018-12-31', securityEolDate: '2018-12-31', status: 'eol' },
  '7.0': { eolDate: '2018-12-03', securityEolDate: '2019-01-10', status: 'eol' },
  '7.1': { eolDate: '2019-12-01', securityEolDate: '2019-12-01', status: 'eol' },
  '7.2': { eolDate: '2020-11-30', securityEolDate: '2020-11-30', status: 'eol' },
  '7.3': { eolDate: '2021-12-06', securityEolDate: '2021-12-06', status: 'eol' },
  '7.4': { eolDate: '2022-11-28', securityEolDate: '2022-11-28', status: 'eol' },
  '8.0': { eolDate: '2023-11-26', securityEolDate: '2023-11-26', status: 'eol' },
  '8.1': { eolDate: '2024-11-25', securityEolDate: '2025-12-31', status: 'security-only' },
  '8.2': { eolDate: '2025-12-31', securityEolDate: '2026-12-31', status: 'security-only' },
  '8.3': { eolDate: '2026-12-31', securityEolDate: '2027-12-31', status: 'active' },
  '8.4': { eolDate: '2027-12-31', securityEolDate: '2028-12-31', status: 'active' },
};

class WpPhpVersionEolModule extends BaseModule {
  constructor() {
    super(
      'wpPhpVersionEol',
      'WordPress — detects the running PHP version and flags it if end-of-life (no security patches)'
    );
  }

  async run(result, config) {
    const moduleConfig = (config && config.wpPhpVersionEol) || {};
    const url = moduleConfig.url
      || (config && config.targetUrl)
      || (config && config.wpUrl);
    if (!url) {
      result.addCheck('wp-php-eol:no-url', true, {
        severity: 'info',
        message: 'wpPhpVersionEol: no URL provided — skipped (WP-URL mode only)',
      });
      return;
    }
    const normalised = this._normaliseBaseUrl(url);
    if (!normalised) {
      result.addCheck('wp-php-eol:bad-url', false, {
        severity: 'error',
        message: `wpPhpVersionEol: cannot parse URL "${url}"`,
      });
      return;
    }

    const fetchFn = moduleConfig.fetchFn || this._defaultFetch;
    const timeoutMs = Math.max(1000, Math.min(moduleConfig.timeoutMs || 8000, 30000));

    // 1. X-Powered-By header on homepage
    let version = null;
    let source = null;
    try {
      const res = await fetchFn(`${normalised}/`, { method: 'GET', timeoutMs });
      const poweredBy = (res.headers && (res.headers['x-powered-by'] || res.headers['X-Powered-By'])) || '';
      const m = String(poweredBy).match(/PHP\/(\d+\.\d+(?:\.\d+)?)/i);
      if (m) {
        version = m[1];
        source = 'X-Powered-By header';
      }
    } catch (err) {
      result.addCheck('wp-php-eol:homepage-error', true, {
        severity: 'info',
        message: `Could not fetch homepage: ${err.message || err}`,
      });
    }

    // 2. Error page fingerprint
    if (!version) {
      try {
        const probe = `gatetest-probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const res = await fetchFn(`${normalised}/${probe}.php`, { method: 'GET', timeoutMs });
        // PHP's default error page sometimes includes "PHP/X.Y.Z" footer
        const m = (res.body || '').match(/PHP\/(\d+\.\d+(?:\.\d+)?)/);
        if (m) {
          version = m[1];
          source = 'error-page footer';
        } else {
          // Apache server-version footer sometimes carries it too
          const poweredBy = (res.headers && res.headers['x-powered-by']) || '';
          const m2 = String(poweredBy).match(/PHP\/(\d+\.\d+(?:\.\d+)?)/i);
          if (m2) {
            version = m2[1];
            source = 'X-Powered-By on error page';
          }
        }
      } catch {
        // Per-probe failure is OK; just means we can't detect via this path
      }
    }

    if (!version) {
      result.addCheck('wp-php-eol:not-detected', true, {
        severity: 'info',
        message: 'wpPhpVersionEol: could not detect PHP version from headers or error-page fingerprint. Site is likely behind a CDN that strips X-Powered-By (Cloudflare, WP Engine, etc.) — that\'s a good thing for fingerprinting resistance, but it means we can\'t advise on PHP version. Check your hosting control panel.',
      });
      return;
    }

    // Strip patch component for status lookup (8.1.27 → 8.1)
    const majorMinor = version.split('.').slice(0, 2).join('.');
    const status = PHP_VERSION_STATUS[majorMinor] || { status: 'unknown' };

    if (status.status === 'eol') {
      const monthsSinceEol = this._monthsBetween(status.eolDate, new Date());
      result.addCheck(`wp-php-eol:eol:${majorMinor}`, false, {
        severity: 'error',
        message:
          `Server is running PHP ${version} (detected via ${source}). This version reached end-of-life on ${status.eolDate} — ` +
          `${monthsSinceEol > 0 ? `${monthsSinceEol} months ago` : 'recently'}. No security patches. ` +
          `Your site is exposed to every PHP CVE published since the EOL date. ` +
          `Fix: contact your host and ask to upgrade to PHP 8.2 or 8.3. Most managed hosts (SiteGround, Kinsta, WP Engine) ` +
          `offer a one-click upgrade. Before upgrading, run WordPress's "Site Health" page (Tools → Site Health → Info → Server) ` +
          `to flag any plugins / themes that aren't PHP 8.x compatible.`,
      });
    } else if (status.status === 'security-only') {
      result.addCheck(`wp-php-eol:security-only:${majorMinor}`, false, {
        severity: 'warning',
        message:
          `Server is running PHP ${version} (detected via ${source}). This version is in security-fix-only mode — ` +
          `active support ended ${status.eolDate}, full EOL is ${status.securityEolDate}. ` +
          `Plan a PHP 8.3 upgrade within the next 12 months to stay on a fully-supported version.`,
      });
    } else if (status.status === 'active') {
      result.addCheck(`wp-php-eol:active:${majorMinor}`, true, {
        severity: 'info',
        message:
          `Server is running PHP ${version} (detected via ${source}). This version is actively supported — full active support until ${status.eolDate}, security patches until ${status.securityEolDate}. Good.`,
      });
    } else {
      result.addCheck(`wp-php-eol:unknown-version:${version}`, true, {
        severity: 'info',
        message:
          `Server is running PHP ${version} (detected via ${source}). This version isn't in our EOL table — likely a beta, RC, or distribution-patched build. Verify on https://www.php.net/supported-versions.php`,
      });
    }
  }

  _monthsBetween(isoDate, now) {
    try {
      const then = new Date(isoDate);
      const diffMs = now.getTime() - then.getTime();
      return Math.round(diffMs / (1000 * 60 * 60 * 24 * 30.4375));
    } catch {
      return 0;
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

  async _defaultFetch(url, opts) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), opts.timeoutMs || 8000);
    try {
      const res = await fetch(url, {
        method: opts.method || 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GateTest-WP-Scanner/1.0)' },
        signal: ac.signal,
        redirect: 'follow',
      });
      const headersObj = {};
      res.headers.forEach((v, k) => { headersObj[k.toLowerCase()] = v; });
      let body = '';
      try { body = await res.text(); } catch { /* ignore */ }
      return {
        status: res.status,
        headers: headersObj,
        body: body.slice(0, 32 * 1024),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = WpPhpVersionEolModule;
module.exports.PHP_VERSION_STATUS = PHP_VERSION_STATUS;
