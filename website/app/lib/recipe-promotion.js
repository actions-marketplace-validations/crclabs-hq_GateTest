/**
 * Recipe promotion — the cross-customer-recipe-distillation engine.
 *
 * `auto-distill.js` writes a recipe into the per-customer JSON store every
 * time Claude solves a templatey finding. When the SAME recipe shape wins
 * on enough DIFFERENT customer installations, it should get promoted from
 * "local recipe (per customer)" to a "shipped deterministic rule" baked
 * into every GateTest install (see `src/core/shipped-rules.js`).
 *
 * Pure-function side of the promotion. The CLI (`bin/gatetest-promote.js`)
 * loads an aggregated corpus, calls `assessPromotionCandidate` on each
 * recipe, and writes a rule JSON file via `serializeShippedRule`. Shipped
 * rules are human-supervised — Craig keeps the call.
 *
 * Promotion criteria (defaults): ≥3 customers, ≥5 occurrences, ≥90% win,
 * <1% FP. Fingerprint = sha256(ruleKey|module|fileExt|before)[:16].
 *
 * Zero npm deps. Safe from both Node CLI and Next.js routes.
 */

'use strict';

const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CRITERIA = Object.freeze({
  minCustomers: 3,
  minOccurrences: 5,
  minWinRate: 0.9,
  maxFalsePositives: 0.01,
});

const SHIPPED_RULE_SCHEMA_VERSION = 1;
const FINGERPRINT_LENGTH = 16; // chars of sha256 we keep for the rule id

// ---------------------------------------------------------------------------
// Fingerprinting
// ---------------------------------------------------------------------------

/**
 * Compute a stable fingerprint for a recipe — the same shape across
 * customers must produce the same fingerprint. Drives both dedup AND
 * promotion-corpus grouping.
 *
 * @param {object} recipe
 * @returns {string} 16-char hex
 */
function recipeFingerprint(recipe) {
  if (!recipe || typeof recipe !== 'object') return '';
  const ruleKey = typeof recipe.ruleKey === 'string' ? recipe.ruleKey : '';
  const mod     = typeof recipe.module  === 'string' ? recipe.module  : '';
  const fileExt = typeof recipe.fileExt === 'string' ? recipe.fileExt : '';
  const before  = typeof recipe.before  === 'string' ? recipe.before  : '';
  return crypto
    .createHash('sha256')
    .update(`${ruleKey}|${mod}|${fileExt}|${before}`)
    .digest('hex')
    .slice(0, FINGERPRINT_LENGTH);
}

// ---------------------------------------------------------------------------
// Assessment
// ---------------------------------------------------------------------------

/**
 * Decide whether a recipe is ready to promote to a shipped rule.
 *
 * The `recipe` shape comes from `auto-distill.js`. The aggregated stats
 * — number of distinct customers, win rate, false-positive rate —
 * normally come from the central aggregator's telemetry roll-up. They
 * can also be supplied directly on the recipe (`recipe.customers`,
 * `recipe.winRate`, `recipe.falsePositiveRate`, `recipe.applicationCount`)
 * which is how the seed-data path and CLI tooling feed the assessment.
 *
 * @param {object} recipe
 * @param {object} [criteria]
 * @param {number} [criteria.minCustomers]      default 3
 * @param {number} [criteria.minOccurrences]    default 5
 * @param {number} [criteria.minWinRate]        default 0.9
 * @param {number} [criteria.maxFalsePositives] default 0.01
 * @returns {{ promote: boolean, reason: string, recipeFingerprint: string }}
 */
function assessPromotionCandidate(recipe, criteria = {}) {
  const c = { ...DEFAULT_CRITERIA, ...criteria };
  const fingerprint = recipeFingerprint(recipe);

  if (!recipe || typeof recipe !== 'object') {
    return { promote: false, reason: 'invalid-recipe', recipeFingerprint: fingerprint };
  }
  if (typeof recipe.ruleKey !== 'string' || !recipe.ruleKey) {
    return { promote: false, reason: 'no-ruleKey', recipeFingerprint: fingerprint };
  }
  if (typeof recipe.module !== 'string' || !recipe.module) {
    return { promote: false, reason: 'no-module', recipeFingerprint: fingerprint };
  }
  if (typeof recipe.before !== 'string' || !recipe.before) {
    return { promote: false, reason: 'no-before', recipeFingerprint: fingerprint };
  }
  if (typeof recipe.after !== 'string') {
    return { promote: false, reason: 'no-after', recipeFingerprint: fingerprint };
  }
  if (recipe.before === recipe.after) {
    return { promote: false, reason: 'before-equals-after', recipeFingerprint: fingerprint };
  }

  const customers = Number(recipe.customers || 0);
  const occurrences = Number(
    recipe.occurrences != null ? recipe.occurrences : recipe.applicationCount || 0
  );
  const winRate = Number(recipe.winRate != null ? recipe.winRate : 0);
  const fpRate  = Number(recipe.falsePositiveRate != null ? recipe.falsePositiveRate : 0);

  if (customers < c.minCustomers) {
    return {
      promote: false,
      reason: `insufficient-customers: ${customers}/${c.minCustomers}`,
      recipeFingerprint: fingerprint,
    };
  }
  if (occurrences < c.minOccurrences) {
    return {
      promote: false,
      reason: `insufficient-occurrences: ${occurrences}/${c.minOccurrences}`,
      recipeFingerprint: fingerprint,
    };
  }
  if (winRate < c.minWinRate) {
    return {
      promote: false,
      reason: `low-win-rate: ${winRate.toFixed(2)}<${c.minWinRate}`,
      recipeFingerprint: fingerprint,
    };
  }
  if (fpRate > c.maxFalsePositives) {
    return {
      promote: false,
      reason: `high-false-positive-rate: ${fpRate.toFixed(3)}>${c.maxFalsePositives}`,
      recipeFingerprint: fingerprint,
    };
  }

  return {
    promote: true,
    reason: `promoted: ${customers} customers, ${occurrences} occurrences, ${(winRate * 100).toFixed(0)}% win rate`,
    recipeFingerprint: fingerprint,
  };
}

// ---------------------------------------------------------------------------
// Build a shipped rule
// ---------------------------------------------------------------------------

/**
 * Escape a string so it is safe to embed verbatim inside a regex source.
 * Used to derive an applicability gate from `recipe.before` when the
 * recipe doesn't carry its own pattern.
 */
function escapeForRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a ShippedRule JSON object from a promoted recipe. The result is the
 * exact in-memory shape `src/core/shipped-rules.js` validates and applies.
 * Default transform: literal-text regex-replace of `before`→`after`. Override
 * via opts.{find,replace,flags,pattern,description,id,promotedAt}.
 *
 * @returns {object} ShippedRule
 */
function buildShippedRuleFromRecipe(recipe, opts = {}) {
  if (!recipe || typeof recipe !== 'object') {
    throw new TypeError('buildShippedRuleFromRecipe: recipe must be an object');
  }
  if (typeof recipe.ruleKey !== 'string' || !recipe.ruleKey) {
    throw new TypeError('buildShippedRuleFromRecipe: recipe.ruleKey required');
  }
  if (typeof recipe.module !== 'string' || !recipe.module) {
    throw new TypeError('buildShippedRuleFromRecipe: recipe.module required');
  }
  if (typeof recipe.before !== 'string' || typeof recipe.after !== 'string') {
    throw new TypeError('buildShippedRuleFromRecipe: recipe.before/after required');
  }

  const find    = opts.find    || escapeForRegex(recipe.before);
  const replace = opts.replace != null ? opts.replace : recipe.after;
  const flags   = opts.flags   || 'g';
  const pattern = opts.pattern || escapeForRegex(recipe.before);

  const id = opts.id || `promoted-${recipeFingerprint(recipe)}`;

  const promotedAt = opts.promotedAt || new Date(0).toISOString();
  // 0 ⇒ epoch sentinel; the CLI overwrites with the run time. Choosing a
  // deterministic default keeps `serializeShippedRule` reproducible.

  const customers = Number(opts.customers || recipe.customers || 0);
  const winRate   = Number(opts.winRate != null ? opts.winRate : recipe.winRate || 0);

  const description = opts.description ||
    `Auto-promoted from cross-customer recipe corpus. ` +
    `${customers} customer install(s) applied this fix; ` +
    `${(winRate * 100).toFixed(0)}% gate-pass + test-green rate.`;

  return {
    id,
    ruleKey: recipe.ruleKey,
    module: recipe.module,
    pattern,
    transform: {
      kind: 'regex-replace',
      find,
      replace,
      flags,
    },
    promotedAt,
    promotedFromCustomers: customers,
    winRate,
    description,
    schemaVersion: SHIPPED_RULE_SCHEMA_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Serialisation — deterministic JSON for the seed files
// ---------------------------------------------------------------------------

const SHIPPED_RULE_KEY_ORDER = [
  'id',
  'ruleKey',
  'module',
  'pattern',
  'transform',
  'promotedAt',
  'promotedFromCustomers',
  'winRate',
  'description',
  'schemaVersion',
];

const TRANSFORM_KEY_ORDER = ['kind', 'find', 'replace', 'flags'];

/**
 * Deterministic, key-ordered JSON serialisation of a ShippedRule. The
 * output ends with a single trailing newline — POSIX-friendly for the
 * seed-rules directory.
 *
 * Same input ⇒ same output. Diffs in git are meaningful.
 *
 * @param {object} rule
 * @returns {string}
 */
function serializeShippedRule(rule) {
  if (!rule || typeof rule !== 'object') {
    throw new TypeError('serializeShippedRule: rule must be an object');
  }
  const out = {};
  for (const k of SHIPPED_RULE_KEY_ORDER) {
    if (rule[k] === undefined) continue;
    if (k === 'transform' && rule.transform && typeof rule.transform === 'object') {
      const t = {};
      for (const tk of TRANSFORM_KEY_ORDER) {
        if (rule.transform[tk] === undefined) continue;
        t[tk] = rule.transform[tk];
      }
      out.transform = t;
      continue;
    }
    out[k] = rule[k];
  }
  return JSON.stringify(out, null, 2) + '\n';
}

// ---------------------------------------------------------------------------

module.exports = {
  assessPromotionCandidate,
  buildShippedRuleFromRecipe,
  serializeShippedRule,
  recipeFingerprint,
  // exported for tooling
  DEFAULT_CRITERIA,
  SHIPPED_RULE_SCHEMA_VERSION,
};
