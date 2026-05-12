// ============================================================================
// EXTERNAL-INTEGRATIONS-STORE TEST — Phase 5.3.1 of THE 110% MANDATE
// ============================================================================
// Verifies the polymorphic external-integrations storage layer.
// Privacy contract is the killer test: cleartext tokens MUST be
// encrypted before SQL binding (AES-256-GCM with INTEGRATIONS_SECRET-
// derived key). Tests confirm round-trip, tamper detection, and that
// the encrypted blob never matches the plaintext token.
// ============================================================================

const { describe, it, test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

// INTEGRATIONS_SECRET must be set BEFORE require so getEncryptionKey
// passes the strict ≥32-char gate.
process.env.INTEGRATIONS_SECRET = 'test-secret-with-at-least-32-characters-long';

const {
  VENDORS,
  SUPPORTED_VENDORS,
  encryptToken,
  decryptToken,
  ensureExternalIntegrationsTable,
  connectIntegration,
  getIntegrationCredentials,
  markUsed,
  disconnectIntegration,
  listConnectedVendors,
} = require(path.resolve(__dirname, '..', 'website', 'app', 'lib', 'external-integrations-store.js'));

const { hashRepoUrl } = require(path.resolve(
  __dirname, '..', 'website', 'app', 'lib', 'scan-fingerprint-store.js'
));

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

test('VENDORS exposes Sentry, Datadog, Vercel Analytics', () => {
  assert.strictEqual(VENDORS.SENTRY, 'sentry');
  assert.strictEqual(VENDORS.DATADOG, 'datadog');
  assert.strictEqual(VENDORS.VERCEL_ANALYTICS, 'vercel_analytics');
  assert.ok(SUPPORTED_VENDORS.includes('sentry'));
});

test('VENDORS object is frozen so callers cannot mutate the contract', () => {
  try { VENDORS.NEW_VENDOR = 'oops'; } catch { /* strict throws, sloppy ignores */ }
  assert.strictEqual(VENDORS.NEW_VENDOR, undefined);
  assert.ok(Object.isFrozen(VENDORS));
});

// ---------- encryption ----------

describe('encryptToken / decryptToken', () => {
  it('round-trips a real-shaped Sentry access token', () => {
    const token = 'sntrys_eyJpYXQiOjE3MTYwMDAwMDAsInVybCI6Imh0dHBzOi8vc2VudHJ5LmlvIn0=_secrethere';
    const encrypted = encryptToken(token);
    assert.notStrictEqual(encrypted, token);
    const decrypted = decryptToken(encrypted);
    assert.strictEqual(decrypted, token);
  });

  it('produces different ciphertext on every call (random IV)', () => {
    const token = 'sntrys_aaa';
    const a = encryptToken(token);
    const b = encryptToken(token);
    assert.notStrictEqual(a, b, 'IV randomisation is required');
    // Both decrypt to the same plaintext
    assert.strictEqual(decryptToken(a), token);
    assert.strictEqual(decryptToken(b), token);
  });

  it('detects tampering — flipped byte → throws', () => {
    const token = 'sntrys_real_token';
    const encrypted = encryptToken(token);
    // Flip the last hex char of the ciphertext (auth-tag check should catch)
    const flipped = encrypted.slice(0, -1) + (encrypted.endsWith('a') ? 'b' : 'a');
    assert.throws(() => decryptToken(flipped));
  });

  it('rejects malformed ciphertext', () => {
    assert.throws(() => decryptToken('not:a:valid:ciphertext:format'));
    assert.throws(() => decryptToken('garbage'));
    assert.throws(() => decryptToken(''));
  });

  it('rejects empty / non-string input on encrypt', () => {
    assert.throws(() => encryptToken(''));
    assert.throws(() => encryptToken(null));
    assert.throws(() => encryptToken(undefined));
  });
});

// ---------- ensureExternalIntegrationsTable ----------

describe('ensureExternalIntegrationsTable', () => {
  it('issues CREATE TABLE plus 2 indexes with UNIQUE constraint', async () => {
    const sql = makeFakeSql();
    await ensureExternalIntegrationsTable(sql);
    const joined = sql.calls.map((c) => c.text).join('\n');
    assert.match(joined, /CREATE TABLE IF NOT EXISTS external_integrations/);
    assert.match(joined, /access_token_enc TEXT NOT NULL/);
    assert.match(joined, /UNIQUE \(repo_url_hash, vendor, org_id, project_id\)/);
    assert.match(joined, /idx_ext_int_repo_vendor/);
    assert.match(joined, /idx_ext_int_vendor_updated/);
  });

  it('throws if sql is missing', async () => {
    await assert.rejects(() => ensureExternalIntegrationsTable(undefined), /sql is required/);
  });
});

// ---------- connectIntegration ----------

describe('connectIntegration', () => {
  it('inserts ON CONFLICT DO UPDATE with encrypted tokens', async () => {
    const sql = makeFakeSql([[{ id: 9 }]]);
    const result = await connectIntegration({
      sql,
      repoUrl: 'https://github.com/o/r',
      vendor: VENDORS.SENTRY,
      orgId: 'my-sentry-org',
      projectId: '1234567',
      accessToken: 'sntrys_supersecret',
      refreshToken: 'rtkn_supersecret',
      scope: 'project:read',
    });
    assert.strictEqual(result.id, 9);
    assert.strictEqual(sql.calls.length, 1);
    assert.match(sql.calls[0].text, /INSERT INTO external_integrations/);
    assert.match(sql.calls[0].text, /ON CONFLICT.*DO UPDATE/);
  });

  it('hashes repo URL before binding (no cleartext URL in SQL)', async () => {
    const sql = makeFakeSql([[{ id: 1 }]]);
    await connectIntegration({
      sql,
      repoUrl: 'https://github.com/secret-org/sensitive-repo',
      vendor: VENDORS.SENTRY,
      orgId: 'org',
      accessToken: 'sntrys_x',
    });
    const expectedHash = hashRepoUrl('https://github.com/secret-org/sensitive-repo');
    assert.ok(sql.calls[0].values.includes(expectedHash));
    for (const v of sql.calls[0].values) {
      if (typeof v !== 'string') continue;
      assert.ok(!v.includes('secret-org'), `cleartext URL leak in: ${v}`);
    }
  });

  it('encrypts the access token before binding (cleartext token never reaches SQL)', async () => {
    const sql = makeFakeSql([[{ id: 1 }]]);
    const cleartextToken = 'sntrys_HIGHLY_SECRET_TOKEN_VALUE_12345';
    await connectIntegration({
      sql,
      repoUrl: 'github.com/o/r',
      vendor: VENDORS.SENTRY,
      orgId: 'org',
      accessToken: cleartextToken,
    });
    for (const v of sql.calls[0].values) {
      if (typeof v !== 'string') continue;
      assert.ok(!v.includes('HIGHLY_SECRET'), `cleartext token leak: ${v}`);
    }
    // Confirm one of the values IS the encrypted form (3-part colon-joined)
    const encryptedValue = sql.calls[0].values.find(
      (v) => typeof v === 'string' && v.split(':').length === 3 && v.length > 50,
    );
    assert.ok(encryptedValue, 'expected an encrypted token in SQL values');
  });

  it('rejects unknown vendors', async () => {
    await assert.rejects(
      () => connectIntegration({
        sql: makeFakeSql([[{ id: 1 }]]),
        repoUrl: 'github.com/o/r',
        vendor: 'invented_vendor',
        orgId: 'org',
        accessToken: 'tok',
      }),
      /vendor must be one of/
    );
  });

  it('rejects calls missing required fields', async () => {
    await assert.rejects(
      () => connectIntegration({ sql: makeFakeSql(), vendor: VENDORS.SENTRY, orgId: 'o', accessToken: 't' }),
      /repoUrl is required/
    );
    await assert.rejects(
      () => connectIntegration({ sql: makeFakeSql(), repoUrl: 'r', vendor: VENDORS.SENTRY, accessToken: 't' }),
      /orgId is required/
    );
    await assert.rejects(
      () => connectIntegration({ sql: makeFakeSql(), repoUrl: 'r', vendor: VENDORS.SENTRY, orgId: 'o' }),
      /accessToken is required/
    );
  });
});

// ---------- getIntegrationCredentials ----------

describe('getIntegrationCredentials', () => {
  it('returns null when nothing is connected', async () => {
    const sql = makeFakeSql([[]]);
    const result = await getIntegrationCredentials({
      sql, repoUrl: 'github.com/o/r', vendor: VENDORS.SENTRY,
    });
    assert.strictEqual(result, null);
  });

  it('returns decrypted tokens when one exists', async () => {
    // Encrypt sample tokens once
    const accessTokenEnc = encryptToken('access_token_x');
    const refreshTokenEnc = encryptToken('refresh_token_y');
    const sql = makeFakeSql([[{
      id: 5, org_id: 'my-org', project_id: 'my-proj',
      access_token_enc: accessTokenEnc,
      refresh_token_enc: refreshTokenEnc,
      expires_at: '2026-12-31', scope: 'project:read',
      last_used_at: null,
    }]]);
    const result = await getIntegrationCredentials({
      sql, repoUrl: 'github.com/o/r', vendor: VENDORS.SENTRY,
    });
    assert.strictEqual(result.id, 5);
    assert.strictEqual(result.accessToken, 'access_token_x');
    assert.strictEqual(result.refreshToken, 'refresh_token_y');
    assert.strictEqual(result.orgId, 'my-org');
  });

  it('handles null refresh_token_enc (some vendors do not provide one)', async () => {
    const accessTokenEnc = encryptToken('access_only');
    const sql = makeFakeSql([[{
      id: 1, org_id: 'org', project_id: null,
      access_token_enc: accessTokenEnc,
      refresh_token_enc: null,
      expires_at: null, scope: null, last_used_at: null,
    }]]);
    const result = await getIntegrationCredentials({
      sql, repoUrl: 'github.com/o/r', vendor: VENDORS.SENTRY,
    });
    assert.strictEqual(result.refreshToken, null);
  });
});

// ---------- markUsed ----------

describe('markUsed', () => {
  it('issues UPDATE on the right id', async () => {
    const sql = makeFakeSql([[]]);
    await markUsed({ sql, id: 42 });
    assert.match(sql.calls[0].text, /UPDATE external_integrations SET last_used_at/);
    assert.ok(sql.calls[0].values.includes(42));
  });
});

// ---------- disconnectIntegration ----------

describe('disconnectIntegration', () => {
  it('deletes only the matching vendor when one is supplied', async () => {
    const sql = makeFakeSql([[{ id: 1 }, { id: 2 }]]);
    const result = await disconnectIntegration({
      sql, repoUrl: 'github.com/o/r', vendor: VENDORS.SENTRY,
    });
    assert.strictEqual(result.deleted, 2);
    assert.match(sql.calls[0].text, /WHERE repo_url_hash = .*AND vendor = /);
  });

  it('deletes all vendors for the repo when no vendor supplied', async () => {
    const sql = makeFakeSql([[{ id: 1 }]]);
    await disconnectIntegration({ sql, repoUrl: 'github.com/o/r' });
    assert.doesNotMatch(sql.calls[0].text, /AND vendor = /);
  });
});

// ---------- listConnectedVendors ----------

describe('listConnectedVendors', () => {
  it('returns rows ordered by vendor', async () => {
    const stub = [
      { vendor: 'datadog', org_id: 'a', project_id: null, expires_at: null, last_used_at: null, updated_at: '2026-01-01' },
      { vendor: 'sentry', org_id: 'b', project_id: '1', expires_at: null, last_used_at: null, updated_at: '2026-01-01' },
    ];
    const sql = makeFakeSql([stub]);
    const result = await listConnectedVendors({ sql, repoUrl: 'github.com/o/r' });
    assert.deepStrictEqual(result, stub);
    assert.match(sql.calls[0].text, /ORDER BY vendor ASC/);
  });
});

// ---------- privacy contract ----------

describe('PRIVACY CONTRACT — tokens never reach SQL in cleartext', () => {
  it('connectIntegration encrypts token before binding (verified with a known-secret marker)', async () => {
    const sql = makeFakeSql([[{ id: 1 }]]);
    const SECRET_MARKER = 'NEVER_LEAK_THIS_TOKEN_VALUE_xyzzy';
    await connectIntegration({
      sql,
      repoUrl: 'github.com/o/r',
      vendor: VENDORS.SENTRY,
      orgId: 'org',
      accessToken: SECRET_MARKER,
      refreshToken: SECRET_MARKER + '_refresh',
    });
    const flat = JSON.stringify(sql.calls[0].values);
    assert.ok(!flat.includes(SECRET_MARKER), `cleartext token leak: ${flat}`);
    assert.ok(!flat.includes('xyzzy'), `cleartext fragment leak: ${flat}`);
  });

  it('encryption secret missing → encryptToken throws (fail-closed)', () => {
    const original = process.env.INTEGRATIONS_SECRET;
    process.env.INTEGRATIONS_SECRET = '';
    try {
      assert.throws(() => encryptToken('anything'), /INTEGRATIONS_SECRET/);
    } finally {
      process.env.INTEGRATIONS_SECRET = original;
    }
  });

  it('encryption secret too short → throws', () => {
    const original = process.env.INTEGRATIONS_SECRET;
    process.env.INTEGRATIONS_SECRET = 'too-short';
    try {
      assert.throws(() => encryptToken('anything'), /≥32 chars/);
    } finally {
      process.env.INTEGRATIONS_SECRET = original;
    }
  });
});
