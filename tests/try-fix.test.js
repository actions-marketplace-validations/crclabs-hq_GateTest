const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { tryFix } = require('../website/app/lib/try-fix');

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function tmpPath(ext = '.jsonl') {
  return path.join(
    os.tmpdir(),
    `gatetest-tryfix-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`
  );
}

function captureTelemetry() {
  const records = [];
  return {
    records,
    fn(entry) { records.push({ ...entry }); },
  };
}

// A finding that the AST layer can handle: rejectUnauthorized: false → true.
const AST_WINNING_ISSUE = {
  file: 'src/client.js',
  content: `const opts = {
  rejectUnauthorized: false,
  host: 'example.com'
};
fetch(opts);
`,
  severity: 'error',
  ruleKey: 'js-reject-unauthorized',
  module: 'tlsSecurity',
  message: 'rejectUnauthorized: false in https.Agent — disables TLS validation',
  line: 2,
};

// A finding that AST doesn't handle but rule-based-fixer does: Python verify=False.
const RULE_WINNING_ISSUE = {
  file: 'src/client.py',
  content: `import requests
requests.get('https://api.example.com', verify=False)
`,
  severity: 'error',
  ruleKey: 'py-verify-false',
  module: 'tlsSecurity',
  message: 'verify=False disables TLS cert validation',
  line: 2,
};

// A finding no layer matches by default — used for recipe and Claude tests.
const NOVEL_ISSUE = {
  file: 'src/foo.txt',
  content: 'this is a custom finding that no AST / rule layer handles',
  severity: 'warning',
  ruleKey: 'totally-novel-rule',
  module: 'unknownModule',
  message: 'something weird',
  line: 1,
};

// ---------------------------------------------------------------------------

describe('try-fix orchestrator', () => {
  describe('Layer wins', () => {
    it('AST layer wins when it returns a non-null patch', async () => {
      // Use a layer override so the test doesn't depend on whether @babel/parser
      // is installed in this environment (it is at full-install time; this test
      // is about orchestration order, not babel availability).
      const astLayer = async (issue) => issue.content.replace('rejectUnauthorized: false', 'rejectUnauthorized: true');
      const tel = captureTelemetry();
      const out = await tryFix(AST_WINNING_ISSUE, {
        enableClaude: false,
        recordFixAttempt: tel.fn,
        layerOverrides: { ast: astLayer },
      });
      assert.strictEqual(out.layer, 'ast');
      assert.ok(out.patched.includes('rejectUnauthorized: true'));
      assert.strictEqual(out.cost, 0);
      assert.ok(Number.isFinite(out.durationMs));
      // Telemetry: AST recorded with success=true.
      assert.ok(tel.records.some(r => r.layer === 'ast' && r.success));
      // Later layers must not be invoked.
      assert.strictEqual(tel.records.some(r => r.layer === 'rule'), false);
      assert.strictEqual(tel.records.some(r => r.layer === 'recipe'), false);
    });

    it('Rule layer wins when AST returns null', async () => {
      const tel = captureTelemetry();
      const out = await tryFix(RULE_WINNING_ISSUE, {
        enableClaude: false,
        recordFixAttempt: tel.fn,
      });
      assert.strictEqual(out.layer, 'rule');
      assert.ok(out.patched.includes('verify=True'));
      assert.strictEqual(out.cost, 0);
      // Telemetry: ast miss, rule success.
      assert.ok(tel.records.some(r => r.layer === 'ast'));
      assert.ok(tel.records.some(r => r.layer === 'rule' && r.success));
    });

    it('Recipe layer wins when AST + Rule miss but recipe matches', async () => {
      const recipeStorePath = tmpPath('.json');

      // Seed the store directly with a recipe whose `before` snippet appears
      // in the issue content. We write the JSON store manually so the test
      // doesn't depend on whether `distillClaudeFix` happens to consider this
      // particular diff templatey.
      const recipe = {
        id: 'seeded-recipe-id',
        ruleKey: NOVEL_ISSUE.ruleKey,
        module: NOVEL_ISSUE.module,
        fileExt: '.txt',
        before: 'this is a custom finding that no AST / rule layer handles',
        after:  'this is a fixed line',
        confidence: 'stable',
        applicationCount: 5,
        provenance: { originalModel: 'claude-sonnet-4-6', originalRuleKey: NOVEL_ISSUE.ruleKey, createdAt: '2026-01-01T00:00:00Z', lastAppliedAt: null },
      };
      fs.writeFileSync(recipeStorePath, JSON.stringify({ version: 1, recipes: [recipe] }, null, 2));

      const tel = captureTelemetry();
      const out = await tryFix(NOVEL_ISSUE, {
        enableClaude: false,
        recipeStorePath,
        recordFixAttempt: tel.fn,
      });
      assert.strictEqual(out.layer, 'recipe');
      assert.ok(out.patched.includes('this is a fixed line'));
      assert.strictEqual(out.cost, 0);
      assert.strictEqual(out.recipeId, 'seeded-recipe-id');
    });

    it('Claude layer is invoked when enableClaude=true and prior layers all miss', async () => {
      // Use a mocked Claude layer override to avoid hitting the real API.
      const claudeCalls = [];
      const fakeClaude = async (issue, opts) => {
        claudeCalls.push({ issue, opts });
        return {
          patched: issue.content + '\n// FIXED-BY-CLAUDE',
          costUsd: 0.001,
          model: 'claude-sonnet-4-6',
        };
      };
      const tel = captureTelemetry();
      const out = await tryFix(NOVEL_ISSUE, {
        enableClaude: true,
        anthropicApiKey: 'sk-test',
        recordFixAttempt: tel.fn,
        layerOverrides: { claude: fakeClaude },
      });
      assert.strictEqual(out.layer, 'claude');
      assert.ok(out.patched.endsWith('// FIXED-BY-CLAUDE'));
      assert.strictEqual(out.costUsd, 0.001);
      assert.strictEqual(claudeCalls.length, 1);
    });

    it('Claude is NOT invoked when enableClaude=false', async () => {
      const claudeCalls = [];
      const fakeClaude = async () => { claudeCalls.push(1); return { patched: 'should-not-happen' }; };
      const tel = captureTelemetry();
      const out = await tryFix(NOVEL_ISSUE, {
        enableClaude: false,
        anthropicApiKey: 'sk-test',
        recordFixAttempt: tel.fn,
        layerOverrides: { claude: fakeClaude },
      });
      assert.strictEqual(out.layer, null);
      assert.strictEqual(out.patched, null);
      assert.strictEqual(claudeCalls.length, 0);
    });

    it('Claude is NOT invoked when anthropicApiKey is missing', async () => {
      const claudeCalls = [];
      const fakeClaude = async () => { claudeCalls.push(1); return { patched: 'should-not-happen' }; };
      const out = await tryFix(NOVEL_ISSUE, {
        enableClaude: true,
        anthropicApiKey: '',
        layerOverrides: { claude: fakeClaude },
      });
      assert.strictEqual(out.layer, null);
      assert.strictEqual(claudeCalls.length, 0);
    });

    it('all-layer-miss returns { layer: null }', async () => {
      const out = await tryFix(NOVEL_ISSUE, { enableClaude: false });
      assert.strictEqual(out.layer, null);
      assert.strictEqual(out.patched, null);
      assert.ok(out.reason);
    });
  });

  describe('Robustness', () => {
    it('a crashing AST layer falls through to Rule', async () => {
      const crashingAst = async () => { throw new Error('boom in AST'); };
      const tel = captureTelemetry();
      const out = await tryFix(RULE_WINNING_ISSUE, {
        enableClaude: false,
        recordFixAttempt: tel.fn,
        layerOverrides: { ast: crashingAst },
      });
      assert.strictEqual(out.layer, 'rule');
      // AST telemetry should reflect the crash.
      const astRec = tel.records.find(r => r.layer === 'ast');
      assert.ok(astRec);
      assert.strictEqual(astRec.success, false);
      assert.ok(astRec.reason && astRec.reason.startsWith('error:'));
    });

    it('telemetry is recorded for every attempted layer regardless of outcome', async () => {
      const tel = captureTelemetry();
      await tryFix(NOVEL_ISSUE, {
        enableClaude: false,
        recordFixAttempt: tel.fn,
      });
      // We expect ast + rule + recipe layers attempted (claude skipped — disabled).
      const layers = tel.records.map(r => r.layer);
      assert.ok(layers.includes('ast'));
      assert.ok(layers.includes('rule'));
      assert.ok(layers.includes('recipe'));
    });

    it('rejects a no-op patched result (layer returns content === original)', async () => {
      const noOpLayer = async (issue) => issue.content; // returns input unchanged
      const tel = captureTelemetry();
      const out = await tryFix(NOVEL_ISSUE, {
        enableClaude: false,
        recordFixAttempt: tel.fn,
        layerOverrides: { ast: noOpLayer, rule: noOpLayer, recipe: noOpLayer },
      });
      // No layer should win because every one returned a no-op.
      assert.strictEqual(out.layer, null);
      // All three telemetry records should show success=false with reason 'no-op'.
      for (const layerName of ['ast', 'rule', 'recipe']) {
        const rec = tel.records.find(r => r.layer === layerName);
        assert.ok(rec, `no telemetry for ${layerName}`);
        assert.strictEqual(rec.success, false);
        assert.strictEqual(rec.reason, 'no-op');
      }
    });

    it('returns { layer: null } when issue is missing/invalid', async () => {
      const out1 = await tryFix(null);
      assert.strictEqual(out1.layer, null);
      const out2 = await tryFix({});
      assert.strictEqual(out2.layer, null);
    });

    it('records ruleKey + module + duration in telemetry (privacy contract — no content)', async () => {
      const astLayer = async (issue) => issue.content.replace('rejectUnauthorized: false', 'rejectUnauthorized: true');
      const tel = captureTelemetry();
      await tryFix(AST_WINNING_ISSUE, {
        enableClaude: false,
        recordFixAttempt: tel.fn,
        layerOverrides: { ast: astLayer },
      });
      const rec = tel.records.find(r => r.layer === 'ast' && r.success);
      assert.ok(rec);
      assert.strictEqual(rec.issueRuleKey, AST_WINNING_ISSUE.ruleKey);
      assert.strictEqual(rec.module, AST_WINNING_ISSUE.module);
      assert.ok(Number.isFinite(rec.durationMs));
      // The telemetry record itself must NOT contain the file content / file path.
      const serialised = JSON.stringify(rec);
      assert.strictEqual(serialised.includes(AST_WINNING_ISSUE.content), false);
      assert.strictEqual(serialised.includes(AST_WINNING_ISSUE.file), false);
    });
  });

  describe('Claude wiring via globalThis.fetch', () => {
    it('uses opts.fetch override to call Anthropic and parse response', async () => {
      const fakeFetch = async (url, init) => {
        assert.ok(url.includes('api.anthropic.com'));
        const parsed = JSON.parse(init.body);
        assert.strictEqual(parsed.model, 'claude-sonnet-4-6');
        return {
          status: 200,
          json: async () => ({
            content: [{ type: 'text', text: 'PATCHED CONTENT FROM CLAUDE' }],
            usage: { input_tokens: 100, output_tokens: 50 },
          }),
        };
      };
      const tel = captureTelemetry();
      const out = await tryFix(NOVEL_ISSUE, {
        enableClaude: true,
        anthropicApiKey: 'sk-test',
        fetch: fakeFetch,
        recordFixAttempt: tel.fn,
      });
      assert.strictEqual(out.layer, 'claude');
      assert.strictEqual(out.patched, 'PATCHED CONTENT FROM CLAUDE');
      assert.ok(out.costUsd > 0);
      assert.strictEqual(out.model, 'claude-sonnet-4-6');
      // Telemetry should reflect Claude success with the cost.
      const rec = tel.records.find(r => r.layer === 'claude' && r.success);
      assert.ok(rec);
      assert.ok(rec.costUsd > 0);
    });

    it('strips markdown code fences from Claude response', async () => {
      const fenced = '```js\nconst x = "fixed";\n```';
      const fakeFetch = async () => ({
        status: 200,
        json: async () => ({
          content: [{ type: 'text', text: fenced }],
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      });
      const out = await tryFix(NOVEL_ISSUE, {
        enableClaude: true,
        anthropicApiKey: 'sk-test',
        fetch: fakeFetch,
      });
      assert.strictEqual(out.layer, 'claude');
      assert.strictEqual(out.patched.startsWith('```'), false);
      assert.ok(out.patched.includes('const x = "fixed"'));
    });

    it('auto-distills a templatey Claude fix into a recipe', async () => {
      const recipeStorePath = tmpPath('.json');
      const issue = {
        file: 'src/widget.js',
        content: 'const o = { rejectUnauthorized: false };',
        severity: 'error',
        ruleKey: 'novel-rule-x',
        module: 'novelMod',
        message: 'something novel',
        line: 1,
      };
      // Claude's response is a small literal diff → templatey.
      const fakeFetch = async () => ({
        status: 200,
        json: async () => ({
          content: [{ type: 'text', text: 'const o = { rejectUnauthorized: true };' }],
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      });
      const out = await tryFix(issue, {
        enableClaude: true,
        anthropicApiKey: 'sk-test',
        fetch: fakeFetch,
        recipeStorePath,
        autoDistill: true,
      });
      assert.strictEqual(out.layer, 'claude');
      const store = JSON.parse(fs.readFileSync(recipeStorePath, 'utf8'));
      assert.strictEqual(store.recipes.length, 1);
      assert.strictEqual(store.recipes[0].ruleKey, 'novel-rule-x');
      assert.strictEqual(store.recipes[0].confidence, 'low');
    });
  });

  describe('JSONL telemetry integration', () => {
    it('writes a record to the JSONL when no recordFixAttempt override is supplied', async () => {
      const telemetryPath = tmpPath('.jsonl');
      const astLayer = async (issue) => issue.content.replace('rejectUnauthorized: false', 'rejectUnauthorized: true');
      const out = await tryFix(AST_WINNING_ISSUE, {
        enableClaude: false,
        telemetryPath,
        layerOverrides: { ast: astLayer },
      });
      assert.strictEqual(out.layer, 'ast');
      assert.ok(fs.existsSync(telemetryPath));
      const lines = fs.readFileSync(telemetryPath, 'utf8').trim().split('\n');
      assert.ok(lines.length >= 1);
      const astRec = lines.map(l => JSON.parse(l)).find(r => r.layer === 'ast' && r.success);
      assert.ok(astRec);
      assert.strictEqual(astRec.issueRuleKey, AST_WINNING_ISSUE.ruleKey);
    });
  });
});
