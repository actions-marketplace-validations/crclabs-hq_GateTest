// ============================================================================
// FIX-CONTEXT-ENRICHER TEST — architecture-aware fix context gathering
// ============================================================================
// Verifies that enrichFixContext gathers consumers, dependencies, and stack
// hints correctly, honours caps, and never throws even when fetchFile blows.
// ============================================================================

const { describe, it, test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const {
  enrichFixContext,
  extractImportSpecifiers,
  resolveSpecifier,
  fileReferencesTarget,
  extractStackHints,
  buildSummary,
} = require(path.resolve(
  __dirname, '..', 'website', 'app', 'lib', 'fix-context-enricher.js',
));

// ─── extractImportSpecifiers ────────────────────────────────────────────────

describe('extractImportSpecifiers', () => {
  it('extracts ES module default import', () => {
    const src = `import foo from './lib/foo'`;
    const specs = extractImportSpecifiers(src);
    assert.ok(specs.includes('./lib/foo'), `Got: ${JSON.stringify(specs)}`);
  });

  it('extracts named ES import', () => {
    const src = `import { bar, baz } from '../utils'`;
    const specs = extractImportSpecifiers(src);
    assert.ok(specs.includes('../utils'));
  });

  it('extracts side-effect import', () => {
    const src = `import './polyfill'`;
    const specs = extractImportSpecifiers(src);
    assert.ok(specs.includes('./polyfill'));
  });

  it('extracts CommonJS require', () => {
    const src = `const x = require('./config')`;
    const specs = extractImportSpecifiers(src);
    assert.ok(specs.includes('./config'));
  });

  it('extracts bare package names', () => {
    const src = `import React from 'react'`;
    const specs = extractImportSpecifiers(src);
    assert.ok(specs.includes('react'));
  });

  it('extracts re-export from specifier', () => {
    const src = `export { thing } from './thing'`;
    const specs = extractImportSpecifiers(src);
    assert.ok(specs.includes('./thing'));
  });

  it('handles multiple imports in one file', () => {
    const src = [
      `import a from './a'`,
      `import b from './b'`,
      `const c = require('./c')`,
    ].join('\n');
    const specs = extractImportSpecifiers(src);
    assert.ok(specs.includes('./a'));
    assert.ok(specs.includes('./b'));
    assert.ok(specs.includes('./c'));
  });

  it('returns empty array for non-string input', () => {
    assert.deepStrictEqual(extractImportSpecifiers(null), []);
    assert.deepStrictEqual(extractImportSpecifiers(undefined), []);
    assert.deepStrictEqual(extractImportSpecifiers(42), []);
  });

  it('returns empty array for empty file', () => {
    assert.deepStrictEqual(extractImportSpecifiers(''), []);
  });
});

// ─── resolveSpecifier ───────────────────────────────────────────────────────

describe('resolveSpecifier', () => {
  const allFiles = [
    'src/lib/stripe-client.ts',
    'src/lib/utils.js',
    'src/api/checkout.ts',
    'src/api/webhooks/index.ts',
    'package.json',
  ];

  it('resolves a relative .ts specifier', () => {
    const result = resolveSpecifier('./stripe-client', 'src/lib/utils.js', allFiles);
    assert.strictEqual(result, 'src/lib/stripe-client.ts');
  });

  it('resolves an exact-extension specifier', () => {
    const result = resolveSpecifier('./utils.js', 'src/lib/stripe-client.ts', allFiles);
    assert.strictEqual(result, 'src/lib/utils.js');
  });

  it('resolves parent-directory relative path (../)', () => {
    const result = resolveSpecifier('../lib/utils', 'src/api/checkout.ts', allFiles);
    assert.strictEqual(result, 'src/lib/utils.js');
  });

  it('resolves directory index import', () => {
    const result = resolveSpecifier('./webhooks', 'src/api/checkout.ts', allFiles);
    assert.strictEqual(result, 'src/api/webhooks/index.ts');
  });

  it('returns null for bare package names', () => {
    assert.strictEqual(resolveSpecifier('react', 'src/app.ts', allFiles), null);
    assert.strictEqual(resolveSpecifier('@anthropic-ai/sdk', 'src/app.ts', allFiles), null);
  });

  it('returns null when file not in allFiles', () => {
    assert.strictEqual(resolveSpecifier('./missing', 'src/app.ts', allFiles), null);
  });

  it('returns null for invalid inputs', () => {
    assert.strictEqual(resolveSpecifier(null, 'src/app.ts', allFiles), null);
    assert.strictEqual(resolveSpecifier('./foo', null, allFiles), null);
  });
});

// ─── fileReferencesTarget ───────────────────────────────────────────────────

describe('fileReferencesTarget', () => {
  it('detects ES import referencing the target file', () => {
    const content = `import { something } from '../lib/stripe-client'`;
    assert.ok(fileReferencesTarget(content, 'src/lib/stripe-client.ts'));
  });

  it('detects require referencing the target file', () => {
    const content = `const x = require('./stripe-client')`;
    assert.ok(fileReferencesTarget(content, 'src/lib/stripe-client.ts'));
  });

  it('returns false when target not referenced', () => {
    const content = `import something from './other-module'`;
    assert.strictEqual(fileReferencesTarget(content, 'src/lib/stripe-client.ts'), false);
  });

  it('handles invalid inputs gracefully', () => {
    assert.strictEqual(fileReferencesTarget(null, 'foo.ts'), false);
    assert.strictEqual(fileReferencesTarget('import x from "./y"', null), false);
  });
});

// ─── extractStackHints ──────────────────────────────────────────────────────

describe('extractStackHints', () => {
  it('identifies Next.js and Stripe from package.json', () => {
    const pkg = JSON.stringify({
      dependencies: { next: '^14.0.0', stripe: '^14.0.0' },
    });
    const hints = extractStackHints(pkg);
    assert.ok(hints.includes('Next.js'), `Got: ${JSON.stringify(hints)}`);
    assert.ok(hints.includes('Stripe'));
  });

  it('identifies TypeScript from devDependencies', () => {
    const pkg = JSON.stringify({
      devDependencies: { typescript: '^5.0.0' },
    });
    const hints = extractStackHints(pkg);
    assert.ok(hints.includes('TypeScript'));
  });

  it('deduplicates hints (e.g. both @prisma/client and prisma)', () => {
    const pkg = JSON.stringify({
      dependencies: { '@prisma/client': '^5.0.0', prisma: '^5.0.0' },
    });
    const hints = extractStackHints(pkg);
    const count = hints.filter((h) => h === 'Prisma').length;
    assert.strictEqual(count, 1);
  });

  it('returns empty array for invalid JSON', () => {
    assert.deepStrictEqual(extractStackHints('not json'), []);
  });

  it('returns empty array for non-string input', () => {
    assert.deepStrictEqual(extractStackHints(null), []);
    assert.deepStrictEqual(extractStackHints(undefined), []);
  });

  it('returns empty array when no known packages present', () => {
    const pkg = JSON.stringify({ dependencies: { 'some-obscure-lib': '^1.0.0' } });
    assert.deepStrictEqual(extractStackHints(pkg), []);
  });
});

// ─── buildSummary ───────────────────────────────────────────────────────────

describe('buildSummary', () => {
  it('includes consumer count and names', () => {
    const s = buildSummary({
      filePath: 'src/lib/stripe-client.ts',
      consumers: ['api/checkout.ts', 'api/webhook.ts'],
      dependencies: [],
      stackHints: [],
    });
    assert.ok(s.includes('2 other file'), `Got: ${s}`);
    assert.ok(s.includes('api/checkout.ts'));
  });

  it('mentions dependency paths', () => {
    const s = buildSummary({
      filePath: 'src/api/checkout.ts',
      consumers: [],
      dependencies: ['src/lib/stripe-client.ts'],
      stackHints: [],
    });
    assert.ok(s.includes('stripe-client'), `Got: ${s}`);
  });

  it('mentions tech stack', () => {
    const s = buildSummary({
      filePath: 'src/app.ts',
      consumers: [],
      dependencies: [],
      stackHints: ['Next.js', 'Stripe'],
    });
    assert.ok(s.includes('Next.js') && s.includes('Stripe'), `Got: ${s}`);
  });

  it('falls back gracefully when all arrays empty', () => {
    const s = buildSummary({
      filePath: 'src/mystery.ts',
      consumers: [],
      dependencies: [],
      stackHints: [],
    });
    assert.ok(typeof s === 'string' && s.length > 0);
    assert.ok(s.includes('mystery.ts'));
  });
});

// ─── enrichFixContext (integration) ─────────────────────────────────────────

describe('enrichFixContext', () => {
  // Synthetic repo
  const allFiles = [
    'src/api/checkout.ts',
    'src/api/webhook.ts',
    'src/lib/stripe-client.ts',
    'src/lib/utils.js',
    'package.json',
  ];

  const fileContents = {
    'src/lib/stripe-client.ts': `
      import { something } from './utils'
      export function createCharge() {}
    `,
    'src/api/checkout.ts': `
      import { createCharge } from '../lib/stripe-client'
      export default function handler() {}
    `,
    'src/api/webhook.ts': `
      import { createCharge } from '../lib/stripe-client'
      export function handleWebhook() {}
    `,
    'src/lib/utils.js': `export function helper() {}`,
    'package.json': JSON.stringify({
      dependencies: { next: '^14', stripe: '^14' },
      devDependencies: { typescript: '^5' },
    }),
  };

  function makeFetchFile(contents) {
    return async (p) => contents[p] || null;
  }

  it('detects consumers of stripe-client', async () => {
    const ctx = await enrichFixContext({
      filePath: 'src/lib/stripe-client.ts',
      fileContents: fileContents['src/lib/stripe-client.ts'],
      allFiles,
      fetchFile: makeFetchFile(fileContents),
    });
    assert.ok(
      ctx.consumers.includes('src/api/checkout.ts') ||
      ctx.consumers.includes('src/api/webhook.ts'),
      `Consumers: ${JSON.stringify(ctx.consumers)}`,
    );
  });

  it('detects dependencies of stripe-client', async () => {
    const ctx = await enrichFixContext({
      filePath: 'src/lib/stripe-client.ts',
      fileContents: fileContents['src/lib/stripe-client.ts'],
      allFiles,
      fetchFile: makeFetchFile(fileContents),
    });
    assert.ok(
      ctx.dependencies.includes('src/lib/utils.js'),
      `Deps: ${JSON.stringify(ctx.dependencies)}`,
    );
  });

  it('extracts stack hints from package.json', async () => {
    const ctx = await enrichFixContext({
      filePath: 'src/api/checkout.ts',
      fileContents: fileContents['src/api/checkout.ts'],
      allFiles,
      fetchFile: makeFetchFile(fileContents),
    });
    assert.ok(ctx.stackHints.includes('Next.js'), `Hints: ${JSON.stringify(ctx.stackHints)}`);
    assert.ok(ctx.stackHints.includes('Stripe'));
  });

  it('returns a non-empty summary string', async () => {
    const ctx = await enrichFixContext({
      filePath: 'src/lib/stripe-client.ts',
      fileContents: fileContents['src/lib/stripe-client.ts'],
      allFiles,
      fetchFile: makeFetchFile(fileContents),
    });
    assert.ok(typeof ctx.summary === 'string' && ctx.summary.length > 0);
  });

  it('never throws when fetchFile always throws', async () => {
    const ctx = await enrichFixContext({
      filePath: 'src/lib/stripe-client.ts',
      fileContents: fileContents['src/lib/stripe-client.ts'],
      allFiles,
      fetchFile: async () => { throw new Error('network down'); },
    });
    assert.ok(Array.isArray(ctx.consumers));
    assert.ok(Array.isArray(ctx.dependencies));
    assert.ok(Array.isArray(ctx.stackHints));
    assert.ok(typeof ctx.summary === 'string');
  });

  it('caps consumers at MAX_DEPS (5)', async () => {
    const manyFiles = Array.from({ length: 20 }, (_, i) => `src/consumer${i}.ts`);
    const manyContents = {};
    for (const f of manyFiles) {
      manyContents[f] = `import { x } from '../lib/stripe-client'`;
    }
    const ctx = await enrichFixContext({
      filePath: 'src/lib/stripe-client.ts',
      fileContents: `export function x() {}`,
      allFiles: ['src/lib/stripe-client.ts', ...manyFiles, 'package.json'],
      fetchFile: async (p) => manyContents[p] || '{}',
    });
    assert.ok(ctx.consumers.length <= 5, `Got ${ctx.consumers.length} consumers`);
  });

  it('caps dependencies at MAX_DEPS (5)', async () => {
    const manyDeps = Array.from({ length: 10 }, (_, i) => `src/lib/dep${i}.ts`);
    const manyImports = manyDeps.map((d, i) => `import x${i} from './${d.split('/').pop()}'`).join('\n');
    const depContents = {};
    for (const d of manyDeps) depContents[d] = `export const x = 1;`;

    const ctx = await enrichFixContext({
      filePath: 'src/api/checkout.ts',
      fileContents: manyImports,
      allFiles: ['src/api/checkout.ts', ...manyDeps, 'package.json'],
      fetchFile: async (p) => depContents[p] || null,
    });
    assert.ok(ctx.dependencies.length <= 5, `Got ${ctx.dependencies.length} dependencies`);
  });

  it('returns empty context on invalid arguments (no throw)', async () => {
    const ctx = await enrichFixContext({});
    assert.deepStrictEqual(ctx.consumers, []);
    assert.deepStrictEqual(ctx.dependencies, []);
    assert.deepStrictEqual(ctx.stackHints, []);
    assert.ok(typeof ctx.summary === 'string');
  });

  it('handles file with no imports and no consumers', async () => {
    const ctx = await enrichFixContext({
      filePath: 'src/standalone.ts',
      fileContents: `export const PI = 3.14;`,
      allFiles: ['src/standalone.ts', 'package.json'],
      fetchFile: async (p) => (p === 'package.json' ? '{}' : null),
    });
    assert.deepStrictEqual(ctx.consumers, []);
    assert.deepStrictEqual(ctx.dependencies, []);
  });

  it('TypeScript .ts files resolved correctly', async () => {
    const ctx = await enrichFixContext({
      filePath: 'app/lib/utils.ts',
      fileContents: `import { helper } from './helper'`,
      allFiles: ['app/lib/utils.ts', 'app/lib/helper.ts', 'package.json'],
      fetchFile: async (p) => (p === 'package.json' ? '{}' : `export function helper() {}`),
    });
    assert.ok(ctx.dependencies.includes('app/lib/helper.ts'));
  });

  it('JavaScript .js files resolved correctly', async () => {
    const ctx = await enrichFixContext({
      filePath: 'lib/main.js',
      fileContents: `const util = require('./util')`,
      allFiles: ['lib/main.js', 'lib/util.js', 'package.json'],
      fetchFile: async (p) => (p === 'package.json' ? '{}' : `module.exports = {};`),
    });
    assert.ok(ctx.dependencies.includes('lib/util.js'));
  });
});
