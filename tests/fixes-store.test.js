/**
 * Tests for website/app/lib/fixes-store.js
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { ensureFixesTable, recordFix, listFixes, getFixStats, PAGE_SIZE } = require('../website/app/lib/fixes-store');

// ---------------------------------------------------------------------------
// Fake-sql factory — records every call for assertion.
// ---------------------------------------------------------------------------
function makeFakeSql(rowsByQuery = {}) {
  const calls = [];
  const fn = async function sql(strings, ...values) {
    const query = Array.isArray(strings) ? strings.join('?') : String(strings);
    calls.push({ query, values });
    // Return specific rows if configured
    for (const [pattern, rows] of Object.entries(rowsByQuery)) {
      if (query.includes(pattern)) return rows;
    }
    return [];
  };
  // Make it callable as a tagged-template (sql`...`) and record calls
  fn.calls = calls;
  return fn;
}

// ---------------------------------------------------------------------------
describe('ensureFixesTable', () => {
  test('creates the fixes_log table and indexes', async () => {
    const sql = makeFakeSql();
    await ensureFixesTable(sql);
    const queries = sql.calls.map(c => c.query);
    assert.ok(queries.some(q => q.includes('CREATE TABLE IF NOT EXISTS fixes_log')));
    assert.ok(queries.some(q => q.includes('idx_fixes_log_created')));
    assert.ok(queries.some(q => q.includes('idx_fixes_log_repo')));
    assert.ok(queries.some(q => q.includes('idx_fixes_log_tier')));
  });

  test('throws if sql is not a function', async () => {
    await assert.rejects(() => ensureFixesTable(null), /sql is required/);
  });
});

// ---------------------------------------------------------------------------
describe('recordFix', () => {
  test('inserts a row and returns id + created_at', async () => {
    const sql = makeFakeSql({
      'INSERT INTO fixes_log': [{ id: 'abc123', created_at: new Date() }],
    });
    const result = await recordFix({
      sql,
      repoName: 'owner/repo',
      prUrl: 'https://github.com/owner/repo/pull/1',
    });
    assert.equal(result.id, 'abc123');
  });

  test('passes all fields through to SQL', async () => {
    const sql = makeFakeSql({ 'INSERT INTO fixes_log': [{ id: 'x', created_at: new Date() }] });
    await recordFix({
      sql,
      repoName: 'a/b',
      prUrl: 'https://github.com/a/b/pull/2',
      tier: 'nuclear',
      errorsFixed: 5,
      warningsFixed: 10,
      modulesFired: ['lint', 'secrets'],
      message: 'Fixed 2 files',
    });
    const insert = sql.calls.find(c => c.query.includes('INSERT'));
    assert.ok(insert);
    assert.deepEqual(insert.values, ['a/b', 'https://github.com/a/b/pull/2', 'nuclear', 5, 10, ['lint', 'secrets'], 'Fixed 2 files']);
  });

  test('truncates message to 500 chars', async () => {
    const sql = makeFakeSql({ 'INSERT INTO fixes_log': [{ id: 'y', created_at: new Date() }] });
    const longMsg = 'x'.repeat(600);
    await recordFix({ sql, repoName: 'a/b', prUrl: 'https://github.com/a/b/pull/3', message: longMsg });
    const insert = sql.calls.find(c => c.query.includes('INSERT'));
    const msgValue = insert.values[insert.values.length - 1];
    assert.equal(msgValue.length, 500);
  });

  test('coerces negative errorsFixed to 0', async () => {
    const sql = makeFakeSql({ 'INSERT INTO fixes_log': [{ id: 'z', created_at: new Date() }] });
    await recordFix({ sql, repoName: 'a/b', prUrl: 'https://github.com/a/b/pull/4', errorsFixed: -5 });
    const insert = sql.calls.find(c => c.query.includes('INSERT'));
    assert.equal(insert.values[3], 0);
  });

  test('throws without repoName', async () => {
    const sql = makeFakeSql({ 'INSERT INTO fixes_log': [] });
    await assert.rejects(() => recordFix({ sql, prUrl: 'https://github.com/a/b/pull/1' }), /repoName/);
  });

  test('throws without prUrl', async () => {
    const sql = makeFakeSql({ 'INSERT INTO fixes_log': [] });
    await assert.rejects(() => recordFix({ sql, repoName: 'a/b' }), /prUrl/);
  });

  test('throws if sql is not a function', async () => {
    await assert.rejects(() => recordFix({ sql: null, repoName: 'a/b', prUrl: 'x' }), /sql is required/);
  });
});

// ---------------------------------------------------------------------------
describe('listFixes', () => {
  const sampleFix = {
    id: 'f1',
    created_at: new Date(),
    repo_name: 'a/b',
    pr_url: 'https://github.com/a/b/pull/1',
    tier: 'full',
    errors_fixed: 2,
    warnings_fixed: 3,
    modules_fired: ['lint'],
    message: null,
  };

  test('returns fixes + pagination on page 1', async () => {
    const sql = makeFakeSql({
      'SELECT id, created_at': [sampleFix],
      'COUNT': [{ total: 1 }],
    });
    const result = await listFixes({ sql, page: 1 });
    assert.equal(result.pagination.page, 1);
    assert.equal(result.pagination.total, 1);
    assert.equal(result.pagination.totalPages, 1);
    assert.equal(result.fixes.length, 1);
  });

  test('computes totalPages correctly', async () => {
    const sql = makeFakeSql({
      'SELECT id, created_at': [],
      'COUNT': [{ total: 175 }],
    });
    const result = await listFixes({ sql });
    assert.equal(result.pagination.totalPages, Math.ceil(175 / PAGE_SIZE));
  });

  test('defaults to page 1 when not specified', async () => {
    const sql = makeFakeSql({
      'SELECT id, created_at': [],
      'COUNT': [{ total: 0 }],
    });
    const result = await listFixes({ sql });
    assert.equal(result.pagination.page, 1);
  });

  test('throws if sql is not a function', async () => {
    await assert.rejects(() => listFixes({ sql: null }), /sql is required/);
  });
});

// ---------------------------------------------------------------------------
describe('getFixStats', () => {
  test('returns aggregate counts', async () => {
    const sql = makeFakeSql({
      'SELECT': [{ total_fixes: 42, total_errors_fixed: 100, total_warnings_fixed: 200, unique_repos: 15 }],
    });
    const stats = await getFixStats({ sql });
    assert.equal(stats.total_fixes, 42);
    assert.equal(stats.unique_repos, 15);
  });

  test('returns zero-object when table is empty', async () => {
    const sql = makeFakeSql({ 'SELECT': [{}] });
    const stats = await getFixStats({ sql });
    assert.equal(stats.total_fixes ?? 0, 0);
  });

  test('throws if sql is not a function', async () => {
    await assert.rejects(() => getFixStats({ sql: 42 }), /sql is required/);
  });
});

// ---------------------------------------------------------------------------
describe('PAGE_SIZE', () => {
  test('is a positive integer', () => {
    assert.ok(Number.isInteger(PAGE_SIZE));
    assert.ok(PAGE_SIZE > 0);
  });
});
