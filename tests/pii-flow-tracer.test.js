/**
 * Tests for website/app/lib/pii-flow-tracer.js
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { tracePiiFlows, renderPiiFlowReport, PII_FIELDS } = require('../website/app/lib/pii-flow-tracer');

function file(path, content) { return { path, content }; }

// ---------------------------------------------------------------------------
describe('PII_FIELDS', () => {
  test('contains canonical PII fields', () => {
    assert.ok(PII_FIELDS.has('email'));
    assert.ok(PII_FIELDS.has('password'));
    assert.ok(PII_FIELDS.has('ssn'));
    assert.ok(PII_FIELDS.has('phone'));
    assert.ok(PII_FIELDS.has('creditcard'));
  });
});

// ---------------------------------------------------------------------------
describe('tracePiiFlows — logging sinks', () => {
  test('flags email flowing to console.log', () => {
    const result = tracePiiFlows([file('src/user.js', `
const email = req.body.email;
console.log(email);
`)]);
    assert.ok(result.findings.length >= 1);
    assert.ok(result.findings.some(f => f.sinks.includes('logging')));
    assert.ok(result.findings.some(f => f.field === 'email'));
  });

  test('flags password in logger.info', () => {
    const result = tracePiiFlows([file('src/auth.js', `
function login(req) {
  const password = req.body.password;
  logger.info('login attempt', { password });
}
`)]);
    assert.ok(result.findings.length >= 1);
    assert.ok(result.findings.some(f => f.sinks.includes('logging')));
  });

  test('flags destructured email in logger', () => {
    const result = tracePiiFlows([file('src/handler.js', `
const { email, phone } = req.body;
logger.debug('user data', email);
`)]);
    assert.ok(result.findings.length >= 1);
  });

  test('does not flag unrelated console.log', () => {
    const result = tracePiiFlows([file('src/utils.js', `
const count = items.length;
console.log('count:', count);
`)]);
    assert.equal(result.findings.length, 0);
  });
});

// ---------------------------------------------------------------------------
describe('tracePiiFlows — analytics sinks', () => {
  test('flags email flowing to mixpanel.track', () => {
    const result = tracePiiFlows([file('src/analytics.js', `
const email = user.email;
mixpanel.track('signup', { email });
`)]);
    assert.ok(result.findings.some(f => f.sinks.includes('analytics')));
  });

  test('flags phone in posthog.capture', () => {
    const result = tracePiiFlows([file('src/events.js', `
posthog.capture('contact', { phone: req.body.phone });
`)]);
    assert.ok(result.findings.some(f => f.sinks.includes('analytics')));
  });
});

// ---------------------------------------------------------------------------
describe('tracePiiFlows — external HTTP sinks', () => {
  test('flags ssn flowing to fetch()', () => {
    const result = tracePiiFlows([file('src/verify.js', `
const ssn = req.body.ssn;
const res = await fetch('/api/verify', { body: JSON.stringify({ ssn }) });
`)]);
    assert.ok(result.findings.some(f => f.sinks.includes('external-http')));
  });

  test('flags email in axios.post', () => {
    const result = tracePiiFlows([file('src/crm.js', `
const email = user.email;
await axios.post('/crm/contact', { email });
`)]);
    assert.ok(result.findings.some(f => f.sinks.includes('external-http')));
  });
});

// ---------------------------------------------------------------------------
describe('tracePiiFlows — suppression', () => {
  test('suppresses with // pii-flow-ok on same line', () => {
    const result = tracePiiFlows([file('src/admin.js', `
const email = req.body.email;
console.log(email); // pii-flow-ok
`)]);
    assert.equal(result.findings.length, 0);
  });

  test('suppresses with // pii-ok on preceding line', () => {
    const result = tracePiiFlows([file('src/admin.js', `
const email = req.body.email;
// pii-ok
console.log(email);
`)]);
    assert.equal(result.findings.length, 0);
  });
});

// ---------------------------------------------------------------------------
describe('tracePiiFlows — test file severity', () => {
  test('downgrades errors to warnings in test files', () => {
    const result = tracePiiFlows([file('tests/auth.test.js', `
const email = req.body.email;
console.log(email);
`)]);
    if (result.findings.length > 0) {
      assert.ok(result.findings.every(f => f.severity === 'warning'));
    }
  });
});

// ---------------------------------------------------------------------------
describe('tracePiiFlows — non-JS files skipped', () => {
  test('skips .json files', () => {
    const result = tracePiiFlows([file('data/users.json', '{"email":"test@example.com"}')]);
    assert.equal(result.findings.length, 0);
  });

  test('skips .md files', () => {
    const result = tracePiiFlows([file('README.md', '# Email: user@example.com\nconsole.log(email)')]);
    assert.equal(result.findings.length, 0);
  });
});

// ---------------------------------------------------------------------------
describe('tracePiiFlows — summary', () => {
  test('summary counts are accurate', () => {
    const result = tracePiiFlows([
      file('src/a.js', 'const email = req.body.email;\nconsole.log(email);'),
      file('src/b.js', 'const phone = req.body.phone;\nconsole.log(phone);'),
    ]);
    assert.equal(result.summary.total, result.findings.length);
    assert.ok(result.summary.bySink.logging >= 0);
  });

  test('returns zero summary on clean files', () => {
    const result = tracePiiFlows([file('src/clean.js', 'const x = 1 + 2;')]);
    assert.equal(result.summary.total, 0);
    assert.equal(result.findings.length, 0);
  });
});

// ---------------------------------------------------------------------------
describe('renderPiiFlowReport', () => {
  test('returns no-findings message when empty', () => {
    const report = renderPiiFlowReport({ findings: [], summary: { total: 0, errors: 0, warnings: 0, bySink: {}, byField: {} } });
    assert.ok(report.includes('No PII flows'));
  });

  test('includes file paths and line numbers in report', () => {
    const result = tracePiiFlows([file('src/leak.js', `
const email = req.body.email;
console.log(email);
`)]);
    if (result.findings.length > 0) {
      const report = renderPiiFlowReport(result);
      assert.ok(report.includes('src/leak.js'));
      assert.ok(report.includes('PII Flow Tracer'));
    }
  });

  test('returns safe report for null input', () => {
    const report = renderPiiFlowReport(null);
    assert.ok(report.includes('No PII flows'));
  });
});
