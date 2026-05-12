// ============================================================================
// COPY-FORMATTERS TEST — pure-function coverage for the bulk-copy helpers
// ============================================================================
// Backs the universal-copy UX shipped across FindingsPanel and
// LiveScanTerminal. The shape these functions emit is what the customer
// pastes into Slack / Linear / Cursor / Claude — if it ever drifts to
// something unparseable, this test catches it before customers do.
// ============================================================================

const { describe, it, test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const {
  formatFindingsAsMarkdown,
  formatFindingAsLine,
  formatScanTranscript,
  defaultPrefixFor,
} = require(path.resolve(
  __dirname, '..', 'website', 'app', 'lib', 'copy-formatters.js'
));

// ---------- formatFindingsAsMarkdown ----------

describe('formatFindingsAsMarkdown', () => {
  it('returns empty string for empty / non-array input', () => {
    assert.strictEqual(formatFindingsAsMarkdown({ findings: [] }), '');
    assert.strictEqual(formatFindingsAsMarkdown({ findings: null }), '');
    assert.strictEqual(formatFindingsAsMarkdown({}), '');
    assert.strictEqual(formatFindingsAsMarkdown(null), '');
  });

  it('produces a markdown checklist with H1, repo line, and checkbox rows', () => {
    const out = formatFindingsAsMarkdown({
      findings: [
        { severity: 'error', module: 'lint', file: 'src/foo.ts', line: 12, message: 'uses var' },
        { severity: 'warning', module: 'secrets', file: 'src/api.ts', line: 1, message: 'placeholder secret' },
      ],
      repoUrl: 'https://github.com/o/r',
    });
    assert.match(out, /^# GateTest findings — 2/);
    assert.match(out, /Repo: https:\/\/github\.com\/o\/r/);
    assert.match(out, /- \[ \] \*\*ERROR\*\* `lint` `src\/foo\.ts:12` — uses var/);
    assert.match(out, /- \[ \] \*\*WARNING\*\* `secrets` `src\/api\.ts:1` — placeholder secret/);
  });

  it('shows "X of Y" header when totalCount differs from findings.length (filtered view)', () => {
    const out = formatFindingsAsMarkdown({
      findings: [{ severity: 'error', module: 'lint', file: 'a.ts', line: 1, message: 'x' }],
      totalCount: 47,
    });
    assert.match(out, /^# GateTest findings — 1 of 47/);
  });

  it('omits "of N" when totalCount equals findings.length', () => {
    const out = formatFindingsAsMarkdown({
      findings: [{ severity: 'error', module: 'lint', file: 'a.ts', line: 1, message: 'x' }],
      totalCount: 1,
    });
    assert.match(out, /^# GateTest findings — 1\n/);
    assert.doesNotMatch(out, /of/);
  });

  it('honors a custom title override', () => {
    const out = formatFindingsAsMarkdown({
      findings: [{ severity: 'error', module: 'm', file: 'a', message: 'x' }],
      title: 'Top issues from sweep',
    });
    assert.match(out, /^# Top issues from sweep/);
    assert.doesNotMatch(out, /GateTest findings/);
  });

  it('handles findings missing fields gracefully', () => {
    const out = formatFindingsAsMarkdown({
      findings: [
        { message: 'no severity, no module, no file' },
        { severity: 'error', module: 'lint', message: 'no file' },
      ],
    });
    // Both rows render — no crash
    assert.match(out, /\*\*FINDING\*\*/); // default severity
    assert.match(out, /`unknown`/); // default module
    assert.match(out, /no severity, no module, no file/);
    assert.match(out, /no file/);
  });

  it('skips null entries inside the array (defensive)', () => {
    const out = formatFindingsAsMarkdown({
      findings: [
        null,
        { severity: 'error', module: 'lint', file: 'a.ts', message: 'real' },
        undefined,
      ],
    });
    assert.match(out, /real/);
    // The header counts ALL findings (caller's job to filter); we just
    // shouldn't crash on null entries.
    assert.match(out, /^# GateTest findings — 3\b/);
  });

  it('omits the file ref when no file present', () => {
    const out = formatFindingsAsMarkdown({
      findings: [{ severity: 'warning', module: 'docs', message: 'missing README' }],
    });
    assert.doesNotMatch(out, /``/);
    assert.match(out, /\*\*WARNING\*\* `docs` — missing README/);
  });
});

// ---------- formatFindingAsLine ----------

describe('formatFindingAsLine', () => {
  it('returns one-line "[SEVERITY] module file:line — message"', () => {
    const out = formatFindingAsLine({
      severity: 'error', module: 'lint', file: 'src/foo.ts', line: 12, message: 'uses var',
    });
    assert.strictEqual(out, '[ERROR] lint src/foo.ts:12 — uses var');
  });

  it('handles missing file', () => {
    const out = formatFindingAsLine({
      severity: 'warning', module: 'docs', message: 'missing readme',
    });
    assert.strictEqual(out, '[WARNING] docs — missing readme');
  });

  it('handles missing line (file but no line)', () => {
    const out = formatFindingAsLine({
      severity: 'info', module: 'syntax', file: 'package.json', message: 'ok',
    });
    assert.strictEqual(out, '[INFO] syntax package.json — ok');
  });

  it('returns empty string for null input (defensive)', () => {
    assert.strictEqual(formatFindingAsLine(null), '');
    assert.strictEqual(formatFindingAsLine(undefined), '');
  });

  it('coerces missing severity / module to safe defaults', () => {
    const out = formatFindingAsLine({ message: 'lone msg' });
    assert.strictEqual(out, '[FINDING] unknown — lone msg');
  });
});

// ---------- formatScanTranscript ----------

describe('formatScanTranscript', () => {
  it('returns empty string for empty / non-array logs', () => {
    assert.strictEqual(formatScanTranscript({ logs: [] }), '');
    assert.strictEqual(formatScanTranscript({ logs: null }), '');
    assert.strictEqual(formatScanTranscript({}), '');
  });

  it('renders default prefixes for known types', () => {
    const out = formatScanTranscript({
      logs: [
        { type: 'cmd', message: 'gatetest --suite full' },
        { type: 'info', message: 'starting scan' },
        { type: 'success', message: 'lint passed' },
        { type: 'error', message: 'secrets failed' },
        { type: 'warn', message: 'deprecated dep' },
      ],
    });
    assert.match(out, /\$ gatetest --suite full/);
    assert.match(out, /OK\s+lint passed/);
    assert.match(out, /ERROR\s+secrets failed/);
    assert.match(out, /WARN\s+deprecated dep/);
  });

  it('prefixes the optional command as a comment header', () => {
    const out = formatScanTranscript({
      logs: [{ type: 'progress', message: 'started' }],
      command: 'gatetest --suite full --fix o/r',
    });
    assert.match(out, /^# gatetest --suite full --fix o\/r\n\nINFO\s+started/);
  });

  it('honors an injected prefixFor (component-specific prefix scheme)', () => {
    const out = formatScanTranscript({
      logs: [{ type: 'success', message: 'done' }],
      prefixFor: (t) => `[${t}] `,
    });
    assert.strictEqual(out, '[success] done');
  });

  it('skips null log entries defensively', () => {
    const out = formatScanTranscript({
      logs: [null, { type: 'info', message: 'survived' }, undefined],
    });
    assert.match(out, /survived/);
  });
});

// ---------- defaultPrefixFor ----------

describe('defaultPrefixFor', () => {
  test('every recognised log type has a prefix', () => {
    for (const type of ['error', 'warn', 'warning', 'success', 'progress', 'cmd']) {
      const p = defaultPrefixFor(type);
      assert.strictEqual(typeof p, 'string');
      assert.ok(p.length > 0, `prefix for ${type} must be non-empty`);
    }
  });

  test('unknown types fall through to whitespace prefix (parseable indent)', () => {
    const p = defaultPrefixFor('something-new');
    assert.match(p, /^\s+$/);
  });
});
