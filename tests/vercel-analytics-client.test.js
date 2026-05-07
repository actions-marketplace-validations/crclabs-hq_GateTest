'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  normaliseRoute,
  aggregateEvents,
  fetchFunctionMetrics,
  VERCEL_API_BASE,
  DEFAULT_SINCE_HOURS,
} = require('../website/app/lib/vercel-analytics-client');

// ─── normaliseRoute ───────────────────────────────────────────────────────────

describe('normaliseRoute', () => {
  it('returns empty string for empty input', () => {
    assert.equal(normaliseRoute(''), '');
    assert.equal(normaliseRoute(null), '');
    assert.equal(normaliseRoute(undefined), '');
  });

  it('strips query strings', () => {
    assert.equal(normaliseRoute('/api/users?page=1&limit=10'), '/api/users');
  });

  it('replaces numeric IDs with :id', () => {
    assert.equal(normaliseRoute('/api/users/123'), '/api/users/:id');
    assert.equal(normaliseRoute('/api/orders/456/items'), '/api/orders/:id/items');
  });

  it('handles multiple numeric segments', () => {
    assert.equal(normaliseRoute('/api/users/1/orders/2'), '/api/users/:id/orders/:id');
  });

  it('strips trailing slashes', () => {
    assert.equal(normaliseRoute('/api/users/'), '/api/users');
  });

  it('preserves non-numeric path segments', () => {
    assert.equal(normaliseRoute('/api/checkout'), '/api/checkout');
    assert.equal(normaliseRoute('/api/scan/run'), '/api/scan/run');
  });

  it('handles root path', () => {
    assert.equal(normaliseRoute('/'), '');
  });
});

// ─── aggregateEvents ─────────────────────────────────────────────────────────

describe('aggregateEvents', () => {
  it('returns empty array for empty input', () => {
    assert.deepEqual(aggregateEvents([]), []);
  });

  it('ignores non-error event types', () => {
    const events = [
      { type: 'info', path: '/api/users' },
      { type: 'ready', path: '/api/scan' },
    ];
    assert.deepEqual(aggregateEvents(events), []);
  });

  it('aggregates error events by route', () => {
    const events = [
      { type: 'error', payload: { path: '/api/checkout' }, created: '2026-05-05' },
      { type: 'error', payload: { path: '/api/checkout' }, created: '2026-05-06' },
      { type: 'error', payload: { path: '/api/users' }, created: '2026-05-01' },
    ];
    const result = aggregateEvents(events);
    assert.equal(result.length, 2);
    const checkout = result.find((r) => r.route === '/api/checkout');
    assert.ok(checkout);
    assert.equal(checkout.errorCount, 2);
    assert.equal(checkout.lastSeen, '2026-05-06');
  });

  it('handles events with top-level path field', () => {
    const events = [
      { type: 'error', path: '/api/scan', created: '2026-05-06' },
    ];
    const result = aggregateEvents(events);
    assert.equal(result.length, 1);
    assert.equal(result[0].route, '/api/scan');
  });

  it('normalises routes (strips numeric IDs)', () => {
    const events = [
      { type: 'error', payload: { path: '/api/users/123' }, created: '2026-05-06' },
      { type: 'error', payload: { path: '/api/users/456' }, created: '2026-05-05' },
    ];
    const result = aggregateEvents(events);
    assert.equal(result.length, 1);
    assert.equal(result[0].route, '/api/users/:id');
    assert.equal(result[0].errorCount, 2);
  });

  it('ignores events with no path', () => {
    const events = [
      { type: 'error', payload: {} },
      { type: 'error' },
    ];
    assert.deepEqual(aggregateEvents(events), []);
  });

  it('tracks most recent lastSeen', () => {
    const events = [
      { type: 'error', path: '/api/x', created: '2026-05-01' },
      { type: 'error', path: '/api/x', created: '2026-05-06' },
      { type: 'error', path: '/api/x', created: '2026-05-03' },
    ];
    const result = aggregateEvents(events);
    assert.equal(result[0].lastSeen, '2026-05-06');
  });
});

// ─── Constants ────────────────────────────────────────────────────────────────

describe('module constants', () => {
  it('exports VERCEL_API_BASE pointing to api.vercel.com', () => {
    assert.ok(VERCEL_API_BASE.includes('vercel.com'));
  });

  it('exports DEFAULT_SINCE_HOURS as 7 days', () => {
    assert.equal(DEFAULT_SINCE_HOURS, 24 * 7);
  });
});

// ─── fetchFunctionMetrics (mocked) ────────────────────────────────────────────

describe('fetchFunctionMetrics', () => {
  it('throws when accessToken is missing', async () => {
    await assert.rejects(
      () => fetchFunctionMetrics({ accessToken: '', projectId: 'proj' }),
      /accessToken is required/,
    );
  });

  it('throws when projectId is missing', async () => {
    await assert.rejects(
      () => fetchFunctionMetrics({ accessToken: 'tok', projectId: '' }),
      /projectId is required/,
    );
  });

  it('throws on non-OK deployment list response', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => 'Unauthorized' });

    try {
      await assert.rejects(
        () => fetchFunctionMetrics({ accessToken: 'tok', projectId: 'proj' }),
        /Vercel API error 401/,
      );
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('returns empty array when no deployments', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ deployments: [] }),
    });

    try {
      const result = await fetchFunctionMetrics({ accessToken: 'tok', projectId: 'proj' });
      assert.deepEqual(result, []);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('includes teamId in deployments URL when provided', async () => {
    let calledUrl = '';
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      calledUrl = url;
      return { ok: true, json: async () => ({ deployments: [] }) };
    };

    try {
      await fetchFunctionMetrics({ accessToken: 'tok', projectId: 'proj', teamId: 'team_abc' });
      assert.ok(calledUrl.includes('teamId=team_abc'));
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('aggregates error events from deployment events endpoint', async () => {
    let callCount = 0;
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      callCount++;
      if (url.includes('/deployments?')) {
        return {
          ok: true,
          json: async () => ({ deployments: [{ uid: 'dep-1' }] }),
        };
      }
      // Events endpoint
      return {
        ok: true,
        json: async () => [
          { type: 'error', payload: { path: '/api/checkout' }, created: '2026-05-06' },
          { type: 'error', payload: { path: '/api/checkout' }, created: '2026-05-05' },
          { type: 'info', payload: { path: '/api/scan' } },
        ],
      };
    };

    try {
      const result = await fetchFunctionMetrics({ accessToken: 'tok', projectId: 'proj' });
      assert.ok(callCount >= 2);
      const checkout = result.find((r) => r.route === '/api/checkout');
      assert.ok(checkout);
      assert.equal(checkout.errorCount, 2);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('handles failed events endpoint gracefully (non-blocking)', async () => {
    const origFetch = globalThis.fetch;
    let callCount = 0;
    globalThis.fetch = async (url) => {
      callCount++;
      if (url.includes('/deployments?')) {
        return { ok: true, json: async () => ({ deployments: [{ uid: 'dep-1' }] }) };
      }
      return { ok: false, status: 500 };
    };

    try {
      const result = await fetchFunctionMetrics({ accessToken: 'tok', projectId: 'proj' });
      assert.deepEqual(result, []); // failed gracefully
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
