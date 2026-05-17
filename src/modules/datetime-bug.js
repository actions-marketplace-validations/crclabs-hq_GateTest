/**
 * Datetime / Timezone Bug Detector Module.
 *
 * Every long-running codebase eventually ships a datetime bug to prod.
 * The bug fires intermittently, "works on my machine", passes every
 * unit test because the dev machine and the CI runner share a
 * timezone, and surfaces only when real customers in different
 * timezones hit the API at the wrong boundary. The fix is always
 * obvious in hindsight; the damage is already done.
 *
 * We target five high-precision bug classes — each is a known
 * runtime-silent failure mode, none of them have good built-in
 * linters, and all of them have been the subject of real-world
 * postmortems at major tech companies:
 *
 *   1. Python `datetime.datetime.now()` without a `tz=` argument.
 *      Returns a naive datetime. Comparisons against aware datetimes
 *      raise `TypeError` only at runtime; comparisons against other
 *      naives silently use the server's local timezone. Production
 *      databases stamp UTC; dev laptops stamp local. The bug hides
 *      until the clocks jump.
 *
 *   2. Python `datetime.datetime.utcnow()`. Deprecated in Python
 *      3.12+. Returns a naive datetime representing UTC — which
 *      promptly gets treated as local by any library that checks
 *      `tzinfo is None`. PEP 673 says "use datetime.now(timezone.utc)".
 *
 *   3. JavaScript `new Date(year, monthLiteral, day)` where the month
 *      literal is in 1..12. JS months are 0-indexed (January is 0).
 *      This call shape is nearly always wrong — either it's the bug
 *      ("Feb 14" becomes "Mar 14") or it's correct by accident and
 *      the reader can't tell. Either way it deserves a flag.
 *
 *   4. `Date.UTC(year, monthLiteral, day)` with month literal 1..12.
 *      Same 0-based trap as above — same fix.
 *
 *   5. `moment()` / `moment(x)` used as a timezone-free constructor.
 *      Moment.js has been in legacy mode since 2020 and its own docs
 *      recommend migration to Luxon / date-fns / Day.js / Temporal.
 *      The constructor without an explicit `.tz(...)` silently uses
 *      local time, reproducing bug class #1.
 *
 * Suppressions:
 *   - `// datetime-ok` / `# datetime-ok` on same or preceding line.
 *   - Test / spec / fixture paths downgrade error → warning.
 *   - Block-comment / line-comment / Python docstring stripping.
 *
 * Rules:
 *
 *   error:   Python naive `datetime.now()` — no tz argument.
 *            (rule: `datetime-bug:naive-now:<rel>:<line>`)
 *
 *   error:   Python deprecated `datetime.utcnow()`.
 *            (rule: `datetime-bug:utcnow-deprecated:<rel>:<line>`)
 *
 *   warning: JS `new Date(year, monthLiteral, day)` with month 1..12.
 *            (rule: `datetime-bug:one-based-month:<rel>:<line>`)
 *
 *   warning: JS `Date.UTC(year, monthLiteral, day)` with month 1..12.
 *            (rule: `datetime-bug:utc-one-based-month:<rel>:<line>`)
 *
 *   warning: `moment()` constructor with no explicit timezone call.
 *            (rule: `datetime-bug:moment-no-tz:<rel>:<line>`)
 *
 * Competitors:
 *   - ESLint has nothing on naive datetimes.
 *   - `pylint` / `ruff` flag `datetime.utcnow` in Py 3.12+ but don't
 *     cross-reference with `datetime.now()` missing tz.
 *   - `moment-deprecation-handler` is a runtime shim, not a linter.
 *   - SonarQube has one Java-only rule on `java.util.Date`.
 *   - Nothing unifies Python naive-datetime + JS 0-vs-1 month + moment
 *     legacy detection at the gate.
 *
 * TODO(gluecron): host-neutral — pure static scan.
 */

const BaseModule = require('./base-module');
const fs = require('fs');
const path = require('path');

const EXCLUDE_DIRS = new Set([
  'node_modules', '.git', '.claude', 'dist', 'build', 'coverage', '.gatetest',
  '.next', 'out', 'target', 'vendor', '.terraform', '__pycache__',
]);

const JS_EXTS = new Set([
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts',
]);
const PY_EXTS = new Set(['.py']);

const TEST_PATH_RE = /(?:^|\/)(?:test|tests|__tests__|spec|specs|e2e|fixtures?|stories)\//i;
const TEST_FILE_RE = /\.(?:test|spec|e2e|stories)\.[a-z0-9]+$/i;

const SUPPRESS_RE = /\bdatetime-ok\b/;

// ---- Pattern regexes ----

// Python: `datetime.now()` / `datetime.datetime.now()` WITHOUT tz= arg
// inside the parens. Conservative — only flag when the whole call fits
// on one line and has no `tz` / `tzinfo` / `timezone` substring.
const PY_NAIVE_NOW_RE = /\b(?:datetime\.)?datetime\.now\s*\(([^)]*)\)/;
const PY_UTCNOW_RE = /\b(?:datetime\.)?datetime\.utcnow\s*\(\s*\)/;

// JS: `new Date(year, monthLiteral, ...)` with 4-digit year and month 1..12.
const JS_ONE_BASED_MONTH_RE = /\bnew\s+Date\s*\(\s*(\d{4})\s*,\s*(\d{1,2})\s*(?:,|\))/;

// JS: `Date.UTC(year, monthLiteral, ...)` with same shape.
const JS_UTC_ONE_BASED_RE = /\bDate\.UTC\s*\(\s*(\d{4})\s*,\s*(\d{1,2})\s*(?:,|\))/;

// Moment constructor — flag only when no `.tz(` follows on the same
// line and no `moment.tz(` form (which is explicit).
const MOMENT_CALL_RE = /\bmoment\s*\(/;
const MOMENT_TZ_RE = /\bmoment\.tz\s*\(|\.tz\s*\(/;

class DatetimeBugModule extends BaseModule {
  constructor() {
    super('datetimeBug', 'Datetime / timezone bug detector — naive datetimes, 0-vs-1 month, moment-legacy');
  }

  async run(result, config) {
    const projectRoot = (config && config.projectRoot) || process.cwd();
    const files = this._collect(projectRoot);

    if (files.length === 0) {
      result.addCheck('datetime-bug:no-files', true, {
        severity: 'info',
        message: 'No source files to scan',
      });
      return;
    }

    result.addCheck('datetime-bug:scanning', true, {
      severity: 'info',
      message: `Scanning ${files.length} file(s)`,
      fileCount: files.length,
    });

    let issues = 0;
    for (const abs of files) {
      const rel = path.relative(projectRoot, abs).replace(/\\/g, '/');
      let text;
      try {
        text = fs.readFileSync(abs, 'utf-8');
      } catch {
        continue;
      }
      if (text.length > 5 * 1024 * 1024) continue;

      const ext = path.extname(abs).toLowerCase();
      if (JS_EXTS.has(ext)) {
        issues += this._scanJs(rel, text, result);
      } else if (PY_EXTS.has(ext)) {
        issues += this._scanPy(rel, text, result);
      }
    }

    result.addCheck('datetime-bug:summary', true, {
      severity: 'info',
      message: `${files.length} file(s) scanned, ${issues} issue(s)`,
      fileCount: files.length,
      issueCount: issues,
    });
  }

  _collect(root) {
    const out = [];
    const walk = (dir) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (EXCLUDE_DIRS.has(e.name)) continue;
        if (e.name.startsWith('.') && e.name !== '.') continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          walk(full);
        } else if (e.isFile()) {
          const ext = path.extname(e.name).toLowerCase();
          if (JS_EXTS.has(ext) || PY_EXTS.has(ext)) out.push(full);
        }
      }
    };
    walk(root);
    return out;
  }

  _scanJs(rel, text, result) {
    const isTest = TEST_PATH_RE.test(rel) || TEST_FILE_RE.test(rel);
    const errSev = isTest ? 'info' : 'warning'; // JS rules are already warning-level; test downgrades to info
    const lines = text.split('\n');
    let issues = 0;
    let inBlock = false;

    for (let i = 0; i < lines.length; i += 1) {
      let line = lines[i];

      // Block-comment state
      if (inBlock) {
        const endIdx = line.indexOf('*/');
        if (endIdx === -1) continue;
        line = line.slice(endIdx + 2);
        inBlock = false;
      }
      const startBlock = line.indexOf('/*');
      if (startBlock !== -1) {
        const endBlock = line.indexOf('*/', startBlock + 2);
        if (endBlock === -1) {
          inBlock = true;
          line = line.slice(0, startBlock);
        } else {
          line = line.slice(0, startBlock) + line.slice(endBlock + 2);
        }
      }
      // Strip line comments
      const lc = line.indexOf('//');
      if (lc !== -1) line = line.slice(0, lc);

      if (this._suppressed(lines, i)) continue;

      // Rule 3: new Date(y, m, d) with m in 1..12
      const m1 = JS_ONE_BASED_MONTH_RE.exec(line);
      if (m1) {
        const year = parseInt(m1[1], 10);
        const month = parseInt(m1[2], 10);
        if (year >= 1900 && year <= 2100 && month >= 1 && month <= 12) {
          result.addCheck(`datetime-bug:one-based-month:${rel}:${i + 1}`, false, {
            severity: errSev,
            message: `new Date(${year}, ${month}, ...) — JS months are 0-indexed. Month ${month} means ${this._monthName(month)}, did you mean ${this._monthName(month - 1)}?`,
            file: rel,
            line: i + 1,
            year,
            monthLiteral: month,
          });
          issues += 1;
        }
      }

      // Rule 4: Date.UTC(y, m, d) with m in 1..12
      const m2 = JS_UTC_ONE_BASED_RE.exec(line);
      if (m2) {
        const year = parseInt(m2[1], 10);
        const month = parseInt(m2[2], 10);
        if (year >= 1900 && year <= 2100 && month >= 1 && month <= 12) {
          result.addCheck(`datetime-bug:utc-one-based-month:${rel}:${i + 1}`, false, {
            severity: errSev,
            message: `Date.UTC(${year}, ${month}, ...) — Date.UTC months are 0-indexed. Month ${month} means ${this._monthName(month)}, did you mean ${this._monthName(month - 1)}?`,
            file: rel,
            line: i + 1,
            year,
            monthLiteral: month,
          });
          issues += 1;
        }
      }

      // Rule 5: moment() without .tz
      if (MOMENT_CALL_RE.test(line) && !MOMENT_TZ_RE.test(line)) {
        // Skip if it's `import moment from` / `require('moment')`
        if (/\b(?:import|require)\b/.test(line)) continue;
        // Skip comments / type annotations
        if (/^\s*\*/.test(line)) continue;
        result.addCheck(`datetime-bug:moment-no-tz:${rel}:${i + 1}`, false, {
          severity: errSev,
          message: `moment() without .tz(...) — silently uses local time. Migrate to Luxon / date-fns / Temporal.`,
          file: rel,
          line: i + 1,
        });
        issues += 1;
      }
    }
    return issues;
  }

  _scanPy(rel, text, result) {
    const isTest = TEST_PATH_RE.test(rel) || TEST_FILE_RE.test(rel);
    const errSev = isTest ? 'warning' : 'error';
    const lines = text.split('\n');
    let issues = 0;
    let inDocstring = false;
    let docQuote = null;

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];

      // Docstring tracking — triple-quoted strings only on their own line
      if (inDocstring) {
        if (line.includes(docQuote)) {
          inDocstring = false;
          docQuote = null;
        }
        continue;
      }
      const m3 = line.match(/^\s*(["']{3})/);
      if (m3) {
        // Single-line triple-quoted?
        const rest = line.slice(line.indexOf(m3[1]) + 3);
        if (!rest.includes(m3[1])) {
          inDocstring = true;
          docQuote = m3[1];
          continue;
        }
      }

      // Line comments
      let codeLine = line;
      const hashIdx = this._findUnquotedHash(codeLine);
      if (hashIdx !== -1) codeLine = codeLine.slice(0, hashIdx);

      if (this._suppressed(lines, i)) continue;

      // Rule 1: datetime.now() without tz=
      const m1 = PY_NAIVE_NOW_RE.exec(codeLine);
      if (m1) {
        const args = m1[1];
        // Only flag if args is empty OR args contains no tz/tzinfo/timezone
        if (!/tz(?:info)?\s*=|timezone\b|pytz\b|ZoneInfo\b|zoneinfo\b/.test(args)) {
          result.addCheck(`datetime-bug:naive-now:${rel}:${i + 1}`, false, {
            severity: errSev,
            message: `datetime.now() without tz= argument — returns naive datetime. Use datetime.now(timezone.utc) or datetime.now(ZoneInfo("...")).`,
            file: rel,
            line: i + 1,
          });
          issues += 1;
        }
      }

      // Rule 2: datetime.utcnow() — always deprecated
      if (PY_UTCNOW_RE.test(codeLine)) {
        result.addCheck(`datetime-bug:utcnow-deprecated:${rel}:${i + 1}`, false, {
          severity: errSev,
          message: `datetime.utcnow() is deprecated (Python 3.12+) and returns a naive datetime. Use datetime.now(timezone.utc).`,
          file: rel,
          line: i + 1,
        });
        issues += 1;
      }
    }
    return issues;
  }

  _suppressed(lines, i) {
    return (lines[i] && SUPPRESS_RE.test(lines[i])) ||
      (i > 0 && lines[i - 1] && SUPPRESS_RE.test(lines[i - 1]));
  }

  _findUnquotedHash(line) {
    let inStr = null;
    for (let j = 0; j < line.length; j += 1) {
      const ch = line[j];
      if (inStr) {
        if (ch === '\\') { j += 1; continue; }
        if (ch === inStr) inStr = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        inStr = ch;
        continue;
      }
      if (ch === '#') return j;
    }
    return -1;
  }

  _monthName(n) {
    const names = ['January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'];
    if (n < 0 || n > 11) return `month-${n}`;
    return names[n];
  }
}

module.exports = DatetimeBugModule;
