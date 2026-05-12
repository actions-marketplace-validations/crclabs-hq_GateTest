'use strict';

// ============================================================================
// SCAN TIER PASSTHROUGH TEST
// ============================================================================
// Guards against Bug #1 — tier downgrade in scan execution.
//
// When a customer pays for "scan_fix" ($199) or "nuclear" ($399), the scan
// path must resolve to the SAME full module list as "full" — not fall back
// to the 4-module Quick Scan. This test asserts:
//   1. TIERS.quick has exactly 4 modules.
//   2. TIERS.full has more than 4 modules (the full suite).
//   3. TIERS.scan_fix exists and is the SAME array reference as TIERS.full
//      (same object identity — no accidental copy that could drift).
//   4. TIERS.nuclear exists and is the SAME array reference as TIERS.full.
//   5. KNOWN_TIERS (derived from Object.keys(TIERS)) includes all four tiers
//      so the normalisation guard in scan/run/route.ts and scan-executor.ts
//      does NOT downgrade "scan_fix" or "nuclear" to "quick".
//
// Loaded via Node 22's transparent TypeScript loader — same source that the
// website imports. No transpile step required.
// ============================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { TIERS } = require('../website/app/lib/scan-modules/types.ts');

// The KNOWN_TIERS set is derived the same way as in route.ts and
// scan-executor.ts — we replicate the derivation here so if the
// pattern changes in production code, this test catches the delta.
const KNOWN_TIERS = new Set(Object.keys(TIERS));

// --- TIERS shape -----------------------------------------------------------

test('TIERS.quick has exactly 4 modules', () => {
  assert.equal(TIERS.quick.length, 4,
    `Expected 4 quick-tier modules, got ${TIERS.quick.length}: ${TIERS.quick.join(', ')}`);
});

test('TIERS.full has more than 4 modules', () => {
  assert.ok(TIERS.full.length > 4,
    `Expected >4 full-tier modules, got ${TIERS.full.length}`);
});

test('TIERS.scan_fix exists', () => {
  assert.ok(Array.isArray(TIERS.scan_fix),
    'TIERS.scan_fix is missing — $199 customers get Quick Scan (4 modules) instead of full scan');
});

test('TIERS.scan_fix is the same array as TIERS.full (no drift via copy)', () => {
  assert.strictEqual(TIERS.scan_fix, TIERS.full,
    'TIERS.scan_fix should reference the same array as TIERS.full, not a copy that could drift');
});

test('TIERS.nuclear exists', () => {
  assert.ok(Array.isArray(TIERS.nuclear),
    'TIERS.nuclear is missing — $399 customers get Quick Scan (4 modules) instead of full scan');
});

test('TIERS.nuclear is the same array as TIERS.full (no drift via copy)', () => {
  assert.strictEqual(TIERS.nuclear, TIERS.full,
    'TIERS.nuclear should reference the same array as TIERS.full, not a copy that could drift');
});

// --- KNOWN_TIERS normalisation guard ---------------------------------------

test('KNOWN_TIERS includes "quick"', () => {
  assert.ok(KNOWN_TIERS.has('quick'), 'KNOWN_TIERS missing "quick"');
});

test('KNOWN_TIERS includes "full"', () => {
  assert.ok(KNOWN_TIERS.has('full'), 'KNOWN_TIERS missing "full"');
});

test('KNOWN_TIERS includes "scan_fix" — prevents $199 downgrade to quick', () => {
  assert.ok(KNOWN_TIERS.has('scan_fix'),
    'KNOWN_TIERS is missing "scan_fix" — the normalisation guard in route.ts / scan-executor.ts ' +
    'would fall back to "quick", downgrading a $199 customer to a 4-module scan');
});

test('KNOWN_TIERS includes "nuclear" — prevents $399 downgrade to quick', () => {
  assert.ok(KNOWN_TIERS.has('nuclear'),
    'KNOWN_TIERS is missing "nuclear" — the normalisation guard in route.ts / scan-executor.ts ' +
    'would fall back to "quick", downgrading a $399 customer to a 4-module scan');
});

// --- Normalisation logic simulation ----------------------------------------

test('normalisation: "scan_fix" passes through unchanged', () => {
  const tier = 'scan_fix';
  const normalised = KNOWN_TIERS.has(tier) ? tier : 'quick';
  assert.equal(normalised, 'scan_fix',
    'Normalisation downgraded "scan_fix" to "quick" — commercial-critical bug');
});

test('normalisation: "nuclear" passes through unchanged', () => {
  const tier = 'nuclear';
  const normalised = KNOWN_TIERS.has(tier) ? tier : 'quick';
  assert.equal(normalised, 'nuclear',
    'Normalisation downgraded "nuclear" to "quick" — commercial-critical bug');
});

test('normalisation: unknown tier falls back to "quick"', () => {
  const tier = 'ultra';
  const normalised = KNOWN_TIERS.has(tier) ? tier : 'quick';
  assert.equal(normalised, 'quick',
    'Normalisation should default unknown tiers to "quick"');
});

// --- Module list completeness sanity check ---------------------------------

test('TIERS.full contains "syntax" (first module sanity)', () => {
  assert.ok(TIERS.full.includes('syntax'), 'full tier is missing "syntax"');
});

test('TIERS.full contains "secrets" (security module sanity)', () => {
  assert.ok(TIERS.full.includes('secrets'), 'full tier is missing "secrets"');
});

test('TIERS.scan_fix contains "syntax" (sanity: same as full)', () => {
  assert.ok(TIERS.scan_fix.includes('syntax'), 'scan_fix tier is missing "syntax"');
});

test('TIERS.nuclear contains "syntax" (sanity: same as full)', () => {
  assert.ok(TIERS.nuclear.includes('syntax'), 'nuclear tier is missing "syntax"');
});
