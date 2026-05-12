/**
 * Phase 5.3.1 — external integrations store.
 *
 * Polymorphic storage for customer ↔ third-party connections (Sentry,
 * Datadog, Vercel Analytics, etc.). Same shape across vendors so the
 * runtime-correlator (5.3.4) can iterate uniformly: "for each integration
 * the customer has connected, fetch the top errors and correlate against
 * the static findings."
 *
 * PRIVACY CONTRACT:
 *   - Cleartext access tokens NEVER reach the database. We encrypt with
 *     INTEGRATIONS_SECRET (must be set; refusing to start without it is
 *     correct — failing closed beats accidentally storing tokens in
 *     cleartext if the env var is missing).
 *   - Repo URL hashed (same hashRepoUrl as scan-fingerprint-store).
 *   - Vendor org/project IDs stored as-is (they're public identifiers).
 *
 * Same DI pattern as every other store: caller injects the sql tagged-
 * template; tests inject a fake-sql harness.
 */

const crypto = require('crypto');

/**
 * Vendors we support. Adding a new vendor here is a coordinated change
 * with the OAuth callback route + the runtime correlator.
 */
const VENDORS = Object.freeze({
  SENTRY: 'sentry',
  DATADOG: 'datadog',
  VERCEL_ANALYTICS: 'vercel_analytics',
});

const SUPPORTED_VENDORS = Object.values(VENDORS);

/**
 * Symmetric encryption for access tokens. Uses AES-256-GCM with a
 * per-token random IV. The key is derived from INTEGRATIONS_SECRET so
 * a single env-var rotation invalidates all stored tokens (which is
 * actually what we want when a secret leaks).
 */
function getEncryptionKey() {
  const secret = process.env.INTEGRATIONS_SECRET || '';
  if (!secret || secret.length < 32) {
    throw new Error(
      'INTEGRATIONS_SECRET env var is required (≥32 chars). ' +
      'Refusing to handle access tokens without it — fail-closed is the right posture.'
    );
  }
  return crypto.createHash('sha256').update(secret).digest();
}

/**
 * Encrypt an access token. Output: "iv:tag:ciphertext" hex-encoded
 * triplet, single column, decrypts back exactly.
 */
function encryptToken(token) {
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('encryptToken: token must be a non-empty string');
  }
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('hex'), tag.toString('hex'), ct.toString('hex')].join(':');
}

/**
 * Decrypt an access token. Throws if the ciphertext was tampered with
 * (auth tag mismatch) or the secret has rotated since encryption.
 */
function decryptToken(encrypted) {
  if (typeof encrypted !== 'string' || !encrypted.includes(':')) {
    throw new Error('decryptToken: malformed ciphertext');
  }
  const parts = encrypted.split(':');
  if (parts.length !== 3) throw new Error('decryptToken: malformed ciphertext');
  const [ivHex, tagHex, ctHex] = parts;
  const key = getEncryptionKey();
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const ct = Buffer.from(ctHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/**
 * Idempotent migration. Same DI pattern as every other store.
 */
async function ensureExternalIntegrationsTable(sql) {
  if (typeof sql !== 'function') throw new Error('ensureExternalIntegrationsTable: sql is required');
  await sql`CREATE TABLE IF NOT EXISTS external_integrations (
    id BIGSERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    repo_url_hash TEXT NOT NULL,
    vendor TEXT NOT NULL,
    org_id TEXT NOT NULL,
    project_id TEXT,
    access_token_enc TEXT NOT NULL,
    refresh_token_enc TEXT,
    expires_at TIMESTAMPTZ,
    scope TEXT,
    last_used_at TIMESTAMPTZ,
    UNIQUE (repo_url_hash, vendor, org_id, project_id)
  )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_ext_int_repo_vendor
    ON external_integrations (repo_url_hash, vendor)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_ext_int_vendor_updated
    ON external_integrations (vendor, updated_at DESC)`;
}

/**
 * Connect a customer's repo to a third-party. Encrypts both tokens
 * before binding. Idempotent — re-connecting the same (repo, vendor,
 * org, project) refreshes the credentials in-place.
 */
async function connectIntegration(opts) {
  const {
    sql, repoUrl, vendor, orgId, projectId = null,
    accessToken, refreshToken = null, expiresAt = null, scope = null,
  } = opts;
  if (typeof sql !== 'function') throw new Error('connectIntegration: sql is required');
  if (!repoUrl) throw new Error('connectIntegration: repoUrl is required');
  if (!vendor || !SUPPORTED_VENDORS.includes(vendor)) {
    throw new Error(`connectIntegration: vendor must be one of ${SUPPORTED_VENDORS.join(', ')}`);
  }
  if (!orgId) throw new Error('connectIntegration: orgId is required');
  if (!accessToken) throw new Error('connectIntegration: accessToken is required');

   
  const { hashRepoUrl } = require('./scan-fingerprint-store.js');
  const repoUrlHash = hashRepoUrl(repoUrl);
  const accessTokenEnc = encryptToken(accessToken);
  const refreshTokenEnc = refreshToken ? encryptToken(refreshToken) : null;

  const rows = await sql`
    INSERT INTO external_integrations (
      repo_url_hash, vendor, org_id, project_id,
      access_token_enc, refresh_token_enc, expires_at, scope, updated_at
    ) VALUES (
      ${repoUrlHash}, ${vendor}, ${orgId}, ${projectId},
      ${accessTokenEnc}, ${refreshTokenEnc}, ${expiresAt}, ${scope}, NOW()
    )
    ON CONFLICT (repo_url_hash, vendor, org_id, project_id) DO UPDATE SET
      access_token_enc = EXCLUDED.access_token_enc,
      refresh_token_enc = EXCLUDED.refresh_token_enc,
      expires_at = EXCLUDED.expires_at,
      scope = EXCLUDED.scope,
      updated_at = NOW()
    RETURNING id
  `;
  const id = rows && rows[0] ? rows[0].id : null;
  return { id };
}

/**
 * Fetch + decrypt an integration's tokens. Used by the runtime
 * correlator (5.3.4) before calling the vendor's API.
 */
async function getIntegrationCredentials(opts) {
  const { sql, repoUrl, vendor } = opts;
  if (typeof sql !== 'function') throw new Error('getIntegrationCredentials: sql is required');
  if (!repoUrl) throw new Error('getIntegrationCredentials: repoUrl is required');
  if (!vendor) throw new Error('getIntegrationCredentials: vendor is required');

   
  const { hashRepoUrl } = require('./scan-fingerprint-store.js');
  const repoUrlHash = hashRepoUrl(repoUrl);
  const rows = await sql`
    SELECT id, org_id, project_id, access_token_enc, refresh_token_enc,
           expires_at, scope, last_used_at
    FROM external_integrations
    WHERE repo_url_hash = ${repoUrlHash} AND vendor = ${vendor}
    ORDER BY updated_at DESC
    LIMIT 1
  `;
  if (!rows || rows.length === 0) return null;
  const row = rows[0];
  return {
    id: row.id,
    orgId: row.org_id,
    projectId: row.project_id,
    accessToken: decryptToken(row.access_token_enc),
    refreshToken: row.refresh_token_enc ? decryptToken(row.refresh_token_enc) : null,
    expiresAt: row.expires_at,
    scope: row.scope,
    lastUsedAt: row.last_used_at,
  };
}

/**
 * Bookkeeping: bump last_used_at after a successful API call.
 */
async function markUsed(opts) {
  const { sql, id } = opts;
  if (typeof sql !== 'function') throw new Error('markUsed: sql is required');
  if (!id) throw new Error('markUsed: id is required');
  await sql`
    UPDATE external_integrations SET last_used_at = NOW() WHERE id = ${id}
  `;
}

/**
 * Disconnect an integration. Customer-facing surface ("revoke
 * GateTest's access to my Sentry org").
 */
async function disconnectIntegration(opts) {
  const { sql, repoUrl, vendor } = opts;
  if (typeof sql !== 'function') throw new Error('disconnectIntegration: sql is required');
  if (!repoUrl) throw new Error('disconnectIntegration: repoUrl is required');
   
  const { hashRepoUrl } = require('./scan-fingerprint-store.js');
  const repoUrlHash = hashRepoUrl(repoUrl);
  if (vendor) {
    const rows = await sql`
      DELETE FROM external_integrations
      WHERE repo_url_hash = ${repoUrlHash} AND vendor = ${vendor}
      RETURNING id
    `;
    return { deleted: (rows || []).length };
  }
  // No vendor → delete every integration for this repo (full disconnect).
  const rows = await sql`
    DELETE FROM external_integrations WHERE repo_url_hash = ${repoUrlHash}
    RETURNING id
  `;
  return { deleted: (rows || []).length };
}

/**
 * List all vendors a repo has connected. Used by the dashboard.
 */
async function listConnectedVendors(opts) {
  const { sql, repoUrl } = opts;
  if (typeof sql !== 'function') throw new Error('listConnectedVendors: sql is required');
  if (!repoUrl) throw new Error('listConnectedVendors: repoUrl is required');
   
  const { hashRepoUrl } = require('./scan-fingerprint-store.js');
  const repoUrlHash = hashRepoUrl(repoUrl);
  const rows = await sql`
    SELECT vendor, org_id, project_id, expires_at, last_used_at, updated_at
    FROM external_integrations
    WHERE repo_url_hash = ${repoUrlHash}
    ORDER BY vendor ASC
  `;
  return rows || [];
}

module.exports = {
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
};
