'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  extractStackFrames,
  normaliseEvent,
  DATADOG_API_BASE,
  DATADOG_EU_API_BASE,
  DEFAULT_LOOKBACK_DAYS,
  MAX_ERRORS,
} = require('../website/app/lib/datadog-client');

// ─── extractStackFrames ───────────────────────────────────────────────────────

describe('extractStackFrames', () => {
  it('returns empty array for empty input', () => {
    assert.deepEqual(extractStackFrames(''), []);
    assert.deepEqual(extractStackFrames(null), []);
    assert.deepEqual(extractStackFrames(undefined), []);
  });

  it('extracts Node.js style stack frames', () => {
    const stack = `Error: Something went wrong
    at handler (src/api/checkout.ts:42:10)
    at processRequest (src/middleware.ts:18:5)`;
    const frames = extractStackFrames(stack);
    assert.equal(frames.length, 2);
    assert.equal(frames[0].file, 'src/api/checkout.ts');
    assert.equal(frames[0].lineno, 42);
    assert.equal(frames[1].file, 'src/middleware.ts');
    assert.equal(frames[1].lineno, 18);
  });

  it('extracts .js frames', () => {
    const stack = '    at handler (app/api/route.js:15:3)';
    const frames = extractStackFrames(stack);
    assert.equal(frames.length, 1);
    assert.equal(frames[0].file, 'app/api/route.js');
    assert.equal(frames[0].lineno, 15);
  });

  it('extracts .mjs frames', () => {
    const stack = '    at fn (src/worker.mjs:5:1)';
    const frames = extractStackFrames(stack);
    assert.equal(frames.length, 1);
    assert.equal(frames[0].lineno, 5);
  });

  it('extracts Python stack frames when no Node frames', () => {
    const stack = `Traceback (most recent call last):
  File "src/api/views.py", line 87, in post
    result = process()`;
    const frames = extractStackFrames(stack);
    assert.equal(frames.length, 1);
    assert.equal(frames[0].file, 'src/api/views.py');
    assert.equal(frames[0].lineno, 87);
  });

  it('returns at most 10 frames', () => {
    const lines = Array.from({ length: 15 }, (_, i) => `    at fn${i} (src/f${i}.ts:${i + 1}:1)`);
    const stack = lines.join('\n');
    const frames = extractStackFrames(stack);
    assert.ok(frames.length <= 10);
  });

  it('returns empty when no recognisable frames', () => {
    const stack = 'Something bad happened at the server level';
    const frames = extractStackFrames(stack);
    assert.deepEqual(frames, []);
  });
});

// ─── normaliseEvent ───────────────────────────────────────────────────────────

describe('normaliseEvent', () => {
  it('returns null for null input', () => {
    assert.equal(normaliseEvent(null), null);
    assert.equal(normaliseEvent(undefined), null);
    assert.equal(normaliseEvent('string'), null);
  });

  it('normalises a basic Datadog log event', () => {
    const event = {
      id: 'abc123',
      attributes: {
        message: 'Error: Auth failed\n    at handler (src/api/auth.ts:22:5)',
        tags: ['service:api', 'env:production'],
        timestamp: '2026-05-06T10:00:00.000Z',
      },
    };
    const result = normaliseEvent(event);
    assert.ok(result);
    assert.equal(result.id, 'abc123');
    assert.ok(result.message.includes('Auth failed'));
    assert.equal(result.service, 'api');
    assert.equal(result.env, 'production');
    assert.equal(result.frames.length, 1);
    assert.equal(result.frames[0].file, 'src/api/auth.ts');
    assert.equal(result.frames[0].lineno, 22);
  });

  it('uses error.message field when available', () => {
    const event = {
      id: 'x',
      attributes: {
        message: 'full stack trace\n    at fn (src/x.ts:1:1)',
        error: { message: 'Specific error text' },
        tags: [],
      },
    };
    const result = normaliseEvent(event);
    assert.equal(result.message, 'Specific error text');
  });

  it('extracts service and env from tags', () => {
    const event = {
      id: 'y',
      attributes: {
        message: 'err',
        tags: ['service:checkout', 'env:prod', 'version:1.2.3'],
      },
    };
    const result = normaliseEvent(event);
    assert.equal(result.service, 'checkout');
    assert.equal(result.env, 'prod');
  });

  it('handles missing tags gracefully', () => {
    const event = {
      id: 'z',
      attributes: { message: 'err', tags: null },
    };
    const result = normaliseEvent(event);
    assert.ok(result);
    assert.equal(result.service, '');
    assert.equal(result.env, '');
  });

  it('extracts frames from error.stack when message has no frames', () => {
    const event = {
      id: 'w',
      attributes: {
        message: 'Error occurred',
        error: {
          message: 'Short message',
          stack: 'Error: x\n    at process (src/handler.js:55:3)',
        },
        tags: [],
      },
    };
    const result = normaliseEvent(event);
    assert.equal(result.frames.length, 1);
    assert.equal(result.frames[0].file, 'src/handler.js');
    assert.equal(result.frames[0].lineno, 55);
  });

  it('returns empty frames when none extractable', () => {
    const event = { id: 'no-frames', attributes: { message: 'plain error', tags: [] } };
    const result = normaliseEvent(event);
    assert.deepEqual(result.frames, []);
  });

  it('converts id to string', () => {
    const event = { id: 12345, attributes: { message: 'err', tags: [] } };
    const result = normaliseEvent(event);
    assert.equal(typeof result.id, 'string');
    assert.equal(result.id, '12345');
  });
});

// ─── Constants ────────────────────────────────────────────────────────────────

describe('module constants', () => {
  it('exports DATADOG_API_BASE as US endpoint', () => {
    assert.ok(DATADOG_API_BASE.includes('datadoghq.com'));
    assert.ok(!DATADOG_API_BASE.includes('.eu'));
  });

  it('exports DATADOG_EU_API_BASE as EU endpoint', () => {
    assert.ok(DATADOG_EU_API_BASE.includes('.eu'));
  });

  it('exports DEFAULT_LOOKBACK_DAYS', () => {
    assert.equal(typeof DEFAULT_LOOKBACK_DAYS, 'number');
    assert.ok(DEFAULT_LOOKBACK_DAYS > 0);
  });

  it('exports MAX_ERRORS', () => {
    assert.equal(typeof MAX_ERRORS, 'number');
    assert.ok(MAX_ERRORS >= 50);
  });
});

// ─── fetchTopErrors (mocked) ──────────────────────────────────────────────────

describe('fetchTopErrors', () => {
  const { fetchTopErrors } = require('../website/app/lib/datadog-client');

  it('throws when apiKey is missing', async () => {
    await assert.rejects(
      () => fetchTopErrors({ apiKey: '', appKey: 'key' }),
      /apiKey is required/,
    );
  });

  it('throws when appKey is missing', async () => {
    await assert.rejects(
      () => fetchTopErrors({ apiKey: 'key', appKey: '' }),
      /appKey is required/,
    );
  });

  it('calls Datadog EU endpoint when site is datadoghq.eu', async () => {
    let calledUrl = '';
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      calledUrl = url;
      return { ok: true, json: async () => ({ data: [] }) };
    };

    try {
      await fetchTopErrors({ apiKey: 'k', appKey: 'a', site: 'datadoghq.eu' });
      assert.ok(calledUrl.includes('datadoghq.eu'));
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('calls US endpoint by default', async () => {
    let calledUrl = '';
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      calledUrl = url;
      return { ok: true, json: async () => ({ data: [] }) };
    };

    try {
      await fetchTopErrors({ apiKey: 'k', appKey: 'a' });
      assert.ok(calledUrl.includes('datadoghq.com'));
      assert.ok(!calledUrl.includes('.eu'));
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('throws on non-OK HTTP response', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 403, text: async () => 'Forbidden' });

    try {
      await assert.rejects(
        () => fetchTopErrors({ apiKey: 'k', appKey: 'a' }),
        /Datadog API error 403/,
      );
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('returns empty array when data is absent', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ data: null }),
    });

    try {
      const events = await fetchTopErrors({ apiKey: 'k', appKey: 'a' });
      assert.deepEqual(events, []);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('normalises returned events', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        data: [{
          id: 'ev1',
          attributes: {
            message: 'Error: oops\n    at handler (src/api.ts:10:1)',
            tags: ['service:web'],
            timestamp: '2026-05-01T00:00:00Z',
          },
        }],
      }),
    });

    try {
      const events = await fetchTopErrors({ apiKey: 'k', appKey: 'a' });
      assert.equal(events.length, 1);
      assert.equal(events[0].service, 'web');
      assert.equal(events[0].frames[0].file, 'src/api.ts');
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
