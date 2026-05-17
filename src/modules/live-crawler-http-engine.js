'use strict';

const { URL } = require('url');
const { fetchPage, checkUrl, extractLinks, extractImages } = require('./live-crawler-http-helpers');

const ERROR_PATTERNS = [
  { regex: /application error/i, type: 'app-error' },
  { regex: /internal server error/i, type: 'server-error' },
  { regex: /page not found/i, type: '404-content' },
  { regex: /something went wrong/i, type: 'generic-error' },
  { regex: /uncaught (type)?error/i, type: 'js-error-in-html' },
  { regex: /cannot read propert/i, type: 'js-runtime-error' },
  { regex: /module not found/i, type: 'module-error' },
  { regex: /hydration failed/i, type: 'hydration-error' },
  { regex: /unhandled runtime error/i, type: 'runtime-error' },
];

async function crawlWithHttp(ctx) {
  const {
    baseUrl, maxPages, timeout, checkExternal,
    visited, pages, errors, brokenLinks, brokenImages, redirects, queue,
    // Phase-2 collectors (closure-bug fix: explicit pass-through)
    brokenScripts, brokenStylesheets,
    missingMetaDescription, missingCanonical,
    slowPages, slowThresholdMs, anchorMissingId, titlesByUrl,
  } = ctx;

  while (queue.length > 0 && visited.size < maxPages) {
    const url = queue.shift();
    if (!url || visited.has(url)) continue;
    visited.add(url);

    try {
      const pageResult = await fetchPage(url, timeout);
      pages.push(pageResult);

      if (pageResult.status >= 400) {
        errors.push({ url, status: pageResult.status, type: 'http-error',
          message: `HTTP ${pageResult.status} ${pageResult.statusText}` });
      }

      if (pageResult.redirected) {
        redirects.push({ from: url, to: pageResult.finalUrl, status: pageResult.redirectStatus });
      }

      if (!pageResult.contentType?.includes('text/html')) continue;
      if (!pageResult.body) continue;

      const body = pageResult.body;
      const textContent = body.replace(/<[^>]*>/g, '').trim();
      if (textContent.length < 50 && !url.includes('api')) {
        errors.push({ url, type: 'empty-page',
          message: `Page appears blank or nearly empty (${textContent.length} chars of text)` });
      }

      const titleMatch = body.match(/<title>([^<]*)<\/title>/i);
      if (!titleMatch || titleMatch[1].trim().length === 0) {
        errors.push({ url, type: 'missing-title', message: 'Page has no <title> or title is empty' });
      } else {
        titlesByUrl.set(url, titleMatch[1].trim());
      }

      const metaDescMatch = body.match(/<meta\s+[^>]*name\s*=\s*["']description["'][^>]*content\s*=\s*["']([^"']*)["']/i);
      if (!metaDescMatch || metaDescMatch[1].trim().length === 0) {
        missingMetaDescription.push({ url, message: 'No meta description tag' });
      }

      const canonicalMatch = body.match(/<link\s+[^>]*rel\s*=\s*["']canonical["'][^>]*href\s*=\s*["']([^"']+)["']/i);
      if (!canonicalMatch) {
        missingCanonical.push({ url, message: 'No <link rel="canonical"> tag' });
      }

      if (pageResult.responseMs && pageResult.responseMs > slowThresholdMs) {
        slowPages.push({ url, responseMs: pageResult.responseMs,
          message: `Page took ${pageResult.responseMs}ms (threshold ${slowThresholdMs}ms)` });
      }

      const idsOnPage = new Set();
      const idRegex = /\bid\s*=\s*["']([^"'\s]+)["']/gi;
      let idMatch;
      while ((idMatch = idRegex.exec(body)) !== null) {
        idsOnPage.add(idMatch[1]);
      }
      const anchorRegex = /<a\s+[^>]*href\s*=\s*["']#([^"'\s]+)["']/gi;
      let anchorMatch;
      while ((anchorMatch = anchorRegex.exec(body)) !== null) {
        const targetId = anchorMatch[1];
        if (!idsOnPage.has(targetId)) {
          anchorMissingId.push({ page: url, anchor: `#${targetId}`,
            message: `<a href="#${targetId}"> targets a non-existent id` });
        }
      }

      for (const { regex, type } of ERROR_PATTERNS) {
        if (regex.test(body)) {
          errors.push({ url, type, message: `Error pattern detected on page: "${type}"` });
        }
      }

      const links = extractLinks(body, baseUrl, url);
      for (const link of links.internal) {
        if (!visited.has(link.href) && !queue.includes(link.href)) queue.push(link.href);
      }

      const images = extractImages(body, baseUrl, url);
      for (const imgUrl of images) {
        try {
          const imgResult = await checkUrl(imgUrl, timeout);
          if (imgResult.status >= 400) {
            brokenImages.push({ page: url, image: imgUrl, status: imgResult.status });
          }
        } catch {
          brokenImages.push({ page: url, image: imgUrl, status: 'timeout/error' });
        }
      }

      await collectAssetStatuses(body, url, timeout, brokenScripts, brokenStylesheets);

      if (checkExternal) {
        for (const link of links.external.slice(0, 20)) {
          try {
            const linkResult = await checkUrl(link.href, timeout);
            if (linkResult.status >= 400) {
              brokenLinks.push({ page: url, link: link.href, status: linkResult.status, type: 'external' });
            }
          } catch {
            brokenLinks.push({ page: url, link: link.href, status: 'timeout/error', type: 'external' });
          }
        }
      }

      if (url.startsWith('https://')) {
        const httpResources = body.match(/(?:src|href|action)\s*=\s*["']http:\/\//gi);
        if (httpResources && httpResources.length > 0) {
          errors.push({ url, type: 'mixed-content',
            message: `${httpResources.length} HTTP resource(s) on HTTPS page (mixed content)` });
        }
      }

    } catch (err) {
      errors.push({ url, type: 'fetch-error', message: `Failed to fetch: ${err.message}` });
    }
  }
}

async function collectAssetStatuses(body, url, timeout, brokenScripts, brokenStylesheets) {
  const scriptRegex = /<script[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
  const scriptUrls = new Set();
  let scriptMatch;
  while ((scriptMatch = scriptRegex.exec(body)) !== null) {
    try {
      const resolved = new URL(scriptMatch[1].trim(), url).href;
      scriptUrls.add(resolved);
    } catch { /* invalid URL */ }
  }
  for (const scriptUrl of scriptUrls) {
    try {
      const r = await checkUrl(scriptUrl, timeout);
      if (r.status >= 400) brokenScripts.push({ page: url, script: scriptUrl, status: r.status });
    } catch {
      brokenScripts.push({ page: url, script: scriptUrl, status: 'timeout/error' });
    }
  }

  const styleRegex = /<link\s+[^>]*rel\s*=\s*["'](?:stylesheet|preload)["'][^>]*href\s*=\s*["']([^"']+)["']/gi;
  const styleUrls = new Set();
  let styleMatch;
  while ((styleMatch = styleRegex.exec(body)) !== null) {
    try {
      const resolved = new URL(styleMatch[1].trim(), url).href;
      styleUrls.add(resolved);
    } catch { /* invalid URL */ }
  }
  for (const styleUrl of styleUrls) {
    try {
      const r = await checkUrl(styleUrl, timeout);
      if (r.status >= 400) brokenStylesheets.push({ page: url, stylesheet: styleUrl, status: r.status });
    } catch {
      brokenStylesheets.push({ page: url, stylesheet: styleUrl, status: 'timeout/error' });
    }
  }
}

module.exports = { crawlWithHttp };
