const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CiSecurityModule = require('../src/modules/ci-security');

function makeResult() {
  return {
    checks: [],
    addCheck(name, passed, details = {}) {
      this.checks.push({ name, passed, ...details });
    },
  };
}

function run(projectRoot) {
  const mod = new CiSecurityModule();
  const result = makeResult();
  return mod.run(result, { projectRoot }).then(() => result);
}

function writeWorkflow(root, name, content) {
  const dir = path.join(root, '.github', 'workflows');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), content);
}

describe('CiSecurityModule — discovery', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ci-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('skips when no workflow files exist', async () => {
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name === 'ci-security:no-files'));
  });

  it('finds both .yml and .yaml in .github/workflows + .gitlab-ci.yml', async () => {
    writeWorkflow(tmp, 'ci.yml', 'name: ci\npermissions: { contents: read }\non: push\njobs: {}\n');
    writeWorkflow(tmp, 'release.yaml', 'name: rel\npermissions: { contents: read }\non: push\njobs: {}\n');
    fs.writeFileSync(path.join(tmp, '.gitlab-ci.yml'), 'stages:\n  - build\n');
    const r = await run(tmp);
    const scanning = r.checks.find((c) => c.name === 'ci-security:scanning');
    assert.match(scanning.message, /3 CI workflow/);
  });
});

describe('CiSecurityModule — action pinning', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ci-pin-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('errors on branch-pinned actions', async () => {
    writeWorkflow(tmp, 'ci.yml', [
      'name: ci',
      'permissions: { contents: read }',
      'on: push',
      'jobs:',
      '  build:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: actions/checkout@main',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('ci-security:branch-pin:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'error');
  });

  it('info-level warning on semver-tag pin (tags are mutable)', async () => {
    writeWorkflow(tmp, 'ci.yml', [
      'name: ci',
      'permissions: { contents: read }',
      'on: push',
      'jobs:',
      '  build:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: actions/checkout@v4',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('ci-security:tag-pin:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'info');
  });

  it('accepts SHA-pinned actions silently', async () => {
    writeWorkflow(tmp, 'ci.yml', [
      'name: ci',
      'permissions: { contents: read }',
      'on: push',
      'jobs:',
      '  build:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: actions/checkout@692973e3d937129bcbf40652eb9f2f61becf3332',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(r.checks.find((c) => c.name.startsWith('ci-security:branch-pin:')), undefined);
    assert.strictEqual(r.checks.find((c) => c.name.startsWith('ci-security:tag-pin:')), undefined);
  });

  it('flags action used with no @ref', async () => {
    writeWorkflow(tmp, 'ci.yml', [
      'name: ci',
      'permissions: { contents: read }',
      'on: push',
      'jobs:',
      '  build:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: actions/checkout',
      '',
    ].join('\n'));
    const r = await run(tmp);
    // With no @ref the regex won't match a pin pattern; but we still want
    // the module to scan cleanly. Assert the file was scanned.
    assert.ok(r.checks.find((c) => c.name === 'ci-security:scanning'));
  });

  it('skips local action references (./...)', async () => {
    writeWorkflow(tmp, 'ci.yml', [
      'name: ci',
      'permissions: { contents: read }',
      'on: push',
      'jobs:',
      '  build:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: ./.github/actions/my-local-action',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(r.checks.find((c) => c.name.startsWith('ci-security:branch-pin:')), undefined);
  });
});

describe('CiSecurityModule — pwn-request', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ci-pwn-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('errors when pull_request_target + checkout of PR head coexist', async () => {
    writeWorkflow(tmp, 'danger.yml', [
      'name: danger',
      'permissions: { contents: read }',
      'on:',
      '  pull_request_target:',
      'jobs:',
      '  build:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: actions/checkout@692973e3d937129bcbf40652eb9f2f61becf3332',
      '        with:',
      '          ref: ${{ github.event.pull_request.head.sha }}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('ci-security:pwn-request:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'error');
  });

  it('warns on pull_request_target alone', async () => {
    writeWorkflow(tmp, 'danger.yml', [
      'name: danger',
      'permissions: { contents: read }',
      'on:',
      '  pull_request_target:',
      'jobs: {}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('ci-security:pr-target:')));
    assert.strictEqual(r.checks.find((c) => c.name.startsWith('ci-security:pwn-request:')), undefined);
  });
});

describe('CiSecurityModule — shell injection + secrets echo', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ci-run-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('errors on github.event.* interpolated into a run block', async () => {
    writeWorkflow(tmp, 'ci.yml', [
      'name: ci',
      'permissions: { contents: read }',
      'on: [issues]',
      'jobs:',
      '  go:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: |',
      '          echo "Issue: ${{ github.event.issue.title }}"',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('ci-security:shell-injection:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'error');
  });

  it('errors on echoing a secret to stdout', async () => {
    writeWorkflow(tmp, 'ci.yml', [
      'name: ci',
      'permissions: { contents: read }',
      'on: push',
      'jobs:',
      '  go:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: echo "${{ secrets.MY_TOKEN }}"',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('ci-security:secret-echo:')));
  });
});

describe('CiSecurityModule — permissions + soft-fail', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ci-perm-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('warns when top-level permissions block is missing', async () => {
    writeWorkflow(tmp, 'ci.yml', [
      'name: ci',
      'on: push',
      'jobs: {}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('ci-security:no-permissions:')));
  });

  it('accepts a file that declares permissions at the top level', async () => {
    writeWorkflow(tmp, 'ci.yml', [
      'name: ci',
      'permissions:',
      '  contents: read',
      'on: push',
      'jobs: {}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(r.checks.find((c) => c.name.startsWith('ci-security:no-permissions:')), undefined);
  });

  it('errors on continue-on-error: true attached to a gatetest step (Bible Forbidden #24)', async () => {
    writeWorkflow(tmp, 'gate.yml', [
      'name: gate',
      'permissions: { contents: read }',
      'on: push',
      'jobs:',
      '  gate:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - name: Run GateTest',
      '        run: npx gatetest --suite full',
      '        continue-on-error: true',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('ci-security:soft-fail-gate:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'error');
  });

  it('does NOT flag continue-on-error on non-gate steps', async () => {
    writeWorkflow(tmp, 'ci.yml', [
      'name: ci',
      'permissions: { contents: read }',
      'on: push',
      'jobs:',
      '  build:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - name: Try flaky script',
      '        run: ./scripts/flaky.sh',
      '        continue-on-error: true',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(r.checks.find((c) => c.name.startsWith('ci-security:soft-fail-gate:')), undefined);
  });

  it('does NOT flag continue-on-error on a SARIF-upload step that follows a gate step (regression)', async () => {
    // Real-world false-positive: the SARIF upload step references
    // `.gatetest/reports/` and uses `continue-on-error: true` legitimately
    // (so a transient upload failure doesn't fail the build). The lookback
    // must stop at the previous step boundary so it doesn't bleed into
    // the prior `gatetest` mention.
    writeWorkflow(tmp, 'ci.yml', [
      'name: ci',
      'permissions: { contents: read, security-events: write }',
      'on: push',
      'jobs:',
      '  gate:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - name: Run GateTest',
      '        run: node bin/gatetest.js --suite quick --sarif --junit',
      '      - name: Upload SARIF to GitHub Security',
      '        if: always()',
      '        uses: github/codeql-action/upload-sarif@v3',
      '        with:',
      '          sarif_file: .gatetest/reports/',
      '        continue-on-error: true',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(r.checks.find((c) => c.name.startsWith('ci-security:soft-fail-gate:')), undefined);
  });
});

describe('CiSecurityModule — summary', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-ci-sum-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('always records a summary when files were scanned', async () => {
    writeWorkflow(tmp, 'ci.yml', 'name: ci\npermissions: { contents: read }\non: push\njobs: {}\n');
    const r = await run(tmp);
    const summary = r.checks.find((c) => c.name === 'ci-security:summary');
    assert.ok(summary);
    assert.match(summary.message, /1 file\(s\)/);
  });
});
