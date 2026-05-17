/**
 * Live Site Crawler Module — tests a RUNNING website by visiting every page.
 *
 * Solves the real problem: "Claude says it's fixed but it's not."
 *
 * Crawls a live URL, checks every page for HTTP errors, JS console errors,
 * broken images, dead links, missing titles, blank pages, redirect chains,
 * mixed content, missing meta tags. Produces a structured report that can
 * be fed directly back to Claude for automated fix loops.
 *
 * Engines split into sibling files for length-budget compliance:
 *   - live-crawler-browser-engine.js — Playwright (JS-rendered, real DOM)
 *   - live-crawler-http-engine.js    — fetch-based (no JS execution)
 *   - live-crawler-http-helpers.js   — shared HTTP utilities + suggestions
 *   - live-crawler-report.js         — Claude-feedback markdown + JSON
 */

const BaseModule = require('./base-module');
const { URL } = require('url');
const { checkUrl, getSuggestion } = require('./live-crawler-http-helpers');
const { crawlWithBrowser } = require('./live-crawler-browser-engine');
const { crawlWithHttp } = require('./live-crawler-http-engine');
const { generateFeedbackReport } = require('./live-crawler-report');

class LiveCrawlerModule extends BaseModule {
  constructor() {
    super('liveCrawler', 'Live Site Crawl & Verification');
  }

  async run(result, config) {
    const crawlConfig = config.getModuleConfig('liveCrawler') || {};
    const baseUrl =
      crawlConfig.url ||
      config.get('liveCrawler.url') ||
      config.get('targetUrl') ||
      config.get('webUrl') ||
      config.get('wpUrl');

    if (!baseUrl) {
      result.addCheck('crawl:config', true, {
        message: 'No live URL configured — set modules.liveCrawler.url in .gatetest/config.json',
      });
      return;
    }

    const maxPages = crawlConfig.maxPages || 100;
    const timeout = crawlConfig.timeout || 10000;
    const checkExternal = crawlConfig.checkExternal !== false;
    const slowThresholdMs = crawlConfig.slowThresholdMs || 2500;

    const collectors = {
      visited: new Set(),
      queue: [baseUrl],
      pages: [],
      errors: [],
      brokenLinks: [],
      redirects: [],
      brokenImages: [],
      brokenScripts: [],
      brokenStylesheets: [],
      missingMetaDescription: [],
      missingCanonical: [],
      slowPages: [],
      anchorMissingId: [],
      titlesByUrl: new Map(),
    };

    let playwright = null;
    let useBrowser = crawlConfig.browser !== false;
    if (useBrowser) {
      try { playwright = require('playwright'); }
      catch { playwright = null; useBrowser = false; }
    }

    result.addCheck('crawl:start', true, {
      message: `Crawling ${baseUrl} (max ${maxPages} pages, mode: ${useBrowser ? 'browser (JS-rendered)' : 'HTTP-only'})...`,
    });

    const engineCtx = {
      baseUrl, maxPages, timeout, checkExternal, slowThresholdMs,
      ...collectors,
    };

    if (useBrowser) {
      await crawlWithBrowser(playwright, engineCtx);
    } else {
      await crawlWithHttp(engineCtx);
    }

    this._emitChecks(result, baseUrl, collectors);

    if (crawlConfig.checkSitemap !== false) await this._checkAuxUrl(result, baseUrl, '/sitemap.xml', timeout,
      'crawl:sitemap-missing', 'warning', 'No /sitemap.xml found',
      'Generate a sitemap.xml. Most frameworks have a plugin for this.');
    if (crawlConfig.checkRobotsTxt !== false) await this._checkAuxUrl(result, baseUrl, '/robots.txt', timeout,
      'crawl:robots-missing', 'info', 'No /robots.txt found',
      'Add a /robots.txt even if it just says "User-agent: *\\nAllow: /" — signals intentionality.');
    if (crawlConfig.checkFavicon !== false) await this._checkAuxUrl(result, baseUrl, '/favicon.ico', timeout,
      'crawl:favicon-missing', 'info', 'No /favicon.ico found',
      'Add a favicon.ico in the site root. Modern alternative: <link rel="icon" href="..."> in <head>.');

    generateFeedbackReport(config, {
      baseUrl,
      pagesScanned: collectors.pages.length,
      errors: collectors.errors,
      brokenLinks: collectors.brokenLinks,
      brokenImages: collectors.brokenImages,
      redirects: collectors.redirects,
    });
  }

  _emitChecks(result, baseUrl, c) {
    result.addCheck('crawl:pages-scanned', true, {
      message: `Crawled ${c.pages.length} page(s) from ${baseUrl}`,
    });

    if (c.errors.length > 0) {
      const grouped = {};
      for (const err of c.errors) {
        if (!grouped[err.type]) grouped[err.type] = [];
        grouped[err.type].push(err);
      }
      for (const [type, errs] of Object.entries(grouped)) {
        result.addCheck(`crawl:error:${type}`, false, {
          message: `${errs.length} "${type}" error(s) found`,
          details: errs.map(e => ({ url: e.url, message: e.message })),
          suggestion: getSuggestion(type),
        });
      }
    }

    this._emitListCheck(result, c.brokenLinks, 'crawl:broken-links', 'error',
      'broken link(s) found', 'Fix or remove broken links');
    this._emitListCheck(result, c.brokenImages, 'crawl:broken-images', 'error',
      'broken image(s) found', 'Fix image paths or replace missing images');
    this._emitListCheck(result, c.brokenScripts, 'crawl:broken-scripts', 'error',
      'broken script(s) found — features depending on these scripts will silently fail for real users',
      'Audit <script src> URLs. 404s typically mean a CDN deprecated the asset or a deploy didn\'t ship the bundle.');
    this._emitListCheck(result, c.brokenStylesheets, 'crawl:broken-stylesheets', 'error',
      'broken stylesheet(s) found — users see unstyled HTML',
      'Audit <link rel="stylesheet"> URLs and CDN endpoints for 404s.');
    this._emitListCheck(result, c.missingMetaDescription, 'crawl:missing-meta-description', 'warning',
      'page(s) missing meta description — Google generates poor snippet text for these pages',
      'Add <meta name="description" content="..."> to each page. Ideal length 150-160 characters.');
    this._emitListCheck(result, c.missingCanonical, 'crawl:missing-canonical', 'warning',
      'page(s) missing <link rel="canonical"> — risks duplicate-content SEO penalties',
      'Add <link rel="canonical" href="..."> pointing at the page\'s preferred URL.');
    this._emitListCheck(result, c.slowPages, 'crawl:slow-pages', 'warning',
      'page(s) slower than threshold — real users bounce on slow TTFB',
      'Investigate slow endpoints. Common causes: cold-start backends, unindexed DB queries, blocking 3rd-party scripts.');
    this._emitListCheck(result, c.anchorMissingId, 'crawl:anchor-missing-target', 'warning',
      'broken anchor link(s) — clicking does nothing for users',
      'Either remove the anchor or add the corresponding id="..." attribute to the target element.');

    const titleCounts = new Map();
    for (const t of c.titlesByUrl.values()) {
      titleCounts.set(t, (titleCounts.get(t) || 0) + 1);
    }
    const duplicateTitles = [];
    for (const [title, count] of titleCounts.entries()) {
      if (count > 1) {
        const urls = Array.from(c.titlesByUrl.entries())
          .filter(([, t]) => t === title)
          .map(([u]) => u);
        duplicateTitles.push({ title, count, urls });
      }
    }
    if (duplicateTitles.length > 0) {
      result.addCheck('crawl:duplicate-titles', false, {
        severity: 'warning',
        message: `${duplicateTitles.length} title(s) used by multiple pages — confuses users + dilutes SEO`,
        details: duplicateTitles.slice(0, 20),
        suggestion: 'Each page should have a unique <title> describing that page specifically.',
      });
    }

    if (c.redirects.length > 0) {
      result.addCheck('crawl:redirects', true, {
        message: `${c.redirects.length} redirect(s) detected`,
        details: c.redirects.slice(0, 20),
      });
    }

    if (c.errors.length === 0 && c.brokenLinks.length === 0 && c.brokenImages.length === 0) {
      result.addCheck('crawl:clean', true, {
        message: `Site is clean — ${c.pages.length} pages, 0 errors, 0 broken links, 0 broken images`,
      });
    }
  }

  _emitListCheck(result, list, key, severity, messageSuffix, suggestion) {
    if (list.length === 0) return;
    result.addCheck(key, false, {
      severity,
      message: `${list.length} ${messageSuffix}`,
      details: list.slice(0, 30),
      suggestion,
    });
  }

  async _checkAuxUrl(result, baseUrl, urlPath, timeout, key, severity, baseMessage, suggestion) {
    try {
      const auxUrl = new URL(urlPath, baseUrl).href;
      const r = await checkUrl(auxUrl, timeout);
      if (r.status >= 400) {
        result.addCheck(key, false, {
          severity,
          message: `${baseMessage} (HTTP ${r.status})`,
          suggestion,
        });
      }
    } catch { /* network error, skip silently */ }
  }
}

module.exports = LiveCrawlerModule;
