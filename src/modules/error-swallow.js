/**
 * Error Swallow Module — silent catches, floating promises, unchecked
 * async errors.
 *
 * The single most common production bug we see across every
 * codebase is error swallowing. `try { ... } catch {}` in a webhook
 * handler. `.catch(() => {})` after a Stripe call. A missing `await`
 * on `db.commit()`. An `if (err) return;` in a Node callback that
 * drops the error on the floor. Each one looks harmless in code
 * review — each one deletes an alert that would have caught a bug
 * before it hit the customer.
 *
 * ESLint's `no-empty` catches a fraction of this (only literal empty
 * `catch` blocks). It misses:
 *   - catch blocks that only log and return
 *   - `.catch(() => {})` / `.catch(() => null)` on promise chains
 *   - missing `await` on a function call whose return type is a
 *     Promise (fire-and-forget)
 *   - Node-callback `(err, data) => { ... data }` that never
 *     branches on `err`
 *   - `process.on('uncaughtException', () => {})` / `unhandledRejection`
 *     handlers that swallow
 *
 * We cover all six families.
 *
 * Discovery: `.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.mts`,
 * `.cts`. Tests (`*.test.*`, `*.spec.*`, under `tests/`, `__tests__/`,
 * `spec/`) are scanned at reduced severity — a silent catch in a test
 * is usually intentional (testing the unhappy path).
 *
 * Rules:
 *
 *   error:   empty `catch (err) { }` block                 (prod)
 *            warning in tests
 *            (rule: `error-swallow:empty-catch:<rel>:<line>`)
 *   error:   catch block that only calls `console.log`/`console.warn`
 *            and does not re-throw — visible in logs but breaks
 *            downstream callers
 *            (rule: `error-swallow:log-and-eat:<rel>:<line>`)
 *   error:   `.catch(() => {})` / `.catch(() => null)` /
 *            `.catch(() => undefined)` on a Promise chain — swallows
 *            the reason. `.catch(noop)` where `noop = () => {}` is
 *            also caught.
 *            (rule: `error-swallow:catch-noop:<rel>:<line>`)
 *   warning: `process.on('uncaughtException', ...)` /
 *            `'unhandledRejection'` handler that doesn't re-throw or
 *            call `process.exit`
 *            (rule: `error-swallow:global-silent-handler:<rel>:<line>`)
 *   warning: Node-callback `(err, ...) => {` that references `err`
 *            neither in a conditional nor a throw — error never
 *            surfaces
 *            (rule: `error-swallow:callback-err-ignored:<rel>:<line>`)
 *   warning: statement-level call to a function whose name strongly
 *            suggests a Promise (`.save()`, `.commit()`, `.then()`,
 *            `.fetch()`, `.send()`, `await*`) with NO `await` and NO
 *            `.then(` / `.catch(` — fire-and-forget
 *            (rule: `error-swallow:floating-promise:<rel>:<line>`)
 *
 * TODO(gluecron): Once Gluecron runs first-party CI and ships its own
 * SDK, extend floating-promise detection to the Gluecron API client
 * (every `gluecron.call.*` returns a Promise).
 */

const fs = require('fs');
const path = require('path');
const BaseModule = require('./base-module');

const DEFAULT_EXCLUDES = [
  'node_modules', '.git', 'dist', 'build', 'coverage', '.gatetest',
  '.next', '__pycache__', 'target', 'vendor', '.terraform', 'out',
];

const SOURCE_EXTS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);
const TEST_PATH_RE = /(?:^|\/)(?:tests?|__tests__|spec)(?:\/|$)|\.(?:test|spec)\.(?:js|jsx|ts|tsx|mjs|cjs|mts|cts)$/i;

// Function names whose invocation returns a Promise commonly enough
// that calling without await/then/catch is a smell. Deliberately
// narrow — we'd rather miss cases than shout false positives.
const PROMISE_METHOD_HINTS = [
  'save', 'commit', 'rollback', 'update', 'insert', 'delete',
  'query', 'exec', 'send', 'publish', 'fetch',
  'capture', 'confirm', 'charge', 'refund', 'cancel',
  'write', 'flush', 'sync', 'upload', 'download',
];

// String-aware "inside a string literal" guard (copied in spirit from
// flaky-tests.js — kept local to avoid cross-module coupling).
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

class ErrorSwallowModule extends BaseModule {
  constructor() {
    super(
      'errorSwallow',
      'Error Swallow — empty catch, .catch(noop), callback-err ignored, floating promises, global silent handlers',
    );
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;
    const files = this._findFiles(projectRoot);

    if (files.length === 0) {
      result.addCheck('error-swallow:no-files', true, {
        severity: 'info',
        message: 'No JS/TS source files found — skipping',
      });
      return;
    }

    result.addCheck('error-swallow:scanning', true, {
      severity: 'info',
      message: `Scanning ${files.length} JS/TS file(s)`,
    });

    let issues = 0;
    for (const file of files) {
      issues += this._scanFile(file, projectRoot, result);
    }

    result.addCheck('error-swallow:summary', true, {
      severity: 'info',
      message: `Error-swallow scan: ${files.length} file(s), ${issues} issue(s)`,
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

  // Returns true if the current line or the previous line carries a
  // `// error-ok` suppressor comment, meaning the developer has documented
  // that this specific swallow is intentional.
  _isSuppressed(lines, lineIdx) {
    const line = lines[lineIdx] || '';
    const prev = lineIdx > 0 ? lines[lineIdx - 1] : '';
    return /\berror-ok\b/.test(line) || /\berror-ok\b/.test(prev);
  }

  _scanFile(file, projectRoot, result) {
    let content;
    try { content = fs.readFileSync(file, 'utf-8'); } catch { return 0; }

    const rel = path.relative(projectRoot, file);
    const isTest = TEST_PATH_RE.test(rel.replace(/\\/g, '/'));
    const lines = content.split('\n');
    let issues = 0;

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//')) continue;

      // 1. Empty catch block — `catch (err) {}` or `catch {}` on one
      //    line, OR `catch (err) {` followed immediately by `}`.
      const catchOnLine = line.match(/\bcatch\s*(?:\(([^)]*)\))?\s*\{/);
      if (catchOnLine && !isInString(line, catchOnLine.index) && !this._isSuppressed(lines, i)) {
        const bodyText = this._collectBlockBody(lines, i, catchOnLine.index);
        if (bodyText.body === '' && bodyText.closed) {
          issues += this._flag(result, `error-swallow:empty-catch:${rel}:${i + 1}`, {
            severity: isTest ? 'warning' : 'error',
            file: rel,
            line: i + 1,
            message: `${rel}:${i + 1} has an empty catch block — any error thrown in the try is erased`,
            suggestion: 'At minimum log the error with context; preferably rethrow or handle it. If the error is genuinely expected and benign, comment WHY.',
          });
        } else if (bodyText.closed && this._isLogAndEat(bodyText.body)) {
          issues += this._flag(result, `error-swallow:log-and-eat:${rel}:${i + 1}`, {
            severity: isTest ? 'info' : 'error',
            file: rel,
            line: i + 1,
            message: `${rel}:${i + 1} catch block only logs and does not re-throw — visible in logs but invisible to callers, breaks downstream error handling`,
            suggestion: 'Either re-throw after logging, call `next(err)` in Express, or convert to a typed Result. Don\'t pretend the operation succeeded.',
          });
        }
      }

      // 2. `.catch(() => {})` / `.catch(() => null)` / `.catch(noop)`
      const catchNoop = line.match(/\.catch\s*\(\s*(?:\(\s*\w*\s*\)|\w+)?\s*=>\s*(?:\{\s*\}|null|undefined|void\s+0)\s*\)/);
      if (catchNoop && !isInString(line, catchNoop.index) && !this._isSuppressed(lines, i)) {
        issues += this._flag(result, `error-swallow:catch-noop:${rel}:${i + 1}`, {
          severity: isTest ? 'warning' : 'error',
          file: rel,
          line: i + 1,
          message: `${rel}:${i + 1} has \`.catch(() => {})\` or equivalent — Promise rejection is silently dropped`,
          suggestion: 'Replace with `.catch((err) => log.error({ err }, "context"))` and either rethrow or surface a typed error. Empty catch means the bug reaches the user.',
        });
      }
      // `.catch(noop)` / `.catch(ignore)` / `.catch(() => { /* ignore */ })`
      const catchNamedNoop = line.match(/\.catch\s*\(\s*(?:noop|ignore|swallow|_)\s*\)/);
      if (catchNamedNoop && !isInString(line, catchNamedNoop.index) && !this._isSuppressed(lines, i)) {
        issues += this._flag(result, `error-swallow:catch-noop:${rel}:${i + 1}`, {
          severity: isTest ? 'warning' : 'error',
          file: rel,
          line: i + 1,
          message: `${rel}:${i + 1} passes a known noop (\`noop\`/\`ignore\`/\`swallow\`/\`_\`) to \`.catch()\``,
          suggestion: 'Give the handler a real body: log, rethrow, or convert to a typed Result.',
        });
      }

      // 3. Global silent handlers
      const globalHandler = line.match(/process\.on\s*\(\s*['"`](uncaughtException|unhandledRejection)['"`]/);
      if (globalHandler && !isInString(line, globalHandler.index) && !this._isSuppressed(lines, i)) {
        // Look at next ~8 lines for a throw/exit/log-with-rethrow
        const windowText = lines.slice(i, Math.min(lines.length, i + 10)).join('\n');
        const hasExit = /\bprocess\.exit\s*\(/.test(windowText);
        const hasThrow = /\bthrow\b/.test(windowText);
        if (!hasExit && !hasThrow) {
          issues += this._flag(result, `error-swallow:global-silent-handler:${rel}:${i + 1}`, {
            severity: 'warning',
            file: rel,
            line: i + 1,
            event: globalHandler[1],
            message: `${rel}:${i + 1} attaches a \`process.on('${globalHandler[1]}', ...)\` handler that doesn't re-throw or exit — crashes become silent`,
            suggestion: 'Log with structured context, then `process.exit(1)` or rethrow. A silent `uncaughtException` handler turns every crash into data corruption.',
          });
        }
      }

      // 4. Node-callback `(err, ...) => { ... }` that doesn't branch
      //    on err. Conservative: only flag if the callback body in the
      //    next ~5 lines doesn't mention `err` — we look ONLY after
      //    the opening brace to avoid counting the param itself.
      const nodeCb = line.match(/\(\s*(err|error)\s*,\s*[^)]+\)\s*=>\s*\{/);
      if (nodeCb && !isInString(line, nodeCb.index) && !this._isSuppressed(lines, i)) {
        const errName = nodeCb[1];
        // Body starts right after the `{` on this line.
        const braceOffset = line.indexOf('{', nodeCb.index + nodeCb[0].length - 1);
        const sameLineBody = braceOffset >= 0 ? line.slice(braceOffset + 1) : '';
        const followingLines = lines.slice(i + 1, Math.min(lines.length, i + 6)).join('\n');
        const bodyWindow = `${sameLineBody}\n${followingLines}`;
        const mentionsErr = new RegExp(`\\b${errName}\\b`).test(bodyWindow);
        if (!mentionsErr) {
          issues += this._flag(result, `error-swallow:callback-err-ignored:${rel}:${i + 1}`, {
            severity: 'warning',
            file: rel,
            line: i + 1,
            message: `${rel}:${i + 1} Node-style callback \`(${errName}, ...)\` never references \`${errName}\` — every error is dropped`,
            suggestion: `Branch on \`if (${errName}) { /* handle or rethrow */ }\` or, better, promisify the API.`,
          });
        }
      }

      // 5. Floating promise heuristic — statement-level call to a
      //    known promise-returning method, NOT preceded by `await`,
      //    `return`, `void`, `=` etc., and NOT followed on the same
      //    line by `.then(` or `.catch(`. Deliberately narrow.
      if (!isTest) {
        const flt = line.match(/^(\s*)([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.([A-Za-z_$][\w$]*)\s*\(/);
        if (flt && !isInString(line, flt.index) && !this._isSuppressed(lines, i)) {
          const indent = flt[1];
          const method = flt[3];
          if (PROMISE_METHOD_HINTS.includes(method.toLowerCase())) {
            // Prefix check — is the statement preceded by await/return/void/= ?
            const before = line.slice(0, flt.index + indent.length);
            const head = line.slice(flt.index + indent.length);
            const prevNonWs = before.trim();
            const looksAwaited = /\b(?:await|return|void|yield)\s*$/.test(prevNonWs)
              || /[=!?([,]\s*$/.test(prevNonWs);
            const chained = /\.(?:then|catch|finally)\s*\(/.test(head);
            if (!looksAwaited && !chained) {
              issues += this._flag(result, `error-swallow:floating-promise:${rel}:${i + 1}`, {
                severity: 'warning',
                file: rel,
                line: i + 1,
                method,
                message: `${rel}:${i + 1} calls \`.${method}()\` without \`await\` / \`.then(...)\` / \`.catch(...)\` — a rejection here becomes an unhandled promise rejection`,
                suggestion: `Add \`await\` if this is inside an async function, or chain \`.catch()\` to handle the rejection.`,
              });
            }
          }
        }
      }
    }

    return issues;
  }

  // Best-effort block-body extractor. Starting at `lines[lineIdx]`
  // with `{` at `openIdx` on that line, walk forward counting braces
  // (string-aware) and return the concatenated body (excluding the
  // outermost braces) plus whether the block was closed.
  _collectBlockBody(lines, lineIdx, hintIdx) {
    const startLine = lines[lineIdx];
    const braceIdx = startLine.indexOf('{', hintIdx);
    if (braceIdx === -1) return { body: '', closed: false };

    let depth = 1;
    let body = '';
    let firstLineRemainder = startLine.slice(braceIdx + 1);
    const walkLine = (text) => {
      for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (ch === '{') { depth += 1; body += ch; }
        else if (ch === '}') {
          depth -= 1;
          if (depth === 0) return { closed: true, rest: text.slice(i + 1) };
          body += ch;
        }
        else body += ch;
      }
      return { closed: false, rest: '' };
    };
    // Process first-line remainder
    const first = walkLine(firstLineRemainder);
    if (first.closed) return { body: body.trim(), closed: true };

    body += '\n';
    for (let j = lineIdx + 1; j < lines.length && j < lineIdx + 40; j += 1) {
      const res = walkLine(lines[j]);
      if (res.closed) return { body: body.trim(), closed: true };
      body += '\n';
    }
    return { body: body.trim(), closed: false };
  }

  // True if the catch body only contains `console.*` calls (or a
  // comment) and no throw / reject / return with an error.
  _isLogAndEat(body) {
    const lines = body.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('//'));
    if (lines.length === 0) return false;
    // Must not throw or reject or return an error value
    if (/\bthrow\b/.test(body)) return false;
    if (/\breject\s*\(/.test(body)) return false;
    if (/\breturn\s+.*\berr(?:or)?\b/.test(body)) return false;
    if (/\bnext\s*\(\s*\w+/.test(body)) return false; // Express-style next(err)
    // Every non-empty line must look like a log call
    return lines.every((l) => /^console\.(?:log|warn|error|info|debug)\s*\(/.test(l)
      || /^(?:log|logger)\.(?:log|warn|error|info|debug)\s*\(/.test(l));
  }

  _flag(result, name, details) {
    result.addCheck(name, false, details);
    return 1;
  }
}

module.exports = ErrorSwallowModule;
