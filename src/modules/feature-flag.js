/**
 * Feature-Flag Hygiene Detector Module.
 *
 * Stale feature flags are the silent tax on every codebase. LaunchDarkly's
 * 2024 State of Feature Management report found that orgs carry 5-10x more
 * flags in code than they actively toggle. Every stale flag is dead code
 * waiting to go wrong: a branch that stops getting tested, a default that
 * quietly drifted, a staff-only path accidentally reachable because someone
 * flipped the default but left the flag check in. Flags that graduate to
 * "permanent on" and stay in the code are just slower `if (true)`.
 *
 * We catch the loudest, most reliable signals — the ones where the flag
 * has *already* collapsed into a constant:
 *
 *   - `if (true) { ... }` / `if (false) { ... }` — the branch flipped,
 *     someone forgot to rip out the conditional.
 *   - `if (1) {` / `if (0) {` / `if (!true) {` / `if (!false) {` — same
 *     bug in C / JS idiom. Negated-literal form is the most common
 *     "temporarily disable" shortcut that ships to prod.
 *   - `const FEATURE_X = true;` / `const ENABLE_Y = false;` — a flag
 *     declared as a compile-time constant. Not a flag at all — a lie.
 *   - Python: `if True:` / `if False:` / `FEATURE_X = True` — same bugs.
 *
 * Rules:
 *
 *   error:   `if (true|1|!false|!0)` — always-true conditional (JS/TS).
 *            (rule: `feature-flag:always-true-if:<rel>:<line>`)
 *
 *   warning: `if (false|0|!true|!1)` — dead branch (JS/TS).
 *            (rule: `feature-flag:always-false-if:<rel>:<line>`)
 *
 *   warning: `const <FLAG_NAMED_CONST> = true|false` — flag-named const
 *            bound to a literal.
 *            (rule: `feature-flag:stale-const:<rel>:<line>`)
 *
 *   error:   Python `if True:` / `if 1:` / `if not False:` — always-true.
 *            (rule: `feature-flag:py-always-true-if:<rel>:<line>`)
 *
 *   warning: Python `if False:` / `if 0:` / `if not True:` — dead branch.
 *            (rule: `feature-flag:py-always-false-if:<rel>:<line>`)
 *
 *   warning: Python `FEATURE_X = True` / `ENABLE_Y = False` — stale const.
 *            (rule: `feature-flag:py-stale-const:<rel>:<line>`)
 *
 * Suppressions:
 *   - `// flag-ok` / `# flag-ok` on same or preceding line.
 *   - Test / spec / fixture paths downgrade error → warning, warning → info.
 *   - Minified / bundled files (`.min.js`, `.bundle.js`) are skipped.
 *
 * Competitors:
 *   - ESLint `no-constant-condition` — catches `if (true)` but not
 *     flag-named-const or `!true` / `!false` idioms, and it's opt-in.
 *   - SonarQube has a scattered "always true/false" family — JS only.
 *   - LaunchDarkly's "code references" tool catches *their* flag API
 *     specifically; no cross-vendor detection.
 *   - Pylint, Ruff, Pyflakes: nothing.
 *   - Nothing unifies JS + Python + flag-named-const + dead-branch
 *     detection at the gate with suppression markers and test-path
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

const MINIFIED_RE = /\.(?:min|bundle|prod)\.[a-z]+$/i;

const TEST_PATH_RE = /(?:^|\/)(?:test|tests|__tests__|spec|specs|e2e|fixtures?|stories)\//i;
const TEST_FILE_RE = /\.(?:test|spec|e2e|stories)\.[a-z0-9]+$/i;

const SUPPRESS_RE = /\bflag-ok\b/;

// JS/TS: `if (true)` / `if (1)` / `if (!false)` / `if (!0)` possibly
// with extra whitespace. We match the opening paren and require the
// literal to be the SOLE expression — no `&&` / `||`.
const JS_ALWAYS_TRUE_RE = /\bif\s*\(\s*(?:true|1|!\s*false|!\s*0)\s*\)/;
const JS_ALWAYS_FALSE_RE = /\bif\s*\(\s*(?:false|0|!\s*true|!\s*1)\s*\)/;

// JS/TS: `const FEATURE_X = true;` — stale flag collapsed into a compile-
// time constant. We restrict to `const` (not `let` / `var`) because the
// `let hasErrored = false; ... hasErrored = true;` initializer pattern is
// extremely common local-state and would dominate the FP rate. A `const`
// bound to a boolean literal is unambiguously a constant, not a flag.
// Const-name pattern: SCREAMING_SNAKE prefixed FEATURE_/ENABLE_/DISABLE_/
// FLAG_/USE_/SHOW_/HIDE_.
const JS_STALE_CONST_RE =
  /\bconst\s+((?:FEATURE|ENABLE|DISABLE|FLAG|USE|SHOW|HIDE)_[A-Z0-9_]+)\s*(?::\s*boolean)?\s*=\s*(true|false)\s*[;,]/;

// Python: `if True:` / `if 1:` / `if not False:`.
const PY_ALWAYS_TRUE_RE = /^\s*if\s+(?:True|1|not\s+False|not\s+0)\s*:/;
const PY_ALWAYS_FALSE_RE = /^\s*if\s+(?:False|0|not\s+True|not\s+1)\s*:/;

// Python: `FEATURE_X = True` / `ENABLE_Y = False`. Module-level only
// (no leading whitespace) so we don't flag class/function locals that
// are conventionally uppercase.
const PY_STALE_CONST_RE =
  /^((?:FEATURE|ENABLE|DISABLE|FLAG|USE|SHOW|HIDE)_[A-Z0-9_]+)\s*(?::\s*bool)?\s*=\s*(True|False)\s*(?:#|$)/;

class FeatureFlagModule extends BaseModule {
  constructor() {
    super(
      'featureFlag',
      'Feature-flag hygiene detector — catches stale flags collapsed into constants and dead-branch conditionals'
    );
  }

  async run(result, config) {
    const projectRoot = (config && config.projectRoot) || process.cwd();
    const files = this._collect(projectRoot);

    if (files.length === 0) {
      result.addCheck('feature-flag:no-files', true, {
        severity: 'info',
        message: 'No source files to scan',
      });
      return;
    }

    result.addCheck('feature-flag:scanning', true, {
      severity: 'info',
      message: `Scanning ${files.length} file(s)`,
      fileCount: files.length,
    });

    let issues = 0;

    for (const abs of files) {
      const rel = path.relative(projectRoot, abs).replace(/\\/g, '/');
      if (MINIFIED_RE.test(rel)) continue;
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

    result.addCheck('feature-flag:summary', true, {
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
    let inTemplate = false;  // multi-line backtick template state

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
      // Strip string contents (replace with spaces, keeping positions)
      // so regexes cannot match code-shaped text embedded in strings.
      // Tracks backticks across lines; single/double quotes reset at EOL.
      const stripRes = this._stripStrings(line, inTemplate);
      line = stripRes.stripped;
      inTemplate = stripRes.inTemplate;

      // Strip line comments
      const lc = line.indexOf('//');
      if (lc !== -1) line = line.slice(0, lc);

      if (this._suppressed(lines, i)) continue;

      // Rule 1: `if (true | 1 | !false | !0)` — always-true
      if (JS_ALWAYS_TRUE_RE.test(line)) {
        result.addCheck(`feature-flag:always-true-if:${rel}:${i + 1}`, false, {
          severity: errSev,
          message: 'Always-true conditional — dead flag collapsed into a constant. Remove the conditional or restore the flag check.',
          file: rel,
          line: i + 1,
        });
        issues += 1;
      }

      // Rule 2: `if (false | 0 | !true | !1)` — always-false
      if (JS_ALWAYS_FALSE_RE.test(line)) {
        result.addCheck(`feature-flag:always-false-if:${rel}:${i + 1}`, false, {
          severity: warnSev,
          message: 'Always-false conditional — dead branch. The body never executes; delete it or restore the real flag check.',
          file: rel,
          line: i + 1,
        });
        issues += 1;
      }

      // Rule 3: `const FEATURE_X = true` — flag-named const bound to literal
      const m3 = JS_STALE_CONST_RE.exec(line);
      if (m3) {
        result.addCheck(`feature-flag:stale-const:${rel}:${i + 1}`, false, {
          severity: warnSev,
          message: `Flag-named constant "${m3[1]}" bound to literal ${m3[2]} — not a real flag. Either wire it to a flag service or rename.`,
          file: rel,
          line: i + 1,
          constant: m3[1],
          value: m3[2],
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

      // Docstring tracking
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

      // Strip line comments (unquoted `#` only)
      let codeLine = line;
      const hashIdx = this._findUnquotedHash(codeLine);
      if (hashIdx !== -1) codeLine = codeLine.slice(0, hashIdx);

      if (this._suppressed(lines, i)) continue;

      // Rule 4: `if True:` / `if 1:` / `if not False:`
      if (PY_ALWAYS_TRUE_RE.test(codeLine)) {
        result.addCheck(`feature-flag:py-always-true-if:${rel}:${i + 1}`, false, {
          severity: errSev,
          message: 'Always-true conditional — dead flag collapsed into a constant.',
          file: rel,
          line: i + 1,
        });
        issues += 1;
      }

      // Rule 5: `if False:` / `if 0:` / `if not True:`
      if (PY_ALWAYS_FALSE_RE.test(codeLine)) {
        result.addCheck(`feature-flag:py-always-false-if:${rel}:${i + 1}`, false, {
          severity: warnSev,
          message: 'Always-false conditional — dead branch. The body never executes.',
          file: rel,
          line: i + 1,
        });
        issues += 1;
      }

      // Rule 6: module-level `FEATURE_X = True`
      const m6 = PY_STALE_CONST_RE.exec(codeLine);
      if (m6) {
        result.addCheck(`feature-flag:py-stale-const:${rel}:${i + 1}`, false, {
          severity: warnSev,
          message: `Flag-named constant "${m6[1]}" bound to literal ${m6[2]} — not a real flag.`,
          file: rel,
          line: i + 1,
          constant: m6[1],
          value: m6[2],
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

  // Walks the line left-to-right and blanks out string-literal contents
  // so regex matches can only hit real code. Tracks backtick template
  // state across lines (single/double quotes don't persist past EOL).
  _stripStrings(line, inTemplate) {
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

module.exports = FeatureFlagModule;
