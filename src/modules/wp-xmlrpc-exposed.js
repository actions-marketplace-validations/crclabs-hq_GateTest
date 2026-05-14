/**
 * WordPress — XML-RPC endpoint exposure detector.
 *
 * /xmlrpc.php is one of the most-attacked endpoints on the entire WP
 * ecosystem. It enables:
 *
 *   - Brute-force amplification: wp.getUsersBlogs lets an attacker test
 *     hundreds of credentials per request, bypassing per-request limits.
 *   - DDoS amplification: pingback.ping lets an attacker tell your server
 *     to ping a target — turning your site into a DDoS reflector.
 *   - Authentication bypass: stacked method calls can bypass some auth
 *     plugins that only check /wp-login.php.
 *
 * 99% of modern WordPress sites don't NEED xmlrpc.php — it's a legacy
 * interface for desktop publishing clients. The recommendation is to
 * disable it via .htaccess, a security plugin, or a one-line filter.
 *
 * Detection: probe /xmlrpc.php with two requests:
 *   1. GET — a working endpoint returns the famous string
 *      "XML-RPC server accepts POST requests only."
 *   2. POST with a system.listMethods body — a working endpoint returns
 *      a SOAP-style XML response listing all available methods.
 *
 * Either signal confirms the endpoint is live. Both signals together
 * is high-confidence.
 *
 * Module ID: 94 (WordPress family).
 * Pre-authorisation: Craig 2026-05-13 — WordPress side product Boss Rule D.
 */

const BaseModule = require('./base-module');

const GET_FINGERPRINT = /XML-RPC server accepts POST requests only/i;
const POST_FINGERPRINT = /<methodResponse>|<methodCall>|<param>/i;
const PINGBACK_AVAILABLE_REGEX = /<value>\s*<string>\s*pingback\.ping\s*<\/string>/i;

class WpXmlrpcExposedModule extends BaseModule {
  constructor() {
    super(
      'wpXmlrpcExposed',
      'WordPress — checks if /xmlrpc.php is exposed (brute-force amplification + DDoS reflector + auth-bypass surface)'
    );
  }

  async run(result, config) {
    const moduleConfig = (config && config.wpXmlrpcExposed) || {};
    const url = moduleConfig.url
      || (config && config.targetUrl)
      || (config && config.wpUrl);
    if (!url) {
      result.addCheck('wp-xmlrpc:no-url', true, {
        severity: 'info',
        message: 'wpXmlrpcExposed: no URL provided — skipped (WP-URL mode only)',
      });
      return;
    }

    const normalised = this._normaliseBaseUrl(url);
    if (!normalised) {
      result.addCheck('wp-xmlrpc:bad-url', false, {
        severity: 'error',
        message: `wpXmlrpcExposed: cannot parse URL "${url}"`,
      });
      return;
    }

    const fetchFn = moduleConfig.fetchFn || this._defaultFetch;
    const timeoutMs = Math.max(1000, Math.min(moduleConfig.timeoutMs || 8000, 30000));
    const xmlrpcUrl = `${normalised}/xmlrpc.php`;

    // GET probe
    let getSignal = false;
    let getStatus = 0;
    try {
      const res = await fetchFn(xmlrpcUrl, { method: 'GET', timeoutMs });
      getStatus = res.status;
      if (res.status >= 200 && res.status < 300 && typeof res.body === 'string') {
        getSignal = GET_FINGERPRINT.test(res.body);
      }
    } catch (err) {
      result.addCheck('wp-xmlrpc:get-error', true, {
        severity: 'info',
        message: `GET ${xmlrpcUrl} failed: ${err.message || err}`,
      });
    }

    // POST probe — system.listMethods is the cheapest meaningful call
    let postSignal = false;
    let pingbackAvailable = false;
    let postStatus = 0;
    try {
      const body = '<?xml version="1.0"?><methodCall><methodName>system.listMethods</methodName><params/></methodCall>';
      const res = await fetchFn(xmlrpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml' },
        body,
        timeoutMs,
      });
      postStatus = res.status;
      if (res.status >= 200 && res.status < 300 && typeof res.body === 'string') {
        postSignal = POST_FINGERPRINT.test(res.body);
        pingbackAvailable = PINGBACK_AVAILABLE_REGEX.test(res.body);
      }
    } catch (err) {
      result.addCheck('wp-xmlrpc:post-error', true, {
        severity: 'info',
        message: `POST ${xmlrpcUrl} failed: ${err.message || err}`,
      });
    }

    const exposed = getSignal || postSignal;
    if (!exposed) {
      result.addCheck('wp-xmlrpc:not-exposed', true, {
        severity: 'info',
        message: `wpXmlrpcExposed: /xmlrpc.php appears to be disabled or blocked (GET=${getStatus}, POST=${postStatus}). Good.`,
      });
      return;
    }

    // Severity is error when pingback is available (DDoS reflector),
    // warning otherwise (still a brute-force amplifier).
    if (pingbackAvailable) {
      result.addCheck('wp-xmlrpc:pingback-available', false, {
        severity: 'error',
        message:
          `${xmlrpcUrl} is exposed AND pingback.ping is enabled. ` +
          `Your site can be weaponised as a DDoS reflector against third parties. ` +
          `Fix immediately: add to .htaccess "<Files xmlrpc.php> Require all denied </Files>" ` +
          `or disable pingbacks via "add_filter('xmlrpc_methods', function($m){unset($m['pingback.ping']);return $m;});".`,
      });
    } else {
      result.addCheck('wp-xmlrpc:exposed', false, {
        severity: 'warning',
        message:
          `${xmlrpcUrl} is exposed (XML-RPC active). Used for brute-force amplification — ` +
          `an attacker can test many credentials per request. ` +
          `Recommendation: disable via .htaccess unless you actively use desktop publishing or Jetpack.`,
      });
    }

    result.addCheck('wp-xmlrpc:summary', true, {
      severity: 'info',
      message: `wpXmlrpcExposed: GET-fingerprint=${getSignal}, POST-fingerprint=${postSignal}, pingback-available=${pingbackAvailable}`,
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
        redirect: 'manual',
      });
      let body = '';
      try { body = await res.text(); } catch { /* ignore */ }
      return { status: res.status, body: body.slice(0, 32 * 1024) };
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = WpXmlrpcExposedModule;
module.exports.GET_FINGERPRINT = GET_FINGERPRINT;
module.exports.POST_FINGERPRINT = POST_FINGERPRINT;
module.exports.PINGBACK_AVAILABLE_REGEX = PINGBACK_AVAILABLE_REGEX;
