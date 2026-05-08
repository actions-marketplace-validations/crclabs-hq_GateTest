/**
 * Fix Recipe Store — learns from every Claude fix that passes the gate.
 *
 * Every time Claude produces a fix that clears the re-scan gate, we record
 * the transformation as a "recipe": a (module, finding_type, extension, diff)
 * tuple. On subsequent fix requests for the same (module, finding_type, ext)
 * pattern, we look up recorded recipes and apply the closest match — no API
 * call required.
 *
 * Follows the established store pattern: helpers accept a `sql` tagged-template
 * via dependency injection. Callers pass @neondatabase/serverless `neon(url)`.
 * Tests inject a fake-sql. Stateless. Serverless-safe. No Pool kept alive.
 *
 * Schema (Neon Postgres, idempotent CREATE TABLE IF NOT EXISTS):
 *
 *   fix_recipes (
 *     id              SERIAL PRIMARY KEY,
 *     module          TEXT NOT NULL,
 *     finding_type    TEXT NOT NULL,
 *     file_extension  TEXT NOT NULL,
 *     before_hash     TEXT NOT NULL,
 *     before_snippet  TEXT NOT NULL,   -- offending code, max 2KB
 *     after_snippet   TEXT NOT NULL,   -- fixed replacement, max 2KB
 *     usage_count     INTEGER NOT NULL DEFAULT 1,
 *     confidence      REAL    NOT NULL DEFAULT 0.5,
 *     created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 *     last_used_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
 *   )
 *
 * Privacy: no file paths, no repo names, no user identifiers.
 * Only anonymised code snippets (before/after) keyed by hash.
 */

const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Schema bootstrap (idempotent)
// ---------------------------------------------------------------------------

async function ensureRecipeTable(sql) {
  if (typeof sql !== 'function') throw new Error('ensureRecipeTable: sql is required');
  await sql`
    CREATE TABLE IF NOT EXISTS fix_recipes (
      id              SERIAL PRIMARY KEY,
      module          TEXT NOT NULL,
      finding_type    TEXT NOT NULL,
      file_extension  TEXT NOT NULL,
      before_hash     TEXT NOT NULL,
      before_snippet  TEXT NOT NULL,
      after_snippet   TEXT NOT NULL,
      usage_count     INTEGER NOT NULL DEFAULT 1,
      confidence      REAL    NOT NULL DEFAULT 0.5,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_used_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS fix_recipes_dedup
      ON fix_recipes (module, finding_type, file_extension, before_hash)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS fix_recipes_lookup
      ON fix_recipes (module, finding_type, file_extension, confidence DESC)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS fix_recipes_popular
      ON fix_recipes (usage_count DESC)
  `;
}

// ---------------------------------------------------------------------------
// Helpers (pure, testable)
// ---------------------------------------------------------------------------

const MAX_SNIPPET_BYTES = 2048;
const SNIPPET_CONTEXT_LINES = 8;
const MIN_CONFIDENCE_TO_APPLY = 0.65;

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/**
 * Extract a normalised lookup key from an issue string.
 * Prefers parenthesised codes like (js-httponly-false); falls back to a slug.
 */
function extractFindingType(issue) {
  const codeMatch = issue.match(/\(([a-z][a-z0-9-]+)\)/i);
  if (codeMatch) return codeMatch[1].toLowerCase();
  return issue.slice(0, 50).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function fileExtension(filePath) {
  if (!filePath) return '.js';
  const dot = filePath.lastIndexOf('.');
  return dot >= 0 ? filePath.slice(dot).toLowerCase() : '.js';
}

/**
 * Compute 1-indexed line numbers that differ between before and after.
 */
function diffedLines(before, after) {
  const bl = before.split('\n');
  const al = after.split('\n');
  const changed = [];
  for (let i = 0; i < Math.max(bl.length, al.length); i++) {
    if (bl[i] !== al[i]) changed.push(i + 1);
  }
  return changed;
}

/**
 * Extract a compact snippet around the changed lines.
 */
function extractBeforeSnippet(content, changedLineNumbers) {
  if (!changedLineNumbers || changedLineNumbers.length === 0) {
    return content.slice(0, MAX_SNIPPET_BYTES);
  }
  const lines = content.split('\n');
  const firstLine = Math.min(...changedLineNumbers);
  const start = Math.max(0, firstLine - 1 - SNIPPET_CONTEXT_LINES);
  const end = Math.min(lines.length, firstLine - 1 + SNIPPET_CONTEXT_LINES + 1);
  return lines.slice(start, end).join('\n').slice(0, MAX_SNIPPET_BYTES);
}

/**
 * Apply a stored recipe to `content`.
 * Tries exact match first, then fuzzy match on the signature line.
 *
 * @param {string} content
 * @param {{ before_snippet: string, after_snippet: string }} recipe
 * @returns {string|null}
 */
function applyRecipe(content, recipe) {
  const { before_snippet: before, after_snippet: after } = recipe;
  if (content.includes(before)) {
    return content.replace(before, after);
  }
  const sigLine = before.split('\n').find(l => l.trim().length > 10);
  if (sigLine && content.includes(sigLine.trim())) {
    const trimmed = sigLine.trim();
    const idx = content.indexOf(trimmed);
    if (idx !== -1) {
      const candidate = content.slice(idx, idx + before.length);
      if (candidate.split('\n').length === before.split('\n').length) {
        return content.slice(0, idx) + after + content.slice(idx + before.length);
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// DB-dependent functions (require sql injection)
// ---------------------------------------------------------------------------

/**
 * Record a successful Claude fix as a recipe.
 *
 * @param {object} opts
 * @param {Function} opts.sql
 * @param {string} opts.module
 * @param {string} opts.issue
 * @param {string} opts.filePath
 * @param {string} opts.beforeContent
 * @param {string} opts.afterContent
 * @param {number} [opts.confidenceDelta=0]
 */
async function recordRecipe({ sql, module: mod, issue, filePath, beforeContent, afterContent, confidenceDelta = 0 }) {
  if (typeof sql !== 'function') throw new Error('recordRecipe: sql is required');
  await ensureRecipeTable(sql);

  const findingType = extractFindingType(issue);
  const ext = fileExtension(filePath);
  const changedLines = diffedLines(beforeContent, afterContent);
  const beforeSnippet = extractBeforeSnippet(beforeContent, changedLines);
  const afterSnippet = extractBeforeSnippet(afterContent, changedLines).slice(0, MAX_SNIPPET_BYTES);
  const beforeHash = sha256(beforeSnippet);
  const baseConfidence = 0.5;
  const delta = Math.max(-0.4, Math.min(0.4, confidenceDelta || 0));

  await sql`
    INSERT INTO fix_recipes
      (module, finding_type, file_extension, before_hash, before_snippet, after_snippet, confidence)
    VALUES (${mod}, ${findingType}, ${ext}, ${beforeHash}, ${beforeSnippet}, ${afterSnippet}, ${baseConfidence + delta})
    ON CONFLICT (module, finding_type, file_extension, before_hash)
    DO UPDATE SET
      usage_count  = fix_recipes.usage_count + 1,
      confidence   = LEAST(0.95, fix_recipes.confidence + 0.05 + ${delta}),
      last_used_at = NOW()
  `;
}

/**
 * Look up the best recipe for a (module, issue, extension) combination.
 *
 * @param {object} opts
 * @param {Function} opts.sql
 * @param {string} opts.module
 * @param {string} opts.issue
 * @param {string} opts.filePath
 * @returns {Promise<{before_snippet:string, after_snippet:string, confidence:number}|null>}
 */
async function lookupRecipe({ sql, module: mod, issue, filePath }) {
  if (typeof sql !== 'function') throw new Error('lookupRecipe: sql is required');
  await ensureRecipeTable(sql);

  const findingType = extractFindingType(issue);
  const ext = fileExtension(filePath);

  const rows = await sql`
    SELECT before_snippet, after_snippet, confidence, usage_count
    FROM fix_recipes
    WHERE module = ${mod}
      AND finding_type = ${findingType}
      AND file_extension = ${ext}
      AND confidence >= ${MIN_CONFIDENCE_TO_APPLY}
    ORDER BY confidence DESC, usage_count DESC
    LIMIT 5
  `;
  return rows.length > 0 ? rows[0] : null;
}

/**
 * Try to fix content using stored recipes for each issue.
 *
 * @param {object} opts
 * @param {Function} opts.sql
 * @param {string} opts.content
 * @param {string} opts.filePath
 * @param {Array<{module: string, issue: string}>} opts.issueObjects
 * @returns {Promise<string|null>}
 */
async function tryRecipeFix({ sql, content, filePath, issueObjects }) {
  if (!issueObjects || issueObjects.length === 0) return null;
  if (typeof sql !== 'function') return null;

  let current = content;
  const unhandled = [];

  for (const { module: mod, issue } of issueObjects) {
    try {
      const recipe = await lookupRecipe({ sql, module: mod, issue, filePath });
      if (!recipe) { unhandled.push(issue); continue; }
      const fixed = applyRecipe(current, recipe);
      if (fixed === null) { unhandled.push(issue); continue; }
      current = fixed;
    } catch {
      unhandled.push(issue);
    }
  }

  if (unhandled.length > 0) return null;
  if (current === content) return null;
  return current;
}

/**
 * Record all gate-passing fixes from the fix route. Best-effort.
 *
 * @param {Function} sql
 * @param {Array<{file:string, original:string, fixed:string, issues:string[]}>} fixes
 * @param {string} [moduleHint]
 */
async function recordSuccessfulFixes(sql, fixes, moduleHint = 'unknown') {
  if (typeof sql !== 'function') return;
  const promises = fixes.flatMap(({ file, original, fixed, issues }) =>
    issues.map(issue =>
      recordRecipe({ sql, module: moduleHint, issue, filePath: file, beforeContent: original, afterContent: fixed })
        .catch(() => {})
    )
  );
  await Promise.allSettled(promises);
}

/**
 * Aggregate stats for the /admin/learning dashboard.
 *
 * @param {Function} sql
 */
async function getRecipeStats(sql) {
  if (typeof sql !== 'function') throw new Error('getRecipeStats: sql is required');
  await ensureRecipeTable(sql);
  const rows = await sql`
    SELECT
      COUNT(*)                                          AS total_recipes,
      COUNT(DISTINCT module)                            AS modules_covered,
      COUNT(DISTINCT file_extension)                    AS extensions_covered,
      SUM(usage_count)                                  AS total_applications,
      ROUND(AVG(confidence)::numeric, 3)                AS avg_confidence,
      COUNT(*) FILTER (WHERE confidence >= 0.8)         AS high_confidence_recipes
    FROM fix_recipes
  `;
  return rows[0] || {};
}

module.exports = {
  ensureRecipeTable,
  recordRecipe,
  lookupRecipe,
  applyRecipe,
  tryRecipeFix,
  recordSuccessfulFixes,
  getRecipeStats,
  extractFindingType,
  diffedLines,
  extractBeforeSnippet,
};
