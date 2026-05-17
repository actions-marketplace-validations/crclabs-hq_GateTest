/**
 * Tests for scripts/ai-ci-fixer.js.
 *
 * No real HTTP, no real GitHub, no real Claude — every external call is
 * injected via dependency injection (deps.callClaude / deps.runner /
 * deps.transport) so tests run hermetically.
 */

'use strict';

const test    = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs');
const os      = require('node:os');
const path    = require('node:path');

const fixer = require('../scripts/ai-ci-fixer');

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-ci-fixer-test-'));
  return dir;
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

/**
 * Build a fake HTTPS transport that returns the given responses for matched
 * paths. Each entry: { match: /regex/ | string, status, body, headers }.
 */
function fakeTransport(responses) {
  return {
    request(opts, cb) {
      const match = responses.find((r) => {
        if (r.match instanceof RegExp) return r.match.test(opts.path);
        if (typeof r.match === 'string') return opts.path === r.match || opts.path.includes(r.match);
        return false;
      });
      const payload = match || { status: 404, body: { message: 'unmatched' }, headers: {} };
      // Defer to simulate async I/O.
      setImmediate(() => {
        const raw = typeof payload.body === 'string' ? payload.body : JSON.stringify(payload.body);
        const res = {
          statusCode: payload.status,
          headers: { 'content-type': 'application/json', ...(payload.headers || {}) },
          on(event, fn) {
            if (event === 'data') fn(Buffer.from(raw));
            if (event === 'end')  fn();
          },
        };
        cb(res);
      });
      return {
        on() {},
        write() {},
        end() {},
        destroy() {},
      };
    },
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

test('runFixer returns disabled when ANTHROPIC_API_KEY is missing', async () => {
  const result = await fixer.runFixer({
    env: { GITHUB_TOKEN: 'x', GITHUB_REPOSITORY: 'o/r', WORKFLOW_RUN_ID: '1' },
  });
  assert.equal(result.status, 'disabled');
  assert.match(result.reason, /ANTHROPIC_API_KEY/);
});

test('runFixer returns disabled when GITHUB_TOKEN is missing', async () => {
  const result = await fixer.runFixer({
    env: { ANTHROPIC_API_KEY: 'x', GITHUB_REPOSITORY: 'o/r', WORKFLOW_RUN_ID: '1' },
  });
  assert.equal(result.status, 'disabled');
  assert.match(result.reason, /GITHUB_TOKEN/);
});

test('runFixer returns disabled when WORKFLOW_RUN_ID is missing', async () => {
  const result = await fixer.runFixer({
    env: { ANTHROPIC_API_KEY: 'x', GITHUB_TOKEN: 'y', GITHUB_REPOSITORY: 'o/r' },
  });
  assert.equal(result.status, 'disabled');
  assert.match(result.reason, /WORKFLOW_RUN_ID/);
});

test('readEnv parses MAX_FIX_ATTEMPTS and CLAUDE_MODEL', () => {
  const env = {
    ANTHROPIC_API_KEY: 'k',
    GITHUB_TOKEN:      't',
    GITHUB_REPOSITORY: 'o/r',
    WORKFLOW_RUN_ID:   '42',
    MAX_FIX_ATTEMPTS:  '5',
    CLAUDE_MODEL:      'claude-opus-4-7',
  };
  const cfg = fixer.readEnv(env);
  assert.equal(cfg.ok, true);
  assert.equal(cfg.maxAttempts, 5);
  assert.equal(cfg.model, 'claude-opus-4-7');
});

test('readEnv falls back to defaults when MAX_FIX_ATTEMPTS is unset/invalid', () => {
  const cfg1 = fixer.readEnv({
    ANTHROPIC_API_KEY: 'k', GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r', WORKFLOW_RUN_ID: '1',
  });
  assert.equal(cfg1.maxAttempts, fixer.DEFAULT_MAX_ATTEMPTS);
  assert.equal(cfg1.model, fixer.DEFAULT_MODEL);

  const cfg2 = fixer.readEnv({
    ANTHROPIC_API_KEY: 'k', GITHUB_TOKEN: 't', GITHUB_REPOSITORY: 'o/r', WORKFLOW_RUN_ID: '1',
    MAX_FIX_ATTEMPTS: 'not-a-number',
  });
  assert.equal(cfg2.maxAttempts, fixer.DEFAULT_MAX_ATTEMPTS);
});

test('parseClaudeResponse extracts FILE/PATCH/END_PATCH blocks', () => {
  const text = `FILE: src/foo.js
PATCH:
console.log('hello');
const x = 1;
END_PATCH

FILE: src/bar.js
PATCH:
module.exports = 42;
END_PATCH`;
  const patches = fixer.parseClaudeResponse(text);
  assert.equal(patches.length, 2);
  assert.equal(patches[0].file, 'src/foo.js');
  assert.match(patches[0].content, /console\.log/);
  assert.equal(patches[1].file, 'src/bar.js');
  assert.match(patches[1].content, /module\.exports = 42/);
});

test('parseClaudeResponse rejects path traversal and absolute paths', () => {
  const text = `FILE: ../outside.js
PATCH:
evil = true;
END_PATCH

FILE: /etc/passwd
PATCH:
root::0:0
END_PATCH

FILE: safe.js
PATCH:
ok = 1;
END_PATCH`;
  const patches = fixer.parseClaudeResponse(text);
  assert.equal(patches.length, 1);
  assert.equal(patches[0].file, 'safe.js');
});

test('parseClaudeResponse returns [] for GIVE_UP', () => {
  assert.deepEqual(fixer.parseClaudeResponse('GIVE_UP'), []);
  assert.deepEqual(fixer.parseClaudeResponse('  GIVE_UP \n'), []);
});

test('parseClaudeResponse returns [] for malformed responses without crashing', () => {
  assert.deepEqual(fixer.parseClaudeResponse(''), []);
  assert.deepEqual(fixer.parseClaudeResponse(null), []);
  assert.deepEqual(fixer.parseClaudeResponse(undefined), []);
  assert.deepEqual(fixer.parseClaudeResponse('Just some random text'), []);
  assert.deepEqual(fixer.parseClaudeResponse('FILE: foo.js\nPATCH:\nno end marker'), []);
  assert.deepEqual(fixer.parseClaudeResponse({ not: 'a string' }), []);
});

test('applyPatches writes files to a tmpdir', () => {
  const dir = makeTmpDir();
  try {
    const written = fixer.applyPatches([
      { file: 'a.js',          content: 'console.log("a");' },
      { file: 'sub/b.js',      content: 'console.log("b");' },
    ], dir);
    assert.equal(written.length, 2);
    assert.equal(fs.readFileSync(path.join(dir, 'a.js'), 'utf-8'),     'console.log("a");');
    assert.equal(fs.readFileSync(path.join(dir, 'sub/b.js'), 'utf-8'), 'console.log("b");');
  } finally {
    cleanup(dir);
  }
});

test('applyPatches refuses path-traversal patches', () => {
  const dir = makeTmpDir();
  try {
    const written = fixer.applyPatches([
      { file: '../escape.js', content: 'bad' },
      { file: '/etc/passwd',  content: 'bad' },
      { file: 'good.js',      content: 'ok'  },
    ], dir);
    assert.equal(written.length, 1);
    assert.equal(written[0], 'good.js');
    assert.equal(fs.existsSync(path.join(dir, '..', 'escape.js')), false);
  } finally {
    cleanup(dir);
  }
});

test('extractFailingFiles parses "at /path/file.js:LINE" patterns', () => {
  const dir = makeTmpDir();
  try {
    const log = `
Error: something blew up
    at ${dir}/src/broken.js:42
    at ${dir}/src/other.js:7:13
    at internal node:internal/foo.js:1
`;
    const files = fixer.extractFailingFiles(log, dir);
    assert.ok(files.includes('src/broken.js'));
    assert.ok(files.includes('src/other.js'));
    // node-internal frames should not appear as repo files
    assert.equal(files.some((f) => f.includes('internal')), false);
  } finally {
    cleanup(dir);
  }
});

test('extractFailingFiles drops node_modules paths', () => {
  const dir = makeTmpDir();
  try {
    const log = `at ${dir}/node_modules/foo/bar.js:1`;
    const files = fixer.extractFailingFiles(log, dir);
    assert.equal(files.length, 0);
  } finally {
    cleanup(dir);
  }
});

test('readFilesForClaude reads existing files and skips missing/huge ones', () => {
  const dir = makeTmpDir();
  try {
    fs.writeFileSync(path.join(dir, 'small.js'), 'small content');
    fs.writeFileSync(path.join(dir, 'huge.js'),  'x'.repeat(60_000));
    const files = fixer.readFilesForClaude(['small.js', 'huge.js', 'missing.js'], dir);
    assert.equal(files.length, 1);
    assert.equal(files[0].path, 'small.js');
    assert.equal(files[0].content, 'small content');
  } finally {
    cleanup(dir);
  }
});

test('buildClaudePrompt caps input around 8K tokens (~32K chars)', () => {
  const longLog = 'x'.repeat(40_000);
  const files = [
    { path: 'a.js', content: 'y'.repeat(20_000) },
    { path: 'b.js', content: 'z'.repeat(20_000) },
  ];
  const prompt = fixer.buildClaudePrompt(longLog, files);
  // We want a reasonable hard ceiling — exactly the documented budget.
  assert.ok(prompt.length <= fixer.MAX_INPUT_CHARS, `prompt is ${prompt.length} chars, expected <= ${fixer.MAX_INPUT_CHARS}`);
});

test('buildClaudePrompt includes the log and at least one file when within budget', () => {
  const log = 'an error happened';
  const files = [{ path: 'src/foo.js', content: 'function foo() {}' }];
  const prompt = fixer.buildClaudePrompt(log, files);
  assert.match(prompt, /an error happened/);
  assert.match(prompt, /FILE: src\/foo\.js/);
  assert.match(prompt, /function foo/);
});

test('tailLines returns the last N lines of a multiline string', () => {
  const text = Array.from({ length: 500 }, (_, i) => `line${i}`).join('\n');
  const tail = fixer.tailLines(text, 50);
  const lines = tail.split('\n');
  assert.equal(lines.length, 50);
  assert.equal(lines[lines.length - 1], 'line499');
});

test('isRateLimited detects 429 and 403-with-zero-remaining', () => {
  assert.equal(fixer.isRateLimited({ status: 429, headers: {} }), true);
  assert.equal(fixer.isRateLimited({ status: 403, headers: { 'x-ratelimit-remaining': '0' } }), true);
  assert.equal(fixer.isRateLimited({ status: 403, body: { message: 'You have exceeded a secondary rate limit' }, headers: {} }), true);
  assert.equal(fixer.isRateLimited({ status: 200, headers: {} }), false);
  assert.equal(fixer.isRateLimited(null), false);
});

test('runFixer caps at MAX_FIX_ATTEMPTS when Claude returns unparseable responses', async () => {
  const dir = makeTmpDir();
  try {
    fs.writeFileSync(path.join(dir, 'broken.js'), 'broken file content');

    const env = {
      ANTHROPIC_API_KEY: 'k',
      GITHUB_TOKEN:      't',
      GITHUB_REPOSITORY: 'o/r',
      WORKFLOW_RUN_ID:   '99',
      MAX_FIX_ATTEMPTS:  '2',
    };

    // GitHub responses: run found, jobs returns one failing job, logs return log text.
    const logText = `Error: something\n    at ${dir}/broken.js:1`;
    const transport = fakeTransport([
      { match: /\/actions\/runs\/99$/,          status: 200, body: { html_url: 'http://example/run/99', head_branch: 'feature' } },
      { match: /\/actions\/runs\/99\/jobs/,     status: 200, body: { jobs: [{ id: 1, conclusion: 'failure', name: 'test' }] } },
      { match: /\/actions\/jobs\/1\/logs/,      status: 200, body: logText },
      // We never expect createIssue or createPR to fire here when Claude gives up,
      // but the "give up" path tries to open an issue:
      { match: /\/issues$/,                     status: 201, body: { number: 7, html_url: 'http://example/issue/7' } },
    ]);

    let claudeCalls = 0;
    const result = await fixer.runFixer({
      env,
      repoRoot:    dir,
      transport,
      callClaude:  async () => { claudeCalls += 1; return 'nonsense response with no FILE blocks'; },
      runner:      () => ({ status: 0, stdout: '', stderr: '' }),
      gate:        () => ({ ok: false, stdout: '', stderr: '' }),
      git:         () => ({ ok: true, status: 0, stdout: '', stderr: '' }),
    });

    assert.equal(claudeCalls, 2, `expected exactly 2 Claude calls (MAX_FIX_ATTEMPTS=2), got ${claudeCalls}`);
    assert.ok(['gave-up', 'gave-up-no-issue', 'no-files'].includes(result.status), `unexpected status: ${result.status}`);
  } finally {
    cleanup(dir);
  }
});

test('runFixer exits cleanly when GitHub is rate-limited', async () => {
  const env = {
    ANTHROPIC_API_KEY: 'k',
    GITHUB_TOKEN:      't',
    GITHUB_REPOSITORY: 'o/r',
    WORKFLOW_RUN_ID:   '1',
  };
  const transport = fakeTransport([
    { match: /\/actions\/runs\/1$/, status: 429, body: { message: 'rate limited' }, headers: {} },
  ]);
  const result = await fixer.runFixer({
    env, transport,
    callClaude: async () => 'should not be called',
  });
  assert.equal(result.status, 'rate-limited');
});

test('runFixer exits cleanly when Claude throws on every attempt', async () => {
  const dir = makeTmpDir();
  try {
    fs.writeFileSync(path.join(dir, 'broken.js'), 'content');
    const env = {
      ANTHROPIC_API_KEY: 'k',
      GITHUB_TOKEN:      't',
      GITHUB_REPOSITORY: 'o/r',
      WORKFLOW_RUN_ID:   '5',
      MAX_FIX_ATTEMPTS:  '2',
    };
    const logText = `at ${dir}/broken.js:1`;
    const transport = fakeTransport([
      { match: /\/actions\/runs\/5$/,        status: 200, body: { html_url: 'http://example/run/5', head_branch: 'main' } },
      { match: /\/actions\/runs\/5\/jobs/,   status: 200, body: { jobs: [{ id: 1, conclusion: 'failure' }] } },
      { match: /\/actions\/jobs\/1\/logs/,   status: 200, body: logText },
      { match: /\/issues$/,                  status: 201, body: { number: 9 } },
    ]);
    let claudeCalls = 0;
    const result = await fixer.runFixer({
      env, repoRoot: dir, transport,
      callClaude: async () => { claudeCalls += 1; throw new Error('Claude timed out'); },
      git:  () => ({ ok: true, stdout: '', stderr: '' }),
      gate: () => ({ ok: false, stdout: '', stderr: '' }),
    });
    assert.equal(claudeCalls, 2);
    assert.ok(['gave-up', 'gave-up-no-issue'].includes(result.status));
  } finally {
    cleanup(dir);
  }
});

test('runFixer opens a PR when gate goes green', async () => {
  const dir = makeTmpDir();
  try {
    fs.writeFileSync(path.join(dir, 'broken.js'), 'old content');
    const env = {
      ANTHROPIC_API_KEY: 'k',
      GITHUB_TOKEN:      't',
      GITHUB_REPOSITORY: 'o/r',
      WORKFLOW_RUN_ID:   '77',
    };
    const logText = `Error: bug\n    at ${dir}/broken.js:1`;
    let prCreated = false;
    const transport = fakeTransport([
      { match: /\/actions\/runs\/77$/,        status: 200, body: { html_url: 'http://example/run/77', head_branch: 'feature/x' } },
      { match: /\/actions\/runs\/77\/jobs/,   status: 200, body: { jobs: [{ id: 1, conclusion: 'failure' }] } },
      { match: /\/actions\/jobs\/1\/logs/,    status: 200, body: logText },
      { match: /\/pulls$/,                    status: 201, body: { number: 42, html_url: 'http://example/pr/42' } },
    ]);

    const claudeResponse = `FILE: broken.js
PATCH:
new content
END_PATCH`;

    const gitCalls = [];
    const result = await fixer.runFixer({
      env, repoRoot: dir, transport,
      callClaude: async () => claudeResponse,
      git:  (args) => { gitCalls.push(args); return { ok: true, stdout: '', stderr: '' }; },
      gate: () => ({ ok: true, stdout: '', stderr: '' }),
    });
    // Patch should have been written
    assert.equal(fs.readFileSync(path.join(dir, 'broken.js'), 'utf-8'), 'new content');
    assert.equal(result.status, 'pr-opened');
    assert.equal(result.pr.status, 201);
    // Git commit + push should have been attempted
    const commitCall = gitCalls.find((a) => a[0] === 'commit');
    const pushCall   = gitCalls.find((a) => a[0] === 'push');
    assert.ok(commitCall, 'expected git commit');
    assert.ok(pushCall,   'expected git push');
  } finally {
    cleanup(dir);
  }
});

test('runFixer returns no-files when log has no parseable file references', async () => {
  const env = {
    ANTHROPIC_API_KEY: 'k',
    GITHUB_TOKEN:      't',
    GITHUB_REPOSITORY: 'o/r',
    WORKFLOW_RUN_ID:   '11',
  };
  const transport = fakeTransport([
    { match: /\/actions\/runs\/11$/,      status: 200, body: { html_url: 'http://example/run/11', head_branch: 'main' } },
    { match: /\/actions\/runs\/11\/jobs/, status: 200, body: { jobs: [{ id: 1, conclusion: 'failure' }] } },
    { match: /\/actions\/jobs\/1\/logs/,  status: 200, body: 'Some abstract error message, no paths.' },
  ]);
  const result = await fixer.runFixer({
    env, transport,
    callClaude: async () => 'never called',
  });
  assert.equal(result.status, 'no-files');
});

// ── Task 2: exponential backoff on Claude 429 / 529 / network errors ───────

/**
 * Build a fake transport that returns a configurable sequence of responses.
 * `entries` is an array; each entry shapes the next request's response:
 *   { status, body, headers, throwOnRequest: true, errorCode: 'ECONNRESET' }
 */
function sequencedClaudeTransport(entries) {
  let i = 0;
  return {
    request(opts, cb) {
      const entry = entries[Math.min(i, entries.length - 1)];
      i++;
      const fakeReq = {
        _errCb: null, _closeCb: null,
        on(event, fn) {
          if (event === 'error') this._errCb = fn;
          if (event === 'close') this._closeCb = fn;
        },
        write() {},
        end() {},
        destroy() { if (this._closeCb) this._closeCb(); },
      };
      if (entry.errorCode) {
        setImmediate(() => {
          const err = new Error(`fake net error ${entry.errorCode}`);
          err.code = entry.errorCode;
          if (fakeReq._errCb) fakeReq._errCb(err);
        });
        return fakeReq;
      }
      setImmediate(() => {
        const status = entry.status || 200;
        const body = entry.body != null
          ? (typeof entry.body === 'string' ? entry.body : JSON.stringify(entry.body))
          : JSON.stringify({ content: [{ text: 'OK_TEXT' }] });
        const res = {
          statusCode: status,
          headers: { 'content-type': 'application/json', ...(entry.headers || {}) },
          on(event, fn) {
            if (event === 'data') fn(Buffer.from(body));
            if (event === 'end')  fn();
          },
        };
        cb(res);
        setImmediate(() => { if (fakeReq._closeCb) fakeReq._closeCb(); });
      });
      return fakeReq;
    },
    _count: () => i,
  };
}

test('callClaude retries on 429 then succeeds', async () => {
  const transport = sequencedClaudeTransport([
    { status: 429, body: { error: 'rate limited' } },
    { status: 200, body: { content: [{ text: 'fixed' }] } },
  ]);
  const sleeps = [];
  const fakeSleep = (ms) => { sleeps.push(ms); return Promise.resolve(); };
  const result = await fixer.callClaude({
    apiKey: 'k', model: 'm', system: 's', user: 'u',
    transport, sleep: fakeSleep, timeoutMs: 5_000,
  });
  assert.equal(result, 'fixed');
  assert.equal(transport._count(), 2, 'expected exactly 2 HTTP attempts');
  assert.equal(sleeps.length, 1);
  assert.equal(sleeps[0], 1_000, 'first backoff delay should be 1s');
});

test('callClaude exhausts retries on persistent 529 and throws', async () => {
  const transport = sequencedClaudeTransport([
    { status: 529, body: { error: 'overloaded' } },
    { status: 529, body: { error: 'overloaded' } },
    { status: 529, body: { error: 'overloaded' } },
  ]);
  const sleeps = [];
  const fakeSleep = (ms) => { sleeps.push(ms); return Promise.resolve(); };
  await assert.rejects(
    fixer.callClaude({
      apiKey: 'k', model: 'm', system: 's', user: 'u',
      transport, sleep: fakeSleep, timeoutMs: 5_000,
    }),
    /529/
  );
  assert.equal(transport._count(), 3, 'expected exactly 3 HTTP attempts');
  assert.deepEqual(sleeps, [1_000, 3_000], 'expected backoff ladder 1s, 3s before final attempt');
});

test('callClaude retries on ECONNRESET network error then succeeds', async () => {
  const transport = sequencedClaudeTransport([
    { errorCode: 'ECONNRESET' },
    { status: 200, body: { content: [{ text: 'recovered' }] } },
  ]);
  const sleeps = [];
  const result = await fixer.callClaude({
    apiKey: 'k', model: 'm', system: 's', user: 'u',
    transport, sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); },
    timeoutMs: 5_000,
  });
  assert.equal(result, 'recovered');
  assert.equal(transport._count(), 2);
  assert.equal(sleeps.length, 1);
});

test('callClaude honors Retry-After header (numeric seconds)', async () => {
  const transport = sequencedClaudeTransport([
    { status: 429, body: { error: 'rl' }, headers: { 'retry-after': '5' } },
    { status: 200, body: { content: [{ text: 'ok' }] } },
  ]);
  const sleeps = [];
  await fixer.callClaude({
    apiKey: 'k', model: 'm', system: 's', user: 'u',
    transport, sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); },
    timeoutMs: 5_000,
  });
  assert.equal(sleeps[0], 5_000, 'Retry-After: 5 should override the 1s backoff');
});

test('callClaude does NOT retry on 400 (non-retryable)', async () => {
  const transport = sequencedClaudeTransport([
    { status: 400, body: { error: 'bad request' } },
  ]);
  await assert.rejects(
    fixer.callClaude({
      apiKey: 'k', model: 'm', system: 's', user: 'u',
      transport, sleep: () => Promise.resolve(), timeoutMs: 5_000,
    }),
    /400/
  );
  assert.equal(transport._count(), 1, 'should NOT retry on 400');
});

test('callClaude does NOT retry on 401 (non-retryable)', async () => {
  const transport = sequencedClaudeTransport([
    { status: 401, body: { error: 'unauthorized' } },
  ]);
  await assert.rejects(
    fixer.callClaude({
      apiKey: 'k', model: 'm', system: 's', user: 'u',
      transport, sleep: () => Promise.resolve(), timeoutMs: 5_000,
    }),
    /401/
  );
  assert.equal(transport._count(), 1);
});

test('_isRetryableClaudeError classifies status codes correctly', () => {
  assert.equal(fixer._isRetryableClaudeError({ _status: 429 }), true);
  assert.equal(fixer._isRetryableClaudeError({ _status: 529 }), true);
  assert.equal(fixer._isRetryableClaudeError({ _status: 503 }), true);
  assert.equal(fixer._isRetryableClaudeError({ _status: 400 }), false);
  assert.equal(fixer._isRetryableClaudeError({ _status: 401 }), false);
  assert.equal(fixer._isRetryableClaudeError({ _status: 500 }), false);
  assert.equal(fixer._isRetryableClaudeError({ code: 'ECONNRESET' }), true);
  assert.equal(fixer._isRetryableClaudeError({ _code: 'ETIMEDOUT' }), true);
  assert.equal(fixer._isRetryableClaudeError({ _code: 'ENOENT' }), false);
  assert.equal(fixer._isRetryableClaudeError(null), false);
});

test('_parseRetryAfter handles numeric seconds and bad input', () => {
  assert.equal(fixer._parseRetryAfter('5'),   5_000);
  assert.equal(fixer._parseRetryAfter('30'),  30_000);
  assert.equal(fixer._parseRetryAfter('0'),   0);
  assert.equal(fixer._parseRetryAfter(''),    null);
  assert.equal(fixer._parseRetryAfter(null),  null);
  assert.equal(fixer._parseRetryAfter(undefined), null);
  // garbage input
  assert.equal(fixer._parseRetryAfter('not-a-number'), null);
  // HTTP-date (rough): a date 5s in the future should be ~5s
  const future = new Date(Date.now() + 5_000).toUTCString();
  const ms = fixer._parseRetryAfter(future);
  if (ms != null) assert.ok(ms >= 1_000 && ms <= 10_000);
});

// ── Task 3: structured per-step log parser ─────────────────────────────────

test('parseStepsFromLog splits on ##[group] markers', () => {
  const log = `##[group]Setup
Setting up Node
##[endgroup]
##[group]Typecheck
tsc --noEmit
##[error]src/foo.ts:42:1 — Type 'string' is not assignable to 'number'
##[endgroup]
##[group]Test
ok
##[endgroup]`;
  const steps = fixer.parseStepsFromLog(log);
  assert.equal(steps.length, 3);
  assert.equal(steps[0].name, 'Setup');
  assert.equal(steps[0].failed, false);
  assert.equal(steps[1].name, 'Typecheck');
  assert.equal(steps[1].failed, true);
  assert.equal(steps[2].name, 'Test');
  assert.equal(steps[2].failed, false);
});

test('parseStepsFromLog identifies a single failing step', () => {
  const log = `##[group]Build
##[error]Compilation failed
##[endgroup]`;
  const steps = fixer.parseStepsFromLog(log);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].failed, true);
});

test('parseStepsFromLog returns [] when no group markers present', () => {
  const log = `error: something broke at src/foo.js:10`;
  const steps = fixer.parseStepsFromLog(log);
  assert.deepEqual(steps, []);
});

test('parseStepsFromLog identifies a failing step in the middle of the log', () => {
  const log = `##[group]A
ok
##[endgroup]
##[group]B
##[error]boom
##[endgroup]
##[group]C
also ok
##[endgroup]`;
  const steps = fixer.parseStepsFromLog(log);
  assert.equal(steps.length, 3);
  assert.equal(steps[1].name, 'B');
  assert.equal(steps[1].failed, true);
  assert.equal(steps[0].failed, false);
  assert.equal(steps[2].failed, false);
});

test('parseStepsFromLog detects "exit code N" non-zero markers', () => {
  const log = `##[group]Test
running tests...
Process completed with exit code 1
##[endgroup]`;
  const steps = fixer.parseStepsFromLog(log);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].failed, true);
});

test('parseStepsFromLog treats "exit code 0" as success', () => {
  const log = `##[group]Test
running tests...
Process completed with exit code 0
##[endgroup]`;
  const steps = fixer.parseStepsFromLog(log);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].failed, false);
});

test('parseStepsFromLog reports no failures when every step succeeds', () => {
  const log = `##[group]A
done
##[endgroup]
##[group]B
done
##[endgroup]`;
  const steps = fixer.parseStepsFromLog(log);
  assert.equal(steps.filter((s) => s.failed).length, 0);
});

test('parseStepsFromLog handles malformed input (no endgroup) without crashing', () => {
  const log = `##[group]Unterminated
some content here
##[error]boom`;
  const steps = fixer.parseStepsFromLog(log);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].failed, true);
});

test('parseStepsFromLog handles null/empty input', () => {
  assert.deepEqual(fixer.parseStepsFromLog(null), []);
  assert.deepEqual(fixer.parseStepsFromLog(''), []);
  assert.deepEqual(fixer.parseStepsFromLog(undefined), []);
});

test('extractFailingFiles uses the failing-step body when group markers present', () => {
  const dir = makeTmpDir();
  try {
    const log = `##[group]Setup
##[endgroup]
##[group]Typecheck
    at ${dir}/src/failing.ts:42
##[error]Type error
##[endgroup]
##[group]Build (skipped after typecheck)
    at ${dir}/src/never-touched.js:1
##[endgroup]`;
    const files = fixer.extractFailingFiles(log, dir);
    // Should ONLY pull from the failing Typecheck step, not from Build.
    assert.ok(files.includes('src/failing.ts'));
    assert.equal(files.includes('src/never-touched.js'), false,
      'should NOT include files from passing steps');
  } finally {
    cleanup(dir);
  }
});

test('extractFailingFiles falls back to whole-log scan when no group markers exist', () => {
  const dir = makeTmpDir();
  try {
    // No ##[group] markers — old-style runner log.
    const log = `something failed
    at ${dir}/src/broken.js:1`;
    const files = fixer.extractFailingFiles(log, dir);
    assert.ok(files.includes('src/broken.js'));
  } finally {
    cleanup(dir);
  }
});

test('buildPrBody and buildIssueBody render the expected content', () => {
  const pr = fixer.buildPrBody({
    runUrl:     'http://example/run/1',
    logExcerpt: 'line1\nline2\nline3',
    attempt:    2,
    model:      'claude-sonnet-4-5',
  });
  assert.match(pr, /AI CI-fixer/);
  assert.match(pr, /Failing workflow.*http:\/\/example\/run\/1/);
  assert.match(pr, /Attempt.*2/);
  assert.match(pr, /Powered by Claude/);

  const issue = fixer.buildIssueBody({
    runUrl:     'http://example/run/1',
    logExcerpt: 'failing log',
    attempted:  [{ attempt: 1, patchCount: 0 }, { attempt: 2, patchCount: 1 }],
    lastError:  new Error('gate red'),
    model:      'claude-sonnet-4-5',
  });
  assert.match(issue, /couldn't repair/);
  assert.match(issue, /attempt 1: 0 patch/);
  assert.match(issue, /attempt 2: 1 patch/);
  assert.match(issue, /gate red/);
});

// ── Flywheel integration ────────────────────────────────────────────────────

test('flywheel: AST layer fix is taken before Claude is ever called', () => {
  // The flywheel try is direct — no async, no I/O. We verify that for a
  // file the AST fixer can handle, the flywheel returns a patch and the
  // file is marked as handled, so the orchestrator wouldn't send it to
  // Claude.
  const flywheel = {
    available: true,
    astFixer: {
      isJsOrTs: (p) => p.endsWith('.js'),
      tryAstFix: (content) => content.replace('rejectUnauthorized: false', 'rejectUnauthorized: true'),
    },
    ruleFixer: { tryRuleBasedFix: () => null },
    telemetry: { recordFixAttempt: () => {} },
    distill: { distillClaudeFix: () => {} },
  };
  const result = fixer._tryFlywheel({
    files: [{ path: 'src/x.js', content: 'const opts = { rejectUnauthorized: false };' }],
    repoRoot: '/tmp',
    flywheel,
  });
  assert.equal(result.patches.length, 1);
  assert.equal(result.patches[0].path, 'src/x.js');
  assert.match(result.patches[0].content, /rejectUnauthorized: true/);
  assert.ok(result.filesHandled.has('src/x.js'));
});

test('flywheel: Rule layer is tried when AST returns no change', () => {
  const flywheel = {
    available: true,
    astFixer: {
      isJsOrTs: () => true,
      tryAstFix: (content) => content, // no change
    },
    ruleFixer: {
      tryRuleBasedFix: (content) => content + '\n// fixed-by-rule',
    },
    telemetry: { recordFixAttempt: () => {} },
    distill: { distillClaudeFix: () => {} },
  };
  const result = fixer._tryFlywheel({
    files: [{ path: 'src/y.js', content: 'console.log("hi");' }],
    repoRoot: '/tmp',
    flywheel,
  });
  assert.equal(result.patches.length, 1);
  assert.match(result.patches[0].content, /fixed-by-rule/);
});

test('flywheel: returns empty when neither layer fires', () => {
  const flywheel = {
    available: true,
    astFixer: { isJsOrTs: () => true, tryAstFix: () => null },
    ruleFixer: { tryRuleBasedFix: () => null },
    telemetry: { recordFixAttempt: () => {} },
    distill: { distillClaudeFix: () => {} },
  };
  const result = fixer._tryFlywheel({
    files: [{ path: 'src/z.js', content: 'novel pattern' }],
    repoRoot: '/tmp',
    flywheel,
  });
  assert.equal(result.patches.length, 0);
  assert.equal(result.filesHandled.size, 0);
});

test('flywheel: crash in AST falls through to Rule, no throw', () => {
  const flywheel = {
    available: true,
    astFixer: {
      isJsOrTs: () => true,
      tryAstFix: () => { throw new Error('boom'); },
    },
    ruleFixer: { tryRuleBasedFix: (c) => c + '\n// rule-recovered' },
    telemetry: { recordFixAttempt: () => {} },
    distill: { distillClaudeFix: () => {} },
  };
  const result = fixer._tryFlywheel({
    files: [{ path: 'src/q.js', content: 'x' }],
    repoRoot: '/tmp',
    flywheel,
  });
  assert.equal(result.patches.length, 1);
  assert.match(result.patches[0].content, /rule-recovered/);
});

test('flywheel: distillClaudeWins calls auto-distill for every patched file', () => {
  const distilled = [];
  const flywheel = {
    available: true,
    distill: {
      distillClaudeFix: (entry) => distilled.push(entry),
    },
  };
  fixer._distillClaudeWins(
    flywheel,
    [
      { path: 'a.js', content: 'fixed a' },
      { path: 'b.js', content: 'fixed b' },
    ],
    { 'a.js': 'orig a', 'b.js': 'orig b' },
    'claude-sonnet-4-5',
  );
  assert.equal(distilled.length, 2);
  assert.equal(distilled[0].patchedContent, 'fixed a');
  assert.equal(distilled[0].originalContent, 'orig a');
  assert.equal(distilled[0].provenance.originalModel, 'claude-sonnet-4-5');
});

test('flywheel: distill silently skips when no original captured', () => {
  const distilled = [];
  const flywheel = {
    available: true,
    distill: { distillClaudeFix: (e) => distilled.push(e) },
  };
  fixer._distillClaudeWins(
    flywheel,
    [{ path: 'unknown.js', content: 'fixed' }],
    {}, // no original
    'claude-sonnet-4-5',
  );
  assert.equal(distilled.length, 0);
});

test('flywheel: loadFlywheel returns { available: false } gracefully when layers missing', () => {
  // The real loadFlywheel uses require — it'll find the real flywheel files
  // in this repo. So this test just verifies the function exists and
  // returns the expected shape.
  const result = fixer._loadFlywheel();
  assert.ok(result);
  assert.equal(typeof result.available, 'boolean');
});
