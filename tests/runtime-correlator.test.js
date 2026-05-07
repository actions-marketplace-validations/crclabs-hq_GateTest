'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  correlateFindings,
  matchFinding,
  normalisePath,
  pathsMatch,
  linesMatch,
  renderLiveBadge,
  renderCorrelationSummary,
  FILE_MATCH_FUZZ,
} = require('../website/app/lib/runtime-correlator');

// ─── normalisePath ────────────────────────────────────────────────────────────

describe('normalisePath', () => {
  it('returns empty string for null/empty input', () => {
    assert.equal(normalisePath(null), '');
    assert.equal(normalisePath(''), '');
    assert.equal(normalisePath(undefined), '');
  });

  it('strips src/ prefix', () => {
    assert.equal(normalisePath('src/api/checkout.ts'), 'api/checkout.ts');
  });

  it('strips app/ prefix', () => {
    assert.equal(normalisePath('app/api/scan/route.ts'), 'api/scan/route.ts');
  });

  it('strips website/app/ prefix', () => {
    assert.equal(normalisePath('website/app/lib/utils.ts'), 'lib/utils.ts');
  });

  it('strips leading ./', () => {
    assert.equal(normalisePath('./src/api.ts'), 'api.ts');
  });

  it('normalises backslashes', () => {
    assert.equal(normalisePath('src\\api\\checkout.ts'), 'api/checkout.ts');
  });

  it('lowercases the result', () => {
    assert.equal(normalisePath('src/API/Checkout.TS'), 'api/checkout.ts');
  });

  it('strips pages/ prefix', () => {
    assert.equal(normalisePath('pages/api/auth.ts'), 'api/auth.ts');
  });
});

// ─── pathsMatch ───────────────────────────────────────────────────────────────

describe('pathsMatch', () => {
  it('matches identical paths', () => {
    assert.ok(pathsMatch('api/checkout.ts', 'api/checkout.ts'));
  });

  it('matches when src/ prefix differs', () => {
    assert.ok(pathsMatch('src/api/checkout.ts', 'api/checkout.ts'));
  });

  it('matches when app/ prefix differs', () => {
    assert.ok(pathsMatch('app/api/checkout.ts', 'api/checkout.ts'));
  });

  it('matches deeply nested paths', () => {
    assert.ok(pathsMatch('website/app/api/scan/run/route.ts', 'api/scan/run/route.ts'));
  });

  it('does not match different file names', () => {
    assert.ok(!pathsMatch('src/api/checkout.ts', 'src/api/payment.ts'));
  });

  it('returns false for empty paths', () => {
    assert.ok(!pathsMatch('', 'api/x.ts'));
    assert.ok(!pathsMatch('api/x.ts', ''));
    assert.ok(!pathsMatch('', ''));
  });

  it('is case-insensitive', () => {
    assert.ok(pathsMatch('src/API/Checkout.TS', 'api/checkout.ts'));
  });
});

// ─── linesMatch ───────────────────────────────────────────────────────────────

describe('linesMatch', () => {
  it('matches exact line numbers', () => {
    assert.ok(linesMatch(42, 42));
  });

  it('matches within FILE_MATCH_FUZZ range', () => {
    assert.ok(linesMatch(42, 42 + FILE_MATCH_FUZZ));
    assert.ok(linesMatch(42, 42 - FILE_MATCH_FUZZ));
  });

  it('does not match beyond FILE_MATCH_FUZZ', () => {
    assert.ok(!linesMatch(42, 42 + FILE_MATCH_FUZZ + 1));
    assert.ok(!linesMatch(42, 42 - FILE_MATCH_FUZZ - 1));
  });

  it('returns false when either value is non-number', () => {
    assert.ok(!linesMatch('42', 42));
    assert.ok(!linesMatch(42, null));
    assert.ok(!linesMatch(undefined, 42));
  });
});

// ─── matchFinding ─────────────────────────────────────────────────────────────

describe('matchFinding', () => {
  const finding = { file: 'src/api/checkout.ts', line: 42 };
  const matchingEvent = {
    id: 'ev1',
    frames: [{ file: 'src/api/checkout.ts', lineno: 42 }],
    count: 5,
    message: 'TypeError: Cannot read property',
  };

  it('returns null for null inputs', () => {
    assert.equal(matchFinding(null, [matchingEvent]), null);
    assert.equal(matchFinding(finding, null), null);
    assert.equal(matchFinding(finding, []), null);
  });

  it('returns matching event when file and line match', () => {
    const result = matchFinding(finding, [matchingEvent]);
    assert.ok(result);
    assert.equal(result.id, 'ev1');
  });

  it('matches with path prefix difference', () => {
    const eventNoPrefix = {
      frames: [{ file: 'api/checkout.ts', lineno: 42 }],
    };
    assert.ok(matchFinding(finding, [eventNoPrefix]));
  });

  it('matches within fuzz range', () => {
    const fuzzyEvent = { frames: [{ file: 'src/api/checkout.ts', lineno: 42 + FILE_MATCH_FUZZ }] };
    assert.ok(matchFinding(finding, [fuzzyEvent]));
  });

  it('does not match beyond fuzz range', () => {
    const farEvent = { frames: [{ file: 'src/api/checkout.ts', lineno: 100 }] };
    assert.equal(matchFinding(finding, [farEvent]), null);
  });

  it('matches when finding has no line number (file-only match)', () => {
    const noLineFinding = { file: 'src/api/checkout.ts', line: null };
    const result = matchFinding(noLineFinding, [matchingEvent]);
    assert.ok(result);
  });

  it('returns null when file does not match', () => {
    const wrongFile = { frames: [{ file: 'src/api/payment.ts', lineno: 42 }] };
    assert.equal(matchFinding(finding, [wrongFile]), null);
  });

  it('returns first matching event', () => {
    const event1 = { id: 'first', frames: [{ file: 'src/api/checkout.ts', lineno: 42 }] };
    const event2 = { id: 'second', frames: [{ file: 'src/api/checkout.ts', lineno: 42 }] };
    const result = matchFinding(finding, [event1, event2]);
    assert.equal(result.id, 'first');
  });

  it('handles events with no frames', () => {
    const noFrames = { frames: [] };
    assert.equal(matchFinding(finding, [noFrames]), null);
  });
});

// ─── correlateFindings ────────────────────────────────────────────────────────

describe('correlateFindings', () => {
  const findings = [
    { file: 'src/api/checkout.ts', line: 42, severity: 'error', module: 'secrets', message: 'key' },
    { file: 'src/utils.ts', line: 5, severity: 'warning', module: 'lint', message: 'unused' },
  ];

  const runtimeEvents = [
    {
      id: 'ev1',
      frames: [{ file: 'src/api/checkout.ts', lineno: 42 }],
      count: 150,
      message: 'TypeError',
      lastSeen: '2026-05-06',
    },
  ];

  it('returns empty for empty findings', () => {
    const result = correlateFindings([], runtimeEvents);
    assert.deepEqual(result.correlated, []);
    assert.equal(result.liveCount, 0);
  });

  it('returns findings unchanged when no runtime events', () => {
    const result = correlateFindings(findings, []);
    assert.equal(result.correlated.length, 2);
    assert.equal(result.liveCount, 0);
    assert.ok(result.summary.includes('No runtime events'));
  });

  it('marks matched findings as liveInProd=true', () => {
    const result = correlateFindings(findings, runtimeEvents);
    const live = result.correlated.find((f) => f.file === 'src/api/checkout.ts');
    assert.ok(live);
    assert.ok(live.liveInProd);
    assert.equal(live.liveEventCount, 150);
    assert.equal(live.liveLastSeen, '2026-05-06');
    assert.equal(live.liveEventId, 'ev1');
  });

  it('marks unmatched findings as liveInProd=false', () => {
    const result = correlateFindings(findings, runtimeEvents);
    const notLive = result.correlated.find((f) => f.file === 'src/utils.ts');
    assert.ok(notLive);
    assert.equal(notLive.liveInProd, false);
  });

  it('sorts live findings before non-live', () => {
    const result = correlateFindings(findings, runtimeEvents);
    assert.ok(result.correlated[0].liveInProd);
    assert.ok(!result.correlated[result.correlated.length - 1].liveInProd);
  });

  it('returns liveCount correctly', () => {
    const result = correlateFindings(findings, runtimeEvents);
    assert.equal(result.liveCount, 1);
  });

  it('summary mentions live count when matches found', () => {
    const result = correlateFindings(findings, runtimeEvents);
    assert.ok(result.summary.includes('1'));
  });

  it('summary mentions no matches when none', () => {
    const result = correlateFindings(findings, [{ frames: [{ file: 'irrelevant.js', lineno: 1 }] }]);
    assert.ok(result.summary.includes('No static findings'));
  });

  it('defaults liveEventCount to 1 when count is absent', () => {
    const eventsNoCount = [{ frames: [{ file: 'src/api/checkout.ts', lineno: 42 }] }];
    const result = correlateFindings(findings, eventsNoCount);
    const live = result.correlated.find((f) => f.liveInProd);
    assert.equal(live.liveEventCount, 1);
  });
});

// ─── renderLiveBadge ─────────────────────────────────────────────────────────

describe('renderLiveBadge', () => {
  it('returns empty string for non-live finding', () => {
    const finding = { liveInProd: false };
    assert.equal(renderLiveBadge(finding), '');
  });

  it('returns empty string for null', () => {
    assert.equal(renderLiveBadge(null), '');
  });

  it('returns LIVE badge for live finding', () => {
    const finding = { liveInProd: true, liveEventCount: 1 };
    const badge = renderLiveBadge(finding);
    assert.ok(badge.includes('🔥'));
    assert.ok(badge.includes('LIVE'));
  });

  it('includes count when liveEventCount > 1', () => {
    const finding = { liveInProd: true, liveEventCount: 50 };
    const badge = renderLiveBadge(finding);
    assert.ok(badge.includes('50×'));
  });

  it('does not include count suffix for single event', () => {
    const finding = { liveInProd: true, liveEventCount: 1 };
    const badge = renderLiveBadge(finding);
    assert.ok(!badge.includes('1×'));
  });
});

// ─── renderCorrelationSummary ─────────────────────────────────────────────────

describe('renderCorrelationSummary', () => {
  it('returns empty string when liveCount is 0', () => {
    assert.equal(renderCorrelationSummary({ correlated: [], liveCount: 0 }), '');
  });

  it('includes heading and table when liveCount > 0', () => {
    const correlated = [
      {
        file: 'src/api/checkout.ts',
        line: 42,
        severity: 'error',
        module: 'secrets',
        message: 'key',
        liveInProd: true,
        liveEventCount: 5,
        liveLastSeen: '2026-05-06T10:00:00Z',
      },
    ];
    const md = renderCorrelationSummary({ correlated, liveCount: 1 });
    assert.ok(md.includes('🔥'));
    assert.ok(md.includes('Live Production Correlation'));
    assert.ok(md.includes('src/api/checkout.ts'));
    assert.ok(md.includes('5'));
  });

  it('mentions runtime source', () => {
    const correlated = [{
      file: 'x.ts', line: 1, severity: 'error', module: 'm', message: 'x',
      liveInProd: true, liveEventCount: 1, liveLastSeen: null,
    }];
    const md = renderCorrelationSummary({ correlated, liveCount: 1, runtimeSource: 'Sentry' });
    assert.ok(md.includes('Sentry'));
  });

  it('defaults runtime source to "runtime monitoring"', () => {
    const correlated = [{
      file: 'x.ts', line: 1, severity: 'error', module: 'm', message: 'x',
      liveInProd: true, liveEventCount: 1, liveLastSeen: null,
    }];
    const md = renderCorrelationSummary({ correlated, liveCount: 1 });
    assert.ok(md.includes('runtime monitoring'));
  });

  it('handles null lastSeen gracefully', () => {
    const correlated = [{
      file: 'x.ts', line: 1, severity: 'error', module: 'm', message: 'x',
      liveInProd: true, liveEventCount: 3, liveLastSeen: null,
    }];
    const md = renderCorrelationSummary({ correlated, liveCount: 1 });
    assert.ok(typeof md === 'string');
    assert.ok(!md.includes('last:'));
  });
});
