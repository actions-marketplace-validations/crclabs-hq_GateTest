/**
 * Architecture annotator.
 *
 * Phase 2.2 of THE FIX-FIRST BUILD PLAN. Second depth-deliverable
 * for the $199 Scan+Fix tier. After the per-finding fixes ship,
 * Claude reads the CODEBASE SHAPE — not just per-file — and produces
 * a "design observations" report covering things no per-file scanner
 * can see: layering violations, duplicated logic across files, god
 * objects, naming inconsistency, refactoring opportunities.
 *
 * Crucially this is REPORTED, not auto-fixed. The customer's senior
 * engineer reads the report and decides whether to act. We don't
 * pretend to refactor someone's architecture without their input.
 *
 * Pure JS, dependency-injected. The route imports this and provides
 * `askClaudeForArchitecture` (a thin wrapper around the existing
 * Anthropic call helper). Tests inject a stub.
 *
 * Output: a structured report with sections (summary, observations,
 * recommendations) plus the raw markdown body Claude wrote. The
 * orchestrator posts the markdown as a PR comment.
 *
 * Context-window discipline: we don't blast 10k files at Claude. The
 * annotator builds a SUMMARY of the codebase shape (file counts by
 * extension, top dirs, biggest files, import-graph stats), picks a
 * SAMPLE of the most architecturally significant files (largest +
 * most-imported), and sends only that to Claude. Default: 8 sampled
 * files, configurable.
 */

const { ANTI_INJECTION_PREAMBLE, wrapUntrusted, scanOutputForLeaks } = require('./prompt-injection-guard');

const DEFAULT_SAMPLE_COUNT = 8;
const DEFAULT_MAX_FILE_BYTES = 10_000;

const SOURCE_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.jsx',
  '.ts', '.mts', '.cts', '.tsx',
  '.py', '.go', '.rs', '.java', '.kt', '.rb', '.php', '.cs', '.swift',
]);

// Patterns must match the path SOMEWHERE — including paths that
// start with the excluded dir (no leading slash). Use `(?:^|\/)` so
// a path like `dist/bundle.js` matches as cleanly as `pkg/dist/bundle.js`.
const SKIP_PATH_PATTERNS = [
  /(?:^|\/)node_modules\//,
  /(?:^|\/)\.next\//,
  /(?:^|\/)dist\//,
  /(?:^|\/)build\//,
  /(?:^|\/)coverage\//,
  /(?:^|\/)vendor\//,
  /\.test\.[jt]sx?$/,
  /\.spec\.[jt]sx?$/,
  /\.min\.[jt]s$/,
];

/**
 * Decide whether a file is architecturally interesting (i.e. worth
 * sampling for Claude). Excludes deps, build output, tests,
 * minified bundles.
 */
function isArchitecturallyInteresting(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) return false;
  for (const skip of SKIP_PATH_PATTERNS) {
    if (skip.test(filePath)) return false;
  }
  const dotIdx = filePath.lastIndexOf('.');
  if (dotIdx === -1) return false;
  const ext = filePath.slice(dotIdx).toLowerCase();
  return SOURCE_EXTENSIONS.has(ext);
}

/**
 * Build a high-level structural summary of the codebase.
 * Returns counts and distributions Claude can reason about without
 * needing to see every file.
 */
function summariseCodebase(fileContents) {
  if (!Array.isArray(fileContents) || fileContents.length === 0) {
    return {
      totalFiles: 0,
      sourceFiles: 0,
      totalBytes: 0,
      topDirectories: [],
      extensionCounts: {},
      largestFiles: [],
    };
  }

  const sourceFiles = fileContents.filter((f) => f && f.path && isArchitecturallyInteresting(f.path));

  // Top-level directory counts (first path segment)
  const dirCounts = new Map();
  for (const f of sourceFiles) {
    const firstSlash = f.path.indexOf('/');
    const top = firstSlash > 0 ? f.path.slice(0, firstSlash) : '(root)';
    dirCounts.set(top, (dirCounts.get(top) || 0) + 1);
  }
  const topDirectories = [...dirCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([dir, count]) => ({ dir, count }));

  // Extension counts
  const extCounts = new Map();
  for (const f of sourceFiles) {
    const dotIdx = f.path.lastIndexOf('.');
    const ext = dotIdx >= 0 ? f.path.slice(dotIdx).toLowerCase() : '(none)';
    extCounts.set(ext, (extCounts.get(ext) || 0) + 1);
  }
  const extensionCounts = Object.fromEntries(
    [...extCounts.entries()].sort((a, b) => b[1] - a[1])
  );

  // Largest files
  const largestFiles = [...sourceFiles]
    .sort((a, b) => (b.content?.length || 0) - (a.content?.length || 0))
    .slice(0, 20)
    .map((f) => ({ path: f.path, bytes: (f.content || '').length }));

  const totalBytes = sourceFiles.reduce((sum, f) => sum + (f.content?.length || 0), 0);

  return {
    totalFiles: fileContents.length,
    sourceFiles: sourceFiles.length,
    totalBytes,
    topDirectories,
    extensionCounts,
    largestFiles,
  };
}

/**
 * Pick a representative sample of files for Claude to actually read.
 * Strategy: take the N largest source files (these are usually the
 * architecturally significant ones — entry points, core modules, big
 * runners). Cap each file at maxFileBytes so a single huge file
 * doesn't burn the budget.
 */
function pickSampleFiles(fileContents, count = DEFAULT_SAMPLE_COUNT, maxFileBytes = DEFAULT_MAX_FILE_BYTES) {
  if (!Array.isArray(fileContents)) return [];
  const candidates = fileContents
    .filter((f) => f && f.path && isArchitecturallyInteresting(f.path) && typeof f.content === 'string')
    .sort((a, b) => b.content.length - a.content.length)
    .slice(0, count);
  return candidates.map((f) => ({
    path: f.path,
    content: f.content.slice(0, maxFileBytes),
    truncated: f.content.length > maxFileBytes,
    originalBytes: f.content.length,
  }));
}

/**
 * Build the prompt for the architecture-annotator agent. Exposed
 * for tests so the prompt shape can be asserted.
 */
function buildArchitecturePrompt({ summary, sampleFiles, repoUrl }) {
  const summaryBody = `Total files: ${summary.totalFiles}
Source files: ${summary.sourceFiles}
Total source bytes: ${summary.totalBytes}
Top directories: ${summary.topDirectories.map((d) => `${d.dir} (${d.count} files)`).join(', ') || '(none)'}
File types: ${Object.entries(summary.extensionCounts).map(([k, v]) => `${k}=${v}`).join(', ') || '(none)'}
Largest files (path, bytes):
${summary.largestFiles.slice(0, 10).map((f) => `  - ${f.path} (${f.bytes} bytes)`).join('\n') || '  (none)'}`;

  const summaryBlock = `CODEBASE SUMMARY:\n- Total files: ${summary.totalFiles}\n- Source files: ${summary.sourceFiles}\n${wrapUntrusted('summary', summaryBody)}`;

  const sampleBlock = sampleFiles.map((f) => {
    const truncationNote = f.truncated ? `\n[FILE TRUNCATED — showing first ${f.content.length} of ${f.originalBytes} bytes]` : '';
    return `### ${wrapUntrusted('path', f.path)}${truncationNote}\n${wrapUntrusted('file_content', f.content)}`;
  }).join('\n\n');

  const repoLine = repoUrl ? `\nREPO: ${wrapUntrusted('repo_url', repoUrl)}` : '';

  return `${ANTI_INJECTION_PREAMBLE}
You are the architecture-annotator agent for GateTest. You are NOT auto-fixing anything. You are reading the codebase shape and writing a "design observations" report for the customer's senior engineer.

Look for:
  - Layering violations (UI imports DB, route imports route, business logic in handlers)
  - Duplicated logic across files (the same thing implemented two ways)
  - God objects / oversized files (huge classes or files doing too much)
  - Inconsistent naming / inconsistent patterns across similar files
  - Refactoring opportunities (specific suggestions, not generic advice)
  - Things missing that you'd expect (e.g. a /api/users route with no input validation)

Do NOT:
  - Propose specific code changes
  - Write a 50-page treatise — keep it tight
  - Repeat findings the per-file scanner would have already caught (lint, secrets, syntax). This report is for things the per-file scanner CANNOT see
  - Make up file paths that aren't in the sample below
${repoLine}
${summaryBlock}

SAMPLE FILES (the architecturally significant ones — largest first; files truncated where noted):

${sampleBlock || '(no sample files available)'}

Output format — STRICTLY this exact shape, no markdown fences around the whole response:

# Architecture observations

## Summary
<2-3 sentence overall read on the codebase>

## Observations
1. **<Title>** — <one paragraph describing what you see and why it matters. Reference specific file paths from the sample where possible.>
2. **<Title>** — <...>
(3-7 observations total. Don't pad — fewer high-quality observations beat many generic ones.)

## Recommendations
- <One-line recommendation, prioritised. 3-7 items. Each must be actionable, not platitude.>

If the sample is too small to draw architectural conclusions (e.g. fewer than 3 source files), output exactly:
SKIP: codebase too small to assess architecture (need at least 3 source files)`;
}

/**
 * Parse the architecture annotator's output. Returns either the
 * structured report or an error reason. Permissive parser — Claude's
 * markdown is allowed to have minor formatting variation.
 */
function parseArchitectureOutput(raw) {
  if (typeof raw !== 'string') return { ok: false, reason: 'response was not a string' };
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'empty response' };

  if (/^SKIP\b/i.test(trimmed)) {
    const reason = trimmed.replace(/^SKIP:?\s*/i, '').split('\n', 1)[0].trim() || 'annotator declined';
    return { ok: false, reason: `annotator declined: ${reason}` };
  }
  if (/^I (cannot|can't|won't)\b|^I'm unable to\b|^As an AI\b/.test(trimmed)) {
    return { ok: false, reason: 'annotator refused' };
  }

  // Must contain at least the three section headers
  const hasSummary = /##\s+Summary\b/i.test(trimmed);
  const hasObservations = /##\s+Observations\b/i.test(trimmed);
  const hasRecs = /##\s+Recommendations\b/i.test(trimmed);
  if (!hasSummary || !hasObservations || !hasRecs) {
    return { ok: false, reason: `missing required section(s): ${[!hasSummary && 'Summary', !hasObservations && 'Observations', !hasRecs && 'Recommendations'].filter(Boolean).join(', ')}` };
  }

  if (trimmed.length < 200) {
    return { ok: false, reason: 'report too short to be useful' };
  }

  // Strip leading/trailing markdown fences if Claude added them despite
  // instructions
  let body = trimmed.replace(/^```[\w]*\n?/, '').replace(/\n?```\s*$/, '');

  return { ok: true, body };
}

/**
 * Run the architecture annotator end-to-end.
 *
 * @param {Object} opts
 * @param {Array<{ path, content }>} opts.fileContents
 * @param {(prompt: string) => Promise<string>} opts.askClaudeForArchitecture
 * @param {string} [opts.repoUrl]
 * @param {number} [opts.sampleCount]
 * @param {number} [opts.maxFileBytes]
 * @returns {Promise<{
 *   ok: boolean,
 *   body: string | null,        // markdown ready to post as PR comment
 *   summary: object | null,     // structural summary used to build the prompt
 *   sampleFiles: Array<{ path, bytes }> | null,  // metadata of what we sampled
 *   reason: string | null,      // populated on failure
 * }>}
 */
async function annotateArchitecture(opts) {
  const {
    fileContents,
    askClaudeForArchitecture,
    repoUrl,
    sampleCount = DEFAULT_SAMPLE_COUNT,
    maxFileBytes = DEFAULT_MAX_FILE_BYTES,
  } = opts || {};

  if (!Array.isArray(fileContents)) throw new TypeError('fileContents must be an array');
  if (typeof askClaudeForArchitecture !== 'function') throw new TypeError('askClaudeForArchitecture must be a function');

  const summary = summariseCodebase(fileContents);
  if (summary.sourceFiles < 3) {
    return {
      ok: false,
      body: null,
      summary,
      sampleFiles: null,
      reason: `codebase too small (${summary.sourceFiles} source files; need ≥ 3)`,
    };
  }

  const sample = pickSampleFiles(fileContents, sampleCount, maxFileBytes);
  if (sample.length === 0) {
    return {
      ok: false,
      body: null,
      summary,
      sampleFiles: null,
      reason: 'no architecturally interesting files to sample',
    };
  }

  const prompt = buildArchitecturePrompt({ summary, sampleFiles: sample, repoUrl });

  let raw;
  try {
    raw = await askClaudeForArchitecture(prompt);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    return {
      ok: false,
      body: null,
      summary,
      sampleFiles: sample.map((s) => ({ path: s.path, bytes: s.originalBytes })),
      reason: `Claude API error: ${message}`,
    };
  }

  const leakScan = scanOutputForLeaks(raw);
  if (!leakScan.safe) {
    const ids = leakScan.leaks.map((l) => l.id).join(', ');
    return {
      ok: false,
      body: null,
      summary,
      sampleFiles: sample.map((s) => ({ path: s.path, bytes: s.originalBytes })),
      reason: `output suppressed — leak detected: ${ids}`,
    };
  }
  raw = leakScan.redacted;

  const parsed = parseArchitectureOutput(raw);
  if (!parsed.ok) {
    return {
      ok: false,
      body: null,
      summary,
      sampleFiles: sample.map((s) => ({ path: s.path, bytes: s.originalBytes })),
      reason: parsed.reason,
    };
  }

  return {
    ok: true,
    body: parsed.body,
    summary,
    sampleFiles: sample.map((s) => ({ path: s.path, bytes: s.originalBytes })),
    reason: null,
  };
}

/**
 * Render the architecture report as a markdown PR comment, with a
 * GateTest-branded header and footer.
 */
function renderArchitectureComment(annotationResult) {
  if (!annotationResult || !annotationResult.ok || !annotationResult.body) {
    const reason = annotationResult?.reason || 'no report generated';
    return `## GateTest Architecture Observations\n\n*Architecture report not generated this run — ${reason}.*`;
  }
  const sampleNote = annotationResult.sampleFiles && annotationResult.sampleFiles.length > 0
    ? `\n\n<sub>Sampled ${annotationResult.sampleFiles.length} of ${annotationResult.summary?.sourceFiles ?? '?'} source files for this analysis (largest first).</sub>`
    : '';
  const footer = `\n\n---\n\n<sub>Architecture observations are part of the <a href="https://gatetest.ai">GateTest $199 Scan + Fix</a> tier. This report is INFORMATIONAL — GateTest never auto-refactors your architecture. Your senior engineer decides whether to act on these observations.</sub>${sampleNote}`;
  return annotationResult.body + footer;
}

module.exports = {
  annotateArchitecture,
  renderArchitectureComment,
  // Exported for tests / advanced callers.
  isArchitecturallyInteresting,
  summariseCodebase,
  pickSampleFiles,
  buildArchitecturePrompt,
  parseArchitectureOutput,
};
