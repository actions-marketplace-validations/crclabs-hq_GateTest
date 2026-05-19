/**
 * CI Summary Reporter — emits a per-module timing table and a top-line
 * summary notice so reviewers can see at a glance which modules were
 * slow and what the gate verdict was, without expanding the run log.
 *
 * Output (inside a collapsible GitHub Actions group):
 *
 *   ::group::GateTest Module Timing
 *   Module                         Time   Status   Errors  Warnings
 *   security                     3450ms   failed        3        12
 *   accessibility                1200ms   passed        0         5
 *   ...
 *   Total                        9876ms              ...
 *   ::endgroup::
 *
 *   ::notice title=GateTest::Suite: 92 modules in 9.9s — 47 findings (12 errors, 35 warnings). Slowest: security (3.5s).
 *
 * Auto-attaches under GitHub Actions; honours the same `githubAnnotations`
 * opt-in flag as GithubAnnotationsReporter so they enable together.
 */

const SLOW_MODULE_MS = 2000;

class CiSummaryReporter {
  constructor(runner) {
    this.runner = runner;
    this._timings = [];
    this._attach();
  }

  _attach() {
    this.runner.on('module:end', (r) => this._record(r));
    this.runner.on('module:skip', (r) => this._record(r));
    this.runner.on('suite:end', (s) => this._onSuiteEnd(s));
  }

  _record(result) {
    this._timings.push({
      module: result.module,
      ms: result.duration || 0,
      status: result.status || 'unknown',
      errors: (result.errorChecks || []).length,
      warnings: (result.warningChecks || []).length,
    });
  }

  _onSuiteEnd(summary) {
    const sorted = [...this._timings].sort((a, b) => b.ms - a.ms);
    const totalMs = this._timings.reduce((s, t) => s + t.ms, 0);

    // Collapsible per-module breakdown.
    process.stdout.write('::group::GateTest Module Timing\n');
    const cols = ['Module', 'Time', 'Status', 'Errors', 'Warnings'];
    const widths = [30, 10, 8, 7, 9];
    process.stdout.write(this._row(cols, widths) + '\n');
    process.stdout.write('-'.repeat(widths.reduce((a, b) => a + b + 1, -1)) + '\n');
    for (const t of sorted) {
      process.stdout.write(this._row([
        t.module,
        `${t.ms}ms`,
        t.status,
        String(t.errors),
        String(t.warnings),
      ], widths) + '\n');
    }
    process.stdout.write('-'.repeat(widths.reduce((a, b) => a + b + 1, -1)) + '\n');
    process.stdout.write(this._row(['Total', `${totalMs}ms`, '', '', ''], widths) + '\n');
    process.stdout.write('::endgroup::\n');

    // Top-line summary notice — visible in PR summary without expanding.
    const slowest = sorted[0];
    const errCount = (summary && summary.checks && summary.checks.errors) || 0;
    const warnCount = (summary && summary.checks && summary.checks.warnings) || 0;
    const moduleCount = this._timings.length;
    const totalSec = (totalMs / 1000).toFixed(1);

    let line = `Suite: ${moduleCount} modules in ${totalSec}s — ${errCount + warnCount} findings (${errCount} errors, ${warnCount} warnings).`;
    if (slowest && slowest.ms >= SLOW_MODULE_MS) {
      line += ` Slowest: ${slowest.module} (${(slowest.ms / 1000).toFixed(1)}s).`;
    }
    process.stdout.write(`::notice title=GateTest::${this._escapeData(line)}\n`);
  }

  _row(values, widths) {
    return values
      .map((v, i) => {
        const w = widths[i];
        // First column left-aligned, rest right-aligned.
        return i === 0 ? String(v).padEnd(w) : String(v).padStart(w);
      })
      .join(' ');
  }

  _escapeData(s) {
    return String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  }
}

module.exports = { CiSummaryReporter };
