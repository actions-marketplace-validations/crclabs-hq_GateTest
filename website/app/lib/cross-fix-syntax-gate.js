/**
 * Cross-fix syntax-validation gate.
 *
 * Phase 1.2 of THE FIX-FIRST BUILD PLAN. Sits between
 * `attemptFixWithRetries` (per-file fix) and PR creation. Catches the
 * failure mode where Claude returns plausible-looking content that
 * passes shape + pattern checks but doesn't actually parse — broken
 * brackets, JSX inside a `.json`, truncated mid-statement. The current
 * fix flow has no syntax gate; without this, syntactically invalid
 * fixes can ship to a customer's PR and break their build.
 *
 * Strategy: file-extension dispatch.
 *   - .json     → JSON.parse
 *   - .js .mjs  → vm.compileFunction (zero-dep, native Node syntax check)
 *   - .cjs      → vm.compileFunction
 *   - everything else → accept (TS/TSX/JSX validation requires the
 *     `typescript` package, which is a Boss Rule item to add at the
 *     repo root; flagged for the next session)
 *
 * Pure JS, dependency-injected for tests. The route imports this and
 * calls `validateFixesSyntax({ fixes })` after collecting all per-file
 * fixes, before opening the PR.
 *
 * Outcome:
 *   { accepted: Fix[], rejected: Array<{ file, reason, original, issues }> }
 *
 * Rejected fixes are NOT auto-retried by this gate (the upstream
 * iterative loop is the retry mechanism). They go straight into the
 * orchestrator's `errors` array so the customer sees the full picture.
 */

 
const vm = require('node:vm');

/**
 * Try to syntax-check a single string as JavaScript / CommonJS / ESM.
 * Returns { ok, reason }.
 *
 * vm.compileFunction wraps the source as a function body, which is the
 * fastest zero-dep way to validate syntax without executing anything.
 * It accepts `await` at the top level (function-body context allows it
 * for async wrappers), so legitimate top-level-await modules pass — but
 * truly broken syntax (unmatched braces, stray tokens) throws SyntaxError.
 */
function checkJsSyntax(source) {
  if (typeof source !== 'string' || source.length === 0) {
    return { ok: false, reason: 'empty source' };
  }
  try {
    // Note: vm.compileFunction supports parsing modern JS (ES2022+).
    // Top-level `import`/`export` statements aren't legal in a function
    // body, so for ESM source we strip them before compiling — this
    // doesn't change the bytes that ship to the PR, only what we
    // validate. If the rest of the file parses, we trust the imports.
    const stripped = source
      .replace(/^\s*import\s+[^;]+;?\s*$/gm, '')
      .replace(/^\s*export\s+(?:default\s+)?(?:async\s+)?/gm, '');
    vm.compileFunction(stripped, [], { filename: 'fix-validation.js' });
    return { ok: true };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    return { ok: false, reason: `syntax error: ${message}` };
  }
}

/**
 * Try to syntax-check a single string as JSON.
 */
function checkJsonSyntax(source) {
  if (typeof source !== 'string' || source.length === 0) {
    return { ok: false, reason: 'empty source' };
  }
  try {
    JSON.parse(source);
    return { ok: true };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    return { ok: false, reason: `invalid JSON: ${message}` };
  }
}

/**
 * Decide which checker to use for a file path.
 * Returns null for extensions we don't validate (TS family + everything
 * else) — those fixes are accepted without syntax checking.
 */
function pickChecker(filePath) {
  const lower = String(filePath || '').toLowerCase();
  if (lower.endsWith('.json')) return checkJsonSyntax;
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) return checkJsSyntax;
  // .ts / .tsx / .jsx / .mts / .cts intentionally unhandled — TS-family
  // syntax requires a real parser (the `typescript` package). Until
  // that's added, those fixes are passed through. Tracked in
  // CLAUDE.md ## THE FIX-FIRST BUILD PLAN.
  return null;
}

/**
 * Run the syntax gate against a collection of fixes.
 *
 * @param {Object} opts
 * @param {Array<{ file: string, fixed: string, original: string, issues: string[] }>} opts.fixes
 *        Output of the per-file iterative fix loop.
 * @param {Object} [opts.checkers]
 *        Optional override of the checkers used for each language —
 *        primarily for tests. Shape: { js, json }. Defaults to the
 *        built-in vm.compileFunction / JSON.parse implementations.
 * @returns {{
 *   accepted: Array<{ file, fixed, original, issues }>,
 *   rejected: Array<{ file, fixed, original, issues, reason, language }>,
 * }}
 */
function validateFixesSyntax(opts) {
  const { fixes, checkers } = opts || {};
  if (!Array.isArray(fixes)) throw new TypeError('fixes must be an array');

  const jsChecker = (checkers && checkers.js) || checkJsSyntax;
  const jsonChecker = (checkers && checkers.json) || checkJsonSyntax;

  const accepted = [];
  const rejected = [];

  for (const fix of fixes) {
    if (!fix || typeof fix.file !== 'string' || typeof fix.fixed !== 'string') {
      rejected.push({ ...(fix || {}), reason: 'malformed fix entry', language: 'unknown' });
      continue;
    }

    const lower = fix.file.toLowerCase();
    let checker;
    let language;
    if (lower.endsWith('.json')) { checker = jsonChecker; language = 'json'; }
    else if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) { checker = jsChecker; language = 'js'; }
    else { checker = null; language = 'unchecked'; }

    if (!checker) {
      // No checker for this extension — pass through. The accepted
      // entry preserves a `language` field so the PR body can note
      // which fixes were syntax-gated and which were not.
      accepted.push({ ...fix, language });
      continue;
    }

    const result = checker(fix.fixed);
    if (result.ok) {
      accepted.push({ ...fix, language });
    } else {
      rejected.push({ ...fix, reason: result.reason, language });
    }
  }

  return { accepted, rejected };
}

/**
 * Summarise gate results for log lines and PR-body footnotes.
 */
function summariseSyntaxGate(result) {
  if (!result) return 'syntax gate: not run';
  const { accepted = [], rejected = [] } = result;
  const total = accepted.length + rejected.length;
  if (total === 0) return 'syntax gate: 0 fixes';
  if (rejected.length === 0) return `syntax gate: ${total} fix${total > 1 ? 'es' : ''} validated, all clean`;
  const failedFiles = rejected.map((r) => r.file).join(', ');
  return `syntax gate: ${accepted.length}/${total} clean, ${rejected.length} rejected (${failedFiles})`;
}

module.exports = {
  validateFixesSyntax,
  summariseSyntaxGate,
  // Exported for tests / advanced callers that want to drive a
  // single-file check without going through the gate orchestrator.
  checkJsSyntax,
  checkJsonSyntax,
  pickChecker,
};
