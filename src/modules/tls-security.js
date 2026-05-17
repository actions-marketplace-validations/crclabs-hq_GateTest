/**
 * TLS / Certificate-Validation-Bypass Detector Module.
 *
 * "Just disable SSL for dev" is how MITM-vulnerable apps ship to prod.
 * The canonical pattern: a developer hits a self-signed cert on staging,
 * disables validation once, and the flag never gets flipped back. The
 * code now trusts ANY cert — including one issued by an attacker on the
 * network path. Every pentest finds it. Every compliance audit flags it.
 *
 * We catch the loudest, most well-known disable patterns across JS and
 * Python — the ones that cannot be explained away as dev-only because
 * they ship in the same file that calls prod APIs:
 *
 *   JS/TS:
 *     - `rejectUnauthorized: false` — Node https.Agent / tls options
 *     - `NODE_TLS_REJECT_UNAUTHORIZED = "0"` — global nuclear disable
 *     - `process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"` — same
 *     - `strictSSL: false` — `request` lib
 *     - `insecure: true` — some HTTP clients
 *
 *   Python:
 *     - `requests.get/post/...(..., verify=False, ...)` — the classic
 *     - `httpx.Client(verify=False)` / `httpx.get(url, verify=False)`
 *     - `aiohttp.TCPConnector(verify_ssl=False)` / `ssl=False`
 *     - `ssl._create_unverified_context()` — deliberate bypass
 *     - `ctx.check_hostname = False` — hostname-validation disable
 *     - `ctx.verify_mode = ssl.CERT_NONE` — cert-validation disable
 *     - `cert_reqs='CERT_NONE'` — urllib3 PoolManager / HTTPSConnectionPool
 *     - `urllib3.disable_warnings(InsecureRequestWarning)` — the
 *       tell-tale pairing with `verify=False`
 *
 * Rules:
 *
 *   error:   JS `rejectUnauthorized: false`
 *            (rule: `tls-security:js-reject-unauthorized:<rel>:<line>`)
 *
 *   error:   JS `NODE_TLS_REJECT_UNAUTHORIZED = "0"` (any form)
 *            (rule: `tls-security:js-env-bypass:<rel>:<line>`)
 *
 *   error:   JS `strictSSL: false` (request / superagent / got family)
 *            (rule: `tls-security:js-strict-ssl:<rel>:<line>`)
 *
 *   error:   Python `verify=False` or `verify_ssl=False` or `ssl=False`
 *            as a keyword argument.
 *            (rule: `tls-security:py-verify-false:<rel>:<line>`)
 *
 *   error:   Python `ssl._create_unverified_context()`.
 *            (rule: `tls-security:py-unverified-context:<rel>:<line>`)
 *
 *   error:   Python `.check_hostname = False`.
 *            (rule: `tls-security:py-check-hostname-false:<rel>:<line>`)
 *
 *   error:   Python `ssl.CERT_NONE` / `cert_reqs='CERT_NONE'` usage.
 *            (rule: `tls-security:py-cert-none:<rel>:<line>`)
 *
 *   warning: Python `urllib3.disable_warnings(InsecureRequestWarning)`.
 *            (rule: `tls-security:py-disable-warnings:<rel>:<line>`)
 *
 * Suppressions:
 *   - `// tls-ok` / `# tls-ok` on same or preceding line.
 *   - Test / spec / fixture paths downgrade error → warning,
 *     warning → info.
 *
 * Competitors:
 *   - ESLint has nothing cross-cutting. SonarQube has "TLS cert
 *     validation disabled" (`javascript:S4830`) but JS only and
 *     narrow — misses `strictSSL: false`.
 *   - Bandit catches Python `verify=False` for `requests` specifically
 *     but misses httpx / aiohttp / urllib3 PoolManager patterns.
 *   - Snyk Code catches subsets behind its SaaS — no unified gate.
 *   - Nothing unifies Node `rejectUnauthorized` + env bypass + Python
 *     `verify=False` + `_create_unverified_context` + CERT_NONE
 *     across a single static check with suppressions and test-path
 *     downgrade.
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

const SUPPRESS_RE = /\btls-ok\b/;

// JS/TS patterns.
const JS_REJECT_UNAUTHORIZED_RE = /\brejectUnauthorized\s*:\s*false\b/;
// Require `process.env.` / `process.env[...]` prefix so the rule only
// fires on an actual Node env write, not on prose / error-message text
// that references the variable name.
const JS_NODE_TLS_ENV_RE =
  /process\.env\s*(?:\.\s*NODE_TLS_REJECT_UNAUTHORIZED|\[\s*['"]NODE_TLS_REJECT_UNAUTHORIZED['"]\s*\])\s*=\s*['"]?0['"]?/;
const JS_STRICT_SSL_RE = /\bstrictSSL\s*:\s*false\b/;
const JS_INSECURE_RE = /\binsecure\s*:\s*true\b/;

// Python patterns.
// `verify=False`, `verify_ssl=False`, `ssl=False` — but NOT `ssl=False`
// inside a function definition or type annotation. We require it to be
// preceded by a comma or `(` (i.e. actually an argument).
const PY_VERIFY_FALSE_RE = /[,(]\s*(verify|verify_ssl|ssl)\s*=\s*False\b/;
const PY_UNVERIFIED_CTX_RE = /\bssl\._create_unverified_context\s*\(/;
const PY_CHECK_HOSTNAME_FALSE_RE = /\.check_hostname\s*=\s*False\b/;
const PY_CERT_NONE_RE = /\bssl\.CERT_NONE\b|cert_reqs\s*=\s*['"]CERT_NONE['"]/;
const PY_DISABLE_WARNINGS_RE =
  /\burllib3\.disable_warnings\s*\([^)]*InsecureRequestWarning/;

class TlsSecurityModule extends BaseModule {
  constructor() {
    super(
      'tlsSecurity',
      'TLS / cert-validation-bypass detector — catches rejectUnauthorized:false, verify=False, ssl.CERT_NONE, and NODE_TLS_REJECT_UNAUTHORIZED=0'
    );
  }

  async run(result, config) {
    const projectRoot = (config && config.projectRoot) || process.cwd();
    const files = this._collect(projectRoot);

    if (files.length === 0) {
      result.addCheck('tls-security:no-files', true, {
        severity: 'info',
        message: 'No source files to scan',
      });
      return;
    }

    result.addCheck('tls-security:scanning', true, {
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

    result.addCheck('tls-security:summary', true, {
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
    const lines = text.split('\n');
    let issues = 0;
    let inBlock = false;
    let inTemplate = false;

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

      // Capture the block-stripped line BEFORE string-content strip —
      // the env-bypass rule needs the `"0"` literal preserved.
      const blockStripped = line;

      // Strip strings across lines so pattern-mentions in docstrings
      // don't FP for the rules whose patterns don't depend on the
      // string value.
      const stripRes = this._stripJsStrings(line, inTemplate);
      line = stripRes.stripped;
      inTemplate = stripRes.inTemplate;

      const lc = line.indexOf('//');
      if (lc !== -1) line = line.slice(0, lc);

      if (this._suppressed(lines, i)) continue;

      // env-bypass rule: run against block-stripped (line-comment
      // stripped) line so `"0"` is preserved. Strip line comments
      // off that version too.
      let envLine = blockStripped;
      const envLc = envLine.indexOf('//');
      if (envLc !== -1) envLine = envLine.slice(0, envLc);
      if (JS_NODE_TLS_ENV_RE.test(envLine)) {
        result.addCheck(`tls-security:js-env-bypass:${rel}:${i + 1}`, false, {
          severity: errSev,
          message: '`NODE_TLS_REJECT_UNAUTHORIZED = "0"` globally disables TLS validation for the entire Node process. Every outbound HTTPS call becomes vulnerable to MITM.',
          file: rel,
          line: i + 1,
        });
        issues += 1;
      }

      if (JS_REJECT_UNAUTHORIZED_RE.test(line)) {
        result.addCheck(`tls-security:js-reject-unauthorized:${rel}:${i + 1}`, false, {
          severity: errSev,
          message: '`rejectUnauthorized: false` disables TLS cert validation — every cert, including attacker-issued ones, is trusted. MITM risk.',
          file: rel,
          line: i + 1,
        });
        issues += 1;
      }
      if (JS_STRICT_SSL_RE.test(line)) {
        result.addCheck(`tls-security:js-strict-ssl:${rel}:${i + 1}`, false, {
          severity: errSev,
          message: '`strictSSL: false` disables TLS cert validation in the `request` / `superagent` / `got` family.',
          file: rel,
          line: i + 1,
        });
        issues += 1;
      }
      if (JS_INSECURE_RE.test(line)) {
        result.addCheck(`tls-security:js-insecure-flag:${rel}:${i + 1}`, false, {
          severity: errSev,
          message: '`insecure: true` disables TLS validation in several HTTP-client configurations.',
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

      if (PY_VERIFY_FALSE_RE.test(codeLine)) {
        result.addCheck(`tls-security:py-verify-false:${rel}:${i + 1}`, false, {
          severity: errSev,
          message: '`verify=False` / `verify_ssl=False` / `ssl=False` disables TLS cert validation in requests / httpx / aiohttp. MITM risk.',
          file: rel,
          line: i + 1,
        });
        issues += 1;
      }
      if (PY_UNVERIFIED_CTX_RE.test(codeLine)) {
        result.addCheck(`tls-security:py-unverified-context:${rel}:${i + 1}`, false, {
          severity: errSev,
          message: '`ssl._create_unverified_context()` returns a context that trusts any cert.',
          file: rel,
          line: i + 1,
        });
        issues += 1;
      }
      if (PY_CHECK_HOSTNAME_FALSE_RE.test(codeLine)) {
        result.addCheck(`tls-security:py-check-hostname-false:${rel}:${i + 1}`, false, {
          severity: errSev,
          message: '`.check_hostname = False` disables hostname validation. An attacker\'s valid cert for a different domain will pass.',
          file: rel,
          line: i + 1,
        });
        issues += 1;
      }
      if (PY_CERT_NONE_RE.test(codeLine)) {
        result.addCheck(`tls-security:py-cert-none:${rel}:${i + 1}`, false, {
          severity: errSev,
          message: '`ssl.CERT_NONE` / `cert_reqs=\'CERT_NONE\'` disables cert validation — any cert (or no cert) is accepted.',
          file: rel,
          line: i + 1,
        });
        issues += 1;
      }
      if (PY_DISABLE_WARNINGS_RE.test(codeLine)) {
        result.addCheck(`tls-security:py-disable-warnings:${rel}:${i + 1}`, false, {
          severity: warnSev,
          message: '`urllib3.disable_warnings(InsecureRequestWarning)` silences the warning that TLS validation is off. Usually paired with `verify=False`.',
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

module.exports = TlsSecurityModule;
