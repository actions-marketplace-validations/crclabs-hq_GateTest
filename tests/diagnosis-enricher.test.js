// ============================================================================
// DIAGNOSIS-ENRICHER TEST — couples Nuclear diagnoser to fix loop.
// ============================================================================
// Verifies the bridge that turns $399 Nuclear from "diagnose, then ship a
// dumb fix in parallel" to "diagnose, then ship a fix that knows what the
// diagnosis said." Pure-function coverage; the diagnoseFindings impl is
// dependency-injected so tests don't need Anthropic.
// ============================================================================

const { describe, it, test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const {
  MAX_FINDINGS_TO_DIAGNOSE,
  issueToFinding,
  classifySeverity,
  runDiagnosesForFixInputs,
  enrichIssuesWithDiagnosis,
  shipDiagnosisAwareFix,
} = require(path.resolve(
  __dirname, '..', 'website', 'app', 'lib', 'diagnosis-enricher.js'
));

// ---------- shape ----------

test('MAX_FINDINGS_TO_DIAGNOSE caps Claude spend per fix-run', () => {
  assert.strictEqual(typeof MAX_FINDINGS_TO_DIAGNOSE, 'number');
  assert.ok(MAX_FINDINGS_TO_DIAGNOSE > 0 && MAX_FINDINGS_TO_DIAGNOSE <= 50);
});

// ---------- issueToFinding ----------

describe('issueToFinding', () => {
  it('maps the IssueInput shape to the diagnoser shape', () => {
    const f = issueToFinding({ file: 'src/foo.ts', issue: 'error: hardcoded API key', module: 'secrets' });
    assert.strictEqual(f.detail, 'error: hardcoded API key');
    assert.strictEqual(f.module, 'secrets');
    assert.strictEqual(f.severity, 'error');
    assert.strictEqual(f.file, 'src/foo.ts');
  });

  it('returns null on garbage input', () => {
    assert.strictEqual(issueToFinding(null), null);
    assert.strictEqual(issueToFinding({}), null);
    assert.strictEqual(issueToFinding({ issue: '' }), null);
    assert.strictEqual(issueToFinding({ issue: 42 }), null);
  });

  it('defaults module to "unknown" when missing', () => {
    const f = issueToFinding({ issue: 'something' });
    assert.strictEqual(f.module, 'unknown');
  });
});

// ---------- classifySeverity ----------

describe('classifySeverity', () => {
  it('respects explicit prefixes', () => {
    assert.strictEqual(classifySeverity('error: x'), 'error');
    assert.strictEqual(classifySeverity('warning: x'), 'warning');
    assert.strictEqual(classifySeverity('info: x'), 'info');
  });

  it('falls back to keyword heuristics', () => {
    assert.strictEqual(classifySeverity('hardcoded API key in src/foo'), 'error');
    assert.strictEqual(classifySeverity('something neutral'), 'warning');
  });

  it('handles non-string input', () => {
    assert.strictEqual(classifySeverity(null), 'warning');
    assert.strictEqual(classifySeverity(undefined), 'warning');
    assert.strictEqual(classifySeverity(42), 'warning');
  });
});

// ---------- runDiagnosesForFixInputs ----------

describe('runDiagnosesForFixInputs', () => {
  it('returns empty diagnoses when issues array is empty', async () => {
    const result = await runDiagnosesForFixInputs({
      issues: [],
      askClaudeForDiagnosis: async () => '',
    });
    assert.strictEqual(result.diagnoses.length, 0);
    assert.match(result.summary, /no issues/i);
  });

  it('skips the diagnoser when ask wrapper is missing', async () => {
    const result = await runDiagnosesForFixInputs({
      issues: [{ file: 'x.ts', issue: 'error: oops', module: 'lint' }],
    });
    assert.strictEqual(result.diagnoses.length, 0);
    assert.match(result.summary, /no Claude wrapper/i);
  });

  it('passes mapped findings into the injected diagnoseFindings', async () => {
    let captured = null;
    const fakeDiagnose = async (opts) => {
      captured = opts;
      return {
        diagnoses: opts.findings.map((f) => ({
          finding: f,
          ok: true,
          diagnosis: {
            explanation: 'fake',
            rootCause: 'rc-' + f.detail,
            recommendation: 'rec-' + f.detail,
            platformNotes: {},
          },
          reason: null,
        })),
        summary: `diagnosed ${opts.findings.length}`,
      };
    };
    const result = await runDiagnosesForFixInputs({
      issues: [
        { file: 'src/a.ts', issue: 'error: bad thing', module: 'security' },
        { file: 'src/b.ts', issue: 'warning: lint stuff', module: 'lint' },
      ],
      askClaudeForDiagnosis: async () => 'unused',
      hostname: 'example.com',
      diagnoseFindings: fakeDiagnose,
    });
    assert.strictEqual(captured.findings.length, 2);
    assert.strictEqual(captured.findings[0].detail, 'error: bad thing');
    assert.strictEqual(captured.findings[0].file, 'src/a.ts');
    assert.strictEqual(captured.hostname, 'example.com');
    assert.strictEqual(captured.maxFindings, MAX_FINDINGS_TO_DIAGNOSE);
    assert.strictEqual(result.diagnoses.length, 2);
  });

  it('falls through gracefully when diagnoser throws (RELIABILITY contract)', async () => {
    const result = await runDiagnosesForFixInputs({
      issues: [{ file: 'a', issue: 'error: x', module: 'm' }],
      askClaudeForDiagnosis: async () => 'unused',
      diagnoseFindings: async () => { throw new Error('Anthropic 503'); },
    });
    assert.strictEqual(result.diagnoses.length, 0);
    assert.match(result.summary, /falling back/i);
    assert.match(result.summary, /Anthropic 503/);
  });
});

// ---------- enrichIssuesWithDiagnosis ----------

describe('enrichIssuesWithDiagnosis', () => {
  const ISSUES = [
    { file: 'src/a.ts', issue: 'error: hardcoded key', module: 'secrets' },
    { file: 'src/b.ts', issue: 'warning: dep stale', module: 'deps' },
    { file: 'src/c.ts', issue: 'info: heads up', module: 'misc' },
  ];

  it('returns issues unchanged when diagnoses is empty', () => {
    const out = enrichIssuesWithDiagnosis(ISSUES, []);
    assert.deepStrictEqual(out, ISSUES);
  });

  it('returns [] for non-array issues', () => {
    assert.deepStrictEqual(enrichIssuesWithDiagnosis(null, []), []);
    assert.deepStrictEqual(enrichIssuesWithDiagnosis(undefined, []), []);
  });

  it('enriches matching issues by detail text', () => {
    const diagnoses = [
      {
        finding: { detail: 'error: hardcoded key' },
        ok: true,
        diagnosis: {
          explanation: 'e',
          rootCause: 'leaking secret',
          recommendation: 'move to env var',
          platformNotes: {},
        },
      },
    ];
    const out = enrichIssuesWithDiagnosis(ISSUES, diagnoses);
    // First issue enriched
    assert.match(out[0].issue, /^error: hardcoded key/);
    assert.match(out[0].issue, /Nuclear-tier diagnosis/);
    assert.match(out[0].issue, /ROOT CAUSE: leaking secret/);
    assert.match(out[0].issue, /RECOMMENDED APPROACH: move to env var/);
    assert.strictEqual(out[0]._diagnosed, true);
    // Other issues passed through unchanged
    assert.strictEqual(out[1].issue, ISSUES[1].issue);
    assert.strictEqual(out[1]._diagnosed, undefined);
  });

  it('skips diagnoses where ok=false', () => {
    const diagnoses = [
      { finding: { detail: 'error: hardcoded key' }, ok: false, diagnosis: null, reason: 'too vague' },
    ];
    const out = enrichIssuesWithDiagnosis(ISSUES, diagnoses);
    assert.strictEqual(out[0].issue, ISSUES[0].issue);
    assert.strictEqual(out[0]._diagnosed, undefined);
  });

  it('appends platformNotes when present', () => {
    const diagnoses = [
      {
        finding: { detail: 'error: hardcoded key' },
        ok: true,
        diagnosis: {
          explanation: 'e',
          rootCause: 'r',
          recommendation: 're',
          platformNotes: { Vercel: 'use env var', AWS: 'use Secrets Manager' },
        },
      },
    ];
    const out = enrichIssuesWithDiagnosis(ISSUES, diagnoses);
    assert.match(out[0].issue, /PLATFORM NOTES:/);
    assert.match(out[0].issue, /Vercel: use env var/);
    assert.match(out[0].issue, /AWS: use Secrets Manager/);
  });

  it('handles malformed diagnoses entries without crashing', () => {
    const diagnoses = [null, undefined, { ok: true }, { finding: { detail: 'x' } }, { finding: { detail: 'error: hardcoded key' }, ok: true }];
    const out = enrichIssuesWithDiagnosis(ISSUES, diagnoses);
    // Nothing should crash; nothing valid to enrich
    assert.strictEqual(out[0]._diagnosed, undefined);
  });
});

// ---------- shipDiagnosisAwareFix ----------

describe('shipDiagnosisAwareFix', () => {
  it('returns empty result for empty issue list', async () => {
    const r = await shipDiagnosisAwareFix({
      issues: [],
      askClaudeForDiagnosis: async () => '',
    });
    assert.strictEqual(r.enrichedIssues.length, 0);
    assert.strictEqual(r.enrichedCount, 0);
    assert.match(r.summary, /no issues/i);
  });

  it('end-to-end: runs diagnoser, enriches issues, returns counts', async () => {
    const fakeDiagnose = async (opts) => ({
      diagnoses: opts.findings.map((f) => ({
        finding: f,
        ok: true,
        diagnosis: {
          explanation: 'e',
          rootCause: 'rc',
          recommendation: 're for ' + f.detail,
          platformNotes: {},
        },
      })),
      summary: 'diagnosed all',
    });
    const r = await shipDiagnosisAwareFix({
      issues: [
        { file: 'src/a.ts', issue: 'error: a', module: 'm1' },
        { file: 'src/b.ts', issue: 'error: b', module: 'm2' },
      ],
      askClaudeForDiagnosis: async () => 'unused',
      diagnoseFindings: fakeDiagnose,
    });
    assert.strictEqual(r.enrichedIssues.length, 2);
    assert.strictEqual(r.enrichedCount, 2);
    assert.match(r.enrichedIssues[0].issue, /RECOMMENDED APPROACH: re for error: a/);
    assert.match(r.summary, /2\/2 issues enriched/);
  });

  it('falls through with original issues when diagnoser fails (RELIABILITY contract)', async () => {
    const issues = [{ file: 'x', issue: 'error: y', module: 'm' }];
    const r = await shipDiagnosisAwareFix({
      issues,
      askClaudeForDiagnosis: async () => 'unused',
      diagnoseFindings: async () => { throw new Error('boom'); },
    });
    assert.strictEqual(r.enrichedCount, 0);
    assert.strictEqual(r.enrichedIssues.length, 1);
    // Original issue passed through unchanged
    assert.strictEqual(r.enrichedIssues[0].issue, 'error: y');
  });

  it('partial enrichment when only some diagnoses succeed', async () => {
    const fakeDiagnose = async (opts) => ({
      diagnoses: opts.findings.map((f, i) => ({
        finding: f,
        ok: i === 0, // first succeeds, second fails
        diagnosis: i === 0 ? {
          explanation: 'e', rootCause: 'rc', recommendation: 're', platformNotes: {},
        } : null,
        reason: i === 0 ? null : 'too vague',
      })),
      summary: 'partial',
    });
    const r = await shipDiagnosisAwareFix({
      issues: [
        { file: 'a', issue: 'error: a', module: 'm' },
        { file: 'b', issue: 'error: b', module: 'm' },
      ],
      askClaudeForDiagnosis: async () => 'unused',
      diagnoseFindings: fakeDiagnose,
    });
    assert.strictEqual(r.enrichedCount, 1);
    assert.match(r.enrichedIssues[0].issue, /RECOMMENDED APPROACH/);
    assert.strictEqual(r.enrichedIssues[1]._diagnosed, undefined);
  });
});
