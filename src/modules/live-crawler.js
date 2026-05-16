/**
 * Live Site Crawler Module - Tests a RUNNING website by visiting every page.
 *
 * This is the module that solves the real problem:
 * "Claude says it's fixed but it's not."
 *
 * It crawls a live URL, checks every page for:
 * - HTTP errors (404, 500, etc.)
 * - JavaScript console errors
 * - Broken images
 * - Dead links (internal and external)
 * - Missing page titles
 * - Empty pages / blank screens
 * - Redirect chains
 * - Mixed content (HTTP on HTTPS)
 * - Missing meta tags
 *
 * Produces a structured report that can be fed directly back to Claude
 * for automated fix loops.
 */

const BaseModule = require('./base-module');
const http = require('http');
const https = require('https');
const { URL } = require('url');

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

    const visited = new Set();
    const queue = [baseUrl];
    const pages = [];
    const errors = [];
    const brokenLinks = [];
    const redirects = [];
    const brokenImages = [];
    // Phase 2 — richer per-page + cross-page surfaces. Each list feeds a
    // distinct addCheck() at the end so the url-finding-clusterer groups
    // them cleanly into the customer report.
    const brokenScripts = [];
    const brokenStylesheets = [];
    const missingMetaDescription = [];
    const missingCanonical = [];
    const slowPages = [];
    const anchorMissingId = [];
    const titlesByUrl = new Map();              // url -> trimmed title (for duplicate detection)
    const slowThresholdMs = crawlConfig.slowThresholdMs || 2500;

    // Determine crawl mode: Playwright (JS-rendered) or HTTP-only
    let playwright = null;
    let useBrowser = crawlConfig.browser !== false; // Default: try browser mode
    if (useBrowser) {
      try {
        playwright = require('playwright');
      } catch {
        playwright = null;
        useBrowser = false;
      }
    }

    result.addCheck('crawl:start', true, {
      message: `Crawling ${baseUrl} (max ${maxPages} pages, mode: ${useBrowser ? 'browser (JS-rendered)' : 'HTTP-only'})...`,
    });

    if (useBrowser) {
      // BROWSER MODE: Full JS execution, console error capture, real DOM inspection
      await this._crawlWithBrowser(playwright, baseUrl, maxPages, timeout, checkExternal,
        visited, pages, errors, brokenLinks, brokenImages, redirects, queue, result);
    } else {
      // FALLBACK: HTTP-only mode (no JS execution)
      await this._crawlWithHttp(baseUrl, maxPages, timeout, checkExternal,
        visited, pages, errors, brokenLinks, brokenImages, redirects, queue, result);
    }

    // Record results
    result.addCheck('crawl:pages-scanned', true, {
      message: `Crawled ${pages.length} page(s) from ${baseUrl}`,
    });

    if (errors.length > 0) {
      // Group errors by type for clearer reporting
      const grouped = {};
      for (const err of errors) {
        if (!grouped[err.type]) grouped[err.type] = [];
        grouped[err.type].push(err);
      }

      for (const [type, errs] of Object.entries(grouped)) {
        result.addCheck(`crawl:error:${type}`, false, {
          message: `${errs.length} "${type}" error(s) found`,
          details: errs.map(e => ({ url: e.url, message: e.message })),
          suggestion: this._getSuggestion(type),
        });
      }
    }

    if (brokenLinks.length > 0) {
      result.addCheck('crawl:broken-links', false, {
        message: `${brokenLinks.length} broken link(s) found`,
        details: brokenLinks.slice(0, 30),
        suggestion: 'Fix or remove broken links',
      });
    }

    if (brokenImages.length > 0) {
      result.addCheck('crawl:broken-images', false, {
        message: `${brokenImages.length} broken image(s) found`,
        details: brokenImages.slice(0, 30),
        suggestion: 'Fix image paths or replace missing images',
      });
    }

    if (brokenScripts.length > 0) {
      result.addCheck('crawl:broken-scripts', false, {
        severity: 'error',
        message: `${brokenScripts.length} broken script(s) found — features depending on these scripts will silently fail for real users`,
        details: brokenScripts.slice(0, 30),
        suggestion: 'Audit <script src> URLs. 404s typically mean a CDN deprecated the asset or a deploy didn\'t ship the bundle.',
      });
    }

    if (brokenStylesheets.length > 0) {
      result.addCheck('crawl:broken-stylesheets', false, {
        severity: 'error',
        message: `${brokenStylesheets.length} broken stylesheet(s) found — users see unstyled HTML`,
        details: brokenStylesheets.slice(0, 30),
        suggestion: 'Audit <link rel="stylesheet"> URLs and CDN endpoints for 404s.',
      });
    }

    if (missingMetaDescription.length > 0) {
      result.addCheck('crawl:missing-meta-description', false, {
        severity: 'warning',
        message: `${missingMetaDescription.length} page(s) missing meta description — Google generates poor snippet text for these pages`,
        details: missingMetaDescription.slice(0, 30),
        suggestion: 'Add <meta name="description" content="..."> to each page. Ideal length 150-160 characters.',
      });
    }

    if (missingCanonical.length > 0) {
      result.addCheck('crawl:missing-canonical', false, {
        severity: 'warning',
        message: `${missingCanonical.length} page(s) missing <link rel="canonical"> — risks duplicate-content SEO penalties`,
        details: missingCanonical.slice(0, 30),
        suggestion: 'Add <link rel="canonical" href="..."> pointing at the page\'s preferred URL.',
      });
    }

    if (slowPages.length > 0) {
      result.addCheck('crawl:slow-pages', false, {
        severity: 'warning',
        message: `${slowPages.length} page(s) slower than threshold — real users bounce on slow TTFB`,
        details: slowPages.slice(0, 30),
        suggestion: 'Investigate slow endpoints. Common causes: cold-start backends, unindexed DB queries, blocking 3rd-party scripts.',
      });
    }

    if (anchorMissingId.length > 0) {
      result.addCheck('crawl:anchor-missing-target', false, {
        severity: 'warning',
        message: `${anchorMissingId.length} broken anchor link(s) — clicking does nothing for users`,
        details: anchorMissingId.slice(0, 30),
        suggestion: 'Either remove the anchor or add the corresponding id="..." attribute to the target element.',
      });
    }

    // Cross-page: titles that repeat across pages dilute SEO and confuse users
    // in browser tabs. Build a counter, surface duplicates.
    const titleCounts = new Map();
    for (const t of titlesByUrl.values()) {
      titleCounts.set(t, (titleCounts.get(t) || 0) + 1);
    }
    const duplicateTitles = [];
    for (const [title, count] of titleCounts.entries()) {
      if (count > 1) {
        const urls = Array.from(titlesByUrl.entries())
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

    // Sitemap and robots.txt — fetch independently of the crawl loop.
    if (crawlConfig.checkSitemap !== false) {
      try {
        const sitemapUrl = new URL('/sitemap.xml', baseUrl).href;
        const r = await this._checkUrl(sitemapUrl, timeout);
        if (r.status >= 400) {
          result.addCheck('crawl:sitemap-missing', false, {
            severity: 'warning',
            message: `No /sitemap.xml found (HTTP ${r.status}) — Google crawls without guidance`,
            suggestion: 'Generate a sitemap.xml. Most frameworks have a plugin for this.',
          });
        }
      } catch { /* network error, skip silently */ }
    }
    if (crawlConfig.checkRobotsTxt !== false) {
      try {
        const robotsUrl = new URL('/robots.txt', baseUrl).href;
        const r = await this._checkUrl(robotsUrl, timeout);
        if (r.status >= 400) {
          result.addCheck('crawl:robots-missing', false, {
            severity: 'info',
            message: `No /robots.txt found (HTTP ${r.status}) — crawlers default to allow-all`,
            suggestion: 'Add a /robots.txt even if it just says "User-agent: *\\nAllow: /" — signals intentionality.',
          });
        }
      } catch { /* network error, skip silently */ }
    }
    if (crawlConfig.checkFavicon !== false) {
      try {
        const faviconUrl = new URL('/favicon.ico', baseUrl).href;
        const r = await this._checkUrl(faviconUrl, timeout);
        if (r.status >= 400) {
          result.addCheck('crawl:favicon-missing', false, {
            severity: 'info',
            message: `No /favicon.ico found (HTTP ${r.status}) — browser tabs show a generic icon`,
            suggestion: 'Add a favicon.ico in the site root. Modern alternative: <link rel="icon" href="..."> in <head>.',
          });
        }
      } catch { /* network error, skip silently */ }
    }

    if (redirects.length > 0) {
      result.addCheck('crawl:redirects', true, {
        message: `${redirects.length} redirect(s) detected`,
        details: redirects.slice(0, 20),
      });
    }

    if (errors.length === 0 && brokenLinks.length === 0 && brokenImages.length === 0) {
      result.addCheck('crawl:clean', true, {
        message: `Site is clean — ${pages.length} pages, 0 errors, 0 broken links, 0 broken images`,
      });
    }

    // Generate the structured feedback report for Claude
    this._generateFeedbackReport(config, {
      baseUrl,
      pagesScanned: pages.length,
      errors,
      brokenLinks,
      brokenImages,
      redirects,
    });
  }

  _fetchPage(url, timeout) {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const client = parsedUrl.protocol === 'https:' ? https : http;
      const startedAt = Date.now();

      const req = client.get(url, {
        timeout,
        headers: {
          'User-Agent': 'GateTest/1.0 (Quality Assurance Crawler)',
          'Accept': 'text/html,application/xhtml+xml,*/*',
        },
      }, (res) => {
        // Handle redirects
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const redirectUrl = new URL(res.headers.location, url).href;
          this._fetchPage(redirectUrl, timeout).then(redirectResult => {
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

  _checkUrl(url, timeout) {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const client = parsedUrl.protocol === 'https:' ? https : http;
      const method = 'HEAD'; // Just check status, don't download body

      const req = client.request(url, {
        method,
        timeout,
        headers: {
          'User-Agent': 'GateTest/1.0 (Quality Assurance Crawler)',
        },
      }, (res) => {
        resolve({
          url,
          status: res.statusCode,
          statusText: res.statusMessage,
        });
        res.resume(); // Drain response
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Timeout'));
      });
      req.end();
    });
  }

  async _crawlWithBrowser(playwright, baseUrl, maxPages, timeout, checkExternal,
    visited, pages, errors, brokenLinks, brokenImages, redirects, queue, result) {

    const browser = await playwright.chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent: 'GateTest/1.0 (Quality Assurance Browser Crawler)',
    });

    const consoleErrors = [];
    const jsErrors = [];

    try {
      const page = await context.newPage();

      // Capture console errors and JS exceptions globally
      page.on('console', msg => {
        if (msg.type() === 'error') {
          consoleErrors.push({ text: msg.text(), url: page.url() });
        }
      });
      page.on('pageerror', err => {
        jsErrors.push({ message: err.message, url: page.url() });
      });

      while (queue.length > 0 && visited.size < maxPages) {
        const url = queue.shift();
        if (!url || visited.has(url)) continue;
        visited.add(url);

        try {
          const response = await page.goto(url, { timeout, waitUntil: 'networkidle' });

          const status = response?.status() || 0;
          const body = await page.content();
          pages.push({ url, status, body });

          // Check HTTP status
          if (status >= 400) {
            errors.push({ url, status, type: 'http-error', message: `HTTP ${status}` });
          }

          // Check for blank/empty page (AFTER JS execution — catches SPA rendering failures)
          const textContent = await page.evaluate(() => document.body?.innerText?.trim() || '');
          if (textContent.length < 50 && !url.includes('api')) {
            errors.push({ url, type: 'empty-page',
              message: `Page appears blank after JS execution (${textContent.length} chars of visible text)` });
          }

          // Check page title
          const title = await page.title();
          if (!title || title.trim().length === 0) {
            errors.push({ url, type: 'missing-title', message: 'Page has no <title> or title is empty' });
          }

          // Check for error messages in the RENDERED page (not raw HTML)
          const errorPatterns = [
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
          for (const { regex, type } of errorPatterns) {
            if (regex.test(textContent)) {
              errors.push({ url, type, message: `Error pattern "${type}" visible on rendered page` });
            }
          }

          // Check for broken images (naturalWidth === 0 means failed to load)
          const broken = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('img'))
              .filter(img => img.src && (!img.complete || img.naturalWidth === 0))
              .map(img => img.src);
          });
          for (const imgSrc of broken) {
            brokenImages.push({ page: url, image: imgSrc, status: 'failed-to-render' });
          }

          // Extract internal links from the RENDERED DOM (catches JS-generated links)
          const renderedLinks = await page.evaluate((base) => {
            return Array.from(document.querySelectorAll('a[href]'))
              .map(a => a.href)
              .filter(href => href.startsWith(base) && !href.includes('#'));
          }, baseUrl);
          for (const link of renderedLinks) {
            if (!visited.has(link) && !queue.includes(link)) queue.push(link);
          }

          // Check external links if enabled
          if (checkExternal) {
            const extLinks = await page.evaluate((base) => {
              return Array.from(document.querySelectorAll('a[href]'))
                .map(a => a.href)
                .filter(href => href.startsWith('http') && !href.startsWith(base));
            }, baseUrl);
            for (const extLink of extLinks.slice(0, 20)) {
              try {
                const linkResult = await this._checkUrl(extLink, timeout);
                if (linkResult.status >= 400) {
                  brokenLinks.push({ page: url, link: extLink, status: linkResult.status, type: 'external' });
                }
              } catch {
                brokenLinks.push({ page: url, link: extLink, status: 'timeout/error', type: 'external' });
              }
            }
          }

          // Check for mixed content
          if (url.startsWith('https://')) {
            const mixedCount = await page.evaluate(() => {
              return Array.from(document.querySelectorAll('[src^="http:"], [href^="http:"]'))
                .filter(el => !el.getAttribute('href')?.startsWith('http://localhost'))
                .length;
            });
            if (mixedCount > 0) {
              errors.push({ url, type: 'mixed-content',
                message: `${mixedCount} HTTP resource(s) on HTTPS page (mixed content)` });
            }
          }

        } catch (err) {
          errors.push({ url, type: 'fetch-error', message: `Failed to load: ${err.message}` });
        }
      }

      // Report console errors captured across all pages
      if (consoleErrors.length > 0) {
        errors.push({
          url: baseUrl,
          type: 'console-errors',
          message: `${consoleErrors.length} console error(s) detected across site`,
          details: consoleErrors.slice(0, 20),
        });
      }

      // Report uncaught JS exceptions
      if (jsErrors.length > 0) {
        errors.push({
          url: baseUrl,
          type: 'js-exceptions',
          message: `${jsErrors.length} uncaught JavaScript exception(s)`,
          details: jsErrors.slice(0, 20),
        });
      }

    } finally {
      await browser.close();
    }
  }

  async _crawlWithHttp(baseUrl, maxPages, timeout, checkExternal,
    visited, pages, errors, brokenLinks, brokenImages, redirects, queue, result) {

    while (queue.length > 0 && visited.size < maxPages) {
      const url = queue.shift();
      if (!url || visited.has(url)) continue;
      visited.add(url);

      try {
        const pageResult = await this._fetchPage(url, timeout);
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

        // Meta description — Google snippet + social previews depend on this.
        const metaDescMatch = body.match(/<meta\s+[^>]*name\s*=\s*["']description["'][^>]*content\s*=\s*["']([^"']*)["']/i);
        if (!metaDescMatch || metaDescMatch[1].trim().length === 0) {
          missingMetaDescription.push({ url, message: 'No meta description tag' });
        }

        // Canonical URL — prevents duplicate-content SEO penalties.
        const canonicalMatch = body.match(/<link\s+[^>]*rel\s*=\s*["']canonical["'][^>]*href\s*=\s*["']([^"']+)["']/i);
        if (!canonicalMatch) {
          missingCanonical.push({ url, message: 'No <link rel="canonical"> tag' });
        }

        // Slow page heuristic — real users bounce on TTFB > 2.5s.
        if (pageResult.responseMs && pageResult.responseMs > slowThresholdMs) {
          slowPages.push({ url, responseMs: pageResult.responseMs, message: `Page took ${pageResult.responseMs}ms (threshold ${slowThresholdMs}ms)` });
        }

        // Anchor links pointing at IDs that don't exist on the page.
        // Customer clicks "back to top" → nothing happens.
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
            anchorMissingId.push({ page: url, anchor: `#${targetId}`, message: `<a href="#${targetId}"> targets a non-existent id` });
          }
        }

        const errorPatterns = [
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
        for (const { regex, type } of errorPatterns) {
          if (regex.test(body)) {
            errors.push({ url, type, message: `Error pattern detected on page: "${type}"` });
          }
        }

        const links = this._extractLinks(body, baseUrl, url);
        for (const link of links.internal) {
          if (!visited.has(link.href) && !queue.includes(link.href)) queue.push(link.href);
        }

        const images = this._extractImages(body, baseUrl, url);
        for (const imgUrl of images) {
          try {
            const imgResult = await this._checkUrl(imgUrl, timeout);
            if (imgResult.status >= 400) {
              brokenImages.push({ page: url, image: imgUrl, status: imgResult.status });
            }
          } catch {
            brokenImages.push({ page: url, image: imgUrl, status: 'timeout/error' });
          }
        }

        // Broken external scripts — empty 404s here break entire features
        // (search, auth, analytics) silently for real users.
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
            const r = await this._checkUrl(scriptUrl, timeout);
            if (r.status >= 400) brokenScripts.push({ page: url, script: scriptUrl, status: r.status });
          } catch {
            brokenScripts.push({ page: url, script: scriptUrl, status: 'timeout/error' });
          }
        }

        // Broken stylesheets — visible to users as unstyled HTML.
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
            const r = await this._checkUrl(styleUrl, timeout);
            if (r.status >= 400) brokenStylesheets.push({ page: url, stylesheet: styleUrl, status: r.status });
          } catch {
            brokenStylesheets.push({ page: url, stylesheet: styleUrl, status: 'timeout/error' });
          }
        }

        if (checkExternal) {
          for (const link of links.external.slice(0, 20)) {
            try {
              const linkResult = await this._checkUrl(link.href, timeout);
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

  _extractLinks(html, baseUrl, pageUrl) {
    const internal = [];
    const external = [];
    const hrefRegex = /href\s*=\s*["']([^"'#]+)/gi;
    let match;

    while ((match = hrefRegex.exec(html)) !== null) {
      let href = match[1].trim();
      if (href.startsWith('mailto:') || href.startsWith('tel:') ||
          href.startsWith('javascript:') || href.startsWith('data:')) continue;

      try {
        const resolved = new URL(href, pageUrl).href;
        if (resolved.startsWith(baseUrl)) {
          internal.push({ href: resolved, source: pageUrl });
        } else if (href.startsWith('http')) {
          external.push({ href: resolved, source: pageUrl });
        }
      } catch {
        // Invalid URL, skip
      }
    }

    return { internal, external };
  }

  _extractImages(html, baseUrl, pageUrl) {
    const images = [];
    const srcRegex = /<img[^>]+src\s*=\s*["']([^"']+)/gi;
    let match;

    while ((match = srcRegex.exec(html)) !== null) {
      try {
        const resolved = new URL(match[1].trim(), pageUrl).href;
        images.push(resolved);
      } catch {
        // Invalid URL
      }
    }

    return images;
  }

  _getSuggestion(errorType) {
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

  _generateFeedbackReport(config, data) {
    const fs = require('fs');
    const path = require('path');

    const reportDir = path.resolve(config.projectRoot, '.gatetest/reports');
    if (!fs.existsSync(reportDir)) {
      fs.mkdirSync(reportDir, { recursive: true });
    }

    // Generate a Claude-readable feedback report
    const lines = [];
    lines.push('# GateTest Live Crawl Report');
    lines.push(`# URL: ${data.baseUrl}`);
    lines.push(`# Pages scanned: ${data.pagesScanned}`);
    lines.push(`# Generated: ${new Date().toISOString()}`);
    lines.push('');

    if (data.errors.length === 0 && data.brokenLinks.length === 0 && data.brokenImages.length === 0) {
      lines.push('## RESULT: ALL CLEAR');
      lines.push('No errors, broken links, or broken images found.');
    } else {
      lines.push('## RESULT: ISSUES FOUND — FIX REQUIRED');
      lines.push('');

      if (data.errors.length > 0) {
        lines.push(`### Page Errors (${data.errors.length})`);
        for (const err of data.errors) {
          lines.push(`- **${err.type}** at ${err.url}`);
          lines.push(`  ${err.message}`);
        }
        lines.push('');
      }

      if (data.brokenLinks.length > 0) {
        lines.push(`### Broken Links (${data.brokenLinks.length})`);
        for (const link of data.brokenLinks) {
          lines.push(`- [${link.status}] ${link.link} (found on ${link.page})`);
        }
        lines.push('');
      }

      if (data.brokenImages.length > 0) {
        lines.push(`### Broken Images (${data.brokenImages.length})`);
        for (const img of data.brokenImages) {
          lines.push(`- [${img.status}] ${img.image} (found on ${img.page})`);
        }
        lines.push('');
      }

      lines.push('## ACTION REQUIRED');
      lines.push('Fix all issues listed above and run `gatetest --module liveCrawler` again.');
      lines.push('Do not deploy until this report shows ALL CLEAR.');
    }

    const report = lines.join('\n');
    const reportPath = path.join(reportDir, 'crawl-feedback.md');
    fs.writeFileSync(reportPath, report);

    // Also save as JSON for programmatic use
    const jsonPath = path.join(reportDir, 'crawl-feedback.json');
    fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2));
  }
}

module.exports = LiveCrawlerModule;
