/**
 * Auto-distill — turns successful Claude fixes into reusable recipes.
 *
 * When Claude solves a finding and the diff is "templatey" (small, mostly
 * literal, at most one varying identifier), we record a recipe so that the
 * same shape can be replayed by the recipe layer next time — zero API cost.
 *
 * This module backs a LOCAL, file-based recipe store (JSON on disk). It
 * complements the Postgres-backed `fix-recipe-store.js` rather than replacing
 * it: the JSON store is for CLI contexts and the flywheel orchestrator, the
 * Postgres store is for the website's serverless route.
 *
 * SCHEMA (JSON file at `recipeStorePath`):
 *
 *   {
 *     "version": 1,
 *     "recipes": [
 *       {
 *         "id": "<sha256-prefix>",
 *         "ruleKey": "js-reject-unauthorized",
 *         "module": "tlsSecurity",
 *         "fileExt": ".js",
 *         "before": "<exact snippet that Claude replaced>",
 *         "after":  "<exact replacement>",
 *         "confidence": "low" | "stable",
 *         "applicationCount": 0,
 *         "provenance": {
 *           "originalModel": "claude-sonnet-4-6",
 *           "originalRuleKey": "js-reject-unauthorized",
 *           "createdAt": "2026-05-17T..Z",
 *           "lastAppliedAt": null
 *         }
 *       }
 *     ]
 *   }
 *
 * PROMOTION:
 *   - First time a recipe is distilled → confidence: "low".
 *   - applicationCount reaches 3 → confidence: "stable".
 *   - Promotion happens via `incrementApplicationCount(id, store)`.
 *
 * Concurrency: the store is a single JSON file rewritten on every write.
 * Reads are tolerant of missing / malformed files. This is enough for the
 * single-process CLI/serverless contexts we run in; not designed for many
 * concurrent writers.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Templatey-ness heuristic
// ---------------------------------------------------------------------------

const MAX_DIFF_LINES_FOR_TEMPLATE = 5;
const MAX_VARYING_IDENTIFIERS = 1;
const IDENTIFIER_RE = /[A-Za-z_$][A-Za-z0-9_$]*/g;

// JS/TS keywords + common identifiers that shouldn't count as "varying"
const COMMON_TOKENS = new Set([
  'true', 'false', 'null', 'undefined', 'NaN', 'Infinity',
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while',
  'try', 'catch', 'finally', 'throw', 'new', 'class', 'extends', 'super',
  'this', 'typeof', 'instanceof', 'in', 'of', 'do', 'switch', 'case', 'default',
  'break', 'continue', 'import', 'export', 'from', 'as', 'async', 'await',
  'yield', 'void', 'delete', 'static', 'public', 'private', 'protected',
  'interface', 'type', 'enum', 'namespace', 'declare', 'readonly', 'abstract',
  'string', 'number', 'boolean', 'object', 'any', 'unknown', 'never',
  'Promise', 'Array', 'Object', 'JSON', 'Math', 'Date', 'console', 'process',
  'require', 'module', 'exports', 'global', 'globalThis',
  // Python
  'def', 'pass', 'lambda', 'with', 'is', 'not', 'and', 'or', 'True', 'False', 'None',
  'self', 'cls', 'print',
  // booleans-in-config
  'rejectUnauthorized', 'strictSSL', 'httpOnly', 'secure', 'insecure',
]);

/**
 * Diff the before/after content and return ONLY the lines that changed.
 * Returns null if too many lines differ (not templatey).
 *
 * @param {string} before
 * @param {string} after
 * @returns {{ beforeLines: string[], afterLines: string[] } | null}
 */
function diffChangedLines(before, after) {
  if (typeof before !== 'string' || typeof after !== 'string') return null;
  if (before === after) return null;

  const bl = before.split('\n');
  const al = after.split('\n');

  // Compute the longest common prefix and suffix line-wise.
  let prefix = 0;
  const minLen = Math.min(bl.length, al.length);
  while (prefix < minLen && bl[prefix] === al[prefix]) prefix++;

  let suffix = 0;
  while (
    suffix < (bl.length - prefix) &&
    suffix < (al.length - prefix) &&
    bl[bl.length - 1 - suffix] === al[al.length - 1 - suffix]
  ) suffix++;

  const beforeLines = bl.slice(prefix, bl.length - suffix);
  const afterLines = al.slice(prefix, al.length - suffix);

  const changedTotal = beforeLines.length + afterLines.length;
  if (changedTotal === 0) return null;
  if (changedTotal > MAX_DIFF_LINES_FOR_TEMPLATE * 2) return null;
  if (beforeLines.length > MAX_DIFF_LINES_FOR_TEMPLATE) return null;
  if (afterLines.length > MAX_DIFF_LINES_FOR_TEMPLATE) return null;

  return { beforeLines, afterLines };
}

/**
 * Count distinct identifier-shaped tokens (excluding common keywords) that
 * differ between beforeLines and afterLines. A recipe is templatey if at most
 * `MAX_VARYING_IDENTIFIERS` such identifiers vary — the rest is literal.
 *
 * @returns {number}
 */
function countVaryingIdentifiers(beforeLines, afterLines) {
  const beforeText = beforeLines.join('\n');
  const afterText = afterLines.join('\n');

  const extract = (s) => {
    const seen = new Set();
    const matches = s.match(IDENTIFIER_RE) || [];
    for (const m of matches) {
      if (COMMON_TOKENS.has(m)) continue;
      seen.add(m);
    }
    return seen;
  };

  const before = extract(beforeText);
  const after = extract(afterText);

  // Identifiers that appear in one side but not the other are "varying".
  let varying = 0;
  for (const t of before) if (!after.has(t)) varying++;
  for (const t of after) if (!before.has(t)) varying++;
  return varying;
}

/**
 * Decide whether a diff is templatey — i.e. could plausibly apply to other
 * files. Templatey ⇒ candidate for a recipe.
 *
 * @param {string} before
 * @param {string} after
 * @returns {{ templatey: boolean, reason?: string, beforeSnippet?: string, afterSnippet?: string }}
 */
function isTemplatey(before, after) {
  const d = diffChangedLines(before, after);
  if (!d) return { templatey: false, reason: 'no-diff-or-too-large' };
  const varying = countVaryingIdentifiers(d.beforeLines, d.afterLines);
  if (varying > MAX_VARYING_IDENTIFIERS) {
    return { templatey: false, reason: `too-many-varying-identifiers:${varying}` };
  }
  return {
    templatey: true,
    beforeSnippet: d.beforeLines.join('\n'),
    afterSnippet: d.afterLines.join('\n'),
  };
}

// ---------------------------------------------------------------------------
// JSON store I/O
// ---------------------------------------------------------------------------

function loadStore(recipeStorePath) {
  if (!recipeStorePath) return { version: 1, recipes: [] };
  try {
    if (!fs.existsSync(recipeStorePath)) return { version: 1, recipes: [] };
    const raw = fs.readFileSync(recipeStorePath, 'utf8');
    if (!raw.trim()) return { version: 1, recipes: [] };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { version: 1, recipes: [] };
    if (!Array.isArray(parsed.recipes)) parsed.recipes = [];
    if (!parsed.version) parsed.version = 1;
    return parsed;
  } catch {
    return { version: 1, recipes: [] };
  }
}

function saveStore(recipeStorePath, store) {
  if (!recipeStorePath) return;
  fs.mkdirSync(path.dirname(recipeStorePath), { recursive: true });
  fs.writeFileSync(recipeStorePath, JSON.stringify(store, null, 2), 'utf8');
}

function recipeId({ ruleKey, module: mod, fileExt, before }) {
  return crypto
    .createHash('sha256')
    .update(`${ruleKey || ''}|${mod || ''}|${fileExt || ''}|${before || ''}`)
    .digest('hex')
    .slice(0, 16);
}

function fileExtOf(filePath) {
  if (!filePath) return '';
  const dot = filePath.lastIndexOf('.');
  return dot >= 0 ? filePath.slice(dot).toLowerCase() : '';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Inspect a successful Claude fix and write a recipe if the diff is templatey.
 *
 * Returns the written recipe (or the existing one if a match already lived in
 * the store), or `{ written: false, reason }` when the diff isn't templatey.
 *
 * NEVER throws — distillation is a best-effort side-channel.
 *
 * @param {object} opts
 * @param {object} opts.issue
 * @param {string} opts.issue.ruleKey
 * @param {string} opts.issue.module
 * @param {string} opts.issue.file
 * @param {string} opts.originalContent
 * @param {string} opts.patchedContent
 * @param {string} opts.recipeStorePath
 * @param {string} [opts.originalModel]
 * @returns {{ written: boolean, recipe?: object, reason?: string }}
 */
function distillClaudeFix({ issue, originalContent, patchedContent, recipeStorePath, originalModel }) {
  try {
    if (!issue || typeof issue !== 'object') return { written: false, reason: 'no-issue' };
    if (typeof originalContent !== 'string' || typeof patchedContent !== 'string') {
      return { written: false, reason: 'bad-content' };
    }
    if (!recipeStorePath) return { written: false, reason: 'no-store-path' };

    const verdict = isTemplatey(originalContent, patchedContent);
    if (!verdict.templatey) {
      return { written: false, reason: verdict.reason };
    }

    const fileExt = fileExtOf(issue.file);
    const ruleKey = issue.ruleKey || 'unknown';
    const mod = issue.module || 'unknown';

    const store = loadStore(recipeStorePath);
    const id = recipeId({ ruleKey, module: mod, fileExt, before: verdict.beforeSnippet });

    const existing = store.recipes.find(r => r.id === id);
    if (existing) {
      // Already known — don't duplicate, don't reset confidence.
      return { written: false, reason: 'duplicate', recipe: existing };
    }

    const recipe = {
      id,
      ruleKey,
      module: mod,
      fileExt,
      before: verdict.beforeSnippet,
      after: verdict.afterSnippet,
      confidence: 'low',
      applicationCount: 0,
      provenance: {
        originalModel: originalModel || null,
        originalRuleKey: ruleKey,
        createdAt: new Date().toISOString(),
        lastAppliedAt: null,
      },
    };

    store.recipes.push(recipe);
    saveStore(recipeStorePath, store);
    return { written: true, recipe };
  } catch (err) {
    return { written: false, reason: `error:${err && err.message ? err.message : 'unknown'}` };
  }
}

/**
 * Look up the first matching recipe by ruleKey + module + fileExt whose
 * `before` snippet appears in the given content.
 *
 * @param {object} opts
 * @param {string} opts.ruleKey
 * @param {string} opts.module
 * @param {string} opts.fileExt
 * @param {string} opts.content
 * @param {string} opts.recipeStorePath
 * @param {boolean} [opts.includeLowConfidence] — default true; flywheel
 *   orchestrator may pass false to require stable recipes only
 * @returns {object|null}
 */
function findMatchingRecipe({ ruleKey, module: mod, fileExt, content, recipeStorePath, includeLowConfidence = true }) {
  try {
    if (!recipeStorePath || typeof content !== 'string') return null;
    const store = loadStore(recipeStorePath);
    for (const r of store.recipes) {
      if (r.ruleKey !== ruleKey) continue;
      if (r.module !== mod) continue;
      if (r.fileExt !== fileExt) continue;
      if (!includeLowConfidence && r.confidence !== 'stable') continue;
      if (!r.before || !content.includes(r.before)) continue;
      return r;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Apply a recipe to content. Returns the patched content or null if the
 * `before` snippet isn't found.
 */
function applyRecipe(content, recipe) {
  if (typeof content !== 'string' || !recipe || typeof recipe.before !== 'string' || typeof recipe.after !== 'string') {
    return null;
  }
  if (!content.includes(recipe.before)) return null;
  return content.replace(recipe.before, recipe.after);
}

/**
 * Increment the application counter on a recipe and promote to "stable" once
 * the counter reaches 3. Never throws — promotion is best-effort.
 *
 * @param {string} recipeId
 * @param {string} recipeStorePath
 * @returns {object|null} the updated recipe, or null on failure
 */
function incrementApplicationCount(idOrRecipe, recipeStorePath) {
  try {
    if (!recipeStorePath) return null;
    const id = typeof idOrRecipe === 'string' ? idOrRecipe : (idOrRecipe && idOrRecipe.id);
    if (!id) return null;
    const store = loadStore(recipeStorePath);
    const recipe = store.recipes.find(r => r.id === id);
    if (!recipe) return null;
    recipe.applicationCount = (recipe.applicationCount || 0) + 1;
    if (!recipe.provenance) recipe.provenance = {};
    recipe.provenance.lastAppliedAt = new Date().toISOString();
    if (recipe.applicationCount >= 3 && recipe.confidence !== 'stable') {
      recipe.confidence = 'stable';
    }
    saveStore(recipeStorePath, store);
    return recipe;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------

module.exports = {
  distillClaudeFix,
  findMatchingRecipe,
  applyRecipe,
  incrementApplicationCount,
  // exposed for tests
  isTemplatey,
  diffChangedLines,
  countVaryingIdentifiers,
  loadStore,
  saveStore,
  recipeId,
};
