'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  executeRefactorPlan,
  renderRefactorPrBody,
  buildModifyPrompt,
  buildCreatePrompt,
  buildTestPrompt,
  runSyntaxGate,
  MAX_FILES_PER_PLAN,
  MAX_NEW_FILES,
} = require('../website/app/lib/refactor-executor');

// ─── runSyntaxGate ────────────────────────────────────────────────────────────

describe('runSyntaxGate', () => {
  it('passes for JS without syntax errors', () => {
    const result = runSyntaxGate('app.js', 'const x = 1;\nmodule.exports = { x };');
    assert.equal(result.passed, true);
  });

  it('passes for unknown file types (no checker)', () => {
    const result = runSyntaxGate('schema.graphql', '{ query }');
    assert.equal(result.passed, true);
  });

  it('fails for invalid JSON', () => {
    const result = runSyntaxGate('config.json', '{ "key": "value" ');
    assert.equal(result.passed, false);
    assert.ok(result.error);
  });

  it('passes for valid JSON', () => {
    const result = runSyntaxGate('config.json', '{"key": "value"}');
    assert.equal(result.passed, true);
  });
});

// ─── buildModifyPrompt ────────────────────────────────────────────────────────

describe('buildModifyPrompt', () => {
  const planFile = { path: 'src/poller.js', description: 'Remove setInterval polling loop' };
  const originalContent = 'setInterval(async () => { await fetch("/api/x"); }, 1000);';
  const plan = { type: 'polling-to-webhook', rationale: 'Replace polling with webhook.' };

  it('includes the refactor type', () => {
    const prompt = buildModifyPrompt(planFile, originalContent, plan);
    assert.ok(prompt.includes('polling-to-webhook'));
  });

  it('includes the file path', () => {
    const prompt = buildModifyPrompt(planFile, originalContent, plan);
    assert.ok(prompt.includes('src/poller.js'));
  });

  it('includes the change description', () => {
    const prompt = buildModifyPrompt(planFile, originalContent, plan);
    assert.ok(prompt.includes('Remove setInterval'));
  });

  it('includes the current content', () => {
    const prompt = buildModifyPrompt(planFile, originalContent, plan);
    assert.ok(prompt.includes('setInterval'));
  });

  it('caps preview at 200 lines', () => {
    const longContent = Array.from({ length: 300 }, (_, i) => `const x${i} = ${i};`).join('\n');
    const prompt = buildModifyPrompt(planFile, longContent, plan);
    // Should not include line 201+
    assert.ok(!prompt.includes('const x200 = 200;'));
  });
});

// ─── buildCreatePrompt ────────────────────────────────────────────────────────

describe('buildCreatePrompt', () => {
  const planFile = { path: 'src/webhook-handler.js', description: 'Webhook receiver handler' };
  const plan = { type: 'polling-to-webhook', rationale: 'Replace polling.' };

  it('includes the new file path', () => {
    const prompt = buildCreatePrompt(planFile, plan, []);
    assert.ok(prompt.includes('src/webhook-handler.js'));
  });

  it('includes the purpose', () => {
    const prompt = buildCreatePrompt(planFile, plan, []);
    assert.ok(prompt.includes('Webhook receiver handler'));
  });

  it('includes already-applied files as context', () => {
    const applied = [{ path: 'src/poller.js', before: 'old', after: 'const x = 1;' }];
    const prompt = buildCreatePrompt(planFile, plan, applied);
    assert.ok(prompt.includes('src/poller.js'));
  });

  it('caps context to 3 applied files', () => {
    const applied = Array.from({ length: 5 }, (_, i) => ({
      path: `src/file${i}.js`,
      before: '',
      after: `const x${i} = ${i};`,
    }));
    const prompt = buildCreatePrompt(planFile, plan, applied);
    // Should cap at 3
    assert.ok(!prompt.includes('src/file3.js'));
  });
});

// ─── buildTestPrompt ──────────────────────────────────────────────────────────

describe('buildTestPrompt', () => {
  const planFile = { path: 'tests/handler.test.js', description: 'Test webhook handler' };
  const plan = { type: 'polling-to-webhook', rationale: 'Replace polling.' };

  it('mentions node:test framework', () => {
    const prompt = buildTestPrompt(planFile, plan, []);
    assert.ok(prompt.includes('node:test'));
  });

  it('includes the test file path', () => {
    const prompt = buildTestPrompt(planFile, plan, []);
    assert.ok(prompt.includes('tests/handler.test.js'));
  });
});

// ─── executeRefactorPlan ──────────────────────────────────────────────────────

describe('executeRefactorPlan', () => {
  const plan = {
    type: 'polling-to-webhook',
    rationale: 'Replace setInterval polling with webhook receiver.',
    filesToModify: [
      { path: 'src/poller.js', description: 'Remove setInterval loop' },
    ],
    newFilesToCreate: [
      { path: 'src/webhook-handler.js', description: 'Webhook receiver' },
    ],
    testFilesToCreate: [
      { path: 'tests/handler.test.js', description: 'Test webhook handler' },
    ],
    warnings: [],
  };

  const sourceFiles = [
    { filePath: 'src/poller.js', content: 'setInterval(async () => { await fetch("/api/x"); }, 1000);' },
  ];

  const happyAsk = async (prompt) => {
    if (prompt.includes('CHANGE REQUIRED')) return "const setupWebhook = () => console.log('webhook');";
    if (prompt.includes('PURPOSE')) return "module.exports = function handler(req) { return req; };";
    if (prompt.includes('WHAT TO TEST')) return "const { describe, it } = require('node:test');\ndescribe('x', () => { it('works', () => {}); });";
    return 'const x = 1;';
  };

  it('returns applied, created, failed, rolledBack arrays', async () => {
    const result = await executeRefactorPlan({ plan, sourceFiles, askClaude: happyAsk });
    assert.ok(Array.isArray(result.applied));
    assert.ok(Array.isArray(result.created));
    assert.ok(Array.isArray(result.failed));
    assert.ok(Array.isArray(result.rolledBack));
  });

  it('applies a file modification successfully', async () => {
    const result = await executeRefactorPlan({ plan, sourceFiles, askClaude: happyAsk });
    assert.equal(result.applied.length, 1);
    assert.equal(result.applied[0].path, 'src/poller.js');
    assert.ok(result.applied[0].before);
    assert.ok(result.applied[0].after);
  });

  it('creates new files', async () => {
    const result = await executeRefactorPlan({ plan, sourceFiles, askClaude: happyAsk });
    const paths = result.created.map((f) => f.path);
    assert.ok(paths.some((p) => p === 'src/webhook-handler.js'));
  });

  it('creates test stubs', async () => {
    const result = await executeRefactorPlan({ plan, sourceFiles, askClaude: happyAsk });
    const paths = result.created.map((f) => f.path);
    assert.ok(paths.some((p) => p.includes('test')));
  });

  it('includes summary string', async () => {
    const result = await executeRefactorPlan({ plan, sourceFiles, askClaude: happyAsk });
    assert.ok(typeof result.summary === 'string');
    assert.ok(result.summary.includes('polling-to-webhook'));
  });

  it('includes prBody markdown', async () => {
    const result = await executeRefactorPlan({ plan, sourceFiles, askClaude: happyAsk });
    assert.ok(typeof result.prBody === 'string');
    assert.ok(result.prBody.includes('#'));
  });

  it('fails gracefully when Claude returns empty string', async () => {
    const silentAsk = async () => '';
    const result = await executeRefactorPlan({ plan, sourceFiles, askClaude: silentAsk });
    assert.equal(result.applied.length, 0);
    assert.ok(result.failed.length > 0);
    assert.ok(result.failed[0].reason.includes('empty'));
  });

  it('fails gracefully when Claude throws', async () => {
    const throwAsk = async () => { throw new Error('API down'); };
    const result = await executeRefactorPlan({ plan, sourceFiles, askClaude: throwAsk });
    assert.equal(result.applied.length, 0);
    assert.ok(result.failed.some((f) => f.reason.includes('Claude error')));
  });

  it('fails when file not found in source set', async () => {
    const missingPlan = {
      ...plan,
      filesToModify: [{ path: 'src/nonexistent.js', description: 'Does not exist' }],
    };
    const result = await executeRefactorPlan({ plan: missingPlan, sourceFiles, askClaude: happyAsk });
    assert.ok(result.failed.some((f) => f.reason.includes('not found')));
  });

  it('strips code fences from Claude response', async () => {
    const fenceAsk = async () => '```js\nconst x = 1;\n```';
    const result = await executeRefactorPlan({ plan, sourceFiles, askClaude: fenceAsk });
    if (result.applied.length > 0) {
      assert.ok(!result.applied[0].after.startsWith('```'));
    }
  });

  it('respects MAX_FILES_PER_PLAN cap', async () => {
    const bigPlan = {
      ...plan,
      filesToModify: Array.from({ length: MAX_FILES_PER_PLAN + 5 }, (_, i) => ({
        path: `src/file${i}.js`,
        description: 'Change something',
      })),
    };
    const bigSourceFiles = Array.from({ length: MAX_FILES_PER_PLAN + 5 }, (_, i) => ({
      filePath: `src/file${i}.js`,
      content: `const x${i} = ${i};`,
    }));
    const result = await executeRefactorPlan({ plan: bigPlan, sourceFiles: bigSourceFiles, askClaude: happyAsk });
    assert.ok(result.applied.length + result.failed.length <= MAX_FILES_PER_PLAN);
  });

  it('respects MAX_NEW_FILES cap', async () => {
    const bigPlan = {
      ...plan,
      filesToModify: [],
      newFilesToCreate: Array.from({ length: MAX_NEW_FILES + 3 }, (_, i) => ({
        path: `src/new${i}.js`,
        description: 'New file',
      })),
      testFilesToCreate: [], // exclude test stubs so created only counts new files
    };
    const result = await executeRefactorPlan({ plan: bigPlan, sourceFiles, askClaude: happyAsk });
    assert.ok(result.created.length <= MAX_NEW_FILES);
  });

  it('runs scanner gate when runTier is provided and passes', async () => {
    const passingRunTier = async () => ({ modules: [] });
    const result = await executeRefactorPlan({
      plan, sourceFiles, askClaude: happyAsk, runTier: passingRunTier,
    });
    // No rollback expected since scanner returns no errors
    assert.equal(result.rolledBack.length, 0);
  });

  it('rolls back last applied file when scanner gate fails', async () => {
    const failingRunTier = async () => ({
      modules: [{
        module: 'secrets',
        checks: [{ passed: false, severity: 'error', message: 'hardcoded key' }],
      }],
    });
    const result = await executeRefactorPlan({
      plan, sourceFiles, askClaude: happyAsk, runTier: failingRunTier,
    });
    assert.equal(result.rolledBack.length, 1);
    assert.ok(result.rolledBack[0].reason.includes('scanner gate'));
  });

  it('does not block when scanner gate throws', async () => {
    const crashRunTier = async () => { throw new Error('scan crash'); };
    const result = await executeRefactorPlan({
      plan, sourceFiles, askClaude: happyAsk, runTier: crashRunTier,
    });
    // Should complete without throwing
    assert.ok(Array.isArray(result.applied));
  });
});

// ─── renderRefactorPrBody ─────────────────────────────────────────────────────

describe('renderRefactorPrBody', () => {
  const plan = {
    type: 'polling-to-webhook',
    rationale: 'Replace polling with a webhook receiver.',
    filesToModify: [],
    newFilesToCreate: [],
    testFilesToCreate: [],
    warnings: [],
  };

  it('includes refactor type heading', () => {
    const md = renderRefactorPrBody({ plan, applied: [], created: [], failed: [], rolledBack: [] });
    assert.ok(md.includes('polling to webhook') || md.includes('polling-to-webhook'));
  });

  it('includes rationale', () => {
    const md = renderRefactorPrBody({ plan, applied: [], created: [], failed: [], rolledBack: [] });
    assert.ok(md.includes('Replace polling'));
  });

  it('shows applied files as checkmarks', () => {
    const applied = [{ path: 'src/poller.js', before: 'old', after: 'new' }];
    const md = renderRefactorPrBody({ plan, applied, created: [], failed: [], rolledBack: [] });
    assert.ok(md.includes('src/poller.js'));
    assert.ok(md.includes('✅'));
  });

  it('shows rolled back files with reason', () => {
    const rolledBack = [{ path: 'src/x.js', reason: 'scanner gate found 1 new error' }];
    const md = renderRefactorPrBody({ plan, applied: [], created: [], failed: [], rolledBack });
    assert.ok(md.includes('src/x.js'));
    assert.ok(md.includes('Rolled back') || md.includes('⏪'));
  });

  it('shows created files', () => {
    const created = [{ path: 'src/webhook-handler.js', content: 'module.exports = () => {};' }];
    const md = renderRefactorPrBody({ plan, applied: [], created, failed: [], rolledBack: [] });
    assert.ok(md.includes('src/webhook-handler.js'));
  });

  it('marks test files with test emoji', () => {
    const created = [{ path: 'tests/handler.test.js', content: 'describe("x", () => {});' }];
    const md = renderRefactorPrBody({ plan, applied: [], created, failed: [], rolledBack: [] });
    assert.ok(md.includes('🧪'));
  });

  it('lists failed items for manual attention', () => {
    const failed = [{ path: 'src/missing.js', reason: 'file not found in source set' }];
    const md = renderRefactorPrBody({ plan, applied: [], created: [], failed, rolledBack: [] });
    assert.ok(md.includes('src/missing.js'));
    assert.ok(md.includes('not found'));
  });

  it('includes GateTest footer', () => {
    const md = renderRefactorPrBody({ plan, applied: [], created: [], failed: [], rolledBack: [] });
    assert.ok(md.includes('GateTest'));
  });
});
