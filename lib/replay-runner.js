/**
 * Replay-runner helpers — the parts of `bin/gatetest-replay.js` that are
 * worth their own unit-tested file. Keeps the CLI script under the 300-line
 * cap and makes local-command execution + console rendering testable in
 * isolation.
 */

'use strict';

const { spawnSync } = require('node:child_process');

const { compareResults } = require('./replay-plan');

/**
 * Run one command in a working dir via `bash -lc`. Returns
 *   { passed, exitCode, signature, output, elapsedMs }.
 *
 * `verbose` streams subprocess output to inherit; otherwise we capture it.
 * 10-minute timeout — CI steps that exceed this need a different tool.
 *
 * Commands starting with `#` are advisory (no auto-map) — short-circuit
 * with a no-op signature instead of spawning bash.
 */
function runLocalCommand(command, workingDir, verbose, runner) {
  const r = runner || spawnSync;
  const safeCmd = String(command || '').trim();
  if (!safeCmd || safeCmd.startsWith('#')) {
    return { passed: false, signature: 'no-op (no command resolved)', exitCode: -1, output: '', elapsedMs: 0 };
  }
  const stdio = verbose ? 'inherit' : 'pipe';
  const t0 = Date.now();
  const res = r('bash', ['-lc', safeCmd], {
    cwd: workingDir, encoding: 'utf-8', stdio, timeout: 10 * 60 * 1000,
  });
  const elapsedMs = Date.now() - t0;
  const out = (res.stdout || '') + (res.stderr || '');
  const signature = extractSignature(out, res.status);
  return { passed: res.status === 0, exitCode: res.status, signature, output: out, elapsedMs };
}

/**
 * Pull the first failure-looking line out of subprocess output.
 * Used as the human-readable "signature" for compareResults().
 *
 * Recognised shapes (priority order):
 *   - `FAIL …` / `error: …` / `Error: …` lines
 *   - node:test `# fail 1` style
 *   - `error TS2304:` style (tsc)
 *
 * Returns "exit <n>" when nothing matches and exitCode != 0.
 * Returns "" on a clean exit.
 */
function extractSignature(output, exitCode) {
  if (!output) return exitCode === 0 ? '' : `exit ${exitCode}`;
  const lines = String(output).split(/\r?\n/);
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (/^(?:FAIL|error[: ]|Error:)/i.test(t)) return t.slice(0, 120);
    if (/^# fail \d+/.test(t)) return t.slice(0, 120);
    if (/error TS\d+/.test(t)) return t.slice(0, 120);
  }
  return exitCode === 0 ? '' : `exit ${exitCode}`;
}

/**
 * Roll up per-step comparisons into a single verdict for the run.
 */
function deriveVerdict(results) {
  if (!results || results.length === 0) return 'no-failed-jobs';
  const allSame = results.every((r) => r.comparison.verdict === 'same');
  if (allSame) return 'reproduces-locally';
  const allFlaky = results.every(
    (r) => r.comparison.verdict === 'flaky' || r.comparison.verdict === 'passes-here'
  );
  if (allFlaky) return 'flaky-or-already-fixed';
  return 'mixed';
}

/**
 * Pick a small projection of the run-metadata object — keeps the JSON
 * report bounded and avoids leaking GitHub's full response shape.
 */
function pickRunMeta(r) {
  if (!r) return null;
  return {
    id: r.id,
    name: r.name || (r.workflow && r.workflow.name) || null,
    path: r.path || null,
    head_sha: r.head_sha || null,
    head_branch: r.head_branch || null,
    conclusion: r.conclusion || null,
    status: r.status || null,
    html_url: r.html_url || null,
  };
}

function pickJob(j) {
  return {
    id: j.id,
    name: j.name || null,
    conclusion: j.conclusion || null,
    failedSteps: Array.isArray(j.steps)
      ? j.steps.filter((s) => s && s.conclusion === 'failure').map((s) => s.name)
      : [],
  };
}

function stripOutputForReport(local) {
  if (!local || typeof local.output !== 'string') return local;
  const tail = local.output.split(/\r?\n/).slice(-80).join('\n');
  return { ...local, output: tail };
}

/**
 * Console renderer — human-readable summary of a replay report.
 * No emojis (Bible rule). One block per failed step.
 */
function renderConsole(report) {
  const lines = [];
  if (!report.ok) {
    lines.push('');
    lines.push(`  gatetest replay — ERROR (${report.stage || 'unknown'})`);
    lines.push('');
    lines.push(`  ${report.error || 'unknown error'}`);
    lines.push('');
    return lines.join('\n');
  }
  const meta = report.runMeta || {};
  lines.push('');
  lines.push(`  gatetest replay — run #${meta.id || '?'} (${meta.name || 'workflow'}) sha ${meta.head_sha ? String(meta.head_sha).slice(0, 8) : '?'}`);
  if (meta.html_url) lines.push(`  ${meta.html_url}`);
  lines.push('');
  if (!report.failingJobs || report.failingJobs.length === 0) {
    lines.push('  No failed jobs in this run — nothing to replay.');
    lines.push('');
    return lines.join('\n');
  }
  lines.push(`  ${report.failingJobs.length} job(s) failed: ${report.failingJobs.map((j) => j.name).join(', ')}`);
  lines.push('  Reproducing locally against this working tree:');
  lines.push('');
  for (let i = 0; i < report.results.length; i++) {
    const r = report.results[i];
    const mark = r.localResult.passed ? 'PASS' : 'FAIL';
    const idx = `[${i + 1}/${report.results.length}]`;
    lines.push(`  ${idx} ${r.step.jobName} :: ${r.step.stepName}`);
    lines.push(`        command: ${r.step.command}`);
    lines.push(`        local:   ${mark} (${r.localResult.elapsedMs || 0}ms)  ${r.comparison.diff}`);
    lines.push('');
  }
  lines.push(`  Verdict: ${report.verdict}`);
  if (report.verdict === 'reproduces-locally') {
    lines.push('  Same failure as CI. Fix locally, then push.');
  } else if (report.verdict === 'flaky-or-already-fixed') {
    lines.push('  CI failed but everything passes here — may be a flake or your tree already has the fix.');
  } else if (report.verdict === 'mixed') {
    lines.push('  Mixed result — some steps reproduce, some don\'t. See per-step output above.');
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Execute one plan step against the working tree, returning a result
 * row for the report. Pure relative to its `exec` dep.
 */
function executePlanStep(step, exec) {
  // CI's "signature" is unavailable without parsing the logs — we only know
  // the step failed. Pass passed:false and no signature; compareResults
  // then falls back to passed-vs-failed comparison.
  const ciResult = { passed: false };
  const localResult = String(step.command).startsWith('#')
    ? { passed: false, signature: 'no command resolved', exitCode: -1, output: step.command, elapsedMs: 0 }
    : exec(step.command);
  const comparison = compareResults(ciResult, localResult);
  return { step, localResult: stripOutputForReport(localResult), comparison };
}

module.exports = {
  runLocalCommand,
  extractSignature,
  deriveVerdict,
  pickRunMeta,
  pickJob,
  stripOutputForReport,
  renderConsole,
  executePlanStep,
};
