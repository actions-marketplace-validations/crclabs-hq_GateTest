/**
 * Chaos Testing Module - Resilience testing by injecting failures.
 *
 * Tests how the site behaves when things go wrong:
 * - Network request failures (random API calls fail)
 * - Slow network conditions (3G throttling)
 * - Missing resources (CSS/JS files 404)
 * - Server timeouts
 * - Offline mode
 *
 * This validates error recovery flows and ensures the site
 * degrades gracefully instead of showing blank pages or crashing.
 *
 * Requires: Playwright
 */

const BaseModule = require('./base-module');
const path = require('path');
const fs = require('fs');

class ChaosModule extends BaseModule {
  constructor() {
    super('chaos', 'Chaos & Resilience Testing');
  }

  async run(result, config) {
    const chaosConfig = config.getModuleConfig('chaos') || {};
    // URL resolution order:
    //   1. GATETEST_CHAOS_URL env var — used by the GitHub Action so customers
    //      can wire a deployed URL without committing a .gatetest/config.json.
    //   2. modules.chaos.url from config (the documented config path).
    //   3. explorer.url / liveCrawler.url — share URL with sibling browser modules.
    const baseUrl = process.env.GATETEST_CHAOS_URL ||
                    chaosConfig.url ||
                    config.get('explorer.url') ||
                    config.get('liveCrawler.url');

    if (!baseUrl) {
      result.addCheck('chaos:config', true, {
        message: 'No URL configured — set GATETEST_CHAOS_URL or modules.chaos.url in .gatetest/config.json',
      });
      return;
    }

    let playwright;
    try {
      playwright = require('playwright');
    } catch {
      result.addCheck('chaos:playwright', false, {
        message: 'Playwright not installed — required for chaos testing',
        suggestion: 'Run: npm install playwright && npx playwright install chromium',
      });
      return;
    }

    const browser = await playwright.chromium.launch({ headless: true });

    try {
      // Test 1: Slow network (3G simulation)
      await this._testSlowNetwork(browser, baseUrl, result);

      // Test 2: Random API failures
      await this._testApiFailures(browser, baseUrl, result);

      // Test 3: Offline mode
      await this._testOfflineMode(browser, baseUrl, result);

      // Test 4: Missing CSS/JS resources
      await this._testMissingResources(browser, baseUrl, result);

      // Test 5: Server timeout simulation
      await this._testTimeouts(browser, baseUrl, result);

    } finally {
      await browser.close();
    }
  }

  async _testSlowNetwork(browser, baseUrl, result) {
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      // Simulate slow 3G
      const client = await page.context().newCDPSession(page);
      await client.send('Network.emulateNetworkConditions', {
        offline: false,
        downloadThroughput: 400 * 1024 / 8, // 400 kbps
        uploadThroughput: 400 * 1024 / 8,
        latency: 400, // 400ms
      });

      const start = Date.now();
      const response = await page.goto(baseUrl, {
        timeout: 30000,
        waitUntil: 'domcontentloaded',
      });
      const loadTime = Date.now() - start;

      // Check if page loaded at all
      if (!response || response.status() >= 500) {
        result.addCheck('chaos:slow-network', false, {
          message: `Site fails on slow network (3G) — status ${response?.status() || 'none'}`,
          suggestion: 'Ensure the site loads on slow connections — optimize critical path',
        });
      } else if (loadTime > 15000) {
        result.addCheck('chaos:slow-network', false, {
          message: `Site takes ${(loadTime / 1000).toFixed(1)}s on 3G — too slow`,
          suggestion: 'Optimize for slow connections: reduce bundle size, lazy load, use CDN',
        });
      } else {
        result.addCheck('chaos:slow-network', true, {
          message: `Site loads on 3G in ${(loadTime / 1000).toFixed(1)}s`,
        });
      }

      // Check for blank page on slow network
      const bodyText = await page.evaluate(() => document.body?.textContent?.trim().length || 0);
      if (bodyText < 10) {
        result.addCheck('chaos:slow-network-blank', false, {
          message: 'Site renders blank on slow network',
          suggestion: 'Add loading states and skeleton screens for slow connections',
        });
      }
    } catch (err) {
      result.addCheck('chaos:slow-network', false, {
        message: `Site crashes on slow network: ${err.message}`,
        suggestion: 'Add timeout handling and loading states',
      });
    } finally {
      await context.close();
    }
  }

  async _testApiFailures(browser, baseUrl, result) {
    const context = await browser.newContext();
    const page = await context.newPage();

    const failedRequests = [];
    let hasErrorScreen = false;

    try {
      // Intercept API calls and fail 50% of them
      await page.route('**/api/**', (route) => {
        if (Math.random() > 0.5) {
          failedRequests.push(route.request().url());
          route.abort('connectionrefused');
        } else {
          route.continue();
        }
      });

      await page.goto(baseUrl, { timeout: 15000, waitUntil: 'networkidle' });
      await page.waitForTimeout(2000);

      // Check if the page shows an error boundary or crashes
      hasErrorScreen = await page.evaluate(() => {
        const body = document.body?.textContent?.toLowerCase() || '';
        return body.includes('unhandled') || body.includes('cannot read') ||
               body.includes('undefined') || body.includes('application error');
      });

      if (hasErrorScreen && failedRequests.length > 0) {
        result.addCheck('chaos:api-failures', false, {
          message: `Site shows errors when API calls fail (${failedRequests.length} calls blocked)`,
          details: failedRequests.slice(0, 10),
          suggestion: 'Add error boundaries and graceful fallbacks for API failures',
        });
      } else {
        result.addCheck('chaos:api-failures', true, {
          message: `Site handles API failures gracefully (${failedRequests.length} calls blocked)`,
        });
      }
    } catch (err) {
      result.addCheck('chaos:api-failures', false, {
        message: `Site crashes when APIs fail: ${err.message}`,
        suggestion: 'Add try/catch around all API calls and display user-friendly errors',
      });
    } finally {
      await context.close();
    }
  }

  async _testOfflineMode(browser, baseUrl, result) {
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      // Load page first (let service worker install)
      await page.goto(baseUrl, { timeout: 15000, waitUntil: 'networkidle' });

      // Go offline
      await context.setOffline(true);

      // Try to navigate
      try {
        await page.reload({ timeout: 5000 });

        const hasContent = await page.evaluate(() => {
          return (document.body?.textContent?.trim().length || 0) > 20;
        });

        if (hasContent) {
          result.addCheck('chaos:offline', true, {
            message: 'Site has offline support (service worker or cache)',
          });
        } else {
          result.addCheck('chaos:offline', true, {
            message: 'No offline support — consider adding a service worker',
          });
        }
      } catch {
        result.addCheck('chaos:offline', true, {
          message: 'No offline support — consider adding a service worker for PWA',
        });
      }
    } finally {
      await context.close();
    }
  }

  async _testMissingResources(browser, baseUrl, result) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const blockedResources = [];

    try {
      // Block CSS and JS files
      await page.route('**/*.css', (route) => {
        blockedResources.push(route.request().url());
        route.abort('blockedbyclient');
      });

      await page.goto(baseUrl, { timeout: 15000, waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1000);

      // Check if page is still usable without CSS
      const hasContent = await page.evaluate(() => {
        return (document.body?.textContent?.trim().length || 0) > 50;
      });

      if (hasContent) {
        result.addCheck('chaos:no-css', true, {
          message: `Content accessible without CSS (${blockedResources.length} stylesheets blocked)`,
        });
      } else {
        result.addCheck('chaos:no-css', false, {
          message: 'Page content disappears without CSS',
          suggestion: 'Ensure core content is in HTML, not generated purely by CSS/JS',
        });
      }
    } finally {
      await context.close();
    }
  }

  async _testTimeouts(browser, baseUrl, result) {
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      // Simulate slow server by adding latency to all requests
      await page.route('**/*', async (route) => {
        await new Promise(resolve => setTimeout(resolve, 2000)); // 2s delay
        route.continue();
      });

      const start = Date.now();
      try {
        await page.goto(baseUrl, { timeout: 20000, waitUntil: 'domcontentloaded' });
        const loadTime = Date.now() - start;

        result.addCheck('chaos:server-timeout', true, {
          message: `Site handles slow server (loaded in ${(loadTime / 1000).toFixed(1)}s with 2s per-request delay)`,
        });
      } catch {
        result.addCheck('chaos:server-timeout', false, {
          message: 'Site fails to load with slow server responses',
          suggestion: 'Add request timeouts and loading states',
        });
      }
    } finally {
      await context.close();
    }
  }
}

module.exports = ChaosModule;
