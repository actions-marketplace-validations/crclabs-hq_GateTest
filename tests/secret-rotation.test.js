const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const SecretRotationModule = require('../src/modules/secret-rotation');

function makeResult() {
  return {
    checks: [],
    addCheck(name, passed, details = {}) {
      this.checks.push({ name, passed, ...details });
    },
  };
}

function run(projectRoot) {
  const mod = new SecretRotationModule();
  const result = makeResult();
  return mod.run(result, { projectRoot }).then(() => result);
}

function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function initGit(root) {
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: root });
}

function commit(root, msg, opts = {}) {
  execFileSync('git', ['add', '-A'], { cwd: root });
  const env = { ...process.env };
  if (opts.date) {
    env.GIT_AUTHOR_DATE = opts.date;
    env.GIT_COMMITTER_DATE = opts.date;
  }
  execFileSync('git', ['commit', '-q', '-m', msg], { cwd: root, env });
}

// Build an ISO date string N days before today.
function daysAgo(n) {
  const d = new Date(Date.now() - n * 24 * 60 * 60 * 1000);
  return d.toISOString();
}

describe('SecretRotationModule — discovery & summary', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-sr-disc-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('emits summary when no secrets present', async () => {
    write(tmp, 'src/a.js', 'console.log("hi");\n');
    const r = await run(tmp);
    const summary = r.checks.find((c) => c.name === 'secret-rotation:summary');
    assert.ok(summary);
  });

  it('degrades gracefully when not a git repo (uses file mtime)', async () => {
    write(tmp, 'src/a.js', 'const key = "AKIAIOSFODNN7EXAMPLE";\n');
    const r = await run(tmp);
    const summary = r.checks.find((c) => c.name === 'secret-rotation:summary');
    assert.ok(summary);
    assert.strictEqual(summary.gitAware, false);
  });
});

describe('SecretRotationModule — stale & aging credentials (git-aware)', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-sr-git-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('errors on a credential whose last git commit is > 90 days old', async () => {
    initGit(tmp);
    write(tmp, 'src/a.js', 'const key = "AKIAIOSFODNN7EXAMPLE";\n');
    commit(tmp, 'seed', { date: daysAgo(200) });
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('secret-rotation:stale:'));
    assert.ok(hit, 'expected stale finding');
    assert.strictEqual(hit.severity, 'error');
    assert.ok(hit.ageDays >= 90);
  });

  it('warns on a credential between 30 and 90 days old', async () => {
    initGit(tmp);
    write(tmp, 'src/a.js', 'ghp_1234567890abcdefghijklmnopqrstuvwxyz1\n');
    commit(tmp, 'seed', { date: daysAgo(45) });
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('secret-rotation:aging:'));
    assert.ok(hit, 'expected aging finding');
    assert.strictEqual(hit.severity, 'warning');
    assert.ok(hit.ageDays >= 30 && hit.ageDays < 90);
  });

  it('does NOT flag a credential < 30 days old', async () => {
    initGit(tmp);
    // Build the shape at runtime so the source file doesn't contain the
    // raw Stripe-shaped literal (push-protection-friendly).
    const stripeish = 'sk_' + 'live_' + 'abcdefghijklmnopqrstuvwx';
    write(tmp, 'src/a.js', `const k = "${stripeish}";\n`);
    commit(tmp, 'seed');
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('secret-rotation:stale:')),
      undefined,
    );
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('secret-rotation:aging:')),
      undefined,
    );
  });

  it('detects anthropic keys', async () => {
    initGit(tmp);
    write(tmp, 'src/a.js', 'const a = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz01234567";\n');
    commit(tmp, 'seed', { date: daysAgo(200) });
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('secret-rotation:stale:anthropic-key:'));
    assert.ok(hit);
  });

  it('skips files under fixtures/', async () => {
    initGit(tmp);
    write(tmp, 'tests/fixtures/sample.txt', 'AKIAIOSFODNN7EXAMPLE\n');
    commit(tmp, 'seed', { date: daysAgo(200) });
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('secret-rotation:stale:')),
      undefined,
    );
  });
});

describe('SecretRotationModule — .env drift', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-sr-env-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('warns when .env has a var missing from .env.example', async () => {
    write(tmp, '.env', 'STRIPE_SECRET_KEY=sk_test_abc\nDB_URL=postgres://x\n');
    write(tmp, '.env.example', 'STRIPE_SECRET_KEY=\n');
    const r = await run(tmp);
    const hit = r.checks.find(
      (c) => c.name === 'secret-rotation:env-drift:missing-from-example:DB_URL',
    );
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'warning');
  });

  it('emits info when .env.example documents a var absent from .env', async () => {
    write(tmp, '.env', 'STRIPE_SECRET_KEY=sk_test_abc\n');
    write(tmp, '.env.example', 'STRIPE_SECRET_KEY=\nANTHROPIC_API_KEY=\n');
    const r = await run(tmp);
    const hit = r.checks.find(
      (c) => c.name === 'secret-rotation:env-drift:missing-from-env:ANTHROPIC_API_KEY',
    );
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'info');
  });

  it('warns when .env.example contains a real-looking credential', async () => {
    write(tmp, '.env', 'GITHUB_TOKEN=ghp_realrealrealrealrealrealrealreal1234\n');
    write(tmp, '.env.example', 'GITHUB_TOKEN=ghp_realrealrealrealrealrealrealreal1234\n');
    const r = await run(tmp);
    assert.ok(r.checks.find(
      (c) => c.name === 'secret-rotation:example-shaped-like-real:GITHUB_TOKEN',
    ));
  });

  it('does NOT warn when example uses an obvious placeholder', async () => {
    write(tmp, '.env', 'GITHUB_TOKEN=ghp_realrealrealrealrealrealrealreal1234\n');
    write(tmp, '.env.example', 'GITHUB_TOKEN=your-github-pat-here\n');
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name === 'secret-rotation:example-shaped-like-real:GITHUB_TOKEN'),
      undefined,
    );
  });

  it('emits info when .env exists but no .env.example', async () => {
    write(tmp, '.env', 'STRIPE_SECRET_KEY=sk_test_abc\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name === 'secret-rotation:no-example'));
  });
});
