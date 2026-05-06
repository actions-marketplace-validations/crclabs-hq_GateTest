'use strict';

/**
 * Phase 5.4 / Phase 6.2.1 — Multi-file refactor executor.
 *
 * Executes a RefactorPlan (from refactor-planner.js) file by file, gating each
 * change through the cross-fix syntax gate and optionally the scanner gate:
 *
 *   Phase 1 — Modify existing files (Claude per-file, syntax gate, batch scanner gate)
 *   Phase 2 — Create new files (Claude, syntax gate)
 *   Phase 3 — Generate test stubs (Claude, non-blocking)
 *
 * Time-budgeted at 240s (execution phase). Failures are captured and never block
 * the remaining files.
 */

const { pickChecker } = require('./cross-fix-syntax-gate');

const MAX_FILES_PER_PLAN = 15;
const MAX_NEW_FILES = 5;
const MAX_TEST_FILES = 3;
const MAX_FILE_BYTES = 80 * 1024;
const EXEC_TIMEOUT_MS = 240_000;

// ─── Per-file Claude prompts ──────────────────────────────────────────────────

function buildModifyPrompt(planFile, originalContent, plan) {
  const preview = originalContent.split('\n').slice(0, 200).join('\n');
  return `You are implementing a ${plan.type} refactor.

REFACTOR PLAN RATIONALE:
${plan.rationale}

FILE TO MODIFY: ${planFile.path}
CHANGE REQUIRED: ${planFile.description}

CURRENT CONTENT:
\`\`\`
${preview}
\`\`\`

Apply the requested change. Return ONLY the complete modified file content.
No explanation. No code fences. Just the file content.`;
}

function buildCreatePrompt(planFile, plan, appliedSoFar) {
  const contextSnippet = appliedSoFar.slice(0, 3)
    .map((f) => `### ${f.path}\n\`\`\`\n${f.after.split('\n').slice(0, 50).join('\n')}\n\`\`\``)
    .join('\n\n');

  return `You are implementing a ${plan.type} refactor.

REFACTOR PLAN RATIONALE:
${plan.rationale}

NEW FILE TO CREATE: ${planFile.path}
PURPOSE: ${planFile.description}

CONTEXT — already-modified files:
${contextSnippet || '(none yet)'}

Return ONLY the complete file content.
No explanation. No code fences. Just the file content.`;
}

function buildTestPrompt(planFile, plan, appliedSoFar) {
  const contextSnippet = appliedSoFar.slice(0, 3)
    .map((f) => `### ${f.path}\n\`\`\`\n${f.after.split('\n').slice(0, 50).join('\n')}\n\`\`\``)
    .join('\n\n');

  return `You are writing tests for a ${plan.type} refactor.

REFACTOR PLAN RATIONALE:
${plan.rationale}

TEST FILE TO CREATE: ${planFile.path}
WHAT TO TEST: ${planFile.description}

REFACTORED CODE:
${contextSnippet || '(no applied files available)'}

Write comprehensive tests using node:test and assert/strict.
Cover happy path, error handling, and edge cases.
Return ONLY the complete test file content.
No explanation. No code fences. Just the file content.`;
}

// ─── Gate helpers ─────────────────────────────────────────────────────────────

function runSyntaxGate(filePath, content) {
  const checker = pickChecker(filePath);
  if (!checker) return { passed: true };
  try {
    const res = checker(content);
    // Some checkers return { ok, reason } rather than throwing (e.g. JSON checker)
    if (res && typeof res === 'object' && res.ok === false) {
      return { passed: false, error: res.reason };
    }
    return { passed: true };
  } catch (err) {
    return { passed: false, error: err.message };
  }
}

async function runScannerGate(changedMap, runTier) {
  try {
    const result = await runTier('quick', changedMap);
    const modules = Array.isArray(result && result.modules) ? result.modules : [];
    const errorCount = modules.reduce((acc, mod) => {
      if (!mod || !Array.isArray(mod.checks)) return acc;
      return acc + mod.checks.filter((c) => c && !c.passed && c.severity === 'error').length;
    }, 0);
    return { passed: errorCount === 0, errorCount };
  } catch {
    return { passed: true, errorCount: 0 }; // non-blocking — scanner outage doesn't block
  }
}

function stripFences(text) {
  return text.replace(/^```[^\n]*\n?/m, '').replace(/```\s*$/m, '').trim();
}

// ─── Main executor ────────────────────────────────────────────────────────────

/**
 * Execute a multi-file refactor plan.
 *
 * @param {Object} opts
 * @param {Object} opts.plan - RefactorPlan from planRefactor()
 * @param {Array<{filePath: string, content: string}>} opts.sourceFiles
 * @param {Function} opts.askClaude - async (prompt: string) => string
 * @param {Function} [opts.runTier] - async (suite, fileMap) => result (optional scanner gate)
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<RefactorResult>}
 */
async function executeRefactorPlan({
  plan,
  sourceFiles,
  askClaude,
  runTier = null,
  timeoutMs = EXEC_TIMEOUT_MS,
}) {
  const deadline = Date.now() + timeoutMs;
  const applied = [];   // { path, before, after }
  const created = [];   // { path, content }
  const failed = [];    // { path, reason }
  const rolledBack = []; // { path, reason }

  // Build a mutable file map
  const fileMap = {};
  for (const { filePath, content } of sourceFiles) {
    fileMap[filePath] = content;
  }

  // ── Phase 1: Modify existing files ──────────────────────────────────────────
  const filesToModify = (plan.filesToModify || []).slice(0, MAX_FILES_PER_PLAN);

  for (const planFile of filesToModify) {
    if (Date.now() > deadline) {
      failed.push({ path: planFile.path, reason: 'execution timeout' });
      continue;
    }

    const originalContent = fileMap[planFile.path];
    if (originalContent === undefined) {
      failed.push({ path: planFile.path, reason: 'file not found in source set' });
      continue;
    }
    if (Buffer.byteLength(originalContent, 'utf8') > MAX_FILE_BYTES) {
      failed.push({ path: planFile.path, reason: 'file exceeds size limit' });
      continue;
    }

    let modified;
    try {
      modified = await askClaude(buildModifyPrompt(planFile, originalContent, plan));
    } catch (err) {
      failed.push({ path: planFile.path, reason: `Claude error: ${err.message}` });
      continue;
    }

    if (!modified || typeof modified !== 'string' || modified.trim().length < 10) {
      failed.push({ path: planFile.path, reason: 'Claude returned empty response' });
      continue;
    }

    const cleaned = stripFences(modified);

    const syntaxResult = runSyntaxGate(planFile.path, cleaned);
    if (!syntaxResult.passed) {
      failed.push({ path: planFile.path, reason: `syntax gate: ${syntaxResult.error}` });
      continue;
    }

    applied.push({ path: planFile.path, before: originalContent, after: cleaned });
    fileMap[planFile.path] = cleaned;
  }

  // ── Scanner gate on all modified files ──────────────────────────────────────
  if (runTier && applied.length > 0) {
    const changedMap = {};
    for (const f of applied) changedMap[f.path] = f.after;

    const scanResult = await runScannerGate(changedMap, runTier);
    if (!scanResult.passed) {
      const lastApplied = applied.pop();
      if (lastApplied) {
        rolledBack.push({
          path: lastApplied.path,
          reason: `scanner gate found ${scanResult.errorCount} new error(s)`,
        });
        fileMap[lastApplied.path] = lastApplied.before;
      }
    }
  }

  // ── Phase 2: Create new files ────────────────────────────────────────────────
  for (const planFile of (plan.newFilesToCreate || []).slice(0, MAX_NEW_FILES)) {
    if (Date.now() > deadline) {
      failed.push({ path: planFile.path, reason: 'execution timeout' });
      continue;
    }

    let content;
    try {
      content = await askClaude(buildCreatePrompt(planFile, plan, applied));
    } catch (err) {
      failed.push({ path: planFile.path, reason: `Claude error: ${err.message}` });
      continue;
    }

    if (!content || typeof content !== 'string' || content.trim().length < 10) {
      failed.push({ path: planFile.path, reason: 'Claude returned empty response' });
      continue;
    }

    const cleaned = stripFences(content);

    const syntaxResult = runSyntaxGate(planFile.path, cleaned);
    if (!syntaxResult.passed) {
      failed.push({ path: planFile.path, reason: `syntax gate: ${syntaxResult.error}` });
      continue;
    }

    created.push({ path: planFile.path, content: cleaned });
    fileMap[planFile.path] = cleaned;
  }

  // ── Phase 3: Generate test stubs (non-blocking) ───────────────────────────
  for (const planFile of (plan.testFilesToCreate || []).slice(0, MAX_TEST_FILES)) {
    if (Date.now() > deadline) break;

    let content;
    try {
      content = await askClaude(buildTestPrompt(planFile, plan, applied));
    } catch {
      continue;
    }

    if (!content || typeof content !== 'string' || content.trim().length < 10) continue;

    const cleaned = stripFences(content);
    created.push({ path: planFile.path, content: cleaned });
  }

  // ── Build summary ─────────────────────────────────────────────────────────
  const totalAttempted = filesToModify.length + (plan.newFilesToCreate || []).slice(0, MAX_NEW_FILES).length;
  const totalDone = applied.length + created.length;

  const summary =
    `Refactor: ${plan.type}. ` +
    `${applied.length} file(s) modified, ${created.length} file(s) created` +
    (rolledBack.length > 0 ? `, ${rolledBack.length} rolled back` : '') +
    (failed.length > 0 ? `, ${failed.length} failed` : '') +
    `. (${totalDone}/${totalAttempted} successful)`;

  const prBody = renderRefactorPrBody({ plan, applied, created, failed, rolledBack });

  return { applied, created, failed, rolledBack, summary, prBody };
}

// ─── PR body renderer ─────────────────────────────────────────────────────────

function renderRefactorPrBody({ plan, applied, created, failed, rolledBack }) {
  const lines = [];
  lines.push(`## Architectural Refactor: ${plan.type.replace(/-/g, ' ')}`);
  lines.push('');
  lines.push('> ' + plan.rationale.replace(/\n/g, '\n> '));
  lines.push('');
  lines.push('---');
  lines.push('');

  lines.push('### Files Modified');
  lines.push('');
  if (applied.length === 0 && rolledBack.length === 0) {
    lines.push('_No files were successfully modified._');
  } else {
    lines.push('| File | Status |');
    lines.push('|------|--------|');
    for (const f of applied) {
      lines.push(`| \`${f.path}\` | ✅ Applied |`);
    }
    for (const f of rolledBack) {
      lines.push(`| \`${f.path}\` | ⏪ Rolled back — ${f.reason} |`);
    }
  }
  lines.push('');

  if (created.length > 0) {
    lines.push('### Files Created');
    lines.push('');
    lines.push('| File | Type |');
    lines.push('|------|------|');
    for (const f of created) {
      const isTest = f.path.includes('.test.') || f.path.includes('.spec.');
      lines.push(`| \`${f.path}\` | ${isTest ? '🧪 Test' : '📄 Source'} |`);
    }
    lines.push('');
  }

  if (failed.length > 0) {
    lines.push('### Items Requiring Manual Attention');
    lines.push('');
    for (const f of failed) {
      lines.push(`- \`${f.path}\` — ${f.reason}`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('*Generated by GateTest Nuclear — Architectural Refactor Pipeline (Phase 5.4)*');
  return lines.join('\n');
}

module.exports = {
  executeRefactorPlan,
  renderRefactorPrBody,
  buildModifyPrompt,
  buildCreatePrompt,
  buildTestPrompt,
  runSyntaxGate,
  EXEC_TIMEOUT_MS,
  MAX_FILES_PER_PLAN,
  MAX_NEW_FILES,
  MAX_TEST_FILES,
};
