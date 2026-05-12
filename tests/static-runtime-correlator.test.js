/**
 * Tests for website/app/lib/static-runtime-correlator.js
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { correlateFindingsWithRuntime, renderLiveBadgeSection, filePathsMatch, isLiveMatch } = require('../website/app/lib/static-runtime-correlator');

// ---------------------------------------------------------------------------
describe('filePathsMatch', () => {
  test('exact match', () => {
    assert.ok(filePathsMatch('src/api/checkout.ts', 'src/api/checkout.ts'));
  });

  test('absolute vs relative', () => {
    assert.ok(filePathsMatch('src/api/checkout.ts', '/home/app/src/api/checkout.ts'));
  });

  test('trailing-component match', () => {
    assert.ok(filePathsMatch('api/checkout.ts', '/home/user/project/api/checkout.ts'));
  });

  test('non-matching files', () => {
    assert.ok(!filePathsMatch('src/api/checkout.ts', 'src/lib/helpers.ts'));
  });

  test('handles null gracefully', () => {
    assert.ok(!filePathsMatch(null, 'src/api.ts'));
    assert.ok(!filePathsMatch('src/api.ts', null));
    assert.ok(!filePathsMatch(null, null));
  });

  test('normalises backslashes', () => {
    assert.ok(filePathsMatch('src\\api\\checkout.ts', 'src/api/checkout.ts'));
  });
});

// ---------------------------------------------------------------------------
describe('isLiveMatch', () => {
  const event = (file, line) => ({ sourceLocation: file ? { file, line } : null });

  test('matches file + line within tolerance', () => {
    const finding = { file: 'src/api/checkout.ts', line: 42 };
    assert.ok(isLiveMatch(finding, event('src/api/checkout.ts', 45)));
  });

  test('does not match line outside tolerance', () => {
    const finding = { file: 'src/api/checkout.ts', line: 42 };
    assert.ok(!isLiveMatch(finding, event('src/api/checkout.ts', 100)));
  });

  test('does not match different file', () => {
    const finding = { file: 'src/api/checkout.ts', line: 42 };
    assert.ok(!isLiveMatch(finding, event('src/lib/helpers.ts', 42)));
  });

  test('returns false for event with no sourceLocation', () => {
    const finding = { file: 'src/api.ts', line: 10 };
    assert.ok(!isLiveMatch(finding, { sourceLocation: null }));
  });

  test('returns false when lines are 0', () => {
    const finding = { file: 'src/api.ts', line: 0 };
    assert.ok(!isLiveMatch(finding, event('src/api.ts', 0)));
  });
});

// ---------------------------------------------------------------------------
describe('correlateFindingsWithRuntime — basic', () => {
  test('returns all findings with live:false when no runtime events', () => {
    const findings = [
      { file: 'src/api.ts', line: 10, severity: 'error', detail: 'XSS risk' },
    ];
    const result = correlateFindingsWithRuntime({ findings, datadogErrors: [], vercelRoutes: [] });
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].live, false);
    assert.equal(result.liveCount, 0);
  });

  test('marks finding as live when Datadog event matches', () => {
    const findings = [
      { file: 'src/api/checkout.ts', line: 42, severity: 'error', detail: 'SQL injection' },
    ];
    const datadogErrors = [
      {
        id: 'dd1',
        message: 'TypeError at checkout',
        service: 'api',
        timestamp: new Date().toISOString(),
        sourceLocation: { file: 'src/api/checkout.ts', line: 44 },
      },
    ];
    const result = correlateFindingsWithRuntime({ findings, datadogErrors });
    assert.equal(result.liveCount, 1);
    assert.ok(result.findings[0].live);
    assert.equal(result.findings[0].liveEvents.length, 1);
  });

  test('does not mark finding as live when lines are too far apart', () => {
    const findings = [
      { file: 'src/api/checkout.ts', line: 42, severity: 'error', detail: 'XSS' },
    ];
    const datadogErrors = [
      {
        id: 'dd1',
        message: 'Error',
        sourceLocation: { file: 'src/api/checkout.ts', line: 200 },
      },
    ];
    const result = correlateFindingsWithRuntime({ findings, datadogErrors });
    assert.equal(result.liveCount, 0);
  });
});

// ---------------------------------------------------------------------------
describe('correlateFindingsWithRuntime — sorting', () => {
  test('live findings sort before non-live', () => {
    const findings = [
      { file: 'src/b.ts', line: 10, severity: 'warning', detail: 'warning' },
      { file: 'src/a.ts', line: 10, severity: 'error', detail: 'error' },
    ];
    const datadogErrors = [
      { id: 'd1', message: 'err', sourceLocation: { file: 'src/b.ts', line: 10 } },
    ];
    const result = correlateFindingsWithRuntime({ findings, datadogErrors });
    // b.ts (live warning) should come before a.ts (non-live error)
    assert.ok(result.findings[0].live);
    assert.equal(result.findings[0].file, 'src/b.ts');
  });
});

// ---------------------------------------------------------------------------
describe('correlateFindingsWithRuntime — route performance', () => {
  test('attaches route performance data for API findings', () => {
    const findings = [
      { file: 'app/api/checkout/route.ts', line: 10, severity: 'error', detail: 'slow query' },
    ];
    const vercelRoutes = [
      { route: '/api/checkout', lcp: 3000, fid: 100, cls: 0.1, ttfb: 500, pageViews: 1000 },
    ];
    const result = correlateFindingsWithRuntime({ findings, vercelRoutes });
    const f = result.findings[0];
    assert.ok(f.routePerformance !== null);
    assert.ok(f.routePerformance.slow); // 3000ms > 2500ms threshold
  });

  test('does not attach route performance for non-API findings', () => {
    const findings = [
      { file: 'src/lib/helpers.ts', line: 10, severity: 'warning', detail: 'unused var' },
    ];
    const vercelRoutes = [
      { route: '/api/checkout', lcp: 3000, pageViews: 100 },
    ];
    const result = correlateFindingsWithRuntime({ findings, vercelRoutes });
    assert.equal(result.findings[0].routePerformance, null);
  });
});

// ---------------------------------------------------------------------------
describe('correlateFindingsWithRuntime — empty inputs', () => {
  test('handles empty findings array', () => {
    const result = correlateFindingsWithRuntime({ findings: [] });
    assert.equal(result.findings.length, 0);
    assert.equal(result.liveCount, 0);
  });

  test('handles no opts', () => {
    const result = correlateFindingsWithRuntime();
    assert.equal(result.findings.length, 0);
  });
});

// ---------------------------------------------------------------------------
describe('renderLiveBadgeSection', () => {
  test('returns empty string when no live findings', () => {
    const result = { findings: [{ file: 'a.ts', line: 1, live: false, liveEvents: [] }] };
    assert.equal(renderLiveBadgeSection(result), '');
  });

  test('includes file path and summary for live findings', () => {
    const result = {
      findings: [{
        file: 'src/api/checkout.ts',
        line: 42,
        live: true,
        detail: 'SQL injection risk',
        liveEvents: [{ message: 'TypeError in prod', timestamp: new Date().toISOString(), service: 'api' }],
      }],
    };
    const section = renderLiveBadgeSection(result);
    assert.ok(section.includes('Active in Production'));
    assert.ok(section.includes('src/api/checkout.ts'));
  });

  test('caps at 10 live findings in the report', () => {
    const liveFinding = (i) => ({
      file: `src/file${i}.ts`, line: i, live: true, detail: `issue ${i}`,
      liveEvents: [{ message: 'err', timestamp: new Date().toISOString() }],
    });
    const result = { findings: Array.from({ length: 15 }, (_, i) => liveFinding(i)) };
    const section = renderLiveBadgeSection(result);
    const matches = section.match(/###\s+`/g) || [];
    assert.ok(matches.length <= 10);
  });
});
