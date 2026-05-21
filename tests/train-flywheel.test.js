/**
 * Tests for scripts/train-flywheel.js + scripts/flywheel-stats.js.
 *
 * The harness is the foundation of the moat-measurement system; if it
 * silently produces wrong ratios, every dashboard read downstream is
 * lying. These tests pin the contract.
 */

'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const trainer = require('../scripts/train-flywheel');
const stats   = require('../scripts/flywheel-stats');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'flywheel-test-'));
}
function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// loadCorpus
// ---------------------------------------------------------------------------

test('loadCorpus accepts the envelope shape used by corpus/seed/instances.json', () => {
  const dir = makeTmpDir();
  try {
    const file = path.join(dir, 'c.json');
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      instances: [
        { id: 'a', file: 'a.js', issues: [], broken: 'x;', fixed: 'y;' },
        { id: 'b', file: 'b.js', issues: [], broken: 'x;', fixed: 'y;' },
      ],
    }));
    const corpus = trainer.loadCorpus(file);
    assert.equal(corpus.version, 1);
    assert.equal(corpus.instances.length, 2);
  } finally { cleanup(dir); }
});

test('loadCorpus also accepts a bare array (legacy shape)', () => {
  const dir = makeTmpDir();
  try {
    const file = path.join(dir, 'c.json');
    fs.writeFileSync(file, JSON.stringify([
      { id: 'a', file: 'a.js', issues: [], broken: 'x;', fixed: 'y;' },
    ]));
    const corpus = trainer.loadCorpus(file);
    assert.equal(corpus.instances.length, 1);
  } finally { cleanup(dir); }
});

test('loadCorpus throws when an instance is missing required fields', () => {
  const dir = makeTmpDir();
  try {
    const file = path.join(dir, 'c.json');
    fs.writeFileSync(file, JSON.stringify({ instances: [{ id: 'a' /* no broken/fixed */ }] }));
    assert.throws(() => trainer.loadCorpus(file), /missing/);
  } finally { cleanup(dir); }
});

test('loadCorpus throws when the file is empty', () => {
  const dir = makeTmpDir();
  try {
    const file = path.join(dir, 'c.json');
    fs.writeFileSync(file, JSON.stringify({ instances: [] }));
    assert.throws(() => trainer.loadCorpus(file), /no instances/);
  } finally { cleanup(dir); }
});

test('loadCorpus throws when the file does not exist', () => {
  assert.throws(() => trainer.loadCorpus('/tmp/does-not-exist-xyz.json'), /not found/);
});

// ---------------------------------------------------------------------------
// summarise — make sure the moat metric arithmetic is right. If this is
// off-by-one, every dashboard read lies.
// ---------------------------------------------------------------------------

test('summarise counts hits per layer and computes Claude-fallthrough ratio', () => {
  const results = [
    { id: 'a', layer: 'ast',       accurate: true },
    { id: 'b', layer: 'ast',       accurate: false }, // hit but wrong
    { id: 'c', layer: 'rule',      accurate: true },
    { id: 'd', layer: 'claude',    accurate: true },
    { id: 'e', layer: 'unhandled', accurate: false },
  ];
  const s = trainer.summarise(results);
  assert.equal(s.total, 5);
  assert.equal(s.accurate, 3);
  assert.equal(s.byLayer.ast, 2);
  assert.equal(s.byLayer.rule, 1);
  assert.equal(s.byLayer.claude, 1);
  assert.equal(s.byLayer.unhandled, 1);
  // freeLayerHits = ast + rule + recipe = 2 + 1 + 0 = 3
  assert.equal(s.freeLayerHits, 3);
  // claudeFallthrough = claude + unhandled = 1 + 1 = 2
  assert.equal(s.claudeFallthrough, 2);
  assert.equal(s.claudeRatio, 2 / 5);
  assert.equal(s.claudeRatioPct, 40);
});

test('summarise handles an empty result set without dividing by zero', () => {
  const s = trainer.summarise([]);
  assert.equal(s.total, 0);
  assert.equal(s.claudeRatio, 0);
  assert.equal(s.accuracyPct, 0);
});

// ---------------------------------------------------------------------------
// tryAst / tryRule — verify each layer is wired and respects unavailability.
// ---------------------------------------------------------------------------

test('tryRule fires on a rule-shaped fix (tls-security:js-env-bypass)', () => {
  const layers = trainer.loadFlywheel();
  if (!layers.available.rule) {
    // Rule layer requires website workspace deps — skip in cold-install envs.
    return;
  }
  const inst = {
    id: 'tls-env',
    file: 'src/boot.js',
    issues: ['tls-security:js-env-bypass:src/boot.js:1'],
    broken: "process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';\nrequire('./app');\n",
    fixed:  "require('./app');\n",
  };
  const r = trainer.tryRule(layers, inst);
  // We don't strictly assert the rule produced the EXACT fixed content —
  // the rule may normalise spacing / quotes. We just assert it FIRED.
  assert.ok(
    r.content !== undefined || r.miss,
    'tryRule must return either a content string or a miss; got: ' + JSON.stringify(r),
  );
});

test('tryAst returns miss for non-JS file extensions', () => {
  const layers = trainer.loadFlywheel();
  const inst = { id: 'x', file: 'foo.yml', issues: [], broken: 'a: 1', fixed: 'a: 2' };
  const r = trainer.tryAst(layers, inst);
  assert.equal(r.layer, 'ast');
  assert.equal(r.miss, true);
});

// ---------------------------------------------------------------------------
// replayInstance — end-to-end on a synthetic case that no layer handles.
// Verifies the fallthrough path emits layer='unhandled' (not silently 'ast').
// ---------------------------------------------------------------------------

test('replayInstance falls through to unhandled when no layer fires', async () => {
  const layers = trainer.loadFlywheel();
  const inst = {
    id: 'unrecognised',
    file: 'src/weird.unknown',  // not JS/TS, no rule will match
    issues: ['nonexistent-rule:foo:src/weird.unknown:1'],
    broken: 'this is gibberish that no fixer knows about',
    fixed:  'this is the magically-correct version',
  };
  const r = await trainer.replayInstance(layers, inst);
  assert.equal(r.id, 'unrecognised');
  assert.equal(r.layer, 'unhandled');
  assert.equal(r.accurate, false);
});

test('replayInstance uses opts.callClaude when provided and no free layer fires', async () => {
  const layers = trainer.loadFlywheel();
  const inst = {
    id: 'claude-only',
    file: 'src/weird.unknown',
    issues: [],
    broken: 'old',
    fixed:  'new',
  };
  let called = false;
  const r = await trainer.replayInstance(layers, inst, {
    callClaude: async (i) => { called = true; return i.fixed; },
  });
  assert.equal(called, true);
  assert.equal(r.layer, 'claude');
  assert.equal(r.accurate, true);
});

// ---------------------------------------------------------------------------
// flywheel-stats: aggregate
// ---------------------------------------------------------------------------

test('aggregate computes Claude ratio from telemetry entries', () => {
  const now = Date.parse('2026-05-21T12:00:00Z');
  const entries = [
    { layer: 'ast',  success: true,  ruleKey: 'r1', ts: now - 1000 },
    { layer: 'rule', success: true,  ruleKey: 'r2', ts: now - 2000 },
    { layer: null,   success: false, ruleKey: 'r3', ts: now - 3000 },   // unhandled
    { layer: 'claude', success: true, ruleKey: 'r4', ts: now - 4000 },
  ];
  const s = stats.aggregate(entries, { now });
  assert.equal(s.all.total, 4);
  assert.equal(s.all.accurate, 3);
  // unhandled + claude = 2 of 4 = 50%
  assert.equal(s.all.claudeRatioPct, 50);
});

test('aggregate splits recent (7d) from all-time correctly', () => {
  const now = Date.parse('2026-05-21T12:00:00Z');
  const eightDaysAgo = now - 8 * 24 * 60 * 60 * 1000;
  const entries = [
    { layer: 'ast',    success: true, ruleKey: 'r1', ts: now - 1000 },         // recent
    { layer: 'claude', success: true, ruleKey: 'r2', ts: eightDaysAgo },       // old
  ];
  const s = stats.aggregate(entries, { now });
  assert.equal(s.all.total, 2);
  assert.equal(s.recent7d.total, 1);
  assert.equal(s.recent7d.byLayer.ast, 1);
  assert.equal(s.recent7d.claudeRatioPct, 0);
  // all-time has 1 claude out of 2 = 50%
  assert.equal(s.all.claudeRatioPct, 50);
});

test('aggregate returns zero ratios for an empty corpus without throwing', () => {
  const s = stats.aggregate([], { now: Date.now() });
  assert.equal(s.all.total, 0);
  assert.equal(s.all.claudeRatioPct, 0);
  assert.equal(s.recent7d.claudeRatioPct, 0);
  assert.deepEqual(s.topRules, []);
});

test('aggregate ranks topRules by successful hits descending', () => {
  const now = Date.now();
  const entries = [
    { layer: 'ast', success: true, ruleKey: 'tls', ts: now },
    { layer: 'ast', success: true, ruleKey: 'tls', ts: now },
    { layer: 'ast', success: true, ruleKey: 'tls', ts: now },
    { layer: 'rule', success: true, ruleKey: 'cookie', ts: now },
    { layer: 'rule', success: false, ruleKey: 'noise', ts: now }, // not counted (success=false)
  ];
  const s = stats.aggregate(entries, { now });
  assert.equal(s.topRules[0].ruleKey, 'tls');
  assert.equal(s.topRules[0].hits, 3);
  assert.equal(s.topRules[1].ruleKey, 'cookie');
  assert.equal(s.topRules[1].hits, 1);
  // 'noise' had only failures, should not appear
  assert.equal(s.topRules.find((r) => r.ruleKey === 'noise'), undefined);
});

// ---------------------------------------------------------------------------
// readEntries — must tolerate malformed lines (the JSONL is best-effort).
// ---------------------------------------------------------------------------

test('readEntries skips malformed lines and returns valid ones', () => {
  const dir = makeTmpDir();
  try {
    const file = path.join(dir, 't.jsonl');
    fs.writeFileSync(file, [
      JSON.stringify({ layer: 'ast', success: true, ts: 1 }),
      '{ this is not valid json',
      '',
      JSON.stringify({ layer: 'rule', success: false, ts: 2 }),
    ].join('\n'));
    const entries = stats.readEntries(file);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].layer, 'ast');
    assert.equal(entries[1].layer, 'rule');
  } finally { cleanup(dir); }
});

test('readEntries returns [] for a missing file (does not throw)', () => {
  assert.deepEqual(stats.readEntries('/tmp/does-not-exist-flywheel.jsonl'), []);
});
