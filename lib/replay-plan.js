/**
 * Replay-plan helpers — pure, no I/O.
 *
 * Provides:
 *   parseRunUrl(url, fallbackRepo)
 *     -> { owner, repo, runId, jobId? }  (throws InvalidUrlError)
 *   buildReplayPlan(failingJobs, workflowYaml?)
 *     -> ReplayStep[]   ({ jobName, stepName, command, source, jobId? })
 *   compareResults(ciResult, localResult)
 *     -> { matchesCi, diff, verdict }
 *
 * Replay mode is the killer dev-experience feature: hand it a GitHub Actions
 * run URL, get back a list of commands to run locally that mirror what CI
 * ran. Plan-building stays pure so it's hermetically testable.
 */

'use strict';

// ── Errors ──────────────────────────────────────────────────────────────────

class InvalidUrlError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'InvalidUrlError';
  }
}

// ── parseRunUrl ─────────────────────────────────────────────────────────────

/**
 * Accept any of:
 *   https://github.com/owner/repo/actions/runs/12345
 *   https://github.com/owner/repo/actions/runs/12345/job/67890
 *   12345                      (only if fallbackRepo is "owner/repo")
 *
 * Returns { owner, repo, runId, jobId? }. runId is a string (some run IDs
 * exceed Number.MAX_SAFE_INTEGER) but always all-digits.
 */
function parseRunUrl(url, fallbackRepo) {
  if (url === null || url === undefined) {
    throw new InvalidUrlError('run URL is required');
  }
  const trimmed = String(url).trim();
  if (!trimmed) {
    throw new InvalidUrlError('run URL is empty');
  }

  // Bare run ID — must be all digits, and the caller must give us a fallback repo.
  if (/^\d+$/.test(trimmed)) {
    if (!fallbackRepo || !/^[^/]+\/[^/]+$/.test(String(fallbackRepo))) {
      throw new InvalidUrlError(`bare run ID "${trimmed}" requires GITHUB_REPOSITORY=owner/repo`);
    }
    const [owner, repo] = String(fallbackRepo).split('/');
    return { owner, repo, runId: trimmed };
  }

  // Full URL form. Accept http/https + github.com host only.
  const re = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/i;
  const m = trimmed.match(re);
  if (!m) {
    throw new InvalidUrlError(`not a GitHub Actions run URL: ${trimmed.slice(0, 80)}`);
  }
  const out = { owner: m[1], repo: m[2].replace(/\.git$/, ''), runId: m[3] };
  if (m[4]) out.jobId = m[4];
  return out;
}

// ── buildReplayPlan ─────────────────────────────────────────────────────────

/**
 * Mapping table — known CI step names → local commands. Keys are
 * normalised (lower, trimmed). Values are the command the user would
 * run in their working tree. These come from the gatetest ci.yml shapes
 * and from the most common Node/Next.js CI conventions.
 */
const STEP_NAME_TO_LOCAL_COMMAND = {
  // gatetest's own workflow
  'run tests':                                        'node --test tests/*.test.js',
  'build website':                                    'cd website && npm run build',
  'run tsc --noemit':                                 'cd website && npx tsc --noEmit',
  'run gatetest quick scan':                          'node bin/gatetest.js --suite quick',
  'run gatetest full scan':                           'node bin/gatetest.js --suite full',
  'run quick self-scan against the gatetest repo itself': 'node bin/gatetest.js --suite quick',
  'self-scan green':                                  'node bin/gatetest.js --suite quick',
  'all tests pass':                                   'node --test tests/*.test.js',
  'website builds clean':                             'cd website && npx next build',

  // Common conventions
  'install':                                          'npm ci',
  'install dependencies':                             'npm ci',
  'lint':                                             'npm run lint',
  'test':                                             'npm test',
  'tests':                                            'npm test',
  'build':                                            'npm run build',
  'typecheck':                                        'npm run typecheck',
  'type check':                                       'npm run typecheck',
  'format check':                                     'npm run format -- --check',
};

/**
 * Given the failing jobs array (from /actions/runs/{id}/jobs) and an
 * optional parsed workflow YAML (loose object), return ReplayStep[].
 *
 * failingJobs: [{ id, name, status, conclusion, steps: [{ name, conclusion }] }]
 *
 * Strategy per failing step:
 *   1. If the workflow YAML has a `run:` string for that step, use it raw.
 *   2. Else, fall back to the mapping table.
 *   3. Else, emit a `source: "unknown"` ReplayStep with a TODO command so
 *      the user sees what was tried, not silently skipped.
 */
function buildReplayPlan(failingJobs, workflowYaml) {
  const plan = [];
  if (!Array.isArray(failingJobs)) return plan;

  // Build a name→runCommand lookup from the workflow YAML, if provided.
  const yamlLookup = workflowYaml ? _buildYamlStepLookup(workflowYaml) : new Map();

  for (const job of failingJobs) {
    if (!job || typeof job !== 'object') continue;
    const jobName = String(job.name || job.workflow_name || 'unnamed-job');
    const steps = Array.isArray(job.steps) ? job.steps : [];
    // Only consider failed steps. If the job failed but no step is marked
    // failed (rare — usually only on cancellation), emit a single advisory
    // step so the customer still sees the job.
    const failedSteps = steps.filter((s) => s && s.conclusion === 'failure');
    if (failedSteps.length === 0) {
      plan.push({
        jobName,
        stepName: '(job failed but no step-level failure recorded)',
        command: '# Unable to determine which step failed — re-check the run page',
        source: 'unknown',
        jobId: job.id,
      });
      continue;
    }
    for (const step of failedSteps) {
      const stepName = String(step.name || 'unnamed-step');
      const key = stepName.toLowerCase().trim();

      // Priority 1: workflow YAML's raw `run:` text for this step.
      const yamlCmd = yamlLookup.get(`${jobName}:${stepName}`) || yamlLookup.get(stepName);
      if (yamlCmd) {
        plan.push({ jobName, stepName, command: yamlCmd, source: 'workflow', jobId: job.id });
        continue;
      }

      // Priority 2: mapping table.
      if (Object.prototype.hasOwnProperty.call(STEP_NAME_TO_LOCAL_COMMAND, key)) {
        plan.push({
          jobName, stepName,
          command: STEP_NAME_TO_LOCAL_COMMAND[key],
          source: 'mapping',
          jobId: job.id,
        });
        continue;
      }

      // Priority 3: unknown. Emit an advisory step so we never silently skip.
      plan.push({
        jobName, stepName,
        command: `# Could not auto-map step "${stepName}" — check the workflow file`,
        source: 'unknown',
        jobId: job.id,
      });
    }
  }
  return plan;
}

/**
 * Walk a parsed workflow YAML and build a Map of step-name → run-command.
 * The YAML shape is `{ jobs: { <jobId>: { name, steps: [{ name, run }] } } }`.
 * Lookup is keyed both by "jobName:stepName" and bare "stepName" so the
 * caller can fall through if jobName isn't an exact match.
 *
 * No-op safe — accepts {} / null / undefined.
 */
function _buildYamlStepLookup(workflowYaml) {
  const lookup = new Map();
  if (!workflowYaml || typeof workflowYaml !== 'object') return lookup;
  const jobs = workflowYaml.jobs;
  if (!jobs || typeof jobs !== 'object') return lookup;
  for (const jobId of Object.keys(jobs)) {
    const job = jobs[jobId];
    if (!job || typeof job !== 'object') continue;
    const jobName = String(job.name || jobId);
    const steps = Array.isArray(job.steps) ? job.steps : [];
    for (const step of steps) {
      if (!step || typeof step !== 'object') continue;
      if (!step.name || typeof step.run !== 'string') continue;
      const cmd = step.run.trim();
      if (!cmd) continue;
      lookup.set(`${jobName}:${step.name}`, cmd);
      // Also key by the bare step name (last-write wins on duplicates — fine,
      // step names are usually unique enough).
      lookup.set(String(step.name), cmd);
    }
  }
  return lookup;
}

// ── compareResults ──────────────────────────────────────────────────────────

/**
 * Compare a CI step's result vs the local replay's result.
 *
 * Inputs:
 *   ciResult:    { passed: bool, signature?: string }
 *   localResult: { passed: bool, signature?: string, exitCode?: number, output?: string }
 *
 * Returns:
 *   { matchesCi: boolean, diff: string, verdict: 'same'|'different'|'flaky'|'passes-here' }
 *
 * Verdict rules:
 *   - CI failed + local failed + signatures match → 'same'      (matchesCi: true)
 *   - CI failed + local failed + signatures differ → 'different' (matchesCi: false)
 *   - CI failed + local passed                    → 'flaky'      (matchesCi: false)
 *   - CI passed + local passed                    → 'passes-here' (matchesCi: true)
 *   - CI passed + local failed                    → 'different'  (matchesCi: false)
 *
 * `signature` is an optional short string that summarises the failure (e.g.
 * "tests/foo.test.js failed", "exit 2"). When both sides supply one, equality
 * implies same-failure; absence on either side falls back to passed-vs-failed.
 */
function compareResults(ciResult, localResult) {
  const ci = ciResult || {};
  const local = localResult || {};
  const ciPassed = ci.passed === true;
  const localPassed = local.passed === true;

  // Both passed.
  if (ciPassed && localPassed) {
    return { matchesCi: true, diff: 'both passed', verdict: 'passes-here' };
  }
  // CI passed but local failed (unusual; user might have local-only breakage).
  if (ciPassed && !localPassed) {
    return {
      matchesCi: false,
      diff: `CI passed but local failed${local.signature ? ` (${local.signature})` : ''}`,
      verdict: 'different',
    };
  }
  // CI failed, local passed → flaky CI or fix already on disk.
  if (!ciPassed && localPassed) {
    return {
      matchesCi: false,
      diff: 'CI failed but local passes — may be a flake or your tree already has the fix',
      verdict: 'flaky',
    };
  }
  // Both failed.
  const ciSig = String(ci.signature || '').trim();
  const localSig = String(local.signature || '').trim();
  if (ciSig && localSig) {
    if (ciSig === localSig) {
      return { matchesCi: true, diff: `same failure as CI: ${ciSig}`, verdict: 'same' };
    }
    return {
      matchesCi: false,
      diff: `different failure — CI: "${ciSig}" / local: "${localSig}"`,
      verdict: 'different',
    };
  }
  // No signatures — both failed, treat as "same" by default (we have no way
  // to distinguish further; calling this 'different' would be misleading).
  return { matchesCi: true, diff: 'both failed (no signature available)', verdict: 'same' };
}

module.exports = {
  parseRunUrl,
  buildReplayPlan,
  compareResults,
  InvalidUrlError,
  // Test/internal helpers
  STEP_NAME_TO_LOCAL_COMMAND,
  _buildYamlStepLookup,
};
