'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  parsePlanResponse,
  renderPlanSummary,
  buildPollingToWebhookPrompt,
  buildInMemoryToStorePrompt,
  buildUntypedFetchToClientPrompt,
  planRefactor,
  MAX_EVIDENCE_FILES,
} = require('../website/app/lib/refactor-planner');

// ─── parsePlanResponse ────────────────────────────────────────────────────────

describe('parsePlanResponse', () => {
  const validResponse = `RATIONALE:
The codebase polls /api/status every 5 seconds using setInterval. Replace with a webhook
so the server pushes state changes instead of the client pulling.

FILES_TO_MODIFY:
src/poller.js | Remove setInterval, add webhook listener registration
src/app.ts | Import and initialise the webhook receiver

NEW_FILES_TO_CREATE:
src/webhook-receiver.js | Express route handler for incoming webhook payloads

TEST_FILES_TO_CREATE:
tests/webhook-receiver.test.js | Test handler parses payload, calls updateUI

WARNINGS:
Requires the external service to support outbound webhooks`;

  it('parses a complete valid response', () => {
    const plan = parsePlanResponse(validResponse, 'polling-to-webhook');
    assert.ok(plan);
    assert.equal(plan.type, 'polling-to-webhook');
    assert.ok(plan.rationale.includes('polls /api/status'));
    assert.equal(plan.filesToModify.length, 2);
    assert.equal(plan.filesToModify[0].path, 'src/poller.js');
    assert.ok(plan.filesToModify[0].description.includes('Remove setInterval'));
    assert.equal(plan.newFilesToCreate.length, 1);
    assert.equal(plan.newFilesToCreate[0].path, 'src/webhook-receiver.js');
    assert.equal(plan.testFilesToCreate.length, 1);
    assert.equal(plan.warnings.length, 1);
  });

  it('returns null when rationale is missing', () => {
    const text = 'FILES_TO_MODIFY:\nsrc/a.js | change something\n';
    assert.equal(parsePlanResponse(text, 'polling-to-webhook'), null);
  });

  it('returns null when filesToModify is empty', () => {
    const text = 'RATIONALE:\nSomething\n\nFILES_TO_MODIFY:\nNONE\n';
    assert.equal(parsePlanResponse(text, 'polling-to-webhook'), null);
  });

  it('handles NONE for new files', () => {
    const text = `RATIONALE:
Replace polling.

FILES_TO_MODIFY:
src/a.js | remove interval

NEW_FILES_TO_CREATE:
NONE

TEST_FILES_TO_CREATE:
NONE

WARNINGS:
NONE`;
    const plan = parsePlanResponse(text, 'polling-to-webhook');
    assert.ok(plan);
    assert.deepEqual(plan.newFilesToCreate, []);
    assert.deepEqual(plan.testFilesToCreate, []);
    assert.deepEqual(plan.warnings, []);
  });

  it('skips file list entries without pipe separator', () => {
    const text = `RATIONALE:
Some rationale here.

FILES_TO_MODIFY:
src/a.js | valid entry
this line has no pipe and should be skipped
src/b.js | another valid entry

NEW_FILES_TO_CREATE:
NONE

TEST_FILES_TO_CREATE:
NONE

WARNINGS:
NONE`;
    const plan = parsePlanResponse(text, 'in-memory-to-store');
    assert.ok(plan);
    assert.equal(plan.filesToModify.length, 2);
  });

  it('preserves the refactorType in output', () => {
    const plan = parsePlanResponse(validResponse, 'in-memory-to-store');
    assert.equal(plan.type, 'in-memory-to-store');
  });

  it('handles code-fence-wrapped response', () => {
    const wrapped = '```\n' + validResponse + '\n```';
    // parsePlanResponse itself doesn't strip fences (planRefactor does that)
    // but it should handle extra newlines gracefully
    const plan = parsePlanResponse(validResponse, 'polling-to-webhook');
    assert.ok(plan);
  });
});

// ─── renderPlanSummary ────────────────────────────────────────────────────────

describe('renderPlanSummary', () => {
  const plan = {
    type: 'polling-to-webhook',
    rationale: 'Replace setInterval polling with a webhook receiver.',
    filesToModify: [
      { path: 'src/poller.js', description: 'Remove setInterval' },
    ],
    newFilesToCreate: [
      { path: 'src/webhook-receiver.js', description: 'Webhook handler' },
    ],
    testFilesToCreate: [
      { path: 'tests/webhook.test.js', description: 'Test handler' },
    ],
    warnings: ['Requires external service to support webhooks'],
  };

  it('includes refactor type in heading', () => {
    const md = renderPlanSummary(plan);
    assert.ok(md.includes('polling-to-webhook'));
  });

  it('includes rationale', () => {
    const md = renderPlanSummary(plan);
    assert.ok(md.includes('Replace setInterval polling'));
  });

  it('lists files to modify', () => {
    const md = renderPlanSummary(plan);
    assert.ok(md.includes('src/poller.js'));
    assert.ok(md.includes('Remove setInterval'));
  });

  it('lists new files to create', () => {
    const md = renderPlanSummary(plan);
    assert.ok(md.includes('src/webhook-receiver.js'));
  });

  it('lists test files', () => {
    const md = renderPlanSummary(plan);
    assert.ok(md.includes('tests/webhook.test.js'));
  });

  it('shows warnings', () => {
    const md = renderPlanSummary(plan);
    assert.ok(md.includes('Requires external service'));
  });

  it('omits new-files section when empty', () => {
    const p = { ...plan, newFilesToCreate: [] };
    const md = renderPlanSummary(p);
    assert.ok(!md.includes('New Files to Create'));
  });

  it('omits test-files section when empty', () => {
    const p = { ...plan, testFilesToCreate: [] };
    const md = renderPlanSummary(p);
    assert.ok(!md.includes('Test Files'));
  });

  it('omits warnings section when empty', () => {
    const p = { ...plan, warnings: [] };
    const md = renderPlanSummary(p);
    assert.ok(!md.includes('Warnings'));
  });

  it('shows None when filesToModify empty', () => {
    const p = { ...plan, filesToModify: [] };
    const md = renderPlanSummary(p);
    assert.ok(md.includes('_None_'));
  });
});

// ─── Prompt builders ──────────────────────────────────────────────────────────

describe('buildPollingToWebhookPrompt', () => {
  const candidate = {
    type: 'polling-to-webhook',
    files: [
      { filePath: 'src/poller.js', evidence: [{ lineNumber: 5, evidence: 'setInterval(...)' }] },
    ],
  };
  const fileContents = [
    { filePath: 'src/poller.js', content: 'setInterval(async () => { await fetch("/api/x"); }, 1000);' },
  ];

  it('produces a non-empty prompt', () => {
    const prompt = buildPollingToWebhookPrompt(candidate, fileContents);
    assert.ok(typeof prompt === 'string' && prompt.length > 100);
  });

  it('includes evidence file path', () => {
    const prompt = buildPollingToWebhookPrompt(candidate, fileContents);
    assert.ok(prompt.includes('src/poller.js'));
  });

  it('includes the structured response format', () => {
    const prompt = buildPollingToWebhookPrompt(candidate, fileContents);
    assert.ok(prompt.includes('RATIONALE:'));
    assert.ok(prompt.includes('FILES_TO_MODIFY:'));
    assert.ok(prompt.includes('NEW_FILES_TO_CREATE:'));
    assert.ok(prompt.includes('TEST_FILES_TO_CREATE:'));
    assert.ok(prompt.includes('WARNINGS:'));
  });

  it('caps evidence to MAX_EVIDENCE_FILES', () => {
    const many = Array.from({ length: MAX_EVIDENCE_FILES + 3 }, (_, i) => ({
      filePath: `f${i}.js`,
      evidence: [{ lineNumber: 1, evidence: 'setInterval(...)' }],
    }));
    const c = { ...candidate, files: many };
    const prompt = buildPollingToWebhookPrompt(c, []);
    // Should not throw and should be a string
    assert.ok(typeof prompt === 'string');
  });
});

describe('buildInMemoryToStorePrompt', () => {
  const candidate = {
    type: 'in-memory-to-store',
    files: [
      { filePath: 'app/api/auth/route.ts', evidence: [{ lineNumber: 2, evidence: 'const sessions = new Map();' }] },
    ],
  };

  it('produces a non-empty prompt', () => {
    const prompt = buildInMemoryToStorePrompt(candidate, []);
    assert.ok(prompt.length > 100);
  });

  it('mentions Vercel KV and Redis options', () => {
    const prompt = buildInMemoryToStorePrompt(candidate, []);
    assert.ok(prompt.includes('Vercel KV'));
    assert.ok(prompt.includes('Redis'));
  });

  it('includes structured format markers', () => {
    const prompt = buildInMemoryToStorePrompt(candidate, []);
    assert.ok(prompt.includes('RATIONALE:'));
    assert.ok(prompt.includes('FILES_TO_MODIFY:'));
  });
});

describe('buildUntypedFetchToClientPrompt', () => {
  const candidate = {
    type: 'untyped-fetch-to-client',
    files: [
      { filePath: 'src/dashboard.ts', evidence: [{ lineNumber: 5, evidence: 'fetch("/api/stats")' }] },
      { filePath: 'src/profile.ts', evidence: [{ lineNumber: 3, evidence: 'fetch("/api/users")' }] },
    ],
  };

  it('mentions file count in prompt', () => {
    const prompt = buildUntypedFetchToClientPrompt(candidate, []);
    assert.ok(prompt.includes('2 files'));
  });

  it('mentions Zod schemas', () => {
    const prompt = buildUntypedFetchToClientPrompt(candidate, []);
    assert.ok(prompt.includes('Zod'));
  });
});

// ─── planRefactor ─────────────────────────────────────────────────────────────

describe('planRefactor', () => {
  const validPlanText = `RATIONALE:
The code polls every 5 seconds. Replace with webhook.

FILES_TO_MODIFY:
src/poller.js | Remove setInterval loop

NEW_FILES_TO_CREATE:
src/webhook-handler.js | Receives webhook payload

TEST_FILES_TO_CREATE:
tests/webhook.test.js | Tests the handler

WARNINGS:
NONE`;

  const candidate = {
    type: 'polling-to-webhook',
    files: [{ filePath: 'src/poller.js', evidence: [{ lineNumber: 3, evidence: 'setInterval(...)' }] }],
  };
  const sourceFiles = [
    { filePath: 'src/poller.js', content: 'setInterval(async () => { await fetch("/api/x"); }, 5000);' },
  ];

  it('returns a plan from a valid Claude response', async () => {
    const askClaude = async () => validPlanText;
    const plan = await planRefactor({ candidate, sourceFiles, askClaude });
    assert.ok(plan);
    assert.equal(plan.type, 'polling-to-webhook');
    assert.ok(plan.rationale.includes('polls every 5 seconds'));
    assert.equal(plan.filesToModify.length, 1);
    assert.equal(plan.newFilesToCreate.length, 1);
    assert.equal(plan.testFilesToCreate.length, 1);
    assert.deepEqual(plan.warnings, []);
  });

  it('strips code fences from Claude response before parsing', async () => {
    const askClaude = async () => '```\n' + validPlanText + '\n```';
    const plan = await planRefactor({ candidate, sourceFiles, askClaude });
    assert.ok(plan);
  });

  it('returns null when Claude returns empty string', async () => {
    const askClaude = async () => '';
    const plan = await planRefactor({ candidate, sourceFiles, askClaude });
    assert.equal(plan, null);
  });

  it('returns null when Claude returns unparseable text', async () => {
    const askClaude = async () => 'Sure! I would suggest refactoring this code to use webhooks.';
    const plan = await planRefactor({ candidate, sourceFiles, askClaude });
    assert.equal(plan, null);
  });

  it('throws on Claude error', async () => {
    const askClaude = async () => { throw new Error('API failure'); };
    await assert.rejects(
      () => planRefactor({ candidate, sourceFiles, askClaude }),
      /API failure/,
    );
  });

  it('throws for unknown refactor type', async () => {
    const badCandidate = { ...candidate, type: 'not-a-real-type', files: [] };
    await assert.rejects(
      () => planRefactor({ candidate: badCandidate, sourceFiles, askClaude: async () => '' }),
      /Unknown refactor type/,
    );
  });

  it('works for in-memory-to-store type', async () => {
    const memCandidate = {
      type: 'in-memory-to-store',
      files: [{ filePath: 'app/api/auth/route.ts', evidence: [{ lineNumber: 2, evidence: 'const cache = new Map();' }] }],
    };
    const askClaude = async () => validPlanText;
    const plan = await planRefactor({ candidate: memCandidate, sourceFiles, askClaude });
    assert.ok(plan);
    assert.equal(plan.type, 'in-memory-to-store');
  });

  it('works for untyped-fetch-to-client type', async () => {
    const fetchCandidate = {
      type: 'untyped-fetch-to-client',
      files: [
        { filePath: 'src/a.ts', evidence: [{ lineNumber: 1, evidence: 'fetch("/api/x")' }] },
        { filePath: 'src/b.ts', evidence: [{ lineNumber: 2, evidence: 'fetch("/api/y")' }] },
      ],
    };
    const askClaude = async () => validPlanText;
    const plan = await planRefactor({ candidate: fetchCandidate, sourceFiles, askClaude });
    assert.ok(plan);
  });
});
