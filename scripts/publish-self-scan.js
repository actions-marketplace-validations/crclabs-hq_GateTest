#!/usr/bin/env node
/**
 * publish-self-scan.js — best-effort publish of the latest self-scan
 * report to gatetest.ai for the live trust badge.
 *
 * Called from `.github/workflows/ci.yml` AFTER the self-scan step.
 * Reads `.gatetest/reports/gatetest-report-latest.json`, derives the
 * badge payload, HMAC-signs the body with `GATETEST_INTERNAL_TOKEN`,
 * and POSTs to `${SELF_SCAN_STATUS_URL || "https://gatetest.ai"}/api/internal/self-scan-status`.
 *
 * FAIL-SOFT: this script ALWAYS exits 0. The CI workflow must not be
 * broken by a stats publish that didn't reach the website (e.g.
 * gatetest.ai is down, the token isn't configured on a fork PR).
 * Use the human-readable stderr output to diagnose.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function envOr(name, fallback) {
  const v = process.env[name];
  return v && v.trim() ? v : fallback;
}

function readSelfScanReport() {
  const reportPath = path.resolve(
    process.cwd(),
    '.gatetest/reports/gatetest-report-latest.json',
  );
  if (!fs.existsSync(reportPath)) {
    return { ok: false, error: `no report at ${reportPath}` };
  }
  try {
    const raw = fs.readFileSync(reportPath, 'utf-8');
    return { ok: true, report: JSON.parse(raw) };
  } catch (err) {
    return { ok: false, error: `failed to parse report: ${err.message}` };
  }
}

function deriveBadgePayload(report) {
  const gt = report.gatetest || {};
  const summary = report.summary || {};
  const modules = summary.modules || {};
  const checks = summary.checks || {};
  const commitSha = (envOr('GITHUB_SHA', '') || '').toLowerCase();

  if (!commitSha) {
    return { ok: false, error: 'GITHUB_SHA not set in env' };
  }

  return {
    ok: true,
    payload: {
      gateStatus: gt.gateStatus === 'PASSED' ? 'PASSED' : 'BLOCKED',
      errorCount: Number(checks.errors || 0),
      warningCount: Number(checks.warnings || 0),
      modulesPassedCount: Number(modules.passed || 0),
      modulesTotalCount: Number(modules.total || 0),
      scannedAt: gt.timestamp || new Date().toISOString(),
      commitSha,
    },
  };
}

async function postPayload(url, body, signature) {
  // Node 22 ships global fetch — no extra dep.
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-signature': signature,
    },
    body,
  });
  return { status: res.status, text: await res.text().catch(() => '') };
}

async function main() {
  const baseUrl = envOr('SELF_SCAN_STATUS_URL', 'https://gatetest.ai');
  const endpoint = `${baseUrl}/api/internal/self-scan-status`;
  const secret = envOr('GATETEST_INTERNAL_TOKEN', '');

  if (!secret) {
    // Truncate so we never log a real token even if someone sets it wrong.
    process.stderr.write(
      '[publish-self-scan] GATETEST_INTERNAL_TOKEN not set — skipping publish (fail-soft)\n',
    );
    return;
  }

  const reportRead = readSelfScanReport();
  if (!reportRead.ok) {
    process.stderr.write(`[publish-self-scan] ${reportRead.error}\n`);
    return;
  }

  const derived = deriveBadgePayload(reportRead.report);
  if (!derived.ok) {
    process.stderr.write(`[publish-self-scan] ${derived.error}\n`);
    return;
  }

  const rawBody = JSON.stringify(derived.payload);
  const signature =
    'sha256=' +
    crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

  try {
    const result = await postPayload(endpoint, rawBody, signature);
    if (result.status >= 200 && result.status < 300) {
      process.stderr.write(
        `[publish-self-scan] OK (${result.status}) — published self-scan to ${endpoint}\n`,
      );
    } else {
      process.stderr.write(
        `[publish-self-scan] FAIL (${result.status}) — ${result.text.slice(0, 200)}\n`,
      );
    }
  } catch (err) {
    process.stderr.write(
      `[publish-self-scan] network error: ${err.message}\n`,
    );
  }
}

main().catch((err) => {
  // Never crash the workflow. Just write and exit 0.
  process.stderr.write(`[publish-self-scan] crashed: ${err.message}\n`);
  process.exit(0);
});
