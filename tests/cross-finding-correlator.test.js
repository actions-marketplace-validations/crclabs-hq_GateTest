// ============================================================================
// CROSS-FINDING-CORRELATOR TEST — Phase 3.2 of THE FIX-FIRST BUILD PLAN
// ============================================================================
// Covers website/app/lib/cross-finding-correlator.js — the Nuclear-tier
// engine that identifies attack chains across the full findings set.
// Per-finding diagnoser sees one finding at a time; this correlator
// reads them all together and identifies COMBINATIONS that form a
// real attack path.
// ============================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  correlateFindings,
  renderCorrelationReport,
  buildCorrelationPrompt,
  parseCorrelationOutput,
  SEVERITY_BADGE,
} = require('../website/app/lib/cross-finding-correlator.js');

const validResponse = `CHAIN: XSS to session takeover via permissive CSP + missing httpOnly
SEVERITY: critical
INVOLVES: 1, 3, 5
IMPACT: An attacker who lands a single reflected-XSS payload anywhere on the site can read document.cookie, exfiltrate the session token via the wildcard CORS, and replay it from any origin. Each finding alone is survivable; together they form a one-shot session takeover.
FIX_ORDER: Remove unsafe-inline from CSP first — that breaks the XSS landing step and immediately neutralises the chain.

CHAIN: Admin brute-force vector via missing rate limit + default secret
SEVERITY: high
INVOLVES: 2, 4
IMPACT: The /admin route is reachable without IP throttling and the default JWT secret is the literal string "changeme". A scripted attacker can mint admin tokens directly without ever attempting a password.
FIX_ORDER: Rotate the JWT secret to a high-entropy value first — without that, rate-limiting alone is insufficient because the attacker doesn't even need to hit the auth endpoint.`;

const findingsSet = [
  { detail: 'CSP allows unsafe-inline scripts', module: 'webHeaders', severity: 'warning' },
  { detail: '/admin route has no rate limiter', module: 'authFlaws', severity: 'warning' },
  { detail: 'cookie httpOnly:false', module: 'cookieSecurity', severity: 'error' },
  { detail: 'JWT_SECRET="changeme" in code', module: 'secrets', severity: 'error' },
  { detail: 'CORS Allow-Origin: *', module: 'webHeaders', severity: 'warning' },
];

// ---------- buildCorrelationPrompt ----------

test('buildCorrelationPrompt — numbers findings 1-indexed', () => {
  const p = buildCorrelationPrompt({ findings: findingsSet });
  assert.match(p, /^1\. .*CSP allows unsafe-inline/m);
  assert.match(p, /^5\. .*CORS Allow-Origin/m);
});

test('buildCorrelationPrompt — includes severity + module annotations', () => {
  const p = buildCorrelationPrompt({ findings: findingsSet });
  assert.match(p, /\[warning\]/);
  assert.match(p, /\[error\]/);
  assert.match(p, /\(webHeaders\)/);
  assert.match(p, /\(secrets\)/);
});

test('buildCorrelationPrompt — explicit instruction not to pad with weak chains', () => {
  const p = buildCorrelationPrompt({ findings: findingsSet });
  assert.match(p, /COMBINED severity is materially worse/);
  assert.match(p, /Do not pad/);
  assert.match(p, /0-5 chains max/);
});

test('buildCorrelationPrompt — output schema documented', () => {
  const p = buildCorrelationPrompt({ findings: findingsSet });
  assert.match(p, /CHAIN:/);
  assert.match(p, /SEVERITY:/);
  assert.match(p, /INVOLVES:/);
  assert.match(p, /IMPACT:/);
  assert.match(p, /FIX_ORDER:/);
  assert.match(p, /SKIP/);
});

test('buildCorrelationPrompt — includes hostname when present', () => {
  const p = buildCorrelationPrompt({ findings: findingsSet, hostname: 'example.com' });
  assert.match(p, /HOST:/);
  assert.match(p, /example\.com/);
});

// ---------- parseCorrelationOutput ----------

test('parseCorrelationOutput — happy path with two chains', () => {
  const r = parseCorrelationOutput(validResponse, 5);
  assert.equal(r.ok, true);
  assert.equal(r.chains.length, 2);
  assert.equal(r.chains[0].severity, 'critical');
  assert.deepEqual(r.chains[0].findingNumbers, [1, 3, 5]);
  assert.match(r.chains[0].title, /XSS to session takeover/);
  assert.match(r.chains[0].impact, /reflected-XSS/);
  assert.match(r.chains[0].fixOrder, /unsafe-inline/);
  assert.equal(r.chains[1].severity, 'high');
  assert.deepEqual(r.chains[1].findingNumbers, [2, 4]);
});

test('parseCorrelationOutput — SKIP marker → ok=true with empty chains', () => {
  const r = parseCorrelationOutput('SKIP: no chains identified — findings appear independent');
  assert.equal(r.ok, true);
  assert.deepEqual(r.chains, []);
});

test('parseCorrelationOutput — refusal recognised', () => {
  const r = parseCorrelationOutput("I cannot perform this analysis.");
  assert.equal(r.ok, false);
  assert.match(r.reason, /refused/);
});

test('parseCorrelationOutput — empty / non-string', () => {
  assert.equal(parseCorrelationOutput('').ok, false);
  assert.equal(parseCorrelationOutput(null).ok, false);
  assert.equal(parseCorrelationOutput(42).ok, false);
});

test('parseCorrelationOutput — invalid severity skips that block', () => {
  const mixed = `CHAIN: Bad severity chain
SEVERITY: spicy
INVOLVES: 1, 2
IMPACT: Something happens here that takes more than a couple of words to explain properly.
FIX_ORDER: Do thing first because reasons.

${validResponse}`;
  const r = parseCorrelationOutput(mixed, 5);
  assert.equal(r.ok, true);
  assert.equal(r.chains.length, 2); // bad-severity block dropped, valid two kept
});

test('parseCorrelationOutput — single-finding "chain" is rejected (a chain needs ≥ 2)', () => {
  const single = `CHAIN: Lonely
SEVERITY: low
INVOLVES: 3
IMPACT: A single-finding chain isn't a chain — it's just a finding repeated.
FIX_ORDER: Address that one finding directly.`;
  const r = parseCorrelationOutput(single, 5);
  assert.equal(r.ok, false);
  assert.match(r.reason, /no valid chain blocks/);
});

test('parseCorrelationOutput — out-of-bounds finding numbers filtered', () => {
  const oob = `CHAIN: Chain referencing nonexistent finding
SEVERITY: high
INVOLVES: 1, 99, 100
IMPACT: Should drop the 99 and 100 references because they exceed the finding set bounds.
FIX_ORDER: Fix the legitimate one first since others don't exist.`;
  const r = parseCorrelationOutput(oob, 5);
  // After filtering OOB, only finding #1 remains — single-finding chain → rejected
  assert.equal(r.ok, false);
});

test('parseCorrelationOutput — missing required field skips block', () => {
  const noImpact = `CHAIN: Missing impact
SEVERITY: high
INVOLVES: 1, 2
FIX_ORDER: Fix one first.`;
  const r = parseCorrelationOutput(noImpact, 5);
  assert.equal(r.ok, false);
  assert.match(r.reason, /no valid chain/);
});

// ---------- correlateFindings (orchestrator) ----------

test('correlateFindings — happy path', async () => {
  const r = await correlateFindings({
    findings: findingsSet,
    askClaudeForCorrelation: async () => validResponse,
  });
  assert.equal(r.ok, true);
  assert.equal(r.chains.length, 2);
  assert.match(r.summary, /2 attack chains identified/);
  // findingsInvolved resolves numbers to detail strings
  assert.equal(r.chains[0].findingsInvolved.length, 3);
  assert.match(r.chains[0].findingsInvolved[0], /CSP allows unsafe-inline/);
  assert.match(r.chains[0].findingsInvolved[1], /httpOnly:false/);
  assert.match(r.chains[0].findingsInvolved[2], /CORS Allow-Origin/);
});

test('correlateFindings — fewer than 2 findings skipped', async () => {
  let calls = 0;
  const r = await correlateFindings({
    findings: [findingsSet[0]],
    askClaudeForCorrelation: async () => { calls++; return validResponse; },
  });
  assert.equal(calls, 0);
  assert.equal(r.ok, true);
  assert.equal(r.chains.length, 0);
  assert.match(r.summary, /need ≥ 2 findings/);
});

test('correlateFindings — SKIP from Claude → ok with empty chains', async () => {
  const r = await correlateFindings({
    findings: findingsSet,
    askClaudeForCorrelation: async () => 'SKIP: nothing combines',
  });
  assert.equal(r.ok, true);
  assert.equal(r.chains.length, 0);
  assert.match(r.summary, /findings appear independent/);
});

test('correlateFindings — Claude API error captured', async () => {
  const r = await correlateFindings({
    findings: findingsSet,
    askClaudeForCorrelation: async () => { throw new Error('ECONNRESET'); },
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /Claude API error/);
});

test('correlateFindings — caps at maxFindings, records overflow', async () => {
  const many = Array.from({ length: 100 }, (_, i) => ({
    detail: `Finding ${i + 1}: thing happened`,
    module: 'm',
    severity: 'warning',
  }));
  let promptSeen = '';
  const r = await correlateFindings({
    findings: many,
    askClaudeForCorrelation: async (p) => { promptSeen = p; return 'SKIP: nothing'; },
    maxFindings: 10,
  });
  assert.equal(r.ok, true);
  assert.match(r.summary, /90 findings beyond 10-cap/);
  // Prompt only contains 10 findings
  const finding1 = (promptSeen.match(/^1\. /m) || []).length;
  const finding10 = (promptSeen.match(/^10\. /m) || []).length;
  const finding11 = (promptSeen.match(/^11\. /m) || []).length;
  assert.equal(finding1, 1);
  assert.equal(finding10, 1);
  assert.equal(finding11, 0);
});

test('correlateFindings — input validation', async () => {
  await assert.rejects(
    () => correlateFindings({ findings: 'no', askClaudeForCorrelation: async () => '' }),
    /findings must be an array/
  );
  await assert.rejects(
    () => correlateFindings({ findings: [] }),
    /askClaudeForCorrelation must be a function/
  );
});

// ---------- renderCorrelationReport ----------

test('renderCorrelationReport — chains rendered with severity badge + impact + fix order', () => {
  const result = {
    ok: true,
    chains: [
      {
        title: 'XSS to session takeover',
        severity: 'critical',
        findingNumbers: [1, 3, 5],
        findingsInvolved: ['CSP allows unsafe-inline', 'cookie httpOnly:false', 'CORS *'],
        impact: 'Attacker can take over a session.',
        fixOrder: 'Remove unsafe-inline first.',
      },
    ],
    summary: 'cross-finding correlation: 1 attack chain identified',
  };
  const out = renderCorrelationReport(result);
  assert.match(out, /Cross-Finding Correlation/);
  assert.match(out, /critical/);
  assert.match(out, /XSS to session takeover/);
  assert.match(out, /CSP allows unsafe-inline/);
  assert.match(out, /\*\*Impact\.\*\* Attacker can take over a session\./);
  assert.match(out, /\*\*Fix order\.\*\* Remove unsafe-inline first\./);
  assert.match(out, /\$399/);
});

test('renderCorrelationReport — zero chains gets the "good outcome" treatment', () => {
  const out = renderCorrelationReport({ ok: true, chains: [], summary: 'zero' });
  assert.match(out, /No attack chains detected/);
  assert.match(out, /good.*outcome/);
});

test('renderCorrelationReport — failed result gets friendly placeholder', () => {
  const out = renderCorrelationReport({ ok: false, chains: [], summary: 'bad', reason: 'Claude API error' });
  assert.match(out, /Cross-Finding Correlation/);
  assert.match(out, /not generated/);
  assert.match(out, /Claude API error/);
});

test('renderCorrelationReport — null result handled', () => {
  const out = renderCorrelationReport(null);
  assert.match(out, /not generated/);
});

// ---------- SEVERITY_BADGE ----------

test('SEVERITY_BADGE — exported and stable', () => {
  assert.equal(SEVERITY_BADGE.critical, '🔴 critical');
  assert.equal(SEVERITY_BADGE.high, '🟠 high');
  assert.equal(SEVERITY_BADGE.medium, '🟡 medium');
  assert.equal(SEVERITY_BADGE.low, '⚪ low');
});
