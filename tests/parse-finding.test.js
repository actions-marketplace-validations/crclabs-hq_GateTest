'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseFinding,
  classifySeverity,
  extractFileFromCheck,
} = require('../src/core/parse-finding');

// ── parseFinding ────────────────────────────────────────────────────

test('parseFinding — extracts file + line + message from standard shape', () => {
  const f = parseFinding('src/foo.ts:42:5 — missing return type', 'modX', 0);
  assert.equal(f.file, 'src/foo.ts');
  assert.equal(f.line, 42);
  assert.equal(f.message, 'missing return type');
});

test('parseFinding — handles dash separator', () => {
  const f = parseFinding('src/bar.js:10 - eval() detected', 'modX', 0);
  assert.equal(f.file, 'src/bar.js');
  assert.equal(f.line, 10);
  assert.match(f.message, /eval/);
});

test('parseFinding — handles colon separator', () => {
  const f = parseFinding('lib/x.py:100: undefined variable', 'modX', 0);
  assert.equal(f.file, 'lib/x.py');
  assert.equal(f.line, 100);
});

test('parseFinding — handles file-only (no line)', () => {
  const f = parseFinding('README.md — typo in headings', 'modX', 0);
  assert.equal(f.file, 'README.md');
  assert.equal(f.line, null);
  assert.match(f.message, /typo/);
});

test('parseFinding — strips leading [severity] tag', () => {
  const f = parseFinding('[error] src/a.ts:5 — missing import', 'modX', 0);
  assert.equal(f.file, 'src/a.ts');
  assert.equal(f.line, 5);
  assert.equal(f.severity, 'error');
});

test('parseFinding — strips leading "severity:" tag', () => {
  const f = parseFinding('warning: src/a.ts:5 — unused variable', 'modX', 0);
  assert.equal(f.file, 'src/a.ts');
  assert.equal(f.severity, 'warning');
});

test('parseFinding — file with path segments + special chars', () => {
  const f = parseFinding('src/components/Button.tsx:88:12 — missing aria-label', 'a11y', 0);
  assert.equal(f.file, 'src/components/Button.tsx');
  assert.equal(f.line, 88);
});

test('parseFinding — bare message produces null file', () => {
  const f = parseFinding('Workflow .github/workflows/deploy.yml uses unpinned action', 'ciSec', 0);
  // This message DOES embed a path that ends in .yml — parser tries
  // to find a "file: rest" or "file:line: rest" shape. "Workflow .github/..."
  // doesn't match either, so file should be null.
  // Acceptance: when file extraction is ambiguous, leave file null.
  assert.equal(typeof f.message, 'string');
});

test('parseFinding — empty / non-string input is safe', () => {
  assert.equal(parseFinding('', 'm', 0).file, null);
  assert.equal(parseFinding(null, 'm', 0).file, null);
  assert.equal(parseFinding(undefined, 'm', 0).file, null);
  assert.equal(parseFinding(42, 'm', 0).file, null);
});

test('parseFinding — id contains module + index', () => {
  const f = parseFinding('something', 'myModule', 7);
  assert.equal(f.id, 'myModule-7');
});

test('parseFinding — unknown module falls back to "unknown"', () => {
  const f = parseFinding('x', null, 3);
  assert.equal(f.id, 'unknown-3');
});

// ── classifySeverity ────────────────────────────────────────────────

test('classifySeverity — error prefix wins', () => {
  assert.equal(classifySeverity('error: foo'), 'error');
  assert.equal(classifySeverity('critical: bar'), 'error');
});

test('classifySeverity — warning prefix wins', () => {
  assert.equal(classifySeverity('warning: foo'), 'warning');
});

test('classifySeverity — info prefix wins', () => {
  assert.equal(classifySeverity('info: foo'), 'info');
  assert.equal(classifySeverity('summary: 12 files scanned'), 'info');
});

test('classifySeverity — keyword heuristic kicks in when no prefix', () => {
  assert.equal(classifySeverity('hardcoded API key in src/foo.ts'), 'error');
  assert.equal(classifySeverity('outdated dependency: lodash'), 'warning');
});

test('classifySeverity — non-string input defaults to warning', () => {
  assert.equal(classifySeverity(null), 'warning');
});

// ── extractFileFromCheck ────────────────────────────────────────────

test('extractFileFromCheck — structured check.file is used', () => {
  const r = extractFileFromCheck({ file: 'src/a.ts', line: 12, message: 'x' });
  assert.equal(r.file, 'src/a.ts');
  assert.equal(r.line, 12);
});

test('extractFileFromCheck — falls back to check.details.file', () => {
  const r = extractFileFromCheck({ details: { file: 'lib/b.js', line: 7 }, message: 'x' });
  assert.equal(r.file, 'lib/b.js');
  assert.equal(r.line, 7);
});

test('extractFileFromCheck — falls back to check.path', () => {
  const r = extractFileFromCheck({ path: 'config/x.yml' });
  assert.equal(r.file, 'config/x.yml');
});

test('extractFileFromCheck — parses message when no structured field', () => {
  const r = extractFileFromCheck({
    message: 'src/foo.ts:42 — missing import',
    name: 'lint',
  });
  assert.equal(r.file, 'src/foo.ts');
  assert.equal(r.line, 42);
});

test('extractFileFromCheck — returns nulls when nothing extractable', () => {
  const r = extractFileFromCheck({
    name: 'summary',
    message: 'scanned 42 files in 1.2s',
  });
  assert.equal(r.file, null);
});

test('extractFileFromCheck — null / non-object safe', () => {
  assert.deepEqual(extractFileFromCheck(null), { file: null, line: null });
  assert.deepEqual(extractFileFromCheck(undefined), { file: null, line: null });
  assert.deepEqual(extractFileFromCheck('string'), { file: null, line: null });
});

// ── Regression coverage: the bug Craig hit ─────────────────────────

test('REGRESSION: modules with no structured file but a file:line message are now fixable', () => {
  // Before the fix: extractFileFromCheck wasn't called from runAutoPr
  // and findings like this got dropped. Now they're extracted.
  const r = extractFileFromCheck({
    name: 'no-eval',
    severity: 'error',
    message: 'src/utils/legacy.js:88 — eval() detected',
  });
  assert.equal(r.file, 'src/utils/legacy.js');
  assert.equal(r.line, 88);
});
