// ============================================================================
// SELECTABLE-FINDINGS TEST — Phase 6.1.2 of THE 100-MOVES MASTER PLAN
// ============================================================================
// Pure-function coverage for the per-finding selection logic that powers
// the FixSelectionPanel UI. The killer test is the IssueInput shape:
// the selection MUST convert cleanly into the payload /api/scan/fix
// accepts, with unfixable findings defensively dropped even if selected.
// ============================================================================

const { describe, it, test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const {
  SEVERITY_ORDER,
  classifySeverity,
  parseSelectableFinding,
  buildSelectableFindings,
  groupSelectableByFile,
  countSelectable,
  selectionForFilter,
  selectionToIssueInputs,
  selectionCtaLabel,
} = require(path.resolve(
  __dirname, '..', 'website', 'app', 'lib', 'selectable-findings.js'
));

// ---------- shape ----------

test('SEVERITY_ORDER is the canonical error→warning→info order', () => {
  assert.deepStrictEqual(SEVERITY_ORDER, ['error', 'warning', 'info']);
});

// ---------- classifySeverity ----------

describe('classifySeverity (mirrors copy-formatters / FindingsPanel heuristic)', () => {
  it('explicit prefix wins', () => {
    assert.strictEqual(classifySeverity('error: x'), 'error');
    assert.strictEqual(classifySeverity('warning: x'), 'warning');
    assert.strictEqual(classifySeverity('info: x'), 'info');
  });

  it('keyword heuristic for unprefixed text', () => {
    assert.strictEqual(classifySeverity('hardcoded API key found'), 'error');
    assert.strictEqual(classifySeverity('package is deprecated'), 'warning');
    assert.strictEqual(classifySeverity('summary: scanned 50 files'), 'info');
  });

  it('defaults to warning for neutral / non-string input', () => {
    assert.strictEqual(classifySeverity('something neutral'), 'warning');
    assert.strictEqual(classifySeverity(null), 'warning');
    assert.strictEqual(classifySeverity(undefined), 'warning');
    assert.strictEqual(classifySeverity(42), 'warning');
  });
});

// ---------- parseSelectableFinding ----------

describe('parseSelectableFinding', () => {
  it('extracts file + line from "file.ts:42 — message"', () => {
    const f = parseSelectableFinding('src/foo.ts:42 — uses var', 'lint', 0);
    assert.strictEqual(f.file, 'src/foo.ts');
    assert.strictEqual(f.line, 42);
    assert.strictEqual(f.message, 'uses var');
    assert.strictEqual(f.fixable, true);
    assert.strictEqual(f.createFile, false);
    assert.strictEqual(f.id, 'lint-0');
    assert.strictEqual(f.module, 'lint');
  });

  it('extracts file:line:col format', () => {
    const f = parseSelectableFinding('src/foo.ts:42:7 — uses var', 'lint', 0);
    assert.strictEqual(f.file, 'src/foo.ts');
    assert.strictEqual(f.line, 42);
  });

  it('extracts file alone when no line', () => {
    const f = parseSelectableFinding('package.json: missing license field', 'licenses', 1);
    assert.strictEqual(f.file, 'package.json');
    assert.strictEqual(f.line, null);
    assert.strictEqual(f.message, 'missing license field');
    assert.strictEqual(f.fixable, true);
  });

  it('flips to CREATE_FILE marker when "missing X.md" pattern matches', () => {
    const f = parseSelectableFinding('repo missing README.md', 'documentation', 2);
    assert.strictEqual(f.file, 'README.md');
    assert.strictEqual(f.fixable, true);
    assert.strictEqual(f.createFile, true);
    assert.match(f.message, /^CREATE_FILE:/);
  });

  it('handles path-shaped CREATE_FILE matches (e.g. "missing config.gitignore")', () => {
    // Regex requires `<path>.<ext>` shape — bare ".gitignore" alone
    // is NOT matched (an honest limitation of the inherited AdminPanel
    // parser shape we mirror here). The toLowerCase==="gitignore"
    // collapse rewrites the matched path-tail so the route emits the
    // canonical leading-dot filename.
    const f = parseSelectableFinding('config missing example.gitignore', 'documentation', 3);
    assert.strictEqual(f.fixable, true);
    assert.strictEqual(f.createFile, true);
    assert.match(f.message, /^CREATE_FILE:/);
  });

  it('does NOT auto-classify bare ".gitignore" as fixable (documented limitation)', () => {
    const f = parseSelectableFinding('repo missing .gitignore', 'documentation', 4);
    // Honest: the regex needs a non-trivial path-prefix, so this stays
    // unfixable. Customers see it in the manual-review surface.
    assert.strictEqual(f.fixable, false);
  });

  it('marks pure-prose findings as unfixable', () => {
    const f = parseSelectableFinding('overall security posture is weak', 'security', 4);
    assert.strictEqual(f.file, null);
    assert.strictEqual(f.fixable, false);
    assert.strictEqual(f.createFile, false);
  });

  it('strips severity prefix from the message', () => {
    const f = parseSelectableFinding('error: src/x.ts:1 — leak', 'secrets', 5);
    assert.strictEqual(f.message, 'leak');
    assert.strictEqual(f.severity, 'error');
  });

  it('stable IDs by (module, index)', () => {
    const a = parseSelectableFinding('x', 'mod', 7);
    const b = parseSelectableFinding('y', 'mod', 7);
    assert.strictEqual(a.id, 'mod-7');
    assert.strictEqual(b.id, 'mod-7');
  });
});

// ---------- buildSelectableFindings ----------

describe('buildSelectableFindings', () => {
  it('returns [] for non-array / empty input', () => {
    assert.deepStrictEqual(buildSelectableFindings(), []);
    assert.deepStrictEqual(buildSelectableFindings(null), []);
    assert.deepStrictEqual(buildSelectableFindings([]), []);
  });

  it('only walks failed modules — passed/skipped modules contribute nothing', () => {
    const out = buildSelectableFindings([
      { name: 'lint', status: 'failed', details: ['src/a.ts:1 — uses var'] },
      { name: 'syntax', status: 'passed', details: [] },
      { name: 'security', status: 'skipped', details: ['something'] }, // skipped — ignored
    ]);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].module, 'lint');
  });

  it('flattens module.details into individual selectables', () => {
    const out = buildSelectableFindings([
      {
        name: 'lint', status: 'failed', details: [
          'src/a.ts:1 — uses var',
          'src/b.ts:2 — line too long',
          'package.json: missing license field',
        ],
      },
    ]);
    assert.strictEqual(out.length, 3);
    assert.strictEqual(out.every((f) => f.fixable), true);
  });
});

// ---------- groupSelectableByFile ----------

describe('groupSelectableByFile', () => {
  it('groups + sorts by error count desc, then warning count, then file name', () => {
    const findings = [
      { id: '1', module: 'm', severity: 'warning', file: 'b.ts', message: 'x', fixable: true },
      { id: '2', module: 'm', severity: 'error', file: 'a.ts', message: 'x', fixable: true },
      { id: '3', module: 'm', severity: 'error', file: 'a.ts', message: 'x', fixable: true },
      { id: '4', module: 'm', severity: 'warning', file: 'a.ts', message: 'x', fixable: true },
    ];
    const groups = groupSelectableByFile(findings);
    assert.strictEqual(groups[0][0], 'a.ts'); // 2 errors
    assert.strictEqual(groups[1][0], 'b.ts'); // 0 errors
  });

  it('sinks "(no file)" bucket to the bottom', () => {
    const findings = [
      { id: '1', module: 'm', severity: 'error', file: null, message: 'x', fixable: false },
      { id: '2', module: 'm', severity: 'warning', file: 'a.ts', message: 'x', fixable: true },
    ];
    const groups = groupSelectableByFile(findings);
    assert.strictEqual(groups[groups.length - 1][0], '(no file)');
  });
});

// ---------- countSelectable ----------

describe('countSelectable', () => {
  it('separates fixable vs unfixable + per-severity + per-module', () => {
    const findings = [
      { id: '1', module: 'lint', severity: 'error', file: 'a.ts', fixable: true },
      { id: '2', module: 'lint', severity: 'warning', file: 'b.ts', fixable: true },
      { id: '3', module: 'security', severity: 'error', file: null, fixable: false },
    ];
    const c = countSelectable(findings);
    assert.strictEqual(c.total, 3);
    assert.strictEqual(c.fixable, 2);
    assert.strictEqual(c.unfixable, 1);
    assert.strictEqual(c.error, 2);
    assert.strictEqual(c.warning, 1);
    assert.strictEqual(c.byModule.lint, 2);
    assert.strictEqual(c.byModule.security, 1);
  });

  it('returns zeros for empty input', () => {
    const c = countSelectable([]);
    assert.strictEqual(c.total, 0);
  });
});

// ---------- selectionForFilter ----------

describe('selectionForFilter', () => {
  const FINDINGS = [
    { id: '1', module: 'lint', severity: 'error', file: 'a.ts', fixable: true },
    { id: '2', module: 'lint', severity: 'warning', file: 'b.ts', fixable: true },
    { id: '3', module: 'lint', severity: 'error', file: null, fixable: false },
    { id: '4', module: 'security', severity: 'error', file: 'c.ts', fixable: true },
  ];

  it('selects all fixable when severity=all + module=all', () => {
    const sel = selectionForFilter(FINDINGS);
    assert.deepStrictEqual([...sel].sort(), ['1', '2', '4']);
  });

  it('respects severity filter', () => {
    const sel = selectionForFilter(FINDINGS, { severity: 'error' });
    assert.deepStrictEqual([...sel].sort(), ['1', '4']);
  });

  it('respects module filter', () => {
    const sel = selectionForFilter(FINDINGS, { module: 'security' });
    assert.deepStrictEqual([...sel], ['4']);
  });

  it('combines severity + module filters', () => {
    const sel = selectionForFilter(FINDINGS, { severity: 'error', module: 'security' });
    assert.deepStrictEqual([...sel], ['4']);
  });

  it('excludes unfixable by default', () => {
    const sel = selectionForFilter(FINDINGS, { severity: 'error' });
    assert.strictEqual(sel.has('3'), false, 'unfixable error must NOT auto-select');
  });

  it('includes unfixable when fixableOnly=false explicitly', () => {
    const sel = selectionForFilter(FINDINGS, { severity: 'error', fixableOnly: false });
    assert.strictEqual(sel.has('3'), true);
  });
});

// ---------- selectionToIssueInputs ----------

describe('selectionToIssueInputs', () => {
  const FINDINGS = [
    { id: '1', module: 'lint', severity: 'error', file: 'a.ts', message: 'no-var', fixable: true },
    { id: '2', module: 'lint', severity: 'warning', file: 'b.ts', message: 'too-long', fixable: true },
    { id: '3', module: 'security', severity: 'error', file: null, message: 'prose', fixable: false },
  ];

  it('converts selection into IssueInput[]', () => {
    const sel = new Set(['1', '2']);
    const out = selectionToIssueInputs(FINDINGS, sel);
    assert.deepStrictEqual(out, [
      { file: 'a.ts', issue: 'no-var', module: 'lint' },
      { file: 'b.ts', issue: 'too-long', module: 'lint' },
    ]);
  });

  it('defensively drops unfixable selections (defence-in-depth)', () => {
    const sel = new Set(['1', '3']);
    const out = selectionToIssueInputs(FINDINGS, sel);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].file, 'a.ts');
  });

  it('returns [] for missing / non-Set selectedIds', () => {
    assert.deepStrictEqual(selectionToIssueInputs(FINDINGS, null), []);
    assert.deepStrictEqual(selectionToIssueInputs(FINDINGS, 'not a set'), []);
  });

  it('returns [] for non-array findings', () => {
    assert.deepStrictEqual(selectionToIssueInputs(null, new Set(['1'])), []);
  });
});

// ---------- selectionCtaLabel ----------

describe('selectionCtaLabel', () => {
  it('renders the right plural and zero-state', () => {
    assert.strictEqual(selectionCtaLabel(0), 'Pick at least one finding to fix');
    assert.strictEqual(selectionCtaLabel(1), 'Fix 1 selected finding with AI');
    assert.strictEqual(selectionCtaLabel(12), 'Fix 12 selected findings with AI');
  });

  it('coerces non-numbers to 0', () => {
    assert.strictEqual(selectionCtaLabel(null), 'Pick at least one finding to fix');
    assert.strictEqual(selectionCtaLabel('many'), 'Pick at least one finding to fix');
  });
});
