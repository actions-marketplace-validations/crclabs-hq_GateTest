/**
 * GateTest Runner - Orchestrates test module execution.
 * Enforces zero-tolerance: any single error blocks the entire pipeline.
 * Supports severity levels: error (blocks), warning (reports), info (informational).
 */

const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

// AI Fix Engine — injected after all modules run, before the autoFix pass.
// Adds autoFix closures to any check that has a file path + fix hint but
// no existing autoFix function. This makes every module AI-fixable.
let _aiFix;
try { _aiFix = require('./ai-fix-engine'); } catch { _aiFix = null; }

// Confidence scoring — each finding gets a 0..1 score from context.
// Low-confidence error-severity findings are soft-blocked (downgraded
// to warning-equivalent at gate time) so doc-string examples, fixture
// files, and example data don't cause noise.
const {
  DEFAULT_CONFIDENCE,
  BLOCK_THRESHOLD,
  scoreFinding,
  isBlockingFinding,
} = require('./confidence');

/** Severity levels — only 'error' blocks the gate. */
const Severity = {
  ERROR: 'error',
  WARNING: 'warning',
  INFO: 'info',
};

/**
 * Source cache — lazily reads file contents the first time confidence
 * scoring asks for it, then reuses for subsequent lookups. Shared
 * across all TestResult instances in a single run via the runner.
 */
class SourceCache {
  constructor(projectRoot) {
    this.projectRoot = projectRoot || process.cwd();
    this.cache = new Map();
  }

  read(filePath) {
    if (!filePath) return null;
    const abs = path.isAbsolute(filePath) ? filePath : path.join(this.projectRoot, filePath);
    if (this.cache.has(abs)) return this.cache.get(abs);
    let content = null;
    try {
      // Bound by stat — don't load huge minified bundles
      const st = fs.statSync(abs);
      if (st.isFile() && st.size <= 2 * 1024 * 1024) {
        content = fs.readFileSync(abs, 'utf-8');
      }
    } catch {
      content = null;
    }
    this.cache.set(abs, content);
    return content;
  }
}

class TestResult {
  constructor(moduleName, options = {}) {
    this.module = moduleName;
    this.status = 'pending';  // pending | running | passed | failed | skipped
    this.checks = [];
    this.fixes = [];          // auto-fix records
    this.startTime = null;
    this.endTime = null;
    this.duration = 0;
    this.error = null;
    // Confidence-scoring context — injected by the runner. When absent
    // (e.g. tests that build TestResult directly) confidence defaults
    // to DEFAULT_CONFIDENCE so callers see the legacy "always block"
    // behaviour.
    this._sourceCache = options.sourceCache || null;
    this._blockThreshold = typeof options.blockThreshold === 'number'
      ? options.blockThreshold
      : BLOCK_THRESHOLD;
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
   * @param {Function} [details.autoFix] - Function that auto-fixes the issue
   * @param {number} [details.confidence] - Explicit confidence 0..1. If
   *   absent, computed from path + source context. Errors below
   *   `blockThreshold` (default 0.7) do not block the gate.
   */
  addCheck(name, passed, details = {}) {
    const severity = details.severity || (passed ? Severity.INFO : Severity.ERROR);

    // Compute confidence ONLY for failing error/warning checks — passing
    // checks and info-level checks don't need scoring (they never block).
    let confidence;
    let confidenceSignals;
    if (typeof details.confidence === 'number') {
      // Explicit caller value wins
      confidence = details.confidence;
      confidenceSignals = details.confidenceSignals || [];
    } else if (!passed && (severity === Severity.ERROR || severity === Severity.WARNING)) {
      const filePath = details.file || details.filePath;
      let sourceText = null;
      if (filePath && this._sourceCache) {
        sourceText = this._sourceCache.read(filePath);
      }
      const scored = scoreFinding({
        filePath,
        ruleKey: name,
        module: this.module,
        message: details.message,
        line: details.line,
        column: details.column,
        sourceText,
      });
      confidence = scored.confidence;
      confidenceSignals = scored.signals;
    } else {
      confidence = DEFAULT_CONFIDENCE;
      confidenceSignals = [];
    }

    this.checks.push({
      name,
      passed,
      severity,
      timestamp: Date.now(),
      ...details,
      confidence,
      confidenceSignals,
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

  /**
   * Errors that are CONFIDENT enough to actually block the gate.
   * (severity === 'error' AND confidence >= blockThreshold)
   */
  get blockingErrorChecks() {
    const t = this._blockThreshold;
    return this.checks.filter(c => isBlockingFinding(c, t));
  }

  /**
   * Errors that fell below the confidence threshold — reported but
   * don't block.
   */
  get softErrorChecks() {
    const t = this._blockThreshold;
    return this.checks.filter(c =>
      !c.passed && c.severity === Severity.ERROR && !isBlockingFinding(c, t),
    );
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
      blockingErrors: this.blockingErrorChecks.length,
      softErrors: this.softErrorChecks.length,
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
      confidenceThreshold: BLOCK_THRESHOLD,
      ...options,
    };
    // Shared source cache for confidence scoring across all modules
    const projectRoot = (config && config.projectRoot) || process.cwd();
    this._sourceCache = new SourceCache(projectRoot);
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

    // Build an absolute-path Set of changed files once per run, then
    // stamp it onto each module so BaseModule._collectFiles can filter.
    // Bigger picture: this is the one wire that turns the whole engine
    // incremental — modules don't need any per-module change to gain
    // the speedup, just to keep using _collectFiles.
    if (
      this.options.diffOnly &&
      Array.isArray(this.options.changedFiles) &&
      this.options.changedFiles.length > 0 &&
      this.config &&
      this.config.projectRoot
    ) {
      const path = require('path');
      const root = this.config.projectRoot;
      const changedAbs = new Set(
        this.options.changedFiles.map((f) => path.resolve(root, f))
      );
      for (const mod of this.modules.values()) {
        mod._incrementalContext = {
          changedFilesAbs: changedAbs,
          changedFilesRel: this.options.changedFiles.slice(),
          projectRoot: root,
        };
      }
    }

    const modulesToRun = moduleNames || Array.from(this.modules.keys());

    this.emit('suite:start', { modules: modulesToRun, diffOnly: this.options.diffOnly });

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
    const result = new TestResult(name, {
      sourceCache: this._sourceCache,
      blockThreshold: this.options.confidenceThreshold,
    });

    if (!mod) {
      result.skip(`Module "${name}" not registered`);
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
      await mod.run(result, moduleConfig);

      // Only CONFIDENT errors block — soft errors (below threshold) are
      // surfaced in the report but don't fail the module. Warnings always
      // pass through. This kills the false-positive friction Craig hit
      // on PR #85: doc-string examples and example fixtures still show
      // up, they just don't fail CI.
      if (result.blockingErrorChecks.length > 0) {
        result.fail(
          `${result.blockingErrorChecks.length} error(s): ${result.blockingErrorChecks.map(c => c.name).join(', ')}`
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

      // Re-evaluate module status after fixes — only confident errors
      // can re-fail the module.
      if (result.status === 'failed' && result.blockingErrorChecks.length === 0) {
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
    const totalBlockingErrors = this.results.reduce(
      (sum, r) => sum + r.blockingErrorChecks.length, 0,
    );
    const totalSoftErrors = this.results.reduce(
      (sum, r) => sum + r.softErrorChecks.length, 0,
    );
    const totalWarnings = this.results.reduce((sum, r) => sum + r.warningChecks.length, 0);
    const totalFixes = this.results.reduce((sum, r) => sum + r.fixes.length, 0);

    // GATE DECISION: only CONFIDENT errors block. Failed modules block
    // unconditionally (runtime exceptions, module crashes). Soft errors
    // are visible in the report but don't fail the gate.
    const gateStatus = (failed.length === 0 && totalBlockingErrors === 0) ? 'PASSED' : 'BLOCKED';

    return {
      gateStatus,
      timestamp: new Date().toISOString(),
      duration: endTime - startTime,
      diffOnly: this.options.diffOnly,
      changedFiles: this.options.changedFiles,
      confidenceThreshold: this.options.confidenceThreshold,
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
        blockingErrors: totalBlockingErrors,
        softErrors: totalSoftErrors,
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
