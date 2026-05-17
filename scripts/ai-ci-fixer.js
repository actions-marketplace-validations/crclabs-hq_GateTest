#!/usr/bin/env node
/**
 * AI CI-fixer — watches for failing CI runs, asks Claude what's wrong,
 * opens a PR with the proposed fix, and runs the gate against it.
 *
 * AUTHORIZATION: This script is gated behind the `GATETEST_AI_CI_FIXER=1`
 * repository variable (defaults OFF). The workflow that drives this script
 * (`.github/workflows/ai-ci-fixer.yml`) checks that flag before running so
 * the code lands without any surprise Anthropic API spend.
 *
 * Inputs (env vars):
 *   ANTHROPIC_API_KEY   — required, fail-closed if missing
 *   GITHUB_TOKEN        — required (provided by Actions)
 *   GITHUB_REPOSITORY   — owner/repo (provided by Actions context)
 *   WORKFLOW_RUN_ID     — the failed workflow run id
 *   MAX_FIX_ATTEMPTS    — default 3
 *   CLAUDE_MODEL        — default claude-sonnet-4-5 (cheap + capable enough)
 *
 * Failure-mode philosophy: NEVER block CI. If anything goes wrong (no API
 * key, GitHub rate-limit, Claude returns nonsense), log it and exit 0.
 *
 * Most of the work lives in lib/ai-ci-fixer-core.js so this file stays
 * under the pr-size hard-cap (500 lines / file). This script is the
 * orchestrator + CLI entry only.
 */

'use strict';

const core = require('../lib/ai-ci-fixer-core');

const USAGE = `\
ai-ci-fixer — watches for failing CI runs and proposes a Claude-generated fix.

Usage:
  node scripts/ai-ci-fixer.js

Environment:
  ANTHROPIC_API_KEY   Required. If missing, the fixer exits 0 (disabled).
  GITHUB_TOKEN        Required.
  GITHUB_REPOSITORY   owner/repo
  WORKFLOW_RUN_ID     Numeric id of the failed workflow run.
  MAX_FIX_ATTEMPTS    Default 3.
  CLAUDE_MODEL        Default ${core.DEFAULT_MODEL}.

The fixer NEVER blocks CI. On any error it logs and exits 0.
`;

// ── Helpers exclusive to the orchestrator ───────────────────────────────────

/**
 * Open a PR carrying the patches applied during a successful attempt.
 */
async function openFixPr({ token, repo, branch, runUrl, logExcerpt, attempt, model, baseRef, git: _git, transport }) {
  _git(['config', 'user.name',  'gatetest-ai-fixer[bot]']);
  _git(['config', 'user.email', 'gatetest-ai-fixer@users.noreply.github.com']);

  const checkout = _git(['checkout', '-B', branch]);
  if (!checkout.ok) core.logErr('git checkout failed', new Error(checkout.stderr));

  const add = _git(['add', '-A']);
  if (!add.ok) core.logErr('git add failed', new Error(add.stderr));

  const commit = _git(['commit', '-m', `AI CI-fixer: repair workflow run ${runUrl} (attempt ${attempt})`]);
  if (!commit.ok) {
    core.logErr('git commit failed (maybe no changes?)', new Error(commit.stderr));
    return { status: 'no-changes' };
  }

  const push = _git(['push', '-u', 'origin', branch, '--force-with-lease']);
  if (!push.ok) {
    core.logErr('git push failed', new Error(push.stderr));
    return { status: 'push-failed' };
  }

  return core.createPullRequest({
    token, repo, head: branch, base: baseRef || 'main',
    title: `AI CI-fixer: repair workflow run #${branch.split('/').pop()}`,
    body:  core.buildPrBody({ runUrl, logExcerpt, attempt, model }),
    opts:  { transport },
  });
}

/**
 * Try one fix-attempt: call Claude → parse → apply → run gate.
 * Returns { ok, patches, gate, response, error }.
 */
async function tryAttempt({ cfg, files, logExcerpt, attempt, deps }) {
  const user = core.buildClaudePrompt(logExcerpt, files);
  let responseText;
  try {
    responseText = await deps.callClaude({
      apiKey:    cfg.apiKey,
      model:     cfg.model,
      system:    core.CLAUDE_SYSTEM_PROMPT,
      user,
      timeoutMs: core.CLAUDE_TIMEOUT_MS,
      transport: deps.transport,
    });
  } catch (err) {
    core.logErr(`Claude call attempt ${attempt}`, err);
    return { ok: false, patches: [], error: err };
  }

  const patches = core.parseClaudeResponse(responseText);
  if (patches.length === 0) {
    core.log(`attempt ${attempt}: unparseable / GIVE_UP response`);
    return { ok: false, patches: [] };
  }

  if (attempt > 1) deps.git(['checkout', '--', '.']);

  const written = core.applyPatches(patches, deps.repoRoot);
  core.log(`attempt ${attempt}: applied ${written.length} patch(es)`);

  const gateResult = deps.gate();
  return { ok: gateResult.ok, patches, gate: gateResult };
}

// ── Orchestrator ────────────────────────────────────────────────────────────

/**
 * End-to-end orchestrator. All branches return cleanly — the fixer NEVER
 * blocks CI. Returns {status, reason} for callers/tests.
 */
async function runFixer(deps = {}) {
  const env       = deps.env       || process.env;
  const repoRoot  = deps.repoRoot  || process.cwd();
  const transport = deps.transport || null;
  const _git      = deps.git       || ((args, opts) => core.git(args, repoRoot, { ...opts, runner: deps.runner }));
  const _gate     = deps.gate      || ((opts) => core.runGate(repoRoot, { ...opts, runner: deps.runner }));
  const _callClaude = deps.callClaude || core.callClaude;

  const cfg = core.readEnv(env);
  if (!cfg.ok) {
    core.log(cfg.reason);
    return { status: 'disabled', reason: cfg.reason };
  }

  core.log(`starting fixer for ${cfg.repo} run #${cfg.runId} (model: ${cfg.model}, maxAttempts: ${cfg.maxAttempts})`);

  // Fetch run + logs
  let runResp, logsResp;
  try {
    runResp = await core.fetchWorkflowRun(cfg.token, cfg.repo, cfg.runId, { transport });
    if (core.isRateLimited(runResp)) { core.log('GitHub API rate-limited — exiting 0'); return { status: 'rate-limited' }; }
    if (runResp.status !== 200)      { core.log(`could not fetch run (${runResp.status}) — exiting 0`); return { status: 'no-run' }; }

    logsResp = await core.fetchWorkflowLogs(cfg.token, cfg.repo, cfg.runId, { transport });
    if (logsResp && logsResp.response && core.isRateLimited(logsResp.response)) {
      core.log('GitHub API rate-limited fetching logs — exiting 0');
      return { status: 'rate-limited' };
    }
  } catch (err) {
    core.logErr('fetching workflow data', err);
    return { status: 'github-error' };
  }

  const runUrl     = runResp.body?.html_url || `https://github.com/${cfg.repo}/actions/runs/${cfg.runId}`;
  const logExcerpt = core.tailLines(logsResp.text || '', core.MAX_LOG_LINES);

  // Identify failing files
  const failingPaths = core.extractFailingFiles(logExcerpt, repoRoot);
  core.log(`identified ${failingPaths.length} failing file(s) from log`);
  const files = core.readFilesForClaude(failingPaths, repoRoot);
  if (files.length === 0) {
    core.log('no readable failing files identified — exiting 0');
    return { status: 'no-files' };
  }

  // Attempt loop
  const attempted = [];
  let lastError = null;
  const tryDeps = { callClaude: _callClaude, git: _git, gate: _gate, transport, repoRoot };
  for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
    core.log(`attempt ${attempt}/${cfg.maxAttempts}`);
    const r = await tryAttempt({ cfg, files, logExcerpt, attempt, deps: tryDeps });
    attempted.push({ attempt, patchCount: r.patches.length });
    if (r.error) { lastError = r.error; continue; }
    if (r.patches.length === 0) continue;
    if (r.ok) {
      core.log(`attempt ${attempt}: gate is GREEN — opening PR`);
      const branch = `ai-fix/${cfg.runId}`;
      const prResp = await openFixPr({
        token: cfg.token, repo: cfg.repo, branch, runUrl, logExcerpt,
        attempt, model: cfg.model,
        baseRef: runResp.body?.head_branch || 'main',
        git: _git, transport,
      });
      return { status: 'pr-opened', attempt, pr: prResp };
    }
    core.log(`attempt ${attempt}: gate still red`);
    lastError = new Error(`Gate still red after attempt ${attempt}`);
  }

  // Exhausted — open fallback issue
  core.log('all attempts exhausted — opening fallback issue');
  try {
    const issueResp = await core.createIssue({
      token: cfg.token, repo: cfg.repo,
      title: `AI CI-fixer couldn't repair workflow run #${cfg.runId}`,
      body:  core.buildIssueBody({ runUrl, logExcerpt, attempted, lastError, model: cfg.model }),
      opts:  { transport },
    });
    return { status: 'gave-up', issue: issueResp, attempted };
  } catch (err) {
    core.logErr('opening fallback issue', err);
    return { status: 'gave-up-no-issue', attempted };
  }
}

// ── Entry point ─────────────────────────────────────────────────────────────

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stdout.write(USAGE);
    return 0;
  }
  try {
    const result = await runFixer();
    core.log(`done: ${result.status}`);
    return 0;
  } catch (err) {
    core.logErr('unhandled', err);
    return 0;
  }
}

if (require.main === module) {
  main().then((code) => process.exit(code));
}

// ── Exports — re-export core helpers so tests have one import surface ──────

module.exports = {
  ...core,
  runFixer,
  openFixPr,
  tryAttempt,
};
