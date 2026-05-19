#!/usr/bin/env node

/**
 * gatetest replay <run-url> [options]
 *
 * Reproduce a failing GitHub Actions run locally in under 30 seconds.
 * Fetches the run, identifies failing jobs+steps, builds a replay plan,
 * executes each step against the current working tree, then diffs the
 * local result against the CI verdict.
 *
 * Robustness rules (Bible — Always-On + Forbidden #15):
 *   - Never crash on partial info. Logs unreachable, YAML missing,
 *     unknown step — degrade gracefully, surface what we know.
 *   - Never block the user. 3 retries max, then move on.
 *   - No emojis in user-facing output.
 *
 * Heavy lifting lives in:
 *   lib/replay-plan.js     — URL parsing, plan building, result comparison
 *   lib/github-runs.js     — REST wrapper with rate-limit retry
 *   lib/minimal-yaml.js    — workflow-YAML extractor
 *   lib/replay-runner.js   — local execution + console rendering
 */

'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { parseRunUrl, buildReplayPlan, InvalidUrlError } = require('../lib/replay-plan');
const { fetchRun, fetchJobs } = require('../lib/github-runs');
const { loadWorkflowYaml } = require('../lib/minimal-yaml');
const {
  runLocalCommand,
  deriveVerdict,
  pickRunMeta,
  pickJob,
  renderConsole,
  executePlanStep,
} = require('../lib/replay-runner');

// ── Help text ───────────────────────────────────────────────────────────────

const HELP = `
  gatetest replay <run-url> [options]

  Reproduce a failing GitHub Actions run on your laptop in seconds.

  ARGUMENTS
    <run-url>            One of:
                           https://github.com/owner/repo/actions/runs/12345
                           https://github.com/owner/repo/actions/runs/12345/job/67890
                           12345  (with GITHUB_REPOSITORY=owner/repo set)

  OPTIONS
    ++token <pat>        GitHub personal-access token. Optional. Resolution
                         order: --token, GITHUB_TOKEN, GH_TOKEN, gh CLI.
                         Falls back to unauthenticated (60 req/hour).
    --working-dir <path> Directory to replay against (default: cwd)
    --json               Emit a JSON report instead of console output
    --verbose            Stream subprocess stdout/stderr live
    --help, -h           Show this help

  EXAMPLES
    gatetest replay https://github.com/ccantynz-alt/gatetest/actions/runs/26002454347
    gatetest replay 26002454347   # with GITHUB_REPOSITORY set
    GITHUB_TOKEN=ghp_... gatetest replay <url> --json

  WHAT IT DOES
    1. Fetches the run + jobs from GitHub REST
    2. Identifies which steps failed
    3. Maps each failed step to a local command (workflow YAML > mapping > advisory)
    4. Runs each command in your working tree
    5. Diffs the local verdict against the CI verdict — same / different / flaky
`;

// ── Args + token resolution ─────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--json') args.json = true;
    else if (a === '--verbose') args.verbose = true;
    else if (a === '--token' && argv[i + 1] !== undefined) args.token = argv[++i];
    else if (a === '--working-dir' && argv[i + 1] !== undefined) args.workingDir = argv[++i];
    else if (a.startsWith('--')) args[a.slice(2)] = true;
    else args.positional.push(a);
  }
  return args;
}

function resolveToken(args, env = process.env, runner = spawnSync) {
  if (args.token) return args.token;
  if (env.GITHUB_TOKEN) return env.GITHUB_TOKEN;
  if (env.GH_TOKEN) return env.GH_TOKEN;
  try {
    const r = runner('gh', ['auth', 'token'], {
      encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (r && r.status === 0 && r.stdout) {
      const tok = String(r.stdout).trim();
      if (tok) return tok;
    }
  } catch { /* gh not installed — fine */ }
  return null;
}

// ── runReplay — the testable orchestrator ───────────────────────────────────

async function runReplay({ url, workingDir, token, env = process.env, deps = {} }) {
  const fallbackRepo = env.GITHUB_REPOSITORY || null;
  let parsed;
  try {
    parsed = parseRunUrl(url, fallbackRepo);
  } catch (err) {
    return { ok: false, error: err.message, stage: 'parse-url' };
  }

  const transport = deps.transport || undefined;
  const runMeta = await fetchRun({ ...parsed, token, transport });
  if (!runMeta) {
    return {
      ok: false,
      error: 'Could not fetch run metadata — repo may be private without a token, or the run was deleted.',
      stage: 'fetch-run',
      parsed,
    };
  }

  const jobs = await fetchJobs({ ...parsed, token, transport });
  let failingJobs = jobs.filter((j) => j && (j.conclusion === 'failure' || j.conclusion === 'cancelled'));
  if (parsed.jobId) {
    failingJobs = failingJobs.filter((j) => String(j.id) === String(parsed.jobId));
  }

  if (failingJobs.length === 0) {
    return {
      ok: true,
      runMeta: pickRunMeta(runMeta),
      parsed,
      failingJobs: [],
      plan: [],
      results: [],
      verdict: runMeta.conclusion === 'success' ? 'ci-passed' : 'no-failed-jobs',
      message: 'Run had no failed jobs — nothing to replay.',
    };
  }

  const workflowPath = runMeta.path || (runMeta.workflow && runMeta.workflow.path) || null;
  const yamlLoader = deps.loadWorkflowYaml || loadWorkflowYaml;
  const yaml = yamlLoader(workingDir, workflowPath);
  const plan = buildReplayPlan(failingJobs, yaml);

  const exec = deps.runLocalCommand || ((cmd) => runLocalCommand(cmd, workingDir, false));
  const results = plan.map((step) => executePlanStep(step, exec));

  return {
    ok: true,
    runMeta: pickRunMeta(runMeta),
    parsed,
    failingJobs: failingJobs.map(pickJob),
    plan,
    results,
    verdict: deriveVerdict(results),
  };
}

// ── CLI bootstrap ───────────────────────────────────────────────────────────

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help || argv.length === 0) {
    process.stdout.write(HELP + '\n');
    return 0;
  }
  const url = args.positional[0];
  if (!url) {
    process.stderr.write('gatetest replay: missing <run-url> — try `gatetest replay --help`\n');
    return 2;
  }
  const workingDir = args.workingDir ? path.resolve(args.workingDir) : process.cwd();
  const token = resolveToken(args, process.env);

  let report;
  try {
    report = await runReplay({ url, workingDir, token });
  } catch (err) {
    if (err instanceof InvalidUrlError) {
      report = { ok: false, error: err.message, stage: 'parse-url' };
    } else {
      report = { ok: false, error: err.message || String(err), stage: 'fatal' };
    }
  }

  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write(renderConsole(report));
  }
  if (!report.ok) return 2;
  if (report.verdict === 'reproduces-locally' || report.verdict === 'mixed') return 1;
  return 0;
}

if (require.main === module) {
  main().then((code) => process.exit(code || 0)).catch((err) => {
    process.stderr.write(`gatetest replay: fatal error: ${err && err.message ? err.message : err}\n`);
    process.exit(2);
  });
}

module.exports = { main, runReplay, parseArgs, resolveToken };
