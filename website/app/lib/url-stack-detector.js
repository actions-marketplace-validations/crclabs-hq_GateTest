'use strict';

/**
 * URL stack detector.
 *
 * Probes a public URL with ONE HTTP GET, parses the response headers
 * and the HTML body, and returns a compact profile of what's running.
 * The suite-recommender then uses this profile to pick the optimal
 * scan tier + module set so a customer doesn't have to know which
 * checks apply to their stack.
 *
 * Pure-ish: only side effect is the single HTTP fetch. Deterministic
 * given identical responses. Used by /api/scan/recommend.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const FETCH_TIMEOUT_MS = 8000;
const MAX_BODY_BYTES = 200 * 1024; // 200 KB — enough for HTML <head> + early body

function fetchProbe(url, timeoutMs = FETCH_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); }
    catch { reject(new Error('Invalid URL')); return; }
    const client = parsed.protocol === 'https:' ? https : http;
    const startedAt = Date.now();
    const req = client.get(url, {
      timeout: timeoutMs,
      headers: {
        'User-Agent': 'GateTest/1.0 (URL Stack Detector +https://gatetest.ai/bot)',
        Accept: 'text/html,application/xhtml+xml,*/*',
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Follow ONE redirect — most sites redirect / to /en or HTTPS.
        try {
          const next = new URL(res.headers.location, url).href;
          fetchProbe(next, timeoutMs).then((r) => resolve({ ...r, redirected: true, originalUrl: url }))
            .catch(reject);
        } catch (e) { reject(e); }
        return;
      }
      let bytes = 0;
      let body = '';
      res.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_BODY_BYTES) {
          body += chunk.toString('utf8', 0, MAX_BODY_BYTES - (bytes - chunk.length));
          req.destroy();
        } else {
          body += chunk.toString('utf8');
        }
      });
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body,
        responseMs: Date.now() - startedAt,
        finalUrl: url,
        redirected: false,
      }));
    });
    req.on('timeout', () => { req.destroy(new Error(`probe timed out after ${timeoutMs}ms`)); });
    req.on('error', reject);
  });
}

/**
 * Parse a probe response into a structured stack profile.
 *
 * @param {{status:number, headers:Record<string,string|string[]>, body:string}} probe
 * @returns {{
 *   framework: string|null,
 *   cms: string|null,
 *   server: string|null,
 *   cdn: string|null,
 *   language: string|null,
 *   hasAdminPath: boolean,
 *   hasApi: boolean,
 *   hasEcommerce: boolean,
 *   isStatic: boolean,
 *   hints: string[],
 * }}
 */
function classify(probe) {
  const hints = [];
  const headers = probe.headers || {};
  const body = probe.body || '';
  const lower = body.toLowerCase().slice(0, 50000); // cap body checks at 50KB

  const headerVal = (k) => {
    const v = headers[k.toLowerCase()];
    return Array.isArray(v) ? v.join(', ') : (v || '');
  };

  let framework = null;
  let cms = null;
  let server = null;
  let cdn = null;
  let language = null;

  // ── CMS / framework detection ──────────────────────────────────────
  if (/wp-content|wp-includes|wp-json/.test(lower)) {
    cms = 'WordPress';
    hints.push('Detected WordPress markup (wp-content/wp-includes/wp-json)');
  } else if (/<meta\s+name=["']generator["']\s+content=["']wordpress/i.test(body)) {
    cms = 'WordPress';
    hints.push('Detected WordPress via generator meta tag');
  } else if (/cdn\.shopify\.com|shopify-section|Shopify\.theme/i.test(body)) {
    cms = 'Shopify';
    hints.push('Detected Shopify storefront');
  } else if (/cdn\.shopifycloud\.com/i.test(body)) {
    cms = 'Shopify';
  } else if (/<meta\s+name=["']generator["']\s+content=["']drupal/i.test(body)) {
    cms = 'Drupal';
  } else if (/<meta\s+name=["']generator["']\s+content=["']joomla/i.test(body)) {
    cms = 'Joomla';
  } else if (/<meta\s+name=["']generator["']\s+content=["']ghost/i.test(body)) {
    cms = 'Ghost';
  } else if (/squarespace/i.test(lower) && /<meta[^>]+squarespace/i.test(body)) {
    cms = 'Squarespace';
  } else if (/wix\.com|x-wix-/i.test(lower + headerVal('server'))) {
    cms = 'Wix';
  } else if (/webflow/i.test(lower) && /<meta[^>]+webflow/i.test(body)) {
    cms = 'Webflow';
  }

  if (/__next_data__|\/_next\/static/i.test(body)) {
    framework = 'Next.js';
    hints.push('Detected Next.js (__NEXT_DATA__ / _next/static)');
  } else if (/__nuxt__|\/_nuxt\//i.test(body)) {
    framework = 'Nuxt';
  } else if (/data-reactroot|data-react-helmet/i.test(body) || /react(?:-dom)?[.@]/i.test(body.slice(0, 5000))) {
    framework = framework || 'React';
  } else if (/ng-version|<app-root/i.test(body)) {
    framework = 'Angular';
  } else if (/data-v-[0-9a-f]{6,}/i.test(body)) {
    framework = 'Vue';
  } else if (/data-sveltekit|__sveltekit/i.test(body)) {
    framework = 'SvelteKit';
  } else if (/data-astro-/i.test(body)) {
    framework = 'Astro';
  } else if (/remix-run/i.test(body)) {
    framework = 'Remix';
  } else if (/hugo|gatsby/i.test(headerVal('x-generator'))) {
    framework = headerVal('x-generator');
  }

  // ── Server / CDN / language ────────────────────────────────────────
  const serverHeader = headerVal('server').toLowerCase();
  if (serverHeader) {
    if (/cloudflare/.test(serverHeader)) { cdn = 'Cloudflare'; server = 'Cloudflare'; }
    else if (/vercel/.test(serverHeader)) { cdn = 'Vercel'; server = 'Vercel'; }
    else if (/netlify/.test(serverHeader)) { cdn = 'Netlify'; server = 'Netlify'; }
    else if (/fastly/.test(serverHeader)) { cdn = 'Fastly'; }
    else if (/cloudfront/.test(serverHeader)) { cdn = 'CloudFront'; }
    else if (/akamai/.test(serverHeader)) { cdn = 'Akamai'; }
    else if (/nginx/.test(serverHeader)) { server = 'nginx'; }
    else if (/apache/.test(serverHeader)) { server = 'Apache'; }
    else if (/iis/.test(serverHeader)) { server = 'IIS'; }
    else if (/caddy/.test(serverHeader)) { server = 'Caddy'; }
    else server = headerVal('server').slice(0, 40);
  }
  if (!cdn) {
    if (headerVal('cf-ray')) { cdn = 'Cloudflare'; }
    else if (headerVal('x-vercel-id')) { cdn = 'Vercel'; }
    else if (headerVal('x-fastly-request-id')) { cdn = 'Fastly'; }
    else if (headerVal('x-amz-cf-id')) { cdn = 'CloudFront'; }
  }

  const poweredBy = headerVal('x-powered-by').toLowerCase();
  if (poweredBy) {
    if (/php/.test(poweredBy)) language = 'PHP';
    else if (/express/.test(poweredBy)) language = 'Node (Express)';
    else if (/asp\.net/.test(poweredBy)) language = '.NET';
    else if (/next\.js/.test(poweredBy)) { framework = framework || 'Next.js'; language = 'Node'; }
    else if (/ruby|rails/.test(poweredBy)) language = 'Ruby';
    else if (/python|django|flask/.test(poweredBy)) language = 'Python';
  }
  if (!language && cms === 'WordPress') language = 'PHP';
  if (!language && framework === 'Next.js') language = 'Node';

  // ── Surface flags ─────────────────────────────────────────────────
  const hasApi = /<link[^>]+href=["'][^"']*\/api\//i.test(body) ||
                 /["']\/api\//i.test(body) ||
                 /<link[^>]+href=["'][^"']*\/graphql/i.test(body) ||
                 /graphql/i.test(body.slice(0, 5000));
  const hasEcommerce = /\b(?:add to cart|checkout|cart|product-add-to-cart|woocommerce)\b/i.test(lower) ||
                       cms === 'Shopify' ||
                       /<meta\s+property=["']og:type["']\s+content=["']product/i.test(body);
  const isStatic =
    !cms && !framework && !poweredBy &&
    !/<script[^>]*src=/i.test(body) &&
    !/data-react|data-v-|__nuxt|__next/i.test(body);
  const hasAdminPath =
    /\/wp-admin|\/wp-login|\/admin\/?["'>]|\/administrator\/?["'>]|\/dashboard/i.test(body);

  if (cms) hints.push(`CMS: ${cms}`);
  if (framework) hints.push(`Framework: ${framework}`);
  if (server) hints.push(`Server: ${server}`);
  if (cdn && cdn !== server) hints.push(`CDN: ${cdn}`);
  if (language) hints.push(`Language: ${language}`);
  if (hasApi) hints.push('API endpoints detected');
  if (hasEcommerce) hints.push('E-commerce surface detected');
  if (hasAdminPath) hints.push('Admin / login path referenced in HTML');
  if (isStatic) hints.push('Looks like a static / no-framework site');

  return { framework, cms, server, cdn, language, hasAdminPath, hasApi, hasEcommerce, isStatic, hints };
}

/**
 * One-shot helper: probe + classify.
 *
 * @param {string} url
 * @returns {Promise<{ok:true, profile, probe} | {ok:false, error:string}>}
 */
async function detectStackForUrl(url) {
  try {
    const probe = await fetchProbe(url);
    const profile = classify(probe);
    return { ok: true, profile, probe: { status: probe.status, responseMs: probe.responseMs, finalUrl: probe.finalUrl, redirected: probe.redirected || false } };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

module.exports = {
  FETCH_TIMEOUT_MS,
  classify,
  fetchProbe,
  detectStackForUrl,
};
