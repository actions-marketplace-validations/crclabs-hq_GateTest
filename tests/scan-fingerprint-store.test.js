// ============================================================================
// SCAN-FINGERPRINT-STORE TEST — Phase 5.1.1 of THE 110% MANDATE
// ============================================================================
// Verifies the cross-repo intelligence storage helper. Privacy contract is
// the killer test target — we MUST never put a cleartext repo URL into a
// query. Also covers schema migrations, similarity lookup (exact + framework-
// overlap fallback), aggregate stats, and GDPR delete-by-repo.
// ============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const {
  REPO_HASH_SALT,
  hashRepoUrl,
  ensureScanFingerprintTable,
  insertFingerprint,
  findSimilarFingerprints,
  getFingerprintStats,
  deleteFingerprintsForRepo,
} = require(path.resolve(
  __dirname,
  '..',
  'website',
  'app',
  'lib',
  'scan-fingerprint-store.js'
));

/**
 * Fake tagged-template SQL function — records every call (text + values) and
 * replays canned responses in FIFO order. Mirrors the Neon signature.
 */
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

describe('hashRepoUrl', () => {
  it('returns a 64-char hex sha256', () => {
    const h = hashRepoUrl('https://github.com/o/r');
    assert.match(h, /^[a-f0-9]{64}$/);
  });

  it('is deterministic — same URL → same hash', () => {
    const a = hashRepoUrl('https://github.com/o/r');
    const b = hashRepoUrl('https://github.com/o/r');
    assert.strictEqual(a, b);
  });

  it('normalises so .git suffix, trailing slash, https://, query string all collapse', () => {
    const a = hashRepoUrl('https://github.com/o/r');
    const b = hashRepoUrl('https://github.com/o/r.git');
    const c = hashRepoUrl('github.com/o/r/');
    const d = hashRepoUrl('https://github.com/o/r?foo=bar');
    const e = hashRepoUrl('https://GITHUB.com/o/r');
    assert.strictEqual(a, b);
    assert.strictEqual(a, c);
    assert.strictEqual(a, d);
    assert.strictEqual(a, e);
  });

  it('different URLs hash to different values', () => {
    const a = hashRepoUrl('https://github.com/o/r1');
    const b = hashRepoUrl('https://github.com/o/r2');
    assert.notStrictEqual(a, b);
  });

  it('rejects null / undefined / non-string', () => {
    assert.throws(() => hashRepoUrl(null), /required and must be a string/);
    assert.throws(() => hashRepoUrl(undefined), /required and must be a string/);
    assert.throws(() => hashRepoUrl(42), /required and must be a string/);
  });

  it('uses a stable, public salt (privacy guarantee is "no cleartext", not "secret salt")', () => {
    assert.strictEqual(typeof REPO_HASH_SALT, 'string');
    assert.match(REPO_HASH_SALT, /gatetest:scan_fingerprint:v1/);
  });
});

describe('ensureScanFingerprintTable', () => {
  it('issues CREATE TABLE plus all 6 indexes', async () => {
    const sql = makeFakeSql();
    await ensureScanFingerprintTable(sql);
    const joined = sql.calls.map((c) => c.text).join('\n');
    assert.match(joined, /CREATE TABLE IF NOT EXISTS scan_fingerprint/);
    assert.match(joined, /repo_url_hash TEXT NOT NULL/);
    assert.match(joined, /framework_versions JSONB NOT NULL/);
    assert.match(joined, /idx_scan_fingerprint_created/);
    assert.match(joined, /idx_scan_fingerprint_repo/);
    assert.match(joined, /idx_scan_fingerprint_framework/);
    assert.match(joined, /idx_scan_fingerprint_module/);
    assert.match(joined, /idx_scan_fingerprint_tier/);
    assert.match(joined, /idx_scan_fingerprint_signature/);
  });

  it('uses GIN indexes for JSONB columns (so containment queries are fast)', async () => {
    const sql = makeFakeSql();
    await ensureScanFingerprintTable(sql);
    const joined = sql.calls.map((c) => c.text).join('\n');
    assert.match(joined, /USING GIN \(framework_versions\)/);
    assert.match(joined, /USING GIN \(module_findings\)/);
  });

  it('throws if sql is missing', async () => {
    await assert.rejects(() => ensureScanFingerprintTable(undefined), /sql is required/);
  });

  it('schema is idempotent (every CREATE uses IF NOT EXISTS)', async () => {
    const sql = makeFakeSql();
    await ensureScanFingerprintTable(sql);
    for (const c of sql.calls) {
      assert.match(c.text, /IF NOT EXISTS/);
    }
  });
});

describe('insertFingerprint', () => {
  it('inserts via INSERT ... RETURNING id, hashes the repo URL before storage', async () => {
    const sql = makeFakeSql([[{ id: 17 }]]);
    const result = await insertFingerprint({
      sql,
      repoUrl: 'https://github.com/o/r',
      tier: 'full',
      frameworkVersions: { next: '16.2.4', react: '19' },
      languageMix: { ts: 0.85 },
      moduleFindings: { lint: { count: 3, patternHashes: ['abc', 'def'] } },
      fixOutcomes: { lint: { attempted: 3, succeeded: 2 } },
      totalFindings: 12,
      totalFixed: 8,
      durationMs: 12345,
      fingerprintSignature: 'sig-1234',
    });
    assert.strictEqual(result.id, 17);
    assert.strictEqual(sql.calls.length, 1);
    const call = sql.calls[0];
    assert.match(call.text, /INSERT INTO scan_fingerprint/);
    assert.match(call.text, /RETURNING id/);
    // The repo URL must NEVER appear as a value — only the hash.
    const hash = hashRepoUrl('https://github.com/o/r');
    assert.ok(call.values.includes(hash), 'repo_url_hash should be passed');
    assert.ok(!call.values.includes('https://github.com/o/r'), 'cleartext URL must never reach SQL');
  });

  it('passes JSONB columns as JSON-stringified values', async () => {
    const sql = makeFakeSql([[{ id: 1 }]]);
    await insertFingerprint({
      sql,
      repoUrl: 'github.com/x/y',
      tier: 'quick',
      frameworkVersions: { next: '16' },
      moduleFindings: { lint: { count: 1 } },
      fingerprintSignature: 'sig',
    });
    const call = sql.calls[0];
    // Each JSONB col gets serialised — find the next-config one in values.
    assert.ok(call.values.some((v) => typeof v === 'string' && v.includes('"next":"16"')));
  });

  it('returns null id when the insert returns no rows', async () => {
    const sql = makeFakeSql([[]]);
    const result = await insertFingerprint({
      sql,
      repoUrl: 'github.com/x/y',
      tier: 'quick',
      frameworkVersions: {},
      moduleFindings: {},
      fingerprintSignature: 'sig',
    });
    assert.strictEqual(result.id, null);
  });

  it('rejects calls missing required fields', async () => {
    await assert.rejects(
      () => insertFingerprint({ sql: makeFakeSql(), tier: 'full', fingerprintSignature: 'x' }),
      /repoUrl is required/
    );
    await assert.rejects(
      () => insertFingerprint({ sql: makeFakeSql(), repoUrl: 'x', fingerprintSignature: 'x' }),
      /tier is required/
    );
    await assert.rejects(
      () => insertFingerprint({ sql: makeFakeSql(), repoUrl: 'x', tier: 'full' }),
      /fingerprintSignature is required/
    );
    await assert.rejects(
      () => insertFingerprint({ repoUrl: 'x', tier: 'full', fingerprintSignature: 'x' }),
      /sql is required/
    );
  });

  it('defaults host to gatetest.ai when not supplied', async () => {
    const sql = makeFakeSql([[{ id: 1 }]]);
    await insertFingerprint({
      sql,
      repoUrl: 'github.com/x/y',
      tier: 'quick',
      frameworkVersions: {},
      moduleFindings: {},
      fingerprintSignature: 'sig',
    });
    assert.ok(sql.calls[0].values.includes('gatetest.ai'));
  });
});

describe('findSimilarFingerprints', () => {
  it('returns exact-signature matches when ≥ limit are found', async () => {
    const matches = [
      { id: 1, fingerprint_signature: 'sig-a' },
      { id: 2, fingerprint_signature: 'sig-a' },
      { id: 3, fingerprint_signature: 'sig-a' },
      { id: 4, fingerprint_signature: 'sig-a' },
      { id: 5, fingerprint_signature: 'sig-a' },
    ];
    const sql = makeFakeSql([matches]);
    const out = await findSimilarFingerprints({
      sql,
      fingerprintSignature: 'sig-a',
      limit: 5,
    });
    assert.strictEqual(out.length, 5);
    assert.strictEqual(sql.calls.length, 1, 'should not run framework fallback');
  });

  it('falls back to framework overlap when exact matches are insufficient', async () => {
    const sql = makeFakeSql([
      [{ id: 1 }], // 1 exact match
      [{ id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }], // 4 framework-similar
    ]);
    const out = await findSimilarFingerprints({
      sql,
      fingerprintSignature: 'sig-a',
      frameworkVersions: { next: '16.2.4' },
      limit: 5,
    });
    assert.strictEqual(out.length, 5);
    assert.strictEqual(sql.calls.length, 2);
    // Soft-match strips patch version: "16.2.4" → "16.2"
    const fallbackCall = sql.calls[1];
    assert.ok(fallbackCall.values.some((v) => typeof v === 'string' && v.includes('"next":"16.2"')));
  });

  it('skips framework fallback when no frameworkVersions supplied', async () => {
    const sql = makeFakeSql([[{ id: 1 }]]);
    const out = await findSimilarFingerprints({
      sql,
      fingerprintSignature: 'sig-a',
      limit: 5,
    });
    assert.strictEqual(out.length, 1);
    assert.strictEqual(sql.calls.length, 1);
  });

  it('honours excludeRepoUrlHash so we never recommend a repo to itself', async () => {
    const sql = makeFakeSql([[{ id: 1 }]]);
    const myHash = hashRepoUrl('github.com/me/mine');
    await findSimilarFingerprints({
      sql,
      fingerprintSignature: 'sig-a',
      excludeRepoUrlHash: myHash,
      limit: 5,
    });
    assert.ok(sql.calls[0].values.includes(myHash));
    assert.match(sql.calls[0].text, /repo_url_hash <> /);
  });

  it('defaults limit to 5', async () => {
    const sql = makeFakeSql([[]]);
    await findSimilarFingerprints({ sql, fingerprintSignature: 'sig' });
    assert.ok(sql.calls[0].values.includes(5));
  });

  it('rejects calls missing fingerprintSignature', async () => {
    await assert.rejects(
      () => findSimilarFingerprints({ sql: makeFakeSql() }),
      /fingerprintSignature is required/
    );
  });
});

describe('getFingerprintStats', () => {
  it('returns count + percentiles + fix-success rate from a single aggregate query', async () => {
    const sql = makeFakeSql([
      [{ count: 312, median_findings: 41, p90_findings: 188, fix_success_rate: 0.83 }],
    ]);
    const stats = await getFingerprintStats({
      sql,
      frameworkVersions: { next: '16' },
    });
    assert.strictEqual(stats.count, 312);
    assert.strictEqual(stats.medianFindings, 41);
    assert.strictEqual(stats.p90Findings, 188);
    assert.strictEqual(stats.fixSuccessRate, 0.83);
  });

  it('handles empty result set gracefully (no scans yet for this stack)', async () => {
    const sql = makeFakeSql([[]]);
    const stats = await getFingerprintStats({
      sql,
      frameworkVersions: { next: '16' },
    });
    assert.strictEqual(stats.count, 0);
    assert.strictEqual(stats.medianFindings, 0);
    assert.strictEqual(stats.fixSuccessRate, 0);
  });

  it('uses the frameworkVersions JSONB containment operator', async () => {
    const sql = makeFakeSql([[]]);
    await getFingerprintStats({
      sql,
      frameworkVersions: { next: '16' },
    });
    assert.match(sql.calls[0].text, /framework_versions @> /);
  });

  it('default lookback window is 30 days', async () => {
    const sql = makeFakeSql([[]]);
    await getFingerprintStats({
      sql,
      frameworkVersions: { next: '16' },
    });
    assert.ok(sql.calls[0].values.includes(30));
  });

  it('rejects calls missing frameworkVersions', async () => {
    await assert.rejects(
      () => getFingerprintStats({ sql: makeFakeSql() }),
      /frameworkVersions is required/
    );
  });
});

describe('deleteFingerprintsForRepo', () => {
  it('deletes by repo_url_hash and returns count', async () => {
    const sql = makeFakeSql([[{ id: 1 }, { id: 2 }, { id: 3 }]]);
    const result = await deleteFingerprintsForRepo({
      sql,
      repoUrl: 'https://github.com/o/r',
    });
    assert.strictEqual(result.deleted, 3);
    assert.match(sql.calls[0].text, /DELETE FROM scan_fingerprint/);
    // Cleartext URL must not appear in the query
    const hash = hashRepoUrl('https://github.com/o/r');
    assert.ok(sql.calls[0].values.includes(hash));
    assert.ok(!sql.calls[0].values.includes('https://github.com/o/r'));
  });

  it('returns 0 when nothing matched', async () => {
    const sql = makeFakeSql([[]]);
    const result = await deleteFingerprintsForRepo({
      sql,
      repoUrl: 'https://github.com/never/scanned',
    });
    assert.strictEqual(result.deleted, 0);
  });

  it('rejects calls missing repoUrl', async () => {
    await assert.rejects(
      () => deleteFingerprintsForRepo({ sql: makeFakeSql() }),
      /repoUrl is required/
    );
  });
});

describe('PRIVACY CONTRACT — cleartext URLs must never reach SQL values', () => {
  it('insertFingerprint does not pass cleartext repoUrl to the SQL layer', async () => {
    const sql = makeFakeSql([[{ id: 1 }]]);
    const repoUrl = 'https://github.com/secret-org/sensitive-repo';
    await insertFingerprint({
      sql,
      repoUrl,
      tier: 'full',
      frameworkVersions: {},
      moduleFindings: {},
      fingerprintSignature: 'sig',
    });
    for (const call of sql.calls) {
      for (const v of call.values) {
        if (typeof v === 'string') {
          assert.ok(!v.includes('secret-org'), `cleartext leak in: ${v}`);
          assert.ok(!v.includes('sensitive-repo'), `cleartext leak in: ${v}`);
        }
      }
    }
  });

  it('deleteFingerprintsForRepo does not pass cleartext repoUrl to the SQL layer', async () => {
    const sql = makeFakeSql([[]]);
    await deleteFingerprintsForRepo({
      sql,
      repoUrl: 'https://github.com/secret-org/sensitive-repo',
    });
    for (const call of sql.calls) {
      for (const v of call.values) {
        if (typeof v === 'string') {
          assert.ok(!v.includes('secret-org'), `cleartext leak in: ${v}`);
        }
      }
    }
  });
});
