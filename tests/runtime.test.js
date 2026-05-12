/**
 * Tests for the GateTest Runtime Layer:
 * Monitor, Diagnostics, CacheManager, Healer, AlertRouter
 * plus deployContract and cacheHeaders static analysis modules.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-runtime-'));
  return dir;
}

function makeResult(name = 'test') {
  const checks = [];
  return {
    module: name,
    checks,
    addCheck(n, passed, details = {}) {
      checks.push({ name: n, passed, ...details });
    },
  };
}

// ── AlertRouter ───────────────────────────────────────────────────────────────

describe('AlertRouter', () => {
  const AlertRouter = require('../src/runtime/alerts');

  test('sends to console without crashing', async () => {
    const router = new AlertRouter({ silent: true });
    await assert.doesNotReject(() => router.warning('Test', 'body'));
  });

  test('writes to log file when configured', async () => {
    const tmp = makeTmp();
    const logFile = path.join(tmp, 'alerts.log');
    const router = new AlertRouter({ silent: true, logFile });
    await router.error('Title', 'Body');
    const content = fs.readFileSync(logFile, 'utf8');
    const entry = JSON.parse(content.trim());
    assert.equal(entry.level, 'error');
    assert.equal(entry.title, 'Title');
    fs.rmSync(tmp, { recursive: true });
  });

  test('respects minLevel — skips below threshold', async () => {
    const tmp = makeTmp();
    const logFile = path.join(tmp, 'alerts.log');
    const router = new AlertRouter({ silent: true, logFile, minLevel: 'error' });
    await router.info('Should not log', 'body');
    assert(!fs.existsSync(logFile), 'info should not be logged at error minLevel');
    fs.rmSync(tmp, { recursive: true });
  });

  test('handles webhook failure gracefully', async () => {
    const router = new AlertRouter({ silent: true, webhook: 'https://localhost:1/nonexistent', minLevel: 'info' });
    await assert.doesNotReject(() => router.info('Test', 'body'));
  });
});

// ── Diagnostics ───────────────────────────────────────────────────────────────

describe('Diagnostics', () => {
  const Diagnostics = require('../src/runtime/diagnostics');

  test('constructor creates instance with defaults', () => {
    const d = new Diagnostics();
    assert.equal(d.timeout, 15000);
    assert.equal(d.samples, 3);
  });

  test('constructor accepts custom options', () => {
    const d = new Diagnostics({ timeout: 5000, samples: 1 });
    assert.equal(d.timeout, 5000);
    assert.equal(d.samples, 1);
  });

  test('_stateFile returns deterministic path', () => {
    const tmpRoot = path.join(os.tmpdir(), 'gatetest-runtime-test');
    const d = new Diagnostics({ stateDir: tmpRoot });
    const f = d._stateFile('https://example.com/api/health');
    assert(f.startsWith(tmpRoot));
    assert(f.endsWith('.json'));
  });

  test('diagnose returns structured result object', async () => {
    const d = new Diagnostics({ timeout: 3000, samples: 1 });
    // Use a known-good public URL for a quick shape check
    // We use localhost:1 (refused) so it completes fast with errors — tests the shape not the network
    const r = await d.diagnose('http://127.0.0.1:19999/nonexistent');
    assert(typeof r.url === 'string');
    assert(typeof r.status === 'string');
    assert(Array.isArray(r.issues));
    assert(Array.isArray(r.actions));
    assert(typeof r.checks === 'object');
    assert(['healthy', 'warning', 'degraded', 'critical'].includes(r.status));
  });

  test('_buildActionPlan adds actions for site-down', () => {
    const d = new Diagnostics();
    const r = { issues: [{ code: 'site-down' }], actions: [], checks: {} };
    d._buildActionPlan(r);
    assert(r.actions.length > 0);
    assert(r.actions.some(a => a.includes('systemctl') || a.includes('server')));
  });

  test('_buildActionPlan adds actions for content-stale', () => {
    const d = new Diagnostics();
    const r = { issues: [{ code: 'content-stale' }], actions: [], checks: {} };
    d._buildActionPlan(r);
    assert(r.actions.some(a => a.includes('flush')));
  });

  test('_classifyBottleneck identifies compute bottleneck', () => {
    const d = new Diagnostics();
    const r = { issues: [], checks: { responseTime: { p50: 1200, p95: 1400 }, cache: {} } };
    d._classifyBottleneck(r);
    assert.equal(r.checks.bottleneck.classification, 'compute');
  });

  test('_classifyBottleneck identifies database bottleneck', () => {
    const d = new Diagnostics();
    const r = { issues: [], checks: { responseTime: { p50: 900, p95: 2500 }, cache: {} } };
    d._classifyBottleneck(r);
    assert.equal(r.checks.bottleneck.classification, 'database');
  });
});

// ── CacheManager ─────────────────────────────────────────────────────────────

describe('CacheManager', () => {
  const CacheManager = require('../src/runtime/cache-manager');

  test('constructor picks up env vars', () => {
    const cm = new CacheManager({ vercelToken: 'tok_test' });
    assert.equal(cm.vercelToken, 'tok_test');
  });

  test('_classifyStrategy identifies bypass', () => {
    const cm = new CacheManager();
    assert.equal(cm._classifyStrategy('no-store', {}), 'bypass');
  });

  test('_classifyStrategy identifies revalidate', () => {
    const cm = new CacheManager();
    assert.equal(cm._classifyStrategy('no-cache, max-age=0', {}), 'revalidate');
  });

  test('_classifyStrategy identifies cdn-cached via s-maxage', () => {
    const cm = new CacheManager();
    assert.equal(cm._classifyStrategy('public, s-maxage=3600', {}), 'cdn-cached');
  });

  test('_classifyStrategy identifies browser-cached', () => {
    const cm = new CacheManager();
    assert.equal(cm._classifyStrategy('public, max-age=86400', {}), 'browser-cached');
  });

  test('_manualInstructions returns useful steps', () => {
    const cm = new CacheManager();
    const steps = cm._manualInstructions('https://example.com');
    assert(steps.length > 0);
    assert(steps.some(s => s.includes('Vercel') || s.includes('Cloudflare')));
  });

  test('flush returns report structure with no API tokens', async () => {
    const cm = new CacheManager();
    const r = await cm.flush('http://127.0.0.1:19999/');
    assert(typeof r.url === 'string');
    assert(Array.isArray(r.actions));
    assert(Array.isArray(r.manualSteps));
    // No tokens → should have manual steps
    assert(r.manualSteps.length > 0);
  });
});

// ── Healer ───────────────────────────────────────────────────────────────────

describe('Healer', () => {
  const Healer = require('../src/runtime/healer');

  test('heal returns report structure', async () => {
    const h = new Healer({ dryRun: true });
    const r = await h.heal({ url: 'https://example.com', issues: [] });
    assert(typeof r.url === 'string');
    assert(Array.isArray(r.automated));
    assert(Array.isArray(r.manual));
    assert(Array.isArray(r.escalate));
  });

  test('heal adds no-action message for clean diagnostic', async () => {
    const h = new Healer({ dryRun: true });
    const r = await h.heal({ url: 'https://example.com', issues: [] });
    assert(r.automated.some(a => a.action === 'no-action'));
  });

  test('heal dry-runs cache flush for content-stale', async () => {
    const h = new Healer({ dryRun: true });
    const r = await h.heal({
      url: 'https://example.com',
      issues: [{ code: 'content-stale', message: 'Content stale' }],
      actions: [],
    });
    assert(r.automated.some(a => a.action === 'flush-cache' && a.dryRun));
  });

  test('heal escalates site-down when no hooks configured', async () => {
    const h = new Healer({ dryRun: false });
    const r = await h.heal({
      url: 'https://example.com',
      issues: [{ code: 'site-down', message: 'Down' }],
      actions: ['check server'],
    });
    assert(r.escalate.some(e => e.severity === 'critical'));
  });

  test('heal adds manual steps for slow', async () => {
    const h = new Healer({ dryRun: true });
    const r = await h.heal({
      url: 'https://example.com',
      issues: [{ code: 'slow', message: 'Slow' }],
      actions: [],
      checks: { bottleneck: { classification: 'database' } },
    });
    assert(r.manual.some(m => m.action === 'investigate-slow'));
  });
});

// ── Monitor ───────────────────────────────────────────────────────────────────

describe('Monitor', () => {
  const Monitor = require('../src/runtime/monitor');

  test('addTarget registers target', () => {
    const m = new Monitor({ silent: true });
    m.addTarget('https://example.com', { interval: 30 });
    assert.equal(m.targets.length, 1);
    assert.equal(m.targets[0].interval, 30000);
  });

  test('addTarget normalises URL without protocol', () => {
    const m = new Monitor({ silent: true });
    m.addTarget('example.com');
    assert(m.targets[0].url.startsWith('https://'));
  });

  test('state initialised for each target', () => {
    const m = new Monitor({ silent: true });
    m.addTarget('https://example.com');
    assert(m.state['https://example.com']);
    assert.equal(m.state['https://example.com'].consecutiveFails, 0);
  });
});

// ── deployContract module ─────────────────────────────────────────────────────

describe('deployContract module', () => {
  const DeployContractModule = require('../src/modules/deploy-contract');

  test('has correct name and description', () => {
    const m = new DeployContractModule();
    assert.equal(m.name, 'deployContract');
    assert(m.description.length > 0);
  });

  test('passes when no curl health-check calls found', async () => {
    const tmp = makeTmp();
    fs.writeFileSync(path.join(tmp, 'deploy.sh'), '#!/bin/bash\necho "deploying"');
    const m = new DeployContractModule();
    const result = makeResult();
    await m.run(result, { projectRoot: tmp });
    const infoCheck = result.checks.find(c => c.name === 'deploy-health-urls');
    assert(infoCheck, 'should have info check when no URLs found');
    assert.equal(infoCheck.passed, true);
    fs.rmSync(tmp, { recursive: true });
  });

  test('flags curl URL that has no matching route', async () => {
    const tmp = makeTmp();
    // Deploy script curls /health but no route exists
    fs.writeFileSync(path.join(tmp, 'deploy.sh'),
      '#!/bin/bash\ncurl -f http://localhost:3000/health || exit 1');
    const m = new DeployContractModule();
    const result = makeResult();
    await m.run(result, { projectRoot: tmp });
    const errorChecks = result.checks.filter(c => !c.passed && c.severity === 'error');
    assert(errorChecks.length > 0, 'should flag unmatched health-check URL');
    fs.rmSync(tmp, { recursive: true });
  });

  test('passes when curl URL matches an express route', async () => {
    const tmp = makeTmp();
    fs.writeFileSync(path.join(tmp, 'deploy.sh'),
      '#!/bin/bash\ncurl -f http://localhost:3000/health || exit 1');
    fs.mkdirSync(path.join(tmp, 'src'));
    fs.writeFileSync(path.join(tmp, 'src', 'server.js'),
      "app.get('/health', (req, res) => res.json({ ok: true }));");
    const m = new DeployContractModule();
    const result = makeResult();
    await m.run(result, { projectRoot: tmp });
    const errorChecks = result.checks.filter(c => !c.passed && c.severity === 'error');
    assert.equal(errorChecks.length, 0, 'should not flag when route exists');
    fs.rmSync(tmp, { recursive: true });
  });
});

// ── cacheHeaders module ───────────────────────────────────────────────────────

describe('cacheHeaders module', () => {
  const CacheHeadersModule = require('../src/modules/cache-headers');

  test('has correct name', () => {
    const m = new CacheHeadersModule();
    assert.equal(m.name, 'cacheHeaders');
  });

  test('no-ops cleanly on empty project', async () => {
    const tmp = makeTmp();
    const m = new CacheHeadersModule();
    const result = makeResult();
    await assert.doesNotReject(() => m.run(result, { projectRoot: tmp }));
    fs.rmSync(tmp, { recursive: true });
  });

  test('flags next.config without cache headers', async () => {
    const tmp = makeTmp();
    fs.writeFileSync(path.join(tmp, 'next.config.js'), 'module.exports = {};\n');
    const m = new CacheHeadersModule();
    const result = makeResult();
    await m.run(result, { projectRoot: tmp });
    const warnings = result.checks.filter(c => !c.passed && c.severity === 'warning');
    assert(warnings.some(w => w.name.includes('nextjs')), 'should warn on missing cache headers in next.config');
    fs.rmSync(tmp, { recursive: true });
  });

  test('passes next.config that has Cache-Control headers', async () => {
    const tmp = makeTmp();
    fs.writeFileSync(path.join(tmp, 'next.config.js'), `
      module.exports = {
        async headers() {
          return [{ source: '/_next/static/(.*)', headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }] }];
        }
      };
    `);
    const m = new CacheHeadersModule();
    const result = makeResult();
    await m.run(result, { projectRoot: tmp });
    const errorChecks = result.checks.filter(c => !c.passed && c.severity === 'error');
    assert.equal(errorChecks.length, 0);
    fs.rmSync(tmp, { recursive: true });
  });

  test('flags vercel.json without static cache headers', async () => {
    const tmp = makeTmp();
    fs.writeFileSync(path.join(tmp, 'vercel.json'), JSON.stringify({ version: 2 }));
    const m = new CacheHeadersModule();
    const result = makeResult();
    await m.run(result, { projectRoot: tmp });
    const warn = result.checks.find(c => c.name === 'vercel-no-static-cache');
    assert(warn, 'should warn on vercel.json without static cache');
    fs.rmSync(tmp, { recursive: true });
  });

  test('passes vercel.json with _next/static cache header', async () => {
    const tmp = makeTmp();
    fs.writeFileSync(path.join(tmp, 'vercel.json'), JSON.stringify({
      headers: [{ source: '/_next/static/(.*)', headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }] }],
    }));
    const m = new CacheHeadersModule();
    const result = makeResult();
    await m.run(result, { projectRoot: tmp });
    const passCheck = result.checks.find(c => c.name === 'vercel-static-cache');
    assert(passCheck?.passed, 'should pass when vercel.json has static cache headers');
    fs.rmSync(tmp, { recursive: true });
  });
});
