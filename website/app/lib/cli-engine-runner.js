'use strict';

/**
 * CLI engine runner for the serverless website.
 *
 * Bridges the gap between the website (which has files in memory) and the
 * full CLI engine in `src/index.js` (which expects a real filesystem with
 * a git repo). Closes the "91 vs 22 modules" honesty gap — the website now
 * runs the SAME engine the CLI runs.
 *
 * Flow:
 *   1. mkdtemp() a workspace under /tmp
 *   2. Write every fileContents[i] entry to disk under that workspace
 *   3. `git init` + a single seed commit so modules that need git history
 *      (prSize, prQuality, secretRotation, importCycle) have HEAD~1 to diff
 *   4. require('../../../src/index.js') and run the suite
 *   5. Translate the CLI summary into the website's ModuleResultEnvelope shape
 *   6. rm -rf the workspace
 *
 * Time budget: caller passes `deadlineMs`. We pass it through to the runner
 * which checks it between modules. If hit, partial results are returned.
 *
 * Path safety: only writes paths that, after path.resolve(), stay under the
 * workspace root. Anything that tries to escape (`../../etc/passwd`) is
 * dropped silently with a console.warn.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

/**
 * @typedef {{ path: string; content: string }} RepoFile
 * @typedef {{ name: string; status: string; checks: number; issues: number; duration: number; details?: string[]; skipped?: string }} ModuleResultEnvelope
 */

const DEFAULT_SUITE = 'full';
const DEFAULT_TIME_BUDGET_MS = 240_000;
const DETAIL_CAP_PER_MODULE = 200;

// Per-scan workspace size cap. Most repos fit comfortably; massive monorepos
// fall back to the in-memory subset runner.
const MAX_WORKSPACE_BYTES = 80 * 1024 * 1024; // 80 MB

function isPathSafe(workspaceRoot, candidatePath) {
  const resolved = path.resolve(workspaceRoot, candidatePath);
  const root = path.resolve(workspaceRoot);
  return resolved === root || resolved.startsWith(root + path.sep);
}

function writeFilesToWorkspace(workspaceRoot, fileContents) {
  let bytesWritten = 0;
  let filesWritten = 0;
  let filesSkipped = 0;
  for (const { path: relPath, content } of fileContents) {
    if (typeof relPath !== 'string' || typeof content !== 'string') {
      filesSkipped += 1;
      continue;
    }
    if (!isPathSafe(workspaceRoot, relPath)) {
      console.warn(`[cli-engine-runner] dropped unsafe path: ${relPath}`);
      filesSkipped += 1;
      continue;
    }
    const fullPath = path.resolve(workspaceRoot, relPath);
    const bytes = Buffer.byteLength(content);
    if (bytesWritten + bytes > MAX_WORKSPACE_BYTES) {
      console.warn(`[cli-engine-runner] hit workspace size cap at ${filesWritten} files / ${bytesWritten} bytes`);
      break;
    }
    try {
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content);
      bytesWritten += bytes;
      filesWritten += 1;
    } catch (err) {
      console.warn(`[cli-engine-runner] write failed for ${relPath}: ${err.message || err}`);
      filesSkipped += 1;
    }
  }
  return { filesWritten, filesSkipped, bytesWritten };
}

function seedGitRepo(workspaceRoot) {
  // Lightweight git seed so modules that need `HEAD~1` or `origin/main` have
  // something to diff against. Failure is non-fatal — git-dependent modules
  // will just return their "no git" info-level fallback.
  try {
    execSync('git init -q -b main', { cwd: workspaceRoot, stdio: 'pipe' });
    execSync('git config user.email "scan@gatetest.ai"', { cwd: workspaceRoot, stdio: 'pipe' });
    execSync('git config user.name "GateTest Scanner"', { cwd: workspaceRoot, stdio: 'pipe' });
    execSync('git config commit.gpgsign false', { cwd: workspaceRoot, stdio: 'pipe' });
    // Initial seed commit so HEAD~1 exists. Empty allowed.
    execSync('git add -A', { cwd: workspaceRoot, stdio: 'pipe' });
    execSync('git commit -q --allow-empty -m "scan seed"', { cwd: workspaceRoot, stdio: 'pipe' });
    return true;
  } catch (err) {
    console.warn(`[cli-engine-runner] git seed failed (non-fatal): ${err.message || err}`);
    return false;
  }
}

/**
 * Translate the CLI engine's summary into the website's ModuleResultEnvelope
 * shape so `scan/run/route.ts` consumers don't need to know which runner
 * produced the data.
 *
 * CLI summary shape (from GateTestRunner):
 *   {
 *     gateStatus: 'PASSED' | 'BLOCKED',
 *     results: [{
 *       module: 'modName',
 *       checks: [{ name, severity, passed, details: { message, file, line }}],
 *       errors: N, warnings: N, info: N, passed: N,
 *       duration: ms,
 *       skipped?: string,
 *     }],
 *     totalErrors, totalWarnings, totalChecks, duration
 *   }
 */
function translateSummary(summary) {
  const modules = [];
  let totalIssues = 0;
  for (const r of summary.results || []) {
    const errors = r.errors || 0;
    const warnings = r.warnings || 0;
    const info = r.info || 0;
    const passedChecks = r.passed || 0;
    const totalChecksForModule = errors + warnings + info + passedChecks;
    const issues = errors + warnings;
    totalIssues += issues;

    let status;
    if (r.skipped) status = 'skipped';
    else if (errors > 0) status = 'failed';
    else if (totalChecksForModule === 0) status = 'skipped';
    else if (warnings > 0) status = 'passed'; // warnings don't block
    else status = 'passed';

    // Convert failed checks → human-readable details for the website UI
    const failedChecks = Array.isArray(r.checks)
      ? r.checks.filter((c) => c && c.passed === false)
      : [];
    let details;
    if (failedChecks.length > 0) {
      const lines = failedChecks.slice(0, DETAIL_CAP_PER_MODULE).map((c) => {
        const sev = (c.severity || 'info').toLowerCase();
        const where = c.details && c.details.file
          ? ` (${c.details.file}${c.details.line ? `:${c.details.line}` : ''})`
          : '';
        const msg = (c.details && c.details.message) || c.name || '(no message)';
        return `[${sev}] ${msg}${where}`;
      });
      if (failedChecks.length > DETAIL_CAP_PER_MODULE) {
        lines.push(
          `info: ${failedChecks.length - DETAIL_CAP_PER_MODULE} more finding(s) not shown — re-scan with the CLI for the full list (gatetest --module ${r.module} --reporter json)`
        );
      }
      details = lines;
    }

    modules.push({
      name: r.module || r.name || 'unknown',
      status,
      checks: totalChecksForModule,
      issues,
      duration: r.duration || 0,
      details,
      ...(r.skipped ? { skipped: r.skipped } : {}),
    });
  }
  return { modules, totalIssues };
}

/**
 * Run the full CLI engine against an in-memory file map. Returns the
 * website-shaped result envelope.
 *
 * @param {Object} opts
 * @param {RepoFile[]} opts.fileContents
 * @param {string} [opts.suite='full']             quick | full | nuclear etc.
 * @param {number} [opts.deadlineMs]               wall-clock deadline (Date.now()-relative)
 * @param {string} [opts.workspaceParent]          override for /tmp (tests)
 * @returns {Promise<{ modules: ModuleResultEnvelope[], totalIssues: number, duration: number, engine: 'cli' }>}
 */
async function runFullEngine({ fileContents, suite = DEFAULT_SUITE, deadlineMs, workspaceParent }) {
  if (!Array.isArray(fileContents)) {
    throw new TypeError('fileContents must be an array of { path, content }');
  }
  const started = Date.now();
  const parent = workspaceParent || os.tmpdir();
  const workspaceRoot = fs.mkdtempSync(path.join(parent, 'gatetest-scan-'));

  try {
    // Materialise files.
    const writeStats = writeFilesToWorkspace(workspaceRoot, fileContents);
    if (writeStats.filesWritten === 0) {
      return {
        modules: [],
        totalIssues: 0,
        duration: Date.now() - started,
        engine: 'cli',
        engineMeta: {
          ...writeStats,
          workspaceRoot: '(empty)',
          error: 'no writable files in fileContents',
        },
      };
    }

    seedGitRepo(workspaceRoot);

    // Require the CLI engine. Pure CJS — works under Next.js server bundling
    // as long as the path resolves relative to this file.
    //
    // turbopackIgnore: the CLI engine eventually loads src/core/registry.js
    // which does dynamic require()s of every module file. Turbopack tries
    // to enumerate all possible targets at build time and crashes. The
    // comment tells Turbopack to skip tracing through this boundary;
    // Node-at-runtime resolves normally.
    // eslint-disable-next-line global-require
    const { GateTest } = require(/* turbopackIgnore: true */ '../../../src/index.js');

    const opts = {
      silent: true,
      // Pass-through hooks for budgets when the runner supports them.
      ...(deadlineMs ? { deadlineMs, timeBudgetMs: Math.max(0, deadlineMs - Date.now()) } : {}),
    };

    // Save process.exitCode around the run — the CLI engine sets exitCode=1
    // when the gate is BLOCKED (designed for terminal usage). On serverless
    // and inside Node's test runner that leaks into the process and fails
    // the parent. We don't care about exitCode here; the summary already
    // carries gateStatus.
    const previousExitCode = process.exitCode;

    let summary;
    try {
      summary = await new GateTest(workspaceRoot, opts).init().runSuite(suite);
    } catch (err) {
      process.exitCode = previousExitCode;
      return {
        modules: [],
        totalIssues: 0,
        duration: Date.now() - started,
        engine: 'cli',
        engineMeta: { error: err.message || String(err), filesWritten: writeStats.filesWritten },
      };
    } finally {
      process.exitCode = previousExitCode;
    }

    const translated = translateSummary(summary);
    return {
      modules: translated.modules,
      totalIssues: translated.totalIssues,
      duration: Date.now() - started,
      engine: 'cli',
      engineMeta: {
        filesWritten: writeStats.filesWritten,
        filesSkipped: writeStats.filesSkipped,
        workspaceBytes: writeStats.bytesWritten,
        gateStatus: summary.gateStatus,
      },
    };
  } finally {
    // Best-effort cleanup. Vercel /tmp is per-invocation anyway so this is
    // belt-and-braces — leftover files don't survive the function instance.
    try { fs.rmSync(workspaceRoot, { recursive: true, force: true }); }
    catch (err) { // error-ok — Vercel /tmp is per-invocation; leftover files don't survive instance teardown
      console.warn(`[cli-engine-runner] cleanup failed: ${err.message || err}`);
    }
  }
}

module.exports = {
  runFullEngine,
  // Exposed for tests
  translateSummary,
  writeFilesToWorkspace,
  isPathSafe,
  DEFAULT_SUITE,
  MAX_WORKSPACE_BYTES,
  DETAIL_CAP_PER_MODULE,
};
