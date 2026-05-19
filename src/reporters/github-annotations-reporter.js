/**
 * GitHub Annotations Reporter — emits GitHub Actions workflow commands
 * so findings appear as inline annotations on the PR diff (red squiggles
 * on the actual line, not buried in a log).
 *
 * Format: ::error file={path},line={line},col={col},title={title}::{message}
 * Spec: https://docs.github.com/en/actions/learn-github-actions/workflow-commands-for-github-actions
 *
 * GitHub's per-step annotation budget is 10 errors / 10 warnings / 10 notices
 * that render inline on the PR — extras still show in the run log but are
 * collapsed. We sort by severity then by confidence so the most actionable
 * findings always land within budget.
 */

const ANNOTATION_BUDGET_PER_LEVEL = 10;

class GithubAnnotationsReporter {
  constructor(runner) {
    this.runner = runner;
    this._attach();
  }

  _attach() {
    this.runner.on('suite:end', (summary) => this._onSuiteEnd(summary));
  }

  _onSuiteEnd(summary) {
    const annotations = this._collectAnnotations(summary);
    const byLevel = { error: [], warning: [], notice: [] };
    for (const a of annotations) byLevel[a.level].push(a);

    // Sort each bucket by confidence descending so the most actionable
    // findings get the inline-on-PR slot.
    for (const level of Object.keys(byLevel)) {
      byLevel[level].sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
    }

    for (const level of ['error', 'warning', 'notice']) {
      const bucket = byLevel[level];
      const cap = Math.min(bucket.length, ANNOTATION_BUDGET_PER_LEVEL);
      for (let i = 0; i < cap; i++) {
        this._emit(bucket[i]);
      }
      if (bucket.length > cap) {
        // Surface the overflow count as a single notice so reviewers know
        // there's more in the full report.
        process.stdout.write(
          `::notice::${bucket.length - cap} additional ${level} finding(s) ` +
          `omitted from PR annotations (GitHub limits 10 per step). ` +
          `See the full GateTest report artifact.\n`
        );
      }
    }
  }

  _collectAnnotations(summary) {
    const out = [];
    for (const moduleResult of summary.results) {
      for (const check of moduleResult.checks) {
        if (check.passed) continue;
        out.push({
          level: this._severityToLevel(check.severity),
          file: check.file || null,
          line: parseInt(check.line, 10) || 1,
          col: parseInt(check.column, 10) || 1,
          title: `GateTest / ${moduleResult.module} / ${check.name}`,
          message: check.message || check.suggestion || check.name,
          confidence: typeof check.confidence === 'number' ? check.confidence : 1,
        });
      }
    }
    return out;
  }

  _emit(a) {
    const parts = [];
    if (a.file) parts.push(`file=${this._escapeProp(a.file)}`);
    parts.push(`line=${a.line}`);
    parts.push(`col=${a.col}`);
    parts.push(`title=${this._escapeProp(a.title)}`);
    const props = parts.join(',');
    process.stdout.write(`::${a.level} ${props}::${this._escapeData(a.message)}\n`);
  }

  // GitHub workflow command escaping. Values in the "data" position (after
  // the `::`) escape % \r \n. Values in property position additionally
  // escape : and , because those are the property delimiters.
  _escapeData(s) {
    return String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  }

  _escapeProp(s) {
    return this._escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
  }

  _severityToLevel(severity) {
    switch (severity) {
      case 'error': return 'error';
      case 'warning': return 'warning';
      case 'info': return 'notice';
      default: return 'warning';
    }
  }
}

module.exports = { GithubAnnotationsReporter };
