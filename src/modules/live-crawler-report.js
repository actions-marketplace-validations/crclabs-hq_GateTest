'use strict';

const fs = require('fs');
const path = require('path');

function generateFeedbackReport(config, data) {
  const reportDir = path.resolve(config.projectRoot, '.gatetest/reports');
  if (!fs.existsSync(reportDir)) {
    fs.mkdirSync(reportDir, { recursive: true });
  }

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
  fs.writeFileSync(path.join(reportDir, 'crawl-feedback.md'), report);
  fs.writeFileSync(path.join(reportDir, 'crawl-feedback.json'), JSON.stringify(data, null, 2));
}

module.exports = { generateFeedbackReport };
