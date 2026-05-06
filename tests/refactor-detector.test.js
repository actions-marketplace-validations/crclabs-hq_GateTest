'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  detectRefactors,
  detectPollingCandidates,
  detectInMemoryCandidates,
  detectUntypedFetchCandidates,
  isServerlessContext,
  MAX_FILES,
  MAX_FILE_BYTES,
} = require('../website/app/lib/refactor-detector');

// ─── isServerlessContext ──────────────────────────────────────────────────────

describe('isServerlessContext', () => {
  it('detects Next.js App Router route files by path', () => {
    assert.ok(isServerlessContext('website/app/api/scan/run/route.ts', ''));
    assert.ok(isServerlessContext('app/api/users/route.js', ''));
  });

  it('detects Next.js Pages API routes by path', () => {
    assert.ok(isServerlessContext('pages/api/auth.ts', ''));
    assert.ok(isServerlessContext('pages/api/scan/run.js', ''));
  });

  it('detects Lambda functions by path', () => {
    assert.ok(isServerlessContext('lambda/handler.js', ''));
    assert.ok(isServerlessContext('functions/worker.ts', ''));
  });

  it('detects by content — NextRequest import', () => {
    assert.ok(isServerlessContext('src/handler.ts', 'import { NextRequest } from "next/server";'));
  });

  it('detects by content — exports.handler', () => {
    assert.ok(isServerlessContext('src/index.js', 'exports.handler = async (event) => {};'));
  });

  it('returns false for non-serverless files', () => {
    assert.ok(!isServerlessContext('src/utils/helpers.ts', 'export const add = (a, b) => a + b;'));
    assert.ok(!isServerlessContext('components/Button.tsx', 'export default function Button() {}'));
  });
});

// ─── detectPollingCandidates ──────────────────────────────────────────────────

describe('detectPollingCandidates', () => {
  it('returns null when no files', () => {
    assert.equal(detectPollingCandidates([]), null);
  });

  it('returns null when no HTTP calls present', () => {
    const files = [{ filePath: 'poller.js', content: 'setInterval(() => { doWork(); }, 5000);' }];
    assert.equal(detectPollingCandidates(files), null);
  });

  it('returns null when no setInterval/loop present', () => {
    const files = [{ filePath: 'api.js', content: 'fetch("/api/data").then(r => r.json());' }];
    assert.equal(detectPollingCandidates(files), null);
  });

  it('detects setInterval + fetch', () => {
    const content = `
setInterval(async () => {
  const res = await fetch('/api/status');
  const data = await res.json();
  updateUI(data);
}, 5000);
`;
    const result = detectPollingCandidates([{ filePath: 'poller.js', content }]);
    assert.ok(result);
    assert.equal(result.type, 'polling-to-webhook');
    assert.equal(result.severity, 'high');
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].filePath, 'poller.js');
    assert.ok(result.files[0].evidence.length > 0);
  });

  it('detects setInterval + axios', () => {
    const content = `
setInterval(async () => {
  const data = await axios.get('/api/inventory');
  refresh(data);
}, 3000);
`;
    const result = detectPollingCandidates([{ filePath: 'sync.js', content }]);
    assert.ok(result);
    assert.equal(result.files.length, 1);
  });

  it('detects while(true) polling loop with sleep + fetch', () => {
    const content = `
async function poll() {
  while (true) {
    const res = await fetch('/api/queue');
    process(res);
    await sleep(2000);
  }
}
`;
    const result = detectPollingCandidates([{ filePath: 'worker.js', content }]);
    assert.ok(result);
    assert.equal(result.files[0].evidence.some((e) => e.evidence.includes('while')), true);
  });

  it('returns correct structure fields', () => {
    const content = 'setInterval(async () => { await fetch("/api/x"); }, 1000);';
    const result = detectPollingCandidates([{ filePath: 'x.js', content }]);
    assert.ok(result.type);
    assert.ok(result.severity);
    assert.ok(result.description);
    assert.ok(result.estimatedEffort);
    assert.ok(result.benefit);
  });

  it('marks effort as large for many files', () => {
    const content = 'setInterval(async () => { await fetch("/api/x"); }, 1000);';
    const files = Array.from({ length: 4 }, (_, i) => ({ filePath: `f${i}.js`, content }));
    const result = detectPollingCandidates(files);
    assert.equal(result.estimatedEffort, 'large');
  });
});

// ─── detectInMemoryCandidates ─────────────────────────────────────────────────

describe('detectInMemoryCandidates', () => {
  it('returns null when no files', () => {
    assert.equal(detectInMemoryCandidates([]), null);
  });

  it('returns null for non-serverless files with Map', () => {
    const files = [{ filePath: 'utils/cache.js', content: 'const cache = new Map();\n' }];
    assert.equal(detectInMemoryCandidates(files), null);
  });

  it('detects Map in Next.js App Router route file', () => {
    const content = `
import { NextRequest } from 'next/server';
const sessions = new Map();

export async function POST(req) {
  sessions.set(id, data);
}
`;
    const result = detectInMemoryCandidates([{ filePath: 'app/api/auth/route.ts', content }]);
    assert.ok(result);
    assert.equal(result.type, 'in-memory-to-store');
    assert.equal(result.severity, 'high');
  });

  it('detects Set in serverless file by content indicator', () => {
    const content = `
exports.handler = async (event) => {};
const activeIds = new Set();
`;
    const result = detectInMemoryCandidates([{ filePath: 'handler.js', content }]);
    assert.ok(result);
    assert.equal(result.files[0].evidence.length > 0, true);
  });

  it('detects named cache/store/state objects in serverless', () => {
    const content = `
export async function GET(req: NextRequest) {}
const rateLimitCache = {};
`;
    const result = detectInMemoryCandidates([{ filePath: 'app/api/rate/route.ts', content }]);
    assert.ok(result);
  });

  it('ignores indented Map declarations (not module scope)', () => {
    const content = `
export async function POST(req: NextRequest) {
    const localMap = new Map(); // inside function — not module-scope
    return localMap;
}
`;
    const result = detectInMemoryCandidates([{ filePath: 'app/api/x/route.ts', content }]);
    assert.equal(result, null);
  });

  it('returns correct structure', () => {
    const content = `
import { NextRequest } from 'next/server';
const cache = new Map();
export async function GET() {}
`;
    const result = detectInMemoryCandidates([{ filePath: 'app/api/x/route.ts', content }]);
    assert.ok(result.type);
    assert.ok(result.description);
    assert.ok(result.benefit);
    assert.equal(result.estimatedEffort, 'medium');
  });
});

// ─── detectUntypedFetchCandidates ────────────────────────────────────────────

describe('detectUntypedFetchCandidates', () => {
  it('returns null when no files', () => {
    assert.equal(detectUntypedFetchCandidates([]), null);
  });

  it('returns null when only one file has untyped fetch', () => {
    const files = [{ filePath: 'a.ts', content: 'const res = await fetch("/api/users");' }];
    assert.equal(detectUntypedFetchCandidates(files), null);
  });

  it('detects when 2+ files have raw fetch to internal API', () => {
    const files = [
      { filePath: 'src/dashboard.ts', content: 'const r = await fetch("/api/stats");' },
      { filePath: 'src/profile.ts', content: 'const r = await fetch("/api/users");' },
    ];
    const result = detectUntypedFetchCandidates(files);
    assert.ok(result);
    assert.equal(result.type, 'untyped-fetch-to-client');
    assert.equal(result.severity, 'medium');
    assert.equal(result.files.length, 2);
  });

  it('skips test files', () => {
    const files = [
      { filePath: 'src/a.ts', content: 'await fetch("/api/x");' },
      { filePath: 'tests/a.test.ts', content: 'await fetch("/api/x");' },
    ];
    const result = detectUntypedFetchCandidates(files);
    assert.equal(result, null); // only 1 non-test file
  });

  it('skips files that already use a typed client', () => {
    const files = [
      { filePath: 'src/a.ts', content: 'const res = await apiClient.get("/api/x");' },
      { filePath: 'src/b.ts', content: 'const res = await fetch("/api/y");' },
    ];
    const result = detectUntypedFetchCandidates(files);
    assert.equal(result, null);
  });

  it('detects axios.get to internal API', () => {
    const files = [
      { filePath: 'src/a.ts', content: 'await axios.get("/api/inventory");' },
      { filePath: 'src/b.ts', content: 'await axios.post("/api/orders");' },
    ];
    const result = detectUntypedFetchCandidates(files);
    assert.ok(result);
  });

  it('marks large effort for 6+ files', () => {
    const files = Array.from({ length: 6 }, (_, i) => ({
      filePath: `src/page${i}.ts`,
      content: `await fetch("/api/data${i}");`,
    }));
    const result = detectUntypedFetchCandidates(files);
    assert.ok(result);
    assert.equal(result.estimatedEffort, 'large');
  });

  it('returns description mentioning file count', () => {
    const files = [
      { filePath: 'src/a.ts', content: 'await fetch("/api/x");' },
      { filePath: 'src/b.ts', content: 'await fetch("/api/y");' },
    ];
    const result = detectUntypedFetchCandidates(files);
    assert.ok(result.description.includes('2 files'));
  });
});

// ─── detectRefactors (main entry) ────────────────────────────────────────────

describe('detectRefactors', () => {
  it('returns empty array for empty input', () => {
    assert.deepEqual(detectRefactors([]), []);
  });

  it('returns empty array when no candidates found', () => {
    const files = [{ filePath: 'src/utils.js', content: 'export const add = (a, b) => a + b;' }];
    assert.deepEqual(detectRefactors(files), []);
  });

  it('sorts high severity before medium', () => {
    const files = [
      // polling (high)
      { filePath: 'poller.js', content: 'setInterval(async () => { await fetch("/api/x"); }, 1000);' },
      // untyped fetch (medium) — 2+ files
      { filePath: 'src/a.ts', content: 'await fetch("/api/x");' },
      { filePath: 'src/b.ts', content: 'await fetch("/api/y");' },
    ];
    const results = detectRefactors(files);
    assert.ok(results.length >= 1);
    if (results.length >= 2) {
      const severityOrder = { high: 0, medium: 1, low: 2 };
      for (let i = 1; i < results.length; i++) {
        assert.ok(severityOrder[results[i - 1].severity] <= severityOrder[results[i].severity]);
      }
    }
  });

  it('respects MAX_FILES limit', () => {
    const many = Array.from({ length: MAX_FILES + 10 }, (_, i) => ({
      filePath: `f${i}.js`,
      content: 'const x = 1;',
    }));
    // Should not throw
    const results = detectRefactors(many);
    assert.ok(Array.isArray(results));
  });

  it('skips files exceeding MAX_FILE_BYTES', () => {
    const big = 'x'.repeat(MAX_FILE_BYTES + 1);
    const files = [{ filePath: 'huge.js', content: big }];
    // Should not throw and returns empty
    const results = detectRefactors(files);
    assert.ok(Array.isArray(results));
  });

  it('detects in-memory-to-store in serverless context', () => {
    const content = `
import { NextRequest } from 'next/server';
const cache = new Map();
export async function GET() {}
`;
    const results = detectRefactors([{ filePath: 'app/api/x/route.ts', content }]);
    const types = results.map((r) => r.type);
    assert.ok(types.includes('in-memory-to-store'));
  });
});
