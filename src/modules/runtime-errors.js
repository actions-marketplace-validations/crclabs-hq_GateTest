/**
 * Runtime Errors Module — headless-browser-driven live error capture.
 *
 * Loads the target URL in a real Chromium instance and watches for the
 * failures that only show up at runtime:
 *
 *   - Uncaught JS errors (page errors / unhandled rejections)
 *   - console.error / console.warn spam
 *   - Network request failures (4xx, 5xx, blocked, refused, aborted)
 *   - CSP violations reported by the browser
 *   - Mixed content warnings (HTTPS page loading HTTP assets)
 *   - Document with `Document.write` blocked
 *   - Service worker registration failures
 *   - Frame errors and hydration mismatches (heuristic — looks for React /
 *     Vue / Next.js / Nuxt error markers in console output)
 *
 * Static probes (`web-headers`, `tls-security`) tell us how the server
 * presents itself. This module tells us what actually happens when a real
 * browser loads the page — the "real conflict" findings Craig asked for.
 *
 * Requires: playwright (already in chaos module; gracefully degrades when
 * the binary is missing).
 *
 * On Vercel serverless, Chromium typically can't launch without
 * additional setup — the module returns a skipped check and the rest of
 * the scan pipeline continues. Real runtime checks light up when this
 * runs on a worker / CLI / dedicated infra.
 */

'use strict';

const BaseModule = require('./base-module');

const HYDRATION_HINTS = [
  /hydration mismatch/i,
  /text content does not match/i,
  /hydration failed/i,
  /did not match.*server/i,
  /minified react error/i,
  /uncaught \(in promise\)/i,
  /\[vue warn\]/i,
  /\[nuxt\]/i,
];

const CSP_HINT = /content security policy|csp directive|refused to (?:execute|load|connect|frame)/i;
const MIXED_CONTENT_HINT = /mixed content/i;
const DEPRECATION_HINT = /deprecated/i;

class RuntimeErrorsModule extends BaseModule {
  constructor() {
    super('runtimeErrors', 'Live Browser Runtime Errors');
  }

  async run(result, config) {
    const moduleCfg = config.getModuleConfig('runtimeErrors') || {};
    const baseUrl =
      moduleCfg.url ||
      config.get('targetUrl') ||
      config.get('webUrl') ||
      config.get('wpUrl') ||
      config.get('explorer.url') ||
      config.get('liveCrawler.url');

    if (!baseUrl) {
      result.addCheck('runtime-errors:config', true, {
        severity: 'info',
        message: 'No target URL configured — set targetUrl or modules.runtimeErrors.url',
      });
      return;
    }

    let playwright;
    try {
      playwright = require('playwright');
    } catch {
      // Fallback: Playwright is installed in website/node_modules in
      // this monorepo (workspace-scoped). Customers running the CLI
      // from a project root that has Playwright installed via the
      // website workspace need this fallback or runtime-errors will
      // falsely report playwright-missing while the binary is actually
      // available a directory level deeper.
      const path = require('node:path');
      const candidates = [
        path.join(__dirname, '..', '..', 'website'),
        path.join(process.cwd(), 'website'),
      ];
      for (const fromDir of candidates) {
        try {
          const resolved = require.resolve('playwright', { paths: [fromDir] });
          playwright = require(resolved);
          break;
        } catch { /* try next candidate */ }
      }
      if (!playwright) {
        result.addCheck('runtime-errors:playwright-missing', true, {
          severity: 'info',
          message:
            'Playwright not available in this environment — runtime checks skipped. ' +
            'Install playwright + chromium to enable live error capture.',
          suggestion: 'npm install playwright && npx playwright install chromium',
        });
        return;
      }
    }

    let browser;
    try {
      browser = await playwright.chromium.launch({
        headless: true,
        timeout: 15000,
      });
    } catch (err) {
      result.addCheck('runtime-errors:browser-launch', true, {
        severity: 'info',
        message: `Browser launch failed (${err.message || err}) — environment likely lacks chromium binaries.`,
      });
      return;
    }

    try {
      const captured = await this._captureRuntime(browser, baseUrl, moduleCfg);
      this._reportCaptured(result, captured, baseUrl);
    } finally {
      try { await browser.close(); } catch { /* swallow close errors */ }
    }
  }

  async _captureRuntime(browser, url, cfg) {
    const ctx = await browser.newContext({
      ignoreHTTPSErrors: false,
      viewport: { width: 1280, height: 800 },
      userAgent: 'GateTest/1.0 (+https://gatetest.ai/bot)',
    });
    const page = await ctx.newPage();

    /** @type {{pageErrors:Array, consoleErrors:Array, consoleWarnings:Array, requestFailures:Array, cspViolations:Array, mixedContent:Array, hydration:Array, deprecations:Array, navigationFailure:string|null, finalUrl:string|null, status:number|null}} */
    const captured = {
      pageErrors: [],
      consoleErrors: [],
      consoleWarnings: [],
      requestFailures: [],
      cspViolations: [],
      mixedContent: [],
      hydration: [],
      deprecations: [],
      navigationFailure: null,
      finalUrl: null,
      status: null,
    };

    page.on('pageerror', (err) => {
      captured.pageErrors.push({
        message: err && err.message ? String(err.message) : String(err),
        stack: err && err.stack ? String(err.stack).split('\n').slice(0, 5).join('\n') : null,
      });
    });

    page.on('console', (msg) => {
      const text = msg.text();
      const type = msg.type();
      if (type === 'error') {
        captured.consoleErrors.push({ text: text.slice(0, 500), type });
        if (CSP_HINT.test(text)) captured.cspViolations.push({ text: text.slice(0, 500) });
        if (MIXED_CONTENT_HINT.test(text)) captured.mixedContent.push({ text: text.slice(0, 500) });
        if (HYDRATION_HINTS.some((re) => re.test(text))) captured.hydration.push({ text: text.slice(0, 500) });
      } else if (type === 'warning') {
        captured.consoleWarnings.push({ text: text.slice(0, 500), type });
        if (DEPRECATION_HINT.test(text)) captured.deprecations.push({ text: text.slice(0, 500) });
        if (CSP_HINT.test(text)) captured.cspViolations.push({ text: text.slice(0, 500) });
        if (MIXED_CONTENT_HINT.test(text)) captured.mixedContent.push({ text: text.slice(0, 500) });
      }
    });

    page.on('requestfailed', (req) => {
      const failure = req.failure();
      captured.requestFailures.push({
        url: req.url().slice(0, 300),
        method: req.method(),
        reason: failure ? failure.errorText : 'unknown',
        resourceType: req.resourceType(),
      });
    });

    page.on('response', (resp) => {
      const status = resp.status();
      const url2 = resp.url();
      if (status >= 400 && url2 !== url) {
        captured.requestFailures.push({
          url: url2.slice(0, 300),
          method: resp.request().method(),
          reason: `HTTP ${status}`,
          resourceType: resp.request().resourceType(),
        });
      }
    });

    const timeoutMs = typeof cfg.timeoutMs === 'number' ? cfg.timeoutMs : 25000;

    try {
      const resp = await page.goto(url, { timeout: timeoutMs, waitUntil: 'networkidle' });
      captured.finalUrl = page.url();
      captured.status = resp ? resp.status() : null;
    } catch (err) {
      captured.navigationFailure = err && err.message ? String(err.message) : String(err);
    }

    try { await ctx.close(); } catch { /* swallow */ }
    return captured;
  }

  _reportCaptured(result, captured, baseUrl) {
    if (captured.navigationFailure) {
      result.addCheck('runtime-errors:navigation', false, {
        severity: 'error',
        message: `Page failed to load: ${captured.navigationFailure}`,
        suggestion: 'Verify the URL is reachable from the public internet and returns a 2xx status quickly.',
      });
      return;
    }

    if (captured.status !== null && captured.status >= 400) {
      result.addCheck('runtime-errors:initial-status', false, {
        severity: 'error',
        message: `Initial page load returned HTTP ${captured.status}.`,
      });
    }

    for (const e of captured.pageErrors.slice(0, 10)) {
      result.addCheck('runtime-errors:page-error', false, {
        severity: 'error',
        message: `Uncaught JS error: ${e.message}`,
        details: e.stack || undefined,
      });
    }

    for (const e of captured.consoleErrors.slice(0, 10)) {
      result.addCheck('runtime-errors:console-error', false, {
        severity: 'warning',
        message: `console.error during load: ${e.text}`,
      });
    }

    for (const f of captured.requestFailures.slice(0, 15)) {
      result.addCheck('runtime-errors:network', false, {
        severity: f.resourceType === 'document' || f.resourceType === 'script' ? 'error' : 'warning',
        message: `${f.method} ${f.url} → ${f.reason} (${f.resourceType})`,
      });
    }

    for (const v of captured.cspViolations.slice(0, 5)) {
      result.addCheck('runtime-errors:csp-violation', false, {
        severity: 'error',
        message: `CSP violation: ${v.text}`,
      });
    }

    for (const m of captured.mixedContent.slice(0, 5)) {
      result.addCheck('runtime-errors:mixed-content', false, {
        severity: 'warning',
        message: `Mixed content blocked: ${m.text}`,
      });
    }

    for (const h of captured.hydration.slice(0, 5)) {
      result.addCheck('runtime-errors:hydration', false, {
        severity: 'warning',
        message: `Possible hydration mismatch: ${h.text}`,
        suggestion: 'Hydration mismatches degrade interactivity and produce flicker / blank UI on first paint.',
      });
    }

    for (const d of captured.deprecations.slice(0, 5)) {
      result.addCheck('runtime-errors:deprecation', false, {
        severity: 'info',
        message: `Browser deprecation: ${d.text}`,
      });
    }

    // Summary line — info-level. The scan UI uses this for the "X tests
    // ran" footer; the cluster engine drops it.
    result.addCheck('runtime-errors:summary', true, {
      severity: 'info',
      message:
        `runtime checked ${baseUrl} → ` +
        `${captured.pageErrors.length} page error(s), ` +
        `${captured.consoleErrors.length} console error(s), ` +
        `${captured.requestFailures.length} network failure(s), ` +
        `${captured.cspViolations.length} CSP violation(s), ` +
        `${captured.mixedContent.length} mixed-content event(s), ` +
        `${captured.hydration.length} hydration hint(s).`,
    });
  }
}

module.exports = RuntimeErrorsModule;
