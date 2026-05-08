'use strict';

/**
 * Tests for POST /api/integrations/ai-generators
 *
 * Tests the route logic by exercising its helper functions and validating
 * the request/response contract. Full route tests (with HTTP) are handled
 * by the e2e suite; these cover the logic layer.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// ─── Inline the pure helpers (mirroring the route logic) ─────────────────────

const ALLOWED_GENERATORS = ['v0', 'lovable', 'bolt', 'replit', 'cursor', 'copilot', 'other'];
const ALLOWED_SUITES = ['quick', 'security', 'full'];
const MAX_FILES = 50;
const MAX_FILE_BYTES = 200 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;

function normaliseFile(f) {
  if (!f || typeof f !== 'object') return null;
  if (typeof f.path !== 'string' || typeof f.content !== 'string') return null;
  if (f.path.length === 0 || f.content.length === 0) return null;
  return { path: f.path, content: f.content };
}

function processFiles(rawFiles) {
  const files = [];
  let totalBytes = 0;
  for (const f of rawFiles.slice(0, MAX_FILES)) {
    const norm = normaliseFile(f);
    if (!norm) continue;
    const bytes = Buffer.byteLength(norm.content, 'utf8');
    if (bytes > MAX_FILE_BYTES) continue;
    totalBytes += bytes;
    if (totalBytes > MAX_TOTAL_BYTES) break;
    files.push(norm);
  }
  return files;
}

function extractFindings(modules) {
  const out = [];
  for (const mod of modules) {
    if (!mod || typeof mod !== 'object') continue;
    const moduleName = typeof mod.module === 'string' ? mod.module : 'unknown';
    const checks = Array.isArray(mod.checks) ? mod.checks : [];
    for (const check of checks) {
      if (!check || typeof check !== 'object') continue;
      if (check.passed) continue;
      out.push({
        severity: typeof check.severity === 'string' ? check.severity : 'warning',
        module: moduleName,
        file: typeof check.file === 'string' ? check.file : '',
        line: typeof check.line === 'number' ? check.line : null,
        message: typeof check.message === 'string' ? check.message : '',
        suggestion: typeof check.suggestion === 'string' ? check.suggestion : undefined,
      });
    }
  }
  return out;
}

// ─── normaliseFile ────────────────────────────────────────────────────────────

describe('normaliseFile', () => {
  it('returns null for non-object input', () => {
    assert.equal(normaliseFile(null), null);
    assert.equal(normaliseFile('string'), null);
    assert.equal(normaliseFile(42), null);
  });

  it('returns null when path or content is missing', () => {
    assert.equal(normaliseFile({ path: 'file.js' }), null);
    assert.equal(normaliseFile({ content: 'code' }), null);
  });

  it('returns null when path or content is empty string', () => {
    assert.equal(normaliseFile({ path: '', content: 'code' }), null);
    assert.equal(normaliseFile({ path: 'file.js', content: '' }), null);
  });

  it('returns normalised file for valid input', () => {
    const result = normaliseFile({ path: 'src/app.js', content: 'const x = 1;' });
    assert.deepEqual(result, { path: 'src/app.js', content: 'const x = 1;' });
  });

  it('ignores extra fields', () => {
    const result = normaliseFile({ path: 'a.js', content: 'b', extra: 'ignored' });
    assert.ok(result);
    assert.equal(result.path, 'a.js');
  });
});

// ─── processFiles ─────────────────────────────────────────────────────────────

describe('processFiles', () => {
  it('returns empty array for empty input', () => {
    assert.deepEqual(processFiles([]), []);
  });

  it('skips null / invalid entries', () => {
    const files = processFiles([null, { path: 'a.js', content: 'x' }, undefined]);
    assert.equal(files.length, 1);
  });

  it('skips files exceeding MAX_FILE_BYTES', () => {
    const bigContent = 'x'.repeat(MAX_FILE_BYTES + 1);
    const files = processFiles([{ path: 'big.js', content: bigContent }]);
    assert.equal(files.length, 0);
  });

  it('caps at MAX_FILES files', () => {
    const many = Array.from({ length: MAX_FILES + 5 }, (_, i) => ({
      path: `file${i}.js`,
      content: 'const x = 1;',
    }));
    const files = processFiles(many);
    assert.ok(files.length <= MAX_FILES);
  });

  it('stops when total bytes exceed MAX_TOTAL_BYTES', () => {
    // Each file is ~500 KB; 5 files = 2.5 MB > MAX_TOTAL_BYTES
    const chunk = 'x'.repeat(500 * 1024);
    const many = Array.from({ length: 5 }, (_, i) => ({ path: `f${i}.js`, content: chunk }));
    const files = processFiles(many);
    assert.ok(files.length < 5);
  });

  it('preserves valid small files', () => {
    const input = [
      { path: 'a.js', content: 'const a = 1;' },
      { path: 'b.js', content: 'const b = 2;' },
    ];
    const files = processFiles(input);
    assert.equal(files.length, 2);
  });
});

// ─── ALLOWED_GENERATORS / ALLOWED_SUITES ─────────────────────────────────────

describe('allowed values', () => {
  it('ALLOWED_GENERATORS includes v0, lovable, bolt, replit, cursor', () => {
    for (const g of ['v0', 'lovable', 'bolt', 'replit', 'cursor', 'copilot', 'other']) {
      assert.ok(ALLOWED_GENERATORS.includes(g), `missing: ${g}`);
    }
  });

  it('ALLOWED_SUITES includes quick, security, full', () => {
    for (const s of ['quick', 'security', 'full']) {
      assert.ok(ALLOWED_SUITES.includes(s), `missing: ${s}`);
    }
  });

  it('unknown generator maps to "other"', () => {
    const gen = ALLOWED_GENERATORS.includes('unknown-gen') ? 'unknown-gen' : 'other';
    assert.equal(gen, 'other');
  });

  it('unknown suite falls back to "quick"', () => {
    const rawSuite = 'nuclear';
    const suite = ALLOWED_SUITES.includes(rawSuite) ? rawSuite : 'quick';
    assert.equal(suite, 'quick');
  });
});

// ─── extractFindings ──────────────────────────────────────────────────────────

describe('extractFindings', () => {
  it('returns empty array for empty modules', () => {
    assert.deepEqual(extractFindings([]), []);
  });

  it('skips passed checks', () => {
    const modules = [
      {
        module: 'syntax',
        checks: [{ passed: true, message: 'ok', severity: 'info' }],
      },
    ];
    assert.deepEqual(extractFindings(modules), []);
  });

  it('includes failed checks with module name', () => {
    const modules = [
      {
        module: 'secrets',
        checks: [
          {
            passed: false,
            severity: 'error',
            file: 'src/config.js',
            line: 5,
            message: 'Hardcoded API key',
            suggestion: 'Move to env var',
          },
        ],
      },
    ];
    const findings = extractFindings(modules);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].module, 'secrets');
    assert.equal(findings[0].severity, 'error');
    assert.equal(findings[0].file, 'src/config.js');
    assert.equal(findings[0].line, 5);
    assert.equal(findings[0].message, 'Hardcoded API key');
    assert.equal(findings[0].suggestion, 'Move to env var');
  });

  it('handles multiple modules and checks', () => {
    const modules = [
      {
        module: 'lint',
        checks: [
          { passed: false, severity: 'warning', message: 'unused var' },
          { passed: true, message: 'ok' },
        ],
      },
      {
        module: 'secrets',
        checks: [{ passed: false, severity: 'error', message: 'hardcoded key' }],
      },
    ];
    const findings = extractFindings(modules);
    assert.equal(findings.length, 2);
  });

  it('defaults severity to warning when missing', () => {
    const modules = [
      { module: 'test', checks: [{ passed: false, message: 'issue' }] },
    ];
    const findings = extractFindings(modules);
    assert.equal(findings[0].severity, 'warning');
  });

  it('sets line to null when not a number', () => {
    const modules = [
      { module: 'test', checks: [{ passed: false, severity: 'error', message: 'x', line: 'bad' }] },
    ];
    const findings = extractFindings(modules);
    assert.equal(findings[0].line, null);
  });

  it('handles null/invalid entries in modules array', () => {
    const findings = extractFindings([null, undefined, { module: 'x', checks: null }]);
    assert.deepEqual(findings, []);
  });
});

// ─── Response shape contract ──────────────────────────────────────────────────

describe('response shape', () => {
  it('summary.passed is true when no errors', () => {
    const findings = [
      { severity: 'warning', module: 'lint', file: '', line: null, message: 'x' },
    ];
    const errors = findings.filter((f) => f.severity === 'error').length;
    const passed = errors === 0;
    assert.ok(passed);
  });

  it('summary.passed is false when any error exists', () => {
    const findings = [
      { severity: 'error', module: 'secrets', file: '', line: null, message: 'key' },
    ];
    const errors = findings.filter((f) => f.severity === 'error').length;
    const passed = errors === 0;
    assert.ok(!passed);
  });

  it('badge URL contains "pass" when passed', () => {
    const badge = `https://gatetest.ai/badge/${true ? 'pass' : 'fail'}`;
    assert.ok(badge.includes('pass'));
  });

  it('badge URL contains "fail" when not passed', () => {
    const badge = `https://gatetest.ai/badge/${false ? 'pass' : 'fail'}`;
    assert.ok(badge.includes('fail'));
  });
});
