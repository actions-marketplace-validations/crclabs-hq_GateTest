const { test, describe } = require('node:test');
const assert = require('assert');

// Pulling functions from PR #102's pipeline.
const { parseClaudeResponse } = require('../lib/ai-ci-fixer-claude');

// All fixtures below are intentionally split with string concatenation so the
// SOURCE FILE never contains a literal that GitHub's secret-scanning can
// match — the runtime-assembled string is what our leak-scanner sees. If you
// inline these into a single string literal, the push hook will reject the
// commit (which is the correct behaviour for the platform-level guard).
const FAKE_ANTHROPIC_KEY = 'sk-' + 'ant-sid01-' + 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-abcdefg';
const FAKE_OPENAI_KEY    = 'sk-' + 'abcdefghijklmnopqrst1234567890abcdef';
const FAKE_GITHUB_PAT    = 'ghp_' + 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
const FAKE_GITHUB_PAT_FG = 'github_pat_' + '11ABCDEF10abcdefghijklmnopqrstuvwxyz_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghij';
const FAKE_STRIPE_LIVE   = 'sk_' + 'live_' + '51NxF200000000000abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz';
const FAKE_STRIPE_TEST   = 'sk_' + 'test_' + '51NxF200000000000abcdefghijklmnopqrstuvwxyz1234567890abcdefghijklmnopqrstuvwxyz';
const FAKE_AWS_ACCESS    = 'AKIA' + 'IOSFODNN7EXAMPLE';
const FAKE_SLACK_BOT     = 'xoxb' + '-1234567890-1234567890123-abcdefghijklmnopqrstuvwx';
const FAKE_GOOGLE_API    = 'AIza' + 'SyAz-abcdefghijklmnopqrstuvwxyz1234';

describe('Security Leak Scanner & Parser (Fail-Closed)', () => {
  // Standard file allowlist — Gap 1 requires the parser receive the
  // original file set; an empty allowlist would block all writes.
  const mockOriginalFiles = [{ path: 'src/index.js' }];

  test('Anthropic API key leak → fail closed', () => {
    const leakedOutput = `FILE: src/index.js\nPATCH:\nconsole.log("System key leaked!");\n// ${FAKE_ANTHROPIC_KEY}\nEND_PATCH`;
    assert.deepStrictEqual(parseClaudeResponse(leakedOutput, mockOriginalFiles), []);
  });

  test('Legacy OpenAI secret key leak → fail closed', () => {
    const leakedOutput = `FILE: src/index.js\nPATCH:\nconst secret = "${FAKE_OPENAI_KEY}";\nEND_PATCH`;
    assert.deepStrictEqual(parseClaudeResponse(leakedOutput, mockOriginalFiles), []);
  });

  test('Classic GitHub PAT leak → fail closed', () => {
    const leakedOutput = `FILE: src/index.js\nPATCH:\nconst token = "${FAKE_GITHUB_PAT}";\nEND_PATCH`;
    assert.deepStrictEqual(parseClaudeResponse(leakedOutput, mockOriginalFiles), []);
  });

  test('Fine-grained GitHub PAT leak → fail closed', () => {
    const leakedOutput = `FILE: src/index.js\nPATCH:\nconst token = "${FAKE_GITHUB_PAT_FG}";\nEND_PATCH`;
    assert.deepStrictEqual(parseClaudeResponse(leakedOutput, mockOriginalFiles), []);
  });

  test('Stripe live secret key leak → fail closed', () => {
    const leakedOutput = `FILE: src/index.js\nPATCH:\nconst stripeKey = "${FAKE_STRIPE_LIVE}";\nEND_PATCH`;
    assert.deepStrictEqual(parseClaudeResponse(leakedOutput, mockOriginalFiles), []);
  });

  test('Stripe test secret key leak → fail closed', () => {
    const leakedOutput = `FILE: src/index.js\nPATCH:\nconst stripeTestKey = "${FAKE_STRIPE_TEST}";\nEND_PATCH`;
    assert.deepStrictEqual(parseClaudeResponse(leakedOutput, mockOriginalFiles), []);
  });

  test('AWS Access Key ID leak → fail closed', () => {
    const leakedOutput = `FILE: src/index.js\nPATCH:\nconst aws_id = "${FAKE_AWS_ACCESS}";\nEND_PATCH`;
    assert.deepStrictEqual(parseClaudeResponse(leakedOutput, mockOriginalFiles), []);
  });

  test('Slack bot/user token leak → fail closed', () => {
    const leakedOutput = `FILE: src/index.js\nPATCH:\nconst slack_bot = "${FAKE_SLACK_BOT}";\nEND_PATCH`;
    assert.deepStrictEqual(parseClaudeResponse(leakedOutput, mockOriginalFiles), []);
  });

  test('Google API key leak → fail closed', () => {
    // Real Google keys are exactly 35 chars after the AIza prefix.
    const leakedOutput = `FILE: src/index.js\nPATCH:\nconst googleKey = "${FAKE_GOOGLE_API}";\nEND_PATCH`;
    assert.deepStrictEqual(parseClaudeResponse(leakedOutput, mockOriginalFiles), []);
  });
});
