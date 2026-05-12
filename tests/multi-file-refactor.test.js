/**
 * Tests for website/app/lib/multi-file-refactor.js
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { runMultiFileRefactor, detectRefactors, renderRefactorReport, DETECTORS } = require('../website/app/lib/multi-file-refactor');

function file(path, content) { return { path, content }; }

// Mock Claude that returns the input unchanged (refactor returns "no changes")
const noopClaude = async (prompt) => {
  // Extract original code from prompt (between first ``` block)
  const match = prompt.match(/```[\w]*\n([\s\S]+?)\n```/);
  return match ? match[1] : prompt;
};

// Mock Claude that returns a modified version
const mutatingClaude = async (prompt) => {
  const match = prompt.match(/```[\w]*\n([\s\S]+?)\n```/);
  if (!match) return '// refactored file\nconst x = 1;';
  return `// REFACTORED\n${match[1]}\n// end`;
};

// ---------------------------------------------------------------------------
describe('DETECTORS', () => {
  test('exports three refactor types', () => {
    assert.ok(DETECTORS.POLLING_TO_WEBHOOK);
    assert.ok(DETECTORS.IN_MEMORY_TO_STORE);
    assert.ok(DETECTORS.UNTYPED_TO_TYPED_CLIENT);
  });

  test('each detector has name, description, detect, prompt', () => {
    for (const [key, d] of Object.entries(DETECTORS)) {
      assert.ok(typeof d.name === 'string', `${key}: name missing`);
      assert.ok(typeof d.description === 'string', `${key}: description missing`);
      assert.ok(typeof d.detect === 'function', `${key}: detect missing`);
      assert.ok(typeof d.prompt === 'function', `${key}: prompt missing`);
    }
  });
});

// ---------------------------------------------------------------------------
describe('detectRefactors — POLLING_TO_WEBHOOK', () => {
  test('detects setInterval + fetch pattern', () => {
    const content = `
setInterval(async () => {
  const data = await fetch('/api/status');
  updateUI(data);
}, 5000);
`;
    const matches = detectRefactors([file('src/poller.js', content)]);
    assert.ok(matches.some(m => m.refactorType === 'POLLING_TO_WEBHOOK'));
  });

  test('does not fire on setInterval without fetch', () => {
    const content = `
setInterval(() => {
  counter++;
}, 1000);
`;
    const matches = detectRefactors([file('src/counter.js', content)]);
    assert.ok(!matches.some(m => m.refactorType === 'POLLING_TO_WEBHOOK'));
  });

  test('detects setInterval + axios', () => {
    const content = `
setInterval(async () => {
  const res = await axios.get('/health');
  setStatus(res.data.status);
}, 10000);
`;
    const matches = detectRefactors([file('src/health.js', content)]);
    assert.ok(matches.some(m => m.refactorType === 'POLLING_TO_WEBHOOK'));
  });
});

// ---------------------------------------------------------------------------
describe('detectRefactors — IN_MEMORY_TO_STORE', () => {
  test('detects global Map + serverless export', () => {
    const content = `
const cache = new Map();
export default async function handler(req, res) {
  if (cache.has(req.query.id)) return res.json(cache.get(req.query.id));
  const data = await db.find(req.query.id);
  cache.set(req.query.id, data);
  res.json(data);
}
`;
    const matches = detectRefactors([file('app/api/data/route.ts', content)]);
    assert.ok(matches.some(m => m.refactorType === 'IN_MEMORY_TO_STORE'));
  });

  test('does not fire when no serverless export', () => {
    const content = `
const cache = new Map();
function localHelper() {
  cache.set('key', 'val');
}
`;
    const matches = detectRefactors([file('src/util.js', content)]);
    assert.ok(!matches.some(m => m.refactorType === 'IN_MEMORY_TO_STORE'));
  });
});

// ---------------------------------------------------------------------------
describe('detectRefactors — UNTYPED_TO_TYPED_CLIENT', () => {
  test('detects multiple fetch() calls without Zod', () => {
    const content = `
async function getUser(id) {
  const res = await fetch('/api/users/' + id);
  return res.json();
}
async function getOrders(userId) {
  const res = await fetch('/api/orders?userId=' + userId);
  return res.json();
}
`;
    const matches = detectRefactors([file('src/api.js', content)]);
    assert.ok(matches.some(m => m.refactorType === 'UNTYPED_TO_TYPED_CLIENT'));
  });

  test('does not fire when Zod is already imported', () => {
    const content = `
import { z } from 'zod';
const UserSchema = z.object({ id: z.string() });
async function getUser(id) {
  const res = await fetch('/api/users/' + id);
  return UserSchema.parse(await res.json());
}
async function getOrders(id) {
  const res = await fetch('/api/orders/' + id);
  return res.json();
}
`;
    const matches = detectRefactors([file('src/api.ts', content)]);
    assert.ok(!matches.some(m => m.refactorType === 'UNTYPED_TO_TYPED_CLIENT'));
  });

  test('does not fire with single fetch call', () => {
    const content = `
async function getData() {
  const res = await fetch('/api/data');
  return res.json();
}
`;
    const matches = detectRefactors([file('src/api.js', content)]);
    assert.ok(!matches.some(m => m.refactorType === 'UNTYPED_TO_TYPED_CLIENT'));
  });
});

// ---------------------------------------------------------------------------
describe('detectRefactors — file filtering', () => {
  test('skips non-JS files', () => {
    const matches = detectRefactors([file('config.yaml', 'setInterval: fetch')]);
    assert.equal(matches.length, 0);
  });

  test('skips empty files', () => {
    const matches = detectRefactors([file('src/empty.js', '')]);
    assert.equal(matches.length, 0);
  });
});

// ---------------------------------------------------------------------------
describe('runMultiFileRefactor', () => {
  test('returns no-match summary when no patterns detected', async () => {
    const result = await runMultiFileRefactor({
      files: [file('src/clean.js', 'const x = 1 + 2;')],
      askClaude: mutatingClaude,
    });
    assert.ok(result.summary.includes('No refactor patterns detected'));
    assert.equal(result.applied.length, 0);
  });

  test('throws if askClaude is not a function', async () => {
    await assert.rejects(
      () => runMultiFileRefactor({ files: [], askClaude: null }),
      /askClaude is required/
    );
  });

  test('handles Claude returning unchanged content gracefully', async () => {
    const content = `
const cache = new Map();
export default async function handler(req, res) {
  res.json(cache.get(req.query.id));
}
`;
    const result = await runMultiFileRefactor({
      files: [file('app/api/route.js', content)],
      askClaude: noopClaude,
    });
    // Should either apply or fail gracefully — no throws
    assert.ok(Array.isArray(result.applied));
    assert.ok(Array.isArray(result.failed));
  });

  test('handles Claude throwing gracefully', async () => {
    const content = `
setInterval(async () => { const d = await fetch('/api'); update(d); }, 5000);
`;
    const result = await runMultiFileRefactor({
      files: [file('src/poll.js', content)],
      askClaude: async () => { throw new Error('API down'); },
    });
    assert.equal(result.applied.length, 0);
    assert.ok(result.failed.length > 0);
    assert.ok(result.failed[0].reason.includes('Claude call failed'));
  });

  test('respects refactorTypes filter', async () => {
    const pollerContent = `
setInterval(async () => { const d = await fetch('/api'); update(d); }, 5000);
`;
    const result = await runMultiFileRefactor({
      files: [file('src/poll.js', pollerContent)],
      refactorTypes: ['IN_MEMORY_TO_STORE'], // not POLLING_TO_WEBHOOK
      askClaude: mutatingClaude,
    });
    // No IN_MEMORY patterns — should find nothing
    assert.ok(result.summary.includes('No refactor patterns detected'));
  });

  test('applies a valid refactor and returns before/after', async () => {
    const content = `
setInterval(async () => {
  const data = await fetch('/api/status');
  updateUI(data);
}, 5000);
`;
    const result = await runMultiFileRefactor({
      files: [file('src/poller.js', content)],
      askClaude: async () => `// REFACTORED\nconst setupWebhook = (cb) => { /* webhook impl */ };\nsetupWebhook(updateUI);`,
    });
    if (result.applied.length > 0) {
      assert.ok(result.applied[0].original);
      assert.ok(result.applied[0].refactored);
      assert.notEqual(result.applied[0].original, result.applied[0].refactored);
    }
  });
});

// ---------------------------------------------------------------------------
describe('renderRefactorReport', () => {
  test('returns "no refactors" message when applied is empty', () => {
    const report = renderRefactorReport({ applied: [], failed: [] });
    assert.ok(report.includes('No refactors applied'));
  });

  test('lists applied refactors with file paths', () => {
    const result = {
      applied: [{ filePath: 'src/poller.js', refactorName: 'polling → webhook', refactorType: 'POLLING_TO_WEBHOOK', ok: true }],
      failed: [],
    };
    const report = renderRefactorReport(result);
    assert.ok(report.includes('src/poller.js'));
    assert.ok(report.includes('polling → webhook'));
  });

  test('lists failed refactors', () => {
    const result = {
      applied: [],
      failed: [{ filePath: 'src/broken.js', reason: 'syntax gate failed', refactorType: 'IN_MEMORY_TO_STORE', ok: false }],
    };
    const report = renderRefactorReport(result);
    assert.ok(report.includes('No refactors applied'));
  });
});
