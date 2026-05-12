/**
 * Base Module - Abstract base class for all GateTest test modules.
 *
 * Phase 6 launch hardening (gaps 1, 2, 3, 6, 7 from the audit):
 *   - _collectFiles now delegates to src/core/safe-fs.walkFiles which:
 *       * caps total files (default 5000, configurable via opts.maxFiles)
 *       * caps recursion depth (default 25)
 *       * traps EACCES / EPERM / EISDIR / ENOENT per-entry (one bad
 *         file no longer kills the scan)
 *       * follows symlinks via realpath with loop protection
 *       * optionally respects .gitignore (opts.respectGitignore)
 *   - _safeReadFile traps the same set of FS errors at read time and
 *     refuses oversize / binary / non-utf8 files cleanly
 *
 * Old _collectFiles signature preserved (projectRoot, patterns, excludes)
 * — every existing call site keeps working.
 */

const safeFs = require('../core/safe-fs');

class BaseModule {
  constructor(name, description) {
    this.name = name;
    this.description = description;
  }

  /**
   * Run the module's checks.
   * @param {TestResult} result - The result object to record checks against.
   * @param {GateTestConfig} config - The GateTest configuration.
   */
  async run(result, config) {
    throw new Error(`Module "${this.name}" must implement run()`);
  }

  /**
   * Collect files matching extension patterns from projectRoot.
   *
   * Built on top of `safe-fs.walkFiles` with bounded depth, file-count cap,
   * symlink-loop protection, per-entry error trapping, and optional
   * `.gitignore` honouring (Phase 6 launch hardening).
   *
   * Incremental scan support (`--since <ref>` / `--pr`): when the module
   * has `this._currentIncrementalFiles` set to a Set of absolute paths
   * (the runner stages it via `_collectFilesWithConfig` before calling
   * the module's run()), the returned list is filtered down to only
   * those files. This is what makes incremental mode 5x-30x faster on
   * a real PR — every file-walking module transparently sees only the
   * changed files via this single hook. Modules opt out by being on
   * the runner's `incremental.alwaysRunList` or by reading
   * `config._incrementalFiles` directly.
   *
   * @param {string} projectRoot
   * @param {string[]} patterns — file extensions including dot (e.g. ['.js', '.ts'])
   *   or ['*'] to match any extension
   * @param {string[]} [excludes] — extra directory names to skip
   * @param {object} [opts] — { maxFiles, maxDepth, respectGitignore }
   *   maxFiles defaults to 5000; pass higher for monorepos that genuinely need
   *   deeper scans, lower for routes with tight time budgets
   * @returns {string[]} absolute paths
   */
  _collectFiles(projectRoot, patterns, excludes = [], opts = {}) {
    const path = require('path');
    const allowAny = patterns.includes('*');
    const allowedExts = new Set(patterns.map((p) => p.toLowerCase()));

    // Merge module's extra excludes into the default skip set.
    // .gatetest, .claude (agent worktrees), .svelte-kit, .output, .vercel
    // are GateTest-specific noise sources not in the safe-fs default list.
    const skipDirs = new Set(safeFs.DEFAULT_SKIP_DIRS);
    skipDirs.add('.gatetest');
    skipDirs.add('.claude');
    skipDirs.add('.svelte-kit');
    skipDirs.add('.output');
    skipDirs.add('.vercel');
    skipDirs.add('public/build');
    skipDirs.add('.cargo');
    for (const e of excludes) skipDirs.add(e);

    const walk = safeFs.walkFiles(projectRoot, {
      skipDirs,
      maxFiles: typeof opts.maxFiles === 'number' ? opts.maxFiles : safeFs.DEFAULT_MAX_FILES,
      maxDepth: typeof opts.maxDepth === 'number' ? opts.maxDepth : safeFs.DEFAULT_MAX_DEPTH,
      respectGitignore: opts.respectGitignore === true,
      filter: (rel) => {
        const ext = path.extname(rel).toLowerCase();
        return allowAny || allowedExts.has(ext);
      },
    });

    // Surface the truncation as a side-channel field readable by callers
    // that care to expose it (e.g. info-level "X files skipped over cap").
    if (walk.truncatedAt !== null) {
      this._lastWalkTruncated = walk.truncatedAt;
    } else {
      this._lastWalkTruncated = null;
    }
    this._lastWalkSkipped = walk.skipped;

    // Incremental filter — applied AFTER the walk so `excludes`,
    // `patterns`, and the Phase 6 safe-fs guarantees all stay intact.
    // The incremental Set is keyed by absolute paths so a `path.resolve`
    // is sufficient cross-platform.
    const incremental = this._currentIncrementalFiles;
    if (incremental && incremental.size > 0) {
      return walk.files.filter((abs) => incremental.has(path.resolve(abs)));
    }

    return walk.files;
  }

  /**
   * Read a single file safely. Returns { ok, content?, encoding?, reason?, size? }.
   * Modules should prefer this over fs.readFileSync — callers don't need to
   * wrap in try/catch and oversize/binary/encoding-mangled files are filtered
   * out cleanly with a structured `reason`.
   */
  _safeReadFile(filePath, opts = {}) {
    return safeFs.safeReadFile(filePath, opts);
  }

  /**
   * Convenience wrapper most modules can call instead of touching
   * `config._incrementalFiles` directly: pass it the module's `config`
   * object before calling `_collectFiles`. Stash-and-restore pattern so
   * concurrent module runs (under `--parallel`) don't trample each other.
   *
   * Most modules don't need to call this — the runner sets
   * `config._incrementalFiles` and BaseModule reads it at walk time
   * via `_collectFilesWithConfig`. Kept here for completeness.
   */
  _collectFilesWithConfig(config, projectRoot, patterns, excludes = []) {
    const previous = this._currentIncrementalFiles;
    this._currentIncrementalFiles =
      (config && config._incrementalFiles) || null;
    try {
      return this._collectFiles(projectRoot, patterns, excludes);
    } finally {
      this._currentIncrementalFiles = previous;
    }
  }

  /**
   * Run a shell command and return { stdout, stderr, exitCode }.
   */
  _exec(command, options = {}) {
    const { execSync } = require('child_process');
    try {
      const stdout = execSync(command, {
        encoding: 'utf-8',
        timeout: options.timeout || 60000,
        cwd: options.cwd || process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return { stdout, stderr: '', exitCode: 0 };
    } catch (err) {
      return {
        stdout: err.stdout || '',
        stderr: err.stderr || '',
        exitCode: err.status || 1,
      };
    }
  }
}

module.exports = BaseModule;
