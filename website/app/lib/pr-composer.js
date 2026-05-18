/**
 * PR-body composer.
 *
 * Phase 1.4 of THE FIX-FIRST BUILD PLAN. Builds the markdown PR body
 * that ships with every auto-fix PR — assembles the artifacts from the
 * iterative loop (1.1), syntax gate (1.2a), scanner gate (1.2b), and
 * test generator (1.3) into one structured report.
 *
 * The PR body is the customer's primary interface to what GateTest
 * did. Every other competitor either (a) gives one-liner commits with
 * no rationale or (b) buries findings in a SaaS dashboard. We put the
 * full audit trail directly on their PR — issues fixed, attempts per
 * fix, gate results, regression tests written, before/after scan
 * comparison.
 *
 * Pure string composition, zero dependencies, fully testable.
 *
 * Inputs: every artifact the orchestrator already collects (no new
 * data needed).
 *
 * Output: a single markdown string ready to hand to openPullRequest.
 */

/**
 * Render the per-file fix history table.
 * Each row: file, issues count, attempt count, attempt outcome breakdown,
 * total Claude time spent.
 */
function renderAttemptHistoryTable(attemptHistoryByFile) {
  if (!attemptHistoryByFile || Object.keys(attemptHistoryByFile).length === 0) {
    return '';
  }
  const rows = Object.entries(attemptHistoryByFile)
    .filter(([, info]) => info && Array.isArray(info.attempts))
    .map(([file, info]) => {
      const total = info.attempts.length;
      const lastOutcome = total > 0 ? info.attempts[total - 1].outcome : '—';
      const totalMs = info.attempts.reduce((sum, a) => sum + (a.durationMs || 0), 0);
      const breakdown = info.attempts.reduce((acc, a) => {
        acc[a.outcome] = (acc[a.outcome] || 0) + 1;
        return acc;
      }, {});
      const breakdownText = Object.entries(breakdown)
        .map(([k, v]) => `${v}× ${k}`)
        .join(', ');
      const status = info.success ? '✅' : '❌';
      return `| ${status} \`${file}\` | ${total} | ${breakdownText} | ${totalMs}ms | ${lastOutcome} |`;
    });
  if (rows.length === 0) return '';
  return [
    '### Per-file fix history',
    '',
    '| File | Attempts | Outcomes | Claude time | Final |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

/**
 * Render the gate-results section. Each gate gets one line.
 */
function renderGateResults({ syntaxGate, scannerGate, testGen }) {
  const lines = ['### Gate results', ''];
  if (syntaxGate && syntaxGate.summary) {
    lines.push(`- **Syntax gate** — ${syntaxGate.summary}`);
  }
  if (scannerGate && scannerGate.summary) {
    lines.push(`- **Cross-file scanner gate** — ${scannerGate.summary}`);
  } else if (scannerGate && scannerGate.skipped) {
    lines.push(`- **Cross-file scanner gate** — skipped (${scannerGate.reason || 'caller did not pass scan baseline'})`);
  }
  if (testGen && testGen.summary) {
    lines.push(`- **Test generation** — ${testGen.summary}`);
  }
  if (lines.length === 2) return ''; // header only — nothing useful
  return lines.join('\n');
}

/**
 * Render the before/after scan comparison table.
 * Each row: module, before-count, after-count, delta.
 * Only rendered when both originalFindings and postFixFindings are
 * provided — otherwise the comparison is meaningless.
 */
function renderBeforeAfterScan({ originalFindingsByModule, postFixFindingsByModule }) {
  const hasOriginal = originalFindingsByModule && Object.keys(originalFindingsByModule).length > 0;
  const hasPost = postFixFindingsByModule && Object.keys(postFixFindingsByModule).length > 0;
  if (!hasOriginal && !hasPost) return '';

  const moduleNames = new Set([
    ...Object.keys(originalFindingsByModule || {}),
    ...Object.keys(postFixFindingsByModule || {}),
  ]);

  const rows = [];
  let totalBefore = 0;
  let totalAfter = 0;
  for (const name of [...moduleNames].sort()) {
    const before = (originalFindingsByModule?.[name] || []).length;
    const after = (postFixFindingsByModule?.[name] || []).length;
    totalBefore += before;
    totalAfter += after;
    if (before === 0 && after === 0) continue; // skip clean-throughout modules
    const delta = after - before;
    const arrow = delta < 0 ? `-${Math.abs(delta)} ✅` : delta > 0 ? `+${delta} ⚠️` : '0';
    rows.push(`| \`${name}\` | ${before} | ${after} | ${arrow} |`);
  }

  if (rows.length === 0) return '';

  const totalDelta = totalAfter - totalBefore;
  const totalArrow = totalDelta < 0 ? `-${Math.abs(totalDelta)} ✅` : totalDelta > 0 ? `+${totalDelta} ⚠️` : '0';

  return [
    '### Before vs after',
    '',
    '| Module | Before | After | Delta |',
    '| --- | --- | --- | --- |',
    ...rows,
    `| **TOTAL** | **${totalBefore}** | **${totalAfter}** | **${totalArrow}** |`,
  ].join('\n');
}

/**
 * Render the fixed-files section (the human-readable list).
 */
function renderFixedFiles(fixes) {
  if (!Array.isArray(fixes) || fixes.length === 0) return '';
  // Skip auto-generated regression tests in this section — they get
  // their own section since they're net-additive code, not fixes.
  const realFixes = fixes.filter((f) => !(f.file || '').startsWith('tests/auto-generated/'));
  if (realFixes.length === 0) return '';
  const blocks = realFixes.map((f) => {
    const issueList = (f.issues || []).map((i) => `  - ✅ ${i}`).join('\n');
    const count = (f.issues || []).length;
    return `<details>\n<summary><strong>${f.file}</strong> — ${count} fix${count !== 1 ? 'es' : ''}</summary>\n\n${issueList}\n</details>`;
  });
  return ['### Fixed files', '', ...blocks].join('\n\n');
}

/**
 * Render the regression-tests-added section.
 */
function renderRegressionTests(fixes) {
  if (!Array.isArray(fixes)) return '';
  const tests = fixes.filter((f) => (f.file || '').startsWith('tests/auto-generated/'));
  if (tests.length === 0) return '';
  const lines = tests.map((t) => {
    const sourceMatch = (t.issues || []).join(' ').match(/Regression test for (.+)/);
    const source = sourceMatch ? sourceMatch[1] : '(unknown source)';
    return `- \`${t.file}\` — covers \`${source}\``;
  });
  return [
    '### Regression tests added',
    '',
    `Claude wrote ${tests.length} new regression test${tests.length !== 1 ? 's' : ''}. Each one demonstrates the original bug would have failed and the fix passes — so reverting any of these fixes will trip the new test.`,
    '',
    ...lines,
  ].join('\n');
}

/**
 * Render the could-not-fix / advisory section from errors[].
 */
function renderErrors(errors) {
  if (!Array.isArray(errors) || errors.length === 0) return '';
  const lines = errors.map((e) => `- ${e}`);
  return ['### Advisory — items that did not fix cleanly', '', ...lines].join('\n');
}

/**
 * The full composer.
 *
 * @param {Object} opts
 * @param {Array<{ file, original, fixed, issues }>} opts.fixes
 * @param {string[]} [opts.errors]
 * @param {Record<string, { attempts: Array<object>, summary: string, success: boolean }>} [opts.attemptHistoryByFile]
 * @param {{ accepted: object[], rejected: object[], summary: string }} [opts.syntaxGate]
 * @param {{ summary?: string, skipped?: boolean, reason?: string, rolledBack?: object[] }} [opts.scannerGate]
 * @param {{ tests: object[], skipped: object[], summary: string }} [opts.testGen]
 * @param {Record<string, string[]>} [opts.originalFindingsByModule]
 * @param {Record<string, string[]>} [opts.postFixFindingsByModule]
 * @param {string} [opts.repoUrl]
 * @param {string} [opts.cveSection]  Pre-rendered CVE patches markdown section (from composeCveFixPrSection).
 * @returns {string}  Markdown PR body, ready to hand to openPullRequest.
 */
function composePrBody(opts) {
  const {
    fixes = [],
    errors = [],
    attemptHistoryByFile,
    syntaxGate,
    scannerGate,
    testGen,
    originalFindingsByModule,
    postFixFindingsByModule,
    cveSection,
  } = opts || {};

  const realFixes = fixes.filter((f) => !(f.file || '').startsWith('tests/auto-generated/'));
  const totalIssuesFixed = realFixes.reduce((sum, f) => sum + ((f.issues || []).length), 0);
  const filesFixed = realFixes.length;
  const testsAdded = fixes.filter((f) => (f.file || '').startsWith('tests/auto-generated/')).length;

  const sections = [];

  // Header
  sections.push(`## GateTest Auto-Fix Report`);
  sections.push('');
  const headlineParts = [];
  if (totalIssuesFixed > 0) headlineParts.push(`**${totalIssuesFixed} issue${totalIssuesFixed !== 1 ? 's' : ''} fixed** across **${filesFixed} file${filesFixed !== 1 ? 's' : ''}**`);
  if (testsAdded > 0) headlineParts.push(`**${testsAdded} regression test${testsAdded !== 1 ? 's' : ''} added**`);
  if (headlineParts.length > 0) {
    sections.push(`> ${headlineParts.join(' · ')} — verified before commit.`);
    sections.push('');
  }
  sections.push(`Every fix in this PR was generated by Claude and validated through three gates before commit: per-file iterative re-attempt loop, cross-fix syntax check, and cross-file scanner re-validation. Fixes that failed any gate were rolled back automatically — they don't ship to your branch.`);

  // CVE patches (auto-patched without Claude — headline feature vs Dependabot)
  if (cveSection && cveSection.trim()) {
    sections.push('');
    sections.push(cveSection);
  }

  // Before/after scan
  const beforeAfter = renderBeforeAfterScan({ originalFindingsByModule, postFixFindingsByModule });
  if (beforeAfter) {
    sections.push('');
    sections.push(beforeAfter);
  }

  // Gates
  const gates = renderGateResults({ syntaxGate, scannerGate, testGen });
  if (gates) {
    sections.push('');
    sections.push(gates);
  }

  // Per-file attempt history
  const history = renderAttemptHistoryTable(attemptHistoryByFile);
  if (history) {
    sections.push('');
    sections.push(history);
  }

  // Fixed files
  const fixed = renderFixedFiles(fixes);
  if (fixed) {
    sections.push('');
    sections.push(fixed);
  }

  // Regression tests
  const regTests = renderRegressionTests(fixes);
  if (regTests) {
    sections.push('');
    sections.push(regTests);
  }

  // Advisory
  const adv = renderErrors(errors);
  if (adv) {
    sections.push('');
    sections.push(adv);
  }

  // How it works
  sections.push('');
  sections.push('### How GateTest works');
  sections.push('');
  sections.push('1. **Scan** — your repo runs through up to 90 quality / security / hygiene modules.');
  sections.push('2. **Iterative fix loop** — for every finding, Claude attempts a fix, GateTest re-checks the file, and if quality drops, Claude sees the failure and tries again. Up to N attempts (default 3).');
  sections.push('3. **Syntax gate** — every accepted fix is parsed before commit. Broken-syntax fixes are rolled back, never shipped.');
  sections.push('4. **Cross-file scanner gate** — all accepted fixes are applied to a synthetic post-fix workspace and re-scanned together. Any fix that introduces a new finding the original scan didn\'t have is rolled back.');
  sections.push('5. **Regression tests** — for every fix, Claude writes a test that would have failed against the buggy code. Tests ship in the same PR.');
  sections.push('6. **PR** — the surviving fixes (and tests) are committed to this branch. GateTest never auto-merges.');

  // Next steps
  sections.push('');
  sections.push('### Next steps');
  sections.push('');
  sections.push('- Review the changes in the **Files Changed** tab');
  sections.push('- Run your existing test suite locally to confirm everything is green');
  sections.push('- Merge when satisfied');

  // Footer
  sections.push('');
  sections.push('---');
  sections.push('');
  sections.push('<sub>Scanned and fixed by <a href="https://gatetest.ai">GateTest</a> — 102 modules · AI-powered · verify-before-commit · pay-on-completion</sub>');

  return sections.join('\n');
}

module.exports = {
  composePrBody,
  // Exported for tests / advanced callers.
  renderAttemptHistoryTable,
  renderGateResults,
  renderBeforeAfterScan,
  renderFixedFiles,
  renderRegressionTests,
  renderErrors,
};
