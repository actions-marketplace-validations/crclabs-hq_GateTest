'use strict';

/**
 * CISO Correlator Bridge — Phase 3.2 wiring helper for /api/scan/fix.
 *
 * Purpose: the Nuclear-tier ($399) CISO report accepts a `chains` array
 * but, prior to this helper, the /api/scan/fix route passed `chains: []`
 * — meaning every Nuclear customer's CISO report rendered a blank
 * attack-chain section.
 *
 * The cross-finding correlator already exists at
 * `website/app/lib/cross-finding-correlator.js` and is wired from
 * `/api/scan/server-fix`. This helper exposes the same engine to
 * `/api/scan/fix` with two production guarantees:
 *
 *   1. **Fail-soft** — correlator failure (Claude error, parse error,
 *      malformed output) NEVER blocks the Nuclear deliverable. Returns
 *      `{ chains: [], note: <human-readable reason> }`.
 *
 *   2. **Budget-bounded** — exactly one Claude call per Nuclear scan
 *      with a hard timeout (default 30s). Timeout is treated as
 *      failure (above).
 *
 * The route imports `correlateForCisoChains` and passes the resulting
 * `chains` array straight into `generateCisoReport`. The `note` is
 * surfaced in the CISO PR-body advisory section when the correlator
 * didn't produce real chains.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { correlateFindings } = require('./cross-finding-correlator');

/**
 * Default timeout for the correlator Claude call. 30 seconds matches
 * the per-fix Anthropic budget elsewhere in the route and gives Claude
 * time to read up to 40 findings + emit 5 chain blocks.
 */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Compute attack chains for the Nuclear-tier CISO report.
 *
 * @param {Object} opts
 * @param {string} opts.tier  Tier identifier. Anything other than
 *   "nuclear" returns `{ chains: [], note: "non-nuclear tier — chains
 *   skipped" }` WITHOUT calling Claude. Saves cost on Quick / Full /
 *   Scan+Fix scans.
 * @param {Array<{ detail: string; module?: string; severity?: string }>} opts.findings
 *   Findings to feed the correlator. Empty / single-finding arrays
 *   short-circuit (no Claude call).
 * @param {string} [opts.hostname]  Customer host / repo identifier
 *   passed through to the correlator prompt.
 * @param {(prompt: string) => Promise<string>} opts.askClaude  Claude
 *   wrapper. Same shape `correlateFindings` expects.
 * @param {number} [opts.timeoutMs]  Hard timeout in ms. Default 30 000.
 * @param {(opts: any) => Promise<any>} [opts._correlate]  Test seam —
 *   inject a mock correlator. Default = the real `correlateFindings`.
 *
 * @returns {Promise<{
 *   chains: Array<{ title: string; severity: string; findingNumbers: number[]; findingsInvolved: string[]; impact: string; fixOrder: string }>;
 *   note: string | null;
 *   skipped: boolean;
 * }>}
 *   `chains` is ALWAYS an array (possibly empty). `note` carries the
 *   reason chains were empty (so the PR body can surface honest
 *   advisory). `skipped: true` means Claude was never called.
 */
async function correlateForCisoChains(opts) {
  const {
    tier,
    findings,
    hostname,
    askClaude,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    _correlate = correlateFindings,
  } = opts || {};

  // Gate 1 — non-Nuclear tiers don't pay for correlation.
  if (tier !== 'nuclear') {
    return {
      chains: [],
      note: `non-nuclear tier (${tier || 'unknown'}) — attack-chain correlation skipped`,
      skipped: true,
    };
  }

  // Gate 2 — empty / single-finding scans can't form chains.
  if (!Array.isArray(findings) || findings.length < 2) {
    return {
      chains: [],
      note: 'insufficient findings (need ≥ 2) — attack-chain correlation skipped',
      skipped: true,
    };
  }

  // Gate 3 — caller must supply the Claude wrapper. If absent, we treat
  // it as a config gap and fail soft (the CISO report still ships).
  if (typeof askClaude !== 'function') {
    return {
      chains: [],
      note: 'attack-chain correlation skipped (no Claude client configured)',
      skipped: true,
    };
  }

  // Run the correlator under a hard timeout. Failure of any kind —
  // Claude error, parse error, timeout — degrades to chains:[] with
  // an honest note. The Nuclear deliverable still ships.
  let timer = null;
  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(() => {
      resolve({ __timedOut: true });
    }, timeoutMs);
  });

  try {
    const correlationPromise = (async () => {
      try {
        return await _correlate({
          findings,
          hostname,
          askClaudeForCorrelation: askClaude,
        });
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        return { __threw: true, message };
      }
    })();

    const winner = await Promise.race([correlationPromise, timeoutPromise]);

    if (winner && winner.__timedOut) {
      return {
        chains: [],
        note: `attack-chain correlation timed out after ${timeoutMs}ms — Nuclear deliverable shipped without chains`,
        skipped: false,
      };
    }
    if (winner && winner.__threw) {
      return {
        chains: [],
        note: `attack-chain correlation failed (${winner.message}) — Nuclear deliverable shipped without chains`,
        skipped: false,
      };
    }

    // Real correlator returned. Even on `ok: false` we still return
    // chains:[] — correlator's own contract is fail-soft.
    if (!winner || winner.ok !== true) {
      const reason = (winner && winner.reason) || 'no chains produced';
      return {
        chains: [],
        note: `attack-chain correlation produced no chains (${reason})`,
        skipped: false,
      };
    }

    // Success — pass through the real chains. May be an empty array
    // when the correlator honestly reported "findings appear
    // independent" — that's a valid no-padding outcome, not a failure.
    return {
      chains: Array.isArray(winner.chains) ? winner.chains : [],
      note: null,
      skipped: false,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

module.exports = {
  correlateForCisoChains,
  DEFAULT_TIMEOUT_MS,
};
