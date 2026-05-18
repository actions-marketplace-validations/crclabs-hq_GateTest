// ============================================================================
// SELF-SCAN-BADGE COMPONENT TEST
// ============================================================================
// The badge's rendering logic is intentionally factored into a pure helper
// (`deriveBadgeState` in `website/app/lib/self-scan-status.js`) so the
// three visual states can be exhaustively unit-tested with no DOM, no JSDOM,
// and no React renderer — staying inside the project's "node:test only,
// zero new deps" testing pattern.
//
// What this file proves:
//   - GREEN state derives correctly from a PASSED payload
//   - BLOCKED state derives correctly from a BLOCKED payload
//   - no-data payload → awaiting state
//   - fetch error (null data + fetchError=true) → awaiting state
//   - metric line composes module / error / warning / age text correctly
//   - commit SHA is shortened to 7 chars
//   - ARIA-label includes the status text for screen-reader announcement
//
// Visual styling (Tailwind class names, dot colors, hover states) is a
// pure mechanical mapping of `state.variant` → class strings in the TSX
// component. The variants themselves are exhaustive and tested here.
// ============================================================================

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const helper = require(
  path.resolve(
    __dirname,
    '..',
    'website',
    'app',
    'lib',
    'self-scan-status.js',
  ),
);

function passedPayload(overrides = {}) {
  return {
    gateStatus: 'PASSED',
    errorCount: 0,
    warningCount: 12,
    modulesPassedCount: 91,
    modulesTotalCount: 91,
    scannedAt: '2026-05-17T13:42:00Z',
    commitSha: 'abc1234def5678',
    ageMinutes: 4,
    ...overrides,
  };
}

function blockedPayload(overrides = {}) {
  return {
    gateStatus: 'BLOCKED',
    errorCount: 3,
    warningCount: 5,
    modulesPassedCount: 88,
    modulesTotalCount: 91,
    scannedAt: '2026-05-17T13:42:00Z',
    commitSha: 'bad0000feed',
    ageMinutes: 11,
    ...overrides,
  };
}

describe('deriveBadgeState — GREEN', () => {
  it('renders variant=passed for PASSED payload', () => {
    const state = helper.deriveBadgeState(passedPayload(), false);
    assert.strictEqual(state.variant, 'passed');
    assert.strictEqual(state.labelText, 'GREEN');
  });

  it('composes the metric line correctly', () => {
    const state = helper.deriveBadgeState(passedPayload(), false);
    assert.match(state.metricLine, /91\/91 modules/);
    assert.match(state.metricLine, /0 errors/);
    assert.match(state.metricLine, /12 warnings/);
    assert.match(state.metricLine, /4 min ago/);
  });

  it('shortens commit SHA to 7 chars', () => {
    const state = helper.deriveBadgeState(passedPayload(), false);
    assert.strictEqual(state.commitShaShort, 'abc1234');
  });

  it('ARIA-label includes status text', () => {
    const state = helper.deriveBadgeState(passedPayload(), false);
    assert.match(state.ariaLabel, /Self-scan status: GREEN/);
    assert.match(state.ariaLabel, /91\/91 modules/);
  });

  it('handles age=0 ("just now")', () => {
    const state = helper.deriveBadgeState(
      passedPayload({ ageMinutes: 0 }),
      false,
    );
    assert.match(state.metricLine, /just now/);
  });

  it('handles age=1 ("1 min ago")', () => {
    const state = helper.deriveBadgeState(
      passedPayload({ ageMinutes: 1 }),
      false,
    );
    assert.match(state.metricLine, /1 min ago/);
  });

  it('handles hour-scale age', () => {
    const state = helper.deriveBadgeState(
      passedPayload({ ageMinutes: 125 }),
      false,
    );
    assert.match(state.metricLine, /2 hr ago/);
  });

  it('handles day-scale age', () => {
    const state = helper.deriveBadgeState(
      passedPayload({ ageMinutes: 60 * 24 * 3 + 15 }),
      false,
    );
    assert.match(state.metricLine, /3 days ago/);
  });
});

describe('deriveBadgeState — BLOCKED', () => {
  it('renders variant=blocked for BLOCKED payload', () => {
    const state = helper.deriveBadgeState(blockedPayload(), false);
    assert.strictEqual(state.variant, 'blocked');
    assert.strictEqual(state.labelText, 'BLOCKED');
  });

  it('includes non-zero error count in metric line', () => {
    const state = helper.deriveBadgeState(blockedPayload(), false);
    assert.match(state.metricLine, /3 errors/);
  });

  it('ARIA-label includes BLOCKED status', () => {
    const state = helper.deriveBadgeState(blockedPayload(), false);
    assert.match(state.ariaLabel, /Self-scan status: BLOCKED/);
  });
});

describe('deriveBadgeState — awaiting', () => {
  it('renders variant=awaiting on null data', () => {
    const state = helper.deriveBadgeState(null, false);
    assert.strictEqual(state.variant, 'awaiting');
    assert.strictEqual(state.labelText, 'Awaiting first scan');
    assert.strictEqual(state.metricLine, null);
    assert.strictEqual(state.commitShaShort, null);
  });

  it('renders variant=awaiting on no-data shape', () => {
    const state = helper.deriveBadgeState(
      {
        status: 'no-data',
        message: 'Awaiting first self-scan on the main branch',
      },
      false,
    );
    assert.strictEqual(state.variant, 'awaiting');
  });

  it('renders variant=awaiting on fetch error', () => {
    const state = helper.deriveBadgeState(passedPayload(), true);
    assert.strictEqual(state.variant, 'awaiting');
    assert.strictEqual(state.labelText, 'Awaiting first scan');
  });

  it('ARIA-label for awaiting is polite + descriptive', () => {
    const state = helper.deriveBadgeState(null, false);
    assert.match(state.ariaLabel, /Self-scan status:/);
    assert.match(state.ariaLabel, /awaiting first scan/i);
  });
});

describe('SelfScanBadge.tsx — file-level invariants', () => {
  const tsx = fs.readFileSync(
    path.resolve(__dirname, '..', 'website', 'app', 'components', 'SelfScanBadge.tsx'),
    'utf-8',
  );

  it('declares "use client" — required for useEffect / useState', () => {
    assert.match(tsx, /^"use client";/m);
  });

  it('sets role="status" + aria-live="polite" on the badge root', () => {
    assert.match(tsx, /role="status"/);
    assert.match(tsx, /aria-live="polite"/);
  });

  it('points the workflow link at the GitHub Actions page by default', () => {
    assert.match(tsx, /github\.com\/crclabs-hq\/gatetest\/actions/i);
  });

  it('uses cache: "no-store" so the badge never serves stale data', () => {
    assert.match(tsx, /cache:\s*"no-store"/);
  });

  it('imports the shared deriveBadgeState helper', () => {
    assert.match(tsx, /self-scan-status/);
    assert.match(tsx, /deriveBadgeState/);
  });

  it('default poll interval is 60_000 ms', () => {
    assert.match(tsx, /DEFAULT_POLL_MS\s*=\s*60_000/);
  });

  it('opens the workflow link in a new tab with rel="noopener noreferrer"', () => {
    assert.match(tsx, /target="_blank"/);
    assert.match(tsx, /rel="noopener noreferrer"/);
  });

  it('exposes data-variant for E2E tests / debugging', () => {
    assert.match(tsx, /data-variant=/);
  });
});
