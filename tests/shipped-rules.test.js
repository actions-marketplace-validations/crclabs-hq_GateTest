'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  loadShippedRules,
  findShippedRule,
  applyShippedRule,
  validateShippedRule,
  DEFAULT_RULES_DIR,
  SUPPORTED_SCHEMA_VERSIONS,
  SUPPORTED_TRANSFORM_KINDS,
} = require('../src/core/shipped-rules');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gatetest-shipped-rules-'));
}

function writeRule(dir, name, obj) {
  const full = path.join(dir, name);
  fs.writeFileSync(full, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
  return full;
}

function validRule(overrides = {}) {
  return {
    id: 'test-rule-1',
    ruleKey: 'tls-security:js-reject-unauthorized',
    module: 'tlsSecurity',
    pattern: 'rejectUnauthorized\\s*:\\s*false',
    transform: {
      kind: 'regex-replace',
      find: 'rejectUnauthorized(\\s*):(\\s*)false',
      replace: 'rejectUnauthorized$1:$2true',
      flags: 'g',
    },
    promotedAt: '2026-05-17T00:00:00Z',
    promotedFromCustomers: 5,
    winRate: 0.94,
    description: 'flip false→true',
    schemaVersion: 1,
    ...overrides,
  };
}

// Silence the stderr warnings during tests so the test runner output stays clean.
let _origStderrWrite;
before(() => {
  _origStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    const s = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
    if (s.startsWith('[shipped-rules]')) return true;
    return _origStderrWrite(chunk, ...rest);
  };
});
after(() => {
  if (_origStderrWrite) process.stderr.write = _origStderrWrite;
});

// ---------------------------------------------------------------------------

describe('shipped-rules / loadShippedRules', () => {
  it('returns empty when the directory does not exist', () => {
    const ghost = path.join(os.tmpdir(), `does-not-exist-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const out = loadShippedRules({ rulesDir: ghost });
    assert.deepStrictEqual(out.rules, []);
    assert.deepStrictEqual(out.loadedFrom, []);
  });

  it('returns empty when the directory exists but is empty', () => {
    const dir = tmpDir();
    const out = loadShippedRules({ rulesDir: dir });
    assert.deepStrictEqual(out.rules, []);
  });

  it('loads three valid rule JSON files', () => {
    const dir = tmpDir();
    writeRule(dir, 'a.json', validRule({ id: 'a' }));
    writeRule(dir, 'b.json', validRule({ id: 'b', ruleKey: 'lint:prefer-const' }));
    writeRule(dir, 'c.json', validRule({ id: 'c', module: 'cookieSecurity' }));
    const out = loadShippedRules({ rulesDir: dir });
    assert.strictEqual(out.rules.length, 3);
    assert.strictEqual(out.loadedFrom.length, 3);
    const ids = out.rules.map((r) => r.id).sort();
    assert.deepStrictEqual(ids, ['a', 'b', 'c']);
  });

  it('silently skips a malformed JSON file but returns the valid ones', () => {
    const dir = tmpDir();
    writeRule(dir, 'good1.json', validRule({ id: 'good1' }));
    writeRule(dir, 'bad.json', '{ "id": "x", "ruleKey":');     // truncated JSON
    writeRule(dir, 'good2.json', validRule({ id: 'good2' }));
    const out = loadShippedRules({ rulesDir: dir });
    assert.strictEqual(out.rules.length, 2);
    const ids = out.rules.map((r) => r.id).sort();
    assert.deepStrictEqual(ids, ['good1', 'good2']);
  });

  it('skips non-JSON files in the directory', () => {
    const dir = tmpDir();
    writeRule(dir, 'a.json', validRule({ id: 'a' }));
    fs.writeFileSync(path.join(dir, 'README.md'), '# notes');
    fs.writeFileSync(path.join(dir, 'noise.txt'), 'noise');
    const out = loadShippedRules({ rulesDir: dir });
    assert.strictEqual(out.rules.length, 1);
    assert.strictEqual(out.rules[0].id, 'a');
  });

  it('rejects rules with unsupported schemaVersion', () => {
    const dir = tmpDir();
    writeRule(dir, 'bad.json', validRule({ schemaVersion: 999 }));
    const out = loadShippedRules({ rulesDir: dir });
    assert.strictEqual(out.rules.length, 0);
  });

  it('rejects rules with unsupported transform.kind', () => {
    const dir = tmpDir();
    writeRule(dir, 'bad.json', validRule({
      transform: { kind: 'magic-pony', find: 'a', replace: 'b' },
    }));
    const out = loadShippedRules({ rulesDir: dir });
    assert.strictEqual(out.rules.length, 0);
  });

  it('rejects rules missing required fields', () => {
    const dir = tmpDir();
    writeRule(dir, 'no-id.json', validRule({ id: '' }));
    writeRule(dir, 'no-key.json', validRule({ id: 'x', ruleKey: '' }));
    writeRule(dir, 'no-module.json', validRule({ id: 'y', module: '' }));
    writeRule(dir, 'no-find.json', validRule({ id: 'z', transform: { kind: 'regex-replace', find: '', replace: 'b' } }));
    const out = loadShippedRules({ rulesDir: dir });
    assert.strictEqual(out.rules.length, 0);
  });

  it('rejects a rule whose transform.find regex does not compile', () => {
    const dir = tmpDir();
    writeRule(dir, 'bad.json', validRule({
      transform: { kind: 'regex-replace', find: '(unclosed', replace: 'b', flags: 'g' },
    }));
    const out = loadShippedRules({ rulesDir: dir });
    assert.strictEqual(out.rules.length, 0);
  });

  it('rejects a rule whose optional pattern regex does not compile', () => {
    const dir = tmpDir();
    writeRule(dir, 'bad.json', validRule({ pattern: '(also-unclosed' }));
    const out = loadShippedRules({ rulesDir: dir });
    assert.strictEqual(out.rules.length, 0);
  });

  it('exposes the default rules dir constant and supported sets', () => {
    assert.ok(DEFAULT_RULES_DIR.endsWith(path.join('src', 'shipped-rules')));
    assert.ok(SUPPORTED_SCHEMA_VERSIONS.has(1));
    assert.ok(SUPPORTED_TRANSFORM_KINDS.has('regex-replace'));
  });

  it('loads the real seed rules ship/d in src/shipped-rules/', () => {
    const out = loadShippedRules();
    // Eight seed rules ship at minimum (tls reject/env/strict, cookie httpOnly/secure,
    // parseint-radix, var-to-const, empty-catch).
    assert.ok(out.rules.length >= 8, `expected ≥8 seed rules, got ${out.rules.length}`);
    const keys = new Set(out.rules.map((r) => r.ruleKey));
    assert.ok(keys.has('tls-security:js-reject-unauthorized'));
    assert.ok(keys.has('cookie-security:js-httponly-false'));
    assert.ok(keys.has('lint:parseint-radix'));
  });
});

describe('shipped-rules / findShippedRule', () => {
  it('returns the matching rule on exact ruleKey + module match', () => {
    const rules = [
      validRule({ id: 'a', ruleKey: 'foo:bar', module: 'modA' }),
      validRule({ id: 'b', ruleKey: 'foo:baz', module: 'modB' }),
    ];
    const hit = findShippedRule(rules, { ruleKey: 'foo:baz', module: 'modB' });
    assert.ok(hit);
    assert.strictEqual(hit.id, 'b');
  });

  it('returns null when no rule matches the criteria', () => {
    const rules = [validRule({ ruleKey: 'foo:bar', module: 'modA' })];
    const hit = findShippedRule(rules, { ruleKey: 'foo:bar', module: 'wrong' });
    assert.strictEqual(hit, null);
  });

  it('returns null on empty/invalid inputs', () => {
    assert.strictEqual(findShippedRule(null, { ruleKey: 'x', module: 'y' }), null);
    assert.strictEqual(findShippedRule([], { ruleKey: 'x', module: 'y' }), null);
    assert.strictEqual(findShippedRule([validRule()], { ruleKey: null, module: 'y' }), null);
  });

  it('returns the FIRST hit when multiple rules match (stable order)', () => {
    const rules = [
      validRule({ id: 'first', ruleKey: 'k', module: 'm' }),
      validRule({ id: 'second', ruleKey: 'k', module: 'm' }),
    ];
    const hit = findShippedRule(rules, { ruleKey: 'k', module: 'm' });
    assert.strictEqual(hit.id, 'first');
  });
});

describe('shipped-rules / applyShippedRule', () => {
  it('applies a regex-replace transform when the pattern matches', () => {
    const rule = validRule();
    const out = applyShippedRule(rule, 'const o = { rejectUnauthorized: false };');
    assert.ok(out);
    assert.strictEqual(out.applied, true);
    assert.ok(out.patched.includes('rejectUnauthorized: true'));
  });

  it('returns applied:false when the pattern does not match content', () => {
    const rule = validRule();
    const out = applyShippedRule(rule, 'const o = { foo: 1 };');
    assert.ok(out);
    assert.strictEqual(out.applied, false);
    assert.strictEqual(out.patched, 'const o = { foo: 1 };');
  });

  it('returns applied:false when applicability gate fails', () => {
    const rule = validRule({ pattern: 'this-string-is-not-present' });
    const out = applyShippedRule(rule, 'rejectUnauthorized: false');
    assert.ok(out);
    assert.strictEqual(out.applied, false);
  });

  it('returns null on invalid rule shape', () => {
    assert.strictEqual(applyShippedRule(null, 'x'), null);
    assert.strictEqual(applyShippedRule({}, 'x'), null);
  });

  it('returns null on non-string content', () => {
    assert.strictEqual(applyShippedRule(validRule(), 123), null);
    assert.strictEqual(applyShippedRule(validRule(), null), null);
  });

  it('respects regex flags (g vs i vs default)', () => {
    const rule = validRule({
      pattern: 'foo',
      transform: { kind: 'regex-replace', find: 'foo', replace: 'bar', flags: 'g' },
    });
    const out = applyShippedRule(rule, 'foo foo foo');
    assert.strictEqual(out.patched, 'bar bar bar');
  });

  it('works without a `pattern` applicability gate', () => {
    const rule = validRule();
    delete rule.pattern;
    const out = applyShippedRule(rule, 'const o = { rejectUnauthorized: false };');
    assert.ok(out);
    assert.strictEqual(out.applied, true);
  });
});

describe('shipped-rules / validateShippedRule', () => {
  it('accepts a known-good rule', () => {
    assert.strictEqual(validateShippedRule(validRule()), true);
  });

  it('rejects non-object / null', () => {
    assert.strictEqual(validateShippedRule(null), false);
    assert.strictEqual(validateShippedRule(undefined), false);
    assert.strictEqual(validateShippedRule([]), false);
    assert.strictEqual(validateShippedRule('hi'), false);
  });

  it('rejects rules with bad regex find', () => {
    assert.strictEqual(
      validateShippedRule(validRule({ transform: { kind: 'regex-replace', find: '(', replace: 'x' } })),
      false
    );
  });

  it('rejects empty find string', () => {
    assert.strictEqual(
      validateShippedRule(validRule({ transform: { kind: 'regex-replace', find: '', replace: 'x' } })),
      false
    );
  });
});
