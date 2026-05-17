/**
 * PR-Size Enforcer Module.
 *
 * The single most reliable predictor of a buggy merge is raw PR size.
 * Google's internal research, Microsoft's engineering data, and every
 * serious post-mortem of production outages point at the same signal:
 * reviewers stop catching bugs in a PR somewhere between 400 and 500
 * lines changed. Past 800–1000 lines, review quality is effectively zero
 * — reviewers scan for obvious smells and rubber-stamp the rest.
 *
 * This module enforces PR hygiene at the gate, before a mega-PR ever
 * reaches a human reviewer. It compares HEAD against a configured base
 * ref (default: auto-detect via staged / working-tree / HEAD~1) and
 * flags diffs that exceed size thresholds.
 *
 * Competitors:
 *   - GitHub has a `diff too large` UI warning but no gate.
 *   - Danger.js has a plugin but needs a Dangerfile + CI config.
 *   - SonarQube / Snyk don't touch PR size.
 *   - Nothing enforces `max lines changed per file` AND
 *     `max total files` AND `mixed-concerns` simultaneously.
 *
 * Diff-resolution strategy (in priority order):
 *   1. Explicit `config.prSize.diff` or `runnerOptions.diff` (tests/CI).
 *   2. `config.prSize.baseBranch` configured (default `origin/main`,
 *      fallback `main`) → resolves merge-base with HEAD and diffs
 *      `<merge-base>..HEAD`. This is the bulletproof path: long-running
 *      feature branches only count the changes introduced ON the branch,
 *      not changes merged into main since the branch was created.
 *   3. Legacy `config.prSize.against` / `runnerOptions.against` → kept
 *      for backward compatibility; uses three-dot range `against...HEAD`
 *      which git interprets as merge-base..HEAD anyway.
 *   4. Auto-detect: try `origin/main`, then `main` merge-base; if neither
 *      resolves, fall back to staged → working-tree → `HEAD~1..HEAD`.
 *
 * Rules:
 *
 *   error:   PR exceeds the hard files-changed ceiling (default 100).
 *            Split the PR. No human can review 100+ files at once.
 *            (rule: `pr-size:too-many-files`)
 *
 *   error:   PR exceeds the hard lines-changed ceiling (default 1000).
 *            Added + removed, counted together.
 *            (rule: `pr-size:too-many-lines`)
 *
 *   error:   A single non-excluded file has more than `maxLinesPerFileError`
 *            (default 500) lines changed. Likely a generated-file blob
 *            that wasn't excluded, or a single-file rewrite that needs
 *            to be committed in stages.
 *            (rule: `pr-size:file-too-large:<relpath>`)
 *
 *   warning: PR exceeds the soft files-changed threshold (default 50).
 *            (rule: `pr-size:many-files`)
 *
 *   warning: PR exceeds the soft lines-changed threshold (default 500).
 *            This is where review quality starts to collapse.
 *            (rule: `pr-size:many-lines`)
 *
 *   warning: A single non-excluded file has more than
 *            `maxLinesPerFileWarning` (default 300) lines changed.
 *            (rule: `pr-size:large-file:<relpath>`)
 *
 *   warning: PR touches more than `maxTopLevelDirs` (default 3)
 *            top-level directories — likely mixing concerns (refactor
 *            + feature + config + docs in one PR).
 *            (rule: `pr-size:mixed-concerns`)
 *
 *   info:    Always — `pr-size:summary` with files / adds / removes counts.
 *
 * Config (modules.prSize):
 *   baseBranch:              base branch to find merge-base against
 *                            (default: auto — tries `origin/main` then
 *                            `main`). When set, the module diffs
 *                            `<merge-base>..HEAD` so only changes
 *                            introduced on this branch count.
 *   against:                 legacy base ref to diff against — uses
 *                            three-dot range `against...HEAD`. Prefer
 *                            `baseBranch` for new configs.
 *   maxFilesChangedWarning:  soft file ceiling (default 50)
 *   maxFilesChangedError:    hard file ceiling (default 100)
 *   maxLinesChangedWarning:  soft line ceiling (default 500)
 *   maxLinesChangedError:    hard line ceiling (default 1000)
 *   maxLinesPerFileWarning:  per-file warning threshold (default 300)
 *   maxLinesPerFileError:    per-file error threshold (default 500)
 *   maxTopLevelDirs:         mixed-concerns threshold (default 3)
 *   excludePatterns:         extra regex strings merged with defaults
 *
 * TODO(gluecron): host-neutral — git diff works against any git host.
 *   The `against` ref is resolved locally, so Gluecron will need no
 *   bridge changes. PR metadata (title, body) could later be pulled
 *   via HostBridge if we want to auto-suggest split points.
 */

const BaseModule = require('./base-module');
const fs = require('fs');
const path = require('path');

// Default excludes: auto-generated / locked / vendored content that
// inflates diffs without reflecting human-review effort.
const DEFAULT_EXCLUDE_PATTERNS = [
  // Lockfiles
  /(?:^|\/)package-lock\.json$/,
  /(?:^|\/)yarn\.lock$/,
  /(?:^|\/)pnpm-lock\.yaml$/,
  /(?:^|\/)npm-shrinkwrap\.json$/,
  /(?:^|\/)Gemfile\.lock$/,
  /(?:^|\/)Cargo\.lock$/,
  /(?:^|\/)poetry\.lock$/,
  /(?:^|\/)Pipfile\.lock$/,
  /(?:^|\/)composer\.lock$/,
  /(?:^|\/)go\.sum$/,
  /(?:^|\/)mix\.lock$/,
  /(?:^|\/)flake\.lock$/,
  // Generated / build output
  /(?:^|\/)dist\//,
  /(?:^|\/)build\//,
  /(?:^|\/)out\//,
  /(?:^|\/)\.next\//,
  /(?:^|\/)coverage\//,
  /(?:^|\/)node_modules\//,
  /(?:^|\/)vendor\//,
  /(?:^|\/)target\//,
  /(?:^|\/)bin\//,
  // Minified / bundled
  /\.min\.(?:js|css|mjs)$/,
  /\.bundle\.(?:js|css|mjs)$/,
  // Snapshot tests
  /\.snap$/,
  // Binary-ish formats that git sometimes treats as text
  /\.(?:map|sourcemap)$/,
];

const DEFAULTS = {
  maxFilesChangedWarning: 50,
  maxFilesChangedError: 100,
  maxLinesChangedWarning: 500,
  maxLinesChangedError: 1000,
  maxLinesPerFileWarning: 300,
  maxLinesPerFileError: 500,
  maxTopLevelDirs: 3,
};

class PrSizeModule extends BaseModule {
  constructor() {
    super('prSize', 'PR-size enforcer — blocks unreviewably-large pull requests');
  }

  async run(result, config) {
    const projectRoot = (config && config.projectRoot) || process.cwd();
    const moduleConfig = (config && config.prSize) || {};
    const runnerOptions = (config && config.runnerOptions) || {};
    const thresholds = { ...DEFAULTS, ...moduleConfig };

    // Not in a git repo → no-op.
    if (!this._isGitRepo(projectRoot)) {
      result.addCheck('pr-size:not-a-git-repo', true, {
        severity: 'info',
        message: 'Not a git repository — PR-size check skipped',
      });
      return;
    }

    const diff = this._getDiff(projectRoot, runnerOptions, moduleConfig);
    if (!diff || !diff.trim()) {
      result.addCheck('pr-size:no-diff', true, {
        severity: 'info',
        message: 'No diff available — PR-size check skipped',
      });
      return;
    }

    const files = this._parseDiff(diff);
    const extraExcludes = Array.isArray(moduleConfig.excludePatterns)
      ? moduleConfig.excludePatterns.map((p) => (p instanceof RegExp ? p : new RegExp(p)))
      : [];
    const allExcludes = [...DEFAULT_EXCLUDE_PATTERNS, ...extraExcludes];

    // Partition: counted vs excluded. Excluded files still surface in
    // summary so the developer knows why the gate treated a big diff
    // as small, but they don't contribute to gate enforcement.
    const counted = files.filter((f) => !this._isExcluded(f.path, allExcludes));
    const excluded = files.filter((f) => this._isExcluded(f.path, allExcludes));

    const totalFiles = counted.length;
    const totalAdded = counted.reduce((s, f) => s + f.added, 0);
    const totalRemoved = counted.reduce((s, f) => s + f.removed, 0);
    const totalLines = totalAdded + totalRemoved;

    // --- files-changed ceiling ---
    if (totalFiles > thresholds.maxFilesChangedError) {
      result.addCheck('pr-size:too-many-files', false, {
        severity: 'error',
        message: `${totalFiles} files changed — exceeds hard ceiling of ${thresholds.maxFilesChangedError}. Split the PR.`,
        files: totalFiles,
        threshold: thresholds.maxFilesChangedError,
      });
    } else if (totalFiles > thresholds.maxFilesChangedWarning) {
      result.addCheck('pr-size:many-files', false, {
        severity: 'warning',
        message: `${totalFiles} files changed — exceeds soft threshold of ${thresholds.maxFilesChangedWarning}. Consider splitting.`,
        files: totalFiles,
        threshold: thresholds.maxFilesChangedWarning,
      });
    }

    // --- lines-changed ceiling ---
    if (totalLines > thresholds.maxLinesChangedError) {
      result.addCheck('pr-size:too-many-lines', false, {
        severity: 'error',
        message: `${totalLines} lines changed (+${totalAdded} / -${totalRemoved}) — exceeds hard ceiling of ${thresholds.maxLinesChangedError}.`,
        lines: totalLines,
        added: totalAdded,
        removed: totalRemoved,
        threshold: thresholds.maxLinesChangedError,
      });
    } else if (totalLines > thresholds.maxLinesChangedWarning) {
      result.addCheck('pr-size:many-lines', false, {
        severity: 'warning',
        message: `${totalLines} lines changed (+${totalAdded} / -${totalRemoved}) — review quality collapses above ${thresholds.maxLinesChangedWarning}.`,
        lines: totalLines,
        added: totalAdded,
        removed: totalRemoved,
        threshold: thresholds.maxLinesChangedWarning,
      });
    }

    // --- per-file size ---
    for (const f of counted) {
      const fileLines = f.added + f.removed;
      if (fileLines > thresholds.maxLinesPerFileError) {
        result.addCheck(`pr-size:file-too-large:${f.path}`, false, {
          severity: 'error',
          message: `${f.path} changed ${fileLines} lines (+${f.added} / -${f.removed}) — exceeds per-file ceiling of ${thresholds.maxLinesPerFileError}.`,
          file: f.path,
          lines: fileLines,
          threshold: thresholds.maxLinesPerFileError,
        });
      } else if (fileLines > thresholds.maxLinesPerFileWarning) {
        result.addCheck(`pr-size:large-file:${f.path}`, false, {
          severity: 'warning',
          message: `${f.path} changed ${fileLines} lines (+${f.added} / -${f.removed}).`,
          file: f.path,
          lines: fileLines,
          threshold: thresholds.maxLinesPerFileWarning,
        });
      }
    }

    // --- mixed concerns (top-level directory sprawl) ---
    const topDirs = new Set(counted.map((f) => this._topLevel(f.path)).filter(Boolean));
    if (topDirs.size > thresholds.maxTopLevelDirs) {
      result.addCheck('pr-size:mixed-concerns', false, {
        severity: 'warning',
        message: `PR touches ${topDirs.size} top-level directories (${[...topDirs].sort().join(', ')}) — likely mixing concerns.`,
        topLevelDirs: [...topDirs].sort(),
        threshold: thresholds.maxTopLevelDirs,
      });
    }

    // --- summary ---
    result.addCheck('pr-size:summary', true, {
      severity: 'info',
      message: `${totalFiles} file(s), +${totalAdded}/-${totalRemoved} line(s) counted; ${excluded.length} excluded file(s) (lockfiles/build/snap)`,
      files: totalFiles,
      added: totalAdded,
      removed: totalRemoved,
      excluded: excluded.length,
      topLevelDirs: [...topDirs].sort(),
    });
  }

  // ------------------------------------------------------------------
  // Diff acquisition
  // ------------------------------------------------------------------

  _isGitRepo(projectRoot) {
    try {
      return fs.existsSync(path.join(projectRoot, '.git'));
    } catch {
      return false;
    }
  }

  _getDiff(projectRoot, runnerOptions, moduleConfig) {
    // 1. Explicit diff provided (tests / CI).
    if (moduleConfig.diff != null) return moduleConfig.diff;
    if (runnerOptions.diff != null) return runnerOptions.diff;

    // 2. baseBranch configured → resolve merge-base, diff
    //    `<merge-base>..HEAD`. This is the bulletproof path for
    //    long-running feature branches: it counts ONLY the changes
    //    introduced on this branch, not changes merged into main
    //    since the branch was created.
    const explicitBase =
      moduleConfig.baseBranch || runnerOptions.baseBranch || null;
    if (explicitBase) {
      const diff = this._diffSinceMergeBase(projectRoot, explicitBase);
      if (diff !== null) return diff;
      // explicitly configured base failed to resolve — fall through
      // to other strategies rather than silently producing no output.
    }

    // 3. Legacy `against` ref (three-dot range, equivalent to
    //    merge-base..HEAD).
    const against = moduleConfig.against || runnerOptions.against;
    if (against) {
      const { stdout, exitCode } = this._exec(
        `git diff --numstat ${against}...HEAD`,
        { cwd: projectRoot },
      );
      if (exitCode === 0 && stdout && stdout.trim()) return stdout;
      // fall through to auto-detect on failure
    }

    // 4. Auto-detect: try origin/main → main merge-base first (the
    //    "long-running feature branch" case), then fall back to
    //    staged / working-tree / HEAD~1..HEAD (the "local pre-push"
    //    case).
    if (!explicitBase && !against) {
      for (const candidate of ['origin/main', 'main']) {
        const diff = this._diffSinceMergeBase(projectRoot, candidate);
        if (diff) return diff;
      }
    }

    const fallbackCommands = [
      'git diff --numstat --cached',
      'git diff --numstat',
      'git diff --numstat HEAD~1 HEAD',
    ];
    for (const cmd of fallbackCommands) {
      const { stdout, exitCode } = this._exec(cmd, { cwd: projectRoot });
      if (exitCode === 0 && stdout && stdout.trim()) {
        return stdout;
      }
    }
    return '';
  }

  /**
   * Resolve `git merge-base HEAD <base>` and return the numstat diff
   * for `<merge-base>..HEAD`. Returns:
   *   - non-empty string: the diff (success)
   *   - empty string:     merge-base found but no changes on the
   *                       branch (success — caller can use as-is)
   *   - null:             merge-base could not be resolved (shallow
   *                       clone, unknown ref, unrelated branch).
   *                       Caller should fall through to next strategy.
   */
  _diffSinceMergeBase(projectRoot, base) {
    const mergeBaseRes = this._exec(`git merge-base HEAD ${base}`, {
      cwd: projectRoot,
    });
    if (mergeBaseRes.exitCode !== 0) return null;
    const mergeBase = (mergeBaseRes.stdout || '').trim();
    if (!mergeBase) return null;

    const diffRes = this._exec(
      `git diff --numstat ${mergeBase}..HEAD`,
      { cwd: projectRoot },
    );
    if (diffRes.exitCode !== 0) return null;
    return diffRes.stdout || '';
  }

  // ------------------------------------------------------------------
  // Parsers
  // ------------------------------------------------------------------

  /**
   * Parses either `git diff --numstat` output (preferred) or a unified
   * diff body (for test convenience). Returns
   *   [{ path, added, removed }, ...]
   */
  _parseDiff(diff) {
    // numstat format: "<added>\t<removed>\t<path>"
    const numstatLine = /^(\d+|-)\t(\d+|-)\t(.+)$/;
    const lines = diff.split('\n');
    const looksLikeNumstat = lines.some((l) => numstatLine.test(l));

    if (looksLikeNumstat) {
      const files = [];
      for (const line of lines) {
        const m = line.match(numstatLine);
        if (!m) continue;
        const added = m[1] === '-' ? 0 : parseInt(m[1], 10);
        const removed = m[2] === '-' ? 0 : parseInt(m[2], 10);
        let filePath = m[3];
        // numstat rename form: "old => new" or "src/{a => b}/file"
        if (filePath.includes(' => ')) {
          const braceMatch = filePath.match(/^(.*)\{(.+?) => (.+?)\}(.*)$/);
          if (braceMatch) {
            filePath = `${braceMatch[1]}${braceMatch[3]}${braceMatch[4]}`;
          } else {
            const arrow = filePath.split(' => ');
            filePath = arrow[arrow.length - 1].trim();
          }
        }
        files.push({ path: filePath, added, removed });
      }
      return files;
    }

    return this._parseUnifiedDiff(diff);
  }

  _parseUnifiedDiff(diff) {
    const files = [];
    let current = null;
    for (const line of diff.split('\n')) {
      if (line.startsWith('diff --git ')) {
        if (current) files.push(current);
        const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
        current = {
          path: m ? m[2] : 'unknown',
          added: 0,
          removed: 0,
        };
        continue;
      }
      if (!current) continue;
      // Skip diff headers
      if (line.startsWith('+++') || line.startsWith('---')) continue;
      if (line.startsWith('@@')) continue;
      if (line.startsWith('+')) current.added += 1;
      else if (line.startsWith('-')) current.removed += 1;
    }
    if (current) files.push(current);
    return files;
  }

  _isExcluded(relPath, patterns) {
    const norm = relPath.replace(/\\/g, '/');
    return patterns.some((rx) => rx.test(norm));
  }

  _topLevel(relPath) {
    const norm = relPath.replace(/\\/g, '/');
    const idx = norm.indexOf('/');
    if (idx === -1) return '(root)';
    return norm.slice(0, idx);
  }
}

module.exports = PrSizeModule;
