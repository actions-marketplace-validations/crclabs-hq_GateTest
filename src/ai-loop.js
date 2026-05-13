#!/usr/bin/env node

/**
 * GateTest AI Loop - The bridge between GateTest and Claude.
 *
 * THIS IS THE KEY FILE. This is how GateTest talks to Claude.
 *
 * How it works:
 * 1. GateTest crawls the live site (every page, every button, every link)
 * 2. GateTest writes a report to .gatetest/reports/fix-these.md
 * 3. Claude Code reads that report and knows exactly what to fix
 * 4. Claude fixes the issues
 * 5. GateTest runs again
 * 6. Repeat until the site is clean
 *
 * Usage from within a Claude Code session:
 *   node src/ai-loop.js https://your-site.com
 *
 * Or add to any project's CLAUDE.md:
 *   "After making changes, run: node path/to/gatetest/src/ai-loop.js https://your-site.com"
 *   "Read .gatetest/reports/fix-these.md and fix every issue listed."
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');

const MAX_PAGES = 200;
const TIMEOUT = 15000;

async function main() {
  const url = process.argv[2];

  if (!url) {
    console.error('\nUsage: node src/ai-loop.js <url>\n');
    console.error('Example: node src/ai-loop.js https://zoobicon.com\n');
    process.exit(1);
  }

  console.log('');
  console.log('='.repeat(60));
  console.log('  GATETEST AI LOOP');
  console.log('  Scanning: ' + url);
  console.log('='.repeat(60));
  console.log('');

  const results = {
    url,
    timestamp: new Date().toISOString(),
    pagesScanned: 0,
    errors: [],
    brokenLinks: [],
    brokenImages: [],
    missingTitles: [],
    emptyPages: [],
    consoleErrors: [],
    mixedContent: [],
    slowPages: [],
    redirectChains: [],
  };

  const visited = new Set();
  const queue = [url];

  while (queue.length > 0 && visited.size < MAX_PAGES) {
    const pageUrl = queue.shift();
    if (!pageUrl || visited.has(pageUrl)) continue;
    visited.add(pageUrl);

    process.stdout.write(`  [${visited.size}] Scanning ${pageUrl.replace(url, '')}... `);

    try {
      const start = Date.now();
      const page = await fetchPage(pageUrl);
      const loadTime = Date.now() - start;

      // Track slow pages
      if (loadTime > 3000) {
        results.slowPages.push({ url: pageUrl, time: `${(loadTime / 1000).toFixed(1)}s` });
      }

      // HTTP errors
      if (page.status >= 400) {
        results.errors.push({
          url: pageUrl,
          error: `HTTP ${page.status}`,
          fix: `Page returns ${page.status}. Check routing, server config, and that the page exists.`,
        });
        console.log(`ERROR ${page.status}`);
        continue;
      }

      // Handle redirects
      if (page.redirected) {
        results.redirectChains.push({ from: pageUrl, to: page.finalUrl });
      }

      if (!page.body || !page.contentType?.includes('text/html')) {
        console.log('skip (not HTML)');
        continue;
      }

      const body = page.body;
      let pageIssues = 0;

      // Check for missing/empty title
      const titleMatch = body.match(/<title>([^<]*)<\/title>/i);
      if (!titleMatch || titleMatch[1].trim().length === 0) {
        results.missingTitles.push({ url: pageUrl });
        pageIssues++;
      }

      // Check for empty/blank pages
      const textContent = body.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
      if (textContent.length < 50) {
        results.emptyPages.push({
          url: pageUrl,
          fix: 'Page appears blank or nearly empty. Check that components are rendering and data is loading.',
        });
        pageIssues++;
      }

      // Check for error messages visible on the page
      const errorPatterns = [
        { regex: /application error/i, name: 'Application Error' },
        { regex: /internal server error/i, name: 'Server Error' },
        { regex: /page not found/i, name: '404 Page' },
        { regex: /something went wrong/i, name: 'Error Message' },
        { regex: /uncaught (type)?error/i, name: 'JavaScript Error' },
        { regex: /cannot read propert/i, name: 'JS TypeError' },
        { regex: /module not found/i, name: 'Module Not Found' },
        { regex: /hydration failed/i, name: 'Hydration Error' },
        { regex: /unhandled runtime error/i, name: 'Runtime Error' },
        { regex: /loading chunk \d+ failed/i, name: 'Chunk Load Error' },
        { regex: /unexpected token/i, name: 'Syntax Error on Page' },
        { regex: /is not defined/i, name: 'Reference Error' },
        { regex: /failed to fetch/i, name: 'Fetch Error' },
        { regex: /network error/i, name: 'Network Error' },
        { regex: /CORS/i, name: 'CORS Error' },
      ];

      for (const { regex, name } of errorPatterns) {
        if (regex.test(textContent)) {
          results.errors.push({
            url: pageUrl,
            error: name,
            fix: `"${name}" is visible on this page. Users can see this error. Find and fix the root cause.`,
          });
          pageIssues++;
        }
      }

      // Check for broken images in HTML
      const imgSrcs = [];
      const imgRegex = /<img[^>]+src=["']([^"']+)["']/gi;
      let imgMatch;
      while ((imgMatch = imgRegex.exec(body)) !== null) {
        try {
          const imgUrl = new URL(imgMatch[1], pageUrl).href;
          imgSrcs.push(imgUrl);
        } catch { /* invalid URL */ }
      }

      // Check a sample of images (limit to avoid being too slow)
      for (const imgUrl of imgSrcs.slice(0, 10)) {
        try {
          const imgStatus = await checkUrl(imgUrl);
          if (imgStatus >= 400) {
            results.brokenImages.push({
              page: pageUrl,
              image: imgUrl,
              status: imgStatus,
              fix: `Image returns ${imgStatus}. Fix the image path or replace the image.`,
            });
            pageIssues++;
          }
        } catch {
          results.brokenImages.push({
            page: pageUrl,
            image: imgUrl,
            status: 'timeout',
            fix: 'Image failed to load. Check the URL is correct and the server is responding.',
          });
          pageIssues++;
        }
      }

      // Check for mixed content (HTTP on HTTPS)
      if (pageUrl.startsWith('https://')) {
        const httpMatches = body.match(/(?:src|href|action)\s*=\s*["']http:\/\/(?!localhost)/gi);
        if (httpMatches && httpMatches.length > 0) {
          results.mixedContent.push({
            url: pageUrl,
            count: httpMatches.length,
            fix: `${httpMatches.length} HTTP resources on HTTPS page. Change all URLs to HTTPS.`,
          });
          pageIssues++;
        }
      }

      // Extract internal links and add to crawl queue
      const linkRegex = /href=["']([^"'#]+)["']/gi;
      let linkMatch;
      while ((linkMatch = linkRegex.exec(body)) !== null) {
        try {
          const href = linkMatch[1].trim();
          if (href.startsWith('mailto:') || href.startsWith('tel:') ||
              href.startsWith('javascript:') || href.startsWith('data:')) continue;

          const resolved = new URL(href, pageUrl).href;

          if (resolved.startsWith(url) && !visited.has(resolved) && !queue.includes(resolved)) {
            queue.push(resolved);
          }
        } catch { /* invalid URL */ }
      }

      // Check a sample of links for broken external links
      const externalLinks = [];
      const allLinks = body.matchAll(/href=["'](https?:\/\/[^"']+)["']/gi);
      for (const match of allLinks) {
        const href = match[1];
        if (!href.startsWith(url)) {
          externalLinks.push(href);
        }
      }

      // Check first 5 external links per page
      for (const extLink of externalLinks.slice(0, 5)) {
        try {
          const status = await checkUrl(extLink);
          if (status >= 400) {
            results.brokenLinks.push({
              page: pageUrl,
              link: extLink,
              status,
              fix: `External link returns ${status}. Remove or update this link.`,
            });
            pageIssues++;
          }
        } catch {
          // Timeout on external link, not critical
        }
      }

      results.pagesScanned++;
      console.log(pageIssues === 0 ? 'OK' : `${pageIssues} issue(s)`);

    } catch (err) {
      results.errors.push({
        url: pageUrl,
        error: `Failed to load: ${err.message}`,
        fix: 'Page could not be loaded at all. Check the server is running and the URL is correct.',
      });
      console.log(`FAIL: ${err.message}`);
    }
  }

  // Generate the report
  const report = generateReport(results);
  const reportDir = path.resolve('.gatetest/reports');
  if (!fs.existsSync(reportDir)) {
    fs.mkdirSync(reportDir, { recursive: true });
  }

  const reportPath = path.join(reportDir, 'fix-these.md');
  fs.writeFileSync(reportPath, report);

  // Also save JSON
  const jsonPath = path.join(reportDir, 'fix-these.json');
  fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));

  // Print summary
  const totalIssues = results.errors.length + results.brokenLinks.length +
    results.brokenImages.length + results.missingTitles.length +
    results.emptyPages.length + results.mixedContent.length;

  console.log('');
  console.log('='.repeat(60));

  if (totalIssues === 0) {
    console.log('  RESULT: ALL CLEAR');
    console.log(`  ${results.pagesScanned} pages scanned. Zero issues found.`);
  } else {
    console.log(`  RESULT: ${totalIssues} ISSUE(S) FOUND`);
    console.log(`  ${results.pagesScanned} pages scanned.`);
    console.log('');
    if (results.errors.length > 0) console.log(`  Page errors:      ${results.errors.length}`);
    if (results.brokenLinks.length > 0) console.log(`  Broken links:     ${results.brokenLinks.length}`);
    if (results.brokenImages.length > 0) console.log(`  Broken images:    ${results.brokenImages.length}`);
    if (results.missingTitles.length > 0) console.log(`  Missing titles:   ${results.missingTitles.length}`);
    if (results.emptyPages.length > 0) console.log(`  Empty pages:      ${results.emptyPages.length}`);
    if (results.mixedContent.length > 0) console.log(`  Mixed content:    ${results.mixedContent.length}`);
    if (results.slowPages.length > 0) console.log(`  Slow pages:       ${results.slowPages.length}`);
  }

  console.log('');
  console.log(`  Full report: ${reportPath}`);
  console.log('='.repeat(60));
  console.log('');

  process.exit(totalIssues === 0 ? 0 : 1);
}

function generateReport(results) {
  const lines = [];
  lines.push('# GateTest Scan Report');
  lines.push('');
  lines.push(`**URL:** ${results.url}`);
  lines.push(`**Scanned:** ${results.timestamp}`);
  lines.push(`**Pages:** ${results.pagesScanned}`);
  lines.push('');

  const totalIssues = results.errors.length + results.brokenLinks.length +
    results.brokenImages.length + results.missingTitles.length +
    results.emptyPages.length + results.mixedContent.length;

  if (totalIssues === 0) {
    lines.push('## RESULT: ALL CLEAR');
    lines.push('');
    lines.push('No issues found. The site is clean.');
    return lines.join('\n');
  }

  lines.push(`## RESULT: ${totalIssues} ISSUES TO FIX`);
  lines.push('');
  lines.push('**INSTRUCTIONS FOR CLAUDE:** Read each issue below. Fix them one by one.');
  lines.push('After fixing, run this scan again to verify: `node src/ai-loop.js ' + results.url + '`');
  lines.push('Do NOT tell the user "it\'s fixed" until this scan returns ALL CLEAR.');
  lines.push('');

  if (results.errors.length > 0) {
    lines.push('---');
    lines.push(`## Page Errors (${results.errors.length})`);
    lines.push('');
    for (let i = 0; i < results.errors.length; i++) {
      const err = results.errors[i];
      lines.push(`### ${i + 1}. ${err.error}`);
      lines.push(`- **Page:** ${err.url}`);
      lines.push(`- **Fix:** ${err.fix}`);
      lines.push('');
    }
  }

  if (results.emptyPages.length > 0) {
    lines.push('---');
    lines.push(`## Empty / Blank Pages (${results.emptyPages.length})`);
    lines.push('');
    for (const page of results.emptyPages) {
      lines.push(`- **${page.url}**`);
      lines.push(`  ${page.fix}`);
    }
    lines.push('');
  }

  if (results.brokenImages.length > 0) {
    lines.push('---');
    lines.push(`## Broken Images (${results.brokenImages.length})`);
    lines.push('');
    for (const img of results.brokenImages) {
      lines.push(`- **Page:** ${img.page}`);
      lines.push(`  **Image:** ${img.image} (status: ${img.status})`);
      lines.push(`  **Fix:** ${img.fix}`);
    }
    lines.push('');
  }

  if (results.brokenLinks.length > 0) {
    lines.push('---');
    lines.push(`## Broken Links (${results.brokenLinks.length})`);
    lines.push('');
    for (const link of results.brokenLinks) {
      lines.push(`- **Page:** ${link.page}`);
      lines.push(`  **Link:** ${link.link} (status: ${link.status})`);
      lines.push(`  **Fix:** ${link.fix}`);
    }
    lines.push('');
  }

  if (results.missingTitles.length > 0) {
    lines.push('---');
    lines.push(`## Missing Page Titles (${results.missingTitles.length})`);
    lines.push('');
    for (const page of results.missingTitles) {
      lines.push(`- ${page.url} — Add a descriptive <title> tag`);
    }
    lines.push('');
  }

  if (results.mixedContent.length > 0) {
    lines.push('---');
    lines.push(`## Mixed Content - HTTP on HTTPS (${results.mixedContent.length})`);
    lines.push('');
    for (const mc of results.mixedContent) {
      lines.push(`- **${mc.url}** — ${mc.count} HTTP resources. ${mc.fix}`);
    }
    lines.push('');
  }

  if (results.slowPages.length > 0) {
    lines.push('---');
    lines.push(`## Slow Pages (${results.slowPages.length})`);
    lines.push('');
    for (const page of results.slowPages) {
      lines.push(`- ${page.url} — ${page.time} load time. Optimize assets and reduce server response time.`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function fetchPage(url) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const client = parsedUrl.protocol === 'https:' ? https : http;

    const req = client.get(url, {
      timeout: TIMEOUT,
      headers: {
        'User-Agent': 'GateTest/1.0 AI Loop Scanner',
        'Accept': 'text/html,*/*',
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, url).href;
        fetchPage(redirectUrl).then(result => {
          resolve({ ...result, redirected: true, finalUrl: redirectUrl });
        }).catch(reject);
        return;
      }

      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        resolve({
          url,
          status: res.statusCode,
          contentType: res.headers['content-type'] || '',
          body,
          redirected: false,
        });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
  });
}

function checkUrl(url) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const client = parsedUrl.protocol === 'https:' ? https : http;

    const req = client.request(url, {
      method: 'HEAD',
      timeout: 8000,
      headers: { 'User-Agent': 'GateTest/1.0' },
    }, (res) => {
      resolve(res.statusCode);
      res.resume();
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

main().catch(err => {
  console.error(`\n[GateTest] Fatal: ${err.message}\n`);
  process.exit(1);
});
