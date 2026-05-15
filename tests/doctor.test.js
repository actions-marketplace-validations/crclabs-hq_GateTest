// =============================================================================
// DOCTOR TEST — src/core/doctor.js
// =============================================================================
// Diagnostic command that audits every prerequisite for auto-fix to work
// and reports them in plain English. Tests cover the pure-function helpers
// (workflow inspector, env-var detection) plus the renderer output shape.
// =============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runDoctor, renderDoctor, inspectGateWorkflow } = require('../src/core/doctor');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gt-doctor-'));
}

describe('inspectGateWorkflow', () => {
  it('returns present:false when no workflow file exists', () => {
    const d = tmp();
    try {
      const r = inspectGateWorkflow(d);
      assert.equal(r.present, false);
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('detects the current workflow with --auto-pr', () => {
    const d = tmp();
    try {
      fs.mkdirSync(path.join(d, '.github/workflows'), { recursive: true });
      fs.writeFileSync(
        path.join(d, '.github/workflows/gatetest-gate.yml'),
        'name: gate\njobs:\n  fix:\n    run: gatetest --suite quick --auto-pr\n'
      );
      const r = inspectGateWorkflow(d);
      assert.equal(r.present, true);
      assert.equal(r.hasAutoPrFlag, true);
      assert.equal(r.hasLegacyFix, false);
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('detects the legacy workflow with --fix only', () => {
    const d = tmp();
    try {
      fs.mkdirSync(path.join(d, '.github/workflows'), { recursive: true });
      fs.writeFileSync(
        path.join(d, '.github/workflows/gatetest-gate.yml'),
        'name: gate\njobs:\n  fix:\n    run: gatetest --suite quick --fix\n'
      );
      const r = inspectGateWorkflow(d);
      assert.equal(r.present, true);
      assert.equal(r.hasAutoPrFlag, false);
      assert.equal(r.hasLegacyFix, true);
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('reports the resolved path so the customer knows which file to edit', () => {
    const d = tmp();
    try {
      fs.mkdirSync(path.join(d, '.github/workflows'), { recursive: true });
      fs.writeFileSync(path.join(d, '.github/workflows/gatetest-gate.yml'), 'name: gate\n');
      const r = inspectGateWorkflow(d);
      assert.equal(r.path, '.github/workflows/gatetest-gate.yml');
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('runDoctor — full sweep', () => {
  it('runs without throwing and returns a structured result', async () => {
    const result = await runDoctor({
      projectRoot: process.cwd(),
      probeAnthropic: false,
    });
    assert.ok(Array.isArray(result.lines));
    assert.ok(typeof result.summary === 'object');
    assert.ok(typeof result.summary.ok === 'number');
    assert.ok(typeof result.summary.warn === 'number');
    assert.ok(typeof result.summary.bad === 'number');
    assert.ok(typeof result.projectRoot === 'string');
  });

  it('reports an "ok" for Node version on modern engines', async () => {
    const result = await runDoctor({ projectRoot: process.cwd(), probeAnthropic: false });
    const nodeLine = result.lines.find((l) => l.line.includes('Node.js'));
    assert.ok(nodeLine);
    assert.equal(nodeLine.kind, 'ok'); // We run on ≥20 in this test
  });

  it('reports an explicit error when ANTHROPIC_API_KEY is missing', async () => {
    const originalKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const result = await runDoctor({ projectRoot: process.cwd(), probeAnthropic: false });
      const apiLine = result.lines.find((l) => l.line.includes('ANTHROPIC_API_KEY'));
      assert.ok(apiLine);
      assert.equal(apiLine.kind, 'bad');
      assert.match(apiLine.fix, /export ANTHROPIC_API_KEY/);
      assert.match(apiLine.fix, /console\.anthropic\.com/);
    } finally {
      if (originalKey !== undefined) process.env.ANTHROPIC_API_KEY = originalKey;
    }
  });

  it('reports a warning when ANTHROPIC_API_KEY has wrong prefix', async () => {
    const originalKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'wrong-prefix-key';
    try {
      const result = await runDoctor({ projectRoot: process.cwd(), probeAnthropic: false });
      const apiLine = result.lines.find((l) => l.line.includes('ANTHROPIC_API_KEY'));
      assert.ok(apiLine);
      assert.equal(apiLine.kind, 'warn');
      assert.match(apiLine.line, /sk-ant-/);
    } finally {
      if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = originalKey;
    }
  });

  it('reports info (not warn/bad) when GLUECRON_API_TOKEN is unset', async () => {
    const originalToken = process.env.GLUECRON_API_TOKEN;
    delete process.env.GLUECRON_API_TOKEN;
    try {
      const result = await runDoctor({ projectRoot: process.cwd(), probeAnthropic: false });
      const glcLine = result.lines.find((l) => l.line.includes('GLUECRON_API_TOKEN'));
      assert.ok(glcLine);
      assert.equal(glcLine.kind, 'info');
    } finally {
      if (originalToken !== undefined) process.env.GLUECRON_API_TOKEN = originalToken;
    }
  });

  it('returns summary counts that match the line kinds', async () => {
    const result = await runDoctor({ projectRoot: process.cwd(), probeAnthropic: false });
    const counted = { ok: 0, warn: 0, bad: 0 };
    for (const l of result.lines) {
      if (counted[l.kind] !== undefined) counted[l.kind] += 1;
    }
    assert.equal(counted.ok, result.summary.ok);
    assert.equal(counted.warn, result.summary.warn);
    assert.equal(counted.bad, result.summary.bad);
  });
});

describe('renderDoctor', () => {
  it('produces a non-empty string', async () => {
    const result = await runDoctor({ projectRoot: process.cwd(), probeAnthropic: false });
    const out = renderDoctor(result);
    assert.ok(typeof out === 'string');
    assert.ok(out.length > 100);
  });

  it('includes the GATETEST DOCTOR header', async () => {
    const result = await runDoctor({ projectRoot: process.cwd(), probeAnthropic: false });
    const out = renderDoctor(result);
    assert.match(out, /GATETEST DOCTOR/);
  });

  it('shows the action-needed banner when errors exist', async () => {
    const originalKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const result = await runDoctor({ projectRoot: process.cwd(), probeAnthropic: false });
      const out = renderDoctor(result);
      // Strip ANSI codes for the assertion
      const plain = out.replace(/\x1b\[\d+m/g, '');
      assert.match(plain, /error\(s\)/);
    } finally {
      if (originalKey !== undefined) process.env.ANTHROPIC_API_KEY = originalKey;
    }
  });
});
