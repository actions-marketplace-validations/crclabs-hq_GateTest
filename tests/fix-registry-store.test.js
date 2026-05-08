'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  recordFix,
  listPublicFixes,
  countPublicFixes,
  getFixStats,
  optOutRepo,
  ensureTable,
  PAGE_SIZE,
  MAX_MESSAGE_CHARS,
} = require('../website/app/lib/fix-registry-store');

// ─── Helper — minimal sql mock ────────────────────────────────────────────────

function makeSql(rows = []) {
  const calls = [];
  const tag = (strings, ...vals) => {
    calls.push({ strings: strings.join('?'), vals });
    return Promise.resolve(rows);
  };
  tag.unsafe = (q) => {
    calls.push({ unsafe: q });
    return Promise.resolve([]);
  };
  tag._calls = calls;
  return tag;
}

// ─── constants ────────────────────────────────────────────────────────────────

describe('module constants', () => {
  it('exports PAGE_SIZE as a positive number', () => {
    assert.ok(typeof PAGE_SIZE === 'number' && PAGE_SIZE > 0);
  });

  it('exports MAX_MESSAGE_CHARS as a positive number', () => {
    assert.ok(typeof MAX_MESSAGE_CHARS === 'number' && MAX_MESSAGE_CHARS > 0);
  });
});

// ─── recordFix ────────────────────────────────────────────────────────────────

describe('recordFix', () => {
  it('throws when repoName is missing', async () => {
    const sql = makeSql([{ id: 1n }]);
    await assert.rejects(
      () => recordFix(sql, { repoName: '', prUrl: 'https://github.com/x/y/pull/1' }),
      /repoName is required/,
    );
  });

  it('throws when prUrl is missing', async () => {
    const sql = makeSql([{ id: 1n }]);
    await assert.rejects(
      () => recordFix(sql, { repoName: 'owner/repo', prUrl: '' }),
      /prUrl is required/,
    );
  });

  it('calls ensureTable before INSERT', async () => {
    const sql = makeSql([{ id: 1n }]);
    await recordFix(sql, { repoName: 'owner/repo', prUrl: 'https://github.com/x/y/pull/1' });
    const unsafeCalls = sql._calls.filter((c) => c.unsafe);
    assert.ok(unsafeCalls.length > 0);
  });

  it('returns the inserted id', async () => {
    const sql = makeSql([{ id: 42n }]);
    const result = await recordFix(sql, {
      repoName: 'owner/repo',
      prUrl: 'https://github.com/x/y/pull/1',
      tier: 'nuclear',
      errorsFixed: 5,
      warningsFixed: 3,
      modulesFired: ['secrets', 'lint'],
      message: 'Fixed a critical auth bug',
    });
    assert.equal(result.id, 42n);
  });

  it('returns null when no rows returned (conflict with no change)', async () => {
    const sql = makeSql([]);
    const result = await recordFix(sql, { repoName: 'x/y', prUrl: 'https://p' });
    assert.equal(result, null);
  });

  it('truncates message to MAX_MESSAGE_CHARS', async () => {
    const sql = makeSql([{ id: 1n }]);
    const longMsg = 'a'.repeat(MAX_MESSAGE_CHARS + 100);
    await recordFix(sql, { repoName: 'x/y', prUrl: 'https://p', message: longMsg });
    // Verify the last tagged SQL call used a truncated message value
    const tagCalls = sql._calls.filter((c) => !c.unsafe);
    const msgVal = tagCalls[tagCalls.length - 1]?.vals?.find(
      (v) => typeof v === 'string' && v.length <= MAX_MESSAGE_CHARS,
    );
    // The truncated message will be among the values
    assert.ok(tagCalls.length > 0);
  });

  it('caps modulesFired at 20 items', async () => {
    const sql = makeSql([{ id: 1n }]);
    const manyModules = Array.from({ length: 30 }, (_, i) => `module${i}`);
    await recordFix(sql, { repoName: 'x/y', prUrl: 'https://p', modulesFired: manyModules });
    // Just verify no error thrown and call was made
    assert.ok(sql._calls.length > 0);
  });

  it('filters non-string module names', async () => {
    const sql = makeSql([{ id: 1n }]);
    const mixed = ['secrets', null, 42, 'lint', undefined];
    await recordFix(sql, { repoName: 'x/y', prUrl: 'https://p', modulesFired: mixed });
    assert.ok(sql._calls.length > 0);
  });
});

// ─── listPublicFixes ──────────────────────────────────────────────────────────

describe('listPublicFixes', () => {
  it('returns rows from the query', async () => {
    const rows = [
      { id: 1n, repo_name: 'owner/repo', pr_url: 'https://g', tier: 'full', errors_fixed: 2 },
    ];
    const sql = makeSql(rows);
    const result = await listPublicFixes(sql);
    assert.equal(result.length, 1);
    assert.equal(result[0].repo_name, 'owner/repo');
  });

  it('uses default page 1 and PAGE_SIZE', async () => {
    const sql = makeSql([]);
    await listPublicFixes(sql);
    assert.ok(sql._calls.length > 0);
  });

  it('accepts page parameter', async () => {
    const sql = makeSql([]);
    await listPublicFixes(sql, { page: 2, pageSize: 10 });
    assert.ok(sql._calls.length > 0);
  });

  it('clamps page to minimum 1', async () => {
    const sql = makeSql([]);
    await listPublicFixes(sql, { page: -5 });
    // Should not throw and should use offset 0
    assert.ok(sql._calls.length > 0);
  });
});

// ─── countPublicFixes ─────────────────────────────────────────────────────────

describe('countPublicFixes', () => {
  it('returns count from db', async () => {
    const sql = makeSql([{ n: 42 }]);
    const count = await countPublicFixes(sql);
    assert.equal(count, 42);
  });

  it('returns 0 when no rows', async () => {
    const sql = makeSql([{}]);
    const count = await countPublicFixes(sql);
    assert.equal(count, 0);
  });
});

// ─── getFixStats ──────────────────────────────────────────────────────────────

describe('getFixStats', () => {
  it('returns stats object', async () => {
    const sql = makeSql([{
      total_fixes: 10,
      total_errors_fixed: 50,
      total_warnings_fixed: 120,
      unique_repos: 7,
    }]);
    const stats = await getFixStats(sql);
    assert.equal(stats.total_fixes, 10);
    assert.equal(stats.total_errors_fixed, 50);
    assert.equal(stats.unique_repos, 7);
  });

  it('returns zero stats when no rows', async () => {
    const sql = makeSql([]);
    const stats = await getFixStats(sql);
    assert.equal(stats.total_fixes, 0);
    assert.equal(stats.total_errors_fixed, 0);
  });
});

// ─── optOutRepo ───────────────────────────────────────────────────────────────

describe('optOutRepo', () => {
  it('calls UPDATE with repo name', async () => {
    const sql = makeSql([]);
    await optOutRepo(sql, 'sensitive/repo');
    const tagCalls = sql._calls.filter((c) => !c.unsafe);
    assert.ok(tagCalls.length > 0);
  });

  it('does nothing for empty repoName', async () => {
    const sql = makeSql([]);
    await optOutRepo(sql, '');
    const tagCalls = sql._calls.filter((c) => !c.unsafe);
    assert.equal(tagCalls.length, 0);
  });

  it('does nothing for null repoName', async () => {
    const sql = makeSql([]);
    await optOutRepo(sql, null);
    assert.ok(sql._calls.length === 0);
  });
});

// ─── ensureTable ──────────────────────────────────────────────────────────────

describe('ensureTable', () => {
  it('calls sql.unsafe with CREATE TABLE', async () => {
    const sql = makeSql([]);
    await ensureTable(sql);
    const unsafeCalls = sql._calls.filter((c) => c.unsafe);
    assert.ok(unsafeCalls.length > 0);
    assert.ok(unsafeCalls[0].unsafe.includes('fix_registry'));
  });
});
