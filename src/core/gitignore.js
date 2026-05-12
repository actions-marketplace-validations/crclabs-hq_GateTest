// =============================================================================
// GITIGNORE — minimal, dependency-free gitignore parser
// =============================================================================
// Phase 6 launch hardening (gap 1 from the audit):
//
// Most modules today walk the whole tree and re-implement their own ad-hoc
// "skip node_modules" logic. The result: false positives from generated code,
// 1000s of unwanted findings against minified bundles, and scans that take
// 10x longer than they should. This parser respects every level of nested
// .gitignore plus the global negation rules (`!pattern` to un-ignore).
//
// Compatibility:
//   - Standard gitignore syntax: leading `/`, trailing `/`, `**`, `*`, `?`,
//     character classes `[abc]`, negation `!`, blank lines + `#` comments
//   - Nested .gitignore — a child `.gitignore` adds rules ONLY for paths
//     under its directory
//   - Global excludes: `.gitignore` at the repo root, plus our own
//     hardcoded base-skip list (node_modules / .git / dist / etc) which
//     is non-negotiable even when a customer's .gitignore exempts them
//
// Compiles each pattern to a regex up front so per-file checks are fast.
// =============================================================================

const fs = require('fs');
const path = require('path');

const { safeReadFile } = require('./safe-fs');

// Base patterns we always skip — we treat these as if they were in a
// machine-wide .gitignore. Customer can never override (no point: scanning
// .git/HEAD generates noise nobody wants).
const HARD_SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg',
  'dist', 'build', 'out', '.next', '.nuxt', '.turbo', '.cache',
  'coverage', '.coverage', '.nyc_output',
  'vendor', 'target', '.gradle',
  '.idea', '.vscode',
  '__pycache__', '.venv', 'venv', '.tox', '.pytest_cache', '.mypy_cache', '.ruff_cache',
  'bower_components', 'jspm_packages', '.parcel-cache',
]);

/**
 * Compile one gitignore line into a regex matcher.
 * Returns { regex, negate, dirOnly } or null for blank/comment lines.
 *
 * @param {string} line — a single .gitignore line
 * @param {string} basePrefix — the directory the .gitignore lives in (relative
 *                               to repo root, slash-separated, no leading slash)
 */
function compilePattern(line, basePrefix = '') {
  let pat = line.replace(/\r$/, '');
  if (!pat || pat.startsWith('#')) return null;
  pat = pat.replace(/\\#/g, '#');
  pat = pat.trim();
  if (!pat) return null;

  let negate = false;
  if (pat.startsWith('!')) {
    negate = true;
    pat = pat.slice(1);
  }

  let dirOnly = false;
  if (pat.endsWith('/')) {
    dirOnly = true;
    pat = pat.slice(0, -1);
  }

  // Anchored patterns (start with `/`) are relative to the .gitignore's directory
  let anchored = false;
  if (pat.startsWith('/')) {
    anchored = true;
    pat = pat.slice(1);
  }
  // Patterns without a slash mid-string match anywhere in the tree (under base)
  const hasMidSlash = pat.indexOf('/') !== -1 && pat.indexOf('/') !== pat.length - 1;
  if (!hasMidSlash && !anchored) {
    // Match anywhere — rewrite to **/ prefix
    pat = '**/' + pat;
  }

  // Convert to regex
  const re = patternToRegex(pat, basePrefix, anchored);
  return { regex: re, negate, dirOnly, raw: line };
}

function patternToRegex(pat, basePrefix, anchored) {
  // Escape regex specials except for our wildcards
  let r = '';
  let i = 0;
  while (i < pat.length) {
    const ch = pat[i];
    if (ch === '*') {
      if (pat[i + 1] === '*') {
        // ** — match across slashes
        if (pat[i + 2] === '/') {
          r += '(?:.*/)?';
          i += 3;
        } else {
          r += '.*';
          i += 2;
        }
      } else {
        // * — match within a single path segment
        r += '[^/]*';
        i += 1;
      }
    } else if (ch === '?') {
      r += '[^/]';
      i += 1;
    } else if (ch === '[') {
      // character class — pass through, escape any backslashes
      const close = pat.indexOf(']', i + 1);
      if (close === -1) {
        r += '\\[';
        i += 1;
      } else {
        r += pat.slice(i, close + 1);
        i = close + 1;
      }
    } else if ('.+()|^$\\{}'.includes(ch)) {
      r += '\\' + ch;
      i += 1;
    } else {
      r += ch;
      i += 1;
    }
  }

  // Build the full anchored regex
  // Pattern matches if the trailing path matches `r` (file) OR a prefix
  // segment matches (directory containing files)
  const prefix = basePrefix ? basePrefix + '/' : '';
  const full = '^' + escapeRegex(prefix) + r + '(?:/.*)?$';
  return new RegExp(full);
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a matcher that decides whether a path should be ignored.
 * @param {string} root — repo root (absolute)
 * @returns {(relativePath: string, isDir?: boolean) => boolean}
 */
function buildIgnoreMatcher(root) {
  // Discover all .gitignore files within the tree (cheap — bounded walk)
  const ignoreFiles = collectGitignoreFiles(root);
  const compiled = [];
  for (const igPath of ignoreFiles) {
    const r = safeReadFile(igPath, { maxBytes: 256 * 1024 });
    if (!r.ok) continue;
    const baseDir = path.relative(root, path.dirname(igPath))
      .split(path.sep).join('/');
    const lines = r.content.split('\n');
    for (const line of lines) {
      const c = compilePattern(line, baseDir);
      if (c) compiled.push(c);
    }
  }

  return function matches(relativePath, isDir = false) {
    // Hard skips win — a customer can't .gitignore-negate node_modules back in
    const segs = relativePath.split('/');
    for (const seg of segs) {
      if (HARD_SKIP_DIRS.has(seg)) return true;
    }
    // Dotfiles at any depth — gitignore-style we already auto-skip dot-dirs
    // in the walker, but a stray dotfile (e.g. `.envrc`) we leave to the
    // caller's filter

    // Walk patterns in order; later (more-specific / negation) rules win
    let ignored = false;
    for (const c of compiled) {
      if (c.dirOnly && !isDir) continue;
      if (c.regex.test(relativePath)) {
        ignored = !c.negate;
      }
    }
    return ignored;
  };
}

function collectGitignoreFiles(root) {
  const out = [];
  const queue = [root];
  const skipDirs = HARD_SKIP_DIRS;

  while (queue.length) {
    const dir = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (skipDirs.has(e.name)) continue;
        if (e.name.startsWith('.') && e.name !== '.github' && e.name !== '.husky') continue;
        queue.push(path.join(dir, e.name));
      } else if (e.isFile() && e.name === '.gitignore') {
        out.push(path.join(dir, e.name));
      }
    }
  }

  return out;
}

module.exports = {
  HARD_SKIP_DIRS,
  compilePattern,
  buildIgnoreMatcher,
  collectGitignoreFiles,
};
