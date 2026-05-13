// =============================================================================
// FIX-PATTERN-RECALL TEST — lib/fix-pattern-recall.js
// =============================================================================
// Reads a customer's committed .gatetest/memory/fix-patterns.json and
// synthesises a "PRIOR FIXES" prompt header that surfaces relevant past
// fixes to Claude.
// =============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildPriorArtHeader,
  summarisePriorArt,
  findFixPatternsJson,
  parseFixPatterns,
  findMatchingPatterns,
  patternKeyFromCheckName,
  FIX_PATTERNS_PATH,
} = require('../lib/fix-pattern-recall');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const STORE = {
  version: 1,
  patterns: {
    'secrets:hardcoded-credential': {
      count: 4,
      lastAt: '2026-04-12T10:00:00Z',
      examples: [
        { description: 'Replaced literal key with process.env read', filesChanged: ['src/db.js'] },
        { description: 'Moved to .env.example placeholder', filesChanged: ['src/api.js'] },
        { description: 'Rotated and moved to vault', filesChanged: ['src/auth.js'] },
      ],
    },
    'lint:no-var': {
      count: 12,
      lastAt: '2026-04-15T08:00:00Z',
      examples: [
        { description: 'var → const where reassignment absent', filesChanged: ['src/main.js'] },
      ],
    },
    'tls-security:reject-unauthorised': {
      count: 1,
      lastAt: '2026-03-10T08:00:00Z',
      examples: [{ description: 'Flipped false → true', filesChanged: ['src/agent.js'] }],
    },
  },
};

const STORE_JSON = JSON.stringify(STORE);

// ---------------------------------------------------------------------------
// patternKeyFromCheckName
// ---------------------------------------------------------------------------

describe('patternKeyFromCheckName', () => {
  it('returns null for empty input', () => {
    assert.equal(patternKeyFromCheckName(''), null);
    assert.equal(patternKeyFromCheckName(null), null);
  });

  it('returns the first two colon-separated parts', () => {
    assert.equal(patternKeyFromCheckName('secrets:hardcoded:extra'), 'secrets:hardcoded');
  });

  it('returns the whole string when no colon', () => {
    assert.equal(patternKeyFromCheckName('secrets'), 'secrets');
  });
});

// ---------------------------------------------------------------------------
// findFixPatternsJson
// ---------------------------------------------------------------------------

describe('findFixPatternsJson', () => {
  it('returns null for empty/missing input', () => {
    assert.equal(findFixPatternsJson(null), null);
    assert.equal(findFixPatternsJson({}), null);
    assert.equal(findFixPatternsJson([]), null);
  });

  it('locates the file in array-form fileContents', () => {
    const fc = [
      { path: 'src/x.js', content: 'foo' },
      { path: `.gatetest/memory/fix-patterns.json`, content: STORE_JSON },
    ];
    assert.equal(findFixPatternsJson(fc), STORE_JSON);
  });

  it('locates the file in map-form fileContents', () => {
    const fc = {
      'src/x.js': 'foo',
      [`.gatetest/memory/fix-patterns.json`]: STORE_JSON,
    };
    assert.equal(findFixPatternsJson(fc), STORE_JSON);
  });

  it('handles nested paths (e.g. monorepo subdirectory)', () => {
    const fc = [
      { path: `apps/api/${FIX_PATTERNS_PATH}`, content: STORE_JSON },
    ];
    assert.equal(findFixPatternsJson(fc), STORE_JSON);
  });

  it('skips entries with non-string content', () => {
    const fc = [
      { path: FIX_PATTERNS_PATH, content: { not: 'a string' } },
    ];
    assert.equal(findFixPatternsJson(fc), null);
  });
});

// ---------------------------------------------------------------------------
// parseFixPatterns
// ---------------------------------------------------------------------------

describe('parseFixPatterns', () => {
  it('returns empty object on malformed JSON', () => {
    assert.deepEqual(parseFixPatterns('{not json'), {});
    assert.deepEqual(parseFixPatterns(''), {});
    assert.deepEqual(parseFixPatterns(null), {});
  });

  it('returns empty object when patterns missing', () => {
    assert.deepEqual(parseFixPatterns('{"version":1}'), {});
  });

  it('returns the patterns map when well-formed', () => {
    const out = parseFixPatterns(STORE_JSON);
    assert.ok(out['secrets:hardcoded-credential']);
    assert.ok(out['lint:no-var']);
  });
});

// ---------------------------------------------------------------------------
// findMatchingPatterns
// ---------------------------------------------------------------------------

describe('findMatchingPatterns', () => {
  it('matches by leading module token of the finding', () => {
    const hits = findMatchingPatterns('secrets: hardcoded API key found', STORE.patterns);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].key, 'secrets:hardcoded-credential');
  });

  it('returns empty when nothing matches', () => {
    const hits = findMatchingPatterns('unknownModule: foo', STORE.patterns);
    assert.equal(hits.length, 0);
  });

  it('returns empty for non-string finding', () => {
    assert.deepEqual(findMatchingPatterns(123, STORE.patterns), []);
    assert.deepEqual(findMatchingPatterns(null, STORE.patterns), []);
  });

  it('is case-insensitive on the module token', () => {
    const hits = findMatchingPatterns('Secrets: API leak', STORE.patterns);
    assert.equal(hits.length, 1);
  });

  it('matches multiple patterns under the same module', () => {
    const extended = {
      'lint:no-var': STORE.patterns['lint:no-var'],
      'lint:no-eval': { count: 3, lastAt: '2026-04-01', examples: [] },
    };
    const hits = findMatchingPatterns('lint: forbidden pattern detected', extended);
    assert.equal(hits.length, 2);
  });
});

// ---------------------------------------------------------------------------
// buildPriorArtHeader
// ---------------------------------------------------------------------------

describe('buildPriorArtHeader', () => {
  it('returns empty string when no fileContents', () => {
    assert.equal(buildPriorArtHeader({ findings: ['secrets: x'] }), '');
  });

  it('returns empty string when no findings', () => {
    const fc = [{ path: FIX_PATTERNS_PATH, content: STORE_JSON }];
    assert.equal(buildPriorArtHeader({ fileContents: fc, findings: [] }), '');
  });

  it('returns empty string when no findings match any pattern', () => {
    const fc = [{ path: FIX_PATTERNS_PATH, content: STORE_JSON }];
    assert.equal(
      buildPriorArtHeader({ fileContents: fc, findings: ['unknownModule: foo'] }),
      ''
    );
  });

  it('builds a populated header when patterns match', () => {
    const fc = [{ path: FIX_PATTERNS_PATH, content: STORE_JSON }];
    const header = buildPriorArtHeader({
      fileContents: fc,
      findings: ['secrets: hardcoded API key in src/foo.js'],
    });
    assert.match(header, /PRIOR FIXES/);
    assert.match(header, /secrets:hardcoded-credential/);
    assert.match(header, /fixed 4x/);
    assert.match(header, /Replaced literal key with process\.env read/);
    assert.match(header, /Stay consistent/);
  });

  it('respects maxPatterns cap', () => {
    const fc = [{ path: FIX_PATTERNS_PATH, content: STORE_JSON }];
    const header = buildPriorArtHeader({
      fileContents: fc,
      findings: ['secrets: x', 'lint: y'],
      maxPatterns: 1,
    });
    // Only one pattern block should appear
    const matches = header.match(/^- /gm) || [];
    assert.equal(matches.length, 1);
  });

  it('ranks patterns by occurrence count (most-fixed first)', () => {
    const fc = [{ path: FIX_PATTERNS_PATH, content: STORE_JSON }];
    const header = buildPriorArtHeader({
      fileContents: fc,
      findings: ['secrets: x', 'lint: y'],
    });
    const noVarIdx = header.indexOf('lint:no-var');
    const secretsIdx = header.indexOf('secrets:hardcoded-credential');
    // lint:no-var has count=12, secrets has count=4 — lint:no-var should appear first
    assert.ok(noVarIdx >= 0 && secretsIdx >= 0, 'both should appear');
    assert.ok(noVarIdx < secretsIdx, 'lint:no-var (count=12) ranks above secrets (count=4)');
  });

  it('respects maxExamplesPerPattern cap', () => {
    const fc = [{ path: FIX_PATTERNS_PATH, content: STORE_JSON }];
    const header = buildPriorArtHeader({
      fileContents: fc,
      findings: ['secrets: x'],
      maxExamplesPerPattern: 1,
    });
    const bulletExamples = (header.match(/^  • /gm) || []).length;
    assert.equal(bulletExamples, 1, 'only one example per pattern');
  });
});

// ---------------------------------------------------------------------------
// summarisePriorArt
// ---------------------------------------------------------------------------

describe('summarisePriorArt', () => {
  it('reports unavailable when no file present', () => {
    const s = summarisePriorArt({ fileContents: [], findings: ['x: y'] });
    assert.equal(s.available, false);
    assert.match(s.reason, /no fix-patterns/);
  });

  it('reports unavailable when patterns empty', () => {
    const empty = JSON.stringify({ version: 1, patterns: {} });
    const s = summarisePriorArt({
      fileContents: [{ path: FIX_PATTERNS_PATH, content: empty }],
      findings: ['secrets: x'],
    });
    assert.equal(s.available, false);
  });

  it('reports available with match count when patterns matched', () => {
    const fc = [{ path: FIX_PATTERNS_PATH, content: STORE_JSON }];
    const s = summarisePriorArt({
      fileContents: fc,
      findings: ['secrets: api key', 'lint: var declaration', 'unknown: foo'],
    });
    assert.equal(s.available, true);
    assert.equal(s.totalPatternsInStore, 3);
    assert.equal(s.matchedThisScan, 2);
    assert.ok(s.matchedKeys.includes('secrets:hardcoded-credential'));
    assert.ok(s.matchedKeys.includes('lint:no-var'));
  });

  it('reports zero matches honestly', () => {
    const fc = [{ path: FIX_PATTERNS_PATH, content: STORE_JSON }];
    const s = summarisePriorArt({
      fileContents: fc,
      findings: ['unknownModule: foo', 'somethingElse: bar'],
    });
    assert.equal(s.available, false);
    assert.equal(s.matchedThisScan, 0);
  });
});
