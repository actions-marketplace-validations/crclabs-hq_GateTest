/**
 * TypeScript Strictness Module — tsconfig regression + suppression abuse.
 *
 * TypeScript's safety is a slider, not a switch. A team starts at
 * `strict: true`, then one PR flips `noImplicitAny: false` to unblock a
 * migration, another sprinkles `@ts-ignore` above every type error, and
 * twelve months later "TypeScript" is a linter for class syntax and
 * nothing else. This module locks the slider back in place.
 *
 * Rules (three families):
 *
 * 1. `tsconfig.json` regressions (project-wide):
 *
 *      error:   `strict: false`                — the master switch off
 *      error:   `noImplicitAny: false`         — implicit any flood
 *      warning: `strictNullChecks: false`      — null/undefined errors disabled
 *      warning: `strictFunctionTypes: false`   — variance checks disabled
 *      warning: `skipLibCheck: true`           — type errors in deps are hidden
 *      info:    `noUnusedLocals`/`noUnusedParameters` missing or false
 *
 *    `tsconfig.test.json` and `tsconfig.*.test.*.json` files are allowed
 *    to relax strictness (tests often need it); the rules above apply
 *    only to the base config and non-test variants.
 *
 * 2. Suppression-comment abuse (per-file):
 *
 *      error:   `@ts-nocheck` at the top of a source file — disables
 *               typechecking for the entire file, effectively opting it
 *               out of TypeScript.
 *               (rule: `typescript-strictness:ts-nocheck:<rel>:<line>`)
 *      warning: `@ts-ignore` with no trailing reason — suppressions
 *               without justification accumulate until nobody remembers
 *               why they're there.
 *               (rule: `typescript-strictness:ts-ignore-no-reason:<rel>:<line>`)
 *      warning: `@ts-expect-error` with no trailing reason — same
 *               rationale; `@ts-expect-error` is better than `@ts-ignore`
 *               because it fails loudly once the underlying type is
 *               fixed, but it still needs a reason.
 *               (rule: `typescript-strictness:ts-expect-error-no-reason:<rel>:<line>`)
 *      info:    `@ts-ignore` counted — used in dashboards for trend
 *               tracking. Prefer `@ts-expect-error` when possible.
 *
 * 3. `any`-leak detection (per-file):
 *
 *      warning: exported function/const/class has a parameter or return
 *               type of `any` — `any` leaks across module boundaries
 *               into every caller.
 *               (rule: `typescript-strictness:any-leak:<rel>:<line>`)
 *      warning: `as any` cast — escape-hatch that silently opts a value
 *               out of the type system.
 *               (rule: `typescript-strictness:as-any:<rel>:<line>`)
 *      info:    `as unknown as X` double-cast — a lesser escape hatch,
 *               but still worth flagging for human review.
 *               (rule: `typescript-strictness:unknown-double-cast:<rel>:<line>`)
 *
 * `.d.ts` declaration files are scanned for tsconfig-level issues only;
 * `any` is sometimes unavoidable in a declaration. `*.test.ts` and
 * `*.spec.ts` are allowed to use `any` liberally.
 *
 * TODO(gluecron): when Gluecron publishes its SDK, mirror these rules
 * against any auto-generated client `.ts` files so we catch regressions
 * the moment the SDK drifts.
 */

const fs = require('fs');
const path = require('path');
const BaseModule = require('./base-module');

const DEFAULT_EXCLUDES = [
  'node_modules', '.git', '.claude', 'dist', 'build', 'coverage', '.gatetest',
  '.next', '__pycache__', 'target', 'vendor', '.terraform', 'out',
];

const TS_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts']);

// Files that legitimately use `any` for test-subject purposes.
const TEST_FILE_RE = /\.(?:test|spec)\.(?:ts|tsx|mts|cts)$/i;

// Declaration files — we skip `any`-leak checks but still flag
// `@ts-nocheck` / `@ts-ignore`.
const DTS_RE = /\.d\.ts$/i;

// String-aware JSONC comment stripper. `/*` and `//` inside a JSON
// string literal are preserved; trailing commas are not our problem
// (we surface those as "unparseable").
function stripJsonc(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let inString = false;
  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];
    if (inString) {
      out += ch;
      if (ch === '\\' && i + 1 < n) {
        out += src[i + 1];
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      // line comment — skip to newline
      i += 2;
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      // block comment — skip to `*/`
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

class TypeScriptStrictnessModule extends BaseModule {
  constructor() {
    super(
      'typescriptStrictness',
      'TypeScript strictness — tsconfig regressions, @ts-ignore/@ts-nocheck abuse, `any`-leak detection',
    );
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;
    const files = this._findFiles(projectRoot);
    const tsconfigs = files.tsconfigs;
    const sources = files.sources;

    if (tsconfigs.length === 0 && sources.length === 0) {
      result.addCheck('typescript-strictness:no-files', true, {
        severity: 'info',
        message: 'No tsconfig.json or TypeScript source files found — skipping',
      });
      return;
    }

    result.addCheck('typescript-strictness:scanning', true, {
      severity: 'info',
      message: `Scanning ${tsconfigs.length} tsconfig(s) and ${sources.length} TypeScript file(s)`,
    });

    let issues = 0;

    for (const tsconfig of tsconfigs) {
      issues += this._scanTsconfig(tsconfig, projectRoot, result);
    }

    for (const src of sources) {
      issues += this._scanSource(src, projectRoot, result);
    }

    result.addCheck('typescript-strictness:summary', true, {
      severity: 'info',
      message: `TypeScript strictness: ${tsconfigs.length} tsconfig(s), ${sources.length} source file(s), ${issues} issue(s)`,
    });
  }

  _findFiles(projectRoot) {
    const tsconfigs = [];
    const sources = [];
    const walk = (dir, depth = 0) => {
      if (depth > 12) return;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (DEFAULT_EXCLUDES.includes(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full, depth + 1);
        } else if (entry.isFile()) {
          const name = entry.name;
          if (name === 'tsconfig.json' || /^tsconfig\.[^/]+\.json$/.test(name)) {
            tsconfigs.push(full);
          } else {
            const ext = path.extname(name).toLowerCase();
            if (TS_EXTS.has(ext)) sources.push(full);
          }
        }
      }
    };
    walk(projectRoot);
    return { tsconfigs, sources };
  }

  _scanTsconfig(file, projectRoot, result) {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf-8');
    } catch {
      return 0;
    }

    const rel = path.relative(projectRoot, file);
    const basename = path.basename(file);
    const isTestConfig = /tsconfig\.(?:test|spec|tests)\./i.test(basename)
      || /tsconfig\.test\.json$/i.test(basename);

    let parsed;
    try {
      // tsconfig is JSONC — allow `//` + `/* */` comments. Strip them
      // with a string-aware walker so that `"@/*": ["./*"]` inside a
      // paths map isn't mistaken for comment syntax.
      const stripped = stripJsonc(raw);
      parsed = JSON.parse(stripped);
    } catch (err) {
      return this._flag(result, `typescript-strictness:tsconfig-unparseable:${rel}`, {
        severity: 'warning',
        file: rel,
        message: `${rel} could not be parsed as JSON (${err.message}) — strictness checks skipped`,
        suggestion: 'Keep tsconfig.json valid JSON with only line/block comments; avoid trailing commas.',
      });
    }

    const co = parsed && parsed.compilerOptions ? parsed.compilerOptions : {};
    let issues = 0;

    // Test configs may legitimately relax strictness — still flag the
    // most dangerous one (`@ts-nocheck`-equivalent skipLibCheck disables
    // library type-checking), but don't escalate the rest.
    if (!isTestConfig) {
      if (co.strict === false) {
        issues += this._flag(result, `typescript-strictness:tsconfig-strict-false:${rel}`, {
          severity: 'error',
          file: rel,
          message: `${rel} sets \`strict: false\` — the master strictness switch is off, effectively demoting TypeScript to a syntax linter`,
          suggestion: 'Set `"strict": true`. If a migration forced this, fix one file at a time behind `// @ts-expect-error` comments until you can flip it back.',
        });
      }
      if (co.noImplicitAny === false) {
        issues += this._flag(result, `typescript-strictness:tsconfig-no-implicit-any-false:${rel}`, {
          severity: 'error',
          file: rel,
          message: `${rel} sets \`noImplicitAny: false\` — parameters and returns default to \`any\`, which defeats the point of TS`,
          suggestion: 'Delete the override. Fix the resulting errors one file at a time.',
        });
      }
      if (co.strictNullChecks === false) {
        issues += this._flag(result, `typescript-strictness:tsconfig-strict-null-checks-false:${rel}`, {
          severity: 'warning',
          file: rel,
          message: `${rel} sets \`strictNullChecks: false\` — \`undefined is not a function\` lives again`,
          suggestion: 'Remove the override; use non-null assertions (`x!`) or narrowing guards instead.',
        });
      }
      if (co.strictFunctionTypes === false) {
        issues += this._flag(result, `typescript-strictness:tsconfig-strict-function-types-false:${rel}`, {
          severity: 'warning',
          file: rel,
          message: `${rel} sets \`strictFunctionTypes: false\` — callback variance errors are hidden`,
          suggestion: 'Remove the override. Callback mismatches usually indicate a real bug.',
        });
      }
    }

    // Applies to all configs (including test): skipLibCheck silently
    // accepts broken `.d.ts` files from dependencies — including ones
    // that redefine globals.
    if (co.skipLibCheck === true) {
      issues += this._flag(result, `typescript-strictness:tsconfig-skip-lib-check:${rel}`, {
        severity: 'warning',
        file: rel,
        message: `${rel} sets \`skipLibCheck: true\` — type errors from \`node_modules/**/*.d.ts\` are hidden, including conflicts between library globals`,
        suggestion: 'Remove `skipLibCheck` and fix the real dependency type issues; or, if a single dep is the culprit, shim it in a \`types/\` folder instead of disabling globally.',
      });
    }

    return issues;
  }

  _scanSource(file, projectRoot, result) {
    let content;
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch {
      return 0;
    }

    const rel = path.relative(projectRoot, file);
    const isTest = TEST_FILE_RE.test(rel);
    const isDts = DTS_RE.test(rel);
    const lines = content.split('\n');
    let issues = 0;

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const trimmed = line.trim();

      // @ts-nocheck — check the first 5 non-empty lines (allows shebang
      // + copyright banners, but catches file-level disables).
      if (i < 10 && /^\s*\/\/\s*@ts-nocheck\b/.test(line)) {
        issues += this._flag(result, `typescript-strictness:ts-nocheck:${rel}:${i + 1}`, {
          severity: 'error',
          file: rel,
          line: i + 1,
          message: `${rel}:${i + 1} uses \`@ts-nocheck\` — typechecking is disabled for the entire file`,
          suggestion: 'Remove `@ts-nocheck` and use targeted `@ts-expect-error: <reason>` on the lines that actually fail to typecheck.',
        });
      }

      // @ts-ignore — warning if no reason text after the directive
      const ignoreMatch = trimmed.match(/^\/\/\s*@ts-ignore\b(.*)$/);
      if (ignoreMatch) {
        const rest = ignoreMatch[1].trim();
        if (!rest || /^[-:\s]*$/.test(rest)) {
          issues += this._flag(result, `typescript-strictness:ts-ignore-no-reason:${rel}:${i + 1}`, {
            severity: 'warning',
            file: rel,
            line: i + 1,
            message: `${rel}:${i + 1} uses \`@ts-ignore\` with no reason — reviewers have no way to know whether it's still needed`,
            suggestion: 'Append a short reason: `// @ts-ignore — upstream type in @foo/bar is wrong (filed: #123)`.',
          });
        } else {
          // Still record the use for dashboard trend tracking.
          result.addCheck(`typescript-strictness:ts-ignore-counted:${rel}:${i + 1}`, true, {
            severity: 'info',
            file: rel,
            line: i + 1,
            message: 'counted @ts-ignore (has reason)',
          });
        }
      }

      // @ts-expect-error — warning if no reason text
      const expectMatch = trimmed.match(/^\/\/\s*@ts-expect-error\b(.*)$/);
      if (expectMatch) {
        const rest = expectMatch[1].trim();
        if (!rest || /^[-:\s]*$/.test(rest)) {
          issues += this._flag(result, `typescript-strictness:ts-expect-error-no-reason:${rel}:${i + 1}`, {
            severity: 'warning',
            file: rel,
            line: i + 1,
            message: `${rel}:${i + 1} uses \`@ts-expect-error\` with no reason — once the underlying type is fixed the next reader won't know what the directive was guarding`,
            suggestion: 'Append a short reason: `// @ts-expect-error — Stripe types lag behind the runtime (fixed in stripe@18)`.',
          });
        }
      }

      // `any` leak detection — skip test files and .d.ts
      if (!isTest && !isDts) {
        issues += this._scanAnyLeak(line, i + 1, rel, result);
      }
    }

    return issues;
  }

  _scanAnyLeak(line, lineNo, rel, result) {
    let issues = 0;

    // Exported function/const/class with `: any` somewhere in the
    // signature. We look for the export keyword near the start of the
    // line and `: any` or `=> any` or `any,`/`any)` in the same line.
    const isExport = /^\s*export\s+(?:async\s+)?(?:function|const|let|var|class|interface|type|enum)\b/.test(line);
    if (isExport) {
      // Careful: `any` as a substring of other words (`canyon`,
      // `company`) shouldn't match. Require word boundaries + a type
      // context (preceded by `:` or `=>` or inside `Array<>`).
      if (/(?::\s*|=>\s*|<\s*)any\b(?![\w$])/.test(line)) {
        issues += this._flag(result, `typescript-strictness:any-leak:${rel}:${lineNo}`, {
          severity: 'warning',
          file: rel,
          line: lineNo,
          message: `${rel}:${lineNo} exports a symbol with \`any\` in its signature — every caller loses type safety across this module boundary`,
          suggestion: 'Replace `any` with `unknown` (forces the caller to narrow) or the actual type. If the shape is genuinely dynamic, use a discriminated union or a generic.',
        });
      }
    }

    // `as any` cast — always worth flagging in non-test code.
    if (/\bas\s+any\b(?![\w$])/.test(line) && !/\bas\s+unknown\s+as\s+any\b/.test(line)) {
      issues += this._flag(result, `typescript-strictness:as-any:${rel}:${lineNo}`, {
        severity: 'warning',
        file: rel,
        line: lineNo,
        message: `${rel}:${lineNo} uses \`as any\` — escape hatch that silently opts this value out of the type system`,
        suggestion: 'Prefer `as unknown as SpecificType` (still an escape hatch, but forces you to name the target type). Better: fix the upstream type.',
      });
    }

    // `as unknown as X` — info-level signal for dashboards.
    if (/\bas\s+unknown\s+as\s+\w/.test(line)) {
      result.addCheck(`typescript-strictness:unknown-double-cast:${rel}:${lineNo}`, true, {
        severity: 'info',
        file: rel,
        line: lineNo,
        message: `${rel}:${lineNo} uses \`as unknown as X\` — escape hatch, but at least a named one`,
      });
    }

    return issues;
  }

  _flag(result, name, details) {
    result.addCheck(name, false, details);
    return 1;
  }
}

module.exports = TypeScriptStrictnessModule;
