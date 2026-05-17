/**
 * Tests for bin/gatetest-replay.js — args parsing, token resolution,
 * runReplay orchestration. Hermetic: every external call is injected.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const replay = require('../bin/gatetest-replay');

// ── parseArgs ───────────────────────────────────────────────────────────────

test('parseArgs — positional URL captured', () => {
  const args = replay.parseArgs(['https://github.com/foo/bar/actions/runs/1']);
  assert.deepEqual(args.positional, ['https://github.com/foo/bar/actions/runs/1']);
});

test('parseArgs — flags + positional mix', () => {
  const args = replay.parseArgs(['--json', 'url-here', '--verbose', '--token', 'tok123']);
  assert.equal(args.json, true);
  assert.equal(args.verbose, true);
  assert.equal(args.token, 'tok123');
  assert.deepEqual(args.positional, ['url-here']);
});

test('parseArgs — --help triggers help', () => {
  const args = replay.parseArgs(['--help']);
  assert.equal(args.help, true);
});

// ── resolveToken ────────────────────────────────────────────────────────────

test('resolveToken — --token wins over env vars', () => {
  const tok = replay.resolveToken(
    { token: 'flag-tok' },
    { GITHUB_TOKEN: 'env-tok', GH_TOKEN: 'gh-tok' },
    () => ({ status: 0, stdout: 'cli-tok\n' }),
  );
  assert.equal(tok, 'flag-tok');
});

test('resolveToken — GITHUB_TOKEN wins over GH_TOKEN', () => {
  const tok = replay.resolveToken(
    {},
    { GITHUB_TOKEN: 'env-tok', GH_TOKEN: 'gh-tok' },
    () => ({ status: 0, stdout: 'cli-tok\n' }),
  );
  assert.equal(tok, 'env-tok');
});

test('resolveToken — GH_TOKEN wins over gh CLI', () => {
  const tok = replay.resolveToken(
    {},
    { GH_TOKEN: 'gh-tok' },
    () => ({ status: 0, stdout: 'cli-tok\n' }),
  );
  assert.equal(tok, 'gh-tok');
});

test('resolveToken — gh CLI used when no env / flag', () => {
  const tok = replay.resolveToken(
    {},
    {},
    () => ({ status: 0, stdout: 'cli-tok\n' }),
  );
  assert.equal(tok, 'cli-tok');
});

test('resolveToken — returns null when nothing available', () => {
  const tok = replay.resolveToken(
    {},
    {},
    () => { throw new Error('gh not installed'); },
  );
  assert.equal(tok, null);
});

test('resolveToken — gh non-zero exit falls through to null', () => {
  const tok = replay.resolveToken(
    {},
    {},
    () => ({ status: 1, stdout: '' }),
  );
  assert.equal(tok, null);
});

// ── runReplay — orchestration with stub deps ────────────────────────────────

function stubTransport(responses) {
  let i = 0;
  return {
    request(opts, cb) {
      const r = responses[Math.min(i, responses.length - 1)];
      i++;
      setImmediate(() => {
        const raw = typeof r.body === 'string' ? r.body : JSON.stringify(r.body || {});
        const res = {
          statusCode: r.status,
          headers: { 'content-type': 'application/json', ...(r.headers || {}) },
          on(event, fn) {
            if (event === 'data') fn(Buffer.from(raw));
            if (event === 'end') fn();
          },
        };
        cb(res);
      });
      return { on() {}, write() {}, end() {}, destroy() {} };
    },
  };
}

test('runReplay — invalid URL returns ok:false stage:parse-url', async () => {
  const report = await replay.runReplay({
    url: 'not a url',
    workingDir: '/tmp',
    deps: { runLocalCommand: () => ({ passed: true }), loadWorkflowYaml: () => null },
  });
  assert.equal(report.ok, false);
  assert.equal(report.stage, 'parse-url');
});

test('runReplay — 404 on run returns ok:false stage:fetch-run', async () => {
  const transport = stubTransport([{ status: 404, body: { message: 'not found' } }]);
  const report = await replay.runReplay({
    url: 'https://github.com/foo/bar/actions/runs/999',
    workingDir: '/tmp',
    deps: { transport, runLocalCommand: () => ({ passed: true }), loadWorkflowYaml: () => null },
  });
  assert.equal(report.ok, false);
  assert.equal(report.stage, 'fetch-run');
});

test('runReplay — run with no failed jobs reports nothing-to-replay', async () => {
  const transport = stubTransport([
    { status: 200, body: { id: 1, name: 'CI', path: '.github/workflows/ci.yml', head_sha: 'abc', conclusion: 'success' } },
    { status: 200, body: { jobs: [{ id: 10, name: 'Test', conclusion: 'success', steps: [] }] } },
  ]);
  const report = await replay.runReplay({
    url: 'https://github.com/foo/bar/actions/runs/1',
    workingDir: '/tmp',
    deps: { transport, runLocalCommand: () => ({ passed: true }), loadWorkflowYaml: () => null },
  });
  assert.equal(report.ok, true);
  assert.equal(report.failingJobs.length, 0);
  assert.match(report.message, /nothing to replay/i);
});

test('runReplay — failing job is mapped to a plan and executed', async () => {
  const transport = stubTransport([
    { status: 200, body: { id: 1, name: 'CI', path: '.github/workflows/ci.yml', head_sha: 'abc', conclusion: 'failure' } },
    { status: 200, body: { jobs: [{
      id: 10, name: 'Test + Build', conclusion: 'failure',
      steps: [{ name: 'Run tests', conclusion: 'failure' }],
    }] } },
  ]);
  const executed = [];
  const report = await replay.runReplay({
    url: 'https://github.com/foo/bar/actions/runs/1',
    workingDir: '/tmp',
    deps: {
      transport,
      loadWorkflowYaml: () => null,
      runLocalCommand: (cmd) => {
        executed.push(cmd);
        return { passed: false, signature: 'tests/foo.test.js failed', exitCode: 1, output: '', elapsedMs: 50 };
      },
    },
  });
  assert.equal(report.ok, true);
  assert.equal(report.plan.length, 1);
  assert.equal(executed.length, 1);
  // Maps "Run tests" to the canonical local command.
  assert.match(executed[0], /node --test/);
  assert.equal(report.verdict, 'reproduces-locally');
});

test('runReplay — local pass on CI fail produces "flaky-or-already-fixed"', async () => {
  const transport = stubTransport([
    { status: 200, body: { id: 1, name: 'CI', conclusion: 'failure' } },
    { status: 200, body: { jobs: [{
      id: 10, name: 'Test', conclusion: 'failure',
      steps: [{ name: 'Run tests', conclusion: 'failure' }],
    }] } },
  ]);
  const report = await replay.runReplay({
    url: 'https://github.com/foo/bar/actions/runs/1',
    workingDir: '/tmp',
    deps: {
      transport,
      loadWorkflowYaml: () => null,
      runLocalCommand: () => ({ passed: true, signature: '', exitCode: 0, output: 'all good', elapsedMs: 100 }),
    },
  });
  assert.equal(report.verdict, 'flaky-or-already-fixed');
  assert.equal(report.results[0].comparison.verdict, 'flaky');
});

test('runReplay — workflow YAML overrides the mapping table', async () => {
  const transport = stubTransport([
    { status: 200, body: { id: 1, name: 'CI', path: '.github/workflows/ci.yml', conclusion: 'failure' } },
    { status: 200, body: { jobs: [{
      id: 10, name: 'Test + Build', conclusion: 'failure',
      steps: [{ name: 'Run tests', conclusion: 'failure' }],
    }] } },
  ]);
  const executed = [];
  const report = await replay.runReplay({
    url: 'https://github.com/foo/bar/actions/runs/1',
    workingDir: '/tmp',
    deps: {
      transport,
      loadWorkflowYaml: () => ({
        jobs: {
          test: {
            name: 'Test + Build',
            steps: [{ name: 'Run tests', run: 'pnpm test --reporter=verbose' }],
          },
        },
      }),
      runLocalCommand: (cmd) => {
        executed.push(cmd);
        return { passed: false, signature: 'same', exitCode: 1, output: '', elapsedMs: 1 };
      },
    },
  });
  assert.equal(executed[0], 'pnpm test --reporter=verbose');
  assert.equal(report.plan[0].source, 'workflow');
});

test('runReplay — bare run ID with GITHUB_REPOSITORY env works', async () => {
  const transport = stubTransport([
    { status: 200, body: { id: 12345, name: 'CI', conclusion: 'failure' } },
    { status: 200, body: { jobs: [] } },
  ]);
  const report = await replay.runReplay({
    url: '12345',
    workingDir: '/tmp',
    env: { GITHUB_REPOSITORY: 'owner/repo' },
    deps: { transport, loadWorkflowYaml: () => null, runLocalCommand: () => ({ passed: true }) },
  });
  assert.equal(report.ok, true);
  assert.equal(report.parsed.owner, 'owner');
  assert.equal(report.parsed.repo, 'repo');
});

// ── End-to-end CLI invocation ───────────────────────────────────────────────

test('CLI — --help exits 0 and prints usage', () => {
  const r = spawnSync(process.execPath, [path.resolve(__dirname, '../bin/gatetest-replay.js'), '--help'], {
    encoding: 'utf-8', timeout: 10_000,
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /gatetest replay/);
  assert.match(r.stdout, /Reproduce a failing GitHub Actions run/);
});

test('CLI — no args prints help and exits 0', () => {
  const r = spawnSync(process.execPath, [path.resolve(__dirname, '../bin/gatetest-replay.js')], {
    encoding: 'utf-8', timeout: 10_000,
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /gatetest replay/);
});

test('CLI — invalid URL exits non-zero with parse-url stage', () => {
  const r = spawnSync(process.execPath, [
    path.resolve(__dirname, '../bin/gatetest-replay.js'),
    'not-a-url',
    '--json',
  ], {
    encoding: 'utf-8', timeout: 10_000,
    env: { ...process.env, GITHUB_REPOSITORY: '' },
  });
  assert.notEqual(r.status, 0);
  // --json output goes to stdout.
  const body = JSON.parse(r.stdout);
  assert.equal(body.ok, false);
  assert.equal(body.stage, 'parse-url');
});

test('CLI — `gatetest replay --help` via main bin dispatches correctly', () => {
  const r = spawnSync(process.execPath, [
    path.resolve(__dirname, '../bin/gatetest.js'),
    'replay',
    '--help',
  ], {
    encoding: 'utf-8', timeout: 10_000,
  });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /gatetest replay/);
});
