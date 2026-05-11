/**
 * GateTest Runner - Orchestrates test module execution.
 * Enforces zero-tolerance: any single error blocks the entire pipeline.
 * Supports severity levels: error (blocks), warning (reports), info (informational).
 */

const { EventEmitter } = require('events');

// AI Fix Engine — injected after all modules run, before the autoFix pass.
// Adds autoFix closures to any check that has a file path + fix hint but
// no existing autoFix function. This makes every module AI-fixable.
let _aiFix;
try { _aiFix = require('./ai-fix-engine'); } catch { _aiFix = null; }

/** Severity levels — only 'error' blocks the gate. */
const Severity = {
  ERROR: 'error',
  WARNING: 'warning',
  INFO: 'info',
};

class TestResult {
  constructor(moduleName) {
    this.module = moduleName;
    this.status = 'pending';  // pending | running | passed | failed | skipped
    this.checks = [];
    this.fixes = [];          // auto-fix records
    this.startTime = null;
    this.endTime = null;
    this.duration = 0;
    this.error = null;
  }

  start() {
    this.status = 'running';
    this.startTime = Date.now();
  }

  /**
   * Add a check result.
   * @param {string} name - Check identifier
   * @param {boolean} passed - Whether the check passed
   * @param {object} details - Additional details
   * @param {string} [details.severity='error'] - Severity: 'error', 'warning', or 'info'
   * @param {string} [details.fix] - Human-readable fix suggestion
   * @param {Function} [details.autoFix] - Function that auto-fixes the issue. Returns { fixed: boolean, description: string }
   */
  addCheck(name, passed, details = {}) {
    const severity = details.severity || (passed ? Severity.INFO : Severity.ERROR);
    this.checks.push({
      name,
      passed,
      severity,
      timestamp: Date.now(),
      ...details,
    });
  }

  /**
   * Record an applied auto-fix.
   */
  addFix(checkName, description, filesChanged = []) {
    this.fixes.push({
      check: checkName,
      description,
      filesChanged,
      timestamp: Date.now(),
    });
  }

  pass() {
    this.status = 'passed';
    this.endTime = Date.now();
    this.duration = this.endTime - this.startTime;
  }

  fail(error) {
    this.status = 'failed';
    this.error = error;
    this.endTime = Date.now();
    this.duration = this.endTime - this.startTime;
  }

  skip(reason) {
    this.status = 'skipped';
    this.error = reason;
  }

  /** Checks that failed with severity 'error' — these block the gate. */
  get errorChecks() {
    return this.checks.filter(c => !c.passed && c.severity === Severity.ERROR);
  }

  /** Checks that failed with severity 'warning' — reported but don't block. */
  get warningChecks() {
    return this.checks.filter(c => !c.passed && c.severity === Severity.WARNING);
  }

  /** Informational checks. */
  get infoChecks() {
    return this.checks.filter(c => c.severity === Severity.INFO);
  }

  get failedChecks() {
    return this.checks.filter(c => !c.passed);
  }

  get passedChecks() {
    return this.checks.filter(c => c.passed);
  }

  toJSON() {
    return {
      module: this.module,
      status: this.status,
      duration: this.duration,
      totalChecks: this.checks.length,
      passedChecks: this.passedChecks.length,
      failedChecks: this.failedChecks.length,
      errors: this.errorChecks.length,
      warnings: this.warningChecks.length,
      fixes: this.fixes.length,
      checks: this.checks,
      appliedFixes: this.fixes,
      error: this.error ? String(this.error) : null,
    };
  }
}

class GateTestRunner extends EventEmitter {
  constructor(config, options = {}) {
    super();
    this.config = config;
    this.modules = new Map();
    this.results = [];
    this.options = {
      stopOnFirstFailure: false,
      parallel: false,
      autoFix: false,           // --fix: automatically apply safe fixes
      diffOnly: false,          // --diff: only scan git-changed files
      changedFiles: null,       // list of changed files (populated by diff mode)
      // --since <ref> / --pr: incremental scan. When set, modules only
      // see files changed in the working tree relative to <ref>. Modules
      // in config.incremental.skipList get skipped (they need full-repo
      // state); modules in alwaysRunList get full-repo state regardless.
      incrementalSince: null,
      incrementalFiles: null,   // resolved list of changed files (Set of abs paths)
      ...options,
    };
  }

  register(name, moduleInstance) {
    this.modules.set(name, moduleInstance);
  }

  async run(moduleNames) {
    const startTime = Date.now();
    this.results = [];

    // If diff mode, resolve changed files before running modules
    if (this.options.diffOnly && !this.options.changedFiles) {
      this.options.changedFiles = this._getChangedFiles();
    }

    // If --since / --pr was used, resolve the changed file list from git.
    // Honest fallback: if git fails, log a warning and fall through to a
    // full scan (don't crash). If 0 source files changed, return early
    // with a green summary — that's a success outcome, not a failure.
    if (this.options.incrementalSince && !this.options.incrementalFiles) {
      const ref = this.options.incrementalSince;
      const incremental = this._resolveIncrementalFiles(ref);
      if (incremental.error) {
        // Hard fallback: emit warning, run a full scan as if --since was
        // never set. The user gets a clear note in stderr.
        this.emit('incremental:fallback', { ref, reason: incremental.error });
        // eslint-disable-next-line no-console
        console.warn(
          `[GateTest] Incremental scan unavailable (${incremental.error}). ` +
          `Falling back to full scan.`,
        );
        this.options.incrementalSince = null;
      } else if (incremental.files.length === 0) {
        // No source files changed — green outcome. Print a clear note
        // and return a tiny summary rather than running 90 modules over
        // an unchanged tree. We use console.error (stderr) for the
        // user-facing CLI message — matches the existing
        // GateTestConfig pattern for tool-emitted notes.
        this.emit('incremental:empty', { ref });
        // error-ok — user-facing CLI announcement on stderr
        console.error(
          `[GateTest] No relevant files changed since ${ref} — nothing to scan.`,
        );
        const endTime = Date.now();
        return this._buildEmptyIncrementalSummary(startTime, endTime, ref);
      } else {
        this.options.incrementalFiles = new Set(incremental.files);
        // error-ok — user-facing CLI announcement on stderr
        console.error(
          `[GateTest] Incremental scan: ${incremental.files.length} file(s) ` +
          `changed since ${ref}`,
        );
        this.emit('incremental:resolved', {
          ref,
          fileCount: incremental.files.length,
          files: incremental.files,
        });
      }
    }

    const modulesToRun = moduleNames || Array.from(this.modules.keys());

    this.emit('suite:start', {
      modules: modulesToRun,
      diffOnly: this.options.diffOnly,
      incrementalSince: this.options.incrementalSince,
    });

    if (this.options.parallel) {
      await this._runParallel(modulesToRun);
    } else {
      await this._runSequential(modulesToRun);
    }

    // Inject AI autoFix closures onto checks that lack one (requires API key + file ref)
    if (this.config && this.config.projectRoot && _aiFix) {
      try { _aiFix.injectAutoFixes(this.results, this.config.projectRoot); } catch { /* non-fatal */ }
    }

    // Auto-fix pass: if enabled, run fixable checks
    if (this.options.autoFix) {
      await this._runAutoFixes();
    }

    const endTime = Date.now();
    const summary = this._buildSummary(startTime, endTime);

    this.emit('suite:end', summary);

    return summary;
  }

  async _runSequential(moduleNames) {
    for (const name of moduleNames) {
      const result = await this._runModule(name);
      this.results.push(result);

      if (result.status === 'failed' && this.options.stopOnFirstFailure) {
        break;
      }
    }
  }

  async _runParallel(moduleNames) {
    const promises = moduleNames.map(name => this._runModule(name));
    this.results = await Promise.all(promises);
  }

  async _runModule(name) {
    const mod = this.modules.get(name);
    const result = new TestResult(name);

    if (!mod) {
      result.skip(`Module "${name}" not registered`);
      this.emit('module:skip', result);
      return result;
    }

    // Incremental-mode skip list: modules that need full-repo state
    // (whole import graph, full env-var declaration set, etc.) get
    // skipped with a clear note rather than running on a partial
    // workspace and producing bogus results.
    if (this.options.incrementalFiles && this._isIncrementalSkipped(name)) {
      result.start();
      result.addCheck('incremental:skipped', true, {
        severity: 'info',
        message:
          `Module "${name}" needs full-repo state and is skipped in ` +
          `incremental mode. Run a full scan (no --since / --pr) to ` +
          `include it.`,
      });
      result.pass();
      this.emit('module:skip', result);
      return result;
    }

    result.start();
    this.emit('module:start', result);

    try {
      // Pass diff-mode context to module
      const moduleConfig = Object.create(this.config);
      moduleConfig._runnerOptions = this.options;
      // deployReadiness reads all prior results to compute the aggregate score
      moduleConfig._allResults = this.results;
      // Incremental file filter — picked up by BaseModule._collectFiles
      // and universal-checker.runLanguageChecks. Modules in the
      // alwaysRunList get the full repo state so their cross-cutting
      // logic still works.
      const useIncremental =
        !!this.options.incrementalFiles &&
        !this._isIncrementalAlwaysRun(name);
      if (useIncremental) {
        moduleConfig._incrementalFiles = this.options.incrementalFiles;
        // Stash the file Set on the module instance so BaseModule's
        // _collectFiles (which doesn't get config as a parameter) can
        // honour the filter transparently. Per-module-run scoped, never
        // leaks across modules: the finally block clears it.
        mod._currentIncrementalFiles = this.options.incrementalFiles;
      }
      try {
        await mod.run(result, moduleConfig);
      } finally {
        if (useIncremental) mod._currentIncrementalFiles = null;
      }

      // Only errors block — warnings are allowed through
      if (result.errorChecks.length > 0) {
        result.fail(
          `${result.errorChecks.length} error(s): ${result.errorChecks.map(c => c.name).join(', ')}`
        );
      } else {
        result.pass();
      }
    } catch (err) {
      result.fail(err);
    }

    this.emit('module:end', result);
    return result;
  }

  /**
   * Run auto-fixes for all fixable failed checks.
   *
   * Every successful fix is also recorded into the persistent MemoryStore so
   * future scans see this project's auto-fix history. This is what makes
   * memory-aware auto-fix a compounding moat: aiReview and agentic can
   * condition on "GateTest fixed this pattern N times before in this repo"
   * rather than re-suggesting the same fix in a vacuum.
   */
  async _runAutoFixes() {
    let totalFixed = 0;
    const memoryStore = this._getMemoryStoreSafe();
    for (const result of this.results) {
      for (const check of result.failedChecks) {
        if (typeof check.autoFix === 'function') {
          try {
            const fixResult = await check.autoFix();
            if (fixResult && fixResult.fixed) {
              check.passed = true;
              check.autoFixed = true;
              result.addFix(check.name, fixResult.description, fixResult.filesChanged || []);
              totalFixed++;

              if (memoryStore) {
                try {
                  memoryStore.recordFix({
                    checkName: check.name,
                    description: fixResult.description,
                    filesChanged: fixResult.filesChanged || [],
                  });
                } catch {
                  // Memory recording must never break an otherwise-good fix
                }
              }
            }
          } catch {
            // Fix failed — leave check as failed
          }
        }
      }

      // Re-evaluate module status after fixes
      if (result.status === 'failed' && result.errorChecks.length === 0) {
        result.status = 'passed';
        result.error = null;
      }
    }

    if (totalFixed > 0) {
      this.emit('autofix:complete', { totalFixed });
    }
  }

  /**
   * Best-effort MemoryStore accessor. Runner never hard-depends on memory
   * being present — if projectRoot or the memory module is missing, fix
   * recording silently no-ops.
   */
  _getMemoryStoreSafe() {
    try {
      const projectRoot = this.config && this.config.projectRoot;
      if (!projectRoot) return null;
      const { MemoryStore } = require('./memory');
      return new MemoryStore(projectRoot);
    } catch {
      return null;
    }
  }

  /**
   * Whether a module is on the incremental skip list (needs whole-repo
   * state). Lookup is config-driven so projects can override via
   * .gatetest.json.
   */
  _isIncrementalSkipped(name) {
    const list = this._getIncrementalConfigList('skipList');
    return list.includes(name);
  }

  /**
   * Whether a module always runs against the full repo regardless of
   * incremental mode (e.g. secret-rotation reads git history, prSize is
   * already a git diff against the base ref).
   */
  _isIncrementalAlwaysRun(name) {
    const list = this._getIncrementalConfigList('alwaysRunList');
    return list.includes(name);
  }

  _getIncrementalConfigList(key) {
    try {
      const cfg =
        (this.config && this.config.config && this.config.config.incremental) ||
        {};
      const list = cfg[key];
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  _getIncrementalSourceExtensions() {
    try {
      const cfg =
        (this.config && this.config.config && this.config.config.incremental) ||
        {};
      const list = cfg.sourceExtensions;
      if (Array.isArray(list) && list.length > 0) return list;
    } catch {
      // fall through
    }
    // Sensible default when config is unreachable (test scaffolding etc.)
    return [
      '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts',
      '.py', '.go', '.rs', '.java', '.rb', '.php', '.cs', '.kt', '.swift',
      '.yml', '.yaml', '.json', '.md', '.sh',
    ];
  }

  /**
   * Resolve the list of files changed since `<ref>` via
   *   git diff --name-only --diff-filter=ACMR <ref>...HEAD
   * Filters to source extensions and existing-on-disk files (a renamed-
   * to-deleted file would otherwise crash module readers).
   *
   * Returns { files: string[] } on success or { error: string } on
   * failure (not a git repo, ref doesn't exist, git missing, etc.). The
   * caller decides whether to fall back to a full scan or not — runner
   * always falls back rather than crashing.
   */
  _resolveIncrementalFiles(ref) {
    const path = require('path');
    const fs = require('fs');
    const { execSync } = require('child_process');

    const projectRoot =
      (this.config && this.config.projectRoot) || process.cwd();

    let raw;
    try {
      // ACMR = Added, Copied, Modified, Renamed. Excludes Deleted (no
      // current file to scan) and Type-changed.
      raw = execSync(
        `git diff --name-only --diff-filter=ACMR ${ref}...HEAD`,
        {
          encoding: 'utf-8',
          cwd: projectRoot,
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
    } catch (err) {
      // git missing, not a repo, ref unknown, etc. — return error so the
      // runner can decide what to do.
      const msg = (err && err.stderr ? String(err.stderr).trim() : '') ||
                  (err && err.message ? String(err.message) : 'git failed');
      return { error: msg.split('\n')[0].slice(0, 160) };
    }

    const sourceExts = new Set(
      this._getIncrementalSourceExtensions().map((e) => e.toLowerCase()),
    );

    const files = raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((rel) => path.resolve(projectRoot, rel))
      .filter((abs) => {
        const ext = path.extname(abs).toLowerCase();
        return sourceExts.has(ext);
      })
      .filter((abs) => {
        try { return fs.existsSync(abs); } catch { return false; }
      });

    return { files };
  }

  /**
   * When 0 source files changed, return a tiny "all clear" summary
   * rather than running 90 modules across an unchanged tree.
   */
  _buildEmptyIncrementalSummary(startTime, endTime, ref) {
    return {
      gateStatus: 'PASSED',
      timestamp: new Date().toISOString(),
      duration: endTime - startTime,
      diffOnly: this.options.diffOnly,
      changedFiles: [],
      incremental: { since: ref, fileCount: 0, skipped: true },
      modules: { total: 0, passed: 0, failed: 0, skipped: 0 },
      checks: { total: 0, passed: 0, failed: 0, errors: 0, warnings: 0 },
      fixes: { total: 0, details: [] },
      results: [],
      failedModules: [],
    };
  }

  /**
   * Get list of files changed relative to the merge-base with the default branch.
   */
  _getChangedFiles() {
    const { execSync } = require('child_process');
    try {
      // Get files changed vs merge-base with main/master
      const baseBranch = (() => {
        try {
          execSync('git rev-parse --verify main', { stdio: 'pipe' });
          return 'main';
        } catch {
          try {
            execSync('git rev-parse --verify master', { stdio: 'pipe' });
            return 'master';
          } catch {
            return 'HEAD~1';
          }
        }
      })();

      const mergeBase = execSync(`git merge-base HEAD ${baseBranch}`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();

      const diff = execSync(`git diff --name-only ${mergeBase}`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();

      // Also include staged and unstaged changes
      const staged = execSync('git diff --cached --name-only', {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();

      const unstaged = execSync('git diff --name-only', {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();

      const allChanged = new Set([
        ...diff.split('\n').filter(Boolean),
        ...staged.split('\n').filter(Boolean),
        ...unstaged.split('\n').filter(Boolean),
      ]);

      return Array.from(allChanged);
    } catch {
      return null; // Fall back to full scan
    }
  }

  _buildSummary(startTime, endTime) {
    const passed = this.results.filter(r => r.status === 'passed');
    const failed = this.results.filter(r => r.status === 'failed');
    const skipped = this.results.filter(r => r.status === 'skipped');

    const totalChecks = this.results.reduce((sum, r) => sum + r.checks.length, 0);
    const passedChecks = this.results.reduce((sum, r) => sum + r.passedChecks.length, 0);
    const failedChecks = this.results.reduce((sum, r) => sum + r.failedChecks.length, 0);
    const totalErrors = this.results.reduce((sum, r) => sum + r.errorChecks.length, 0);
    const totalWarnings = this.results.reduce((sum, r) => sum + r.warningChecks.length, 0);
    const totalFixes = this.results.reduce((sum, r) => sum + r.fixes.length, 0);

    // GATE DECISION: Failed modules or error-severity checks block the gate.
    const gateStatus = (failed.length === 0 && totalErrors === 0) ? 'PASSED' : 'BLOCKED';

    return {
      gateStatus,
      timestamp: new Date().toISOString(),
      duration: endTime - startTime,
      diffOnly: this.options.diffOnly,
      changedFiles: this.options.changedFiles,
      incremental: this.options.incrementalSince
        ? {
            since: this.options.incrementalSince,
            fileCount: this.options.incrementalFiles
              ? this.options.incrementalFiles.size
              : 0,
            skipped: false,
          }
        : null,
      modules: {
        total: this.results.length,
        passed: passed.length,
        failed: failed.length,
        skipped: skipped.length,
      },
      checks: {
        total: totalChecks,
        passed: passedChecks,
        failed: failedChecks,
        errors: totalErrors,
        warnings: totalWarnings,
      },
      fixes: {
        total: totalFixes,
        details: this.results.flatMap(r => r.fixes),
      },
      results: this.results.map(r => r.toJSON()),
      failedModules: failed.map(r => ({
        module: r.module,
        error: String(r.error),
        failedChecks: r.failedChecks,
      })),
    };
  }
}

module.exports = { GateTestRunner, TestResult, Severity };
