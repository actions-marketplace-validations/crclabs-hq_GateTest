const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
  scrubEvent,
  scrubBreadcrumb,
  scrubFrameVars,
  scrubRequest,
  scrubObject,
  isSensitiveKey,
  utf8ByteLength,
  MAX_STRING_BYTES,
} = require('../website/app/lib/sentry-scrubber');

describe('sentry-scrubber — isSensitiveKey', () => {
  it('flags exact matches case-insensitively', () => {
    assert.strictEqual(isSensitiveKey('body'), true);
    assert.strictEqual(isSensitiveKey('BODY'), true);
    assert.strictEqual(isSensitiveKey('Authorization'), true);
    assert.strictEqual(isSensitiveKey('prompt'), true);
    assert.strictEqual(isSensitiveKey('fileContent'), true);
    assert.strictEqual(isSensitiveKey('file_content'), true);
    assert.strictEqual(isSensitiveKey('repoUrl'), true);
    assert.strictEqual(isSensitiveKey('repo_url'), true);
    assert.strictEqual(isSensitiveKey('apiKey'), true);
    assert.strictEqual(isSensitiveKey('api_key'), true);
    assert.strictEqual(isSensitiveKey('token'), true);
    assert.strictEqual(isSensitiveKey('secret'), true);
    assert.strictEqual(isSensitiveKey('password'), true);
    assert.strictEqual(isSensitiveKey('messages'), true);
    assert.strictEqual(isSensitiveKey('cookie'), true);
    assert.strictEqual(isSensitiveKey('set-cookie'), true);
    assert.strictEqual(isSensitiveKey('x-api-key'), true);
    assert.strictEqual(isSensitiveKey('anthropic-api-key'), true);
    assert.strictEqual(isSensitiveKey('stripe-signature'), true);
  });

  it('passes through unrelated keys', () => {
    assert.strictEqual(isSensitiveKey('name'), false);
    assert.strictEqual(isSensitiveKey('count'), false);
    assert.strictEqual(isSensitiveKey('module'), false);
    assert.strictEqual(isSensitiveKey('status'), false);
  });

  it('handles non-string input safely', () => {
    assert.strictEqual(isSensitiveKey(null), false);
    assert.strictEqual(isSensitiveKey(undefined), false);
    assert.strictEqual(isSensitiveKey(42), false);
    assert.strictEqual(isSensitiveKey({}), false);
  });
});

describe('sentry-scrubber — utf8ByteLength', () => {
  it('counts ASCII as 1 byte per char', () => {
    assert.strictEqual(utf8ByteLength('hello'), 5);
  });
  it('counts multi-byte UTF-8 correctly', () => {
    // "café" — é is 2 bytes in UTF-8
    assert.strictEqual(utf8ByteLength('café'), 5);
  });
  it('returns 0 for non-strings', () => {
    assert.strictEqual(utf8ByteLength(null), 0);
    assert.strictEqual(utf8ByteLength(undefined), 0);
    assert.strictEqual(utf8ByteLength(42), 0);
  });
});

describe('sentry-scrubber — scrubFrameVars', () => {
  it('removes the `body` local from a stack frame (the customer code path)', () => {
    const vars = {
      body: '<customer source code here>',
      file: 'src/something.ts',
      count: 7,
    };
    const out = scrubFrameVars(vars);
    assert.strictEqual(out.body, '[redacted: sensitive]');
    assert.strictEqual(out.file, 'src/something.ts');
    assert.strictEqual(out.count, 7);
  });

  it('removes prompt + messages + fileContent + repoUrl + apiKey from frame locals', () => {
    const vars = {
      prompt: 'Please write a fix for this bug',
      messages: [{ role: 'user', content: 'secret instructions' }],
      fileContent: 'export const x = 1;',
      repoUrl: 'https://github.com/cust/repo',
      apiKey: 'sk-ant-xxxxxxxx',
      ok: 'this passes through',
    };
    const out = scrubFrameVars(vars);
    assert.strictEqual(out.prompt, '[redacted: sensitive]');
    assert.strictEqual(out.messages, '[redacted: sensitive]');
    assert.strictEqual(out.fileContent, '[redacted: sensitive]');
    assert.strictEqual(out.repoUrl, '[redacted: sensitive]');
    assert.strictEqual(out.apiKey, '[redacted: sensitive]');
    assert.strictEqual(out.ok, 'this passes through');
  });

  it('truncates a 10 KB string local to the oversize marker', () => {
    const big = 'x'.repeat(10 * 1024);
    const out = scrubFrameVars({ blob: big });
    assert.match(out.blob, /^\[redacted: oversize \d+ KB\]$/);
  });

  it('passes through non-string non-sensitive values', () => {
    const out = scrubFrameVars({ ok: 'short', n: 42, b: true, arr: [1, 2, 3] });
    assert.strictEqual(out.ok, 'short');
    assert.strictEqual(out.n, 42);
    assert.strictEqual(out.b, true);
    assert.deepStrictEqual(out.arr, [1, 2, 3]);
  });

  it('handles null/undefined/non-object input', () => {
    assert.strictEqual(scrubFrameVars(null), null);
    assert.strictEqual(scrubFrameVars(undefined), undefined);
    assert.strictEqual(scrubFrameVars('not an object'), 'not an object');
  });
});

describe('sentry-scrubber — scrubObject', () => {
  it('strips sensitive keys recursively', () => {
    const obj = {
      user: { id: 1, password: 'plain-text' },
      meta: { token: 'abc123', okField: 'ok' },
    };
    const out = scrubObject(obj);
    assert.strictEqual(out.user.password, '[redacted: sensitive]');
    assert.strictEqual(out.meta.token, '[redacted: sensitive]');
    assert.strictEqual(out.user.id, 1);
    assert.strictEqual(out.meta.okField, 'ok');
  });

  it('caps recursion depth (no infinite loops)', () => {
    const a = { x: 1 };
    a.self = a;
    // Should not crash; depth limit returns marker.
    const out = scrubObject(a);
    assert.ok(out);
  });

  it('handles arrays of nested objects', () => {
    const out = scrubObject([{ token: 'a' }, { name: 'b' }]);
    assert.strictEqual(out[0].token, '[redacted: sensitive]');
    assert.strictEqual(out[1].name, 'b');
  });
});

describe('sentry-scrubber — scrubRequest', () => {
  it('removes body (data), cookies, and sensitive headers', () => {
    const req = {
      url: 'https://gatetest.ai/api/scan/fix',
      method: 'POST',
      data: 'huge customer code body',
      cookies: 'session=abc',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer secret-token',
        'x-api-key': 'pk_live_xxxx',
        'cookie': 'a=b',
      },
    };
    const out = scrubRequest(req);
    assert.strictEqual(out.data, '[redacted: sensitive]');
    assert.strictEqual(out.cookies, '[redacted: sensitive]');
    assert.strictEqual(out.headers['content-type'], 'application/json');
    assert.strictEqual(out.headers['authorization'], '[redacted: sensitive]');
    assert.strictEqual(out.headers['x-api-key'], '[redacted: sensitive]');
    assert.strictEqual(out.headers['cookie'], '[redacted: sensitive]');
    assert.strictEqual(out.url, 'https://gatetest.ai/api/scan/fix');
    assert.strictEqual(out.method, 'POST');
  });

  it('handles missing headers gracefully', () => {
    const out = scrubRequest({ url: '/foo', method: 'GET' });
    assert.strictEqual(out.url, '/foo');
    assert.strictEqual(out.method, 'GET');
  });

  it('passes through non-objects', () => {
    assert.strictEqual(scrubRequest(null), null);
    assert.strictEqual(scrubRequest(undefined), undefined);
  });
});

describe('sentry-scrubber — scrubEvent (the main contract)', () => {
  it('A fake event with body in locals has that key removed', () => {
    const event = {
      exception: {
        values: [
          {
            type: 'Error',
            stacktrace: {
              frames: [
                {
                  filename: 'app/api/scan/fix/route.ts',
                  vars: {
                    body: '<customer code>',
                    ok: 'pass-through',
                  },
                },
              ],
            },
          },
        ],
      },
    };
    const out = scrubEvent(event);
    assert.strictEqual(out.exception.values[0].stacktrace.frames[0].vars.body, '[redacted: sensitive]');
    assert.strictEqual(out.exception.values[0].stacktrace.frames[0].vars.ok, 'pass-through');
  });

  it('A fake event with prompt long string is scrubbed', () => {
    const event = {
      exception: {
        values: [
          {
            stacktrace: {
              frames: [
                {
                  vars: { prompt: 'long prompt body with sensitive instructions' },
                },
              ],
            },
          },
        ],
      },
    };
    const out = scrubEvent(event);
    assert.strictEqual(out.exception.values[0].stacktrace.frames[0].vars.prompt, '[redacted: sensitive]');
  });

  it('A fake event with a 10 KB non-sensitive string is truncated to the marker', () => {
    const big = 'a'.repeat(10 * 1024);
    const event = {
      exception: {
        values: [
          {
            stacktrace: {
              frames: [
                { vars: { someLargeBuffer: big } },
              ],
            },
          },
        ],
      },
    };
    const out = scrubEvent(event);
    assert.match(out.exception.values[0].stacktrace.frames[0].vars.someLargeBuffer, /^\[redacted: oversize \d+ KB\]$/);
  });

  it('An event with no sensitive locals passes through unchanged', () => {
    const event = {
      exception: {
        values: [
          {
            type: 'TypeError',
            value: 'x is not a function',
            stacktrace: {
              frames: [
                {
                  filename: 'app/foo.ts',
                  lineno: 12,
                  vars: { count: 7, name: 'bob' },
                },
              ],
            },
          },
        ],
      },
    };
    const out = scrubEvent(event);
    assert.strictEqual(out.exception.values[0].stacktrace.frames[0].vars.count, 7);
    assert.strictEqual(out.exception.values[0].stacktrace.frames[0].vars.name, 'bob');
    assert.strictEqual(out.exception.values[0].value, 'x is not a function');
  });

  it('scrubs request body + cookies + auth headers in event.request', () => {
    const event = {
      request: {
        url: '/api/scan/fix',
        method: 'POST',
        data: 'huge customer code body',
        cookies: 's=abc',
        headers: { authorization: 'Bearer xxx' },
      },
    };
    const out = scrubEvent(event);
    assert.strictEqual(out.request.data, '[redacted: sensitive]');
    assert.strictEqual(out.request.cookies, '[redacted: sensitive]');
    assert.strictEqual(out.request.headers.authorization, '[redacted: sensitive]');
  });

  it('scrubs event.extra and event.contexts', () => {
    const event = {
      extra: { prompt: 'sneaky leak', count: 3 },
      contexts: { app: { token: 'leak' } },
    };
    const out = scrubEvent(event);
    assert.strictEqual(out.extra.prompt, '[redacted: sensitive]');
    assert.strictEqual(out.extra.count, 3);
    assert.strictEqual(out.contexts.app.token, '[redacted: sensitive]');
  });

  it('caps oversize values in event.tags', () => {
    const big = 'y'.repeat(10 * 1024);
    const event = { tags: { region: 'us', huge: big } };
    const out = scrubEvent(event);
    assert.strictEqual(out.tags.region, 'us');
    assert.match(out.tags.huge, /^\[redacted: oversize \d+ KB\]$/);
  });

  it('scrubs breadcrumbs in event.breadcrumbs', () => {
    const event = {
      breadcrumbs: [
        { type: 'http', data: { body: 'leak', url: '/x' } },
      ],
    };
    const out = scrubEvent(event);
    assert.strictEqual(out.breadcrumbs[0].data.body, '[redacted: sensitive]');
    assert.strictEqual(out.breadcrumbs[0].data.url, '/x');
  });

  it('handles null and non-object events', () => {
    assert.strictEqual(scrubEvent(null), null);
    assert.strictEqual(scrubEvent(undefined), undefined);
    assert.strictEqual(scrubEvent('not an event'), 'not an event');
  });
});

describe('sentry-scrubber — scrubBreadcrumb', () => {
  it('strips sensitive keys from data', () => {
    const bc = { type: 'http', data: { url: '/x', body: 'leak', token: 'abc' } };
    const out = scrubBreadcrumb(bc);
    assert.strictEqual(out.data.body, '[redacted: sensitive]');
    assert.strictEqual(out.data.token, '[redacted: sensitive]');
    assert.strictEqual(out.data.url, '/x');
  });
  it('passes through breadcrumbs with no data', () => {
    const bc = { type: 'info', message: 'hello' };
    const out = scrubBreadcrumb(bc);
    assert.strictEqual(out.type, 'info');
    assert.strictEqual(out.message, 'hello');
  });
  it('handles null / non-object', () => {
    assert.strictEqual(scrubBreadcrumb(null), null);
    assert.strictEqual(scrubBreadcrumb(undefined), undefined);
  });
});

describe('sentry-scrubber — MAX_STRING_BYTES', () => {
  it('is 4 KB', () => {
    assert.strictEqual(MAX_STRING_BYTES, 4 * 1024);
  });
});
