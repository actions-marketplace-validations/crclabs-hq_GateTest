/**
 * Money / Currency Float-Safety Detector Module.
 *
 * Storing currency in a floating-point type is the textbook bug
 * that every fintech eventually ships. `0.1 + 0.2 !== 0.3` is the
 * punchline — a $100.00 invoice becomes $99.99999999... after three
 * additions; a $0.01 fee over a million transactions accrues
 * hundreds of dollars of drift; a $19.99 line item rounds to $20.00
 * on display and to $19.989 in the database. Regulators call this
 * fraud. Tax authorities call this fraud. Your customers call this
 * fraud.
 *
 * The fix is always: use a fixed-precision decimal type. In JS:
 * Decimal.js, big.js, bignumber.js, dinero.js, currency.js. In
 * Python: the `decimal.Decimal` type from the stdlib. In Go:
 * `math/big` or `shopspring/decimal`. In Java: `BigDecimal`. The
 * anti-pattern we catch: a money-named variable (`price`, `total`,
 * `amount`, `tax`, `subtotal`, `balance`, currency codes like `usd`,
 * `eur`, etc.) assigned from `parseFloat(...)` / `Number(...)` in
 * JS or `float(...)` in Python, or receiving `.toFixed(0)` /
 * `.toFixed(1)` (sub-cent precision) when no decimal library is
 * visible in the file.
 *
 * Rules:
 *
 *   error:   JS: money-named variable assigned from `parseFloat(...)`
 *            or `Number(...)`.
 *            (rule: `money-float:js-parse-float:<rel>:<line>`)
 *
 *   error:   Python: money-named variable assigned from `float(...)`.
 *            (rule: `money-float:py-float-cast:<rel>:<line>`)
 *
 *   warning: `.toFixed(0)` or `.toFixed(1)` on a money-named variable.
 *            Sub-cent precision — rounding bugs are almost certain.
 *            (rule: `money-float:insufficient-precision:<rel>:<line>`)
 *
 *   info:    Decimal library detected (safe-harbour marker).
 *            (rule: `money-float:decimal-library-ok`)
 *
 * Suppressions:
 *   - `// money-float-ok` / `# money-float-ok` on same or preceding line.
 *   - Test / spec / fixture paths downgrade error → warning.
 *   - If file imports a known decimal library (decimal.js, big.js,
 *     bignumber.js, dinero.js, currency.js, @decimal, or Python
 *     `decimal` / `from decimal import Decimal`), the entire file is
 *     treated as safe-harbour — no float-cast rule fires.
 *
 * Competitors:
 *   - SonarQube has one Java-only rule on `float`/`double` for
 *     money — nothing for JS / Python / Go.
 *   - ESLint has nothing. Pylint has nothing. ruff has nothing.
 *   - Semgrep has a handful of community rules with high FP.
 *   - Nothing unifies JS + Python + library-aware safe-harbour at the gate.
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

const SUPPRESS_RE = /\bmoney-float-ok\b/;

// Money-named identifiers. We anchor on the IDENTIFIER, not the
// value. Conservative list to keep FP rate low — only terms that
// are unambiguously about money.
const MONEY_NAME_RE =
  /\b(price|amount|total|cost|fee|tax|subtotal|balance|payment|charge|refund|credit|debit|salary|wage|rent|bill|invoice|revenue|profit|margin|discount|coupon|tip|gratuity|usd|eur|gbp|jpy|cad|aud|nzd|chf|dollar|dollars|euro|euros|pound|pounds|yen|yuan|rupee|peso|cents?)s?\b/i;

// JS: `const price = parseFloat(...)` / `let total = Number(...)` /
// `var amount = +input`.
const JS_ASSIGN_FLOAT_RE =
  /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:\w<>\s,|&]*=\s*(parseFloat|Number)\s*\(/;
// Class / object property form: `this.price = parseFloat(...)` /
// `obj.total = Number(...)`.
const JS_PROP_FLOAT_RE =
  /\b(?:this|[A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*=\s*(parseFloat|Number)\s*\(/;

// Python: `price = float(x)` / `self.total = float(x)`.
const PY_ASSIGN_FLOAT_RE =
  /\b(?:self\.)?([A-Za-z_][\w]*)\s*(?::\s*[\w\[\]., ]+)?\s*=\s*float\s*\(/;

// `.toFixed(N)`. We capture N so we can check precision.
const TOFIXED_RE = /([A-Za-z_$][\w$]*)\.toFixed\s*\(\s*(\d+)\s*\)/;

// Library-detection patterns. If any of these appear anywhere in
// the file, we treat the file as safe-harbour for the float-cast
// rules (but .toFixed is still checked, since devs sometimes use
// both incorrectly).
const LIBRARY_PATTERNS = [
  /\brequire\s*\(\s*['"](decimal\.js|big\.js|bignumber\.js|dinero\.js|currency\.js|@decimal|money-math|cashify)['"]/,
  /\bfrom\s+['"](decimal\.js|big\.js|bignumber\.js|dinero\.js|currency\.js|@decimal|money-math|cashify)['"]/,
  /\bimport\s+[\s\S]{0,100}\bfrom\s+['"](decimal\.js|big\.js|bignumber\.js|dinero\.js|currency\.js|@decimal|money-math|cashify)['"]/,
  /\bfrom\s+decimal\s+import\s+Decimal\b/,           // Python stdlib
  /\bimport\s+decimal\b/,                             // Python stdlib
  /\bDinero\s*\(/,                                    // dinero.js constructor
  /\bnew\s+Decimal\s*\(/,                             // decimal.js constructor
  /\bnew\s+BigNumber\s*\(/,                           // bignumber.js constructor
  /\bnew\s+Big\s*\(/,                                 // big.js constructor
];

class MoneyFloatModule extends BaseModule {
  constructor() {
    super('moneyFloat', 'Money / currency float-safety detector — catches IEEE-754 precision loss on currency-named variables');
  }

  async run(result, config) {
    const projectRoot = (config && config.projectRoot) || process.cwd();
    const files = this._collect(projectRoot);

    if (files.length === 0) {
      result.addCheck('money-float:no-files', true, {
        severity: 'info',
        message: 'No source files to scan',
      });
      return;
    }

    result.addCheck('money-float:scanning', true, {
      severity: 'info',
      message: `Scanning ${files.length} file(s)`,
      fileCount: files.length,
    });

    let issues = 0;
    let filesWithLibrary = 0;

    for (const abs of files) {
      const rel = path.relative(projectRoot, abs).replace(/\\/g, '/');
      let text;
      try {
        text = fs.readFileSync(abs, 'utf-8');
      } catch {
        continue;
      }
      if (text.length > 5 * 1024 * 1024) continue;

      const hasLibrary = LIBRARY_PATTERNS.some((re) => re.test(text));
      if (hasLibrary) filesWithLibrary += 1;

      const ext = path.extname(abs).toLowerCase();
      if (JS_EXTS.has(ext)) {
        issues += this._scanJs(rel, text, result, hasLibrary);
      } else if (PY_EXTS.has(ext)) {
        issues += this._scanPy(rel, text, result, hasLibrary);
      }
    }

    if (filesWithLibrary > 0) {
      result.addCheck('money-float:decimal-library-ok', true, {
        severity: 'info',
        message: `${filesWithLibrary} file(s) import a decimal-safe library — safe-harbour applied`,
        fileCount: filesWithLibrary,
      });
    }

    result.addCheck('money-float:summary', true, {
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

  _scanJs(rel, text, result, hasLibrary) {
    const isTest = TEST_PATH_RE.test(rel) || TEST_FILE_RE.test(rel);
    const errSev = isTest ? 'warning' : 'error';
    const warnSev = isTest ? 'info' : 'warning';
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

      // Rule 1: money-named var assigned from parseFloat / Number
      if (!hasLibrary) {
        const m1 = JS_ASSIGN_FLOAT_RE.exec(line);
        if (m1 && MONEY_NAME_RE.test(m1[1])) {
          result.addCheck(`money-float:js-parse-float:${rel}:${i + 1}`, false, {
            severity: errSev,
            message: `Money-named variable "${m1[1]}" assigned from ${m1[2]}(...) — IEEE-754 precision loss. Use Decimal.js / big.js / dinero.js.`,
            file: rel,
            line: i + 1,
            variable: m1[1],
          });
          issues += 1;
        }
        const m2 = JS_PROP_FLOAT_RE.exec(line);
        if (m2 && MONEY_NAME_RE.test(m2[1])) {
          result.addCheck(`money-float:js-parse-float-prop:${rel}:${i + 1}`, false, {
            severity: errSev,
            message: `Money-named property ".${m2[1]}" assigned from ${m2[2]}(...) — IEEE-754 precision loss.`,
            file: rel,
            line: i + 1,
            property: m2[1],
          });
          issues += 1;
        }
      }

      // Rule 3: .toFixed(N) with N < 2 on a money-named receiver
      const m3 = TOFIXED_RE.exec(line);
      if (m3) {
        const receiver = m3[1];
        const precision = parseInt(m3[2], 10);
        if (precision < 2 && MONEY_NAME_RE.test(receiver)) {
          result.addCheck(`money-float:insufficient-precision:${rel}:${i + 1}`, false, {
            severity: warnSev,
            message: `${receiver}.toFixed(${precision}) — sub-cent precision on money variable. Use .toFixed(2) or a decimal library.`,
            file: rel,
            line: i + 1,
            variable: receiver,
            precision,
          });
          issues += 1;
        }
      }
    }
    return issues;
  }

  _scanPy(rel, text, result, hasLibrary) {
    if (hasLibrary) return 0;  // file uses `decimal` module — safe
    const isTest = TEST_PATH_RE.test(rel) || TEST_FILE_RE.test(rel);
    const errSev = isTest ? 'warning' : 'error';
    const lines = text.split('\n');
    let issues = 0;
    let inDocstring = false;
    let docQuote = null;

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];

      // Docstring tracking
      if (inDocstring) {
        if (line.includes(docQuote)) {
          inDocstring = false;
          docQuote = null;
        }
        continue;
      }
      const m3 = line.match(/^\s*(["']{3})/);
      if (m3) {
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

      const m = PY_ASSIGN_FLOAT_RE.exec(codeLine);
      if (m && MONEY_NAME_RE.test(m[1])) {
        result.addCheck(`money-float:py-float-cast:${rel}:${i + 1}`, false, {
          severity: errSev,
          message: `Money-named variable "${m[1]}" assigned from float(...) — IEEE-754 precision loss. Use decimal.Decimal.`,
          file: rel,
          line: i + 1,
          variable: m[1],
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
}

module.exports = MoneyFloatModule;
