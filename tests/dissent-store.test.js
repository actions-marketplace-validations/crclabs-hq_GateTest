// ============================================================================
// DISSENT-STORE TEST — Phase 5.2.1 of THE 110% MANDATE
// ============================================================================
// Verifies the closed-feedback-loop storage layer. Same design + same
// privacy contract as scan-fingerprint-store: cleartext repo URLs and
// reviewer identities are hashed before SQL binding.
// ============================================================================

const { describe, it, test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const {
  DISSENT_KINDS,
  REVIEWER_HASH_SALT,
  hashReviewer,
  ensureDissentTable,
  recordDissent,
  aggregateDissentByModulePattern,
  listDissentForRepo,
  dissentKindsSummary,
} = require(path.resolve(__dirname, '..', 'website', 'app', 'lib', 'dissent-store.js'));

const {
  hashRepoUrl,
} = require(path.resolve(__dirname, '..', 'website', 'app', 'lib', 'scan-fingerprint-store.js'));

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

// ---------- shape ----------

test('DISSENT_KINDS exposes the five recognised dissent types', () => {
  for (const k of ['ROLLED_BACK', 'PR_CLOSED_UNMERGED', 'FALSE_POSITIVE', 'FIX_REJECTED', 'COMMENT_DOWNVOTE']) {
    assert.ok(DISSENT_KINDS[k], `missing kind: ${k}`);
  }
});

test('DISSENT_KINDS is frozen so callers cannot accidentally mutate the contract', () => {
  // In sloppy mode Object.freeze silently ignores writes; in strict mode it throws.
  // Either way the result is the same: the property does not get added.
  try { DISSENT_KINDS.NEW_KIND = 'oops'; } catch { /* strict mode threw, fine */ }
  assert.strictEqual(DISSENT_KINDS.NEW_KIND, undefined);
  assert.ok(Object.isFrozen(DISSENT_KINDS));
});

// ---------- hashReviewer ----------

describe('hashReviewer', () => {
  it('returns a 24-char hex string', () => {
    const h = hashReviewer('craig');
    assert.match(h, /^[a-f0-9]{24}$/);
  });

  it('is deterministic — same identity → same hash', () => {
    assert.strictEqual(hashReviewer('craig'), hashReviewer('craig'));
  });

  it('is case-insensitive — Craig and craig produce the same hash', () => {
    assert.strictEqual(hashReviewer('Craig'), hashReviewer('craig'));
    assert.strictEqual(hashReviewer('CRAIG'), hashReviewer('craig'));
  });

  it('different identities → different hashes', () => {
    assert.notStrictEqual(hashReviewer('alice'), hashReviewer('bob'));
  });

  it('returns null on null / undefined / non-string input', () => {
    assert.strictEqual(hashReviewer(null), null);
    assert.strictEqual(hashReviewer(undefined), null);
    assert.strictEqual(hashReviewer(42), null);
  });

  it('uses a stable, public salt (same privacy posture as scan-fingerprint-store)', () => {
    assert.strictEqual(typeof REVIEWER_HASH_SALT, 'string');
    assert.match(REVIEWER_HASH_SALT, /gatetest:dissent_reviewer:v1/);
  });
});

// ---------- ensureDissentTable ----------

describe('ensureDissentTable', () => {
  it('issues CREATE TABLE plus all 4 indexes', async () => {
    const sql = makeFakeSql();
    await ensureDissentTable(sql);
    const joined = sql.calls.map((c) => c.text).join('\n');
    assert.match(joined, /CREATE TABLE IF NOT EXISTS dissent/);
    assert.match(joined, /repo_url_hash TEXT NOT NULL/);
    assert.match(joined, /pattern_hash TEXT,/);
    assert.match(joined, /reviewer_hash TEXT,/);
    assert.match(joined, /idx_dissent_module_pattern/);
    assert.match(joined, /idx_dissent_created/);
    assert.match(joined, /idx_dissent_repo/);
    assert.match(joined, /idx_dissent_kind/);
  });

  it('every CREATE uses IF NOT EXISTS (idempotent migrations)', async () => {
    const sql = makeFakeSql();
    await ensureDissentTable(sql);
    for (const c of sql.calls) {
      assert.match(c.text, /IF NOT EXISTS/);
    }
  });

  it('throws if sql is missing', async () => {
    await assert.rejects(() => ensureDissentTable(undefined), /sql is required/);
  });
});

// ---------- recordDissent ----------

describe('recordDissent', () => {
  it('inserts and returns id', async () => {
    const sql = makeFakeSql([[{ id: 7 }]]);
    const result = await recordDissent({
      sql,
      repoUrl: 'https://github.com/o/r',
      module: 'lint',
      patternHash: 'abc123',
      kind: DISSENT_KINDS.FALSE_POSITIVE,
      reviewer: 'alice',
      fixPrNumber: 42,
      notes: 'this rule fires on legitimate code',
    });
    assert.strictEqual(result.id, 7);
    assert.strictEqual(sql.calls.length, 1);
    assert.match(sql.calls[0].text, /INSERT INTO dissent/);
    assert.match(sql.calls[0].text, /RETURNING id/);
  });

  it('hashes repoUrl before binding (no cleartext URL in SQL values)', async () => {
    const sql = makeFakeSql([[{ id: 1 }]]);
    await recordDissent({
      sql,
      repoUrl: 'https://github.com/secret-org/sensitive',
      module: 'secrets',
      kind: DISSENT_KINDS.ROLLED_BACK,
    });
    const expectedHash = hashRepoUrl('https://github.com/secret-org/sensitive');
    assert.ok(sql.calls[0].values.includes(expectedHash));
    for (const v of sql.calls[0].values) {
      if (typeof v !== 'string') continue;
      assert.ok(!v.includes('secret-org'));
      assert.ok(!v.includes('sensitive'));
    }
  });

  it('hashes reviewer before binding (no cleartext identity in SQL)', async () => {
    const sql = makeFakeSql([[{ id: 1 }]]);
    await recordDissent({
      sql,
      repoUrl: 'github.com/x/y',
      module: 'lint',
      kind: DISSENT_KINDS.FALSE_POSITIVE,
      reviewer: 'craig.cantyznz',
    });
    const expectedReviewerHash = hashReviewer('craig.cantyznz');
    assert.ok(sql.calls[0].values.includes(expectedReviewerHash));
    for (const v of sql.calls[0].values) {
      if (typeof v !== 'string') continue;
      assert.ok(!v.includes('craig.cantyznz'));
    }
  });

  it('caps notes at 500 chars', async () => {
    const sql = makeFakeSql([[{ id: 1 }]]);
    const longNotes = 'x'.repeat(2000);
    await recordDissent({
      sql,
      repoUrl: 'github.com/x/y',
      module: 'lint',
      kind: DISSENT_KINDS.FALSE_POSITIVE,
      notes: longNotes,
    });
    const noteValue = sql.calls[0].values.find((v) => typeof v === 'string' && v.startsWith('xxx'));
    assert.strictEqual(noteValue.length, 500);
  });

  it('rejects unknown dissent kinds', async () => {
    await assert.rejects(
      () => recordDissent({
        sql: makeFakeSql([[{ id: 1 }]]),
        repoUrl: 'github.com/x/y',
        module: 'lint',
        kind: 'invented_kind',
      }),
      /kind must be one of/
    );
  });

  it('rejects calls missing required fields', async () => {
    await assert.rejects(
      () => recordDissent({ sql: makeFakeSql(), module: 'lint', kind: DISSENT_KINDS.FALSE_POSITIVE }),
      /repoUrl is required/
    );
    await assert.rejects(
      () => recordDissent({ sql: makeFakeSql(), repoUrl: 'x', kind: DISSENT_KINDS.FALSE_POSITIVE }),
      /module is required/
    );
    await assert.rejects(
      () => recordDissent({ repoUrl: 'x', module: 'lint', kind: DISSENT_KINDS.FALSE_POSITIVE }),
      /sql is required/
    );
  });

  it('null reviewer + null patternHash + null notes are accepted', async () => {
    const sql = makeFakeSql([[{ id: 1 }]]);
    const r = await recordDissent({
      sql,
      repoUrl: 'github.com/x/y',
      module: 'lint',
      kind: DISSENT_KINDS.PR_CLOSED_UNMERGED,
    });
    assert.strictEqual(r.id, 1);
  });
});

// ---------- aggregateDissentByModulePattern ----------

describe('aggregateDissentByModulePattern', () => {
  it('returns the rows the storage produces (passthrough)', async () => {
    const stub = [
      { module: 'lint', pattern_hash: 'h1', dissent_count: 12, distinct_reviewers: 3, distinct_repos: 8, kinds: ['false_positive'] },
    ];
    const sql = makeFakeSql([stub]);
    const out = await aggregateDissentByModulePattern({ sql, daysBack: 30 });
    assert.deepStrictEqual(out, stub);
  });

  it('uses GROUP BY (module, pattern_hash) and a time-window predicate', async () => {
    const sql = makeFakeSql([[]]);
    await aggregateDissentByModulePattern({ sql, daysBack: 7 });
    assert.match(sql.calls[0].text, /GROUP BY module, pattern_hash/);
    assert.match(sql.calls[0].text, /created_at > NOW\(\)/);
    assert.ok(sql.calls[0].values.includes(7));
  });

  it('default window is 30 days', async () => {
    const sql = makeFakeSql([[]]);
    await aggregateDissentByModulePattern({ sql });
    assert.ok(sql.calls[0].values.includes(30));
  });
});

// ---------- listDissentForRepo ----------

describe('listDissentForRepo', () => {
  it('queries by hashed repo URL', async () => {
    const sql = makeFakeSql([[]]);
    await listDissentForRepo({ sql, repoUrl: 'github.com/x/y' });
    const expected = hashRepoUrl('github.com/x/y');
    assert.ok(sql.calls[0].values.includes(expected));
  });

  it('rejects calls missing repoUrl', async () => {
    await assert.rejects(
      () => listDissentForRepo({ sql: makeFakeSql() }),
      /repoUrl is required/
    );
  });

  it('default limit is 100', async () => {
    const sql = makeFakeSql([[]]);
    await listDissentForRepo({ sql, repoUrl: 'github.com/x/y' });
    assert.ok(sql.calls[0].values.includes(100));
  });
});

// ---------- dissentKindsSummary ----------

describe('dissentKindsSummary', () => {
  it('returns rows from a GROUP BY kind query', async () => {
    const stub = [
      { kind: 'false_positive', n: 30 },
      { kind: 'rolled_back', n: 5 },
    ];
    const sql = makeFakeSql([stub]);
    const out = await dissentKindsSummary({ sql, daysBack: 30 });
    assert.deepStrictEqual(out, stub);
    assert.match(sql.calls[0].text, /GROUP BY kind/);
  });
});

// ---------- privacy contract ----------

describe('PRIVACY CONTRACT — never leak cleartext repo URL or reviewer identity', () => {
  it('recordDissent never lets cleartext URL into SQL values', async () => {
    const sql = makeFakeSql([[{ id: 1 }]]);
    await recordDissent({
      sql,
      repoUrl: 'https://github.com/secret-org/sensitive-repo',
      module: 'secrets',
      kind: DISSENT_KINDS.ROLLED_BACK,
      reviewer: 'sensitive-username',
    });
    const flat = JSON.stringify(sql.calls[0].values);
    assert.ok(!flat.includes('secret-org'), `cleartext URL leak: ${flat}`);
    assert.ok(!flat.includes('sensitive-repo'), `cleartext URL leak: ${flat}`);
    assert.ok(!flat.includes('sensitive-username'), `cleartext reviewer leak: ${flat}`);
  });

  it('listDissentForRepo never lets cleartext URL into SQL values', async () => {
    const sql = makeFakeSql([[]]);
    await listDissentForRepo({
      sql,
      repoUrl: 'https://github.com/secret-org/sensitive-repo',
    });
    for (const v of sql.calls[0].values) {
      if (typeof v !== 'string') continue;
      assert.ok(!v.includes('secret-org'));
    }
  });
});
