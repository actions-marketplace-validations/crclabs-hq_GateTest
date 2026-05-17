'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

const UA = 'GateTest/1.0 (Quality Assurance Crawler)';

function fetchPage(url, timeout) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const client = parsedUrl.protocol === 'https:' ? https : http;
    const startedAt = Date.now();

    const req = client.get(url, {
      timeout,
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*' },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, url).href;
        fetchPage(redirectUrl, timeout).then(redirectResult => {
          resolve({
            ...redirectResult,
            redirected: true,
            redirectStatus: res.statusCode,
            originalUrl: url,
          });
        }).catch(reject);
        return;
      }

      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        resolve({
          url,
          finalUrl: url,
          status: res.statusCode,
          statusText: res.statusMessage,
          contentType: res.headers['content-type'] || '',
          body,
          redirected: false,
          responseMs: Date.now() - startedAt,
        });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Timeout after ${timeout}ms`));
    });
  });
}

function checkUrl(url, timeout) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const client = parsedUrl.protocol === 'https:' ? https : http;

    const req = client.request(url, {
      method: 'HEAD',
      timeout,
      headers: { 'User-Agent': UA },
    }, (res) => {
      resolve({ url, status: res.statusCode, statusText: res.statusMessage });
      res.resume();
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
    req.end();
  });
}

function extractLinks(html, baseUrl, pageUrl) {
  const internal = [];
  const external = [];
  const hrefRegex = /href\s*=\s*["']([^"'#]+)/gi;
  let match;

  while ((match = hrefRegex.exec(html)) !== null) {
    const href = match[1].trim();
    if (href.startsWith('mailto:') || href.startsWith('tel:') ||
        href.startsWith('javascript:') || href.startsWith('data:')) continue;

    try {
      const resolved = new URL(href, pageUrl).href;
      if (resolved.startsWith(baseUrl)) {
        internal.push({ href: resolved, source: pageUrl });
      } else if (href.startsWith('http')) {
        external.push({ href: resolved, source: pageUrl });
      }
    } catch { /* invalid URL */ }
  }

  return { internal, external };
}

function extractImages(html, baseUrl, pageUrl) {
  const images = [];
  const srcRegex = /<img[^>]+src\s*=\s*["']([^"']+)/gi;
  let match;

  while ((match = srcRegex.exec(html)) !== null) {
    try {
      const resolved = new URL(match[1].trim(), pageUrl).href;
      images.push(resolved);
    } catch { /* invalid URL */ }
  }

  return images;
}

function getSuggestion(errorType) {
  const suggestions = {
    'http-error': 'Check server routes and ensure all pages return 200 status',
    'empty-page': 'Page is rendering blank — check component rendering and data loading',
    'missing-title': 'Add a <title> tag to every page for SEO and usability',
    'app-error': 'Application error displayed to users — check error boundaries and server logs',
    'server-error': 'Internal server error — check server logs and API endpoints',
    '404-content': 'Page displays 404 content — fix routing or remove dead links',
    'generic-error': 'Error message visible to users — fix the underlying issue',
    'js-error-in-html': 'JavaScript error rendered in page — check console and error boundaries',
    'js-runtime-error': 'JavaScript runtime error — check for null/undefined access patterns',
    'module-error': 'Module not found error — check imports and build configuration',
    'hydration-error': 'React hydration mismatch — ensure server and client render match',
    'runtime-error': 'Unhandled runtime error — add error boundaries and fix root cause',
    'mixed-content': 'HTTP resources on HTTPS page — update all resource URLs to HTTPS',
    'fetch-error': 'Page could not be loaded — check if the server is running',
  };
  return suggestions[errorType] || 'Investigate and fix the issue';
}

module.exports = { fetchPage, checkUrl, extractLinks, extractImages, getSuggestion };
