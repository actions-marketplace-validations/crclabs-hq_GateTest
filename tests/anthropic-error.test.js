// =============================================================================
// ANTHROPIC-ERROR TEST — phase-6 launch hardening (gap 5)
// =============================================================================
// Pure-function classifier — covers every Anthropic HTTP status the
// route layer might see in production.
// =============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
  KIND_KEY_INVALID,
  KIND_OUT_OF_CREDIT,
  KIND_RATE_LIMITED,
  KIND_BAD_REQUEST,
  KIND_OVERLOADED,
  KIND_DOWN,
  KIND_UNKNOWN,
  classifyAnthropicError,
  formatAnthropicError,
} = require('../website/app/lib/anthropic-error');

describe('classifyAnthropicError', () => {
  it('401 → key-invalid', () => {
    const c = classifyAnthropicError(401, '{"error":"unauthorized"}');
    assert.strictEqual(c.kind, KIND_KEY_INVALID);
    assert.match(c.action, /console\.anthropic\.com/);
  });

  it('402 → out-of-credit', () => {
    const c = classifyAnthropicError(402, '{"error":"payment required"}');
    assert.strictEqual(c.kind, KIND_OUT_OF_CREDIT);
    assert.match(c.action, /billing/);
  });

  it('400 with credit_balance_too_low → out-of-credit (Anthropic\'s real shape)', () => {
    const c = classifyAnthropicError(400, '{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Claude API"}}');
    assert.strictEqual(c.kind, KIND_OUT_OF_CREDIT);
  });

  it('429 → rate-limited', () => {
    const c = classifyAnthropicError(429, '{"error":"too many"}');
    assert.strictEqual(c.kind, KIND_RATE_LIMITED);
    assert.match(c.message, /rate limit/i);
  });

  it('400 (no credit phrase) → bad-request', () => {
    const c = classifyAnthropicError(400, '{"error":"bad input"}');
    assert.strictEqual(c.kind, KIND_BAD_REQUEST);
  });

  it('529 → overloaded', () => {
    const c = classifyAnthropicError(529, '');
    assert.strictEqual(c.kind, KIND_OVERLOADED);
  });

  it('500-503 → api-down', () => {
    assert.strictEqual(classifyAnthropicError(500, '').kind, KIND_DOWN);
    assert.strictEqual(classifyAnthropicError(502, '').kind, KIND_DOWN);
    assert.strictEqual(classifyAnthropicError(503, '').kind, KIND_DOWN);
  });

  it('418 (other) → unknown', () => {
    const c = classifyAnthropicError(418, '');
    assert.strictEqual(c.kind, KIND_UNKNOWN);
    assert.strictEqual(c.action, null);
  });

  it('caps body to 200 chars (no log overflow)', () => {
    const huge = 'x'.repeat(5000);
    const c = classifyAnthropicError(500, huge);
    assert.ok(c.raw.length <= 200);
  });

  it('handles non-string body without crashing', () => {
    const c = classifyAnthropicError(500, undefined);
    assert.strictEqual(typeof c.raw, 'string');
  });
});

describe('formatAnthropicError', () => {
  it('joins message + action when both present', () => {
    const c = classifyAnthropicError(402, '');
    const f = formatAnthropicError(c);
    assert.match(f, /credit balance exhausted/);
    assert.match(f, /billing/);
  });

  it('returns just message when action is null', () => {
    const c = classifyAnthropicError(418, '');
    const f = formatAnthropicError(c);
    assert.strictEqual(f, c.message);
  });
});
