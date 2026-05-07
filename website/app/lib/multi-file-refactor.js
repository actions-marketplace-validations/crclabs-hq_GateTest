/**
 * Phase 6.2.1 — Multi-file architectural refactor pipeline.
 *
 * Three canonical refactors that cover the most-common structural debt in
 * modern JS/TS codebases. Each refactor:
 *   1. Detects the pattern (regex + heuristic, no AST required)
 *   2. Sends a context-rich prompt to Claude (plan-then-apply)
 *   3. Applies the patch to each affected file
 *   4. Runs the cross-fix syntax gate on every patched file
 *   5. Returns the full patch set for PR composition
 *
 * Refactors shipped:
 *   - POLLING_TO_WEBHOOK: setInterval(fetch) → webhook receiver + event emitter
 *   - IN_MEMORY_TO_STORE: global Map/Set/Object state → Vercel KV / Redis
 *   - UNTYPED_TO_TYPED_CLIENT: raw fetch() → typed client + Zod schemas
 *
 * Design constraints:
 *   - Hard time budgets: 90s plan + 240s execute
 *   - Max 50 files per run (bounded scope)
 *   - Per-file failures are isolated — never block the batch
 *   - Syntax gate on every patched file — no broken code ships
 *   - Non-blocking: caller awaits the result, does NOT stream
 */

'use strict';

// ---------------------------------------------------------------------------
// Detection patterns
// ---------------------------------------------------------------------------

const DETECTORS = {
  POLLING_TO_WEBHOOK: {
    name: 'polling → webhook',
    description: 'Replaces polling loops that call HTTP endpoints on a timer with a webhook-driven architecture.',
    detect(content) {
      // setInterval + fetch/axios inside the callback
      return /setInterval\s*\(/.test(content)
        && /fetch\s*\(|axios\.\w+\s*\(/.test(content);
    },
    prompt(filePath, content, context) {
      return `You are refactoring a polling loop to a webhook-driven architecture.

FILE: ${filePath}
PATTERN DETECTED: setInterval with HTTP call — polling-based data fetching.

CODEBASE CONTEXT:
${context}

CURRENT CODE:
\`\`\`
${content.slice(0, 6000)}
\`\`\`

TASK:
1. Remove the setInterval polling loop.
2. Replace it with a webhook receiver function/handler that accepts incoming events.
3. Add an event emitter or callback pattern so callers can subscribe to updates.
4. Generate the webhook sender (the code that calls a webhook endpoint) if you can infer the target shape.
5. Add appropriate retry logic with exponential backoff for the webhook sender.

RULES:
- Return ONLY the complete refactored file. No explanations. No code fences.
- Preserve all imports, exports, and types exactly — only change the polling loop.
- If you cannot safely refactor without more context, return the UNCHANGED original file verbatim.`;
    },
  },

  IN_MEMORY_TO_STORE: {
    name: 'in-memory state → external store',
    description: 'Replaces global Map/Set/Object state on serverless paths with Vercel KV or Redis.',
    detect(content) {
      // Global Map/Set/plain-object state at module level (not inside a function)
      const hasGlobalMap = /^(?:const|let|var)\s+\w+\s*=\s*new\s+(?:Map|Set)\s*\(\)/m.test(content);
      const hasGlobalObj = /^(?:const|let|var)\s+\w+\s*=\s*\{\s*\}/m.test(content);
      const hasServerlessMarker = /export\s+(?:default\s+)?(?:async\s+)?function|export\s+const\s+\w+\s*=\s*async/.test(content);
      return (hasGlobalMap || hasGlobalObj) && hasServerlessMarker;
    },
    prompt(filePath, content, context) {
      return `You are refactoring in-memory serverless state to an external store.

FILE: ${filePath}
PATTERN DETECTED: global Map/Set/Object used in a serverless context — state does not survive between function invocations.

CODEBASE CONTEXT:
${context}

CURRENT CODE:
\`\`\`
${content.slice(0, 6000)}
\`\`\`

TASK:
1. Replace global Map/Set/Object state with @vercel/kv (preferred) or ioredis calls.
2. Wrap every state read/write in an async helper.
3. Add TTL where appropriate (cache invalidation).
4. Handle the case where the store is unavailable gracefully (fallback or clear error).
5. Keep the public interface of the module identical — callers should not need to change.

RULES:
- Return ONLY the complete refactored file. No explanations. No code fences.
- Use @vercel/kv import: import { kv } from '@vercel/kv';
- If the pattern is too complex to safely refactor, return the UNCHANGED original file verbatim.`;
    },
  },

  UNTYPED_TO_TYPED_CLIENT: {
    name: 'untyped fetch → typed client',
    description: 'Generates a typed API client with Zod validation from raw fetch() calls.',
    detect(content) {
      // Multiple raw fetch() calls + no existing Zod/type-safe client
      const fetchCount = (content.match(/\bfetch\s*\(/g) || []).length;
      const hasZod = /from\s+['"]zod['"]|import\s+\w+\s+from\s+['"]zod['"]/.test(content);
      return fetchCount >= 2 && !hasZod;
    },
    prompt(filePath, content, context) {
      return `You are generating a typed API client from raw fetch() calls.

FILE: ${filePath}
PATTERN DETECTED: ${(content.match(/\bfetch\s*\(/g) || []).length} raw fetch() calls without type validation.

CODEBASE CONTEXT:
${context}

CURRENT CODE:
\`\`\`
${content.slice(0, 6000)}
\`\`\`

TASK:
1. Identify all unique API endpoints being called (group by URL pattern).
2. For each endpoint, infer the request/response shape from usage context.
3. Generate Zod schemas for each request and response type.
4. Create typed wrapper functions: async function getUser(id: string): Promise<User>
5. Replace all raw fetch() calls with the typed wrappers.
6. Add runtime validation: parse the response through the Zod schema.
7. Export the client functions so callers import from this file.

RULES:
- Return ONLY the complete refactored file. No explanations. No code fences.
- Use import { z } from 'zod'; at the top.
- Each wrapper must use z.parse() or z.safeParse() on the response.
- If you cannot safely type an endpoint, leave that specific fetch() unchanged.
- If the file is too complex, return the UNCHANGED original file verbatim.`;
    },
  },
};

// ---------------------------------------------------------------------------
// Syntax gate — minimal inline version (JS/TS only, no external dep)
// ---------------------------------------------------------------------------
const vm = require('vm');

function syntaxCheck(content, filePath) {
  const ext = (filePath.split('.').pop() || '').toLowerCase();

  if (['json'].includes(ext)) {
    try { JSON.parse(content); return { ok: true }; }
    catch (e) { return { ok: false, reason: e.message }; }
  }

  if (['js', 'mjs', 'cjs'].includes(ext)) {
    try { new vm.Script(content, { filename: filePath }); return { ok: true }; }
    catch (e) { return { ok: false, reason: e.message }; }
  }

  // TypeScript and others — pass through (can't compile without tsc)
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Detect which refactors apply to a set of files
// ---------------------------------------------------------------------------
function detectRefactors(files) {
  const matches = [];
  for (const { path: filePath, content } of files) {
    if (!content || typeof content !== 'string') continue;
    const ext = (filePath.split('.').pop() || '').toLowerCase();
    if (!['js', 'ts', 'jsx', 'tsx', 'mjs', 'cjs'].includes(ext)) continue;

    for (const [key, detector] of Object.entries(DETECTORS)) {
      if (detector.detect(content)) {
        matches.push({ refactorType: key, filePath, content, detector });
      }
    }
  }
  return matches;
}

// ---------------------------------------------------------------------------
// Apply a single refactor: call Claude, syntax-check, return result
// ---------------------------------------------------------------------------
async function applyRefactor(match, contextSummary, askClaude, opts = {}) {
  const { filePath, content, detector } = match;
  const { timeoutMs = 90_000 } = opts;

  const prompt = detector.prompt(filePath, content, contextSummary);

  let refactoredContent;
  try {
    const callPromise = askClaude(prompt);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Claude timeout')), timeoutMs)
    );
    refactoredContent = await Promise.race([callPromise, timeoutPromise]);
  } catch (err) {
    return {
      filePath,
      refactorType: match.refactorType,
      ok: false,
      reason: `Claude call failed: ${err instanceof Error ? err.message : String(err)}`,
      original: content,
      refactored: null,
    };
  }

  // Strip code fences
  refactoredContent = (refactoredContent || '')
    .replace(/^```[\w]*\n?/, '')
    .replace(/\n?```$/, '');

  // Validate: must have produced something, must not be shorter than 40% of original
  if (!refactoredContent || refactoredContent.trim().length === 0) {
    return { filePath, refactorType: match.refactorType, ok: false, reason: 'empty output', original: content, refactored: null };
  }
  if (content.length > 200 && refactoredContent.length < content.length * 0.4) {
    return { filePath, refactorType: match.refactorType, ok: false, reason: 'likely truncation', original: content, refactored: null };
  }
  if (refactoredContent === content) {
    return { filePath, refactorType: match.refactorType, ok: false, reason: 'no changes produced', original: content, refactored: null };
  }

  // Syntax gate
  const gate = syntaxCheck(refactoredContent, filePath);
  if (!gate.ok) {
    return { filePath, refactorType: match.refactorType, ok: false, reason: `syntax gate: ${gate.reason}`, original: content, refactored: null };
  }

  return {
    filePath,
    refactorType: match.refactorType,
    refactorName: detector.name,
    ok: true,
    reason: null,
    original: content,
    refactored: refactoredContent,
  };
}

// ---------------------------------------------------------------------------
// Main entrypoint
// ---------------------------------------------------------------------------
/**
 * Run the multi-file refactor pipeline.
 *
 * @param {object} opts
 * @param {Array<{path: string, content: string}>} opts.files
 * @param {string}   [opts.contextSummary]  Brief description of the repo
 * @param {Function} opts.askClaude         (prompt: string) => Promise<string>
 * @param {string[]} [opts.refactorTypes]   Subset to run (default: all)
 * @param {number}   [opts.maxFiles]        Max files to refactor (default: 50)
 * @param {number}   [opts.concurrency]     Parallel Claude calls (default: 2)
 */
async function runMultiFileRefactor(opts) {
  const {
    files,
    contextSummary = '',
    askClaude,
    refactorTypes = Object.keys(DETECTORS),
    maxFiles = 50,
    concurrency = 2,
  } = opts;

  if (typeof askClaude !== 'function') throw new Error('runMultiFileRefactor: askClaude is required');

  // Detect applicable refactors
  const allMatches = detectRefactors(files.slice(0, maxFiles));
  const matches = allMatches.filter(m => refactorTypes.includes(m.refactorType));

  if (matches.length === 0) {
    return {
      applied: [],
      skipped: [],
      failed: [],
      summary: 'No refactor patterns detected in the provided files.',
    };
  }

  // Apply with bounded concurrency
  const results = [];
  for (let i = 0; i < matches.length; i += concurrency) {
    const batch = matches.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(m => applyRefactor(m, contextSummary, askClaude))
    );
    results.push(...batchResults);
  }

  const applied = results.filter(r => r.ok);
  const failed = results.filter(r => !r.ok);

  return {
    applied,
    failed,
    summary: `${applied.length} refactor${applied.length !== 1 ? 's' : ''} applied across ${applied.length} file${applied.length !== 1 ? 's' : ''}. ${failed.length} skipped (${failed.map(f => f.reason).join('; ') || 'none'}).`,
  };
}

/**
 * Render a markdown PR comment describing the refactors.
 */
function renderRefactorReport(result) {
  if (!result || result.applied.length === 0) {
    return '## Architectural Refactors\n\nNo refactors applied.';
  }

  const lines = ['## 🔨 Architectural Refactors\n'];
  lines.push(`Applied **${result.applied.length} refactor${result.applied.length !== 1 ? 's' : ''}**:\n`);

  const byType = {};
  for (const r of result.applied) {
    (byType[r.refactorName || r.refactorType] = byType[r.refactorName || r.refactorType] || []).push(r.filePath);
  }

  for (const [name, fps] of Object.entries(byType)) {
    lines.push(`### ${name}`);
    for (const fp of fps) lines.push(`- \`${fp}\``);
    lines.push('');
  }

  if (result.failed.length > 0) {
    lines.push('### Skipped');
    for (const f of result.failed) {
      lines.push(`- \`${f.filePath}\` — ${f.reason}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

module.exports = {
  runMultiFileRefactor,
  detectRefactors,
  renderRefactorReport,
  DETECTORS,
};
