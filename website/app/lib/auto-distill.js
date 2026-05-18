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

// Remote-store adapter is loaded lazily / defensively so a missing module
// (during partial cherry-picks, unbundled CLI use, etc.) never breaks the
// flywheel. The remote store is best-effort; the local JSON store is the
// authoritative fallback.
let _remote = null;
function getRemote() {
  if (_remote !== null) return _remote;
  try {
    _remote = require('./recipe-store-remote');
  } catch {
    _remote = {
      loadRemoteRecipes: async () => null,
      saveRemoteRecipe:  async () => false,
      isRemoteConfigured: () => false,
    };
  }
  return _remote;
}

// In-memory cache of the remote store, keyed by URL. Avoids hammering the
// HTTP endpoint on every `findMatchingRecipe` call. Cache TTL is per-process
// (no expiry within a single CI run — fresh runner = fresh cache).
const _remoteCache = new Map();
const REMOTE_CACHE_TTL_MS = 30_000;

function readRemoteCache(url) {
  const entry = _remoteCache.get(url);
  if (!entry) return null;
  if (Date.now() - entry.at > REMOTE_CACHE_TTL_MS) {
    _remoteCache.delete(url);
    return null;
  }
  return entry.recipes;
}

function writeRemoteCache(url, recipes) {
  _remoteCache.set(url, { at: Date.now(), recipes });
}

function clearRemoteCache() {
  _remoteCache.clear();
}

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
    // Privacy opt-out: customer sets GATETEST_DISTILL_OPT_OUT=1 in CI to keep
    // their fix snippets out of the shared recipe store. Documented in the
    // privacy policy under section 2.4 (Distilled Fix Recipes).
    const optOutEnv = (arguments[0] && arguments[0].env) || process.env;
    const optOutFlag = optOutEnv && optOutEnv.GATETEST_DISTILL_OPT_OUT;
    if (optOutFlag === '1' || optOutFlag === 'true' || optOutFlag === 'TRUE') {
      return { written: false, reason: 'opt-out' };
    }

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

    // Best-effort: also push to the remote store if one is configured.
    // Fire-and-forget — the local write is the authoritative success signal.
    try {
      const remote = getRemote();
      const sourceEnv = (arguments[0] && arguments[0].env) || process.env;
      const url = (arguments[0] && arguments[0].remoteStoreUrl) ||
        (sourceEnv && sourceEnv[remote.ENV_URL_KEY || 'GATETEST_RECIPE_STORE_URL']);
      if (url && remote && typeof remote.saveRemoteRecipe === 'function') {
        // Bust the cache so the next read picks up our new recipe.
        clearRemoteCache();
        const p = remote.saveRemoteRecipe(url, recipe, {
          token: arguments[0] && arguments[0].remoteStoreToken,
          transport: arguments[0] && arguments[0].transport,
          env: sourceEnv,
        });
        if (p && typeof p.catch === 'function') {
          p.catch(() => { /* best-effort */ });
        }
      }
    } catch { /* best-effort */ }

    return { written: true, recipe };
  } catch (err) {
    return { written: false, reason: `error:${err && err.message ? err.message : 'unknown'}` };
  }
}

/**
 * Search a list of recipes for one whose (ruleKey, module, fileExt) match
 * AND whose `before` snippet is present in `content`. Returns the first hit.
 *
 * @param {Array<object>} recipes
 * @param {object} criteria
 */
function _searchRecipes(recipes, { ruleKey, module: mod, fileExt, content, includeLowConfidence }) {
  if (!Array.isArray(recipes)) return null;
  for (const r of recipes) {
    if (!r || typeof r !== 'object') continue;
    if (r.ruleKey !== ruleKey) continue;
    if (r.module !== mod) continue;
    if (r.fileExt !== fileExt) continue;
    if (!includeLowConfidence && r.confidence !== 'stable') continue;
    if (!r.before || typeof r.before !== 'string') continue;
    if (typeof content === 'string' && !content.includes(r.before)) continue;
    return r;
  }
  return null;
}

/**
 * Look up the first matching recipe by ruleKey + module + fileExt whose
 * `before` snippet appears in the given content.
 *
 * Consults the REMOTE store first (when configured via
 * `GATETEST_RECIPE_STORE_URL` or `opts.remoteStoreUrl`), falling back to the
 * LOCAL JSON store on miss or remote failure. Remote results are cached
 * in-memory per-URL to avoid re-fetching on every call within a CI run.
 *
 * NEVER throws.
 *
 * @param {object} opts
 * @param {string} opts.ruleKey
 * @param {string} opts.module
 * @param {string} opts.fileExt
 * @param {string} opts.content
 * @param {string} opts.recipeStorePath
 * @param {boolean} [opts.includeLowConfidence] — default true
 * @param {string}  [opts.remoteStoreUrl]       — override env URL
 * @param {string}  [opts.remoteStoreToken]     — override env token
 * @param {object}  [opts.transport]            — http transport (for tests)
 * @param {object}  [opts.env]                  — env source (for tests)
 * @returns {Promise<object|null>}
 */
async function findMatchingRecipe(opts) {
  try {
    if (!opts || typeof opts !== 'object') return null;
    const {
      ruleKey, module: mod, fileExt, content, recipeStorePath,
      includeLowConfidence = true,
      remoteStoreUrl, remoteStoreToken, transport, env,
    } = opts;
    if (typeof content !== 'string') return null;

    const criteria = { ruleKey, module: mod, fileExt, content, includeLowConfidence };

    // --- Layer 1: REMOTE store (when configured) ---------------------------
    const remote = getRemote();
    const sourceEnv = env || process.env;
    const url = remoteStoreUrl || (sourceEnv && sourceEnv[remote.ENV_URL_KEY || 'GATETEST_RECIPE_STORE_URL']);
    if (url && remote && typeof remote.loadRemoteRecipes === 'function') {
      let cached = readRemoteCache(url);
      if (cached === null) {
        const fetched = await remote.loadRemoteRecipes(url, {
          token: remoteStoreToken,
          transport,
          env: sourceEnv,
        });
        if (fetched && Array.isArray(fetched.recipes)) {
          cached = fetched.recipes;
          writeRemoteCache(url, cached);
        }
      }
      if (cached) {
        const hit = _searchRecipes(cached, criteria);
        if (hit) return hit;
      }
    }

    // --- Layer 2: LOCAL JSON store -----------------------------------------
    if (!recipeStorePath) return null;
    const store = loadStore(recipeStorePath);
    return _searchRecipes(store.recipes, criteria);
  } catch {
    return null;
  }
}

/**
 * SYNCHRONOUS variant — local store only. Useful for tests and callers that
 * cannot wait on a network round-trip. The remote-first variant is the
 * default `findMatchingRecipe` export.
 */
function findMatchingRecipeLocal({ ruleKey, module: mod, fileExt, content, recipeStorePath, includeLowConfidence = true }) {
  try {
    if (!recipeStorePath || typeof content !== 'string') return null;
    const store = loadStore(recipeStorePath);
    return _searchRecipes(store.recipes, { ruleKey, module: mod, fileExt, content, includeLowConfidence });
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
  findMatchingRecipe,            // async — remote-first, local fallback
  findMatchingRecipeLocal,       // sync — local only
  applyRecipe,
  incrementApplicationCount,
  clearRemoteCache,
  // exposed for tests
  isTemplatey,
  diffChangedLines,
  countVaryingIdentifiers,
  loadStore,
  saveStore,
  recipeId,
};
