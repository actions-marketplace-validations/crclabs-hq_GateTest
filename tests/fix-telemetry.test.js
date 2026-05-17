const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  recordFixAttempt,
  summariseLayerRatios,
  defaultTelemetryPath,
  _sanitiseRecord,
} = require('../website/app/lib/fix-telemetry');

function tmpJsonl() {
  return path.join(
    os.tmpdir(),
    `gatetest-telemetry-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`
  );
}

describe('fix-telemetry — recordFixAttempt', () => {
  let p;

  beforeEach(() => {
    p = tmpJsonl();
  });

  it('appends a JSON line to the JSONL file', () => {
    recordFixAttempt({
      layer: 'ast',
      success: true,
      issueRuleKey: 'js-reject-unauthorized',
      module: 'tlsSecurity',
      durationMs: 12,
      costUsd: 0,
    }, { path: p });

    assert.ok(fs.existsSync(p), 'JSONL file should exist');
    const raw = fs.readFileSync(p, 'utf8');
    const lines = raw.trim().split('\n');
    assert.strictEqual(lines.length, 1);
    const rec = JSON.parse(lines[0]);
    assert.strictEqual(rec.layer, 'ast');
    assert.strictEqual(rec.success, true);
    assert.strictEqual(rec.issueRuleKey, 'js-reject-unauthorized');
    assert.strictEqual(rec.module, 'tlsSecurity');
    assert.strictEqual(rec.durationMs, 12);
  });

  it('record contains layer, success, ruleKey, module, duration, cost', () => {
    recordFixAttempt({
      layer: 'claude',
      success: true,
      issueRuleKey: 'r',
      module: 'm',
      durationMs: 9001,
      costUsd: 0.0123,
    }, { path: p });
    const rec = JSON.parse(fs.readFileSync(p, 'utf8').trim());
    assert.ok('layer' in rec);
    assert.ok('success' in rec);
    assert.ok('issueRuleKey' in rec);
    assert.ok('module' in rec);
    assert.ok('durationMs' in rec);
    assert.ok('costUsd' in rec);
    assert.ok('ts' in rec);
  });

  it('does NOT record issue.content / file contents / repo URLs', () => {
    recordFixAttempt({
      layer: 'rule',
      success: true,
      issueRuleKey: 'r',
      module: 'm',
      durationMs: 1,
      costUsd: 0,
      content: 'SECRET_API_KEY=abcd1234',
      file: '/private/path/foo.js',
      issue: { content: 'sensitive' },
      repoUrl: 'https://github.com/secret/private',
    }, { path: p });

    const rec = JSON.parse(fs.readFileSync(p, 'utf8').trim());
    assert.strictEqual(rec.content, undefined);
    assert.strictEqual(rec.file, undefined);
    assert.strictEqual(rec.issue, undefined);
    assert.strictEqual(rec.repoUrl, undefined);
    // The raw bytes on disk must not contain the secret value.
    const raw = fs.readFileSync(p, 'utf8');
    assert.strictEqual(raw.includes('SECRET_API_KEY'), false);
    assert.strictEqual(raw.includes('abcd1234'), false);
  });

  it('appends repeatedly without losing earlier lines', () => {
    for (let i = 0; i < 5; i++) {
      recordFixAttempt({
        layer: 'rule',
        success: i % 2 === 0,
        issueRuleKey: `r-${i}`,
        module: 'm',
        durationMs: i,
        costUsd: 0,
      }, { path: p });
    }
    const lines = fs.readFileSync(p, 'utf8').trim().split('\n');
    assert.strictEqual(lines.length, 5);
  });

  it('NEVER throws (the resilience contract) even on a bad path', () => {
    // /nonexistent/deep/path is fine — mkdirSync recursive will create.
    // The harder failure case: try writing to a path under a regular file.
    const fileAsParent = tmpJsonl();
    fs.writeFileSync(fileAsParent, 'x', 'utf8');
    const childPath = path.join(fileAsParent, 'child.jsonl');
    assert.doesNotThrow(() => {
      recordFixAttempt({
        layer: 'ast',
        success: false,
        issueRuleKey: 'r',
        module: 'm',
      }, { path: childPath });
    });
    fs.unlinkSync(fileAsParent);
  });

  it('clamps invalid layer values to null', () => {
    const rec = _sanitiseRecord({ layer: 'bogus-not-a-real-layer', success: true });
    assert.strictEqual(rec.layer, null);
  });

  it('clamps negative durationMs / costUsd to 0', () => {
    const rec = _sanitiseRecord({ layer: 'ast', durationMs: -5, costUsd: -1 });
    assert.strictEqual(rec.durationMs, 0);
    assert.strictEqual(rec.costUsd, 0);
  });

  it('defaultTelemetryPath resolves under homedir', () => {
    const p2 = defaultTelemetryPath();
    assert.ok(p2.includes('.gatetest'));
    assert.ok(p2.endsWith('fix-attempts.jsonl'));
  });
});

describe('fix-telemetry — summariseLayerRatios', () => {
  let p;

  beforeEach(() => {
    p = tmpJsonl();
  });

  it('returns empty stats when file is missing', async () => {
    const stats = await summariseLayerRatios({ path: p });
    assert.strictEqual(stats.ast.count, 0);
    assert.strictEqual(stats.rule.count, 0);
    assert.strictEqual(stats.recipe.count, 0);
    assert.strictEqual(stats.claude.count, 0);
    assert.strictEqual(stats.null.count, 0);
  });

  it('groups by layer correctly', async () => {
    const layers = ['ast', 'ast', 'rule', 'recipe', 'claude', 'claude', 'claude', null];
    for (const l of layers) {
      recordFixAttempt({
        layer: l,
        success: true,
        issueRuleKey: 'r',
        module: 'm',
        durationMs: 1,
        costUsd: l === 'claude' ? 0.01 : 0,
      }, { path: p });
    }
    const stats = await summariseLayerRatios({ path: p });
    assert.strictEqual(stats.ast.count, 2);
    assert.strictEqual(stats.rule.count, 1);
    assert.strictEqual(stats.recipe.count, 1);
    assert.strictEqual(stats.claude.count, 3);
    assert.strictEqual(stats.null.count, 1);
    assert.ok(Math.abs(stats.claude.totalCostUsd - 0.03) < 1e-9);
  });

  it('counts successes separately from total count', async () => {
    recordFixAttempt({ layer: 'ast', success: true,  issueRuleKey: 'r', module: 'm', durationMs: 1 }, { path: p });
    recordFixAttempt({ layer: 'ast', success: false, issueRuleKey: 'r', module: 'm', durationMs: 1 }, { path: p });
    recordFixAttempt({ layer: 'ast', success: true,  issueRuleKey: 'r', module: 'm', durationMs: 1 }, { path: p });
    const stats = await summariseLayerRatios({ path: p });
    assert.strictEqual(stats.ast.count, 3);
    assert.strictEqual(stats.ast.successes, 2);
  });

  it('skips malformed JSON lines without crashing', async () => {
    fs.writeFileSync(p, [
      JSON.stringify({ ts: new Date().toISOString(), layer: 'ast', success: true }),
      'this is not JSON',
      '{ partial',
      '',
      JSON.stringify({ ts: new Date().toISOString(), layer: 'rule', success: true }),
    ].join('\n') + '\n', 'utf8');
    const stats = await summariseLayerRatios({ path: p });
    assert.strictEqual(stats.ast.count, 1);
    assert.strictEqual(stats.rule.count, 1);
  });

  it('honours since/until window', async () => {
    // Older record (manually crafted with old timestamp)
    fs.writeFileSync(p, JSON.stringify({
      ts: '2020-01-01T00:00:00.000Z',
      layer: 'ast',
      success: true,
      durationMs: 1,
      costUsd: 0,
    }) + '\n', 'utf8');
    recordFixAttempt({ layer: 'rule', success: true, issueRuleKey: 'r', module: 'm', durationMs: 1 }, { path: p });

    const since = new Date(Date.now() - 60_000);
    const stats = await summariseLayerRatios({ since, path: p });
    assert.strictEqual(stats.ast.count, 0, 'old record filtered out');
    assert.strictEqual(stats.rule.count, 1, 'new record included');
  });
});
