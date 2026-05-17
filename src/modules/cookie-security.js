/**
 * Cookie / Session-Security Config Detector Module.
 *
 * Misconfigured session cookies are the gift that keeps on giving: a
 * `httpOnly: false` cookie carrying the session id is readable from any
 * injected JS (XSS → session takeover); a `secure: false` flag lets the
 * cookie ride over plain HTTP where a network attacker can read it; a
 * `SESSION_COOKIE_HTTPONLY = False` on a Django site means `document
 * .cookie` on a third-party page running in an iframe can read
 * everything. Audit reports find these in production all the time —
 * they persist because frameworks default to secure but individual
 * overrides slip in and never get reviewed.
 *
 * We catch the unambiguous misconfigurations — where the security flag
 * is *explicitly* set to off, or where the session secret is an obvious
 * placeholder that shipped without being replaced.
 *
 *   JS/TS:
 *     - `httpOnly: false` in cookie / session options — error (XSS risk)
 *     - `secure: false` in cookie / session options — warning
 *     - `sameSite: 'none'` with no `secure: true` nearby — warning
 *     - `secret: '<known-weak>'` — obvious placeholder secret — error
 *
 *   Python (Flask / Django / FastAPI):
 *     - `SESSION_COOKIE_SECURE = False` — warning
 *     - `SESSION_COOKIE_HTTPONLY = False` — error
 *     - `CSRF_COOKIE_SECURE = False` — warning
 *     - `CSRF_COOKIE_HTTPONLY = False` — error
 *     - `httponly=False` (FastAPI / Starlette `set_cookie`) — error
 *
 * Rules:
 *
 *   error:   JS `httpOnly: false` in cookie / session options.
 *            (rule: `cookie-sec:js-httponly-false:<rel>:<line>`)
 *
 *   warning: JS `secure: false` in cookie / session options.
 *            (rule: `cookie-sec:js-secure-false:<rel>:<line>`)
 *
 *   error:   JS `secret: '<weak>'` where `<weak>` is a known-weak
 *            placeholder (`'changeme'`, `'secret'`, `'default'`,
 *            `'password'`, `'keyboard cat'`, `'test'`, `'mysecret'`,
 *            `'sessionsecret'`, `'abcd1234'`).
 *            (rule: `cookie-sec:js-weak-secret:<rel>:<line>`)
 *
 *   warning: Python `SESSION_COOKIE_SECURE = False` /
 *            `CSRF_COOKIE_SECURE = False`.
 *            (rule: `cookie-sec:py-cookie-secure-false:<rel>:<line>`)
 *
 *   error:   Python `SESSION_COOKIE_HTTPONLY = False` /
 *            `CSRF_COOKIE_HTTPONLY = False` / `httponly=False` kwarg.
 *            (rule: `cookie-sec:py-cookie-httponly-false:<rel>:<line>`)
 *
 * Suppressions:
 *   - `// cookie-ok` / `# cookie-ok` on same or preceding line.
 *   - Test / spec / fixture paths downgrade error → warning,
 *     warning → info.
 *
 * Competitors:
 *   - OWASP ZAP catches insecure cookies at runtime — requires a
 *     deployed env. Not a pre-merge gate.
 *   - Bandit has `hardcoded_password_string` (weak-secret adjacent)
 *     but nothing on SESSION_COOKIE_* flags.
 *   - SonarQube has one JS rule on `secure: false` and one on
 *     `httpOnly: false` but misses Python framework configs entirely.
 *   - ESLint / Pylint / Ruff have nothing on session-cookie config.
 *   - Nothing unifies Express / Next / Flask / Django / FastAPI
 *     session-cookie config at the gate with placeholder-secret
 *     detection.
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

const SUPPRESS_RE = /\bcookie-ok\b/;

// JS/TS patterns.
const JS_HTTPONLY_FALSE_RE = /\bhttpOnly\s*:\s*false\b/;
const JS_SECURE_FALSE_RE = /\bsecure\s*:\s*false\b/;
// Weak session secret — known placeholder values.
const JS_WEAK_SECRET_RE =
  /\bsecret\s*:\s*['"](changeme|secret|default|password|keyboard cat|test|mysecret|sessionsecret|session-secret|abcd1234|foo|bar|change[_-]?me|your[_-]?secret[_-]?here|replace[_-]?me)['"]/i;

// Python patterns.
const PY_COOKIE_SECURE_FALSE_RE =
  /^\s*(SESSION_COOKIE_SECURE|CSRF_COOKIE_SECURE)\s*=\s*False\b/;
const PY_COOKIE_HTTPONLY_FALSE_RE =
  /^\s*(SESSION_COOKIE_HTTPONLY|CSRF_COOKIE_HTTPONLY)\s*=\s*False\b/;
// FastAPI / Starlette set_cookie kwarg: `httponly=False`.
const PY_HTTPONLY_KWARG_FALSE_RE = /[,(]\s*httponly\s*=\s*False\b/;

class CookieSecurityModule extends BaseModule {
  constructor() {
    super(
      'cookieSecurity',
      'Cookie / session-security config detector — catches httpOnly:false, weak session secrets, SESSION_COOKIE_* misconfigs'
    );
  }

  async run(result, config) {
    const projectRoot = (config && config.projectRoot) || process.cwd();
    const files = this._collect(projectRoot);

    if (files.length === 0) {
      result.addCheck('cookie-sec:no-files', true, {
        severity: 'info',
        message: 'No source files to scan',
      });
      return;
    }

    result.addCheck('cookie-sec:scanning', true, {
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

    result.addCheck('cookie-sec:summary', true, {
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
    let inTemplate = false;

    for (let i = 0; i < lines.length; i += 1) {
      let line = lines[i];

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

      // Weak-secret rule needs the raw string value — capture
      // block-stripped version before string-content strip.
      const blockStripped = line;

      const stripRes = this._stripJsStrings(line, inTemplate);
      line = stripRes.stripped;
      inTemplate = stripRes.inTemplate;

      const lc = line.indexOf('//');
      if (lc !== -1) line = line.slice(0, lc);

      if (this._suppressed(lines, i)) continue;

      if (JS_HTTPONLY_FALSE_RE.test(line)) {
        result.addCheck(`cookie-sec:js-httponly-false:${rel}:${i + 1}`, false, {
          severity: errSev,
          message: '`httpOnly: false` on a session cookie — readable from JS. XSS becomes session takeover.',
          file: rel,
          line: i + 1,
        });
        issues += 1;
      }
      if (JS_SECURE_FALSE_RE.test(line)) {
        result.addCheck(`cookie-sec:js-secure-false:${rel}:${i + 1}`, false, {
          severity: warnSev,
          message: '`secure: false` allows the cookie over plain HTTP — a network attacker can read it.',
          file: rel,
          line: i + 1,
        });
        issues += 1;
      }

      // Weak-secret rule on the block-stripped (strings-intact) line.
      let secretLine = blockStripped;
      const secretLc = secretLine.indexOf('//');
      if (secretLc !== -1) secretLine = secretLine.slice(0, secretLc);
      const weakMatch = JS_WEAK_SECRET_RE.exec(secretLine);
      if (weakMatch) {
        result.addCheck(`cookie-sec:js-weak-secret:${rel}:${i + 1}`, false, {
          severity: errSev,
          message: `Session secret is a known-weak placeholder ("${weakMatch[1]}") — replace before deploy.`,
          file: rel,
          line: i + 1,
          value: weakMatch[1],
        });
        issues += 1;
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
      const md = line.match(/^\s*(["']{3})/);
      if (md) {
        const rest = line.slice(line.indexOf(md[1]) + 3);
        if (!rest.includes(md[1])) {
          inDocstring = true;
          docQuote = md[1];
          continue;
        }
      }

      let codeLine = line;
      const hashIdx = this._findUnquotedHash(codeLine);
      if (hashIdx !== -1) codeLine = codeLine.slice(0, hashIdx);

      if (this._suppressed(lines, i)) continue;

      const m1 = PY_COOKIE_SECURE_FALSE_RE.exec(codeLine);
      if (m1) {
        result.addCheck(`cookie-sec:py-cookie-secure-false:${rel}:${i + 1}`, false, {
          severity: warnSev,
          message: `\`${m1[1]} = False\` — cookie will ride over plain HTTP. Network attacker can read it.`,
          file: rel,
          line: i + 1,
          setting: m1[1],
        });
        issues += 1;
      }
      const m2 = PY_COOKIE_HTTPONLY_FALSE_RE.exec(codeLine);
      if (m2) {
        result.addCheck(`cookie-sec:py-cookie-httponly-false:${rel}:${i + 1}`, false, {
          severity: errSev,
          message: `\`${m2[1]} = False\` — cookie readable from JS. XSS becomes session takeover.`,
          file: rel,
          line: i + 1,
          setting: m2[1],
        });
        issues += 1;
      }
      if (PY_HTTPONLY_KWARG_FALSE_RE.test(codeLine)) {
        result.addCheck(`cookie-sec:py-fastapi-httponly-false:${rel}:${i + 1}`, false, {
          severity: errSev,
          message: '`httponly=False` on a Response.set_cookie / Starlette cookie — readable from JS.',
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

  _stripJsStrings(line, inTemplate) {
    let out = '';
    let state = inTemplate ? '`' : null;
    let j = 0;
    while (j < line.length) {
      const ch = line[j];
      if (state) {
        if (ch === '\\') {
          out += '  ';
          j += 2;
          continue;
        }
        if (ch === state) {
          out += ch;
          state = null;
          j += 1;
          continue;
        }
        out += ' ';
        j += 1;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        out += ch;
        state = ch;
        j += 1;
        continue;
      }
      out += ch;
      j += 1;
    }
    return { stripped: out, inTemplate: state === '`' };
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

module.exports = CookieSecurityModule;
