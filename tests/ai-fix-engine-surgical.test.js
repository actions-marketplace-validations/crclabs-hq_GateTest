/**
 * Tests for the surgical-mode port in ai-fix-engine.js.
 *
 * All tests use dependency injection (_callAnthropic in opts) so no
 * real HTTP calls are made. Temporary files are created in os.tmpdir()
 * and cleaned up after each test.
 */

'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const { aiFix } = require('../src/core/ai-fix-engine');

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Write content to a fresh temp file, returning its absolute path.
 * The file is automatically removed after the test completes.
 */
function makeTempFile(content, ext = '.js') {
  const p = path.join(os.tmpdir(), `gatetest-test-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  fs.writeFileSync(p, content, 'utf-8');
  return p;
}

/**
 * Build a file string of N lines: "line1\nline2\n…\nlineN".
 */
function makeLines(n) {
  const rows = [];
  for (let i = 1; i <= n; i++) rows.push(`line${i}`);
  return rows.join('\n');
}

// ── Test 1 — surgical mode: clean replacement, patch applied correctly ──────

test('aiFix surgical: clean replacement patches only the target window', async () => {
  // 50-line file; issue is at line 25.
  // Surgical window: ±20 → lines 5..45 (clamped to 1..50).
  const original = makeLines(50);
  const filePath = makeTempFile(original);

  try {
    // The mock returns ONLY a replacement block for the window (lines 5..45 = 41 lines).
    // We'll return a replacement that changes exactly one of those lines.
    // Extract the window manually so we can patch it in the mock response.
    const origLines = original.split('\n');
    // window: lines 5..45 (1-indexed), i.e. indices 4..44
    const windowLines = origLines.slice(4, 45);
    // Change the line at line 25 (index 24 within original, index 20 in window)
    windowLines[20] = 'FIXED_LINE_25';
    const mockReplacement = windowLines.join('\n');

    const mockCallAnthropic = async () => mockReplacement;

    const result = await aiFix({
      filePath,
      issueTitle: 'test-issue',
      issueMessage: 'line 25 has a problem',
      lineNumber: 25,
      apiKey: 'test-key',
      _callAnthropic: mockCallAnthropic,
    });

    assert.equal(result.fixed, true, `Expected fixed=true, got: ${result.description}`);
    assert.deepEqual(result.filesChanged, [filePath]);
    assert.ok(/surgical fix applied at line 25/i.test(result.description));

    const written = fs.readFileSync(filePath, 'utf-8');
    const writtenLines = written.split('\n');

    // Lines before window (1..4) byte-identical
    for (let i = 0; i < 4; i++) {
      assert.equal(writtenLines[i], `line${i + 1}`, `Line ${i + 1} should be unchanged`);
    }
    // Line 25 (index 24) should be the fixed version
    assert.equal(writtenLines[24], 'FIXED_LINE_25');
    // Lines after window (46..50) byte-identical
    for (let i = 45; i < 50; i++) {
      assert.equal(writtenLines[i], `line${i + 1}`, `Line ${i + 1} should be unchanged`);
    }
  } finally {
    try { fs.unlinkSync(filePath); } catch { /* cleanup */ }
  }
});

// ── Test 2 — surgical mode: empty replacement is rejected ────────────────────
//
// NOTE: the "replacement mutates outside the splice window" path can't be
// triggered through the natural splice flow — spliceReplacement only ever
// touches the [startLine..endLine] range, so the before/after sections are
// always byte-identical to the original by construction. validateSurgicalFix
// is defense-in-depth and is independently covered by tests/surgical-fix.test.js.
// Here we cover the OTHER early-exit path the engine surfaces: an empty
// replacement block (e.g. Claude returns just fences with nothing inside).

test('aiFix surgical: empty replacement block is rejected', async () => {
  const original = makeLines(50);
  const filePath = makeTempFile(original);

  try {
    // Mock returns fences with nothing between — parseReplacementBlock strips
    // the fences and returns an empty string.
    const mockCallAnthropic = async () => '```\n```';

    const result = await aiFix({
      filePath,
      issueTitle: 'test-issue',
      issueMessage: 'some issue',
      lineNumber: 25,
      apiKey: 'test-key',
      _callAnthropic: mockCallAnthropic,
    });

    assert.equal(result.fixed, false);
    assert.ok(
      /empty replacement/i.test(result.description),
      `Expected "empty replacement" in description, got: "${result.description}"`
    );
    assert.deepEqual(result.filesChanged, []);

    // File must be unchanged
    const written = fs.readFileSync(filePath, 'utf-8');
    assert.equal(written, original);
  } finally {
    try { fs.unlinkSync(filePath); } catch { /* cleanup */ }
  }
});

// ── Test 3 — whole-file mode: clean small fix, mutation guard accepts ────────

test('aiFix whole-file: small targeted replacement accepted by mutation guard', async () => {
  // 20-line file; fix changes exactly 1 line.
  const origLines = [];
  for (let i = 1; i <= 20; i++) origLines.push(`line${i}`);
  origLines[9] = 'const bad = parseFloat(money); // money-float issue';
  const original = origLines.join('\n');

  const fixedLines = [...origLines];
  fixedLines[9] = 'const bad = new Decimal(money); // fixed';
  const correctedContent = fixedLines.join('\n');

  const filePath = makeTempFile(original);

  try {
    const mockCallAnthropic = async () =>
      JSON.stringify({ fixed: true, correctedContent, description: 'Replaced parseFloat with Decimal' });

    const result = await aiFix({
      filePath,
      issueTitle: 'money-float',
      issueMessage: 'Do not use parseFloat for money',
      // No lineNumber → whole-file mode
      apiKey: 'test-key',
      _callAnthropic: mockCallAnthropic,
    });

    assert.equal(result.fixed, true, `Expected fixed=true, got: ${result.description}`);
    assert.deepEqual(result.filesChanged, [filePath]);

    const written = fs.readFileSync(filePath, 'utf-8');
    assert.equal(written, correctedContent);
  } finally {
    try { fs.unlinkSync(filePath); } catch { /* cleanup */ }
  }
});

// ── Test 4 — whole-file mode: huge diff rejected by mutation guard ───────────

test('aiFix whole-file: large rewrite rejected by mutation guard', async () => {
  // 200-line file; mock returns a completely different 200-line file.
  const origLines = [];
  for (let i = 1; i <= 200; i++) origLines.push(`original_line_${i};`);
  const original = origLines.join('\n');

  // Completely rewritten content (every line different).
  const rewrittenLines = [];
  for (let i = 1; i <= 200; i++) rewrittenLines.push(`reformatted_and_renamed_line_${i};`);
  const correctedContent = rewrittenLines.join('\n');

  const filePath = makeTempFile(original);

  try {
    const mockCallAnthropic = async () =>
      JSON.stringify({ fixed: true, correctedContent, description: 'Rewrote everything' });

    const result = await aiFix({
      filePath,
      issueTitle: 'some-issue',
      issueMessage: 'one small thing',
      // No lineNumber → whole-file mode
      apiKey: 'test-key',
      _callAnthropic: mockCallAnthropic,
    });

    assert.equal(result.fixed, false);
    assert.ok(
      /rejected by mutation guard/i.test(result.description),
      `Expected "rejected by mutation guard" in description, got: "${result.description}"`
    );
    assert.deepEqual(result.filesChanged, []);

    // File must be unchanged
    const written = fs.readFileSync(filePath, 'utf-8');
    assert.equal(written, original);
  } finally {
    try { fs.unlinkSync(filePath); } catch { /* cleanup */ }
  }
});

// ── Test 5 — no API key → returns suggestion, fixed=false ────────────────────

test('aiFix: no API key returns fixed=false with fixSuggestion as description', async () => {
  const filePath = makeTempFile('const x = parseFloat(price);');

  try {
    const result = await aiFix({
      filePath,
      issueTitle: 'money-float',
      issueMessage: 'Do not use parseFloat for money',
      fixSuggestion: 'Use new Decimal(price) instead',
      lineNumber: 1,
      apiKey: '',            // explicitly empty — no env var either
      _callAnthropic: async () => { throw new Error('should not be called'); },
    });

    assert.equal(result.fixed, false);
    assert.equal(result.description, 'Use new Decimal(price) instead');
    assert.deepEqual(result.filesChanged, []);
  } finally {
    try { fs.unlinkSync(filePath); } catch { /* cleanup */ }
  }
});

// ── Test 6 — file too large → returns fixed=false, description mentions size ─

test('aiFix: file larger than 120KB returns fixed=false with "too large"', async () => {
  // Write a file slightly over 120KB.
  const bigContent = 'x'.repeat(121_000);
  const filePath = makeTempFile(bigContent);

  try {
    const result = await aiFix({
      filePath,
      issueTitle: 'whatever',
      issueMessage: 'whatever',
      lineNumber: 1,
      apiKey: 'test-key',
      _callAnthropic: async () => { throw new Error('should not be called'); },
    });

    assert.equal(result.fixed, false);
    assert.ok(
      /too large/i.test(result.description),
      `Expected "too large" in description, got: "${result.description}"`
    );
    assert.deepEqual(result.filesChanged, []);
  } finally {
    try { fs.unlinkSync(filePath); } catch { /* cleanup */ }
  }
});
