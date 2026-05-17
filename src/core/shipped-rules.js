/**
 * shipped-rules — loader for cross-customer-promoted fix rules.
 *
 * Architectural role: when the SAME recipe shape wins on enough different
 * customer installs, it gets promoted from "per-customer learned recipe"
 * (`auto-distill.js`) to a "shipped deterministic rule" baked into every
 * GateTest install. The product gets smarter without per-customer config.
 *
 * Shipped rules live as static JSON files under `src/shipped-rules/*.json`.
 * Each file declares a single rule. The loader merges every JSON it can read,
 * silently skipping malformed files (a broken rule file MUST NEVER block the
 * fix path — recipe layer falls through to Claude anyway).
 *
 * RULE SCHEMA (v1):
 *   {
 *     "id":         "stable-12-char-hash",
 *     "ruleKey":    "tls-security:js-reject-unauthorized",
 *     "module":     "tlsSecurity",
 *     "pattern":    "rejectUnauthorized:\\s*false",       // OPTIONAL: applicability gate (regex)
 *     "transform": {
 *       "kind":     "regex-replace",
 *       "find":     "rejectUnauthorized:\\s*false",
 *       "replace":  "rejectUnauthorized: true",
 *       "flags":    "g"                                    // optional, default 'g'
 *     },
 *     "promotedAt":            "2026-05-17T00:00:00Z",
 *     "promotedFromCustomers": 5,
 *     "winRate":               0.94,
 *     "description":           "Flip rejectUnauthorized: false to true",
 *     "schemaVersion": 1
 *   }
 *
 * Required fields: id, ruleKey, module, transform.kind, transform.find,
 * transform.replace, schemaVersion. Everything else is metadata for the
 * promotion CLI / admin dashboard.
 *
 * The loader is sync (rules are static disk reads at startup). Apply is sync.
 * No npm deps — only `fs` + `path`.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SUPPORTED_SCHEMA_VERSIONS = new Set([1]);
const SUPPORTED_TRANSFORM_KINDS = new Set(['regex-replace']);
const DEFAULT_RULES_DIR = path.join(__dirname, '..', 'shipped-rules');

// stderr-only warning helper — never pollutes stdout, never throws.
function warn(msg) {
  try {
    process.stderr.write(`[shipped-rules] ${msg}\n`);
  } catch {
    /* swallow */
  }
}

/**
 * Validate a parsed shipped-rule object. Returns true if structurally sound,
 * false otherwise (logs why). Never throws.
 */
function validateShippedRule(rule) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return false;
  if (typeof rule.id !== 'string' || !rule.id) return false;
  if (typeof rule.ruleKey !== 'string' || !rule.ruleKey) return false;
  if (typeof rule.module !== 'string' || !rule.module) return false;
  if (!SUPPORTED_SCHEMA_VERSIONS.has(rule.schemaVersion)) return false;
  if (!rule.transform || typeof rule.transform !== 'object') return false;
  if (!SUPPORTED_TRANSFORM_KINDS.has(rule.transform.kind)) return false;
  if (typeof rule.transform.find !== 'string' || !rule.transform.find) return false;
  if (typeof rule.transform.replace !== 'string') return false;
  // Defensive: regex must compile.
  try {
    // eslint-disable-next-line no-new
    new RegExp(rule.transform.find, rule.transform.flags || 'g');
  } catch {
    return false;
  }
  if (typeof rule.pattern === 'string') {
    try {
      // eslint-disable-next-line no-new
      new RegExp(rule.pattern);
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Load every shipped-rule JSON file from a directory. Malformed files are
 * silently skipped (warning logged to stderr). Missing directory → empty.
 *
 * @param {object} [opts]
 * @param {string} [opts.rulesDir]  defaults to `src/shipped-rules/`
 * @returns {{ rules: object[], loadedFrom: string[] }}
 */
function loadShippedRules(opts = {}) {
  const rulesDir = opts.rulesDir || DEFAULT_RULES_DIR;
  const out = { rules: [], loadedFrom: [] };

  let entries;
  try {
    if (!fs.existsSync(rulesDir)) return out;
    entries = fs.readdirSync(rulesDir);
  } catch (err) {
    warn(`cannot read rules dir ${rulesDir}: ${err && err.message}`);
    return out;
  }

  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const full = path.join(rulesDir, name);
    let raw;
    try {
      raw = fs.readFileSync(full, 'utf8');
    } catch (err) {
      warn(`cannot read ${name}: ${err && err.message}`);
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      warn(`malformed JSON in ${name}: ${err && err.message}`);
      continue;
    }
    // Each file holds ONE rule (start simple — group later if needed).
    if (!validateShippedRule(parsed)) {
      warn(`schema validation failed for ${name}`);
      continue;
    }
    out.rules.push(parsed);
    out.loadedFrom.push(full);
  }

  return out;
}

/**
 * Find the first shipped rule that matches a (ruleKey, module) pair. Returns
 * null when no rule matches.
 *
 * @param {Array<object>} rules
 * @param {object} criteria
 * @param {string} criteria.ruleKey
 * @param {string} criteria.module
 * @returns {object|null}
 */
function findShippedRule(rules, { ruleKey, module: mod }) {
  if (!Array.isArray(rules)) return null;
  if (typeof ruleKey !== 'string' || typeof mod !== 'string') return null;
  for (const r of rules) {
    if (!r || typeof r !== 'object') continue;
    if (r.ruleKey !== ruleKey) continue;
    if (r.module !== mod) continue;
    return r;
  }
  return null;
}

/**
 * Apply a shipped rule's transform to `content`. Returns
 *   { patched, applied: true }   when at least one substitution happened
 *   { patched: content, applied: false }  when nothing changed
 *   null                         when the rule is unusable / unsafe
 *
 * Honors the optional `rule.pattern` applicability gate — if `pattern` is
 * present and does NOT match content, the rule is skipped (returns
 * `applied: false`).
 */
function applyShippedRule(rule, content) {
  if (!rule || typeof rule !== 'object') return null;
  if (typeof content !== 'string') return null;
  if (!validateShippedRule(rule)) return null;

  // Applicability gate.
  if (typeof rule.pattern === 'string') {
    try {
      const gate = new RegExp(rule.pattern);
      if (!gate.test(content)) return { patched: content, applied: false };
    } catch {
      return null;
    }
  }

  let re;
  try {
    re = new RegExp(rule.transform.find, rule.transform.flags || 'g');
  } catch {
    return null;
  }
  // Reset state on a global regex before re-testing.
  re.lastIndex = 0;
  const patched = content.replace(re, rule.transform.replace);
  return { patched, applied: patched !== content };
}

module.exports = {
  loadShippedRules,
  findShippedRule,
  applyShippedRule,
  validateShippedRule,
  // exposed for tooling
  DEFAULT_RULES_DIR,
  SUPPORTED_SCHEMA_VERSIONS,
  SUPPORTED_TRANSFORM_KINDS,
};
