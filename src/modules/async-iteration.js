/**
 * Async-Iteration Module — async callbacks in the wrong iterator.
 *
 * JavaScript's array iterators were designed before async/await and
 * they interact with Promises in silently-broken ways. Every team has
 * these bugs. None of the mainstream linters catch the real ones.
 *
 * THE FOUR BUGS:
 *
 *   (1) `.reduce(async (acc, item) => { ... })` — "async reducer"
 *       The accumulator becomes a Promise chain. Every iteration the
 *       callback has to `await acc` to get the previous value. You've
 *       accidentally serialised what looked like a functional pipeline,
 *       and if you *don't* await `acc` your spreads/concats start
 *       returning `{ then: [Function] }` shaped garbage.
 *
 *   (2) `.filter(async x => ...)` — "async filter"
 *       The filter predicate now returns a Promise. Promises are
 *       truthy. Every single item passes the filter. Your 10,000-item
 *       list "works" on small test data because the elements happen to
 *       match anyway. It ships. Production fails silently in ways you
 *       can't trace.
 *
 *   (3) `.some(async x => ...)` / `.every(async x => ...)` — same
 *       shape as filter. `some` returns true on the first item; `every`
 *       returns true for all items. Short-circuit semantics don't
 *       survive contact with Promises.
 *
 *   (4) `.forEach(async x => { await ... })` — "async forEach"
 *       forEach ignores the return values. The developer wrote
 *       `await` inside expecting sequential execution; instead
 *       forEach fires every callback in parallel, doesn't await any
 *       of them, errors get swallowed and ordering is lost. The
 *       outer function returns *before* the inner awaits resolve.
 *
 *   (5) `.map(async x => ...)` without `Promise.all` — "unwrapped map"
 *       map returns an array of Promises. If the caller then does
 *       `for (const r of results) console.log(r)`, they're logging
 *       Promise objects, not values. Warning-level because the "fix"
 *       (wrap in `Promise.all`) is so common that most real map calls
 *       ARE wrapped and we only flag the unwrapped ones.
 *
 * False-positive avoidance:
 *   - `Promise.all(arr.map(async ...))` and `await Promise.all(...)`
 *     — fine, never flag
 *   - `.map(async ...)` whose result is immediately `await`ed as part
 *     of `Promise.all` — fine
 *   - Test/spec/fixture files — downgrade error → warning (real bugs,
 *     but tests intentionally use weird shapes)
 *   - Comments / strings — ignored
 *   - Explicit `// async-iteration-ok` marker on the same or
 *     preceding line — respected
 *
 * Competitors:
 *   - ESLint `no-async-promise-executor` — catches `new Promise(async ...)`
 *     only. Nothing for .reduce/.filter/.some/.every.
 *   - ESLint `no-array-callback-reference` — unrelated.
 *   - `eslint-plugin-unicorn/no-await-in-promise-methods` — narrow
 *     Promise.all/allSettled case only.
 *   - `@typescript-eslint/no-floating-promises` — catches some .forEach
 *     cases but only if strict TypeScript config is on AND result is
 *     not assigned.
 *   - `@typescript-eslint/no-misused-promises` — closest competitor,
 *     but opt-in, narrow, and misses `.reduce` entirely.
 *   - SonarQube — one rule for `forEach`, nothing else.
 *
 * Rules:
 *
 *   error:   `arr.reduce(async ...)` — silent serialisation + Promise
 *            accumulator anti-pattern.
 *            (rule: `async-iteration:async-reduce:<rel>:<line>`)
 *
 *   error:   `arr.filter(async ...)` / `.some(async ...)` /
 *            `.every(async ...)` — Promise is truthy, predicate is
 *            meaningless.
 *            (rule: `async-iteration:async-predicate:<rel>:<line>`)
 *
 *   warning: `arr.forEach(async ...)` — forEach ignores returned
 *            Promises, the enclosing function finishes before the
 *            awaits do.
 *            (rule: `async-iteration:async-foreach:<rel>:<line>`)
 *
 *   warning: `arr.map(async ...)` not wrapped in `Promise.all(...)` —
 *            resulting array is Promises, not values.
 *            (rule: `async-iteration:unwrapped-map:<rel>:<line>`)
 *
 * TODO(gluecron): host-neutral — pure JS/TS source scan.
 */

const fs = require('fs');
const path = require('path');
const BaseModule = require('./base-module');

const DEFAULT_EXCLUDES = [
  'node_modules', '.git', 'dist', 'build', 'coverage', '.gatetest',
  '.next', '__pycache__', 'target', 'vendor', '.terraform', 'out',
];

const SOURCE_EXTS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);

const TEST_PATH_RE = /(?:^|\/)(?:tests?|__tests__|spec|fixtures?|stories|storybook|e2e)(?:\/|$)|\.(?:test|spec|stories|fixture|e2e)\.(?:js|jsx|ts|tsx|mjs|cjs|mts|cts)$/i;

// `<receiver>.<method>(async <arrow-args> => ` and the `function` form.
// Captures method name so we can route per-rule.
// We match both arrow (`async (x) =>` / `async x =>`) and function
// (`async function`) callbacks.
const METHOD_CALL_RE = /\.\s*(reduce|reduceRight|filter|some|every|forEach|map|flatMap|find|findIndex|findLast|findLastIndex)\s*\(\s*async(?:\s*\(|\s+[A-Za-z_$]|\s+function\b)/g;

// Explicit opt-out marker.
const OK_MARKER_RE = /\basync-iteration-ok\b/;

function isInString(line, idx) {
  let inS = false; let inD = false; let inT = false;
  for (let i = 0; i < idx && i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '\\') { i += 1; continue; }
    if (!inD && !inT && ch === '\'') inS = !inS;
    else if (!inS && !inT && ch === '"') inD = !inD;
    else if (!inS && !inD && ch === '`') inT = !inT;
  }
  return inS || inD || inT;
}

/**
 * Walk backwards through `before` tracking paren depth. If we pop back
 * through an unclosed `(` whose text immediately prior matches
 * `Promise.(all|allSettled|any|race)`, the call site is inside a
 * Promise combinator and should not be flagged.
 */
function isInsidePromiseCombinator(before) {
  let depth = 0;
  for (let i = before.length - 1; i >= 0; i -= 1) {
    const ch = before[i];
    if (ch === ')') depth += 1;
    else if (ch === '(') {
      if (depth === 0) {
        // Unclosed `(` — check what precedes it.
        const head = before.slice(0, i);
        if (/\bPromise\.(?:all|allSettled|any|race)\s*$/.test(head)) return true;
        return false;
      }
      depth -= 1;
    }
  }
  return false;
}

class AsyncIterationModule extends BaseModule {
  constructor() {
    super(
      'asyncIteration',
      'Async-iteration detector — async callbacks handed to .reduce/.filter/.some/.every/.forEach/.map where Promise semantics silently break the iterator',
    );
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;
    const files = this._findFiles(projectRoot);

    if (files.length === 0) {
      result.addCheck('async-iteration:no-files', true, {
        severity: 'info',
        message: 'No JS/TS source files found — skipping',
      });
      return;
    }

    result.addCheck('async-iteration:scanning', true, {
      severity: 'info',
      message: `Scanning ${files.length} JS/TS file(s) for async-iterator misuse`,
    });

    let issues = 0;
    for (const file of files) {
      issues += this._scanFile(file, projectRoot, result);
    }

    result.addCheck('async-iteration:summary', true, {
      severity: 'info',
      message: `Async-iteration scan: ${files.length} file(s), ${issues} issue(s)`,
    });
  }

  _findFiles(projectRoot) {
    const out = [];
    const walk = (dir, depth = 0) => {
      if (depth > 12) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (DEFAULT_EXCLUDES.includes(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, depth + 1);
        else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (SOURCE_EXTS.has(ext)) out.push(full);
        }
      }
    };
    walk(projectRoot);
    return out;
  }

  _scanFile(file, projectRoot, result) {
    let content;
    try { content = fs.readFileSync(file, 'utf-8'); } catch { return 0; }

    const rel = path.relative(projectRoot, file);
    const isTestFile = TEST_PATH_RE.test(rel);
    const lines = content.split('\n');
    let issues = 0;

    let inBlockComment = false;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const trimmed = line.trim();

      if (inBlockComment) {
        if (/\*\//.test(line)) inBlockComment = false;
        continue;
      }
      if (/^\s*\/\*/.test(line) && !/\*\//.test(line)) {
        inBlockComment = true;
        continue;
      }
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*')) continue;

      // Per-file and per-line opt-out.
      if (OK_MARKER_RE.test(line)) continue;
      const prev = i > 0 ? lines[i - 1] : '';
      if (OK_MARKER_RE.test(prev)) continue;

      METHOD_CALL_RE.lastIndex = 0;
      let m;
      while ((m = METHOD_CALL_RE.exec(line)) !== null) {
        if (isInString(line, m.index)) continue;

        const method = m[1];

        // For `.map` / `.flatMap`, only flag when NOT inside Promise.all(...)
        // on the same line or the immediately preceding line.
        if (method === 'map' || method === 'flatMap') {
          const before = line.slice(0, m.index);

          // Accept `Promise.all(...)` / `Promise.allSettled(...)` / etc.
          // wrapping the .map call. Walk back through paren depth to
          // find an unclosed `(` preceded by Promise.<combinator>.
          if (isInsidePromiseCombinator(before)) continue;
          // Also check multi-line: preceding line may end with
          // `await Promise.all(` and the .map is on a fresh line.
          const prevLine = i > 0 ? lines[i - 1] : '';
          if (/\bPromise\.(?:all|allSettled|any|race)\s*\(\s*$/.test(prevLine.trim() ? prevLine : '')) {
            if (/^\s*(?:[a-zA-Z_$][\w$]*)?\s*$/.test(before)) continue;
          }

          // Accept immediate `await` context on map returning a short
          // chain `.map(...).then(...)` or `.map(...).catch(...)` —
          // those are explicit promise consumers.
          const after = line.slice(m.index);
          // Look ahead to end of call: if the matching close-paren is
          // followed by `.then(` or `.catch(` or `.finally(`, treat
          // as explicit async consumer.
          if (/\)\s*\.(?:then|catch|finally)\s*\(/.test(after)) continue;

          issues += this._flag(result, `async-iteration:unwrapped-map:${rel}:${i + 1}`, {
            severity: isTestFile ? 'info' : 'warning',
            file: rel,
            line: i + 1,
            method,
            message: `${rel}:${i + 1} \`.${method}(async ...)\` not wrapped in \`Promise.all(...)\` — the resulting array is an array of Promises, not values`,
            suggestion: 'Wrap in `await Promise.all(arr.map(async x => ...))` to collect the resolved values, or use a plain `for...of` if you need sequential execution with awaits.',
          });
          continue;
        }

        if (method === 'reduce' || method === 'reduceRight') {
          issues += this._flag(result, `async-iteration:async-reduce:${rel}:${i + 1}`, {
            severity: isTestFile ? 'warning' : 'error',
            file: rel,
            line: i + 1,
            method,
            message: `${rel}:${i + 1} \`.${method}(async ...)\` — the accumulator becomes a Promise chain; iterations silently serialise and \`await acc\` is required every step`,
            suggestion: 'Replace with a `for...of` loop collecting into a local variable, or precompute an array of resolved values with `await Promise.all(arr.map(...))` and then `.reduce(...)` synchronously.',
          });
          continue;
        }

        if (method === 'filter' || method === 'some' || method === 'every' || method === 'find' || method === 'findIndex' || method === 'findLast' || method === 'findLastIndex') {
          issues += this._flag(result, `async-iteration:async-predicate:${rel}:${i + 1}`, {
            severity: isTestFile ? 'warning' : 'error',
            file: rel,
            line: i + 1,
            method,
            message: `${rel}:${i + 1} \`.${method}(async ...)\` — Promise is always truthy, so \`${method}\` returns a meaningless result (every item passes / first item matches)`,
            suggestion: 'Resolve the predicate first with `Promise.all`, then filter/test synchronously: `const results = await Promise.all(arr.map(async x => check(x))); arr.filter((_, i) => results[i]);`',
          });
          continue;
        }

        if (method === 'forEach') {
          issues += this._flag(result, `async-iteration:async-foreach:${rel}:${i + 1}`, {
            severity: isTestFile ? 'info' : 'warning',
            file: rel,
            line: i + 1,
            method,
            message: `${rel}:${i + 1} \`.forEach(async ...)\` — forEach doesn't await returned Promises; the enclosing function returns before the inner awaits resolve and errors are swallowed`,
            suggestion: 'For sequential execution use `for (const x of arr) { await ... }`. For parallel use `await Promise.all(arr.map(async x => ...))`.',
          });
        }
      }
    }

    return issues;
  }

  _flag(result, name, details) {
    result.addCheck(name, false, details);
    return 1;
  }
}

module.exports = AsyncIterationModule;
