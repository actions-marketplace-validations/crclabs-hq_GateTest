// =============================================================================
// SCAN REDACTION TEST
// =============================================================================
// Verifies that file paths and line numbers are stripped from finding detail
// strings for scan-only tiers (quick / full) so customers cannot copy-paste
// findings into Claude to bypass the fix tier.
// Fix tiers (scan_fix / nuclear) receive full unredacted detail.
// =============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert');

// Mirror the redaction logic from website/app/api/scan/run/route.ts
// so changes to either must be kept in sync.
function redactDetailForTier(d, isFixTier) {
  if (isFixTier) return d;
  const stripped = d.replace(/^(?:error|warn(?:ing)?|info)\s*:\s*/i, '').trim();
  return stripped.replace(/^[A-Za-z0-9_./@\-+]+?\.[A-Za-z0-9]{1,8}(?::\d+(?::\d+)?)?\s*[-—:]\s*/, '');
}

function redactModulesForTier(modules, tier) {
  const isFixTier = tier === 'scan_fix' || tier === 'nuclear';
  if (isFixTier) return modules;
  return modules.map((m) => ({
    ...m,
    details: (m.details || []).map((d) => redactDetailForTier(d, false)),
  }));
}

// ---------------------------------------------------------------------------
// Redaction logic — detail string parsing
// ---------------------------------------------------------------------------

describe('scan redaction — detail string stripping', () => {
  it('strips file:line — message format', () => {
    const d = 'src/api/auth.js:42 — rejectUnauthorized: false';
    assert.strictEqual(redactDetailForTier(d, false), 'rejectUnauthorized: false');
  });

  it('strips file:line:col — message format', () => {
    const d = 'src/api/auth.js:42:8 — rejectUnauthorized: false';
    assert.strictEqual(redactDetailForTier(d, false), 'rejectUnauthorized: false');
  });

  it('strips file — message format (dash separator)', () => {
    const d = 'src/lib/payment.ts — parseFloat(price) on money variable';
    assert.strictEqual(redactDetailForTier(d, false), 'parseFloat(price) on money variable');
  });

  it('strips file: message format (colon separator)', () => {
    const d = 'config/database.js: hardcoded connection string';
    assert.strictEqual(redactDetailForTier(d, false), 'hardcoded connection string');
  });

  it('strips file:line: message (colon after line number)', () => {
    const d = '.env.example:5: placeholder value matches real credential shape';
    assert.strictEqual(redactDetailForTier(d, false), 'placeholder value matches real credential shape');
  });

  it('strips error: prefix before file path', () => {
    const d = 'error: src/hooks/useAuth.ts:18 — empty catch block swallows error';
    assert.strictEqual(redactDetailForTier(d, false), 'empty catch block swallows error');
  });

  it('strips warning: prefix before file path', () => {
    const d = 'warning: scripts/deploy.sh:99 — curl piped to sh without verification';
    assert.strictEqual(redactDetailForTier(d, false), 'curl piped to sh without verification');
  });

  it('strips warn: prefix (shortened)', () => {
    const d = 'warn: app/api/route.ts:15 — object dump in logger call';
    assert.strictEqual(redactDetailForTier(d, false), 'object dump in logger call');
  });

  it('leaves messages without file paths intact', () => {
    const d = 'No lockfile found — dependencies unpinned';
    assert.strictEqual(redactDetailForTier(d, false), 'No lockfile found — dependencies unpinned');
  });

  it('leaves repo: missing messages intact (no file-path shape)', () => {
    const d = 'repo: missing .env.example';
    assert.strictEqual(redactDetailForTier(d, false), 'repo: missing .env.example');
  });

  it('handles dotfiles correctly', () => {
    const d = '.github/workflows/ci.yml:49 — continue-on-error: true on gate step';
    assert.strictEqual(redactDetailForTier(d, false), 'continue-on-error: true on gate step');
  });

  it('handles scoped package paths', () => {
    const d = 'node_modules/@types/react/index.d.ts:1 — skipped';
    assert.strictEqual(redactDetailForTier(d, false), 'skipped');
  });
});

// ---------------------------------------------------------------------------
// Fix tiers — no redaction applied
// ---------------------------------------------------------------------------

describe('scan redaction — fix tiers pass through unmodified', () => {
  const detail = 'src/api/auth.js:42 — rejectUnauthorized: false';

  it('scan_fix tier returns full detail', () => {
    assert.strictEqual(redactDetailForTier(detail, true), detail);
  });

  it('nuclear tier returns full detail', () => {
    assert.strictEqual(redactDetailForTier(detail, true), detail);
  });
});

// ---------------------------------------------------------------------------
// Module-level redaction
// ---------------------------------------------------------------------------

describe('scan redaction — module array transformation', () => {
  const modules = [
    {
      name: 'secrets',
      status: 'failed',
      checks: 10,
      issues: 2,
      details: [
        'src/config/keys.js:5 — Hardcoded API key detected',
        'src/config/keys.js:12 — Stripe secret key exposed',
      ],
    },
    {
      name: 'lint',
      status: 'passed',
      checks: 50,
      issues: 0,
      details: [],
    },
  ];

  it('quick tier redacts file paths from details', () => {
    const result = redactModulesForTier(modules, 'quick');
    assert.strictEqual(result[0].details[0], 'Hardcoded API key detected');
    assert.strictEqual(result[0].details[1], 'Stripe secret key exposed');
  });

  it('full tier redacts file paths from details', () => {
    const result = redactModulesForTier(modules, 'full');
    assert.ok(!result[0].details[0].includes('src/config/keys.js'));
    assert.ok(!result[0].details[1].includes('src/config/keys.js'));
  });

  it('scan_fix tier preserves full file paths', () => {
    const result = redactModulesForTier(modules, 'scan_fix');
    assert.ok(result[0].details[0].includes('src/config/keys.js:5'));
    assert.ok(result[0].details[1].includes('src/config/keys.js:12'));
  });

  it('nuclear tier preserves full file paths', () => {
    const result = redactModulesForTier(modules, 'nuclear');
    assert.ok(result[0].details[0].includes('src/config/keys.js:5'));
  });

  it('modules without details are unaffected', () => {
    const result = redactModulesForTier(modules, 'quick');
    assert.deepStrictEqual(result[1].details, []);
  });

  it('non-details module fields are preserved (name, status, checks, issues)', () => {
    const result = redactModulesForTier(modules, 'quick');
    assert.strictEqual(result[0].name, 'secrets');
    assert.strictEqual(result[0].status, 'failed');
    assert.strictEqual(result[0].checks, 10);
    assert.strictEqual(result[0].issues, 2);
  });

  it('redacted detail contains the meaningful issue description', () => {
    const result = redactModulesForTier(modules, 'quick');
    assert.ok(result[0].details[0].length > 5, 'redacted detail should not be empty');
  });
});
