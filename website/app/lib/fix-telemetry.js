/**
 * Fix telemetry — per-attempt JSONL log.
 *
 * Records WHICH layer of the flywheel handled each fix attempt (ast / rule /
 * recipe / claude / null) plus duration, success, and cost. The point is to
 * surface the flywheel maturing: as recipes accumulate, the Claude ratio
 * should drop. Craig sees this on the admin dashboard.
 *
 * RESILIENCE CONTRACT (Bible Forbidden #15):
 *   - This module MUST NEVER throw.
 *   - File-write failures (permission denied, disk full, missing dir) are
 *     logged once via console.warn and the call returns silently.
 *   - Telemetry is a side-channel; it must never block a fix attempt.
 *
 * PRIVACY CONTRACT (Bible #6 / Forbidden #6):
 *   - We record `ruleKey`, `module`, `layer`, `success`, `durationMs`,
 *     `costUsd`. We do NOT record `issue.content`, file contents, repo URLs,
 *     or user-identifying data. The JSONL is a flywheel-progress log, not a
 *     scan database.
 *
 * Storage: `~/.gatetest/telemetry/fix-attempts.jsonl` (one line per attempt).
 * Caller can override via `opts.path` for tests.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_LAYERS = new Set(['ast', 'rule', 'recipe', 'claude', null]);
const MAX_RULE_KEY_LEN = 200;
const MAX_MODULE_LEN = 100;

let _warnedOnce = false;
function warnOnce(msg) {
  if (_warnedOnce) return;
  _warnedOnce = true;
  // eslint-disable-next-line no-console
  console.warn(`[fix-telemetry] ${msg}`);
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

function defaultTelemetryPath() {
  return path.join(os.homedir(), '.gatetest', 'telemetry', 'fix-attempts.jsonl');
}

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Sanitisation — guarantee no secrets reach the JSONL
// ---------------------------------------------------------------------------

function sanitiseString(s, max) {
  if (typeof s !== 'string') return null;
  return s.slice(0, max);
}

function sanitiseRecord(entry) {
  // Whitelist exactly the fields we record. No `issue.content` allowed.
  const out = {
    ts: new Date().toISOString(),
    layer: VALID_LAYERS.has(entry.layer) ? entry.layer : null,
    success: !!entry.success,
    issueRuleKey: sanitiseString(entry.issueRuleKey, MAX_RULE_KEY_LEN),
    module: sanitiseString(entry.module, MAX_MODULE_LEN),
    durationMs: Number.isFinite(entry.durationMs) ? Math.max(0, Math.round(entry.durationMs)) : 0,
    costUsd: Number.isFinite(entry.costUsd) ? Math.max(0, entry.costUsd) : 0,
  };
  // Optional fields used by orchestrator for richer dashboards
  if (entry.reason) out.reason = sanitiseString(entry.reason, 100);
  if (entry.model) out.model = sanitiseString(entry.model, 50);
  if (entry.fileExt) out.fileExt = sanitiseString(entry.fileExt, 10);
  return out;
}

// ---------------------------------------------------------------------------
// Public: recordFixAttempt
// ---------------------------------------------------------------------------

/**
 * Append a fix-attempt record to the JSONL log. Best-effort, never throws.
 *
 * @param {object} entry
 * @param {'ast'|'rule'|'recipe'|'claude'|null} entry.layer
 * @param {boolean} entry.success
 * @param {string} [entry.issueRuleKey]
 * @param {string} [entry.module]
 * @param {number} [entry.durationMs]
 * @param {number} [entry.costUsd]
 * @param {string} [entry.reason]
 * @param {string} [entry.model]
 * @param {string} [entry.fileExt]
 * @param {object} [opts]
 * @param {string} [opts.path] — override the JSONL path (for tests)
 */
function recordFixAttempt(entry, opts = {}) {
  try {
    const filePath = opts.path || defaultTelemetryPath();
    const record = sanitiseRecord(entry || {});
    const line = JSON.stringify(record) + '\n';
    try {
      ensureDir(filePath);
    } catch (err) {
      warnOnce(`could not create telemetry dir: ${err.message}`);
      return;
    }
    try {
      fs.appendFileSync(filePath, line, { encoding: 'utf8' });
    } catch (err) {
      warnOnce(`could not append telemetry: ${err.message}`);
    }
  } catch (err) {
    // Last-ditch — never let telemetry block a fix.
    warnOnce(`unexpected error: ${err && err.message ? err.message : 'unknown'}`);
  }
}

// ---------------------------------------------------------------------------
// Public: summariseLayerRatios
// ---------------------------------------------------------------------------

/**
 * Returns an aggregate of {layer: {count, successes, totalCostUsd}} for the
 * window [since, until]. Reads the JSONL line-by-line so a 100MB log doesn't
 * load into memory.
 *
 * Malformed lines (non-JSON, missing fields) are skipped, not thrown.
 * Missing file → empty stats.
 *
 * @param {object} [opts]
 * @param {Date} [opts.since]
 * @param {Date} [opts.until]
 * @param {string} [opts.path]
 * @returns {Promise<object>}
 */
async function summariseLayerRatios(opts = {}) {
  const filePath = opts.path || defaultTelemetryPath();
  const sinceMs = opts.since instanceof Date ? opts.since.getTime() : -Infinity;
  const untilMs = opts.until instanceof Date ? opts.until.getTime() : Infinity;

  const empty = () => ({ count: 0, successes: 0, totalCostUsd: 0 });
  const stats = {
    ast: empty(),
    rule: empty(),
    recipe: empty(),
    claude: empty(),
    null: empty(), // all-layer-miss
  };

  let exists = false;
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
    exists = true;
  } catch {
    exists = false;
  }
  if (!exists) return stats;

  return await new Promise((resolve) => {
    let stream;
    try {
      stream = fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 64 * 1024 });
    } catch (err) {
      warnOnce(`could not read telemetry: ${err.message}`);
      resolve(stats);
      return;
    }
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    rl.on('line', (line) => {
      if (!line || !line.trim()) return;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        return; // skip malformed
      }
      if (!rec || typeof rec !== 'object') return;
      const t = Date.parse(rec.ts);
      if (Number.isFinite(t)) {
        if (t < sinceMs || t > untilMs) return;
      } // missing ts → include (defensive)
      const key = rec.layer === null || rec.layer === undefined ? 'null' : String(rec.layer);
      const bucket = stats[key];
      if (!bucket) return; // unknown layer label — skip
      bucket.count++;
      if (rec.success) bucket.successes++;
      if (Number.isFinite(rec.costUsd)) bucket.totalCostUsd += Math.max(0, rec.costUsd);
    });
    rl.on('error', (err) => {
      warnOnce(`telemetry read error: ${err.message}`);
      resolve(stats);
    });
    rl.on('close', () => resolve(stats));
  });
}

// ---------------------------------------------------------------------------

module.exports = {
  recordFixAttempt,
  summariseLayerRatios,
  defaultTelemetryPath,
  // exposed for tests
  _sanitiseRecord: sanitiseRecord,
};
