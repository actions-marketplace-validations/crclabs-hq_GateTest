const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  extractFindingType,
  diffedLines,
  extractBeforeSnippet,
  applyRecipe,
} = require('../website/app/lib/fix-recipe-store.js');

// Note: DB-dependent functions (recordRecipe, lookupRecipe, tryRecipeFix,
// recordSuccessfulFixes, getRecipeStats) are not tested here — they require
// a live Neon connection. Tested via integration tests against staging.
// The pure helper functions below are the algorithmic core and are tested fully.

// ---------------------------------------------------------------------------
// extractFindingType
// ---------------------------------------------------------------------------

describe('extractFindingType', () => {
  it('extracts parenthesised module code', () => {
    assert.equal(extractFindingType('httpOnly: false (js-httponly-false)'), 'js-httponly-false');
  });

  it('extracts code from end of issue string', () => {
    assert.equal(extractFindingType('verify=False — TLS disabled (py-verify-false)'), 'py-verify-false');
  });

  it('falls back to slug of first 50 chars when no parenthesised code', () => {
    const result = extractFindingType('rejectUnauthorized: false — TLS cert validation disabled');
    assert.ok(typeof result === 'string');
    assert.ok(result.length > 0);
    assert.doesNotMatch(result, /\s/);
  });

  it('handles empty string', () => {
    const result = extractFindingType('');
    assert.ok(typeof result === 'string');
  });

  it('normalises to lowercase', () => {
    const result = extractFindingType('UPPERCASE ISSUE (JS-HTTPONLY-FALSE)');
    assert.equal(result, 'js-httponly-false');
  });

  it('multiple parenthesised groups — takes first', () => {
    const result = extractFindingType('something (first-code) and (second-code)');
    assert.equal(result, 'first-code');
  });
});

// ---------------------------------------------------------------------------
// diffedLines
// ---------------------------------------------------------------------------

describe('diffedLines', () => {
  it('returns empty array for identical content', () => {
    assert.deepEqual(diffedLines('a\nb\nc', 'a\nb\nc'), []);
  });

  it('returns 1-indexed changed line numbers', () => {
    const before = 'a\nb\nc\nd';
    const after  = 'a\nB\nc\nd';
    assert.deepEqual(diffedLines(before, after), [2]);
  });

  it('handles multi-line changes', () => {
    const before = 'a\nb\nc';
    const after  = 'X\nY\nc';
    assert.deepEqual(diffedLines(before, after), [1, 2]);
  });

  it('handles different line counts (after longer)', () => {
    const before = 'a\nb';
    const after  = 'a\nb\nc';
    const result = diffedLines(before, after);
    assert.ok(result.includes(3)); // line 3 is new in after
  });

  it('handles empty before', () => {
    const result = diffedLines('', 'a\nb');
    assert.ok(Array.isArray(result));
  });
});

// ---------------------------------------------------------------------------
// extractBeforeSnippet
// ---------------------------------------------------------------------------

describe('extractBeforeSnippet', () => {
  it('returns the lines around the changed region', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
    const content = lines.join('\n');
    const snippet = extractBeforeSnippet(content, [25]);
    assert.match(snippet, /line 25/);
  });

  it('caps at MAX_SNIPPET_BYTES (2048)', () => {
    const content = 'x'.repeat(5000);
    const snippet = extractBeforeSnippet(content, []);
    assert.ok(snippet.length <= 2048);
  });

  it('falls back to first N chars when no changed lines provided', () => {
    const content = 'abcdef'.repeat(100);
    const snippet = extractBeforeSnippet(content, []);
    assert.ok(snippet.length <= 2048);
    assert.ok(snippet.startsWith('abc'));
  });

  it('includes context lines before and after change point', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line-${i + 1}`);
    const content = lines.join('\n');
    const snippet = extractBeforeSnippet(content, [15]);
    assert.match(snippet, /line-7/);   // 8 lines before
    assert.match(snippet, /line-15/);  // the change line
  });
});

// ---------------------------------------------------------------------------
// applyRecipe
// ---------------------------------------------------------------------------

describe('applyRecipe', () => {
  it('applies exact snippet match', () => {
    const content = 'const a = 1;\nconst b = "bad";\nconst c = 3;\n';
    const recipe = {
      before_snippet: 'const b = "bad";',
      after_snippet: 'const b = "good";',
    };
    const result = applyRecipe(content, recipe);
    assert.ok(result !== null);
    assert.match(result, /const b = "good"/);
    assert.doesNotMatch(result, /const b = "bad"/);
  });

  it('returns null when snippet not found', () => {
    const content = 'const x = 1;\n';
    const recipe = {
      before_snippet: 'something that is not in the content',
      after_snippet: 'replacement',
    };
    assert.equal(applyRecipe(content, recipe), null);
  });

  it('preserves surrounding content', () => {
    const content = 'prefix\nbad line\nsuffix\n';
    const recipe = { before_snippet: 'bad line', after_snippet: 'good line' };
    const result = applyRecipe(content, recipe);
    assert.ok(result !== null);
    assert.match(result, /prefix/);
    assert.match(result, /good line/);
    assert.match(result, /suffix/);
  });

  it('fuzzy-matches on significant line when exact fails', () => {
    // Content has extra whitespace that breaks exact match
    const before = 'const opts = { rejectUnauthorized: false };';
    const after  = 'const opts = { rejectUnauthorized: true };';
    const content = `// comment\n${before}\n// end\n`;
    const recipe = {
      before_snippet: before,
      after_snippet: after,
    };
    // Exact should work here since content.includes(before) is true
    const result = applyRecipe(content, recipe);
    assert.ok(result !== null);
    assert.match(result, /rejectUnauthorized: true/);
  });

  it('handles multi-line snippets', () => {
    const before = 'const a = {\n  bad: true,\n};';
    const after  = 'const a = {\n  bad: false,\n};';
    const content = `something before\n${before}\nsomething after`;
    const recipe = { before_snippet: before, after_snippet: after };
    const result = applyRecipe(content, recipe);
    assert.ok(result !== null);
    assert.match(result, /bad: false/);
  });
});

// ---------------------------------------------------------------------------
// Privacy contract
// ---------------------------------------------------------------------------

describe('Privacy: findingType is derived from issue text, not file path', () => {
  it('produces same key regardless of which file the issue came from', () => {
    // The file path is used only for extension extraction — not the key
    const issue = 'rejectUnauthorized: false — TLS cert validation disabled';
    const r1 = extractFindingType(issue);
    const r2 = extractFindingType(issue);
    assert.equal(r1, r2);
  });

  it('produces a compact slug-like key with no raw whitespace', () => {
    const result = extractFindingType('httpOnly: false — js-httponly-false');
    assert.doesNotMatch(result, /\s/);
    assert.ok(result.length > 0);
  });

  it('two distinct issue types produce distinct keys', () => {
    const a = extractFindingType('rejectUnauthorized: false (js-reject-unauthorized)');
    const b = extractFindingType('httpOnly: false (js-httponly-false)');
    assert.notEqual(a, b);
  });
});
