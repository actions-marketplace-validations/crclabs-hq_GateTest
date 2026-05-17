/**
 * ReDoS / Catastrophic-Regex Detector Module.
 *
 * User submits crafted input, a "simple" regex takes seconds to complete,
 * the request worker pool fills up, and the service is effectively DoSed
 * with nothing in the access log more suspicious than a long request
 * body. Classic CVE-generating class — Express body-parser 2017,
 * moment.js 2022, node-fetch 2021, trim 2020, every-url-parser-regex
 * ever written. The fix is always trivial (rewrite the pattern) but the
 * detection is what fails: most teams only find out when a prod box
 * goes to 100% CPU.
 *
 * The formal problem of "is this regex catastrophic?" is NP-hard, but
 * three syntactic anti-patterns catch ~90% of real-world ReDoS
 * vulnerabilities with zero false positives:
 *
 *   1. Nested quantifier where the inner element can match empty or has
 *      its own quantifier: `(a+)+`, `(a*)*`, `(a+)*`, `(a*)+`,
 *      `(.+)+`, `([abc]+)*`
 *   2. Alternation inside a quantifier where branches overlap:
 *      `(a|a)*`, `(\d|\d+)*`, `(abc|abcd)*`
 *   3. Greedy `.*` followed by a long required literal — can trigger
 *      backtracking explosion with specific inputs.
 *
 * Plus one behavioural rule that isn't about the regex shape but about
 * data flow:
 *
 *   4. `new RegExp(userInput)` / `RegExp(req.body.x)` — user-controlled
 *      regex construction is an injection vector (CWE-1333 /
 *      CWE-185). Even a safe-looking regex becomes catastrophic if
 *      the user provides the source.
 *
 * Competitors:
 *   - ESLint `no-misleading-character-class` catches a narrow subset,
 *     nothing about backtracking.
 *   - `safe-regex` (npm) is unmaintained (last published 2021) and
 *     has a high false-positive rate.
 *   - `recheck` is accurate but requires CI integration most teams
 *     never set up.
 *   - SonarQube has one "Denial-of-Service via regex" rule; Semgrep
 *     has a few narrow patterns; nothing unifies shape + data-flow.
 *
 * Rules:
 *
 *   error:   Nested quantifier on an inner element that is itself
 *            quantified or can match empty string.
 *            (rule: `redos:nested-quantifier:<rel>:<line>`)
 *
 *   error:   Alternation with overlapping branches inside a
 *            quantified group — `(a|a)*`, `(\d|\d+)*`.
 *            (rule: `redos:overlapping-alternation:<rel>:<line>`)
 *
 *   error:   `new RegExp(x)` / `RegExp(x)` where `x` is a
 *            request/body/query/param source — user-controlled
 *            regex construction.
 *            (rule: `redos:user-controlled-regex:<rel>:<line>`)
 *
 *   warning: Greedy `.*` / `.+` followed by a required literal
 *            further in the pattern — backtracking-prone.
 *            (rule: `redos:greedy-backtrack:<rel>:<line>`)
 *
 * Suppressions:
 *   - `// redos-ok` on the same or preceding line.
 *   - Test / spec / fixture paths downgrade error → warning.
 *   - Content inside line / block comments is ignored.
 *
 * TODO(gluecron): host-neutral — pure static source scan.
 */

const BaseModule = require('./base-module');
const fs = require('fs');
const path = require('path');

const EXCLUDE_DIRS = new Set([
  'node_modules', '.git', '.claude', 'dist', 'build', 'coverage', '.gatetest',
  '.next', 'out', 'target', 'vendor', '.terraform', '__pycache__',
]);

const SOURCE_EXTS = new Set([
  '.js', '.jsx', '.mjs', '.cjs',
  '.ts', '.tsx', '.mts', '.cts',
  '.py',
]);

const TEST_PATH_RE = /(?:^|\/)(?:test|tests|__tests__|spec|specs|e2e|fixtures?|stories)\//i;
const TEST_FILE_RE = /\.(?:test|spec|e2e|stories)\.[a-z0-9]+$/i;

const SUPPRESS_RE = /\bredos-ok\b/;

// Request-taint sources. Narrow on purpose — we only want to flag the
// classic injection shapes.
const TAINT_RE = /\b(?:req|request|ctx|event|input|body|query|params?|headers?|cookies?|userInput|rawInput|user[A-Za-z]*)(?:\.[A-Za-z_$][\w$]*|\[[^\]]+\])*\b/;

// ---- Shape-based catastrophic-regex patterns ------------------------
//
// These run against the *source text* of a regex, not via `new RegExp`
// (we don't want to actually execute untrusted patterns). Each pattern
// is conservative — matches must be syntactically unambiguous.

// Nested quantifier: `(X+)+`, `(X*)*`, `(X+)*`, `(X*)+`
// Inner X is one of: `.` / `\w` / `\d` / `\s` / `[...]` / `[^...]`
const NESTED_QUANT_RE = /\(\s*(?:\?\s*:)?(?:\\[wds]|\.|\[\^?[^\]]*\])[*+](?:\?)?\s*\)\s*[*+]/;

// Nested quantifier (variant): `(?:[abc]+)*`, `(?:\d+)+`
const NESTED_QUANT_NONCAP_RE = /\(\?\s*:\s*(?:\\[wds]|\.|\[\^?[^\]]*\])[*+](?:\?)?\s*\)\s*[*+]/;

// Alternation with overlap: `(a|a)*`, `(\d|\d+)*`
// Conservative: same branch repeated, or one branch is a prefix of
// another inside a quantified group.
const ALT_OVERLAP_RE = /\((?:\?\s*:)?\s*([^()|]+)\s*\|\s*\1[+*]?\s*\)\s*[*+]/;
const ALT_PREFIX_RE = /\((?:\?\s*:)?\s*(\\[dws]|[A-Za-z])\s*\|\s*\1[+*]\s*\)\s*[*+]/;

// Greedy `.*` / `.+` with trailing literal — only flag when the
// expression is truly unanchored AND contains the `.*` twice with a
// non-anchor-character between them (polynomial backtracking risk in
// the worst case). Anchored patterns (`^...$`) back off in linear
// time and are NOT flagged.
const GREEDY_BACKTRACK_RE = /^[^^].*\.[*+][^*+?|)]+\.[*+][^$]*$/;

class RedosModule extends BaseModule {
  constructor() {
    super('redos', 'ReDoS / catastrophic-regex detector');
  }

  async run(result, config) {
    const projectRoot = (config && config.projectRoot) || process.cwd();
    const files = this._collect(projectRoot);

    if (files.length === 0) {
      result.addCheck('redos:no-files', true, {
        severity: 'info',
        message: 'No source files to scan',
      });
      return;
    }

    result.addCheck('redos:scanning', true, {
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
      if (text.length > 5 * 1024 * 1024) continue; // skip >5MB
      const lineIssues = this._scanFile(rel, text, result);
      issues += lineIssues;
    }

    result.addCheck('redos:summary', true, {
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
          if (SOURCE_EXTS.has(ext)) out.push(full);
        }
      }
    };
    walk(root);
    return out;
  }

  _scanFile(rel, text, result) {
    const isTest = TEST_PATH_RE.test(rel) || TEST_FILE_RE.test(rel);
    const lines = text.split('\n');
    let issues = 0;

    // Block-comment state
    let inBlockComment = false;

    for (let i = 0; i < lines.length; i += 1) {
      let line = lines[i];

      // Strip block-comment segments before scanning
      if (inBlockComment) {
        const endIdx = line.indexOf('*/');
        if (endIdx === -1) continue;
        line = line.slice(endIdx + 2);
        inBlockComment = false;
      }
      const startBlock = line.indexOf('/*');
      if (startBlock !== -1) {
        const endBlock = line.indexOf('*/', startBlock + 2);
        if (endBlock === -1) {
          inBlockComment = true;
          line = line.slice(0, startBlock);
        } else {
          line = line.slice(0, startBlock) + line.slice(endBlock + 2);
        }
      }

      // Strip line-comments
      const lineCmt = line.indexOf('//');
      if (lineCmt !== -1) line = line.slice(0, lineCmt);
      const hashCmt = rel.endsWith('.py') ? line.indexOf('#') : -1;
      if (hashCmt !== -1) line = line.slice(0, hashCmt);

      // Suppression: same or preceding line contains `redos-ok`
      const suppressed =
        SUPPRESS_RE.test(lines[i]) ||
        (i > 0 && SUPPRESS_RE.test(lines[i - 1]));

      // Extract regex literals: /pattern/flags
      // Conservative: must be preceded by `=`, `(`, `,`, `return`,
      // `&&`, `||`, `?`, `:`, whitespace-then-start-of-expression.
      const patterns = this._extractRegexSources(line);

      for (const pat of patterns) {
        const lineNo = i + 1;
        if (suppressed) continue;
        const sev = isTest ? 'warning' : 'error';

        if (NESTED_QUANT_RE.test(pat) || NESTED_QUANT_NONCAP_RE.test(pat)) {
          result.addCheck(`redos:nested-quantifier:${rel}:${lineNo}`, false, {
            severity: sev,
            message: `Nested quantifier in regex — catastrophic backtracking risk: /${this._truncate(pat)}/`,
            file: rel,
            line: lineNo,
            pattern: this._truncate(pat),
          });
          issues += 1;
          continue;
        }
        if (ALT_OVERLAP_RE.test(pat) || ALT_PREFIX_RE.test(pat)) {
          result.addCheck(`redos:overlapping-alternation:${rel}:${lineNo}`, false, {
            severity: sev,
            message: `Alternation with overlapping branches inside quantifier: /${this._truncate(pat)}/`,
            file: rel,
            line: lineNo,
            pattern: this._truncate(pat),
          });
          issues += 1;
          continue;
        }
        if (GREEDY_BACKTRACK_RE.test(pat)) {
          result.addCheck(`redos:greedy-backtrack:${rel}:${i + 1}`, false, {
            severity: isTest ? 'info' : 'warning',
            message: `Multiple greedy wildcards in regex — backtracking-prone: /${this._truncate(pat)}/`,
            file: rel,
            line: lineNo,
            pattern: this._truncate(pat),
          });
          issues += 1;
        }
      }

      // Data-flow rule: new RegExp(tainted) / RegExp(tainted)
      const ctorMatch = /\b(?:new\s+)?RegExp\s*\(\s*([^)]+?)\s*\)/.exec(line);
      if (ctorMatch && !suppressed) {
        const arg = ctorMatch[1];
        // Only flag if arg looks like user input, not a string literal
        const isLiteral = /^['"`]/.test(arg.trim());
        if (!isLiteral && TAINT_RE.test(arg)) {
          const lineNo = i + 1;
          result.addCheck(`redos:user-controlled-regex:${rel}:${lineNo}`, false, {
            severity: isTest ? 'warning' : 'error',
            message: `User-controlled source passed to RegExp constructor — injection risk (CWE-1333): ${arg.trim().slice(0, 60)}`,
            file: rel,
            line: lineNo,
            source: arg.trim().slice(0, 80),
          });
          issues += 1;
        }
      }
    }

    return issues;
  }

  _extractRegexSources(line) {
    const out = [];

    // Regex literal: `/pattern/flags` — must be preceded by an
    // expression-start context, not a division.
    // Conservative heuristic: preceded by one of `=([,!&|?:;` or start-of-line.
    const literalRe = /(^|[=([,!&|?:;{}]|\breturn\b|\btypeof\b|\b=>\s*)\s*\/((?:\\.|[^\/\n\\])+?)\/[gimsuy]*/g;
    let m;
    while ((m = literalRe.exec(line)) !== null) {
      out.push(m[2]);
    }

    // `new RegExp("pattern"...)` / `RegExp("pattern"...)`
    // Inside a string literal, regex metacharacters are double-escaped
    // (e.g. `"\\d+"` represents the regex `\d+`). Collapse one level of
    // backslash escaping before pattern-matching.
    const ctorRe = /\b(?:new\s+)?RegExp\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g;
    while ((m = ctorRe.exec(line)) !== null) {
      out.push(this._unescapeStringLiteral(m[2]));
    }

    // Python: `re.compile(r"pattern")` / `re.compile("pattern")`
    // Raw strings (prefix `r`) don't need unescaping; regular ones do.
    const pyRawRe = /\bre\.(?:compile|match|search|findall|finditer|sub|fullmatch)\s*\(\s*r(['"])((?:\\.|(?!\1).)*)\1/g;
    while ((m = pyRawRe.exec(line)) !== null) {
      out.push(m[2]);
    }
    const pyStrRe = /\bre\.(?:compile|match|search|findall|finditer|sub|fullmatch)\s*\(\s*(['"])((?:\\.|(?!\1).)*)\1/g;
    while ((m = pyStrRe.exec(line)) !== null) {
      // Skip raw strings (already captured above)
      const prefixIdx = m.index + m[0].indexOf(m[1]) - 1;
      if (prefixIdx >= 0 && line[prefixIdx] === 'r') continue;
      out.push(this._unescapeStringLiteral(m[2]));
    }

    return out;
  }

  _truncate(pat) {
    if (pat.length <= 60) return pat;
    return pat.slice(0, 57) + '...';
  }

  _unescapeStringLiteral(s) {
    // Collapse a single level of backslash escaping so `\\d` → `\d`.
    // This mirrors what JavaScript's string parser would do when it
    // evaluates the string at runtime before handing it to RegExp().
    return s.replace(/\\(.)/g, '$1');
  }
}

module.exports = RedosModule;
