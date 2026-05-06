'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  isEntryPoint,
  detectFramework,
  detectPresentPolicies,
  buildSecurityPolicyPrompt,
  validatePatch,
  applySecurityPolicies,
  generateSecurityPatches,
  MAX_FILES_PER_RUN,
} = require('../website/app/lib/security-policy-applier');

// ─── isEntryPoint ─────────────────────────────────────────────────────────────

describe('isEntryPoint', () => {
  it('accepts app.js at root', () => {
    assert.equal(isEntryPoint('app.js'), true);
    assert.equal(isEntryPoint('server.js'), true);
    assert.equal(isEntryPoint('index.js'), true);
    assert.equal(isEntryPoint('main.ts'), true);
  });

  it('accepts middleware files', () => {
    assert.equal(isEntryPoint('middleware.ts'), true);
    assert.equal(isEntryPoint('src/middleware.js'), true);
  });

  it('accepts src/ entry points', () => {
    assert.equal(isEntryPoint('src/app.js'), true);
    assert.equal(isEntryPoint('src/server.ts'), true);
  });

  it('rejects test files', () => {
    assert.equal(isEntryPoint('app.test.js'), false);
    assert.equal(isEntryPoint('server.spec.ts'), false);
  });

  it('rejects type declarations', () => {
    assert.equal(isEntryPoint('app.d.ts'), false);
  });

  it('rejects build output and node_modules', () => {
    assert.equal(isEntryPoint('dist/app.js'), false);
    assert.equal(isEntryPoint('.next/server/app.js'), false);
    assert.equal(isEntryPoint('node_modules/express/app.js'), false);
  });

  it('rejects non-entry-point names', () => {
    assert.equal(isEntryPoint('utils.js'), false);
    assert.equal(isEntryPoint('routes/users.js'), false);
    assert.equal(isEntryPoint('config.js'), false);
  });

  it('rejects non-JS/TS files', () => {
    assert.equal(isEntryPoint('app.json'), false);
    assert.equal(isEntryPoint('app.py'), false);
  });

  it('rejects empty/null', () => {
    assert.equal(isEntryPoint(''), false);
    assert.equal(isEntryPoint(null), false);
  });
});

// ─── detectFramework ──────────────────────────────────────────────────────────

describe('detectFramework', () => {
  it('detects express from require', () => {
    assert.equal(detectFramework("const express = require('express'); const app = express();"), 'express');
  });

  it('detects express from import', () => {
    assert.equal(detectFramework("import express from 'express';"), 'express');
  });

  it('detects fastify', () => {
    assert.equal(detectFramework("const fastify = require('fastify'); const app = Fastify();"), 'fastify');
  });

  it('detects koa', () => {
    assert.equal(detectFramework("const Koa = require('koa'); const app = new Koa();"), 'koa');
  });

  it('detects nextjs from NextResponse', () => {
    assert.equal(detectFramework("import { NextResponse } from 'next/server';"), 'nextjs');
  });

  it('detects hono', () => {
    assert.equal(detectFramework("import { Hono } from 'hono'; const app = new Hono();"), 'hono');
  });

  it('returns unknown for unrecognised content', () => {
    assert.equal(detectFramework('const x = 1;'), 'unknown');
  });
});

// ─── detectPresentPolicies ────────────────────────────────────────────────────

describe('detectPresentPolicies', () => {
  it('detects helmet as CSP', () => {
    const policies = detectPresentPolicies("app.use(helmet());");
    assert.ok(policies.has('csp'));
  });

  it('detects Content-Security-Policy header as CSP', () => {
    const policies = detectPresentPolicies('res.setHeader("Content-Security-Policy", "default-src \'self\'");');
    assert.ok(policies.has('csp'));
  });

  it('detects csrf', () => {
    const policies = detectPresentPolicies("const csrf = require('csrf'); app.use(csrf());");
    assert.ok(policies.has('csrf'));
  });

  it('detects doubleCsrf', () => {
    const policies = detectPresentPolicies("const { doubleCsrf } = require('csrf-csrf');");
    assert.ok(policies.has('csrf'));
  });

  it('detects rate limiting', () => {
    const policies = detectPresentPolicies("const rateLimit = require('express-rate-limit');");
    assert.ok(policies.has('rateLimit'));
  });

  it('returns empty set for unprotected file', () => {
    const policies = detectPresentPolicies("const express = require('express');\nconst app = express();");
    assert.equal(policies.size, 0);
  });

  it('detects multiple policies', () => {
    const content = "app.use(helmet()); app.use(csrf()); const limiter = rateLimit({});";
    const policies = detectPresentPolicies(content);
    assert.ok(policies.has('csp'));
    assert.ok(policies.has('csrf'));
    assert.ok(policies.has('rateLimit'));
  });
});

// ─── buildSecurityPolicyPrompt ────────────────────────────────────────────────

describe('buildSecurityPolicyPrompt', () => {
  const content = "const express = require('express');\nconst app = express();\napp.listen(3000);";

  it('includes filePath and framework', () => {
    const prompt = buildSecurityPolicyPrompt({
      filePath: 'src/app.js',
      content,
      framework: 'express',
      missingPolicies: ['csp', 'csrf'],
    });
    assert.ok(prompt.includes('src/app.js'));
    assert.ok(prompt.includes('express'));
  });

  it('lists missing policies', () => {
    const prompt = buildSecurityPolicyPrompt({
      filePath: 'app.js',
      content,
      framework: 'express',
      missingPolicies: ['csp', 'rateLimit'],
    });
    assert.ok(prompt.includes('CSP') || prompt.includes('Content-Security-Policy'));
    assert.ok(prompt.includes('rate') || prompt.includes('Rate'));
  });

  it('includes file content', () => {
    const prompt = buildSecurityPolicyPrompt({
      filePath: 'app.js',
      content,
      framework: 'express',
      missingPolicies: ['csrf'],
    });
    assert.ok(prompt.includes("require('express')"));
  });

  it('provides fastify-specific instructions', () => {
    const prompt = buildSecurityPolicyPrompt({
      filePath: 'server.js',
      content: "const fastify = require('fastify');",
      framework: 'fastify',
      missingPolicies: ['csp'],
    });
    assert.ok(prompt.includes('fastify') || prompt.includes('Fastify'));
  });
});

// ─── validatePatch ────────────────────────────────────────────────────────────

describe('validatePatch', () => {
  it('accepts valid CSP patch', () => {
    const content = "const helmet = require('helmet');\nconst app = express();\napp.use(helmet());\napp.listen(3000);";
    const { valid } = validatePatch(content, ['csp']);
    assert.equal(valid, true);
  });

  it('accepts valid rate-limit patch', () => {
    const content = "const rateLimit = require('express-rate-limit');\nconst limiter = rateLimit({ windowMs: 60000, max: 100 });\napp.use(limiter);";
    const { valid } = validatePatch(content, ['rateLimit']);
    assert.equal(valid, true);
  });

  it('rejects patch that is too short', () => {
    const { valid, reason } = validatePatch('ok', ['csp']);
    assert.equal(valid, false);
    assert.ok(reason.includes('short'));
  });

  it('rejects patch with no policy reference', () => {
    const content = "const express = require('express');\nconst app = express();\napp.listen(3000);";
    const { valid, reason } = validatePatch(content, ['csp', 'csrf']);
    assert.equal(valid, false);
    assert.ok(reason.includes('policy'));
  });

  it('rejects empty content', () => {
    const { valid } = validatePatch('', ['csp']);
    assert.equal(valid, false);
  });
});

// ─── applySecurityPolicies ────────────────────────────────────────────────────

describe('applySecurityPolicies', () => {
  const expressContent = "const express = require('express');\nconst app = express();\napp.get('/', (req, res) => res.send('hi'));\napp.listen(3000);";

  it('returns ok=true for a valid Claude patch', async () => {
    const patch = "const helmet = require('helmet');\nconst csrf = require('csurf');\nconst rateLimit = require('express-rate-limit');\nconst express = require('express');\nconst app = express();\napp.use(helmet()); // CSP protection\napp.use(csrf()); // CSRF protection\nconst limiter = rateLimit({ windowMs: 60000, max: 100 }); // rate-limit\napp.use(limiter);\napp.get('/', (req, res) => res.send('hi'));\napp.listen(3000);";
    const result = await applySecurityPolicies({
      filePath: 'app.js',
      content: expressContent,
      askClaude: async () => patch,
    });
    assert.equal(result.ok, true);
    assert.ok(result.patch);
    assert.equal(result.patch.path, 'app.js');
    assert.ok(result.patch.policies.length > 0);
  });

  it('returns already-secured reason when all policies present', async () => {
    const secured = "const helmet = require('helmet'); const csrf = require('csrf'); const rateLimit = require('express-rate-limit'); app.use(helmet()); app.use(csrf()); app.use(rateLimit({}));";
    const result = await applySecurityPolicies({
      filePath: 'app.js',
      content: secured,
      askClaude: async () => { throw new Error('should not be called'); },
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'already-secured');
  });

  it('returns ok=false when Claude responds SKIP', async () => {
    const result = await applySecurityPolicies({
      filePath: 'app.js',
      content: expressContent,
      askClaude: async () => 'SKIP',
    });
    assert.equal(result.ok, false);
    assert.ok(result.reason.includes('not unit-testable') || result.reason.includes('safely patch') || result.reason.includes('Claude'));
  });

  it('throws when Claude throws (propagates for orchestrator errors[])', async () => {
    await assert.rejects(
      () => applySecurityPolicies({
        filePath: 'app.js',
        content: expressContent,
        askClaude: async () => { throw new Error('network timeout'); },
      }),
      /network timeout/
    );
  });

  it('strips code fences from Claude response', async () => {
    const patch = "```javascript\nconst helmet = require('helmet');\napp.use(helmet());\n```";
    const result = await applySecurityPolicies({
      filePath: 'app.js',
      content: expressContent,
      askClaude: async () => patch,
    });
    assert.equal(result.ok, true);
    assert.ok(!result.patch.content.startsWith('```'));
  });
});

// ─── generateSecurityPatches ──────────────────────────────────────────────────

describe('generateSecurityPatches', () => {
  const makeFile = (filePath, content = "const express = require('express');\nconst app = express();\napp.listen(3000);") =>
    ({ filePath, content });

  const goodPatch = "const helmet = require('helmet');\nconst csrf = require('csurf');\nconst rateLimit = require('express-rate-limit');\nconst express = require('express');\nconst app = express();\napp.use(helmet());\napp.use(csrf());\nconst limiter = rateLimit({ windowMs: 60000, max: 100 });\napp.use(limiter);\napp.listen(3000);";

  it('patches an unprotected entry-point file', async () => {
    const result = await generateSecurityPatches({
      sourceFiles: [makeFile('app.js')],
      askClaude: async () => goodPatch,
    });
    assert.equal(result.patches.length, 1);
    assert.equal(result.totalApplied, 1);
    assert.equal(result.errors.length, 0);
  });

  it('skips files that are not entry points', async () => {
    const result = await generateSecurityPatches({
      sourceFiles: [makeFile('utils.js'), makeFile('helpers/format.js')],
      askClaude: async () => goodPatch,
    });
    assert.equal(result.patches.length, 0);
    assert.ok(result.skipped.some(s => s.reason === 'no-entry-points-found'));
  });

  it('skips files that are already secured', async () => {
    const secured = "const helmet = require('helmet'); const csrf = require('csrf'); const rateLimit = require('express-rate-limit'); app.use(helmet()); app.use(csrf()); app.use(rateLimit({}));";
    const result = await generateSecurityPatches({
      sourceFiles: [makeFile('app.js', secured)],
      askClaude: async () => { throw new Error('should not be called'); },
    });
    assert.equal(result.patches.length, 0);
    assert.ok(result.skipped.some(s => s.reason === 'already-secured'));
  });

  it('skips files larger than MAX_FILE_BYTES', async () => {
    const bigContent = 'x'.repeat(85 * 1024);
    const result = await generateSecurityPatches({
      sourceFiles: [makeFile('app.js', bigContent)],
      askClaude: async () => goodPatch,
    });
    assert.equal(result.patches.length, 0);
  });

  it('respects maxFiles cap and reports deferred in skipped', async () => {
    const files = [
      makeFile('app.js'),
      makeFile('server.js'),
      makeFile('index.js'),
      makeFile('middleware.ts'),
    ];
    const result = await generateSecurityPatches({
      sourceFiles: files,
      askClaude: async () => goodPatch,
      maxFiles: 2,
    });
    assert.ok(result.patches.length <= 2);
    const deferred = result.skipped.find(s => s.reason && s.reason.startsWith('deferred:'));
    assert.ok(deferred, 'should have a deferred skip entry');
  });

  it('captures per-file errors without aborting the whole run', async () => {
    let calls = 0;
    const partialClaude = async () => {
      calls++;
      if (calls === 1) throw new Error('API timeout');
      return goodPatch;
    };
    const result = await generateSecurityPatches({
      sourceFiles: [makeFile('app.js'), makeFile('server.js')],
      askClaude: partialClaude,
    });
    assert.equal(result.errors.length, 1);
    assert.ok(result.errors[0].includes('API timeout'));
  });

  it('includes a human-readable summary', async () => {
    const result = await generateSecurityPatches({
      sourceFiles: [makeFile('app.js')],
      askClaude: async () => goodPatch,
    });
    assert.ok(typeof result.summary === 'string');
    assert.ok(result.summary.length > 0);
  });

  it('exports MAX_FILES_PER_RUN constant', () => {
    assert.equal(typeof MAX_FILES_PER_RUN, 'number');
    assert.ok(MAX_FILES_PER_RUN > 0);
  });
});
