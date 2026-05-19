/**
 * Base Module - Abstract base class for all GateTest test modules.
 */

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
   * Collect files matching patterns from project root.
   *
   * Incremental-scan mode: when the runner sets
   * `this._incrementalContext = { changedFilesAbs: Set<string> }` on
   * the module instance (only on PRs / `--diff`), the returned file list
   * is intersected with that set. Modules don't need to know — they get
   * a shorter list and run proportionally faster. Per-PR scans drop from
   * ~30s (full sweep, parallel) to ~3-10s (touched files only).
   *
   * Modules that need to run on EVERY scan regardless of diff (e.g. a
   * config-level checker that reads `package.json`) can opt out by
   * setting `this._respectsIncremental = false` in their constructor.
   */
  _collectFiles(projectRoot, patterns, excludes = []) {
    const fs = require('fs');
    const path = require('path');
    const files = [];

    const defaultExcludes = [
      'node_modules', '.git', 'dist', 'build', '.gatetest', 'coverage',
      '.next', '.nuxt', '.svelte-kit', '.output', '.vercel', '.turbo',
      '__pycache__', '.pytest_cache', 'target', 'vendor', '.cargo',
      'out', 'public/build', '.cache', '.parcel-cache',
      // .claude is the agent-coordination dir (worktrees, scratch state).
      // Scanning .claude/worktrees/agent-* inflates findings with
      // duplicate scans of the same code — every gatetest run on a
      // repo with active agent worktrees would produce N× the noise.
      '.claude',
    ];
    const allExcludes = [...defaultExcludes, ...excludes];

    const walk = (dir) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (allExcludes.includes(entry.name)) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (patterns.includes(ext) || patterns.includes('*')) {
            files.push(fullPath);
          }
        }
      }
    };

    walk(projectRoot);

    // Incremental filter — applied AFTER the walk so the exclude rules
    // and extension matching still hold. Cheap set intersection.
    if (
      this._respectsIncremental !== false &&
      this._incrementalContext &&
      this._incrementalContext.changedFilesAbs instanceof Set
    ) {
      const changed = this._incrementalContext.changedFilesAbs;
      return files.filter((f) => changed.has(f));
    }

    return files;
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
