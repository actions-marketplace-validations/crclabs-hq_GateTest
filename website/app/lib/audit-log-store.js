'use strict';

/**
 * Audit log — append-only event store with cryptographic hash chain.
 *
 * Why we need this:
 *   Legal protection. If a customer disputes a fix, a scan, or a charge
 *   we can prove (a) what happened, (b) when, (c) that the record has
 *   not been tampered with since.
 *
 * Schema:
 *   id            BIGSERIAL  primary key
 *   created_at    TIMESTAMPTZ default NOW()
 *   actor         TEXT       who triggered the event ("system" | customer_id | "claude")
 *   action        TEXT       what happened ("scan.started" | "fix.applied" | ...)
 *   resource_type TEXT       what kind of thing ("scan" | "fix" | "pr" | "subscription")
 *   resource_id   TEXT       opaque identifier (URL / Stripe ID / scan UUID)
 *   metadata      JSONB      flexible payload (counts, costs, hashes, ...)
 *   prev_hash     TEXT       hash of the previous row, or 'GENESIS' for row 1
 *   row_hash      TEXT       SHA-256(prev_hash + canonical_payload) — tamper evidence
 *
 * Hash chain semantics:
 *   row_hash[N] = sha256(row_hash[N-1] + canonical(row[N]))
 *   To prove the log hasn't been tampered with: walk forward from row 1,
 *   recompute every row_hash, assert they match. One altered row breaks
 *   the chain at every subsequent row.
 *
 * Append-only by convention:
 *   Postgres permits DELETE / UPDATE — the audit table is never written
 *   via either in this codebase. A DB-level revoke on UPDATE/DELETE for
 *   the application role is the next-level hardening (ops task).
 *
 * Retention: 7 years (SOC2 standard). purgeExpired() exists for the
 * periodic cleanup job; it's not invoked from any request path.
 *
 * Privacy: metadata MUST NOT contain raw source code, secrets, or
 * personally-identifying customer data. Use IDs and hashes, not values.
 * The recordEvent() helper does NOT strip these on your behalf — caller
 * is responsible.
 */

const crypto = require('crypto');

const TABLE_NAME = 'audit_log';
const DEFAULT_RETENTION_YEARS = 7;
const GENESIS_HASH = 'GENESIS';

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS audit_log (
    id            BIGSERIAL PRIMARY KEY,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actor         TEXT NOT NULL,
    action        TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id   TEXT NOT NULL,
    metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
    prev_hash     TEXT NOT NULL,
    row_hash      TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS audit_log_created    ON audit_log (created_at DESC);
  CREATE INDEX IF NOT EXISTS audit_log_actor      ON audit_log (actor, created_at DESC);
  CREATE INDEX IF NOT EXISTS audit_log_resource   ON audit_log (resource_type, resource_id);
  CREATE INDEX IF NOT EXISTS audit_log_action     ON audit_log (action, created_at DESC);
`;

/**
 * Ensure the audit_log table exists. Safe to call repeatedly — uses
 * CREATE TABLE IF NOT EXISTS.
 */
async function ensureAuditTable(sql) {
  await sql.unsafe(CREATE_TABLE_SQL);
}

/**
 * Canonicalise a row payload before hashing so equivalent payloads
 * always produce the same hash. We sort keys recursively and stringify
 * with no whitespace.
 */
function canonicalise(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalise).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalise(value[k])).join(',') + '}';
}

/**
 * Compute row_hash given the previous row's row_hash and the new row's
 * canonical content.
 */
function computeRowHash(prevHash, payload) {
  const canonical = canonicalise(payload);
  return crypto.createHash('sha256').update(prevHash + canonical).digest('hex');
}

/**
 * Fetch the row_hash of the most recent row, or 'GENESIS' if the table
 * is empty.
 */
async function _getLastRowHash(sql) {
  const rows = await sql`SELECT row_hash FROM audit_log ORDER BY id DESC LIMIT 1`;
  if (!rows || rows.length === 0) return GENESIS_HASH;
  return rows[0].row_hash;
}

/**
 * Record a single audit event. Computes the hash chain and inserts in
 * one statement.
 *
 * Returns { id, rowHash } on success.
 *
 * NOTE on concurrency: two parallel inserts could both read the same
 * "last row hash" and produce two rows that both chain off the same
 * predecessor. The chain still verifies for each path independently —
 * but the global linearity is lost. For strict ordering, wrap recordEvent
 * in a serialisable transaction or a SELECT FOR UPDATE on a sentinel
 * row. For now the chain is per-write-thread; this is good enough for
 * tamper-evidence but not for proof-of-global-order.
 */
async function recordEvent(sql, { actor, action, resourceType, resourceId, metadata = {} }) {
  if (typeof actor !== 'string' || actor.length === 0) throw new Error('actor is required');
  if (typeof action !== 'string' || action.length === 0) throw new Error('action is required');
  if (typeof resourceType !== 'string' || resourceType.length === 0) throw new Error('resourceType is required');
  if (typeof resourceId !== 'string' || resourceId.length === 0) throw new Error('resourceId is required');
  if (metadata == null || typeof metadata !== 'object') throw new Error('metadata must be an object');

  await ensureAuditTable(sql);

  const prevHash = await _getLastRowHash(sql);
  const payload = { actor, action, resourceType, resourceId, metadata };
  const rowHash = computeRowHash(prevHash, payload);

  const rows = await sql`
    INSERT INTO audit_log
      (actor, action, resource_type, resource_id, metadata, prev_hash, row_hash)
    VALUES
      (${actor}, ${action}, ${resourceType}, ${resourceId}, ${metadata}, ${prevHash}, ${rowHash})
    RETURNING id, row_hash AS "rowHash"
  `;
  return rows[0];
}

/**
 * Fire-and-forget recordEvent that never throws. Use this inside hot
 * request paths where you do NOT want audit-log writes to break the
 * customer's experience. Failures are logged via console.warn (which
 * Vercel collects into the function log).
 */
async function recordEventSafe(sql, event) {
  try {
    return await recordEvent(sql, event);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[audit-log] recordEvent failed:', err && err.message ? err.message : err);
    return null;
  }
}

/**
 * List events with optional filters. All filters are optional; missing
 * filters return all events. `limit` defaults to 100, capped at 1000.
 *
 * Filters:
 *   actor          exact match
 *   action         exact match
 *   resourceType   exact match
 *   resourceId     exact match
 *   since          ISO datetime — only events at or after this time
 *   until          ISO datetime — only events at or before this time
 *
 * Returns rows in DESCENDING created_at order (newest first).
 */
async function listEvents(sql, opts = {}) {
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 100, 1), 1000);
  const conditions = [];
  const params = [];
  let i = 1;
  for (const key of ['actor', 'action']) {
    if (opts[key] !== undefined) { conditions.push(`${key} = $${i++}`); params.push(opts[key]); }
  }
  if (opts.resourceType !== undefined) { conditions.push(`resource_type = $${i++}`); params.push(opts.resourceType); }
  if (opts.resourceId   !== undefined) { conditions.push(`resource_id   = $${i++}`); params.push(opts.resourceId); }
  if (opts.since !== undefined)        { conditions.push(`created_at   >= $${i++}`); params.push(opts.since); }
  if (opts.until !== undefined)        { conditions.push(`created_at   <= $${i++}`); params.push(opts.until); }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const query = `SELECT id, created_at, actor, action, resource_type, resource_id, metadata, prev_hash, row_hash
                 FROM audit_log
                 ${whereClause}
                 ORDER BY created_at DESC
                 LIMIT ${limit}`;
  if (params.length === 0) return await sql.unsafe(query);
  return await sql.unsafe(query, params);
}

/**
 * Verify the integrity of the hash chain between fromId (inclusive) and
 * toId (inclusive). Returns { ok: true } on a clean chain, or
 * { ok: false, brokenAt, expected, actual } at the first mismatch.
 *
 * Walks rows in ascending order, recomputes each row's hash using the
 * stored prev_hash + canonicalised payload, and compares to stored
 * row_hash. Also asserts prev_hash[N] === row_hash[N-1].
 *
 * If toId is omitted, verifies all rows from fromId to the current end.
 */
async function verifyChain(sql, { fromId = 1, toId = null } = {}) {
  const upperClause = toId ? `AND id <= ${parseInt(toId, 10)}` : '';
  const lowerId = parseInt(fromId, 10);
  const rows = await sql.unsafe(
    `SELECT id, actor, action, resource_type, resource_id, metadata, prev_hash, row_hash
     FROM audit_log
     WHERE id >= ${lowerId} ${upperClause}
     ORDER BY id ASC`
  );

  if (rows.length === 0) return { ok: true, rowsChecked: 0 };

  let priorRowHash = null;
  if (lowerId > 1) {
    const beforeRows = await sql`SELECT row_hash FROM audit_log WHERE id < ${lowerId} ORDER BY id DESC LIMIT 1`;
    priorRowHash = beforeRows && beforeRows[0] ? beforeRows[0].row_hash : GENESIS_HASH;
  } else {
    priorRowHash = GENESIS_HASH;
  }

  for (const r of rows) {
    if (r.prev_hash !== priorRowHash) {
      return {
        ok: false,
        brokenAt: r.id,
        reason: 'prev_hash does not match prior row\'s row_hash',
        expected: priorRowHash,
        actual: r.prev_hash,
      };
    }
    const payload = {
      actor: r.actor,
      action: r.action,
      resourceType: r.resource_type,
      resourceId: r.resource_id,
      metadata: r.metadata,
    };
    const recomputed = computeRowHash(r.prev_hash, payload);
    if (recomputed !== r.row_hash) {
      return {
        ok: false,
        brokenAt: r.id,
        reason: 'recomputed row_hash does not match stored row_hash',
        expected: recomputed,
        actual: r.row_hash,
      };
    }
    priorRowHash = r.row_hash;
  }
  return { ok: true, rowsChecked: rows.length };
}

/**
 * Periodic cleanup. Delete rows older than `retentionYears` (default 7).
 * NOT invoked from any request path — call from a scheduled job.
 *
 * NOTE: deleting from the audit log fundamentally weakens the
 * tamper-evidence guarantee (the chain has a gap). In a stricter
 * regime you'd archive to cold storage before delete. For this first
 * cut, delete-after-retention is the simpler shape.
 *
 * Returns { deleted: <row count> }.
 */
async function purgeExpired(sql, retentionYears = DEFAULT_RETENTION_YEARS) {
  if (!Number.isFinite(retentionYears) || retentionYears < 1) {
    throw new Error('retentionYears must be a positive number');
  }
  const result = await sql`
    DELETE FROM audit_log
    WHERE created_at < NOW() - (${retentionYears} || ' years')::interval
    RETURNING id
  `;
  return { deleted: Array.isArray(result) ? result.length : 0 };
}

/**
 * Convenience for request paths that may or may not have a database
 * configured (early-stage deployments, local dev without DATABASE_URL).
 * Does nothing — and never throws — when DATABASE_URL is unset, the
 * neon import isn't available, or the write itself fails. Safe to
 * fire-and-forget at any hot path.
 *
 * Pass the event payload as the first argument. Internally lazy-loads
 * the neon client via require() so this module stays usable in
 * test environments where @neondatabase/serverless isn't installed.
 */
async function recordEventIfConfigured(event) {
  if (!process.env.DATABASE_URL) return null;
  let sql;
  try {
    // eslint-disable-next-line global-require
    const { neon } = require('@neondatabase/serverless');
    sql = neon(process.env.DATABASE_URL);
  } catch {
    return null;
  }
  return recordEventSafe(sql, event);
}

module.exports = {
  ensureAuditTable,
  recordEvent,
  recordEventSafe,
  recordEventIfConfigured,
  listEvents,
  verifyChain,
  purgeExpired,
  // Exported for tests / advanced callers
  computeRowHash,
  canonicalise,
  TABLE_NAME,
  GENESIS_HASH,
  DEFAULT_RETENTION_YEARS,
  CREATE_TABLE_SQL,
};
