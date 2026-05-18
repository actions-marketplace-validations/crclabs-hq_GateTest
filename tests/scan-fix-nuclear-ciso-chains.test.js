'use strict';

// ============================================================================
// NUCLEAR-TIER CISO CHAINS WIRING TEST
// ============================================================================
// Verifies the bridge between the cross-finding correlator and the
// /api/scan/fix Nuclear branch (replaces the `chains: []` placeholder
// PR #92 left behind). Before this wiring every $399 customer's CISO
// report had a blank attack-chain section.
//
// Contract under test (`website/app/lib/ciso-correlator-bridge.js`):
//
//  1. Nuclear tier with ≥ 2 findings → correlator is called, chains
//     surface in the result.
//  2. Correlator throws → chains:[] returned with a human-readable
//     note. Nuclear deliverable still ships.
//  3. Correlator times out → same fail-soft behaviour.
//  4. Non-Nuclear tier (full, scan_fix, quick) → correlator is NOT
//     called. No Claude spend on lower tiers.
//  5. Empty / single-finding scans → correlator is NOT called.
//  6. Real correlator return path verified via the actual
//     cross-finding-correlator with a stub Claude wrapper.
//
// Tests are hermetic — no network, no real Claude.
// ============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  correlateForCisoChains,
  DEFAULT_TIMEOUT_MS,
} = require('../website/app/lib/ciso-correlator-bridge');

const { correlateFindings } = require('../website/app/lib/cross-finding-correlator');

// ─── Fixtures ────────────────────────────────────────────────────────────────

const TWO_FINDINGS = [
  { detail: 'CSP header allows unsafe-inline', module: 'webHeaders', severity: 'warning' },
  { detail: 'CORS Access-Control-Allow-Origin: * with credentials:true', module: 'webHeaders', severity: 'error' },
  { detail: 'Cookie session has httpOnly:false', module: 'cookieSecurity', severity: 'error' },
];

const ONE_FINDING = [
  { detail: 'Hardcoded localhost URL in production code', module: 'hardcodedUrl', severity: 'error' },
];

const MOCK_CHAINS = [
  {
    title: 'XSS to session takeover',
    severity: 'critical',
    findingNumbers: [1, 2, 3],
    findingsInvolved: [
      'CSP header allows unsafe-inline',
      'CORS Access-Control-Allow-Origin: * with credentials:true',
      'Cookie session has httpOnly:false',
    ],
    impact: 'Attacker injects script via CSP unsafe-inline, reads session cookie via CORS credential leak.',
    fixOrder: 'Tighten CSP first to close injection vector.',
  },
  {
    title: 'CSRF amplification',
    severity: 'high',
    findingNumbers: [2, 3],
    findingsInvolved: [
      'CORS Access-Control-Allow-Origin: * with credentials:true',
      'Cookie session has httpOnly:false',
    ],
    impact: 'Cross-origin requests can ride the session because both protections are off.',
    fixOrder: 'Lock CORS to known origins.',
  },
];

// ─── 1. Mock correlator returns N chains → those chains are propagated ───────

describe('correlateForCisoChains — returns chains the report can render', () => {
  it('Nuclear tier + valid findings → mock correlator chains are returned verbatim', async () => {
    let correlateCalls = 0;
    const result = await correlateForCisoChains({
      tier: 'nuclear',
      findings: TWO_FINDINGS,
      hostname: 'example.com',
      askClaude: async () => 'unused — mock correlator',
      _correlate: async (opts) => {
        correlateCalls += 1;
        assert.equal(opts.findings.length, TWO_FINDINGS.length);
        assert.equal(opts.hostname, 'example.com');
        assert.equal(typeof opts.askClaudeForCorrelation, 'function');
        return { ok: true, chains: MOCK_CHAINS, summary: '2 chains', reason: null };
      },
    });
    assert.equal(correlateCalls, 1, 'correlator should be called exactly once');
    assert.equal(result.chains.length, 2);
    assert.equal(result.chains[0].title, 'XSS to session takeover');
    assert.equal(result.chains[1].severity, 'high');
    assert.equal(result.skipped, false);
    assert.equal(result.note, null);
  });

  it('correlator returning ok:true with 0 chains is the honest "independent findings" outcome', async () => {
    const result = await correlateForCisoChains({
      tier: 'nuclear',
      findings: TWO_FINDINGS,
      askClaude: async () => '',
      _correlate: async () => ({ ok: true, chains: [], summary: '0 chains', reason: null }),
    });
    assert.deepEqual(result.chains, []);
    assert.equal(result.note, null, 'ok:true with empty chains is not a failure');
    assert.equal(result.skipped, false);
  });
});

// ─── 2. Correlator throws → chains:[] + note. Deliverable still ships. ──────

describe('correlateForCisoChains — fail-soft on errors', () => {
  it('correlator throws → chains:[] + descriptive note', async () => {
    const result = await correlateForCisoChains({
      tier: 'nuclear',
      findings: TWO_FINDINGS,
      askClaude: async () => '',
      _correlate: async () => {
        throw new Error('claude 503');
      },
    });
    assert.deepEqual(result.chains, []);
    assert.ok(result.note);
    assert.match(result.note, /correlation failed/);
    assert.match(result.note, /claude 503/);
    assert.equal(result.skipped, false);
  });

  it('correlator returns ok:false → chains:[] + reason surfaced', async () => {
    const result = await correlateForCisoChains({
      tier: 'nuclear',
      findings: TWO_FINDINGS,
      askClaude: async () => '',
      _correlate: async () => ({ ok: false, chains: [], summary: 'failed', reason: 'malformed response' }),
    });
    assert.deepEqual(result.chains, []);
    assert.ok(result.note);
    assert.match(result.note, /malformed response/);
  });
});

// ─── 3. Timeout → chains:[] + note. Deliverable still ships. ────────────────

describe('correlateForCisoChains — fail-soft on timeout', () => {
  it('correlator hangs past timeoutMs → chains:[] + timeout note', async () => {
    const result = await correlateForCisoChains({
      tier: 'nuclear',
      findings: TWO_FINDINGS,
      askClaude: async () => '',
      timeoutMs: 50,
      _correlate: () => new Promise(() => { /* never resolves */ }),
    });
    assert.deepEqual(result.chains, []);
    assert.ok(result.note);
    assert.match(result.note, /timed out/);
    assert.match(result.note, /50ms/);
    assert.equal(result.skipped, false);
  });

  it('correlator finishes before timeout → chains returned, timer cleared', async () => {
    const result = await correlateForCisoChains({
      tier: 'nuclear',
      findings: TWO_FINDINGS,
      askClaude: async () => '',
      timeoutMs: 10_000,
      _correlate: async () => ({ ok: true, chains: [MOCK_CHAINS[0]], summary: '1 chain', reason: null }),
    });
    assert.equal(result.chains.length, 1);
    assert.equal(result.note, null);
  });
});

// ─── 4. Non-Nuclear tiers skip the correlator (no Claude spend) ─────────────

describe('correlateForCisoChains — non-Nuclear tiers skip the correlator', () => {
  it('tier="full" → correlator NOT called, skipped:true', async () => {
    let calls = 0;
    const result = await correlateForCisoChains({
      tier: 'full',
      findings: TWO_FINDINGS,
      askClaude: async () => '',
      _correlate: async () => { calls += 1; return { ok: true, chains: [], summary: '', reason: null }; },
    });
    assert.equal(calls, 0, 'correlator must not run on $99 Full tier');
    assert.deepEqual(result.chains, []);
    assert.equal(result.skipped, true);
    assert.match(result.note, /non-nuclear/);
  });

  it('tier="scan_fix" → correlator NOT called (that is the $199 tier)', async () => {
    let calls = 0;
    const result = await correlateForCisoChains({
      tier: 'scan_fix',
      findings: TWO_FINDINGS,
      askClaude: async () => '',
      _correlate: async () => { calls += 1; return { ok: true, chains: [], summary: '', reason: null }; },
    });
    assert.equal(calls, 0);
    assert.equal(result.skipped, true);
  });

  it('tier="quick" → correlator NOT called (that is the $29 tier)', async () => {
    let calls = 0;
    const result = await correlateForCisoChains({
      tier: 'quick',
      findings: TWO_FINDINGS,
      askClaude: async () => '',
      _correlate: async () => { calls += 1; return { ok: true, chains: [], summary: '', reason: null }; },
    });
    assert.equal(calls, 0);
    assert.equal(result.skipped, true);
  });

  it('tier undefined / null → correlator NOT called', async () => {
    let calls = 0;
    const result = await correlateForCisoChains({
      findings: TWO_FINDINGS,
      askClaude: async () => '',
      _correlate: async () => { calls += 1; return { ok: true, chains: [], summary: '', reason: null }; },
    });
    assert.equal(calls, 0);
    assert.equal(result.skipped, true);
  });
});

// ─── 5. Empty / single-finding scans → correlator NOT called ────────────────

describe('correlateForCisoChains — insufficient findings skip the correlator', () => {
  it('empty findings → correlator NOT called', async () => {
    let calls = 0;
    const result = await correlateForCisoChains({
      tier: 'nuclear',
      findings: [],
      askClaude: async () => '',
      _correlate: async () => { calls += 1; return { ok: true, chains: [], summary: '', reason: null }; },
    });
    assert.equal(calls, 0);
    assert.equal(result.skipped, true);
    assert.match(result.note, /insufficient findings/);
  });

  it('single finding → correlator NOT called (need ≥ 2 for a chain)', async () => {
    let calls = 0;
    const result = await correlateForCisoChains({
      tier: 'nuclear',
      findings: ONE_FINDING,
      askClaude: async () => '',
      _correlate: async () => { calls += 1; return { ok: true, chains: [], summary: '', reason: null }; },
    });
    assert.equal(calls, 0);
    assert.equal(result.skipped, true);
  });

  it('findings is not an array → correlator NOT called', async () => {
    let calls = 0;
    const result = await correlateForCisoChains({
      tier: 'nuclear',
      findings: undefined,
      askClaude: async () => '',
      _correlate: async () => { calls += 1; return { ok: true, chains: [], summary: '', reason: null }; },
    });
    assert.equal(calls, 0);
    assert.equal(result.skipped, true);
  });
});

// ─── 6. Missing Claude client → graceful skip ───────────────────────────────

describe('correlateForCisoChains — missing Claude client', () => {
  it('askClaude not supplied → correlator NOT called, chains:[]', async () => {
    let calls = 0;
    const result = await correlateForCisoChains({
      tier: 'nuclear',
      findings: TWO_FINDINGS,
      // askClaude omitted
      _correlate: async () => { calls += 1; return { ok: true, chains: [], summary: '', reason: null }; },
    });
    assert.equal(calls, 0);
    assert.equal(result.skipped, true);
    assert.match(result.note, /no Claude client configured/);
  });
});

// ─── 7. End-to-end with the REAL cross-finding-correlator + stub Claude ─────

describe('correlateForCisoChains — end-to-end with real correlator', () => {
  it('real correlator parses a SKIP response → chains:[], ok outcome (no note)', async () => {
    // The real correlator treats a SKIP marker as ok:true / chains:[]
    // — the honest "findings appear independent" outcome.
    const stubClaude = async () => 'SKIP: no chains identified — findings appear independent';
    const result = await correlateForCisoChains({
      tier: 'nuclear',
      findings: TWO_FINDINGS,
      askClaude: stubClaude,
      _correlate: correlateFindings, // real engine
    });
    assert.deepEqual(result.chains, []);
    assert.equal(result.note, null);
    assert.equal(result.skipped, false);
  });

  it('real correlator parses a well-formed chain block → chains surface end-to-end', async () => {
    const fakeResponse =
      'CHAIN: XSS to session takeover\n' +
      'SEVERITY: critical\n' +
      'INVOLVES: 1, 2, 3\n' +
      'IMPACT: Attacker injects via unsafe-inline and reads session cookie.\n' +
      'FIX_ORDER: Tighten CSP first.\n';
    const stubClaude = async () => fakeResponse;
    const result = await correlateForCisoChains({
      tier: 'nuclear',
      findings: TWO_FINDINGS,
      askClaude: stubClaude,
      _correlate: correlateFindings, // real engine
    });
    assert.equal(result.chains.length, 1);
    assert.equal(result.chains[0].title, 'XSS to session takeover');
    assert.equal(result.chains[0].severity, 'critical');
    assert.deepEqual(result.chains[0].findingNumbers, [1, 2, 3]);
    assert.equal(result.chains[0].findingsInvolved.length, 3);
    assert.equal(result.note, null);
  });
});

// ─── 8. Sanity — exported constant ──────────────────────────────────────────

describe('correlateForCisoChains — exported constants', () => {
  it('DEFAULT_TIMEOUT_MS is a positive integer (~30s)', () => {
    assert.ok(Number.isInteger(DEFAULT_TIMEOUT_MS));
    assert.ok(DEFAULT_TIMEOUT_MS >= 5_000);
    assert.ok(DEFAULT_TIMEOUT_MS <= 60_000);
  });
});
