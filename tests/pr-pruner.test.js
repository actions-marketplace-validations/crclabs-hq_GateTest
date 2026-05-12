'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { PrPruner } = require('../src/core/pr-pruner');

// ─── helpers ─────────────────────────────────────────────────────────────────

function makePruner(overrides = {}) {
  return new PrPruner({ token: 'test-token', dryRun: true, ...overrides });
}

function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

// ─── constructor ──────────────────────────────────────────────────────────────

describe('PrPruner — constructor', () => {
  it('defaults to gatetest/ and claude/ patterns', () => {
    const p = makePruner();
    assert.deepStrictEqual(p.patterns, ['gatetest/', 'claude/']);
  });

  it('accepts custom patterns', () => {
    const p = makePruner({ patterns: ['fix/', 'bot/'] });
    assert.deepStrictEqual(p.patterns, ['fix/', 'bot/']);
  });

  it('defaults staledays to 7', () => {
    const p = makePruner();
    assert.strictEqual(p.staledays, 7);
  });

  it('defaults dryRun to false when not set', () => {
    const p = new PrPruner({ token: 'x' });
    assert.strictEqual(p.dryRun, false);
  });
});

// ─── _ageInDays ───────────────────────────────────────────────────────────────

describe('PrPruner — _ageInDays', () => {
  it('returns 0 for now', () => {
    const p = makePruner();
    assert.strictEqual(p._ageInDays(new Date().toISOString()), 0);
  });

  it('returns correct days for past date', () => {
    const p = makePruner();
    const age = p._ageInDays(daysAgo(10));
    assert.ok(age >= 9 && age <= 11, `expected ~10, got ${age}`);
  });
});

// ─── _processBranch — dry-run with mock API ───────────────────────────────────

describe('PrPruner — _processBranch dry-run', () => {
  function makePrunerWithMocks(findPRs, getCommit) {
    const p = makePruner({ staleDays: 7 });
    p._findPRsForBranch = findPRs;
    p._getCommit = getCommit;
    p._deleteBranch = async (owner, repo, branch, report, reason) => {
      report.deletedBranches.push({ branch, reason, dryRun: true });
    };
    p._closePR = async (owner, repo, number, report) => {
      report.closedPRs.push({ number, dryRun: true });
    };
    return p;
  }

  it('deletes branch with merged PR immediately', async () => {
    const p = makePrunerWithMocks(
      async () => [{ state: 'closed', number: 5, updated_at: daysAgo(20) }],
      async () => ({})
    );
    const report = { deletedBranches: [], closedPRs: [], skipped: [], errors: [] };
    const branch = { name: 'claude/old-fix', commit: { sha: 'abc' } };
    await p._processBranch('owner', 'repo', branch, report);
    assert.strictEqual(report.deletedBranches.length, 1);
    assert.strictEqual(report.deletedBranches[0].branch, 'claude/old-fix');
    assert.strictEqual(report.deletedBranches[0].reason, 'pr-closed');
  });

  it('skips open PR that is fresh (under stale threshold)', async () => {
    const p = makePrunerWithMocks(
      async () => [{ state: 'open', number: 3, updated_at: daysAgo(2) }],
      async () => ({})
    );
    const report = { deletedBranches: [], closedPRs: [], skipped: [], errors: [] };
    await p._processBranch('owner', 'repo', { name: 'gatetest/fresh', commit: { sha: 'abc' } }, report);
    assert.strictEqual(report.deletedBranches.length, 0);
    assert.strictEqual(report.skipped.length, 1);
    assert.match(report.skipped[0].reason, /only 2d old/);
  });

  it('closes and deletes stale open PR branch', async () => {
    const p = makePrunerWithMocks(
      async () => [{ state: 'open', number: 7, updated_at: daysAgo(14) }],
      async () => ({})
    );
    const report = { deletedBranches: [], closedPRs: [], skipped: [], errors: [] };
    await p._processBranch('owner', 'repo', { name: 'claude/stale', commit: { sha: 'abc' } }, report);
    assert.strictEqual(report.closedPRs.length, 1);
    assert.strictEqual(report.closedPRs[0].number, 7);
    assert.strictEqual(report.deletedBranches.length, 1);
  });

  it('deletes orphan branch (no PR) older than stale threshold', async () => {
    const p = makePrunerWithMocks(
      async () => [],
      async () => ({ commit: { committer: { date: daysAgo(10) } } })
    );
    const report = { deletedBranches: [], closedPRs: [], skipped: [], errors: [] };
    await p._processBranch('owner', 'repo', { name: 'gatetest/orphan', commit: { sha: 'abc' } }, report);
    assert.strictEqual(report.deletedBranches.length, 1);
    assert.strictEqual(report.deletedBranches[0].reason, 'no-pr');
  });

  it('skips orphan branch that is fresh', async () => {
    const p = makePrunerWithMocks(
      async () => [],
      async () => ({ commit: { committer: { date: daysAgo(3) } } })
    );
    const report = { deletedBranches: [], closedPRs: [], skipped: [], errors: [] };
    await p._processBranch('owner', 'repo', { name: 'gatetest/new', commit: { sha: 'abc' } }, report);
    assert.strictEqual(report.deletedBranches.length, 0);
    assert.strictEqual(report.skipped.length, 1);
  });
});

// ─── prune — branch filtering ─────────────────────────────────────────────────

describe('PrPruner — pattern filtering', () => {
  it('only processes branches matching patterns', async () => {
    const p = makePruner({ patterns: ['claude/'] });
    const processed = [];
    p._listBranches = async () => [
      { name: 'main', commit: { sha: 'a' } },
      { name: 'claude/fix-1', commit: { sha: 'b' } },
      { name: 'feature/foo', commit: { sha: 'c' } },
      { name: 'claude/fix-2', commit: { sha: 'd' } },
    ];
    p._processBranch = async (owner, repo, branch, report) => {
      processed.push(branch.name);
    };

    await p.prune('o', 'r');
    assert.deepStrictEqual(processed, ['claude/fix-1', 'claude/fix-2']);
  });

  it('catches per-branch errors and continues', async () => {
    const p = makePruner();
    p._listBranches = async () => [
      { name: 'claude/a', commit: { sha: 'a' } },
      { name: 'claude/b', commit: { sha: 'b' } },
    ];
    let calls = 0;
    p._processBranch = async (owner, repo, branch, report) => {
      calls++;
      if (branch.name === 'claude/a') throw new Error('API down');
    };

    const report = await p.prune('o', 'r');
    assert.strictEqual(calls, 2, 'should attempt both branches');
    assert.strictEqual(report.errors.length, 1);
    assert.strictEqual(report.errors[0].branch, 'claude/a');
  });
});
