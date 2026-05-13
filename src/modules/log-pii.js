/**
 * Logging Hygiene / PII-in-Logs Detector Module.
 *
 * The GDPR / CCPA / PCI-DSS violation that ships in every codebase
 * at some point: `console.log(req.body)` on the login route.
 * `logger.info(user)` on a "successful auth" line. `log.debug(\`req
 * headers: ${JSON.stringify(headers)}\`)`. Every one of those lines
 * writes a password, an Authorization bearer token, a session
 * cookie, a credit-card number, or a social-security number into a
 * log-aggregation stack that ships to Datadog / Splunk / Elastic
 * where seventeen engineers and four contractors can grep it.
 *
 * Real postmortems:
 *   - Facebook 2019: ~600M plaintext passwords in internal logs.
 *   - Twitter 2018: 330M plaintext passwords in internal logs.
 *   - GitHub 2018: 10M plaintext passwords in internal logs.
 *   - Robinhood 2019: multi-year stored plaintext passwords in
 *     internal logs.
 *
 * The pattern is always the same: a well-intentioned "let's log
 * the request for debugging" line made it to prod and nobody
 * noticed the request body contained credentials.
 *
 * We target four high-precision shapes:
 *
 *   1. Logger call with an explicitly sensitive identifier argument:
 *      `console.log(password)`, `logger.info(token)`,
 *      `log.debug(apiKey)`, `console.warn(authorization)`.
 *      These are near-certain bugs.
 *
 *   2. Logger call with a request / body / headers / user object
 *      as a direct argument or via `JSON.stringify(...)`.
 *      `console.log(req)`, `logger.info(req.body)`,
 *      `log.debug(JSON.stringify(user))`, `console.warn(headers)`.
 *      Any of these can leak PII or auth material depending on
 *      the request shape.
 *
 *   3. Logger call with a template-string interpolation of a
 *      sensitive identifier or object:
 *      `log.info(\`user=${user}\`)`, `console.log(\`req: ${req.body}\`)`.
 *
 *   4. `dump()` / `pp()` / `pprint()` / `print(...)` in Python on
 *      sensitive names (entry-level bug; we flag it warning).
 *
 * Rules:
 *
 *   error:   Logger call with a sensitive identifier (password,
 *            token, apiKey, secret, credential, authorization,
 *            cookie, ssn, creditCard, cvv, pin).
 *            (rule: `log-pii:sensitive-arg:<rel>:<line>`)
 *
 *   warning: Logger call with a request / body / user / headers
 *            object as a direct argument.
 *            (rule: `log-pii:object-dump:<rel>:<line>`)
 *
 *   warning: Logger call with JSON.stringify(...) of a sensitive
 *            or request-shaped object.
 *            (rule: `log-pii:stringify-dump:<rel>:<line>`)
 *
 *   warning: Python print(...) on a sensitive identifier.
 *            (rule: `log-pii:py-print-sensitive:<rel>:<line>`)
 *
 * Suppressions:
 *   - `// log-safe` / `# log-safe` on same or preceding line.
 *   - Test / spec / fixture paths downgrade error → warning.
 *
 * Competitors:
 *   - ESLint has nothing.
 *   - Pylint has nothing.
 *   - Semgrep has a handful of rules with high FP.
 *   - SonarQube has one PHP-only rule on `var_dump`.
 *   - Snyk Code catches some but requires their SaaS.
 *   - Nothing unifies JS + Python + template-string + stringify-
 *     dump + sensitive-identifier + object-dump at the gate.
 *
 * TODO(gluecron): host-neutral — pure static scan.
 */

const BaseModule = require('./base-module');
const fs = require('fs');
const path = require('path');

const EXCLUDE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.gatetest',
  '.next', 'out', 'target', 'vendor', '.terraform', '__pycache__',
]);

const JS_EXTS = new Set([
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts',
]);
const PY_EXTS = new Set(['.py']);

const TEST_PATH_RE = /(?:^|\/)(?:test|tests|__tests__|spec|specs|e2e|fixtures?|stories)\//i;
const TEST_FILE_RE = /\.(?:test|spec|e2e|stories)\.[a-z0-9]+$/i;

const SUPPRESS_RE = /\blog-safe\b/;

// Sensitive identifier names — arguments named these are nearly
// always direct credentials or PII.
const SENSITIVE_RE =
  /^(password|passwd|pwd|token|tokens|apikey|api_key|apiToken|api_token|secret|secrets|credential|credentials|authorization|auth|accessToken|access_token|refreshToken|refresh_token|idToken|id_token|jwt|bearer|cookie|cookies|session|sessionid|session_id|ssn|socialSecurity|social_security|creditCard|credit_card|cardNumber|card_number|cvv|cvc|pin|privateKey|private_key|pass|userPassword|user_password)$/i;

// Object-like identifiers that commonly carry PII or credentials.
// A logger call with one of these as the entire argument is a
// PII-leak smell. We deliberately exclude highly-ambiguous names
// like `event`, `context`, `data`, `input`, `row` because they
// are as often used for string labels or primitive values as for
// full-dump objects — the FP rate is too high.
const OBJECT_DUMP_RE =
  /^(req|request|body|payload|user|member|account|profile|customer|headers?|cookies?|authHeader|session|formData|formdata)$/i;

// JS logger call shapes (method name is captured to produce a good
// error message).
const JS_LOGGER_CALL_RE =
  /\b(?:console|logger|log|logging|winston|pino|bunyan|morgan|debug|fastify\.log|this\.logger|this\.log|ctx\.log)\.(log|debug|info|warn|warning|error|fatal|trace|verbose)\s*\(/;

// Python print/logger shapes.
const PY_LOGGER_CALL_RE =
  /\b(?:print|logger|log|logging|structlog)\.?(info|debug|warning|warn|error|exception|critical|print)?\s*\(/;
// Bare Python print(): `print(...)` matches below too.
const PY_PRINT_RE = /\bprint\s*\(/;

class LogPiiModule extends BaseModule {
  constructor() {
    super('logPii', 'Logging-hygiene / PII-in-logs detector — catches credentials, tokens, and request objects logged in plaintext');
  }

  async run(result, config) {
    const projectRoot = (config && config.projectRoot) || process.cwd();
    const files = this._collect(projectRoot);

    if (files.length === 0) {
      result.addCheck('log-pii:no-files', true, {
        severity: 'info',
        message: 'No source files to scan',
      });
      return;
    }

    result.addCheck('log-pii:scanning', true, {
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

    result.addCheck('log-pii:summary', true, {
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
      const lc = line.indexOf('//');
      if (lc !== -1) line = line.slice(0, lc);

      if (this._suppressed(lines, i)) continue;

      // Strip string literal content so that logger patterns appearing
      // inside description strings or test fixtures don't false-positive.
      // We blank the content of single/double-quoted strings but preserve
      // the quotes themselves so the rest of the line structure is intact.
      const lineForMatch = this._blankStringContent(line);

      const match = JS_LOGGER_CALL_RE.exec(lineForMatch);
      if (!match) continue;
      const method = match[1];
      const callStart = match.index + match[0].length;
      const args = this._extractArgs(line, callStart);
      if (!args) continue;

      // Rule 1: argument is a bare sensitive identifier
      for (const arg of args) {
        const ident = this._bareIdentifier(arg);
        if (ident && SENSITIVE_RE.test(ident)) {
          result.addCheck(`log-pii:sensitive-arg:${rel}:${i + 1}`, false, {
            severity: errSev,
            message: `Logger ${method}() with sensitive identifier "${ident}" — plaintext credential / PII leak to log aggregation`,
            file: rel,
            line: i + 1,
            method,
            identifier: ident,
          });
          issues += 1;
          continue;
        }
        // Rule 2: argument is a bare object-dump identifier
        if (ident && OBJECT_DUMP_RE.test(ident)) {
          result.addCheck(`log-pii:object-dump:${rel}:${i + 1}`, false, {
            severity: warnSev,
            message: `Logger ${method}() with full object "${ident}" — may contain request body / headers / credentials`,
            file: rel,
            line: i + 1,
            method,
            identifier: ident,
          });
          issues += 1;
          continue;
        }
        // Rule 3: argument is `JSON.stringify(x)` where x is
        // sensitive or object-dump
        const sm = arg.match(/^JSON\.stringify\s*\(\s*([A-Za-z_$][\w$]*)/);
        if (sm) {
          const inner = sm[1];
          if (SENSITIVE_RE.test(inner) || OBJECT_DUMP_RE.test(inner)) {
            result.addCheck(`log-pii:stringify-dump:${rel}:${i + 1}`, false, {
              severity: warnSev,
              message: `Logger ${method}() with JSON.stringify(${inner}) — serialises full object including PII / credentials`,
              file: rel,
              line: i + 1,
              method,
              identifier: inner,
            });
            issues += 1;
            continue;
          }
        }
        // Rule 4: argument is a template string containing a BARE
        // ${sensitive} or ${object} interpolation. We require the
        // closing `}` directly after the identifier so that shapes
        // like `${auth.type}` or `${event.name}` (which are label-
        // shaped field access, not object dumps) don't FP.
        if (arg.startsWith('`')) {
          const interp = Array.from(arg.matchAll(/\$\{\s*([A-Za-z_$][\w$]*)\s*\}/g));
          for (const intr of interp) {
            const ident2 = intr[1];
            if (SENSITIVE_RE.test(ident2)) {
              result.addCheck(`log-pii:sensitive-interp:${rel}:${i + 1}`, false, {
                severity: errSev,
                message: `Logger ${method}() template-string interpolates sensitive identifier "${ident2}"`,
                file: rel,
                line: i + 1,
                method,
                identifier: ident2,
              });
              issues += 1;
              break;
            }
            if (OBJECT_DUMP_RE.test(ident2)) {
              result.addCheck(`log-pii:object-interp:${rel}:${i + 1}`, false, {
                severity: warnSev,
                message: `Logger ${method}() template-string interpolates full object "${ident2}" — may contain PII / credentials`,
                file: rel,
                line: i + 1,
                method,
                identifier: ident2,
              });
              issues += 1;
              break;
            }
          }
        }
      }
    }
    return issues;
  }

  _scanPy(rel, text, result) {
    const isTest = TEST_PATH_RE.test(rel) || TEST_FILE_RE.test(rel);
    const errSev = isTest ? 'warning' : 'error';
    const warnSev = isTest ? 'info' : 'warning';
    const lines = text.split('\n');
    let issues = 0;
    let inDocstring = false;
    let docQuote = null;

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];

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

      let codeLine = line;
      const hashIdx = this._findUnquotedHash(codeLine);
      if (hashIdx !== -1) codeLine = codeLine.slice(0, hashIdx);

      if (this._suppressed(lines, i)) continue;

      // Python logger call — logger.{info,debug,...}(...) OR
      // plain print(...). We treat both.
      let callMatch = PY_LOGGER_CALL_RE.exec(codeLine);
      if (!callMatch) {
        callMatch = PY_PRINT_RE.exec(codeLine);
        if (!callMatch) continue;
      }
      const callStart = callMatch.index + callMatch[0].length;
      const args = this._extractArgs(codeLine, callStart);
      if (!args) continue;

      for (const arg of args) {
        const ident = this._bareIdentifier(arg);
        if (ident && SENSITIVE_RE.test(ident)) {
          result.addCheck(`log-pii:py-print-sensitive:${rel}:${i + 1}`, false, {
            severity: errSev,
            message: `Python print/log with sensitive identifier "${ident}" — plaintext credential leak`,
            file: rel,
            line: i + 1,
            identifier: ident,
          });
          issues += 1;
          continue;
        }
        if (ident && OBJECT_DUMP_RE.test(ident)) {
          result.addCheck(`log-pii:py-object-dump:${rel}:${i + 1}`, false, {
            severity: warnSev,
            message: `Python print/log with full object "${ident}" — may contain PII / credentials`,
            file: rel,
            line: i + 1,
            identifier: ident,
          });
          issues += 1;
        }
      }
    }
    return issues;
  }

  /**
   * Extract arguments from a call where paren is already open at
   * `startIdx`. Splits on top-level commas (respecting nested
   * parens, brackets, braces, strings, template strings).
   */
  _extractArgs(line, startIdx) {
    const parts = [];
    let depth = 1;
    let cur = '';
    let inStr = null;
    let j = startIdx;
    while (j < line.length) {
      const ch = line[j];
      if (inStr) {
        cur += ch;
        if (ch === '\\') {
          if (j + 1 < line.length) cur += line[j + 1];
          j += 2;
          continue;
        }
        if (ch === inStr) inStr = null;
        j += 1;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        inStr = ch;
        cur += ch;
        j += 1;
        continue;
      }
      if (ch === '(' || ch === '[' || ch === '{') {
        depth += 1;
        cur += ch;
        j += 1;
        continue;
      }
      if (ch === ')' || ch === ']' || ch === '}') {
        depth -= 1;
        if (depth === 0) {
          if (cur.trim()) parts.push(cur.trim());
          return parts;
        }
        cur += ch;
        j += 1;
        continue;
      }
      if (ch === ',' && depth === 1) {
        if (cur.trim()) parts.push(cur.trim());
        cur = '';
        j += 1;
        continue;
      }
      cur += ch;
      j += 1;
    }
    // Unterminated — skip
    return null;
  }

  _bareIdentifier(arg) {
    const m = arg.match(/^([A-Za-z_$][\w$]*)$/);
    return m ? m[1] : null;
  }

  _suppressed(lines, i) {
    return (lines[i] && SUPPRESS_RE.test(lines[i])) ||
      (i > 0 && lines[i - 1] && SUPPRESS_RE.test(lines[i - 1]));
  }

  _blankStringContent(line) {
    // Replace content of single- and double-quoted strings with spaces so
    // that patterns inside string literals don't false-positive. Preserves
    // the original string positions (character counts unchanged).
    let out = '';
    let i = 0;
    while (i < line.length) {
      const ch = line[i];
      if (ch === '"' || ch === "'") {
        out += ch;
        i++;
        while (i < line.length && line[i] !== ch && line[i] !== '\n') {
          if (line[i] === '\\') { out += '  '; i += 2; continue; }
          out += ' ';
          i++;
        }
        if (i < line.length) { out += line[i]; i++; }
        continue;
      }
      out += ch;
      i++;
    }
    return out;
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

module.exports = LogPiiModule;
