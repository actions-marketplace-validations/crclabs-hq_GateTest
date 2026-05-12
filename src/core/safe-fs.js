// =============================================================================
// SAFE-FS — defensive filesystem helpers
// =============================================================================
// Phase 6 launch hardening (gaps 2 / 3 / 6 / 7 from the audit):
//
//   - Cap file size before readFileSync — minified bundles or accidental
//     2GB log files crash the runner with OOM today
//   - Trap EACCES / EPERM / EISDIR / ENOENT — one unreadable file currently
//     kills an entire scan
//   - Detect non-utf8 encodings (UTF-16 / Latin-1 / binary mistaken-for-text)
//     so modules don't generate garbage findings against random byte streams
//   - Walk a directory with built-in skips (node_modules / .git / dist / etc),
//     a max-files ceiling, a max-depth ceiling, a per-file size cap, and
//     graceful per-entry error handling
//
// Every helper is a pure function. No side effects beyond reading the FS.
// All errors are converted into return values so callers don't have to wrap
// every call in try/catch.
// =============================================================================

const fs = require('fs');
const path = require('path');

// 1MB default — covers 99% of source files; bundles / minified output that
// blow past this are exactly what we want to skip anyway.
const DEFAULT_MAX_BYTES = 1024 * 1024;

// 5000 default — most real codebases have far fewer source files. Enterprise
// monorepos can override per-module via { maxFiles }.
const DEFAULT_MAX_FILES = 5000;

// 25 default — deeper than any healthy import structure but bounded against
// symlink loops and pathological recursion.
const DEFAULT_MAX_DEPTH = 25;

const DEFAULT_SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  'coverage',
  '.coverage',
  '.nyc_output',
  'vendor',
  'target',
  '.gradle',
  '.idea',
  '.vscode',
  '__pycache__',
  '.venv',
  'venv',
  'env',
  '.tox',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  'bower_components',
  'jspm_packages',
  '.parcel-cache',
  'tmp',
  'temp',
]);

// =============================================================================
// Encoding detection
// =============================================================================

/**
 * Return one of: "utf-8", "utf-16-le", "utf-16-be", "binary", "ascii"
 * Heuristic — looks at the first 512 bytes for BOMs and high-byte density.
 */
function detectEncoding(buffer) {
  if (!buffer || buffer.length === 0) return 'utf-8';
  // BOM markers
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return 'utf-8';
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return 'utf-16-le';
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) return 'utf-16-be';

  // Sample first 512 bytes
  const sampleSize = Math.min(buffer.length, 512);
  let nullBytes = 0;
  let highBytes = 0;
  for (let i = 0; i < sampleSize; i++) {
    const b = buffer[i];
    if (b === 0) nullBytes++;
    else if (b >= 0x80) highBytes++;
  }

  // Lots of nulls = likely binary or UTF-16 without BOM
  if (nullBytes > sampleSize * 0.05) return 'binary';
  // Pure ASCII (no high bytes)
  if (highBytes === 0) return 'ascii';
  // High bytes present — assume utf-8 (validated by Buffer.toString failure path
  // in the caller if it's actually invalid)
  return 'utf-8';
}

// =============================================================================
// safeReadFile
// =============================================================================

/**
 * Read a file with full error handling.
 *
 * @param {string} filePath
 * @param {object} [opts]
 * @param {number} [opts.maxBytes] — cap, file truncated to this size
 * @returns {{ ok: boolean, content?: string, encoding?: string, reason?: string, size?: number }}
 */
function safeReadFile(filePath, opts = {}) {
  const maxBytes = typeof opts.maxBytes === 'number' ? opts.maxBytes : DEFAULT_MAX_BYTES;

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (err) {
    return { ok: false, reason: errorReason(err) };
  }

  if (stat.isDirectory()) return { ok: false, reason: 'is-directory' };
  if (!stat.isFile()) return { ok: false, reason: 'not-a-file' };

  if (stat.size > maxBytes) {
    return { ok: false, reason: 'too-large', size: stat.size };
  }

  let buffer;
  try {
    buffer = fs.readFileSync(filePath);
  } catch (err) {
    return { ok: false, reason: errorReason(err) };
  }

  const encoding = detectEncoding(buffer);
  if (encoding === 'binary') {
    return { ok: false, reason: 'binary', size: stat.size };
  }

  let content;
  if (encoding === 'utf-16-le' || encoding === 'utf-16-be') {
    // Convert by byte-swap then utf-16le decode (Node only natively decodes utf-16le)
    let decodable = buffer;
    if (encoding === 'utf-16-be') {
      decodable = Buffer.alloc(buffer.length);
      for (let i = 0; i < buffer.length - 1; i += 2) {
        decodable[i] = buffer[i + 1];
        decodable[i + 1] = buffer[i];
      }
    }
    content = decodable.toString('utf16le');
    // Strip BOM if present after decode
    if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
  } else {
    content = buffer.toString('utf-8');
    if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
  }

  return { ok: true, content, encoding, size: stat.size };
}

function errorReason(err) {
  if (!err || !err.code) return 'unknown';
  switch (err.code) {
    case 'EACCES':
    case 'EPERM':
      return 'permission-denied';
    case 'ENOENT':
      return 'not-found';
    case 'EISDIR':
      return 'is-directory';
    case 'EMFILE':
    case 'ENFILE':
      return 'file-handle-exhausted';
    case 'ELOOP':
      return 'symlink-loop';
    default:
      return err.code;
  }
}

// =============================================================================
// walkFiles — bounded directory walker
// =============================================================================

/**
 * Walk a directory tree.
 *
 * @param {string} root — absolute or repo-relative directory to walk
 * @param {object} [opts]
 * @param {Set<string>} [opts.skipDirs] — directory NAMES (not paths) to skip
 * @param {number} [opts.maxFiles] — total file ceiling (default 5000)
 * @param {number} [opts.maxDepth] — recursion depth ceiling (default 25)
 * @param {(relPath: string) => boolean} [opts.filter] — return true to keep
 *   (called BEFORE size/encoding checks; cheap path-based prefilter)
 * @returns {{ files: string[], skipped: { path: string, reason: string }[],
 *             truncatedAt: number | null }}
 */
function walkFiles(root, opts = {}) {
  const skipDirs = opts.skipDirs instanceof Set ? opts.skipDirs : DEFAULT_SKIP_DIRS;
  const maxFiles = typeof opts.maxFiles === 'number' ? opts.maxFiles : DEFAULT_MAX_FILES;
  const maxDepth = typeof opts.maxDepth === 'number' ? opts.maxDepth : DEFAULT_MAX_DEPTH;
  const userFilter = typeof opts.filter === 'function' ? opts.filter : () => true;

  // Optional gitignore-respect — built lazily so the cost is zero when the
  // caller doesn't need it.
  let ignoreMatcher = null;
  if (opts.respectGitignore) {
    // Delayed require to avoid a circular dep
    const { buildIgnoreMatcher } = require('./gitignore');
    ignoreMatcher = buildIgnoreMatcher(root);
  }

  const filter = (rel) => {
    if (ignoreMatcher && ignoreMatcher(rel, false)) return false;
    return userFilter(rel);
  };

  const files = [];
  const skipped = [];
  let truncatedAt = null;

  // Iterative BFS so we don't blow the stack on deep trees
  const queue = [{ dir: root, depth: 0 }];
  const visitedRealPaths = new Set();

  while (queue.length > 0) {
    if (files.length >= maxFiles) {
      truncatedAt = files.length;
      break;
    }

    const { dir, depth } = queue.shift();
    if (depth > maxDepth) {
      skipped.push({ path: dir, reason: 'max-depth' });
      continue;
    }

    // Symlink-loop protection via realpath
    let realDir;
    try {
      realDir = fs.realpathSync(dir);
    } catch (err) {
      skipped.push({ path: dir, reason: errorReason(err) });
      continue;
    }
    if (visitedRealPaths.has(realDir)) continue;
    visitedRealPaths.add(realDir);

    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      skipped.push({ path: dir, reason: errorReason(err) });
      continue;
    }

    for (const entry of entries) {
      if (files.length >= maxFiles) {
        truncatedAt = files.length;
        break;
      }
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).split(path.sep).join('/');

      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        if (entry.name.startsWith('.') && entry.name !== '.github' && entry.name !== '.husky') {
          // dotdirs default-skip, except a handful that carry signal
          continue;
        }
        queue.push({ dir: full, depth: depth + 1 });
      } else if (entry.isFile()) {
        if (!filter(rel)) continue;
        files.push(full);
      } else if (entry.isSymbolicLink()) {
        // Resolve once and re-classify
        try {
          const linkStat = fs.statSync(full);
          if (linkStat.isFile() && filter(rel)) files.push(full);
          else if (linkStat.isDirectory() && !skipDirs.has(entry.name)) {
            queue.push({ dir: full, depth: depth + 1 });
          }
        } catch (err) {
          skipped.push({ path: full, reason: errorReason(err) });
        }
      }
      // Anything else (sockets, fifos, char devs) is silently ignored
    }
  }

  return { files, skipped, truncatedAt };
}

// =============================================================================
// Convenience: read every text file in a directory, capped + safe
// =============================================================================

/**
 * Walk + read in one pass. Returns ONLY successfully-read text files.
 *
 * @param {string} root
 * @param {object} [opts] — passed to walkFiles + safeReadFile
 * @returns {{
 *   files: { path: string, relativePath: string, content: string, encoding: string }[],
 *   skipped: { path: string, reason: string }[],
 *   truncatedAt: number | null
 * }}
 */
function readTextFiles(root, opts = {}) {
  const walk = walkFiles(root, opts);
  const out = [];
  const skipped = [...walk.skipped];

  for (const file of walk.files) {
    const r = safeReadFile(file, opts);
    if (r.ok) {
      out.push({
        path: file,
        relativePath: path.relative(root, file).split(path.sep).join('/'),
        content: r.content,
        encoding: r.encoding,
      });
    } else {
      skipped.push({ path: file, reason: r.reason });
    }
  }

  return { files: out, skipped, truncatedAt: walk.truncatedAt };
}

module.exports = {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_FILES,
  DEFAULT_MAX_DEPTH,
  DEFAULT_SKIP_DIRS,
  detectEncoding,
  errorReason,
  safeReadFile,
  walkFiles,
  readTextFiles,
};
