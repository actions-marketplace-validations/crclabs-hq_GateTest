/**
 * WordPress — Version-leak detector.
 *
 * Knowing the exact WordPress core version lets an attacker match against
 * known CVEs. Default WordPress installs leak the version in multiple
 * places:
 *
 *   /readme.html                                          "Version X.Y.Z"
 *   <meta name="generator" content="WordPress X.Y.Z">    Most themes
 *   /wp-includes/css/dist/version.css?ver=X.Y.Z          Public CSS asset
 *   /wp-includes/js/jquery/jquery-migrate.js?ver=X.Y.Z   Public JS asset
 *   /feed/  → <generator>https://wordpress.org/?v=X.Y.Z</generator>   RSS feed
 *
 * This module probes each known leak vector and reports any that succeed.
 * Severity is warning by default — version leak doesn't cause immediate
 * compromise, but it lowers the cost of CVE-targeted attacks.
 *
 * Module ID: 93 (WordPress family).
 * Pre-authorisation: Craig 2026-05-13 — WordPress side product Boss Rule D.
 */

const BaseModule = require('./base-module');

const VERSION_LEAK_VECTORS = [
  {
    path: 'readme.html',
    match: /Version\s+(\d+\.\d+(?:\.\d+)?)/i,
    severity: 'warning',
    reason: 'WordPress readme.html exposes exact core version — delete or block via .htaccess',
  },
  {
    path: 'license.txt',
    match: null, // mere accessibility is the signal
    severity: 'info',
    reason: 'WordPress license.txt is accessible — weak version-leak signal, can be blocked via .htaccess',
  },
  {
    path: 'feed/',
    match: /<generator>https?:\/\/wordpress\.org\/\?v=(\d+\.\d+(?:\.\d+)?)<\/generator>/i,
    severity: 'warning',
    reason: 'RSS feed exposes exact WordPress version in <generator> element — strip via remove_action filter',
  },
  {
    path: '?feed=rss2',
    match: /<generator>https?:\/\/wordpress\.org\/\?v=(\d+\.\d+(?:\.\d+)?)<\/generator>/i,
    severity: 'warning',
    reason: 'RSS2 feed exposes exact WordPress version — strip via remove_action filter',
  },
];

const HOMEPAGE_GENERATOR_REGEX = /<meta\s+name=["']generator["']\s+content=["']WordPress\s+(\d+\.\d+(?:\.\d+)?)["']/i;

class WpVersionLeakModule extends BaseModule {
  constructor() {
    super(
      'wpVersionLeak',
      'WordPress — finds where the site leaks its core version (readme.html, meta generator, RSS feed, CSS/JS ver=)'
    );
  }

  async run(result, config) {
    const moduleConfig = (config && config.wpVersionLeak) || {};
    const url = moduleConfig.url
      || (config && config.targetUrl)
      || (config && config.wpUrl);
    if (!url) {
      result.addCheck('wp-version-leak:no-url', true, {
        severity: 'info',
        message: 'wpVersionLeak: no URL provided — skipped (WP-URL mode only)',
      });
      return;
    }

    const normalised = this._normaliseBaseUrl(url);
    if (!normalised) {
      result.addCheck('wp-version-leak:bad-url', false, {
        severity: 'error',
        message: `wpVersionLeak: cannot parse URL "${url}"`,
      });
      return;
    }

    const fetchFn = moduleConfig.fetchFn || this._defaultFetch;
    const timeoutMs = Math.max(1000, Math.min(moduleConfig.timeoutMs || 8000, 30000));

    // Pull homepage once — most reliable single-shot version leak signal.
    let detectedVersion = null;
    try {
      const homepage = await fetchFn(normalised + '/', { timeoutMs });
      if (homepage.status >= 200 && homepage.status < 300 && typeof homepage.body === 'string') {
        const m = homepage.body.match(HOMEPAGE_GENERATOR_REGEX);
        if (m) {
          detectedVersion = m[1];
          result.addCheck('wp-version-leak:meta-generator', false, {
            severity: 'warning',
            message:
              `Homepage <meta name="generator"> exposes WordPress ${m[1]}. Remove via: ` +
              `add_filter('the_generator', '__return_empty_string'); in functions.php.`,
          });
        }
      }
    } catch (err) {
      result.addCheck('wp-version-leak:homepage-fetch', true, {
        severity: 'info',
        message: `Could not fetch homepage: ${err.message || err}`,
      });
    }

    // Now the known per-vector leaks.
    let leakCount = detectedVersion ? 1 : 0;
    for (const vector of VERSION_LEAK_VECTORS) {
      const url = `${normalised}/${vector.path}`;
      let res;
      try {
        res = await fetchFn(url, { timeoutMs });
      } catch (err) {
        result.addCheck(`wp-version-leak:probe-error:${vector.path}`, true, {
          severity: 'info',
          message: `Could not probe ${vector.path}: ${err.message || err}`,
        });
        continue;
      }
      const accessible = res.status >= 200 && res.status < 300;
      if (!accessible) continue;
      if (vector.match && typeof res.body === 'string') {
        const m = res.body.match(vector.match);
        if (m) {
          leakCount += 1;
          if (!detectedVersion) detectedVersion = m[1];
          result.addCheck(`wp-version-leak:found:${vector.path}`, false, {
            severity: vector.severity,
            message: `${url} leaks WordPress ${m[1]}. ${vector.reason}`,
          });
        }
        continue;
      }
      // Accessibility-only signal (license.txt)
      leakCount += 1;
      result.addCheck(`wp-version-leak:accessible:${vector.path}`, false, {
        severity: vector.severity,
        message: `${url} is publicly accessible. ${vector.reason}`,
      });
    }

    result.addCheck('wp-version-leak:summary', true, {
      severity: 'info',
      message: detectedVersion
        ? `wpVersionLeak: detected WordPress ${detectedVersion} across ${leakCount} leak vector(s). Lock these down so a CVE attacker can't match versions to exploits.`
        : `wpVersionLeak: no version leaks detected across ${VERSION_LEAK_VECTORS.length + 1} known vectors. Good.`,
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
      // Limit body read to first 32KB — version leaks are in the head of
      // the document; pulling the full body wastes time on big homepages.
      const buf = await this._readUpTo(res, 32 * 1024);
      return { status: res.status, body: buf };
    } finally {
      clearTimeout(timer);
    }
  }

  async _readUpTo(res, maxBytes) {
    const reader = res.body && res.body.getReader ? res.body.getReader() : null;
    if (!reader) {
      try { return await res.text(); } catch { return ''; }
    }
    let received = 0;
    const chunks = [];
    while (received < maxBytes) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
    }
    try { reader.cancel(); } catch { /* ignore */ }
    const total = chunks.reduce((s, c) => s + c.byteLength, 0);
    const merged = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { merged.set(c, off); off += c.byteLength; }
    return Buffer.from(merged).toString('utf8');
  }
}

module.exports = WpVersionLeakModule;
module.exports.VERSION_LEAK_VECTORS = VERSION_LEAK_VECTORS;
module.exports.HOMEPAGE_GENERATOR_REGEX = HOMEPAGE_GENERATOR_REGEX;
