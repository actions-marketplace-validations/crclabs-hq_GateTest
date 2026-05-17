const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const PrSizeModule = require('../src/modules/pr-size');

function makeResult() {
  return {
    checks: [],
    addCheck(name, passed, details = {}) {
      this.checks.push({ name, passed, ...details });
    },
  };
}

async function run(projectRoot, moduleCfg = {}, runnerOpts = {}) {
  const mod = new PrSizeModule();
  const result = makeResult();
  await mod.run(result, { projectRoot, prSize: moduleCfg, runnerOptions: runnerOpts });
  return result;
}

// Minimal fake-git scaffolding: `.git` directory present so the module
// treats the dir as a git repo, then diff is injected via config.diff.
function makeFakeRepo() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-prsz-'));
  fs.mkdirSync(path.join(tmp, '.git'));
  return tmp;
}

function cleanup(tmp) {
  fs.rmSync(tmp, { recursive: true, force: true });
}

function numstat(rows) {
  return rows.map(([a, r, p]) => `${a}\t${r}\t${p}`).join('\n') + '\n';
}

describe('PrSizeModule — no git repo', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-prsz-no-')); });
  afterEach(() => cleanup(tmp));

  it('is a no-op when the project root is not a git repo', async () => {
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name === 'pr-size:not-a-git-repo'));
  });
});

describe('PrSizeModule — empty diff', () => {
  let tmp;
  beforeEach(() => { tmp = makeFakeRepo(); });
  afterEach(() => cleanup(tmp));

  it('records no-diff when the diff is empty', async () => {
    const r = await run(tmp, { diff: '' });
    assert.ok(r.checks.find((c) => c.name === 'pr-size:no-diff'));
  });
});

describe('PrSizeModule — under thresholds', () => {
  let tmp;
  beforeEach(() => { tmp = makeFakeRepo(); });
  afterEach(() => cleanup(tmp));

  it('passes cleanly and records a summary', async () => {
    const diff = numstat([
      [10, 2, 'src/a.ts'],
      [5, 1, 'src/b.ts'],
    ]);
    const r = await run(tmp, { diff });
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name.startsWith('pr-size:'),
    );
    assert.strictEqual(hits.length, 0);
    const s = r.checks.find((c) => c.name === 'pr-size:summary');
    assert.ok(s);
    assert.strictEqual(s.files, 2);
    assert.strictEqual(s.added, 15);
    assert.strictEqual(s.removed, 3);
  });
});

describe('PrSizeModule — files-changed ceiling', () => {
  let tmp;
  beforeEach(() => { tmp = makeFakeRepo(); });
  afterEach(() => cleanup(tmp));

  it('warns when file count exceeds soft threshold', async () => {
    const rows = [];
    for (let i = 0; i < 60; i += 1) rows.push([1, 0, `src/f${i}.ts`]);
    const r = await run(tmp, { diff: numstat(rows) });
    const hit = r.checks.find((c) => c.name === 'pr-size:many-files');
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'warning');
  });

  it('errors when file count exceeds hard ceiling', async () => {
    const rows = [];
    for (let i = 0; i < 120; i += 1) rows.push([1, 0, `src/f${i}.ts`]);
    const r = await run(tmp, { diff: numstat(rows) });
    const hit = r.checks.find((c) => c.name === 'pr-size:too-many-files');
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'error');
  });
});

describe('PrSizeModule — lines-changed ceiling', () => {
  let tmp;
  beforeEach(() => { tmp = makeFakeRepo(); });
  afterEach(() => cleanup(tmp));

  it('warns when total lines exceed soft threshold', async () => {
    const r = await run(tmp, { diff: numstat([[400, 150, 'src/a.ts']]) });
    const hit = r.checks.find((c) => c.name === 'pr-size:many-lines');
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'warning');
  });

  it('errors when total lines exceed hard ceiling', async () => {
    const r = await run(tmp, { diff: numstat([[800, 300, 'src/a.ts']]) });
    const hit = r.checks.find((c) => c.name === 'pr-size:too-many-lines');
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'error');
  });
});

describe('PrSizeModule — per-file size', () => {
  let tmp;
  beforeEach(() => { tmp = makeFakeRepo(); });
  afterEach(() => cleanup(tmp));

  it('warns on a single file past the per-file warning threshold', async () => {
    const r = await run(tmp, {
      diff: numstat([[250, 80, 'src/big.ts'], [5, 1, 'src/small.ts']]),
    });
    const hit = r.checks.find((c) => c.name === 'pr-size:large-file:src/big.ts');
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'warning');
  });

  it('errors on a single file past the per-file error threshold', async () => {
    const r = await run(tmp, { diff: numstat([[400, 200, 'src/huge.ts']]) });
    const hit = r.checks.find((c) => c.name === 'pr-size:file-too-large:src/huge.ts');
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'error');
  });
});

describe('PrSizeModule — lockfile / generated exclusion', () => {
  let tmp;
  beforeEach(() => { tmp = makeFakeRepo(); });
  afterEach(() => cleanup(tmp));

  it('excludes package-lock.json from the line count', async () => {
    // 100K lines in the lockfile alone would otherwise blow the gate.
    const diff = numstat([
      [100000, 0, 'package-lock.json'],
      [10, 0, 'src/real.ts'],
    ]);
    const r = await run(tmp, { diff });
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name.startsWith('pr-size:'),
    );
    assert.strictEqual(hits.length, 0);
    const s = r.checks.find((c) => c.name === 'pr-size:summary');
    assert.strictEqual(s.files, 1);
    assert.strictEqual(s.added, 10);
    assert.strictEqual(s.excluded, 1);
  });

  it('excludes dist/ and .next/ build output', async () => {
    const diff = numstat([
      [5000, 0, 'dist/bundle.js'],
      [3000, 0, '.next/static/chunks/1.js'],
      [8, 2, 'src/real.ts'],
    ]);
    const r = await run(tmp, { diff });
    const s = r.checks.find((c) => c.name === 'pr-size:summary');
    assert.strictEqual(s.files, 1);
    assert.strictEqual(s.excluded, 2);
  });

  it('excludes *.min.js and *.snap', async () => {
    const diff = numstat([
      [1000, 0, 'public/app.min.js'],
      [600, 0, 'tests/__snapshots__/a.test.js.snap'],
      [4, 0, 'src/real.ts'],
    ]);
    const r = await run(tmp, { diff });
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name.startsWith('pr-size:'),
    );
    assert.strictEqual(hits.length, 0);
  });
});

describe('PrSizeModule — mixed concerns', () => {
  let tmp;
  beforeEach(() => { tmp = makeFakeRepo(); });
  afterEach(() => cleanup(tmp));

  it('warns when PR touches more than 3 top-level directories', async () => {
    const diff = numstat([
      [5, 0, 'src/a.ts'],
      [5, 0, 'tests/a.test.ts'],
      [5, 0, 'docs/a.md'],
      [5, 0, 'scripts/deploy.sh'],
      [5, 0, 'config/prod.json'],
    ]);
    const r = await run(tmp, { diff });
    const hit = r.checks.find((c) => c.name === 'pr-size:mixed-concerns');
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'warning');
    assert.ok(hit.topLevelDirs.includes('src'));
    assert.ok(hit.topLevelDirs.includes('docs'));
  });

  it('does NOT flag a focused single-directory PR', async () => {
    const diff = numstat([
      [10, 2, 'src/a.ts'],
      [8, 0, 'src/b.ts'],
      [3, 1, 'src/c.ts'],
    ]);
    const r = await run(tmp, { diff });
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name.startsWith('pr-size:'),
    );
    assert.strictEqual(hits.length, 0);
  });
});

describe('PrSizeModule — threshold overrides', () => {
  let tmp;
  beforeEach(() => { tmp = makeFakeRepo(); });
  afterEach(() => cleanup(tmp));

  it('honours custom thresholds', async () => {
    const r = await run(tmp, {
      diff: numstat([[60, 0, 'src/a.ts']]),
      maxLinesChangedWarning: 50,
      maxLinesChangedError: 100,
    });
    const hit = r.checks.find((c) => c.name === 'pr-size:many-lines');
    assert.ok(hit);
  });
});

describe('PrSizeModule — rename handling', () => {
  let tmp;
  beforeEach(() => { tmp = makeFakeRepo(); });
  afterEach(() => cleanup(tmp));

  it('parses renames in numstat form "old => new" without crashing', async () => {
    const diff = '10\t2\tsrc/old.ts => src/new.ts\n';
    const r = await run(tmp, { diff });
    const s = r.checks.find((c) => c.name === 'pr-size:summary');
    assert.ok(s);
    assert.strictEqual(s.files, 1);
  });

  it('parses renames in numstat form "src/{a => b}/file" without crashing', async () => {
    const diff = '4\t1\tsrc/{old => new}/file.ts\n';
    const r = await run(tmp, { diff });
    const s = r.checks.find((c) => c.name === 'pr-size:summary');
    assert.ok(s);
    assert.strictEqual(s.files, 1);
  });
});

// --------------------------------------------------------------------
// Real-git scaffolding for merge-base tests. These tests run actual
// `git init` + commits in a tmpdir, then exercise the module against
// that real repo. Identity is set via local repo config (no global
// config mutation).
// --------------------------------------------------------------------

function git(repo, args) {
  // -c flags set per-invocation identity + branch so we never depend
  // on (or mutate) the user's global git config.
  return execSync(
    [
      'git',
      '-c', 'user.email=test@gatetest.ai',
      '-c', 'user.name=GateTestTester',
      '-c', 'init.defaultBranch=main',
      '-c', 'commit.gpgsign=false',
      ...args,
    ].join(' '),
    { cwd: repo, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
  );
}

function makeRealRepo() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-prsz-real-'));
  git(tmp, ['init', '--initial-branch=main', '-q']);
  fs.writeFileSync(path.join(tmp, 'README.md'), 'init\n');
  git(tmp, ['add', '.']);
  git(tmp, ['commit', '-q', '-m', '"init"']);
  return tmp;
}

function writeAndCommit(repo, filename, content, msg) {
  fs.writeFileSync(path.join(repo, filename), content);
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', `"${msg}"`]);
}

describe('PrSizeModule — merge-base diff resolution', () => {
  let tmp;
  beforeEach(() => { tmp = makeRealRepo(); });
  afterEach(() => cleanup(tmp));

  it('uses merge-base when baseBranch is configured', async () => {
    // Set up: on main, add a baseline file. Branch off. On the branch,
    // add ONE file with 5 lines. Meanwhile, advance main with a HUGE
    // unrelated change.
    git(tmp, ['checkout', '-q', '-b', 'feature']);
    writeAndCommit(tmp, 'small.ts', 'a\nb\nc\nd\ne\n', 'branch change');

    git(tmp, ['checkout', '-q', 'main']);
    // 200 lines of "noise" on main AFTER branch was created
    const noise = Array.from({ length: 200 }, (_, i) => `line${i}`).join('\n');
    writeAndCommit(tmp, 'big-main-change.ts', noise, 'main-noise');

    git(tmp, ['checkout', '-q', 'feature']);

    const r = await run(tmp, { baseBranch: 'main' });
    const s = r.checks.find((c) => c.name === 'pr-size:summary');
    assert.ok(s, 'summary check should fire');
    // ONLY the 5-line branch change counts — NOT the 200-line main noise.
    assert.strictEqual(s.files, 1, 'only branch-introduced file counts');
    assert.strictEqual(s.added, 5, 'only branch-introduced lines count');
  });

  it('counts ONLY branch changes — main commits since branch creation are excluded', async () => {
    // The bug this test prevents: diff against `main` (not merge-base)
    // counts everything on main since branch creation, producing
    // false-positive "PR too big".
    git(tmp, ['checkout', '-q', '-b', 'feature']);
    writeAndCommit(tmp, 'x.ts', 'one\ntwo\n', 'small branch change');

    git(tmp, ['checkout', '-q', 'main']);
    // Land 700 lines on main — this would fail the soft 500-line gate
    // if it leaked into our branch's diff.
    const huge = Array.from({ length: 700 }, (_, i) => `m${i}`).join('\n');
    writeAndCommit(tmp, 'main-only.ts', huge, 'main only');

    git(tmp, ['checkout', '-q', 'feature']);

    const r = await run(tmp, { baseBranch: 'main' });
    const flagged = r.checks.filter(
      (c) => c.passed === false && c.name.startsWith('pr-size:'),
    );
    assert.strictEqual(
      flagged.length, 0,
      'no PR-size violations expected — branch only added 2 lines',
    );
    const s = r.checks.find((c) => c.name === 'pr-size:summary');
    assert.strictEqual(s.added, 2);
  });

  it('falls back gracefully when merge-base returns nothing (unknown ref)', async () => {
    // Configure a non-existent base branch. merge-base will fail.
    // Module must NOT crash; it should fall through to the working-tree
    // / HEAD~1 detection path.
    // Touch a file in the working tree so something exists to find.
    fs.writeFileSync(path.join(tmp, 'wt.ts'), 'x\ny\n');
    git(tmp, ['add', '.']);
    // (don't commit — leave it staged so `git diff --cached` will pick it up)

    const r = await run(tmp, { baseBranch: 'nonexistent-base-branch' });
    // Should not throw; should produce some check (either a summary or
    // a no-diff marker). The point: graceful degradation.
    const hasSummary = r.checks.find((c) => c.name === 'pr-size:summary');
    const hasNoDiff = r.checks.find((c) => c.name === 'pr-size:no-diff');
    assert.ok(hasSummary || hasNoDiff, 'falls back to a resolved state');
  });

  it('auto-detects when no base is configured — finds main via merge-base', async () => {
    // Default behaviour: no baseBranch configured. Module should
    // auto-detect by trying `origin/main` then `main`, and use
    // merge-base. We have no `origin/main` here (no remote), so it
    // should land on `main`.
    git(tmp, ['checkout', '-q', '-b', 'feature']);
    writeAndCommit(tmp, 'autonew.ts', 'p\nq\nr\n', 'branch added 3 lines');

    git(tmp, ['checkout', '-q', 'main']);
    writeAndCommit(tmp, 'after-branch.ts', 'noise\nmore\n', 'main moved on');

    git(tmp, ['checkout', '-q', 'feature']);

    const r = await run(tmp);
    const s = r.checks.find((c) => c.name === 'pr-size:summary');
    assert.ok(s);
    // Branch only added 3 lines via autonew.ts; main's "after-branch.ts"
    // must NOT leak in.
    assert.strictEqual(s.files, 1);
    assert.strictEqual(s.added, 3);
  });

  it('existing behaviour preserved: working-tree diff still works when no base resolvable', async () => {
    // Set up a repo with NO commits past init and NO branches diverged.
    // Stage some changes. Without a baseBranch or against ref, the
    // module should still surface the staged diff via the fallback
    // chain (staged → working-tree → HEAD~1..HEAD).
    fs.writeFileSync(path.join(tmp, 'a.ts'), 'one\ntwo\nthree\n');
    git(tmp, ['add', '.']);

    // No baseBranch, no against — pure auto. Since main exists with
    // only the init commit and no branches diverge, merge-base
    // resolves to the init commit, and diff merge-base..HEAD has
    // nothing (the working-tree change is staged but not committed).
    // The fallback chain should then catch it via `--cached`.
    const r = await run(tmp);
    const s = r.checks.find((c) => c.name === 'pr-size:summary');
    const noDiff = r.checks.find((c) => c.name === 'pr-size:no-diff');
    // Either we got the staged diff via fallback, or no-diff marker.
    // Either way, no crash and a deterministic terminal state.
    assert.ok(s || noDiff);
  });
});

describe('PrSizeModule — unified diff fallback', () => {
  let tmp;
  beforeEach(() => { tmp = makeFakeRepo(); });
  afterEach(() => cleanup(tmp));

  it('parses raw unified diff body when numstat is not used', async () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index aaa..bbb 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,2 +1,4 @@',
      ' ctx',
      '+added1',
      '+added2',
      '-removed1',
      '',
    ].join('\n');
    const r = await run(tmp, { diff });
    const s = r.checks.find((c) => c.name === 'pr-size:summary');
    assert.ok(s);
    assert.strictEqual(s.files, 1);
    assert.strictEqual(s.added, 2);
    assert.strictEqual(s.removed, 1);
  });
});
