// ============================================================================
// SELF-SCAN-STATUS API TEST — coverage for the live self-scan badge.
// ============================================================================
// Verifies the pure helpers behind `/api/internal/self-scan-status` and
// `/api/internal/self-scan-history`. All HMAC verification, payload
// validation, in-memory storage, and ageMinutes math is exercised here.
//
// Covered paths:
//   - POST with valid HMAC + valid payload   → 200 { stored: true }
//   - POST with missing signature             → 401 { error }
//   - POST with wrong signature               → 403 { error }
//   - POST with malformed JSON                → 400 { error }
//   - POST with wrong gateStatus enum         → 400 { error }
//   - POST with negative errorCount           → 400 { error }
//   - POST with bad commitSha                 → 400 { error }
//   - POST with modulesPassed > total         → 400 { error }
//   - POST with secret unset                  → 503 { error } (fail-closed)
//   - GET with no data → returns no-data shape
//   - GET with data    → returns latest scan shape
//   - GET ageMinutes calculation correct (mock clock)
//   - In-memory state survives between POST and subsequent GET
//   - History endpoint returns most-recent-first, bounded to HISTORY_LIMIT
//
// Hermetic — no real HTTP. node:test + node:assert only.
// ============================================================================

'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const path = require('path');

const helper = require(
  path.resolve(
    __dirname,
    '..',
    'website',
    'app',
    'lib',
    'self-scan-status.js',
  ),
);

const SECRET = 'test-internal-token-0123456789abcdef0123456789abcdef';

function hmacHeader(body, secret = SECRET) {
  return (
    'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex')
  );
}

function validPayload(overrides = {}) {
  return {
    gateStatus: 'PASSED',
    errorCount: 0,
    warningCount: 12,
    modulesPassedCount: 91,
    modulesTotalCount: 91,
    scannedAt: '2026-05-17T13:42:00Z',
    commitSha: 'abc1234',
    ...overrides,
  };
}

beforeEach(() => {
  helper._resetForTests();
});

describe('verifyInternalSignature', () => {
  it('returns true when header matches sha256=<hmac(secret, body)>', () => {
    const body = '{"a":1}';
    assert.strictEqual(
      helper.verifyInternalSignature(body, hmacHeader(body), SECRET),
      true,
    );
  });

  it('returns false on wrong signature', () => {
    assert.strictEqual(
      helper.verifyInternalSignature('{"a":1}', hmacHeader('{"a":2}'), SECRET),
      false,
    );
  });

  it('returns false on missing or malformed header', () => {
    assert.strictEqual(
      helper.verifyInternalSignature('{}', null, SECRET),
      false,
    );
    assert.strictEqual(helper.verifyInternalSignature('{}', '', SECRET), false);
    assert.strictEqual(
      helper.verifyInternalSignature('{}', 'not-sha256-prefix', SECRET),
      false,
    );
  });

  it('returns false when secret is empty (fail-closed)', () => {
    assert.strictEqual(
      helper.verifyInternalSignature('{}', hmacHeader('{}'), ''),
      false,
    );
  });
});

describe('signBody', () => {
  it('produces a sha256= prefix and a hex hmac', () => {
    const sig = helper.signBody('{"a":1}', SECRET);
    assert.match(sig, /^sha256=[a-f0-9]{64}$/);
    assert.strictEqual(
      sig,
      hmacHeader('{"a":1}'),
      'should match the verification helper',
    );
  });
});

describe('validateStatusPayload', () => {
  it('accepts a well-formed payload and normalises commitSha', () => {
    const result = helper.validateStatusPayload(
      validPayload({ commitSha: 'AB12CDE' }),
    );
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.payload.commitSha, 'ab12cde');
  });

  it('rejects wrong gateStatus enum', () => {
    const result = helper.validateStatusPayload(
      validPayload({ gateStatus: 'GREEN' }),
    );
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /gateStatus/);
  });

  it('rejects negative errorCount', () => {
    const result = helper.validateStatusPayload(
      validPayload({ errorCount: -1 }),
    );
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /errorCount/);
  });

  it('rejects modulesPassed > total', () => {
    const result = helper.validateStatusPayload(
      validPayload({ modulesPassedCount: 92, modulesTotalCount: 91 }),
    );
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /modulesPassedCount.*exceed/);
  });

  it('rejects bad commitSha shape', () => {
    const result = helper.validateStatusPayload(
      validPayload({ commitSha: 'xyz' }),
    );
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /commitSha/);
  });

  it('rejects unparseable scannedAt', () => {
    const result = helper.validateStatusPayload(
      validPayload({ scannedAt: 'not-a-date' }),
    );
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /scannedAt/);
  });
});

describe('processPublishStatus — POST flow', () => {
  it('returns 200 on valid HMAC + valid payload', () => {
    const rawBody = JSON.stringify(validPayload());
    const result = helper.processPublishStatus({
      rawBody,
      signatureHeader: hmacHeader(rawBody),
      env: { GATETEST_INTERNAL_TOKEN: SECRET },
    });
    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.body.stored, true);
  });

  it('returns 401 when signature header missing', () => {
    const rawBody = JSON.stringify(validPayload());
    const result = helper.processPublishStatus({
      rawBody,
      signatureHeader: null,
      env: { GATETEST_INTERNAL_TOKEN: SECRET },
    });
    assert.strictEqual(result.status, 401);
    assert.match(result.body.error, /missing signature/);
  });

  it('returns 403 when signature is wrong', () => {
    const rawBody = JSON.stringify(validPayload());
    const result = helper.processPublishStatus({
      rawBody,
      signatureHeader: hmacHeader('different-body'),
      env: { GATETEST_INTERNAL_TOKEN: SECRET },
    });
    assert.strictEqual(result.status, 403);
    assert.match(result.body.error, /invalid signature/);
  });

  it('returns 400 on malformed JSON body', () => {
    const rawBody = 'not-json';
    const result = helper.processPublishStatus({
      rawBody,
      signatureHeader: hmacHeader(rawBody),
      env: { GATETEST_INTERNAL_TOKEN: SECRET },
    });
    assert.strictEqual(result.status, 400);
    assert.match(result.body.error, /malformed/);
  });

  it('returns 400 on payload validation failure', () => {
    const rawBody = JSON.stringify(validPayload({ gateStatus: 'NOPE' }));
    const result = helper.processPublishStatus({
      rawBody,
      signatureHeader: hmacHeader(rawBody),
      env: { GATETEST_INTERNAL_TOKEN: SECRET },
    });
    assert.strictEqual(result.status, 400);
    assert.match(result.body.error, /gateStatus/);
  });

  it('returns 503 when secret env var is unset (fail-closed)', () => {
    const rawBody = JSON.stringify(validPayload());
    const result = helper.processPublishStatus({
      rawBody,
      signatureHeader: hmacHeader(rawBody),
      env: {}, // no GATETEST_INTERNAL_TOKEN
    });
    assert.strictEqual(result.status, 503);
    assert.match(result.body.error, /secret/);
  });
});

describe('getLatestStatus — GET flow', () => {
  it('returns no-data when nothing has been published', () => {
    const result = helper.getLatestStatus();
    assert.strictEqual(result.status, 'no-data');
    assert.match(result.message, /Awaiting first self-scan/);
  });

  it('returns the stored stats after a successful POST', () => {
    const rawBody = JSON.stringify(validPayload());
    helper.processPublishStatus({
      rawBody,
      signatureHeader: hmacHeader(rawBody),
      env: { GATETEST_INTERNAL_TOKEN: SECRET },
      nowMs: 1_700_000_000_000,
    });
    const result = helper.getLatestStatus(1_700_000_000_000);
    assert.strictEqual(result.gateStatus, 'PASSED');
    assert.strictEqual(result.errorCount, 0);
    assert.strictEqual(result.warningCount, 12);
    assert.strictEqual(result.modulesPassedCount, 91);
    assert.strictEqual(result.modulesTotalCount, 91);
    assert.strictEqual(result.commitSha, 'abc1234');
    assert.strictEqual(result.ageMinutes, 0);
  });

  it('computes ageMinutes correctly', () => {
    const rawBody = JSON.stringify(validPayload());
    helper.processPublishStatus({
      rawBody,
      signatureHeader: hmacHeader(rawBody),
      env: { GATETEST_INTERNAL_TOKEN: SECRET },
      nowMs: 1_700_000_000_000,
    });
    // 4 minutes later
    const result = helper.getLatestStatus(1_700_000_000_000 + 4 * 60_000);
    assert.strictEqual(result.ageMinutes, 4);
  });

  it('treats negative time-delta (clock skew) as 0 age', () => {
    const rawBody = JSON.stringify(validPayload());
    helper.processPublishStatus({
      rawBody,
      signatureHeader: hmacHeader(rawBody),
      env: { GATETEST_INTERNAL_TOKEN: SECRET },
      nowMs: 1_700_000_000_000,
    });
    // simulated past
    const result = helper.getLatestStatus(1_699_999_000_000);
    assert.strictEqual(result.ageMinutes, 0);
  });

  it('preserves state across POST and a subsequent GET (warm-instance behaviour)', () => {
    const rawBody = JSON.stringify(validPayload({ commitSha: 'deadbee' }));
    helper.processPublishStatus({
      rawBody,
      signatureHeader: hmacHeader(rawBody),
      env: { GATETEST_INTERNAL_TOKEN: SECRET },
    });
    // Simulate a second arrival
    const result = helper.getLatestStatus();
    assert.strictEqual(result.commitSha, 'deadbee');
  });

  it('overwrites latest on a fresh POST and preserves history', () => {
    const first = JSON.stringify(validPayload({ commitSha: 'aaa1111' }));
    helper.processPublishStatus({
      rawBody: first,
      signatureHeader: hmacHeader(first),
      env: { GATETEST_INTERNAL_TOKEN: SECRET },
    });
    const second = JSON.stringify(
      validPayload({ commitSha: 'bbb2222', gateStatus: 'BLOCKED', errorCount: 3 }),
    );
    helper.processPublishStatus({
      rawBody: second,
      signatureHeader: hmacHeader(second),
      env: { GATETEST_INTERNAL_TOKEN: SECRET },
    });
    const latest = helper.getLatestStatus();
    assert.strictEqual(latest.commitSha, 'bbb2222');
    assert.strictEqual(latest.gateStatus, 'BLOCKED');

    const history = helper.getHistory();
    // Most-recent-first.
    assert.strictEqual(history.length, 2);
    assert.strictEqual(history[0].commitSha, 'bbb2222');
    assert.strictEqual(history[1].commitSha, 'aaa1111');
  });
});

describe('getHistory — bounded ring buffer', () => {
  it('caps at HISTORY_LIMIT entries', () => {
    const total = helper.HISTORY_LIMIT + 5;
    for (let i = 0; i < total; i++) {
      const sha = `c${String(i).padStart(6, '0')}`; // 7 chars, hex-shaped
      const body = JSON.stringify(validPayload({ commitSha: sha }));
      helper.processPublishStatus({
        rawBody: body,
        signatureHeader: hmacHeader(body),
        env: { GATETEST_INTERNAL_TOKEN: SECRET },
      });
    }
    const history = helper.getHistory();
    assert.strictEqual(history.length, helper.HISTORY_LIMIT);
    // Most recent first — the LAST one we pushed should be at index 0.
    assert.strictEqual(history[0].commitSha, `c${String(total - 1).padStart(6, '0')}`);
  });

  it('returns an empty array before any POST', () => {
    const history = helper.getHistory();
    assert.deepStrictEqual(history, []);
  });
});
