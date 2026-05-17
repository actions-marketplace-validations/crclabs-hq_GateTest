'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
  assessPromotionCandidate,
  buildShippedRuleFromRecipe,
  serializeShippedRule,
  recipeFingerprint,
  DEFAULT_CRITERIA,
  SHIPPED_RULE_SCHEMA_VERSION,
} = require('../website/app/lib/recipe-promotion');

const { validateShippedRule } = require('../src/core/shipped-rules');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function ripeRecipe(overrides = {}) {
  return {
    id: 'rec-123',
    ruleKey: 'tls-security:js-reject-unauthorized',
    module: 'tlsSecurity',
    fileExt: '.js',
    before: '  rejectUnauthorized: false,',
    after:  '  rejectUnauthorized: true,',
    confidence: 'stable',
    applicationCount: 12,
    customers: 5,
    occurrences: 12,
    winRate: 0.95,
    falsePositiveRate: 0.0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

describe('recipe-promotion / assessPromotionCandidate', () => {
  it('promotes a healthy recipe with the default criteria', () => {
    const out = assessPromotionCandidate(ripeRecipe());
    assert.strictEqual(out.promote, true);
    assert.match(out.reason, /promoted/i);
    assert.strictEqual(out.recipeFingerprint.length, 16);
  });

  it('blocks when there are too few customers, with a useful reason', () => {
    const out = assessPromotionCandidate(ripeRecipe({ customers: 2 }));
    assert.strictEqual(out.promote, false);
    assert.match(out.reason, /customers/i);
    assert.match(out.reason, /2\/3/);
  });

  it('blocks when occurrences are below the threshold', () => {
    const out = assessPromotionCandidate(ripeRecipe({ occurrences: 4 }));
    assert.strictEqual(out.promote, false);
    assert.match(out.reason, /occurrences/i);
  });

  it('blocks when the win rate is too low', () => {
    const out = assessPromotionCandidate(ripeRecipe({ winRate: 0.6 }));
    assert.strictEqual(out.promote, false);
    assert.match(out.reason, /win-rate/i);
  });

  it('blocks when the false-positive rate is too high', () => {
    const out = assessPromotionCandidate(ripeRecipe({ falsePositiveRate: 0.05 }));
    assert.strictEqual(out.promote, false);
    assert.match(out.reason, /false-positive/i);
  });

  it('returns a stable fingerprint regardless of promote/block outcome', () => {
    const a = assessPromotionCandidate(ripeRecipe());
    const b = assessPromotionCandidate(ripeRecipe({ customers: 1 }));
    assert.strictEqual(a.recipeFingerprint, b.recipeFingerprint);
  });

  it('rejects invalid recipes', () => {
    assert.strictEqual(assessPromotionCandidate(null).promote, false);
    assert.strictEqual(assessPromotionCandidate({}).promote, false);
    assert.strictEqual(assessPromotionCandidate(ripeRecipe({ ruleKey: '' })).promote, false);
    assert.strictEqual(assessPromotionCandidate(ripeRecipe({ module: '' })).promote, false);
    assert.strictEqual(assessPromotionCandidate(ripeRecipe({ before: '' })).promote, false);
    assert.strictEqual(assessPromotionCandidate(ripeRecipe({ after: 'no-change', before: 'no-change' })).promote, false);
  });

  it('honors caller-overridden thresholds', () => {
    // Loosen the criteria to a single customer — formerly-blocked recipe now passes.
    const out = assessPromotionCandidate(ripeRecipe({ customers: 1, occurrences: 1 }), {
      minCustomers: 1,
      minOccurrences: 1,
    });
    assert.strictEqual(out.promote, true);
  });

  it('falls back to applicationCount when occurrences is not set', () => {
    const rec = ripeRecipe();
    delete rec.occurrences;
    rec.applicationCount = 8;
    const out = assessPromotionCandidate(rec);
    assert.strictEqual(out.promote, true);
  });

  it('exposes defaults for tooling', () => {
    assert.strictEqual(DEFAULT_CRITERIA.minCustomers, 3);
    assert.strictEqual(DEFAULT_CRITERIA.minOccurrences, 5);
    assert.strictEqual(DEFAULT_CRITERIA.minWinRate, 0.9);
    assert.ok(DEFAULT_CRITERIA.maxFalsePositives < 0.05);
  });
});

describe('recipe-promotion / buildShippedRuleFromRecipe', () => {
  it('produces a rule that passes the shipped-rules validator', () => {
    const rule = buildShippedRuleFromRecipe(ripeRecipe());
    assert.strictEqual(validateShippedRule(rule), true);
  });

  it('carries customer count and win rate into provenance fields', () => {
    const rule = buildShippedRuleFromRecipe(ripeRecipe({ customers: 7, winRate: 0.93 }));
    assert.strictEqual(rule.promotedFromCustomers, 7);
    assert.strictEqual(rule.winRate, 0.93);
  });

  it('uses regex-replace as the default transform kind', () => {
    const rule = buildShippedRuleFromRecipe(ripeRecipe());
    assert.strictEqual(rule.transform.kind, 'regex-replace');
    assert.strictEqual(typeof rule.transform.find, 'string');
    assert.strictEqual(typeof rule.transform.replace, 'string');
    assert.strictEqual(rule.transform.flags, 'g');
  });

  it('escapes the recipe.before content for the regex.find by default', () => {
    const rec = ripeRecipe({
      before: 'x.y(z)+1',
      after:  'x.y(z) + 2',
    });
    const rule = buildShippedRuleFromRecipe(rec);
    // The escaped form should match the literal source.
    const re = new RegExp(rule.transform.find);
    assert.ok(re.test('x.y(z)+1'));
    // And it should NOT match unrelated text the unescaped regex would.
    assert.strictEqual(re.test('xay(z)11'), false);
  });

  it('uses an opts.find override when supplied', () => {
    const rule = buildShippedRuleFromRecipe(ripeRecipe(), {
      find: 'customFind\\d+',
      replace: 'customReplace',
    });
    assert.strictEqual(rule.transform.find, 'customFind\\d+');
    assert.strictEqual(rule.transform.replace, 'customReplace');
  });

  it('throws TypeError on invalid input', () => {
    assert.throws(() => buildShippedRuleFromRecipe(null), TypeError);
    assert.throws(() => buildShippedRuleFromRecipe({}), TypeError);
    assert.throws(() => buildShippedRuleFromRecipe({ ruleKey: 'x' }), TypeError);
    assert.throws(() => buildShippedRuleFromRecipe({ ruleKey: 'x', module: 'm' }), TypeError);
  });

  it('produces a deterministic id from the fingerprint when no id override supplied', () => {
    const r1 = buildShippedRuleFromRecipe(ripeRecipe());
    const r2 = buildShippedRuleFromRecipe(ripeRecipe());
    assert.strictEqual(r1.id, r2.id);
    assert.match(r1.id, /^promoted-/);
  });

  it('sets the shipped-rule schemaVersion to the current version', () => {
    const rule = buildShippedRuleFromRecipe(ripeRecipe());
    assert.strictEqual(rule.schemaVersion, SHIPPED_RULE_SCHEMA_VERSION);
  });
});

describe('recipe-promotion / serializeShippedRule', () => {
  it('produces deterministic output (same input ⇒ same string)', () => {
    const rule = buildShippedRuleFromRecipe(ripeRecipe());
    const a = serializeShippedRule(rule);
    const b = serializeShippedRule(rule);
    assert.strictEqual(a, b);
  });

  it('emits keys in the documented order so git diffs stay readable', () => {
    const rule = buildShippedRuleFromRecipe(ripeRecipe());
    const out = serializeShippedRule(rule);
    const idIdx        = out.indexOf('"id"');
    const ruleKeyIdx   = out.indexOf('"ruleKey"');
    const moduleIdx    = out.indexOf('"module"');
    const transformIdx = out.indexOf('"transform"');
    const schemaIdx    = out.indexOf('"schemaVersion"');
    assert.ok(idIdx < ruleKeyIdx);
    assert.ok(ruleKeyIdx < moduleIdx);
    assert.ok(moduleIdx < transformIdx);
    assert.ok(transformIdx < schemaIdx);
  });

  it('ends with a single trailing newline (POSIX-friendly)', () => {
    const rule = buildShippedRuleFromRecipe(ripeRecipe());
    const out = serializeShippedRule(rule);
    assert.strictEqual(out.endsWith('\n'), true);
    assert.strictEqual(out.endsWith('\n\n'), false);
  });

  it('throws on non-object input', () => {
    assert.throws(() => serializeShippedRule(null), TypeError);
    assert.throws(() => serializeShippedRule('x'), TypeError);
  });

  it('round-trips through JSON.parse intact', () => {
    const rule = buildShippedRuleFromRecipe(ripeRecipe());
    const ser = serializeShippedRule(rule);
    const parsed = JSON.parse(ser);
    assert.strictEqual(parsed.id, rule.id);
    assert.strictEqual(parsed.ruleKey, rule.ruleKey);
    assert.strictEqual(parsed.transform.find, rule.transform.find);
  });
});

describe('recipe-promotion / recipeFingerprint', () => {
  it('returns the same hash for two recipes with the same fingerprint inputs', () => {
    const a = recipeFingerprint(ripeRecipe({ applicationCount: 1 }));
    const b = recipeFingerprint(ripeRecipe({ applicationCount: 99 }));
    // applicationCount is NOT part of the fingerprint, so they should match.
    assert.strictEqual(a, b);
  });

  it('returns different hashes when ruleKey differs', () => {
    const a = recipeFingerprint(ripeRecipe({ ruleKey: 'foo:bar' }));
    const b = recipeFingerprint(ripeRecipe({ ruleKey: 'foo:baz' }));
    assert.notStrictEqual(a, b);
  });

  it('returns empty string for invalid input', () => {
    assert.strictEqual(recipeFingerprint(null), '');
    assert.strictEqual(recipeFingerprint(undefined), '');
  });
});
