/**
 * Phase 6 launch hardening — gap 5 from the audit:
 *
 * Today every non-200 response from api.anthropic.com surfaces to the
 * customer as "Claude API error 402: <truncated json>". The customer has
 * no way to tell "the GateTest engine is broken" from "you ran out of
 * Anthropic credit." This helper classifies the status into a clear
 * actionable message before it bubbles up.
 *
 * Pure function. No side effects. Importable from .js and .ts call sites.
 *
 * @typedef {{ kind: string, status: number, message: string, action: string|null, raw: string }} ClassifiedError
 */

const KIND_KEY_INVALID = 'key-invalid';
const KIND_OUT_OF_CREDIT = 'out-of-credit';
const KIND_RATE_LIMITED = 'rate-limited';
const KIND_BAD_REQUEST = 'bad-request';
const KIND_OVERLOADED = 'overloaded';
const KIND_DOWN = 'api-down';
const KIND_UNKNOWN = 'unknown';

/**
 * @param {number} status — HTTP status from Anthropic
 * @param {string} [body] — optional response body for context (max 200 chars used)
 * @returns {ClassifiedError}
 */
function classifyAnthropicError(status, body = '') {
  const snippet = String(body).slice(0, 200);

  if (status === 401) {
    return {
      kind: KIND_KEY_INVALID,
      status,
      message: 'Anthropic API key is invalid or revoked.',
      action: 'Generate a new key at https://console.anthropic.com/settings/keys and update ANTHROPIC_API_KEY in your environment.',
      raw: snippet,
    };
  }

  // Anthropic returns 402 for billing problems but the official error code
  // is also "credit_balance_too_low" inside a 400 body. Catch both shapes.
  if (status === 402 || /credit[_ ]balance|insufficient[_ ]credit|out[_ ]of[_ ]credit/i.test(snippet)) {
    return {
      kind: KIND_OUT_OF_CREDIT,
      status,
      message: 'Anthropic credit balance exhausted — top up to resume AI features.',
      action: 'Add credit at https://console.anthropic.com/settings/billing.',
      raw: snippet,
    };
  }

  if (status === 429) {
    return {
      kind: KIND_RATE_LIMITED,
      status,
      message: 'Anthropic rate limit hit — too many requests.',
      action: 'Retry after a short delay, or request a higher rate limit at https://console.anthropic.com/settings/limits.',
      raw: snippet,
    };
  }

  if (status === 400) {
    return {
      kind: KIND_BAD_REQUEST,
      status,
      message: 'Anthropic rejected the request as malformed.',
      action: 'Likely a context-window overflow or a prompt-content policy refusal. Inspect the raw body.',
      raw: snippet,
    };
  }

  if (status === 529) {
    return {
      kind: KIND_OVERLOADED,
      status,
      message: 'Anthropic API is overloaded right now.',
      action: 'Retry with exponential backoff. Check https://status.anthropic.com.',
      raw: snippet,
    };
  }

  if (status >= 500 && status < 600) {
    return {
      kind: KIND_DOWN,
      status,
      message: 'Anthropic API is temporarily down or returned a 5xx.',
      action: 'Retry shortly. Check https://status.anthropic.com.',
      raw: snippet,
    };
  }

  return {
    kind: KIND_UNKNOWN,
    status,
    message: `Anthropic returned an unexpected ${status}.`,
    action: null,
    raw: snippet,
  };
}

/**
 * Format the classification for error.message — what bubbles up through
 * the route and into the customer-visible scan response.
 *
 * @param {ClassifiedError} c
 * @returns {string}
 */
function formatAnthropicError(c) {
  if (c.action) return `${c.message} ${c.action}`;
  return c.message;
}

module.exports = {
  KIND_KEY_INVALID,
  KIND_OUT_OF_CREDIT,
  KIND_RATE_LIMITED,
  KIND_BAD_REQUEST,
  KIND_OVERLOADED,
  KIND_DOWN,
  KIND_UNKNOWN,
  classifyAnthropicError,
  formatAnthropicError,
};
