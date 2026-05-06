'use strict';

/**
 * Phase 5.4 / Phase 6.2.1 — Multi-file refactor planner.
 *
 * Given a RefactorCandidate (from refactor-detector.js), asks Claude to produce
 * a concrete multi-file refactor plan specifying which files to modify, which new
 * files to create, and test stubs to validate the refactor.
 *
 * Time-budgeted at 90s (planning phase).
 */

const MAX_EVIDENCE_FILES = 8;
const MAX_FILE_PREVIEW_LINES = 40;
const PLAN_TIMEOUT_MS = 90_000;

// ─── Prompt builders ──────────────────────────────────────────────────────────

function summariseEvidence(candidate) {
  return candidate.files.slice(0, MAX_EVIDENCE_FILES)
    .map((f) => {
      const ev = f.evidence.map((e) => `line ${e.lineNumber}: ${e.evidence}`).join('; ');
      return `File: ${f.filePath}\n  Evidence: ${ev}`;
    })
    .join('\n\n');
}

function buildFilePreviews(fileContents) {
  return fileContents.slice(0, 3)
    .map((f) => {
      const lines = f.content.split('\n').slice(0, MAX_FILE_PREVIEW_LINES);
      return `### ${f.filePath}\n\`\`\`\n${lines.join('\n')}\n\`\`\``;
    })
    .join('\n\n');
}

function buildPollingToWebhookPrompt(candidate, fileContents) {
  return `You are a senior software engineer planning a polling-to-webhook refactor.

PROBLEM:
The codebase contains polling loops (setInterval/setTimeout + HTTP fetch calls) that should
be replaced with webhook receivers. This wastes bandwidth, adds latency, and fails under rate limits.

EVIDENCE OF POLLING:
${summariseEvidence(candidate)}

FILE PREVIEWS (first ${MAX_FILE_PREVIEW_LINES} lines):
${buildFilePreviews(fileContents)}

TASK:
Produce a concrete multi-file refactor plan. Be specific about what changes.

Respond in EXACTLY this format (no extra text before or after):

RATIONALE:
<2-3 sentences explaining what the polling is doing and why webhooks are better>

FILES_TO_MODIFY:
<filePath> | <what to change: remove the setInterval/polling loop, add webhook receiver setup>
[list all affected files, one per line]

NEW_FILES_TO_CREATE:
<path> | <purpose: webhook receiver handler, webhook registration client, etc.>
[list new files, one per line, or NONE if no new files needed]

TEST_FILES_TO_CREATE:
<path> | <what to test: webhook delivery, receiver handler, fallback behavior>
[list test files, one per line]

WARNINGS:
<any risk or limitation of this refactor, or NONE>`;
}

function buildInMemoryToStorePrompt(candidate, fileContents) {
  return `You are a senior software engineer planning an in-memory-state-to-external-store refactor.

PROBLEM:
The codebase contains module-level Map/Set/Object in serverless function files.
Serverless functions are stateless — memory is reset on cold starts and NOT shared
across concurrent instances. This causes silent data loss and race conditions.

EVIDENCE OF IN-MEMORY STATE:
${summariseEvidence(candidate)}

FILE PREVIEWS (first ${MAX_FILE_PREVIEW_LINES} lines):
${buildFilePreviews(fileContents)}

TASK:
Produce a concrete multi-file refactor plan. Recommend the appropriate external store:
- Vercel KV (Redis) for sessions, rate-limiting, caching
- Postgres/Neon for persistent data, complex queries
- Upstash Redis for low-latency ephemeral state

Respond in EXACTLY this format (no extra text before or after):

RATIONALE:
<2-3 sentences explaining the risk and which store type to use and why>

FILES_TO_MODIFY:
<filePath> | <what to change: replace Map with Redis client calls, add store import, etc.>
[list all affected files, one per line]

NEW_FILES_TO_CREATE:
<path> | <purpose: store client wrapper, schema migration, etc.>
[list new files, one per line, or NONE]

TEST_FILES_TO_CREATE:
<path> | <what to test: store reads/writes with mocked client, fallback behavior>
[list test files, one per line]

WARNINGS:
<any risk or limitation, e.g. "requires Vercel KV env vars", or NONE>`;
}

function buildUntypedFetchToClientPrompt(candidate, fileContents) {
  return `You are a senior software engineer planning a typed-client refactor.

PROBLEM:
The codebase makes raw fetch/axios calls to internal APIs in ${candidate.files.length} files
without a typed client. Breaking API changes silently fail at runtime, auth logic is
duplicated, and there is no type safety on responses.

EVIDENCE OF UNTYPED FETCH:
${summariseEvidence(candidate)}

FILE PREVIEWS (first ${MAX_FILE_PREVIEW_LINES} lines):
${buildFilePreviews(fileContents)}

TASK:
Produce a concrete multi-file refactor plan. Generate a typed API client with Zod schemas.
Use standard fetch (no extra dependencies if possible). Centralise auth headers and base URL.

Respond in EXACTLY this format (no extra text before or after):

RATIONALE:
<2-3 sentences explaining the maintenance burden and how the typed client solves it>

FILES_TO_MODIFY:
<filePath> | <what to change: replace raw fetch with client.METHOD(), import client>
[list all affected files, one per line]

NEW_FILES_TO_CREATE:
<path> | <purpose: typed API client, Zod response schemas, etc.>
[list new files, one per line]

TEST_FILES_TO_CREATE:
<path> | <what to test: client methods with mocked fetch, schema validation, auth headers>
[list test files, one per line]

WARNINGS:
<any risk, e.g. "assumes all /api/* routes return JSON", or NONE>`;
}

// ─── Response parser ──────────────────────────────────────────────────────────

function parsePlanResponse(text, refactorType) {
  const extract = (label) => {
    const regex = new RegExp(`${label}:\\s*\\n([\\s\\S]*?)(?=\\n[A-Z_]+:|$)`);
    const match = text.match(regex);
    return match ? match[1].trim() : '';
  };

  const parseFileList = (block) => {
    if (!block || block.trim().toUpperCase() === 'NONE') return [];
    return block
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && line.includes('|'))
      .map((line) => {
        const idx = line.indexOf('|');
        return {
          path: line.slice(0, idx).trim(),
          description: line.slice(idx + 1).trim(),
        };
      })
      .filter((f) => f.path.length > 0);
  };

  const rationale = extract('RATIONALE');
  const filesToModify = parseFileList(extract('FILES_TO_MODIFY'));
  const newFilesToCreate = parseFileList(extract('NEW_FILES_TO_CREATE'));
  const testFilesToCreate = parseFileList(extract('TEST_FILES_TO_CREATE'));
  const warningsText = extract('WARNINGS');
  const warnings =
    !warningsText || warningsText.trim().toUpperCase() === 'NONE'
      ? []
      : warningsText.split('\n').map((w) => w.trim()).filter(Boolean);

  if (!rationale || filesToModify.length === 0) return null;

  return {
    type: refactorType,
    rationale,
    filesToModify,
    newFilesToCreate,
    testFilesToCreate,
    warnings,
  };
}

// ─── Main entry ───────────────────────────────────────────────────────────────

/**
 * Plan a multi-file refactor using Claude.
 *
 * @param {Object} opts
 * @param {Object} opts.candidate - RefactorCandidate from detectRefactors()
 * @param {Array<{filePath: string, content: string}>} opts.sourceFiles
 * @param {Function} opts.askClaude - async (prompt: string) => string
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<RefactorPlan | null>}
 */
async function planRefactor({ candidate, sourceFiles, askClaude, timeoutMs = PLAN_TIMEOUT_MS }) {
  const evidenceFilePaths = new Set(candidate.files.map((f) => f.filePath));
  const fileContents = sourceFiles.filter((f) => evidenceFilePaths.has(f.filePath));

  let prompt;
  if (candidate.type === 'polling-to-webhook') {
    prompt = buildPollingToWebhookPrompt(candidate, fileContents);
  } else if (candidate.type === 'in-memory-to-store') {
    prompt = buildInMemoryToStorePrompt(candidate, fileContents);
  } else if (candidate.type === 'untyped-fetch-to-client') {
    prompt = buildUntypedFetchToClientPrompt(candidate, fileContents);
  } else {
    throw new Error(`Unknown refactor type: ${candidate.type}`);
  }

  let response;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    response = await askClaude(prompt);
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new Error(`Planning timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!response || typeof response !== 'string') return null;

  const cleaned = response.replace(/^```[^\n]*\n?/m, '').replace(/```\s*$/m, '').trim();
  return parsePlanResponse(cleaned, candidate.type);
}

/**
 * Render a refactor plan as Markdown (for PR body or report section).
 */
function renderPlanSummary(plan) {
  const lines = [];
  lines.push(`## Architectural Refactor: ${plan.type}`);
  lines.push('');
  lines.push('### Rationale');
  lines.push(plan.rationale);
  lines.push('');

  lines.push('### Files to Modify');
  if (plan.filesToModify.length === 0) {
    lines.push('_None_');
  } else {
    for (const f of plan.filesToModify) {
      lines.push(`- \`${f.path}\` — ${f.description}`);
    }
  }
  lines.push('');

  if (plan.newFilesToCreate.length > 0) {
    lines.push('### New Files to Create');
    for (const f of plan.newFilesToCreate) {
      lines.push(`- \`${f.path}\` — ${f.description}`);
    }
    lines.push('');
  }

  if (plan.testFilesToCreate.length > 0) {
    lines.push('### Test Files');
    for (const f of plan.testFilesToCreate) {
      lines.push(`- \`${f.path}\` — ${f.description}`);
    }
    lines.push('');
  }

  if (plan.warnings.length > 0) {
    lines.push('### Warnings');
    for (const w of plan.warnings) {
      lines.push(`- ${w}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

module.exports = {
  planRefactor,
  parsePlanResponse,
  renderPlanSummary,
  buildPollingToWebhookPrompt,
  buildInMemoryToStorePrompt,
  buildUntypedFetchToClientPrompt,
  PLAN_TIMEOUT_MS,
  MAX_EVIDENCE_FILES,
  MAX_FILE_PREVIEW_LINES,
};
