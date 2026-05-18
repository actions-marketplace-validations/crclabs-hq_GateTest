'use strict';

// ============================================================================
// NUCLEAR-TIER CISO REPORT WIRING TEST
// ============================================================================
// Verifies the contract between /api/scan/fix and the CISO report:
//
//  1. Nuclear-tier invocation produces a PR body that includes the
//     CISO-report-attached notice with the file path the customer can
//     open.
//  2. Quick / Full / Scan+Fix tier invocations DO NOT include the CISO
//     report notice (it's a $399 deliverable).
//  3. Report-generation failure does NOT erase the rest of the PR body
//     (fail-soft — the customer keeps the fixes they paid for).
//  4. The report path the route would commit to is deterministic +
//     date-stamped so re-runs don't collide.
//  5. The compliance-gap summary the composer surfaces matches the
//     numbers from generateCisoReport.
//
// These tests exercise the same composer + generator code paths the
// route uses without spawning the Next.js runtime. Route-level
// integration is covered by the dev-server / deployed-endpoint proof
// docs; this file locks the contract between the three pieces.
// ============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  composePrBody,
  renderCisoReportSection,
} = require('../website/app/lib/pr-composer');

const {
  generateCisoReport,
  cisoReportPath,
} = require('../website/app/lib/ciso-report-generator');

// ─── Fixtures ────────────────────────────────────────────────────────────────

const FIXES = [
  {
    file: 'src/auth.ts',
    original: 'const sec = "hardcoded";',
    fixed: 'const sec = process.env.SECRET;',
    issues: ['Hardcoded secret in auth module'],
  },
];

const FINDINGS = [
  { module: 'secrets', severity: 'error', detail: 'Hardcoded secret' },
  { module: 'tlsSecurity', severity: 'error', detail: 'rejectUnauthorized: false' },
  { module: 'logPii', severity: 'warning', detail: 'console.log(req.body)' },
];

async function buildCisoDescriptor() {
  const result = await generateCisoReport({
    findings: FINDINGS,
    hostName: 'org/repo',
    tier: 'Nuclear',
    // askClaude omitted — narrative skipped, rest of report still ships.
  });
  return {
    descriptor: {
      path: cisoReportPath(),
      riskLevel: result.riskLevel,
      complianceGaps: result.complianceGaps,
      counts: result.counts,
    },
    result,
  };
}

// ─── 1. Nuclear-tier PR body INCLUDES the attached-report notice ─────────────

describe('scan-fix Nuclear wiring — PR body includes CISO attachment notice', () => {
  it('Nuclear-tier composePrBody mentions the CISO report file path', async () => {
    const { descriptor } = await buildCisoDescriptor();
    const body = composePrBody({
      fixes: FIXES,
      errors: [],
      cisoReport: descriptor,
    });
    assert.match(body, /Board-ready CISO report/);
    assert.ok(body.includes(descriptor.path), 'PR body should include the report file path');
  });

  it('mentions OWASP, SOC2, CIS, and the 30/60/90 roadmap framing', async () => {
    const { descriptor } = await buildCisoDescriptor();
    const body = composePrBody({
      fixes: FIXES,
      cisoReport: descriptor,
    });
    assert.match(body, /OWASP Top 10/);
    assert.match(body, /SOC2 Trust Service Criteria/);
    assert.match(body, /CIS Controls v8/);
    assert.match(body, /30\/60\/90-day remediation roadmap/);
  });

  it('surfaces the risk level + finding-count breakdown', async () => {
    const { descriptor, result } = await buildCisoDescriptor();
    const body = composePrBody({
      fixes: FIXES,
      cisoReport: descriptor,
    });
    assert.ok(body.includes(result.riskLevel), 'should include risk level');
    assert.match(body, /\d+ critical \/ \d+ high \/ \d+ medium \/ \d+ low/);
  });

  it('compliance-gap counts in the PR body match generateCisoReport output', async () => {
    const { descriptor, result } = await buildCisoDescriptor();
    const body = composePrBody({
      fixes: FIXES,
      cisoReport: descriptor,
    });
    const owaspMatch = body.match(/OWASP Top 10 2021 \((\d+) categories implicated\)/);
    const soc2Match = body.match(/SOC2 Trust Service Criteria \((\d+) criteria implicated\)/);
    const cisMatch = body.match(/CIS Controls v8 \((\d+) controls implicated\)/);
    assert.ok(owaspMatch);
    assert.ok(soc2Match);
    assert.ok(cisMatch);
    assert.equal(Number(owaspMatch[1]), result.complianceGaps.owasp.length);
    assert.equal(Number(soc2Match[1]), result.complianceGaps.soc2.length);
    assert.equal(Number(cisMatch[1]), result.complianceGaps.cis.length);
  });
});

// ─── 2. Lower tiers DO NOT include the CISO attachment notice ────────────────

describe('scan-fix Nuclear wiring — lower tiers excluded', () => {
  it('Quick-tier (no cisoReport passed) composePrBody DOES NOT mention CISO report', () => {
    const body = composePrBody({
      fixes: FIXES,
      errors: [],
      // cisoReport intentionally omitted — Quick tier
    });
    assert.ok(!body.includes('Board-ready CISO report'));
    assert.ok(!body.includes('gatetest-reports/'));
  });

  it('Full-tier composePrBody DOES NOT mention CISO report', () => {
    const body = composePrBody({
      fixes: FIXES,
      // Full tier — route does not pass cisoReport
    });
    assert.ok(!body.includes('Board-ready CISO report'));
  });

  it('Scan+Fix-tier composePrBody DOES NOT mention CISO report', () => {
    const body = composePrBody({
      fixes: FIXES,
      // Scan+Fix tier — route does not pass cisoReport
    });
    assert.ok(!body.includes('Board-ready CISO report'));
  });
});

// ─── 3. Report-generation failure must NOT block the PR ──────────────────────

describe('scan-fix Nuclear wiring — fail-soft on report errors', () => {
  it('cisoReport.failed=true renders a graceful advisory in the PR body', () => {
    const body = composePrBody({
      fixes: FIXES,
      errors: ['CISO report generation failed (report not attached to PR): transient API error'],
      cisoReport: { failed: true },
    });
    // The advisory section should appear instead of the normal attachment.
    assert.match(body, /Board-ready CISO report/);
    assert.match(body, /transient error/i);
    assert.ok(!body.includes('gatetest-reports/'), 'no fake path when generation failed');
  });

  it('cisoReport.failed=true does NOT erase the fixed-files section', () => {
    const body = composePrBody({
      fixes: FIXES,
      cisoReport: { failed: true },
    });
    // Fixes still ship — the customer keeps what they paid for.
    assert.ok(body.includes('src/auth.ts'));
    assert.match(body, /Fixed files/);
  });

  it('cisoReport.failed=true does NOT erase the auto-fix header', () => {
    const body = composePrBody({
      fixes: FIXES,
      cisoReport: { failed: true },
    });
    assert.match(body, /GateTest Auto-Fix Report/);
  });

  it('renderCisoReportSection with failed=true returns a defined advisory string', () => {
    const out = renderCisoReportSection({ failed: true });
    assert.ok(typeof out === 'string');
    assert.ok(out.length > 0);
    assert.match(out, /Board-ready CISO report/);
  });

  it('renderCisoReportSection with no path returns empty string (defensive)', () => {
    const out = renderCisoReportSection({ riskLevel: 'HIGH' });
    assert.equal(out, '');
  });

  it('renderCisoReportSection with no args returns empty string', () => {
    assert.equal(renderCisoReportSection(), '');
  });
});

// ─── 4. Path determinism ─────────────────────────────────────────────────────

describe('scan-fix Nuclear wiring — report path', () => {
  it('cisoReportPath returns a stable, date-stamped path under gatetest-reports/', () => {
    const p = cisoReportPath('2026-05-18');
    assert.equal(p, 'gatetest-reports/ciso-board-report-2026-05-18.md');
  });

  it('cisoReportPath with no arg returns todays date', () => {
    const today = new Date().toISOString().slice(0, 10);
    assert.equal(cisoReportPath(), `gatetest-reports/ciso-board-report-${today}.md`);
  });
});

// ─── 5. End-to-end through composer ──────────────────────────────────────────

describe('scan-fix Nuclear wiring — end-to-end', () => {
  it('full Nuclear-shape composePrBody renders all expected sections', async () => {
    const { descriptor } = await buildCisoDescriptor();
    const body = composePrBody({
      fixes: FIXES,
      errors: [],
      attemptHistoryByFile: {
        'src/auth.ts': {
          success: true,
          attempts: [{ attemptNumber: 1, durationMs: 1234, outcome: 'success' }],
          summary: '1 attempt, success',
        },
      },
      syntaxGate: { summary: '1 accepted, 0 rejected' },
      scannerGate: { skipped: true, reason: 'baseline not supplied' },
      testGen: { summary: '1 test generated' },
      cisoReport: descriptor,
    });
    // Headline auto-fix sections
    assert.match(body, /GateTest Auto-Fix Report/);
    assert.match(body, /1 issue fixed/);
    assert.match(body, /Per-file fix history/);
    assert.match(body, /Gate results/);
    // CISO addendum
    assert.match(body, /Board-ready CISO report/);
    assert.ok(body.includes(descriptor.path));
    // How-it-works + Next-steps still appear
    assert.match(body, /How GateTest works/);
    assert.match(body, /Next steps/);
  });
});
