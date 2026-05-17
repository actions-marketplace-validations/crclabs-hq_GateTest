/**
 * Dead Code Module — unused exports, unreachable files, orphaned symbols.
 *
 * Every codebase rots the same way: an export that nothing imports, a
 * file that's not referenced from any entry point, a symbol kept
 * around "just in case" for two years. `ts-prune`, `knip`, `unimport`
 * each only cover one language. GateTest does this across JS/TS and
 * Python in one pass, with zero dependencies.
 *
 * Approach (line-heuristic, no AST):
 *
 *   1. Walk the project, collect:
 *        - `exports`:  (file, name) pairs for every exported symbol
 *        - `imports`:  set of names referenced from other files
 *        - `filerefs`: set of files referenced from other files
 *          (via a `from './foo'` or `require('./foo')` etc.)
 *   2. Emit:
 *        - warning: exported symbol never imported anywhere
 *        - info:    file has exports but nothing imports the file
 *        - warning: commented-out block of 10+ consecutive `//` or `#`
 *                   lines (rotting code).
 *
 * Entry-point heuristics — files that are allowed to have "no inbound
 * references" without being flagged:
 *
 *   - `index.{js,ts,mjs,cjs,jsx,tsx}`
 *   - `main.{js,ts,py}`
 *   - files directly named in `package.json` `main` / `bin` / `exports`
 *   - anything under `bin/`, `tests/`, `test/`, `__tests__/`,
 *     `scripts/`, `migrations/`, `pages/`, `app/`, `api/`
 *
 * We specifically do NOT try to resolve ESM path aliases, TS paths,
 * webpack aliases, or wildcard re-exports — that's what an AST-based
 * tool would do and it's way out of scope for a line-heuristic scan.
 * This module flags *candidates*; the AI-review module + human in the
 * loop is the confirmation layer.
 *
 * Pattern-keyed names (`dead-code:unused-export:<rel>:<line>:<name>`
 * etc.) feed the memory module's fix-pattern engine.
 *
 * TODO(gluecron): when Gluecron ships a multi-repo view, teach this
 * module to treat cross-repo imports as live references.
 */

const fs = require('fs');
const path = require('path');
const BaseModule = require('./base-module');

const DEFAULT_EXCLUDES = [
  'node_modules', '.git', '.claude', 'dist', 'build', 'coverage', '.gatetest',
  '.next', '__pycache__', 'target', 'vendor', '.terraform', 'out',
];

const JS_EXTS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);
const PY_EXTS = new Set(['.py']);
const ALL_EXTS = new Set([...JS_EXTS, ...PY_EXTS]);

// Directory prefixes that are treated as "reachable" by convention —
// they're the entry points, not the library internals.
const ENTRYPOINT_DIRS = [
  'bin/', 'tests/', 'test/', '__tests__/', 'scripts/',
  'migrations/', 'pages/', 'app/', 'api/', 'public/',
  'integrations/',
];

// Filenames that are reachable by convention regardless of directory.
const ENTRYPOINT_BASENAMES = new Set([
  'index.js', 'index.ts', 'index.mjs', 'index.cjs', 'index.jsx', 'index.tsx',
  'main.js', 'main.ts', 'main.py', '__init__.py', '__main__.py',
  'app.js', 'app.ts', 'server.js', 'server.ts',
  'conftest.py', 'setup.py', 'manage.py',
]);

// Symbols that test frameworks / runtime hooks reference without a
// conventional `import ... from`. If an export has one of these names
// we don't flag it — too much risk of false positives.
const FRAMEWORK_RESERVED = new Set([
  // Next.js — HTTP method handlers and conventional route files
  'default', 'metadata', 'generateMetadata', 'generateStaticParams',
  'generateViewport', 'viewport',
  'loader', 'action', 'GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS',
  'HEAD', 'middleware', 'config',
  // Next.js route segment config (App Router)
  'dynamic', 'dynamicParams', 'revalidate', 'fetchCache', 'runtime',
  'preferredRegion', 'maxDuration',
  // Next.js image / opengraph file conventions
  'alt', 'size', 'contentType',
  // React
  'ErrorBoundary', 'NotFound',
  // Python / pytest / unittest
  'setUp', 'tearDown', 'setup', 'teardown', 'setup_module', 'teardown_module',
]);

class DeadCodeModule extends BaseModule {
  constructor() {
    super(
      'deadCode',
      'Dead Code — unused exports across JS/TS/Python, orphaned files, rotting commented-out blocks',
    );
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;
    const files = this._findFiles(projectRoot);

    if (files.length === 0) {
      result.addCheck('dead-code:no-files', true, {
        severity: 'info',
        message: 'No JS/TS/Python source files found — skipping',
      });
      return;
    }

    result.addCheck('dead-code:scanning', true, {
      severity: 'info',
      message: `Scanning ${files.length} source file(s) for unused exports and orphaned files`,
    });

    // Pass 1: gather every file's exports, imports, and file references
    const index = this._buildIndex(files, projectRoot);

    // Pass 2: flag unused exports, orphaned files, commented-out blocks
    let totalIssues = 0;
    totalIssues += this._flagUnusedExports(index, result);
    totalIssues += this._flagOrphanedFiles(index, result);
    totalIssues += this._flagCommentedOutBlocks(files, projectRoot, result);

    result.addCheck('dead-code:summary', true, {
      severity: 'info',
      message: `Dead-code scan: ${files.length} file(s), ${totalIssues} issue(s)`,
    });
  }

  _findFiles(projectRoot) {
    const out = [];
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
          const ext = path.extname(entry.name).toLowerCase();
          if (ALL_EXTS.has(ext)) out.push(full);
        }
      }
    };
    walk(projectRoot);
    return out;
  }

  _buildIndex(files, projectRoot) {
    // For each file: { exports: [{name, line}], lang }
    // Global: importedNames: Set<string>
    //         referencedFiles: Set<absolutePath (normalized)>
    const perFile = new Map();
    const importedNames = new Set();
    const referencedFiles = new Set();

    for (const file of files) {
      let content;
      try {
        content = fs.readFileSync(file, 'utf-8');
      } catch {
        continue;
      }
      const ext = path.extname(file).toLowerCase();
      const lang = PY_EXTS.has(ext) ? 'py' : 'js';
      const exports = lang === 'py'
        ? this._extractPyExports(content)
        : this._extractJsExports(content);

      perFile.set(file, { exports, lang, rel: path.relative(projectRoot, file) });

      const { names, paths } = lang === 'py'
        ? this._extractPyImports(content)
        : this._extractJsImports(content);

      for (const n of names) importedNames.add(n);
      for (const p of paths) {
        const resolved = this._resolveImportPath(file, p, projectRoot);
        if (resolved) referencedFiles.add(resolved);
      }
    }

    return { perFile, importedNames, referencedFiles, projectRoot };
  }

  /**
   * Parse JS/TS exports. Matches:
   *   export function foo(...)
   *   export async function foo
   *   export const/let/var foo =
   *   export class Foo
   *   export default function foo
   *   export { foo, bar as baz }
   *   module.exports.foo = ...
   *   module.exports = { foo, bar }
   *   exports.foo = ...
   */
  _extractJsExports(content) {
    const out = [];
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*')) continue;

      // export (async) function NAME / export class NAME / export const NAME
      let m = line.match(/^\s*export\s+(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/);
      if (m) { out.push({ name: m[1], line: i + 1 }); continue; }

      // export default function NAME / export default class NAME
      m = line.match(/^\s*export\s+default\s+(?:async\s+)?(?:function\*?|class)\s+([A-Za-z_$][\w$]*)/);
      if (m) { out.push({ name: m[1], line: i + 1, isDefault: true }); continue; }

      // export { a, b as c }
      m = line.match(/^\s*export\s*\{\s*([^}]+)\s*\}/);
      if (m) {
        const names = m[1].split(',').map((s) => {
          const parts = s.trim().split(/\s+as\s+/);
          return (parts[1] || parts[0]).trim();
        }).filter(Boolean);
        for (const n of names) out.push({ name: n, line: i + 1 });
        continue;
      }

      // module.exports.NAME = ... or exports.NAME = ...
      m = line.match(/^\s*(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/);
      if (m) { out.push({ name: m[1], line: i + 1 }); continue; }
    }
    return out;
  }

  /**
   * Parse JS/TS imports — both the names imported and the module path.
   * Matches:
   *   import Foo from './bar'
   *   import { a, b as c } from './bar'
   *   import * as ns from './bar'
   *   const foo = require('./bar')
   *   const { a, b } = require('./bar')
   *   import('./bar')
   */
  _extractJsImports(content) {
    const names = new Set();
    const paths = new Set();

    const importRe = /import\s+(?:(\*\s+as\s+[A-Za-z_$][\w$]*)|([A-Za-z_$][\w$]*)|(\{[^}]*\})|(\{[^}]*\}\s*,\s*[A-Za-z_$][\w$]*)|([A-Za-z_$][\w$]*\s*,\s*\{[^}]*\}))?\s*(?:from\s+)?["']([^"']+)["']/g;
    let m;
    while ((m = importRe.exec(content)) !== null) {
      paths.add(m[6]);
      const spec = m[1] || m[2] || m[3] || m[4] || m[5] || '';
      if (spec) {
        const braces = spec.match(/\{([^}]*)\}/);
        if (braces) {
          for (const part of braces[1].split(',')) {
            const trimmed = part.trim();
            if (!trimmed) continue;
            const alias = trimmed.split(/\s+as\s+/);
            names.add(alias[0].trim());
          }
        }
        const bare = spec.match(/^([A-Za-z_$][\w$]*)/);
        if (bare) names.add(bare[1]);
      }
    }

    const requireRe = /require\s*\(\s*["']([^"']+)["']\s*\)/g;
    while ((m = requireRe.exec(content)) !== null) {
      paths.add(m[1]);
    }

    // Destructured require: const { a, b } = require('./x')
    const destructRe = /\{\s*([^}]+)\s*\}\s*=\s*require\s*\(\s*["']([^"']+)["']\s*\)/g;
    while ((m = destructRe.exec(content)) !== null) {
      for (const part of m[1].split(',')) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const alias = trimmed.split(/\s*:\s*/);
        names.add(alias[0].trim());
      }
    }

    const dynamicImportRe = /import\s*\(\s*["']([^"']+)["']\s*\)/g;
    while ((m = dynamicImportRe.exec(content)) !== null) {
      paths.add(m[1]);
    }

    return { names, paths };
  }

  /**
   * Python exports: top-level `def`, `class`, and module-level
   * assignments NAME = ...
   *
   * Names prefixed with `_` are treated as private (PEP 8) and not
   * emitted as exports — they're intentionally internal.
   */
  _extractPyExports(content) {
    const out = [];
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      // Must be at column 0 (no indent) to be module-level
      let m = line.match(/^(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/);
      if (m) {
        if (!m[1].startsWith('_')) out.push({ name: m[1], line: i + 1 });
        continue;
      }
      m = line.match(/^class\s+([A-Za-z_][\w]*)/);
      if (m) {
        if (!m[1].startsWith('_')) out.push({ name: m[1], line: i + 1 });
        continue;
      }
      m = line.match(/^([A-Z][A-Z0-9_]*)\s*=/);
      if (m) out.push({ name: m[1], line: i + 1 });
    }
    return out;
  }

  _extractPyImports(content) {
    const names = new Set();
    const paths = new Set();
    const lines = content.split('\n');
    for (const line of lines) {
      // from X import a, b as c
      let m = line.match(/^\s*from\s+([.\w]+)\s+import\s+(.+?)(?:\s*#.*)?$/);
      if (m) {
        paths.add(m[1]);
        for (const part of m[2].split(',')) {
          const trimmed = part.trim();
          if (!trimmed || trimmed === '*') continue;
          const alias = trimmed.split(/\s+as\s+/);
          names.add(alias[0].trim());
        }
        continue;
      }
      // import x, y as z
      m = line.match(/^\s*import\s+(.+?)(?:\s*#.*)?$/);
      if (m) {
        for (const part of m[1].split(',')) {
          const trimmed = part.trim();
          if (!trimmed) continue;
          const alias = trimmed.split(/\s+as\s+/);
          const first = alias[0].trim().split('.')[0];
          names.add(alias[1] ? alias[1].trim() : first);
          paths.add(alias[0].trim());
        }
      }
    }
    return { names, paths };
  }

  /**
   * Resolve a relative import to an absolute file path on disk.
   * Returns null if it's a bare package import (react, lodash, etc.)
   * or we can't find a matching file.
   */
  _resolveImportPath(fromFile, importPath, projectRoot) {
    // Bare package / non-relative — skip
    if (!importPath) return null;
    if (!importPath.startsWith('.') && !importPath.startsWith('/')) return null;

    const base = importPath.startsWith('/')
      ? path.join(projectRoot, importPath)
      : path.resolve(path.dirname(fromFile), importPath);

    // Try exact, with extensions, and as index within a directory
    const candidates = [
      base,
      ...Array.from(ALL_EXTS).map((e) => base + e),
      ...Array.from(ALL_EXTS).map((e) => path.join(base, 'index' + e)),
      ...Array.from(ALL_EXTS).map((e) => path.join(base, '__init__' + e)),
    ];
    for (const c of candidates) {
      try {
        const st = fs.statSync(c);
        if (st.isFile()) return path.normalize(c);
      } catch {
        // keep going
      }
    }
    return null;
  }

  _isEntryPoint(file, projectRoot) {
    const rel = path.relative(projectRoot, file).replace(/\\/g, '/');
    const base = path.basename(file);
    if (ENTRYPOINT_BASENAMES.has(base)) return true;
    for (const dir of ENTRYPOINT_DIRS) {
      if (rel === dir.slice(0, -1) || rel.startsWith(dir)) return true;
    }
    // Next.js-style route files (page.tsx / layout.tsx / route.ts)
    if (/\b(page|layout|route|loading|error|not-found|template|default|global-error)\.(tsx?|jsx?)$/.test(base)) {
      return true;
    }
    // Next.js file-based metadata / assets conventions
    if (/^(opengraph-image|twitter-image|icon|apple-icon|favicon|robots|sitemap|manifest)(\.[^.]+)?\.(tsx?|jsx?|ts|js)$/.test(base)) {
      return true;
    }
    return false;
  }

  _flagUnusedExports(index, result) {
    let issues = 0;
    for (const [file, info] of index.perFile.entries()) {
      for (const exp of info.exports) {
        if (FRAMEWORK_RESERVED.has(exp.name)) continue;
        if (exp.isDefault) continue; // default exports get imported under any name
        if (index.importedNames.has(exp.name)) continue;

        issues += this._flag(result, `dead-code:unused-export:${info.rel}:${exp.line}:${exp.name}`, {
          severity: 'warning',
          file: info.rel,
          line: exp.line,
          export: exp.name,
          message: `\`${exp.name}\` is exported from ${info.rel} but no file in the project imports it — candidate dead code`,
          suggestion: 'Delete the export (and its body if it\'s only used here), or wire it up from a live caller.',
        });
      }
    }
    return issues;
  }

  _flagOrphanedFiles(index, result) {
    let issues = 0;
    for (const [file, info] of index.perFile.entries()) {
      if (info.exports.length === 0) continue;
      if (this._isEntryPoint(file, index.projectRoot)) continue;
      if (index.referencedFiles.has(path.normalize(file))) continue;

      issues += this._flag(result, `dead-code:orphan-file:${info.rel}`, {
        severity: 'info',
        file: info.rel,
        message: `${info.rel} exports ${info.exports.length} symbol(s) but no file in the project imports it — candidate orphaned module`,
        suggestion: 'If this module is legitimately reachable via a path alias, dynamic require, or non-JS entry point, mark it as such. Otherwise delete.',
      });
    }
    return issues;
  }

  _flagCommentedOutBlocks(files, projectRoot, result) {
    let issues = 0;
    for (const file of files) {
      let content;
      try {
        content = fs.readFileSync(file, 'utf-8');
      } catch { continue; }

      const ext = path.extname(file).toLowerCase();
      const lang = PY_EXTS.has(ext) ? 'py' : 'js';
      const rel = path.relative(projectRoot, file);
      const lines = content.split('\n');

      let run = 0;
      let runStart = 0;
      const emit = (from, count) => {
        if (count < 10) return;
        issues += this._flag(result, `dead-code:commented-block:${rel}:${from}`, {
          severity: 'info',
          file: rel,
          line: from,
          message: `${count}-line commented-out block at ${rel}:${from} — rotting code`,
          suggestion: 'Delete the block. If you need it later, `git log` has it. Comments should explain live code, not preserve dead code.',
        });
      };

      for (let i = 0; i < lines.length; i += 1) {
        const t = lines[i].trim();
        const isComment = lang === 'js'
          ? (t.startsWith('//') && !t.startsWith('///'))
          : t.startsWith('#') && !t.startsWith('#!');
        // A commented-out "code" line, not a doc comment or banner.
        // Heuristic: contains at least one of [=(){};,] after the marker.
        const marker = lang === 'js' ? '//' : '#';
        const body = t.startsWith(marker) ? t.slice(marker.length).trim() : '';
        const looksLikeCode = isComment && /[=(){};]/.test(body);

        if (looksLikeCode) {
          if (run === 0) runStart = i + 1;
          run += 1;
        } else {
          emit(runStart, run);
          run = 0;
        }
      }
      emit(runStart, run);
    }
    return issues;
  }

  _flag(result, name, details) {
    result.addCheck(name, false, details);
    return 1;
  }
}

module.exports = DeadCodeModule;
