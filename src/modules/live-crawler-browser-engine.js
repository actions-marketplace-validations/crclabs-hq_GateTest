'use strict';

const { checkUrl } = require('./live-crawler-http-helpers');

const RENDERED_ERROR_PATTERNS = [
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

async function crawlWithBrowser(playwright, ctx) {
  const {
    baseUrl, maxPages, timeout, checkExternal,
    visited, pages, errors, brokenLinks, brokenImages, queue,
  } = ctx;

  const browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'GateTest/1.0 (Quality Assurance Browser Crawler)',
  });

  const consoleErrors = [];
  const jsErrors = [];

  try {
    const page = await context.newPage();

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

        if (status >= 400) {
          errors.push({ url, status, type: 'http-error', message: `HTTP ${status}` });
        }

        const textContent = await page.evaluate(() => document.body?.innerText?.trim() || '');
        if (textContent.length < 50 && !url.includes('api')) {
          errors.push({ url, type: 'empty-page',
            message: `Page appears blank after JS execution (${textContent.length} chars of visible text)` });
        }

        const title = await page.title();
        if (!title || title.trim().length === 0) {
          errors.push({ url, type: 'missing-title', message: 'Page has no <title> or title is empty' });
        }

        for (const { regex, type } of RENDERED_ERROR_PATTERNS) {
          if (regex.test(textContent)) {
            errors.push({ url, type, message: `Error pattern "${type}" visible on rendered page` });
          }
        }

        const broken = await page.evaluate(() => {
          return Array.from(document.querySelectorAll('img'))
            .filter(img => img.src && (!img.complete || img.naturalWidth === 0))
            .map(img => img.src);
        });
        for (const imgSrc of broken) {
          brokenImages.push({ page: url, image: imgSrc, status: 'failed-to-render' });
        }

        const renderedLinks = await page.evaluate((base) => {
          return Array.from(document.querySelectorAll('a[href]'))
            .map(a => a.href)
            .filter(href => href.startsWith(base) && !href.includes('#'));
        }, baseUrl);
        for (const link of renderedLinks) {
          if (!visited.has(link) && !queue.includes(link)) queue.push(link);
        }

        if (checkExternal) {
          const extLinks = await page.evaluate((base) => {
            return Array.from(document.querySelectorAll('a[href]'))
              .map(a => a.href)
              .filter(href => href.startsWith('http') && !href.startsWith(base));
          }, baseUrl);
          for (const extLink of extLinks.slice(0, 20)) {
            try {
              const linkResult = await checkUrl(extLink, timeout);
              if (linkResult.status >= 400) {
                brokenLinks.push({ page: url, link: extLink, status: linkResult.status, type: 'external' });
              }
            } catch {
              brokenLinks.push({ page: url, link: extLink, status: 'timeout/error', type: 'external' });
            }
          }
        }

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

    if (consoleErrors.length > 0) {
      errors.push({
        url: baseUrl,
        type: 'console-errors',
        message: `${consoleErrors.length} console error(s) detected across site`,
        details: consoleErrors.slice(0, 20),
      });
    }

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

module.exports = { crawlWithBrowser };
