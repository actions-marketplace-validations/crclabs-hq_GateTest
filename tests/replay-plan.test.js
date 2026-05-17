/**
 * Tests for lib/replay-plan.js — URL parsing, plan building, result diff.
 * Hermetic: pure functions, no I/O.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseRunUrl,
  buildReplayPlan,
  compareResults,
  InvalidUrlError,
  STEP_NAME_TO_LOCAL_COMMAND,
  _buildYamlStepLookup,
} = require('../lib/replay-plan');

// ── parseRunUrl ─────────────────────────────────────────────────────────────

test('parseRunUrl — happy path full URL', () => {
  const r = parseRunUrl('https://github.com/ccantynz-alt/gatetest/actions/runs/26002454347');
  assert.equal(r.owner, 'ccantynz-alt');
  assert.equal(r.repo, 'gatetest');
  assert.equal(r.runId, '26002454347');
  assert.equal(r.jobId, undefined);
});

test('parseRunUrl — job-scoped URL', () => {
  const r = parseRunUrl('https://github.com/foo/bar/actions/runs/12345/job/67890');
  assert.equal(r.owner, 'foo');
  assert.equal(r.repo, 'bar');
  assert.equal(r.runId, '12345');
  assert.equal(r.jobId, '67890');
});

test('parseRunUrl — strips .git suffix from repo', () => {
  const r = parseRunUrl('https://github.com/foo/bar.git/actions/runs/12345');
  assert.equal(r.repo, 'bar');
});

test('parseRunUrl — bare run ID with GITHUB_REPOSITORY fallback', () => {
  const r = parseRunUrl('12345', 'foo/bar');
  assert.equal(r.owner, 'foo');
  assert.equal(r.repo, 'bar');
  assert.equal(r.runId, '12345');
});

test('parseRunUrl — bare run ID without fallback throws', () => {
  assert.throws(() => parseRunUrl('12345'), InvalidUrlError);
});

test('parseRunUrl — bare run ID with malformed fallback throws', () => {
  assert.throws(() => parseRunUrl('12345', 'not-a-repo'), InvalidUrlError);
});

test('parseRunUrl — non-github URL throws InvalidUrlError', () => {
  assert.throws(() => parseRunUrl('https://gitlab.com/foo/bar/-/jobs/123'), InvalidUrlError);
});

test('parseRunUrl — empty input throws', () => {
  assert.throws(() => parseRunUrl(''), InvalidUrlError);
  assert.throws(() => parseRunUrl(null), InvalidUrlError);
});

test('parseRunUrl — junk URL throws', () => {
  assert.throws(() => parseRunUrl('https://github.com/owner/repo/pulls/5'), InvalidUrlError);
});

// ── buildReplayPlan ─────────────────────────────────────────────────────────

test('buildReplayPlan — known step names hit the mapping table', () => {
  const failing = [{
    id: 100, name: 'Test + Build',
    steps: [{ name: 'Run tests', conclusion: 'failure' }],
  }];
  const plan = buildReplayPlan(failing);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].source, 'mapping');
  assert.equal(plan[0].command, STEP_NAME_TO_LOCAL_COMMAND['run tests']);
  assert.equal(plan[0].jobName, 'Test + Build');
});

test('buildReplayPlan — unknown step name emits advisory placeholder', () => {
  const failing = [{
    id: 1, name: 'Custom Job',
    steps: [{ name: 'Some Custom Thing', conclusion: 'failure' }],
  }];
  const plan = buildReplayPlan(failing);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].source, 'unknown');
  assert.match(plan[0].command, /Could not auto-map/);
});

test('buildReplayPlan — workflow YAML overrides mapping table', () => {
  const failing = [{
    id: 1, name: 'Test + Build',
    steps: [{ name: 'Run tests', conclusion: 'failure' }],
  }];
  const yaml = {
    jobs: {
      test: {
        name: 'Test + Build',
        steps: [{ name: 'Run tests', run: 'custom-cmd --foo' }],
      },
    },
  };
  const plan = buildReplayPlan(failing, yaml);
  assert.equal(plan[0].source, 'workflow');
  assert.equal(plan[0].command, 'custom-cmd --foo');
});

test('buildReplayPlan — only failed steps are included', () => {
  const failing = [{
    id: 1, name: 'Test',
    steps: [
      { name: 'Setup', conclusion: 'success' },
      { name: 'Run tests', conclusion: 'failure' },
      { name: 'Cleanup', conclusion: 'skipped' },
    ],
  }];
  const plan = buildReplayPlan(failing);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].stepName, 'Run tests');
});

test('buildReplayPlan — job-failed-with-no-step-failure emits one advisory', () => {
  const failing = [{
    id: 1, name: 'Cancelled Job',
    steps: [{ name: 'Setup', conclusion: 'cancelled' }],
  }];
  const plan = buildReplayPlan(failing);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].source, 'unknown');
});

test('buildReplayPlan — empty / non-array input returns []', () => {
  assert.deepEqual(buildReplayPlan(undefined), []);
  assert.deepEqual(buildReplayPlan(null), []);
  assert.deepEqual(buildReplayPlan('not-array'), []);
});

test('buildReplayPlan — multiple failing steps across multiple jobs', () => {
  const failing = [
    { id: 1, name: 'Test', steps: [{ name: 'Run tests', conclusion: 'failure' }] },
    { id: 2, name: 'TypeScript', steps: [{ name: 'Run tsc --noEmit', conclusion: 'failure' }] },
  ];
  const plan = buildReplayPlan(failing);
  assert.equal(plan.length, 2);
  assert.equal(plan[0].jobName, 'Test');
  assert.equal(plan[1].jobName, 'TypeScript');
});

test('_buildYamlStepLookup — extracts run text by step name', () => {
  const yaml = {
    jobs: { test: { name: 'Test', steps: [{ name: 'Build', run: 'npm run build' }] } },
  };
  const lookup = _buildYamlStepLookup(yaml);
  assert.equal(lookup.get('Build'), 'npm run build');
  assert.equal(lookup.get('Test:Build'), 'npm run build');
});

test('_buildYamlStepLookup — handles malformed input gracefully', () => {
  assert.equal(_buildYamlStepLookup(null).size, 0);
  assert.equal(_buildYamlStepLookup({}).size, 0);
  assert.equal(_buildYamlStepLookup({ jobs: null }).size, 0);
});

// ── compareResults ──────────────────────────────────────────────────────────

test('compareResults — same failure signature reports matchesCi: true', () => {
  const r = compareResults(
    { passed: false, signature: 'tests/foo.test.js failed' },
    { passed: false, signature: 'tests/foo.test.js failed' },
  );
  assert.equal(r.matchesCi, true);
  assert.equal(r.verdict, 'same');
  assert.match(r.diff, /same failure/);
});

test('compareResults — different failure signatures returns matchesCi: false', () => {
  const r = compareResults(
    { passed: false, signature: 'tests/a.test.js failed' },
    { passed: false, signature: 'tests/b.test.js failed' },
  );
  assert.equal(r.matchesCi, false);
  assert.equal(r.verdict, 'different');
  assert.match(r.diff, /different failure/);
});

test('compareResults — CI failed but local passed → flaky', () => {
  const r = compareResults(
    { passed: false, signature: 'tests/foo failed' },
    { passed: true, signature: '' },
  );
  assert.equal(r.matchesCi, false);
  assert.equal(r.verdict, 'flaky');
  assert.match(r.diff, /flake|fix/);
});

test('compareResults — both passed → passes-here', () => {
  const r = compareResults({ passed: true }, { passed: true });
  assert.equal(r.matchesCi, true);
  assert.equal(r.verdict, 'passes-here');
});

test('compareResults — CI passed but local failed → different', () => {
  const r = compareResults(
    { passed: true },
    { passed: false, signature: 'local breakage' },
  );
  assert.equal(r.matchesCi, false);
  assert.equal(r.verdict, 'different');
});

test('compareResults — both failed with no signatures → same (default)', () => {
  const r = compareResults({ passed: false }, { passed: false });
  assert.equal(r.matchesCi, true);
  assert.equal(r.verdict, 'same');
});

test('compareResults — null inputs do not crash', () => {
  const r = compareResults(null, null);
  // Both undefined-passed treated as both failed-no-sig → same.
  assert.equal(r.matchesCi, true);
});
