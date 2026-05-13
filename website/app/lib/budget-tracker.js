/**
 * Per-scan Anthropic spend tracker.
 *
 * Pure in-process — created at the start of each request, mutated as
 * the request proceeds, dropped when the request ends. No durable
 * storage. Safe on Vercel serverless because each function invocation
 * is its own process; concurrent invocations get their own tracker.
 *
 * Why we need this: an unbounded fix-loop bug, a malicious repo
 * crafted to maximise prompt token usage, or a stuck retry pool can
 * each burn through the Anthropic balance in a single request. The
 * tracker stops that by aborting before the NEXT call once a cap is
 * crossed, so the worst-case overshoot is one in-flight call.
 *
 * Two-axis cap: tokens (input + output) AND estimated USD. Either
 * triggers abort. Per-scan ceilings configurable via env.
 *
 * Per-customer / per-day caps need a durable store — out of scope
 * here; this module is the in-request half. Pair with persisted
 * counters when that store lands.
 */

const ALS = (() => {
  try {
    return require('node:async_hooks').AsyncLocalStorage;
  } catch {
    return null;
  }
})();

// Sonnet 4.x pricing as of May 2026 — input $3/MTok, output $15/MTok.
// Tunable per env if Anthropic moves the price card.
const INPUT_USD_PER_MTOK = Number(process.env.GATETEST_INPUT_USD_PER_MTOK) || 3;
const OUTPUT_USD_PER_MTOK = Number(process.env.GATETEST_OUTPUT_USD_PER_MTOK) || 15;

// Default per-scan ceilings.
const DEFAULT_MAX_TOKENS = Number(process.env.GATETEST_MAX_TOKENS_PER_SCAN) || 1_500_000;
const DEFAULT_MAX_USD = Number(process.env.GATETEST_MAX_USD_PER_SCAN) || 12;

// Rough char-to-token ratio. Claude tokenizer averages ~3.5-4 chars/tok
// for English+code. Use 3.0 to deliberately over-count so we cut off
// BEFORE the real ceiling is crossed.
const CHARS_PER_TOKEN = 3.0;

function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / CHARS_PER_TOKEN);
}

class BudgetTracker {
  constructor({ maxTokens = DEFAULT_MAX_TOKENS, maxUsd = DEFAULT_MAX_USD, label = 'scan' } = {}) {
    this.maxTokens = maxTokens;
    this.maxUsd = maxUsd;
    this.label = label;
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.callCount = 0;
    this.aborted = false;
    this.abortReason = null;
    this.startedAt = Date.now();
  }

  /**
   * Account for one Claude call. `body` is the request body string,
   * `response` the result from anthropicCall (either { status, data }
   * or null if the call threw). If Anthropic returned a `usage` object
   * we use its exact token counts; otherwise we estimate from char
   * lengths.
   */
  record(body, response) {
    this.callCount += 1;
    const usage = response?.data?.usage;
    if (usage && typeof usage.output_tokens === 'number') {
      this.inputTokens += usage.input_tokens || estimateTokens(body);
      this.outputTokens += usage.output_tokens;
    } else {
      this.inputTokens += estimateTokens(body);
      const text =
        (response?.data?.content && response.data.content[0]?.text) || '';
      this.outputTokens += estimateTokens(text);
    }
    this._checkCaps();
  }

  _checkCaps() {
    if (this.aborted) return;
    const total = this.inputTokens + this.outputTokens;
    if (total > this.maxTokens) {
      this.aborted = true;
      this.abortReason = `token cap exceeded (${total}/${this.maxTokens})`;
      return;
    }
    const usd = this.estimatedUsd();
    if (usd > this.maxUsd) {
      this.aborted = true;
      this.abortReason = `usd cap exceeded ($${usd.toFixed(2)}/$${this.maxUsd})`;
    }
  }

  estimatedUsd() {
    return (
      (this.inputTokens / 1_000_000) * INPUT_USD_PER_MTOK +
      (this.outputTokens / 1_000_000) * OUTPUT_USD_PER_MTOK
    );
  }

  /**
   * Call BEFORE each new Anthropic call. Throws `BudgetExceeded` if
   * the cap was already breached on a prior call. The error carries
   * a snapshot so the caller can surface it cleanly to the user.
   */
  preflight() {
    if (!this.aborted) return;
    const err = new Error(`Anthropic budget exhausted: ${this.abortReason}`);
    err.code = 'BUDGET_EXCEEDED';
    err.tracker = this.snapshot();
    throw err;
  }

  snapshot() {
    return {
      label: this.label,
      callCount: this.callCount,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      totalTokens: this.inputTokens + this.outputTokens,
      estimatedUsd: Number(this.estimatedUsd().toFixed(4)),
      maxTokens: this.maxTokens,
      maxUsd: this.maxUsd,
      aborted: this.aborted,
      abortReason: this.abortReason,
      durationMs: Date.now() - this.startedAt,
    };
  }
}

// ---------------------------------------------------------------------------
// AsyncLocalStorage context — lets deep call stacks (libs that don't accept
// a tracker arg) reach the per-request tracker without explicit threading.
// ---------------------------------------------------------------------------

const _als = ALS ? new ALS() : null;

function getCurrentTracker() {
  if (!_als) return null;
  return _als.getStore() || null;
}

function runWithTracker(tracker, fn) {
  if (!_als) return fn();
  return _als.run(tracker, fn);
}

function createBudgetTracker(opts) {
  return new BudgetTracker(opts);
}

module.exports = {
  BudgetTracker,
  createBudgetTracker,
  getCurrentTracker,
  runWithTracker,
  estimateTokens,
  // Exposed for tests.
  INPUT_USD_PER_MTOK,
  OUTPUT_USD_PER_MTOK,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MAX_USD,
  CHARS_PER_TOKEN,
};
