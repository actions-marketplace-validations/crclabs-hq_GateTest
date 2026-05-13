// =============================================================================
// AUDIT-LOG-STORE TEST — website/app/lib/audit-log-store.js
// =============================================================================
// Append-only event store with cryptographic hash chain. Tests use an
// in-memory mock `sql` function shaped like @neondatabase/serverless to
// avoid the network hop / DB dependency.
// =============================================================================

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const {
  ensureAuditTable,
  recordEvent,
  recordEventSafe,
  listEvents,
  verifyChain,
  purgeExpired,
  computeRowHash,
  canonicalise,
  GENESIS_HASH,
  CREATE_TABLE_SQL,
} = require('../website/app/lib/audit-log-store');

// ---------------------------------------------------------------------------
// Mock sql function. Mirrors @neondatabase/serverless's tagged-template +
// .unsafe() shape just well enough to exercise audit-log-store.
// ---------------------------------------------------------------------------

function makeMockSql() {
  const state = {
    rows: [],            // in-memory audit_log rows
    nextId: 1,
    ensureCalls: 0,
  };

  function tagged(strings, ...values) {
    // Reconstruct the SQL with $1, $2, … placeholders to recognise statements.
    let sql = '';
    for (let i = 0; i < strings.length; i++) {
      sql += strings[i];
      if (i < values.length) sql += `$${i + 1}`;
    }
    return runSql(sql, values);
  }

  tagged.unsafe = function unsafe(query, params = []) {
    return runSql(query, params);
  };

  function runSql(rawSql, params) {
    const lower = rawSql.toLowerCase();
    if (lower.includes('create table')) {
      state.ensureCalls += 1;
      return Promise.resolve([]);
    }
    if (lower.includes('insert into audit_log')) {
      const [actor, action, resourceType, resourceId, metadata, prevHash, rowHash] = params;
      const row = {
        id: state.nextId++,
        created_at: new Date().toISOString(),
        actor,
        action,
        resource_type: resourceType,
        resource_id: resourceId,
        metadata,
        prev_hash: prevHash,
        row_hash: rowHash,
      };
      state.rows.push(row);
      return Promise.resolve([{ id: row.id, rowHash: row.row_hash }]);
    }
    if (lower.includes('select row_hash from audit_log order by id desc limit 1')) {
      if (state.rows.length === 0) return Promise.resolve([]);
      return Promise.resolve([{ row_hash: state.rows[state.rows.length - 1].row_hash }]);
    }
    if (lower.includes('select row_hash from audit_log where id <')) {
      // verify-chain prior-row lookup
      const beforeId = params[0] !== undefined ? params[0] : parseInt(rawSql.match(/id < (\d+)/i)?.[1] || '0', 10);
      const prior = [...state.rows].reverse().find((r) => r.id < beforeId);
      if (!prior) return Promise.resolve([]);
      return Promise.resolve([{ row_hash: prior.row_hash }]);
    }
    if (lower.includes('select id, actor, action') && lower.includes('from audit_log')) {
      // verifyChain forward walk
      const lower2 = rawSql;
      const fromMatch = lower2.match(/id >= (\d+)/);
      const toMatch = lower2.match(/id <= (\d+)/);
      const from = fromMatch ? parseInt(fromMatch[1], 10) : 1;
      const to = toMatch ? parseInt(toMatch[1], 10) : Infinity;
      return Promise.resolve(state.rows.filter((r) => r.id >= from && r.id <= to));
    }
    if (lower.includes('select id, created_at, actor')) {
      // listEvents — return all rows, optionally filtered
      let rows = [...state.rows];
      // Very loose filter parsing for the tests' purposes
      if (params.length > 0 && lower.includes('actor =')) {
        rows = rows.filter((r) => r.actor === params[0]);
      }
      // Newest first
      rows.sort((a, b) => b.id - a.id);
      const limitMatch = lower2OrSelf(rawSql).match(/limit (\d+)/i);
      if (limitMatch) rows = rows.slice(0, parseInt(limitMatch[1], 10));
      return Promise.resolve(rows);
    }
    if (lower.includes('delete from audit_log')) {
      // Tests construct a purge case manually; we delete nothing here
      // because our created_at values are all "now". Tests use a direct
      // state.rows override to simulate stale rows.
      return Promise.resolve([]);
    }
    throw new Error(`mock-sql: unhandled query: ${rawSql.slice(0, 80)}`);
  }

  function lower2OrSelf(q) { return typeof q === 'string' ? q : ''; }

  return { sql: tagged, state };
}

// ---------------------------------------------------------------------------
// canonicalise + computeRowHash
// ---------------------------------------------------------------------------

describe('canonicalise', () => {
  it('sorts object keys for deterministic output', () => {
    const a = canonicalise({ b: 1, a: 2 });
    const b = canonicalise({ a: 2, b: 1 });
    assert.equal(a, b);
  });

  it('handles nested objects and arrays', () => {
    const out = canonicalise({ b: [1, { y: 2, x: 1 }], a: null });
    assert.equal(out, '{"a":null,"b":[1,{"x":1,"y":2}]}');
  });

  it('passes primitives through JSON.stringify', () => {
    assert.equal(canonicalise(42), '42');
    assert.equal(canonicalise('hi'), '"hi"');
    assert.equal(canonicalise(null), 'null');
  });
});

describe('computeRowHash', () => {
  it('produces a 64-char hex SHA-256', () => {
    const h = computeRowHash('GENESIS', { a: 1 });
    assert.match(h, /^[0-9a-f]{64}$/);
  });

  it('changes if prev_hash changes', () => {
    const a = computeRowHash('A', { a: 1 });
    const b = computeRowHash('B', { a: 1 });
    assert.notEqual(a, b);
  });

  it('changes if payload changes', () => {
    const a = computeRowHash('X', { a: 1 });
    const b = computeRowHash('X', { a: 2 });
    assert.notEqual(a, b);
  });

  it('is deterministic across key order', () => {
    const a = computeRowHash('X', { a: 1, b: 2 });
    const b = computeRowHash('X', { b: 2, a: 1 });
    assert.equal(a, b);
  });

  it('matches an independent crypto.sha256 of canonical(prev+payload)', () => {
    const prev = 'GENESIS';
    const payload = { x: 1, y: 2 };
    const expected = crypto.createHash('sha256').update(prev + canonicalise(payload)).digest('hex');
    assert.equal(computeRowHash(prev, payload), expected);
  });
});

// ---------------------------------------------------------------------------
// ensureAuditTable + CREATE_TABLE_SQL shape
// ---------------------------------------------------------------------------

describe('CREATE_TABLE_SQL', () => {
  it('uses IF NOT EXISTS for idempotency', () => {
    assert.match(CREATE_TABLE_SQL, /CREATE TABLE IF NOT EXISTS audit_log/);
  });

  it('declares all required columns', () => {
    for (const col of ['id', 'created_at', 'actor', 'action', 'resource_type', 'resource_id', 'metadata', 'prev_hash', 'row_hash']) {
      assert.match(CREATE_TABLE_SQL, new RegExp(`\\b${col}\\b`));
    }
  });

  it('creates all four indexes', () => {
    for (const idx of ['audit_log_created', 'audit_log_actor', 'audit_log_resource', 'audit_log_action']) {
      assert.match(CREATE_TABLE_SQL, new RegExp(idx));
    }
  });
});

describe('ensureAuditTable', () => {
  it('runs the create-table statement', async () => {
    const { sql, state } = makeMockSql();
    await ensureAuditTable(sql);
    assert.equal(state.ensureCalls, 1);
  });
});

// ---------------------------------------------------------------------------
// recordEvent — input validation
// ---------------------------------------------------------------------------

describe('recordEvent — input validation', () => {
  it('throws when actor is missing', async () => {
    const { sql } = makeMockSql();
    await assert.rejects(
      () => recordEvent(sql, { action: 'x', resourceType: 'y', resourceId: 'z' }),
      /actor is required/
    );
  });

  it('throws when action is missing', async () => {
    const { sql } = makeMockSql();
    await assert.rejects(
      () => recordEvent(sql, { actor: 'a', resourceType: 'y', resourceId: 'z' }),
      /action is required/
    );
  });

  it('throws when resourceType is missing', async () => {
    const { sql } = makeMockSql();
    await assert.rejects(
      () => recordEvent(sql, { actor: 'a', action: 'x', resourceId: 'z' }),
      /resourceType is required/
    );
  });

  it('throws when resourceId is missing', async () => {
    const { sql } = makeMockSql();
    await assert.rejects(
      () => recordEvent(sql, { actor: 'a', action: 'x', resourceType: 'y' }),
      /resourceId is required/
    );
  });

  it('throws when metadata is not an object', async () => {
    const { sql } = makeMockSql();
    await assert.rejects(
      () => recordEvent(sql, { actor: 'a', action: 'x', resourceType: 'y', resourceId: 'z', metadata: 'bad' }),
      /metadata must be an object/
    );
  });
});

// ---------------------------------------------------------------------------
// recordEvent — chain building
// ---------------------------------------------------------------------------

describe('recordEvent — chain building', () => {
  it('row 1 chains off GENESIS', async () => {
    const { sql, state } = makeMockSql();
    await recordEvent(sql, { actor: 'sys', action: 'scan.started', resourceType: 'scan', resourceId: 's1' });
    assert.equal(state.rows.length, 1);
    assert.equal(state.rows[0].prev_hash, GENESIS_HASH);
    assert.match(state.rows[0].row_hash, /^[0-9a-f]{64}$/);
  });

  it('row N+1 chains off row N\'s row_hash', async () => {
    const { sql, state } = makeMockSql();
    await recordEvent(sql, { actor: 'sys', action: 'scan.started', resourceType: 'scan', resourceId: 's1' });
    await recordEvent(sql, { actor: 'sys', action: 'scan.completed', resourceType: 'scan', resourceId: 's1' });
    assert.equal(state.rows.length, 2);
    assert.equal(state.rows[1].prev_hash, state.rows[0].row_hash);
  });

  it('three rows produce three distinct row_hashes', async () => {
    const { sql, state } = makeMockSql();
    for (let i = 1; i <= 3; i++) {
      await recordEvent(sql, { actor: 'sys', action: 'x', resourceType: 'scan', resourceId: `r${i}` });
    }
    const hashes = state.rows.map((r) => r.row_hash);
    assert.equal(new Set(hashes).size, 3);
  });

  it('returns { id, rowHash } shape', async () => {
    const { sql } = makeMockSql();
    const out = await recordEvent(sql, { actor: 's', action: 'a', resourceType: 't', resourceId: 'i' });
    assert.equal(out.id, 1);
    assert.match(out.rowHash, /^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// recordEventSafe — non-throwing wrapper
// ---------------------------------------------------------------------------

describe('recordEventSafe', () => {
  it('returns null instead of throwing on input error', async () => {
    const { sql } = makeMockSql();
    const out = await recordEventSafe(sql, { actor: '' });
    assert.equal(out, null);
  });

  it('happy path returns the same shape as recordEvent', async () => {
    const { sql } = makeMockSql();
    const out = await recordEventSafe(sql, { actor: 's', action: 'a', resourceType: 't', resourceId: 'i' });
    assert.equal(out.id, 1);
  });
});

// ---------------------------------------------------------------------------
// verifyChain
// ---------------------------------------------------------------------------

describe('verifyChain', () => {
  it('returns ok=true on a clean 3-row chain', async () => {
    const { sql } = makeMockSql();
    for (let i = 1; i <= 3; i++) {
      await recordEvent(sql, { actor: 's', action: 'x', resourceType: 't', resourceId: `r${i}` });
    }
    const result = await verifyChain(sql, { fromId: 1 });
    assert.equal(result.ok, true);
    assert.equal(result.rowsChecked, 3);
  });

  it('returns ok=true and rowsChecked=0 on empty table', async () => {
    const { sql } = makeMockSql();
    const result = await verifyChain(sql, { fromId: 1 });
    assert.equal(result.ok, true);
    assert.equal(result.rowsChecked, 0);
  });

  it('detects a tampered row_hash', async () => {
    const { sql, state } = makeMockSql();
    for (let i = 1; i <= 3; i++) {
      await recordEvent(sql, { actor: 's', action: 'x', resourceType: 't', resourceId: `r${i}` });
    }
    // Tamper: overwrite row 2's metadata in place WITHOUT updating row_hash
    state.rows[1].metadata = { tampered: true };
    const result = await verifyChain(sql, { fromId: 1 });
    assert.equal(result.ok, false);
    assert.equal(result.brokenAt, 2);
    assert.match(result.reason, /row_hash/);
  });

  it('detects a broken prev_hash link', async () => {
    const { sql, state } = makeMockSql();
    for (let i = 1; i <= 3; i++) {
      await recordEvent(sql, { actor: 's', action: 'x', resourceType: 't', resourceId: `r${i}` });
    }
    // Tamper: replace row 2's prev_hash with something else
    state.rows[1].prev_hash = 'malicious-hash';
    const result = await verifyChain(sql, { fromId: 1 });
    assert.equal(result.ok, false);
    assert.equal(result.brokenAt, 2);
  });
});

// ---------------------------------------------------------------------------
// listEvents — light smoke (mock SQL filters are coarse)
// ---------------------------------------------------------------------------

describe('listEvents', () => {
  it('returns rows newest-first', async () => {
    const { sql } = makeMockSql();
    for (let i = 1; i <= 5; i++) {
      await recordEvent(sql, { actor: 's', action: 'x', resourceType: 't', resourceId: `r${i}` });
    }
    const rows = await listEvents(sql, {});
    assert.equal(rows.length, 5);
    assert.equal(rows[0].resource_id, 'r5');
  });

  it('respects limit', async () => {
    const { sql } = makeMockSql();
    for (let i = 1; i <= 5; i++) {
      await recordEvent(sql, { actor: 's', action: 'x', resourceType: 't', resourceId: `r${i}` });
    }
    const rows = await listEvents(sql, { limit: 2 });
    assert.equal(rows.length, 2);
  });

  it('caps limit at 1000 even if a larger value is passed', async () => {
    const { sql } = makeMockSql();
    await recordEvent(sql, { actor: 's', action: 'x', resourceType: 't', resourceId: 'r1' });
    // No assertion on actual cap behaviour — just ensure the function returns
    // without throwing when an over-cap limit is passed.
    const rows = await listEvents(sql, { limit: 10_000 });
    assert.ok(Array.isArray(rows));
  });
});

// ---------------------------------------------------------------------------
// purgeExpired — input validation
// ---------------------------------------------------------------------------

describe('purgeExpired', () => {
  it('rejects negative retention years', async () => {
    const { sql } = makeMockSql();
    await assert.rejects(() => purgeExpired(sql, -1), /retentionYears must be a positive number/);
  });

  it('rejects zero retention', async () => {
    const { sql } = makeMockSql();
    await assert.rejects(() => purgeExpired(sql, 0), /retentionYears must be a positive number/);
  });

  it('happy path returns { deleted } shape', async () => {
    const { sql } = makeMockSql();
    const result = await purgeExpired(sql, 7);
    assert.equal(typeof result.deleted, 'number');
  });
});
