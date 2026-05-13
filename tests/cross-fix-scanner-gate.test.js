// ============================================================================
// CROSS-FIX SCANNER GATE TEST — Phase 1.2b of THE FIX-FIRST BUILD PLAN
// ============================================================================
// Covers website/app/lib/cross-fix-scanner-gate.js — the gate that runs
// the real scanner against the synthetic post-fix workspace and rolls
// back any fix that introduced a new finding. This is the cross-FILE
// safety net (the syntax gate is the per-FILE one).
//
// Tests inject a stub runTier so the algorithm can be exercised without
// touching real scanner modules.
// ============================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  validateFixesAgainstScanner,
  buildPostFixWorkspace,
  extractFileFromDetail,
  diffFindings,
  attributeFindings,
} = require('../website/app/lib/cross-fix-scanner-gate.js');

// ---------- buildPostFixWorkspace ----------

test('buildPostFixWorkspace — swaps fixed content into existing files', () => {
  const original = [
    { path: 'src/a.js', content: 'old-a' },
    { path: 'src/b.js', content: 'old-b' },
    { path: 'src/c.js', content: 'old-c' },
  ];
  const fixes = [{ file: 'src/b.js', fixed: 'new-b' }];
  const result = buildPostFixWorkspace(original, fixes);
  assert.deepEqual(result, [
    { path: 'src/a.js', content: 'old-a' },
    { path: 'src/b.js', content: 'new-b' },
    { path: 'src/c.js', content: 'old-c' },
  ]);
});

test('buildPostFixWorkspace — appends net-new files at end', () => {
  const original = [{ path: 'src/a.js', content: 'old-a' }];
  const fixes = [
    { file: 'src/a.js', fixed: 'new-a' },
    { file: 'src/d.js', fixed: 'brand-new-d' },
  ];
  const result = buildPostFixWorkspace(original, fixes);
  assert.equal(result.length, 2);
  assert.equal(result[0].content, 'new-a');
  assert.equal(result[1].path, 'src/d.js');
  assert.equal(result[1].content, 'brand-new-d');
});

test('buildPostFixWorkspace — empty inputs', () => {
  assert.deepEqual(buildPostFixWorkspace([], []), []);
  assert.deepEqual(buildPostFixWorkspace([{ path: 'a.js', content: 'a' }], []), [{ path: 'a.js', content: 'a' }]);
});

// ---------- extractFileFromDetail ----------

test('extractFileFromDetail — colon-separated path:line:msg', () => {
  assert.equal(extractFileFromDetail('src/foo.js:42: missing semicolon'), 'src/foo.js');
  assert.equal(extractFileFromDetail('package.json: invalid JSON'), 'package.json');
});

test('extractFileFromDetail — em-dash separator', () => {
  assert.equal(extractFileFromDetail('src/foo.js — broken JSON'), 'src/foo.js');
  assert.equal(extractFileFromDetail('src/foo.js - dash variant'), 'src/foo.js');
});

test('extractFileFromDetail — null when no path detected', () => {
  assert.equal(extractFileFromDetail('Module XYZ scanned 12 files'), null);
  assert.equal(extractFileFromDetail(''), null);
  assert.equal(extractFileFromDetail(null), null);
});

// ---------- diffFindings ----------

test('diffFindings — finds new entries per module', () => {
  const original = {
    syntax: ['a.js: missing brace'],
    secrets: [],
  };
  const post = {
    syntax: ['a.js: missing brace', 'b.js: stray token'],
    secrets: ['c.js: hardcoded API key'],
  };
  const newFindings = diffFindings(original, post);
  assert.equal(newFindings.length, 2);
  const detailsByModule = newFindings.reduce((acc, f) => {
    (acc[f.module] = acc[f.module] || []).push(f.detail);
    return acc;
  }, {});
  assert.deepEqual(detailsByModule.syntax, ['b.js: stray token']);
  assert.deepEqual(detailsByModule.secrets, ['c.js: hardcoded API key']);
});

test('diffFindings — no new findings when post matches original', () => {
  const findings = { syntax: ['a.js: x'], lint: ['b.js: y'] };
  assert.deepEqual(diffFindings(findings, findings), []);
});

test('diffFindings — module appears post-fix but not in original', () => {
  const original = {};
  const post = { newModule: ['x.js: brand new finding'] };
  const newFindings = diffFindings(original, post);
  assert.equal(newFindings.length, 1);
  assert.equal(newFindings[0].module, 'newModule');
});

// ---------- attributeFindings ----------

test('attributeFindings — attributes finding to its file when in fix set', () => {
  const newFindings = [
    { module: 'syntax', detail: 'src/a.js: stray token' },
    { module: 'lint', detail: 'src/b.js: unused import' },
  ];
  const fixedPaths = new Set(['src/a.js', 'src/b.js']);
  const { attributed, unattributed } = attributeFindings(newFindings, fixedPaths);
  assert.equal(attributed.size, 2);
  assert.deepEqual(attributed.get('src/a.js'), ['[syntax] src/a.js: stray token']);
  assert.deepEqual(attributed.get('src/b.js'), ['[lint] src/b.js: unused import']);
  assert.equal(unattributed.length, 0);
});

test('attributeFindings — unattributed when file not in fix set', () => {
  const newFindings = [
    { module: 'syntax', detail: 'src/never-fixed.js: error' },
  ];
  const fixedPaths = new Set(['src/a.js']);
  const { attributed, unattributed } = attributeFindings(newFindings, fixedPaths);
  assert.equal(attributed.size, 0);
  assert.equal(unattributed.length, 1);
});

test('attributeFindings — unattributed when no path in detail', () => {
  const newFindings = [
    { module: 'codeQuality', detail: 'Module summary: 0 checks performed' },
  ];
  const { attributed, unattributed } = attributeFindings(newFindings, new Set(['src/a.js']));
  assert.equal(attributed.size, 0);
  assert.equal(unattributed.length, 1);
});

test('attributeFindings — multiple findings per file aggregate', () => {
  const newFindings = [
    { module: 'syntax', detail: 'src/a.js: error 1' },
    { module: 'lint',   detail: 'src/a.js: error 2' },
  ];
  const fixedPaths = new Set(['src/a.js']);
  const { attributed } = attributeFindings(newFindings, fixedPaths);
  assert.equal(attributed.get('src/a.js').length, 2);
});

// ---------- validateFixesAgainstScanner (orchestrator) ----------

function makeStubRunTier(modulesByTier) {
  return async (tier, ctx) => {
    void ctx; // unused in stub
    return { modules: modulesByTier[tier] || [], totalIssues: 0 };
  };
}

test('validateFixesAgainstScanner — empty fix set returns trivial result', async () => {
  const result = await validateFixesAgainstScanner({
    fixes: [],
    originalFileContents: [],
    originalFindingsByModule: {},
    runTier: async () => ({ modules: [], totalIssues: 0 }),
    owner: 'x', repo: 'y',
  });
  assert.equal(result.accepted.length, 0);
  assert.equal(result.rolledBack.length, 0);
  assert.match(result.summary, /0 fixes, nothing to validate/);
});

test('validateFixesAgainstScanner — clean re-scan accepts all fixes', async () => {
  const fixes = [{ file: 'src/a.js', fixed: 'good code', original: 'old', issues: ['i'] }];
  const original = [{ path: 'src/a.js', content: 'old' }];
  const originalFindings = { syntax: [] };
  const runTier = makeStubRunTier({ full: [{ name: 'syntax', details: [] }] });
  const result = await validateFixesAgainstScanner({
    fixes, originalFileContents: original, originalFindingsByModule: originalFindings,
    runTier, owner: 'x', repo: 'y',
  });
  assert.equal(result.accepted.length, 1);
  assert.equal(result.rolledBack.length, 0);
  assert.match(result.summary, /1 fix validated, no regressions/);
});

test('validateFixesAgainstScanner — rolls back fix that introduces new finding', async () => {
  const fixes = [
    { file: 'src/a.js', fixed: 'fixed-a', original: 'old-a', issues: ['i'] },
    { file: 'src/b.js', fixed: 'fixed-b', original: 'old-b', issues: ['i'] },
  ];
  const original = [
    { path: 'src/a.js', content: 'old-a' },
    { path: 'src/b.js', content: 'old-b' },
  ];
  // Original scan: A had a finding, B was clean.
  const originalFindings = {
    syntax: ['src/a.js: original A finding'],
    lint: [],
  };
  // Post-fix scan: A's original finding gone (good), but B now has a
  // new finding that wasn't there before — fix B should roll back.
  const runTier = makeStubRunTier({
    full: [
      { name: 'syntax', details: [] },
      { name: 'lint', details: ['src/b.js: B introduced a lint error'] },
    ],
  });
  const result = await validateFixesAgainstScanner({
    fixes, originalFileContents: original, originalFindingsByModule: originalFindings,
    runTier, owner: 'x', repo: 'y',
  });
  assert.equal(result.accepted.length, 1);
  assert.equal(result.accepted[0].file, 'src/a.js');
  assert.equal(result.rolledBack.length, 1);
  assert.equal(result.rolledBack[0].file, 'src/b.js');
  assert.match(result.rolledBack[0].reason, /1 new finding/);
  assert.equal(result.rolledBack[0].newFindings.length, 1);
  assert.match(result.rolledBack[0].newFindings[0], /\[lint\] src\/b\.js: B introduced/);
});

test('validateFixesAgainstScanner — unattributed findings recorded but not blocking', async () => {
  const fixes = [{ file: 'src/a.js', fixed: 'new-a', original: 'old-a', issues: ['i'] }];
  const original = [{ path: 'src/a.js', content: 'old-a' }];
  const originalFindings = { codeQuality: [] };
  const runTier = makeStubRunTier({
    full: [{ name: 'codeQuality', details: ['Module-level summary: total files 1'] }],
  });
  const result = await validateFixesAgainstScanner({
    fixes, originalFileContents: original, originalFindingsByModule: originalFindings,
    runTier, owner: 'x', repo: 'y',
  });
  assert.equal(result.accepted.length, 1);
  assert.equal(result.rolledBack.length, 0);
  assert.equal(result.unattributedFindings.length, 1);
  assert.match(result.summary, /1 unattributed advisory finding/);
});

test('validateFixesAgainstScanner — fails open on runTier error', async () => {
  const fixes = [{ file: 'src/a.js', fixed: 'x', original: 'y', issues: ['i'] }];
  const result = await validateFixesAgainstScanner({
    fixes,
    originalFileContents: [{ path: 'src/a.js', content: 'y' }],
    originalFindingsByModule: {},
    runTier: async () => { throw new Error('scanner exploded'); },
    owner: 'x', repo: 'y',
  });
  assert.equal(result.accepted.length, 1);
  assert.equal(result.rolledBack.length, 0);
  assert.match(result.summary, /failed-open/);
  assert.match(result.summary, /scanner exploded/);
});

test('validateFixesAgainstScanner — multiple new findings on one file aggregate into one rollback', async () => {
  const fixes = [{ file: 'src/a.js', fixed: 'new', original: 'old', issues: ['i'] }];
  const runTier = makeStubRunTier({
    full: [
      { name: 'syntax', details: ['src/a.js: error 1'] },
      { name: 'lint', details: ['src/a.js: error 2'] },
      { name: 'security', details: ['src/a.js: error 3'] },
    ],
  });
  const result = await validateFixesAgainstScanner({
    fixes,
    originalFileContents: [{ path: 'src/a.js', content: 'old' }],
    originalFindingsByModule: { syntax: [], lint: [], security: [] },
    runTier, owner: 'x', repo: 'y',
  });
  assert.equal(result.rolledBack.length, 1);
  assert.equal(result.rolledBack[0].newFindings.length, 3);
});

test('validateFixesAgainstScanner — input validation', async () => {
  await assert.rejects(
    () => validateFixesAgainstScanner({ fixes: 'not-array', originalFileContents: [], originalFindingsByModule: {}, runTier: async () => ({}), owner: 'x', repo: 'y' }),
    /fixes must be an array/
  );
  await assert.rejects(
    () => validateFixesAgainstScanner({ fixes: [], originalFileContents: 'no', originalFindingsByModule: {}, runTier: async () => ({}), owner: 'x', repo: 'y' }),
    /originalFileContents must be an array/
  );
  await assert.rejects(
    () => validateFixesAgainstScanner({ fixes: [], originalFileContents: [], originalFindingsByModule: null, runTier: async () => ({}), owner: 'x', repo: 'y' }),
    /originalFindingsByModule must be an object/
  );
  await assert.rejects(
    () => validateFixesAgainstScanner({ fixes: [], originalFileContents: [], originalFindingsByModule: {}, runTier: 'no', owner: 'x', repo: 'y' }),
    /runTier must be a function/
  );
  await assert.rejects(
    () => validateFixesAgainstScanner({ fixes: [], originalFileContents: [], originalFindingsByModule: {}, runTier: async () => ({}), owner: null, repo: 'y' }),
    /owner and repo must be strings/
  );
});

test('validateFixesAgainstScanner — does not roll back fix that ALREADY had a similar finding (same string)', async () => {
  // Edge: if the original scan flagged "src/a.js: console.log" and the
  // fix didn't fully remove it, the SAME string appears again post-fix.
  // That's not a NEW finding — it's a stale one. Don't roll back.
  const fixes = [{ file: 'src/a.js', fixed: 'still-has-console-log', original: 'old', issues: ['i'] }];
  const originalFindings = { codeQuality: ['src/a.js: console.log present'] };
  const runTier = makeStubRunTier({
    full: [{ name: 'codeQuality', details: ['src/a.js: console.log present'] }],
  });
  const result = await validateFixesAgainstScanner({
    fixes,
    originalFileContents: [{ path: 'src/a.js', content: 'old' }],
    originalFindingsByModule: originalFindings,
    runTier, owner: 'x', repo: 'y',
  });
  assert.equal(result.accepted.length, 1);
  assert.equal(result.rolledBack.length, 0);
});

test('validateFixesAgainstScanner — synthetic workspace passed to runTier', async () => {
  let receivedCtx = null;
  const runTier = async (tier, ctx) => {
    receivedCtx = ctx;
    return { modules: [], totalIssues: 0 };
  };
  await validateFixesAgainstScanner({
    fixes: [{ file: 'src/a.js', fixed: 'NEW', original: 'OLD', issues: ['i'] }],
    originalFileContents: [
      { path: 'src/a.js', content: 'OLD' },
      { path: 'src/b.js', content: 'untouched' },
    ],
    originalFindingsByModule: {},
    runTier, owner: 'org', repo: 'project',
  });
  assert.equal(receivedCtx.owner, 'org');
  assert.equal(receivedCtx.repo, 'project');
  const aFile = receivedCtx.fileContents.find((f) => f.path === 'src/a.js');
  const bFile = receivedCtx.fileContents.find((f) => f.path === 'src/b.js');
  assert.equal(aFile.content, 'NEW', 'fixed file content swapped in');
  assert.equal(bFile.content, 'untouched', 'unfixed file kept original content');
});
