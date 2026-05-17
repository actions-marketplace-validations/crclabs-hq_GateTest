const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  distillClaudeFix,
  findMatchingRecipe,
  applyRecipe,
  incrementApplicationCount,
  isTemplatey,
  diffChangedLines,
  countVaryingIdentifiers,
  loadStore,
} = require('../website/app/lib/auto-distill');

function tmpStore() {
  return path.join(
    os.tmpdir(),
    `gatetest-recipes-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
  );
}

const REJECT_FIXTURE = {
  before: `const opts = {
  rejectUnauthorized: false,
  host: 'api.example.com'
};`,
  after: `const opts = {
  rejectUnauthorized: true,
  host: 'api.example.com'
};`,
};

describe('auto-distill — isTemplatey heuristic', () => {
  it('flags a small literal diff as templatey', () => {
    const v = isTemplatey(REJECT_FIXTURE.before, REJECT_FIXTURE.after);
    assert.strictEqual(v.templatey, true);
    assert.ok(v.beforeSnippet.includes('rejectUnauthorized'));
    assert.ok(v.afterSnippet.includes('rejectUnauthorized'));
  });

  it('rejects a large diff (function body rewrite) as non-templatey', () => {
    const before = `function loadUser(id) {
  const x = 1;
  const y = 2;
  return { id, x, y };
}`;
    const after = `function loadUser(id) {
  const cache = getCache();
  if (cache.has(id)) return cache.get(id);
  const user = db.users.findOne({ id });
  cache.set(id, user);
  return user;
}`;
    const v = isTemplatey(before, after);
    assert.strictEqual(v.templatey, false);
  });

  it('rejects a diff with many varying identifiers', () => {
    const before = `const a = foo(b, c);`;
    const after  = `const x = bar(y, z);`;
    const v = isTemplatey(before, after);
    assert.strictEqual(v.templatey, false);
  });

  it('rejects identical content', () => {
    const v = isTemplatey('same', 'same');
    assert.strictEqual(v.templatey, false);
  });

  it('diffChangedLines returns null on identical inputs', () => {
    assert.strictEqual(diffChangedLines('a', 'a'), null);
  });

  it('countVaryingIdentifiers ignores common keywords', () => {
    // Both sides reference `true`/`false`/`const` — these don't count as varying.
    const before = ['const x = false;'];
    const after = ['const x = true;'];
    assert.strictEqual(countVaryingIdentifiers(before, after), 0);
  });
});

describe('auto-distill — distillClaudeFix', () => {
  let store;
  beforeEach(() => { store = tmpStore(); });

  it('writes a recipe for a templatey diff', () => {
    const out = distillClaudeFix({
      issue: { ruleKey: 'js-reject-unauthorized', module: 'tlsSecurity', file: 'src/foo.js' },
      originalContent: REJECT_FIXTURE.before,
      patchedContent: REJECT_FIXTURE.after,
      recipeStorePath: store,
    });
    assert.strictEqual(out.written, true);
    assert.ok(out.recipe);
    assert.strictEqual(out.recipe.ruleKey, 'js-reject-unauthorized');
    assert.strictEqual(out.recipe.module, 'tlsSecurity');
    assert.strictEqual(out.recipe.fileExt, '.js');

    const persisted = loadStore(store);
    assert.strictEqual(persisted.recipes.length, 1);
    assert.strictEqual(persisted.recipes[0].id, out.recipe.id);
  });

  it('does NOT write a recipe for a large / non-templatey diff', () => {
    const out = distillClaudeFix({
      issue: { ruleKey: 'whole-rewrite', module: 'codeQuality', file: 'src/big.js' },
      originalContent: 'function a() {\n  return 1;\n}\n',
      patchedContent: 'function a() {\n  const x = compute();\n  const y = process(x);\n  const z = persist(y);\n  return finalize(z);\n}\n',
      recipeStorePath: store,
    });
    assert.strictEqual(out.written, false);
    const persisted = loadStore(store);
    assert.strictEqual(persisted.recipes.length, 0);
  });

  it('marks a new recipe with confidence: "low"', () => {
    const out = distillClaudeFix({
      issue: { ruleKey: 'js-reject-unauthorized', module: 'tlsSecurity', file: 'src/foo.js' },
      originalContent: REJECT_FIXTURE.before,
      patchedContent: REJECT_FIXTURE.after,
      recipeStorePath: store,
    });
    assert.strictEqual(out.written, true);
    assert.strictEqual(out.recipe.confidence, 'low');
    assert.strictEqual(out.recipe.applicationCount, 0);
  });

  it('populates provenance fields', () => {
    const out = distillClaudeFix({
      issue: { ruleKey: 'js-httponly-false', module: 'cookieSecurity', file: 'src/foo.ts' },
      originalContent: 'const o = { httpOnly: false };',
      patchedContent:  'const o = { httpOnly: true };',
      recipeStorePath: store,
      originalModel: 'claude-sonnet-4-6',
    });
    assert.strictEqual(out.written, true);
    assert.ok(out.recipe.provenance);
    assert.strictEqual(out.recipe.provenance.originalModel, 'claude-sonnet-4-6');
    assert.strictEqual(out.recipe.provenance.originalRuleKey, 'js-httponly-false');
    assert.ok(out.recipe.provenance.createdAt);
    assert.strictEqual(out.recipe.provenance.lastAppliedAt, null);
  });

  it('does not duplicate an existing recipe', () => {
    distillClaudeFix({
      issue: { ruleKey: 'js-reject-unauthorized', module: 'tlsSecurity', file: 'src/foo.js' },
      originalContent: REJECT_FIXTURE.before,
      patchedContent: REJECT_FIXTURE.after,
      recipeStorePath: store,
    });
    const out2 = distillClaudeFix({
      issue: { ruleKey: 'js-reject-unauthorized', module: 'tlsSecurity', file: 'src/foo.js' },
      originalContent: REJECT_FIXTURE.before,
      patchedContent: REJECT_FIXTURE.after,
      recipeStorePath: store,
    });
    assert.strictEqual(out2.written, false);
    assert.strictEqual(out2.reason, 'duplicate');
    assert.strictEqual(loadStore(store).recipes.length, 1);
  });

  it('never throws on bad input', () => {
    assert.doesNotThrow(() => distillClaudeFix({ recipeStorePath: store }));
    assert.doesNotThrow(() => distillClaudeFix({ issue: null, recipeStorePath: store }));
    assert.doesNotThrow(() => distillClaudeFix({
      issue: { ruleKey: 'x', module: 'y', file: 'z.js' },
      originalContent: null,
      patchedContent: 'whatever',
      recipeStorePath: store,
    }));
  });
});

describe('auto-distill — promotion', () => {
  let store;
  beforeEach(() => { store = tmpStore(); });

  it('promotes to "stable" after 3 successful applications', () => {
    const written = distillClaudeFix({
      issue: { ruleKey: 'js-reject-unauthorized', module: 'tlsSecurity', file: 'src/foo.js' },
      originalContent: REJECT_FIXTURE.before,
      patchedContent: REJECT_FIXTURE.after,
      recipeStorePath: store,
    });
    const id = written.recipe.id;

    let r = incrementApplicationCount(id, store);
    assert.strictEqual(r.applicationCount, 1);
    assert.strictEqual(r.confidence, 'low');

    r = incrementApplicationCount(id, store);
    assert.strictEqual(r.applicationCount, 2);
    assert.strictEqual(r.confidence, 'low');

    r = incrementApplicationCount(id, store);
    assert.strictEqual(r.applicationCount, 3);
    assert.strictEqual(r.confidence, 'stable');
  });

  it('updates lastAppliedAt on application', () => {
    const written = distillClaudeFix({
      issue: { ruleKey: 'k', module: 'm', file: 'f.js' },
      originalContent: 'a = false;',
      patchedContent:  'a = true;',
      recipeStorePath: store,
    });
    assert.strictEqual(written.recipe.provenance.lastAppliedAt, null);
    const after = incrementApplicationCount(written.recipe.id, store);
    assert.ok(after.provenance.lastAppliedAt);
  });
});

describe('auto-distill — findMatchingRecipe + applyRecipe', () => {
  let store;
  beforeEach(() => { store = tmpStore(); });

  it('finds a matching recipe by ruleKey + module + fileExt + content', async () => {
    // Ensure no remote env interferes with the local-only test.
    const savedUrl = process.env.GATETEST_RECIPE_STORE_URL;
    delete process.env.GATETEST_RECIPE_STORE_URL;
    try {
      distillClaudeFix({
        issue: { ruleKey: 'js-reject-unauthorized', module: 'tlsSecurity', file: 'src/a.js' },
        originalContent: REJECT_FIXTURE.before,
        patchedContent: REJECT_FIXTURE.after,
        recipeStorePath: store,
      });
      const found = await findMatchingRecipe({
        ruleKey: 'js-reject-unauthorized',
        module: 'tlsSecurity',
        fileExt: '.js',
        content: 'preamble\n' + REJECT_FIXTURE.before + '\ntrailing',
        recipeStorePath: store,
      });
      assert.ok(found);
      const patched = applyRecipe('preamble\n' + REJECT_FIXTURE.before + '\ntrailing', found);
      assert.ok(patched.includes('rejectUnauthorized: true'));
      assert.ok(patched.includes('preamble'));
      assert.ok(patched.includes('trailing'));
    } finally {
      if (savedUrl !== undefined) process.env.GATETEST_RECIPE_STORE_URL = savedUrl;
    }
  });

  it('returns null when nothing matches', async () => {
    const savedUrl = process.env.GATETEST_RECIPE_STORE_URL;
    delete process.env.GATETEST_RECIPE_STORE_URL;
    try {
      const found = await findMatchingRecipe({
        ruleKey: 'nope', module: 'nope', fileExt: '.js', content: 'x', recipeStorePath: store,
      });
      assert.strictEqual(found, null);
    } finally {
      if (savedUrl !== undefined) process.env.GATETEST_RECIPE_STORE_URL = savedUrl;
    }
  });

  it('honours includeLowConfidence=false', async () => {
    const savedUrl = process.env.GATETEST_RECIPE_STORE_URL;
    delete process.env.GATETEST_RECIPE_STORE_URL;
    try {
      const w = distillClaudeFix({
        issue: { ruleKey: 'r', module: 'm', file: 'f.js' },
        originalContent: 'a = false;',
        patchedContent:  'a = true;',
        recipeStorePath: store,
      });
      assert.strictEqual(w.recipe.confidence, 'low');
      const noLow = await findMatchingRecipe({
        ruleKey: 'r', module: 'm', fileExt: '.js', content: 'a = false;',
        recipeStorePath: store, includeLowConfidence: false,
      });
      assert.strictEqual(noLow, null);
      const withLow = await findMatchingRecipe({
        ruleKey: 'r', module: 'm', fileExt: '.js', content: 'a = false;',
        recipeStorePath: store, includeLowConfidence: true,
      });
      assert.ok(withLow);
    } finally {
      if (savedUrl !== undefined) process.env.GATETEST_RECIPE_STORE_URL = savedUrl;
    }
  });
});

describe('auto-distill — remote-store integration', () => {
  const { clearRemoteCache } = require('../website/app/lib/auto-distill');
  let store;
  beforeEach(() => {
    store = tmpStore();
    clearRemoteCache();
  });

  it('findMatchingRecipe consults remote first, falls back to local', async () => {
    // No matching recipe locally.
    const calls = [];
    const fakeTransport = makeFakeTransport(calls, [
      {
        match: (urlPath) => urlPath === '/recipes',
        status: 200,
        body: { recipes: [{
          id: 'remote-1',
          ruleKey: 'js-reject-unauthorized',
          module: 'tlsSecurity',
          fileExt: '.js',
          before: 'rejectUnauthorized: false',
          after:  'rejectUnauthorized: true',
          confidence: 'stable',
          applicationCount: 5,
          provenance: { originalModel: null, originalRuleKey: 'js-reject-unauthorized', createdAt: '2026-01-01', lastAppliedAt: null },
        }] },
      },
    ]);

    const found = await findMatchingRecipe({
      ruleKey: 'js-reject-unauthorized',
      module: 'tlsSecurity',
      fileExt: '.js',
      content: 'const opts = { rejectUnauthorized: false };',
      recipeStorePath: store,
      remoteStoreUrl: 'https://example.test/recipes',
      transport: fakeTransport,
    });
    assert.ok(found, 'expected remote recipe to be found');
    assert.strictEqual(found.id, 'remote-1');
    assert.strictEqual(calls.length, 1, 'remote should have been called exactly once');
  });

  it('falls back to local store when remote returns nothing', async () => {
    distillClaudeFix({
      issue: { ruleKey: 'local-only', module: 'tlsSecurity', file: 'src/a.js' },
      originalContent: REJECT_FIXTURE.before,
      patchedContent: REJECT_FIXTURE.after,
      recipeStorePath: store,
    });
    const fakeTransport = makeFakeTransport([], [
      { match: () => true, status: 200, body: { recipes: [] } },
    ]);
    const found = await findMatchingRecipe({
      ruleKey: 'local-only',
      module: 'tlsSecurity',
      fileExt: '.js',
      content: REJECT_FIXTURE.before,
      recipeStorePath: store,
      remoteStoreUrl: 'https://example.test/recipes',
      transport: fakeTransport,
    });
    assert.ok(found, 'should have fallen back to the local store');
    assert.strictEqual(found.ruleKey, 'local-only');
  });

  it('caches remote results across calls in the same process', async () => {
    const calls = [];
    const fakeTransport = makeFakeTransport(calls, [
      { match: () => true, status: 200, body: { recipes: [] } },
    ]);
    await findMatchingRecipe({
      ruleKey: 'k', module: 'm', fileExt: '.js', content: 'x',
      recipeStorePath: store,
      remoteStoreUrl: 'https://example.test/recipes',
      transport: fakeTransport,
    });
    await findMatchingRecipe({
      ruleKey: 'k', module: 'm', fileExt: '.js', content: 'x',
      recipeStorePath: store,
      remoteStoreUrl: 'https://example.test/recipes',
      transport: fakeTransport,
    });
    assert.strictEqual(calls.length, 1, `expected exactly 1 remote call across 2 lookups, got ${calls.length}`);
  });

  it('distillClaudeFix writes to remote (best-effort) when configured', async () => {
    const calls = [];
    const fakeTransport = makeFakeTransport(calls, [
      { match: () => true, status: 200, body: { ok: true } },
    ]);
    const out = distillClaudeFix({
      issue: { ruleKey: 'js-reject-unauthorized', module: 'tlsSecurity', file: 'src/foo.js' },
      originalContent: REJECT_FIXTURE.before,
      patchedContent: REJECT_FIXTURE.after,
      recipeStorePath: store,
      remoteStoreUrl: 'https://example.test/recipes',
      transport: fakeTransport,
    });
    assert.strictEqual(out.written, true, 'local write should have succeeded');
    // Remote write is fire-and-forget — yield a tick to let it run.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(calls.length, 1, `expected exactly 1 remote write, got ${calls.length}`);
    assert.strictEqual(calls[0].method, 'PUT');
  });

  it('remote failure does not break local-store reads', async () => {
    distillClaudeFix({
      issue: { ruleKey: 'r', module: 'm', file: 'f.js' },
      originalContent: 'a = false;',
      patchedContent:  'a = true;',
      recipeStorePath: store,
    });
    // Transport that throws — simulate complete network failure.
    const throwTransport = {
      request: () => { throw new Error('connection refused'); },
    };
    const found = await findMatchingRecipe({
      ruleKey: 'r', module: 'm', fileExt: '.js', content: 'a = false;',
      recipeStorePath: store,
      remoteStoreUrl: 'https://example.test/recipes',
      transport: throwTransport,
    });
    assert.ok(found, 'local fallback should still succeed when remote throws');
  });
});

// Local helper for the remote-integration tests — re-uses the same shape as
// tests/recipe-store-remote.test.js's fakeTransport but lives here for the
// auto-distill suite to stay self-contained.
function makeFakeTransport(calls, responses) {
  return {
    request(opts, cb) {
      calls.push({ method: opts.method, path: opts.path });
      const match = responses.find((r) => {
        if (typeof r.match === 'function') return r.match(opts.path);
        if (r.match instanceof RegExp)     return r.match.test(opts.path);
        if (typeof r.match === 'string')   return opts.path === r.match || opts.path.includes(r.match);
        return false;
      });
      const payload = match || { status: 404, body: { message: 'unmatched' } };
      const closeListeners = [];
      setImmediate(() => {
        const raw = typeof payload.body === 'string' ? payload.body : JSON.stringify(payload.body);
        const res = {
          statusCode: payload.status,
          headers: { 'content-type': 'application/json' },
          on(event, fn) {
            if (event === 'data') fn(Buffer.from(raw));
            if (event === 'end')  fn();
          },
        };
        cb(res);
        // Fire close listeners so the consumer can clear its timeout timer.
        setImmediate(() => {
          for (const fn of closeListeners) {
            try { fn(); } catch { /* ignore */ }
          }
        });
      });
      return {
        on(event, fn) { if (event === 'close') closeListeners.push(fn); },
        write() {},
        end() {},
        destroy() {},
      };
    },
  };
}
