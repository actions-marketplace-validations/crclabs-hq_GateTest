/**
 * Try-fix — the flywheel orchestrator.
 *
 * Tries each fix layer in order, returns the first successful patch:
 *
 *   1. AST           — Babel-based deterministic transforms      (zero API cost)
 *   2. Rule          — regex-based fast path                     (zero API cost)
 *   3. Recipe        — per-customer learned recipe lookup        (zero API cost)
 *   4. ShippedRules  — cross-customer promoted deterministic     (zero API cost)
 *   5. Claude        — full LLM call                             (PAID — only if enabled)
 *
 * Architecture intent: most fixes are served by layers 1-4 (free). Only novel
 * patterns hit Claude (paid). When Claude succeeds AND the diff is templatey,
 * `auto-distill` adds a recipe — so the next time the same shape appears, the
 * recipe layer wins. When the SAME recipe shape wins across enough different
 * customers, `recipe-promotion` promotes it to a shipped rule loaded into
 * every install (see `src/core/shipped-rules.js`). Over time, the Claude
 * ratio drops to single digits.
 *
 * CONTRACT:
 *   - Each layer runs inside its own try/catch — a crash in one layer falls
 *     through to the next; the whole orchestrator never throws.
 *   - Each layer is bounded by a 30s soft timeout — a hanging layer falls
 *     through. The 30s ceiling is per-LAYER, not per-call.
 *   - Telemetry is recorded for EVERY attempt regardless of outcome.
 *   - A "patched" result that equals the original counts as a NO-OP and is
 *     rejected (layer returns null, orchestrator falls through).
 *
 * Safe to call from server routes (Vercel serverless) AND from CLI contexts.
 */

const fs = require('fs');
const path = require('path');

const LAYER_TIMEOUT_MS = 30_000;

// Anthropic pricing (approximate, USD per 1K tokens) — used for telemetry cost
// roll-up. Treat as best-effort: the bill of record is the Anthropic console.
const CLAUDE_PRICING = {
  // claude-sonnet-4-6 — sonnet pricing as of 2026-04
  'claude-sonnet-4-6':       { inputPer1K: 0.003, outputPer1K: 0.015 },
  'claude-sonnet-4-20250514':{ inputPer1K: 0.003, outputPer1K: 0.015 },
  default:                   { inputPer1K: 0.003, outputPer1K: 0.015 },
};

// Lazy-require so the orchestrator loads even if optional deps (babel) aren't
// installed in some context.
function safeRequire(modName) {
  try {
    return require(modName);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowMs() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  const [s, ns] = process.hrtime();
  return s * 1000 + ns / 1e6;
}

function withTimeout(fn, ms) {
  // Run a sync-or-async function, reject if it doesn't resolve in `ms`.
  return new Promise((resolve, reject) => {
    let settled = false;
    const t = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`layer-timeout:${ms}ms`));
    }, ms);
    Promise.resolve()
      .then(fn)
      .then((val) => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        resolve(val);
      })
      .catch((err) => {
        if (settled) return;
        settled = true;
        clearTimeout(t);
        reject(err);
      });
  });
}

function fileExtOf(filePath) {
  if (!filePath) return '';
  const dot = filePath.lastIndexOf('.');
  return dot >= 0 ? filePath.slice(dot).toLowerCase() : '';
}

function priceCost({ model, usage }) {
  if (!usage) return 0;
  const tier = CLAUDE_PRICING[model] || CLAUDE_PRICING.default;
  const inTok = Number(usage.input_tokens || 0);
  const outTok = Number(usage.output_tokens || 0);
  return (inTok / 1000) * tier.inputPer1K + (outTok / 1000) * tier.outputPer1K;
}

// ---------------------------------------------------------------------------
// Telemetry shim — telemetry MUST NEVER break the fix path
// ---------------------------------------------------------------------------

function recordSafely(telemetryFn, entry, telemetryPath) {
  try {
    if (typeof telemetryFn === 'function') {
      telemetryFn(entry, telemetryPath ? { path: telemetryPath } : undefined);
    }
  } catch {
    // swallow — telemetry is a side-channel
  }
}

// ---------------------------------------------------------------------------
// Layer 1: AST
// ---------------------------------------------------------------------------

async function runAstLayer(issue) {
  const astFixer = safeRequire('./ast-fixer');
  if (!astFixer || typeof astFixer.tryAstFix !== 'function') return null;
  if (typeof astFixer.isJsOrTs !== 'function' || !astFixer.isJsOrTs(issue.file)) return null;
  if (typeof issue.content !== 'string') return null;

  // tryAstFix takes (content, filePath, issues[]) — synchronous, returns string|null
  const issueStrings = [issue.message || issue.ruleKey || ''].filter(Boolean);
  if (issueStrings.length === 0) return null;
  return astFixer.tryAstFix(issue.content, issue.file, issueStrings);
}

// ---------------------------------------------------------------------------
// Layer 2: Rule
// ---------------------------------------------------------------------------

async function runRuleLayer(issue) {
  const ruleFixer = safeRequire('./rule-based-fixer');
  if (!ruleFixer) return null;
  if (typeof issue.content !== 'string') return null;
  const tryFn = ruleFixer.tryRuleBasedFix || ruleFixer.tryFix;
  if (typeof tryFn !== 'function') return null;

  const issueStrings = [issue.message || issue.ruleKey || ''].filter(Boolean);
  if (issueStrings.length === 0) return null;
  return tryFn(issue.content, issue.file, issueStrings);
}

// ---------------------------------------------------------------------------
// Layer 3: Recipe (local JSON store)
// ---------------------------------------------------------------------------

async function runRecipeLayer(issue, opts) {
  const distill = safeRequire('./auto-distill');
  if (!distill || typeof distill.findMatchingRecipe !== 'function') return null;
  if (typeof issue.content !== 'string') return null;
  if (!opts.recipeStorePath) return null;

  // findMatchingRecipe is async (remote-first, local fallback). It may also
  // be a sync function in older builds — handle both via await.
  let recipe;
  try {
    recipe = await distill.findMatchingRecipe({
      ruleKey: issue.ruleKey || '',
      module: issue.module || '',
      fileExt: fileExtOf(issue.file),
      content: issue.content,
      recipeStorePath: opts.recipeStorePath,
      remoteStoreUrl: opts.remoteStoreUrl,
      remoteStoreToken: opts.remoteStoreToken,
    });
  } catch {
    recipe = null;
  }
  if (!recipe) return null;

  const patched = distill.applyRecipe(issue.content, recipe);
  if (!patched || patched === issue.content) return null;

  // Bump usage counter — promotes low → stable at 3.
  try { distill.incrementApplicationCount(recipe.id, opts.recipeStorePath); } catch { /* non-fatal */ }
  return { patched, recipeId: recipe.id };
}

// ---------------------------------------------------------------------------
// Layer 4: ShippedRules — cross-customer-promoted deterministic transforms
//
// Loaded from `src/core/shipped-rules/*.json`. These are recipes that won
// across enough different customer installs to graduate from per-customer
// learning to a baked-in product capability. Fires BEFORE Claude because
// these have high-confidence evidence behind them (≥90% win rate across
// ≥3 customers, ≥5 occurrences) but AFTER local recipes because the
// per-customer recipe layer is faster (in-memory) and customer-specific.
// ---------------------------------------------------------------------------

// Module-level cache so we don't re-read the disk for every fix attempt.
// The cache key is `rulesDir` so callers can swap directories in tests.
const _shippedRulesCache = new Map();

function loadShippedRulesCached(rulesDir) {
  const key = rulesDir || '__default__';
  const hit = _shippedRulesCache.get(key);
  if (hit) return hit;
  let loader;
  try {
    // Live in the CLI package — load via a path that survives both the
    // Next.js bundler (server-side) and node-direct require from tests.
    loader = require('../../../src/core/shipped-rules');
  } catch {
    loader = null;
  }
  if (!loader || typeof loader.loadShippedRules !== 'function') {
    const empty = { rules: [], loadedFrom: [], _impl: null };
    _shippedRulesCache.set(key, empty);
    return empty;
  }
  const out = loader.loadShippedRules(rulesDir ? { rulesDir } : undefined);
  const wrapped = {
    rules: Array.isArray(out && out.rules) ? out.rules : [],
    loadedFrom: Array.isArray(out && out.loadedFrom) ? out.loadedFrom : [],
    _impl: loader,
  };
  _shippedRulesCache.set(key, wrapped);
  return wrapped;
}

function _resetShippedRulesCache() { _shippedRulesCache.clear(); }

async function runShippedRulesLayer(issue, opts) {
  if (opts && opts.disableShippedRules) return null;
  if (typeof issue.content !== 'string') return null;
  if (typeof issue.ruleKey !== 'string' || typeof issue.module !== 'string') return null;

  const cache = loadShippedRulesCached(opts && opts.shippedRulesDir);
  if (!cache._impl || cache.rules.length === 0) return null;

  const rule = cache._impl.findShippedRule(cache.rules, {
    ruleKey: issue.ruleKey,
    module: issue.module,
  });
  if (!rule) return null;

  const result = cache._impl.applyShippedRule(rule, issue.content);
  if (!result || !result.applied) return null;
  return { patched: result.patched, shippedRuleId: rule.id };
}

// ---------------------------------------------------------------------------
// Layer 5: Claude
// ---------------------------------------------------------------------------

const CLAUDE_PROMPT_PREFIX = `You are a code-fixer for GateTest. You receive a single finding and a file. Return ONLY the complete fixed file content. No explanation. No markdown fences. No prose.

If the finding cannot be fixed safely, return the file UNCHANGED.

Rules:
- Fix the root cause, not the symptom.
- Do not introduce console.log/debugger/TODO/FIXME in library code.
- Preserve all unrelated code byte-for-byte.

`;

function buildClaudePrompt(issue) {
  return CLAUDE_PROMPT_PREFIX +
    `FILE: ${issue.file}\n` +
    (issue.line ? `LINE: ${issue.line}\n` : '') +
    `MODULE: ${issue.module}\n` +
    `RULE: ${issue.ruleKey}\n` +
    `SEVERITY: ${issue.severity}\n` +
    `MESSAGE: ${issue.message}\n\n` +
    `CURRENT FILE CONTENT:\n` +
    issue.content;
}

function stripFences(s) {
  if (typeof s !== 'string') return s;
  let out = s.trim();
  if (out.startsWith('```')) {
    out = out.replace(/^```[a-zA-Z0-9+_-]*\n?/, '');
    if (out.endsWith('```')) out = out.slice(0, -3);
    out = out.trim();
  }
  return out;
}

async function runClaudeLayer(issue, opts) {
  if (!opts.enableClaude) return { skipped: true, reason: 'disabled' };
  if (!opts.anthropicApiKey) return { skipped: true, reason: 'no-api-key' };
  if (typeof issue.content !== 'string') return null;

  const model = opts.claudeModel || 'claude-sonnet-4-6';
  const fetchFn = opts.fetch || (typeof globalThis.fetch === 'function' ? globalThis.fetch : null);
  if (!fetchFn) return { skipped: true, reason: 'no-fetch' };

  const prompt = buildClaudePrompt(issue);
  const body = JSON.stringify({
    model,
    max_tokens: 8192,
    messages: [{ role: 'user', content: prompt }],
  });

  const res = await fetchFn('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': opts.anthropicApiKey,
    },
    body,
  });

  let data;
  try {
    data = await res.json();
  } catch {
    return null;
  }
  if (!data || !Array.isArray(data.content) || data.content.length === 0) return null;
  const text = data.content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
  const cleaned = stripFences(text);
  if (!cleaned) return null;

  const costUsd = priceCost({ model, usage: data.usage });
  return { patched: cleaned, costUsd, model };
}

// ---------------------------------------------------------------------------
// Layer runner — wraps a layer with timeout, error handling, telemetry, no-op check
// ---------------------------------------------------------------------------

async function runLayer({ name, fn, issue, opts, telemetryFn, telemetryPath, extraTelemetry }) {
  const start = nowMs();
  let raw;
  let err;
  try {
    raw = await withTimeout(() => fn(issue, opts), LAYER_TIMEOUT_MS);
  } catch (e) {
    err = e;
  }
  const durationMs = nowMs() - start;

  // Normalise the layer result shape.
  let patched = null;
  let costUsd = 0;
  let extra = {};
  if (err) {
    // crashed — fall through
  } else if (raw == null) {
    // explicit null/undefined — fall through
  } else if (typeof raw === 'string') {
    patched = raw;
  } else if (typeof raw === 'object') {
    if (raw.skipped) {
      // Claude was disabled / no key / no fetch — record reason but no success.
      recordSafely(telemetryFn, {
        layer: name,
        success: false,
        issueRuleKey: issue.ruleKey,
        module: issue.module,
        durationMs,
        costUsd: 0,
        reason: raw.reason,
        ...extraTelemetry,
      }, telemetryPath);
      return { ok: false, skipped: true, reason: raw.reason };
    }
    if (typeof raw.patched === 'string') patched = raw.patched;
    if (Number.isFinite(raw.costUsd)) costUsd = raw.costUsd;
    extra = raw;
  }

  // No-op rejection: a layer that returns the same content as the input is NOT a fix.
  const isNoOp = patched != null && patched === issue.content;
  const success = patched != null && !isNoOp;

  recordSafely(telemetryFn, {
    layer: name,
    success,
    issueRuleKey: issue.ruleKey,
    module: issue.module,
    durationMs,
    costUsd,
    reason: err ? `error:${err.message}` : (isNoOp ? 'no-op' : (success ? 'ok' : 'miss')),
    model: extra.model,
    fileExt: fileExtOf(issue.file),
    ...extraTelemetry,
  }, telemetryPath);

  if (!success) return { ok: false };

  return { ok: true, patched, durationMs, costUsd, extra };
}

// ---------------------------------------------------------------------------
// Public: tryFix
// ---------------------------------------------------------------------------

/**
 * Try each fix layer in order, return the first successful patch.
 *
 * @param {object} issue                — the finding to fix
 * @param {string} issue.file           — repo-relative path (used by AST/extension)
 * @param {string} issue.content        — current file content
 * @param {string} [issue.severity]
 * @param {string} issue.ruleKey
 * @param {string} issue.module
 * @param {string} [issue.message]
 * @param {number} [issue.line]
 * @param {object} [opts]
 * @param {boolean} [opts.enableClaude=false]
 * @param {string}  [opts.anthropicApiKey]
 * @param {string}  [opts.claudeModel='claude-sonnet-4-6']
 * @param {string}  [opts.recipeStorePath]
 * @param {function} [opts.fetch]       — override globalThis.fetch (tests)
 * @param {function} [opts.recordFixAttempt] — override telemetry sink (tests)
 * @param {string}   [opts.telemetryPath]    — override JSONL path (tests)
 * @param {boolean}  [opts.autoDistill=true] — write a recipe on Claude success
 * @param {object}   [opts.layerOverrides]   — for tests: { ast, rule, recipe, claude }
 * @returns {Promise<object>}
 */
async function tryFix(issue, opts = {}) {
  if (!issue || typeof issue !== 'object') {
    return { layer: null, patched: null, reason: 'no-issue' };
  }
  if (typeof issue.content !== 'string') {
    return { layer: null, patched: null, reason: 'no-content' };
  }

  // Telemetry sink — default to fix-telemetry's recordFixAttempt; tests can
  // override via opts.recordFixAttempt.
  let telemetryFn = opts.recordFixAttempt;
  if (!telemetryFn) {
    const t = safeRequire('./fix-telemetry');
    telemetryFn = t && t.recordFixAttempt;
  }
  const telemetryPath = opts.telemetryPath;

  // Per-layer overrides for tests (e.g. mock a crashing AST layer).
  const overrides = opts.layerOverrides || {};

  // -- Layer 1: AST --------------------------------------------------------
  const astResult = await runLayer({
    name: 'ast',
    fn: overrides.ast || runAstLayer,
    issue,
    opts,
    telemetryFn,
    telemetryPath,
  });
  if (astResult.ok) {
    return {
      layer: 'ast',
      patched: astResult.patched,
      durationMs: astResult.durationMs,
      cost: 0,
    };
  }

  // -- Layer 2: Rule -------------------------------------------------------
  const ruleResult = await runLayer({
    name: 'rule',
    fn: overrides.rule || runRuleLayer,
    issue,
    opts,
    telemetryFn,
    telemetryPath,
  });
  if (ruleResult.ok) {
    return {
      layer: 'rule',
      patched: ruleResult.patched,
      durationMs: ruleResult.durationMs,
      cost: 0,
    };
  }

  // -- Layer 3: Recipe -----------------------------------------------------
  const recipeResult = await runLayer({
    name: 'recipe',
    fn: overrides.recipe || runRecipeLayer,
    issue,
    opts,
    telemetryFn,
    telemetryPath,
  });
  if (recipeResult.ok) {
    return {
      layer: 'recipe',
      patched: recipeResult.patched,
      recipeId: recipeResult.extra && recipeResult.extra.recipeId,
      durationMs: recipeResult.durationMs,
      cost: 0,
    };
  }

  // -- Layer 4: ShippedRules — cross-customer-promoted deterministic ------
  const shippedResult = await runLayer({
    name: 'shipped',
    fn: overrides.shipped || runShippedRulesLayer,
    issue,
    opts,
    telemetryFn,
    telemetryPath,
  });
  if (shippedResult.ok) {
    return {
      layer: 'shipped',
      patched: shippedResult.patched,
      shippedRuleId: shippedResult.extra && shippedResult.extra.shippedRuleId,
      durationMs: shippedResult.durationMs,
      cost: 0,
    };
  }

  // -- Layer 5: Claude (only if enabled + key present) --------------------
  if (!opts.enableClaude || !opts.anthropicApiKey) {
    return {
      layer: null,
      patched: null,
      reason: !opts.enableClaude ? 'claude-disabled' : 'no-api-key',
    };
  }

  const claudeResult = await runLayer({
    name: 'claude',
    fn: overrides.claude || runClaudeLayer,
    issue,
    opts,
    telemetryFn,
    telemetryPath,
  });
  if (claudeResult.ok) {
    const model = (claudeResult.extra && claudeResult.extra.model) || opts.claudeModel || 'claude-sonnet-4-6';
    // Best-effort auto-distill: write a recipe so the next time this shape
    // shows up, the recipe layer (free) wins instead of Claude (paid).
    if (opts.autoDistill !== false && opts.recipeStorePath) {
      try {
        const distill = safeRequire('./auto-distill');
        if (distill && typeof distill.distillClaudeFix === 'function') {
          distill.distillClaudeFix({
            issue: { ruleKey: issue.ruleKey, module: issue.module, file: issue.file },
            originalContent: issue.content,
            patchedContent: claudeResult.patched,
            recipeStorePath: opts.recipeStorePath,
            originalModel: model,
          });
        }
      } catch { /* non-fatal */ }
    }
    return {
      layer: 'claude',
      patched: claudeResult.patched,
      durationMs: claudeResult.durationMs,
      costUsd: claudeResult.costUsd,
      model,
    };
  }

  return { layer: null, patched: null, reason: 'no-layer-matched' };
}

// ---------------------------------------------------------------------------

module.exports = {
  tryFix,
  // exposed for tests
  _runAstLayer: runAstLayer,
  _runRuleLayer: runRuleLayer,
  _runRecipeLayer: runRecipeLayer,
  _runShippedRulesLayer: runShippedRulesLayer,
  _runClaudeLayer: runClaudeLayer,
  _resetShippedRulesCache,
  _withTimeout: withTimeout,
  _priceCost: priceCost,
  _stripFences: stripFences,
  LAYER_TIMEOUT_MS,
};
