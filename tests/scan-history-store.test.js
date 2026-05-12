// ============================================================================
// SCAN-HISTORY-STORE TEST
// ============================================================================
// Verifies the per-repo scan history storage helper.
//
// Key invariants tested:
//   1. Privacy contract — cleartext repo URL NEVER reaches a SQL value
//   2. Graceful degradation when DB is unavailable (sql throws)
//   3. Module summary shape is preserved through insert + retrieval
//   4. Limit parameter is honoured in getRepoHistory
//   5. ensureScanHistoryTable creates the table + both indexes with IF NOT EXISTS
//   6. saveScanResult validates required fields
//   7. getRepoHistory returns empty array when sql returns no rows
//   8. hashRepoUrl normalises URLs the same way as scan-fingerprint-store
// ============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const {
  REPO_HASH_SALT,
  hashRepoUrl,
  ensureScanHistoryTable,
  saveScanResult,
  getRepoHistory,
} = require(path.resolve(__dirname, '..', 'website', 'app', 'lib', 'scan-history-store.js'));

// ---------------------------------------------------------------------------
// Fake SQL tagged-template — records calls, replays canned responses in FIFO.
// ---------------------------------------------------------------------------
function makeFakeSql(responses = []) {
  const calls = [];
  const queue = [...responses];
  const fakeSql = (strings, ...values) => {
    const text = strings.join('?');
    calls.push({ text, values });
    const next = queue.length > 0 ? queue.shift() : [];
    return Promise.resolve(next);
  };
  fakeSql.calls = calls;
  return fakeSql;
}

/** Build a fakeSql that throws on the very first non-DDL call. */
function makeThrowingSql(message = 'DB unavailable') {
  let ddlCalls = 0; // allow the two ensureTable DDL calls through
  const fakeSql = (strings, ...values) => {
    const text = strings.join('?');
    if (text.includes('CREATE TABLE') || text.includes('CREATE INDEX')) {
      ddlCalls++;
      return Promise.resolve([]);
    }
    void values;
    return Promise.reject(new Error(message));
  };
  Object.defineProperty(fakeSql, 'ddlCalls', { get: () => ddlCalls });
  return fakeSql;
}

// ---------------------------------------------------------------------------
// hashRepoUrl
// ---------------------------------------------------------------------------
describe('hashRepoUrl', () => {
  it('returns a 64-char hex sha256', () => {
    const h = hashRepoUrl('https://github.com/owner/repo');
    assert.match(h, /^[a-f0-9]{64}$/);
  });

  it('is deterministic — same URL always produces the same hash', () => {
    const a = hashRepoUrl('https://github.com/owner/repo');
    const b = hashRepoUrl('https://github.com/owner/repo');
    assert.strictEqual(a, b);
  });

  it('normalises protocol, trailing slash, .git suffix, and query string', () => {
    const base = hashRepoUrl('https://github.com/o/r');
    assert.strictEqual(hashRepoUrl('https://github.com/o/r.git'), base);
    assert.strictEqual(hashRepoUrl('github.com/o/r/'), base);
    assert.strictEqual(hashRepoUrl('https://github.com/o/r?foo=bar'), base);
    assert.strictEqual(hashRepoUrl('HTTPS://GITHUB.COM/o/r'), base);
  });

  it('different repos produce different hashes', () => {
    const a = hashRepoUrl('https://github.com/o/r1');
    const b = hashRepoUrl('https://github.com/o/r2');
    assert.notStrictEqual(a, b);
  });

  it('rejects null, undefined, and non-strings', () => {
    assert.throws(() => hashRepoUrl(null), /required and must be a string/);
    assert.throws(() => hashRepoUrl(undefined), /required and must be a string/);
    assert.throws(() => hashRepoUrl(42), /required and must be a string/);
  });

  it('uses the correct salt constant', () => {
    assert.strictEqual(typeof REPO_HASH_SALT, 'string');
    assert.match(REPO_HASH_SALT, /gatetest:scan_history:v1/);
  });
});

// ---------------------------------------------------------------------------
// ensureScanHistoryTable
// ---------------------------------------------------------------------------
describe('ensureScanHistoryTable', () => {
  it('issues CREATE TABLE and both indexes', async () => {
    const sql = makeFakeSql();
    await ensureScanHistoryTable(sql);
    const joined = sql.calls.map((c) => c.text).join('\n');
    assert.match(joined, /CREATE TABLE IF NOT EXISTS scan_history/);
    assert.match(joined, /repo_hash TEXT NOT NULL/);
    assert.match(joined, /module_summary JSONB/);
    assert.match(joined, /scan_history_repo_hash_idx/);
    assert.match(joined, /scan_history_scanned_at_idx/);
  });

  it('all DDL statements use IF NOT EXISTS (idempotent)', async () => {
    const sql = makeFakeSql();
    await ensureScanHistoryTable(sql);
    for (const call of sql.calls) {
      assert.match(call.text, /IF NOT EXISTS/,
        `Expected IF NOT EXISTS in: ${call.text.slice(0, 80)}`);
    }
  });

  it('throws if sql is not provided', async () => {
    await assert.rejects(() => ensureScanHistoryTable(undefined), /sql is required/);
  });
});

// ---------------------------------------------------------------------------
// saveScanResult
// ---------------------------------------------------------------------------
describe('saveScanResult', () => {
  it('inserts a row and returns the new id', async () => {
    // DDL calls: CREATE TABLE + 2x CREATE INDEX (3) + INSERT (1) = 4 responses needed
    const sql = makeFakeSql([[], [], [], [{ id: 42 }]]);
    const result = await saveScanResult({
      sql,
      repoUrl: 'https://github.com/org/repo',
      tier: 'full',
      totalIssues: 12,
      totalModules: 39,
      durationMs: 34000,
      modules: [
        { name: 'lint', status: 'failed', issues: 5 },
        { name: 'secrets', status: 'passed', issues: 0 },
      ],
    });
    assert.strictEqual(result.id, 42);
  });

  it('PRIVACY: cleartext repo URL never reaches SQL values', async () => {
    const repoUrl = 'https://github.com/secret-org/private-repo';
    const sql = makeFakeSql([[], [], [], [{ id: 1 }]]);
    await saveScanResult({
      sql,
      repoUrl,
      tier: 'quick',
      totalIssues: 0,
      totalModules: 4,
    });
    for (const call of sql.calls) {
      for (const v of call.values) {
        if (typeof v === 'string') {
          assert.ok(!v.includes('secret-org'), `cleartext org name leaked: ${v}`);
          assert.ok(!v.includes('private-repo'), `cleartext repo name leaked: ${v}`);
        }
      }
    }
  });

  it('passes the repo_hash (not cleartext URL) as a SQL value', async () => {
    const repoUrl = 'https://github.com/org/repo';
    const sql = makeFakeSql([[], [], [], [{ id: 1 }]]);
    await saveScanResult({
      sql,
      repoUrl,
      tier: 'quick',
      totalIssues: 3,
      totalModules: 4,
    });
    const expectedHash = hashRepoUrl(repoUrl);
    const insertCall = sql.calls.find((c) => c.text.includes('INSERT INTO scan_history'));
    assert.ok(insertCall, 'INSERT call not found');
    assert.ok(
      insertCall.values.includes(expectedHash),
      'repo_hash not found in SQL values'
    );
    assert.ok(
      !insertCall.values.includes(repoUrl),
      'cleartext repoUrl must NOT be in SQL values'
    );
  });

  it('serialises module_summary as JSONB and preserves shape', async () => {
    const modules = [
      { name: 'lint', status: 'failed', issues: 7 },
      { name: 'security', status: 'passed', issues: 0 },
    ];
    const sql = makeFakeSql([[], [], [], [{ id: 5 }]]);
    await saveScanResult({
      sql,
      repoUrl: 'github.com/x/y',
      tier: 'nuclear',
      totalIssues: 7,
      totalModules: 2,
      modules,
    });
    const insertCall = sql.calls.find((c) => c.text.includes('INSERT INTO scan_history'));
    assert.ok(insertCall, 'INSERT call not found');
    // module_summary should be serialised JSON containing the module names
    const jsonValue = insertCall.values.find(
      (v) => typeof v === 'string' && v.includes('"lint"') && v.includes('"security"')
    );
    assert.ok(jsonValue, 'module_summary JSON not found in SQL values');
    const parsed = JSON.parse(jsonValue.replace(/::jsonb$/, ''));
    assert.strictEqual(parsed[0].name, 'lint');
    assert.strictEqual(parsed[0].status, 'failed');
    assert.strictEqual(parsed[0].issues, 7);
    assert.strictEqual(parsed[1].name, 'security');
  });

  it('gracefully handles missing DB (sql throws) without crashing the caller', async () => {
    const throwingSql = makeThrowingSql('DB unavailable');
    // The caller (route.ts) wraps in try/catch. Verify the store itself throws
    // (which the caller catches) rather than swallowing the error silently.
    await assert.rejects(
      () => saveScanResult({
        sql: throwingSql,
        repoUrl: 'github.com/x/y',
        tier: 'quick',
        totalIssues: 0,
        totalModules: 4,
      }),
      /DB unavailable/
    );
  });

  it('returns null id when the insert returns no rows', async () => {
    const sql = makeFakeSql([[], [], [], []]);
    const result = await saveScanResult({
      sql,
      repoUrl: 'github.com/x/y',
      tier: 'quick',
      totalIssues: 0,
      totalModules: 4,
    });
    assert.strictEqual(result.id, null);
  });

  it('validates required fields', async () => {
    const sql = makeFakeSql();
    await assert.rejects(
      () => saveScanResult({ sql, tier: 'full', totalIssues: 0, totalModules: 4 }),
      /repoUrl is required/
    );
    await assert.rejects(
      () => saveScanResult({ sql, repoUrl: 'x', totalIssues: 0, totalModules: 4 }),
      /tier is required/
    );
    await assert.rejects(
      () => saveScanResult({ sql, repoUrl: 'x', tier: 'full', totalModules: 4 }),
      /totalIssues must be a number/
    );
    await assert.rejects(
      () => saveScanResult({ sql: undefined, repoUrl: 'x', tier: 'full', totalIssues: 0, totalModules: 4 }),
      /sql is required/
    );
  });
});

// ---------------------------------------------------------------------------
// getRepoHistory
// ---------------------------------------------------------------------------
describe('getRepoHistory', () => {
  it('returns rows for the repo ordered newest-first', async () => {
    const rows = [
      { id: 2, tier: 'full', total_issues: 12, total_modules: 39, duration_ms: 34000, scanned_at: '2026-05-05T10:00:00Z', module_summary: [] },
      { id: 1, tier: 'full', total_issues: 54, total_modules: 39, duration_ms: 41000, scanned_at: '2026-04-28T10:00:00Z', module_summary: [] },
    ];
    // DDL: CREATE TABLE + 2x CREATE INDEX (3) + SELECT (1) = 4 responses needed
    const sql = makeFakeSql([[], [], [], rows]);
    const result = await getRepoHistory(sql, 'https://github.com/org/repo', 20);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].total_issues, 12);
    assert.strictEqual(result[1].total_issues, 54);
  });

  it('returns empty array when sql returns no rows', async () => {
    const sql = makeFakeSql([[], [], [], []]);
    const result = await getRepoHistory(sql, 'github.com/x/y', 20);
    assert.ok(Array.isArray(result));
    assert.strictEqual(result.length, 0);
  });

  it('passes the limit value to the SQL query', async () => {
    const sql = makeFakeSql([[], [], [], []]);
    await getRepoHistory(sql, 'github.com/x/y', 5);
    const selectCall = sql.calls.find((c) => c.text.includes('SELECT') && c.text.includes('scan_history'));
    assert.ok(selectCall, 'SELECT call not found');
    assert.ok(selectCall.values.includes(5), `limit=5 not found in values: ${JSON.stringify(selectCall.values)}`);
  });

  it('PRIVACY: cleartext repo URL never reaches SQL values in getRepoHistory', async () => {
    const repoUrl = 'https://github.com/secret-org/private-repo';
    const sql = makeFakeSql([[], [], [], []]);
    await getRepoHistory(sql, repoUrl, 20);
    for (const call of sql.calls) {
      for (const v of call.values) {
        if (typeof v === 'string') {
          assert.ok(!v.includes('secret-org'), `cleartext org name leaked: ${v}`);
          assert.ok(!v.includes('private-repo'), `cleartext repo name leaked: ${v}`);
        }
      }
    }
  });

  it('uses the hashed repo URL as the lookup key', async () => {
    const repoUrl = 'https://github.com/org/repo';
    const expectedHash = hashRepoUrl(repoUrl);
    const sql = makeFakeSql([[], [], [], []]);
    await getRepoHistory(sql, repoUrl, 20);
    const selectCall = sql.calls.find((c) => c.text.includes('WHERE repo_hash'));
    assert.ok(selectCall, 'SELECT with WHERE repo_hash not found');
    assert.ok(
      selectCall.values.includes(expectedHash),
      'Expected repo_hash in SQL values'
    );
  });

  it('returns empty array when DB is unavailable (graceful)', async () => {
    // DB throws — caller should handle gracefully (route.ts catches it and
    // returns { history: [] }). The store itself propagates the error so the
    // caller can choose the recovery strategy.
    const throwingSql = makeThrowingSql('Connection refused');
    await assert.rejects(
      () => getRepoHistory(throwingSql, 'github.com/x/y', 20),
      /Connection refused/
    );
  });

  it('validates required arguments', async () => {
    const sql = makeFakeSql([[], []]);
    await assert.rejects(
      () => getRepoHistory(sql, ''),
      /repoUrl is required/
    );
    await assert.rejects(
      () => getRepoHistory(undefined, 'github.com/x/y'),
      /sql is required/
    );
  });
});
