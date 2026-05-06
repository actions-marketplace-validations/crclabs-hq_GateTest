'use strict';

/**
 * Phase 5.4 / Phase 6.2.1 — Multi-file architectural refactor detector.
 *
 * Pure static analysis: no Claude, no network calls.
 * Detects three canonical refactor opportunities across a codebase:
 *
 *   1. polling-to-webhook     — setInterval/setTimeout + HTTP (should be a webhook receiver)
 *   2. in-memory-to-store     — module-level Map/Set/Object in serverless files (lost on restart)
 *   3. untyped-fetch-to-client — raw fetch/axios without typed wrapper (type safety gap)
 *
 * Returns RefactorCandidate[] sorted by severity (high → medium → low).
 */

const MAX_FILES = 100;
const MAX_FILE_BYTES = 100 * 1024;

// ─── Pattern libraries ────────────────────────────────────────────────────────

const POLLING_PATTERNS = {
  interval: [
    /\bsetInterval\s*\(/,
    /\bsetTimeout\s*\(/,
    /\bschedule\s*\(/,
  ],
  httpCall: [
    /\bfetch\s*\(/,
    /\baxios\s*\.\s*(?:get|post|put|patch|delete|request)\s*\(/,
    /\bhttp(?:s)?\s*\.\s*(?:get|request)\s*\(/,
    /\bgot\s*\s*\(/,
    /\bneedle\s*\.\s*(?:get|post|request)\s*\(/,
    /\bsuperagent\s*\./,
    /\bundici\s*\./,
  ],
  pollingLoop: [
    /while\s*\(\s*true\s*\)/,
    /for\s*\(\s*;;\s*\)/,
    /while\s*\(\s*running\s*\)/,
    /while\s*\(\s*isRunning\s*\)/,
    /while\s*\(\s*!stopped\s*\)/,
  ],
  sleepInLoop: [
    /\bawait\s+(?:sleep|delay|wait|setTimeout|new\s+Promise)\s*\(/,
  ],
};

const IN_MEMORY_PATTERNS = {
  globalState: [
    /^(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*new\s+Map\s*\(/m,
    /^(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*new\s+Set\s*\(/m,
    /^(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*new\s+WeakMap\s*\(/m,
    /^(?:export\s+)?(?:const|let|var)\s+\w+Cache\s*=\s*\{/m,
    /^(?:export\s+)?(?:const|let|var)\s+\w+Store\s*=\s*\{/m,
    /^(?:export\s+)?(?:const|let|var)\s+\w+State\s*=\s*\{/m,
  ],
  serverlessIndicators: [
    /export\s+(?:async\s+)?function\s+(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*\(/,
    /export\s+(?:const|default)\s+(?:handler|default)\s*=/,
    /module\.exports\s*=\s*(?:async\s+)?\([^)]*\)\s*=>/,
    /exports\.handler\s*=/,
    /NextApiRequest|NextRequest/,
  ],
};

const UNTYPED_FETCH_PATTERNS = {
  rawFetch: [
    /\bfetch\s*\(\s*['"`][^'"`]+['"`]/,
    /\bfetch\s*\(\s*`[^`]+`\s*[,)]/,
    /\baxios\s*\.\s*(?:get|post|put|patch|delete)\s*\(\s*['"`]/,
  ],
  internalApiIndicator: [
    /['"`]\/api\//,
    /['"`]https?:\/\/[^'"`]*\/api\//,
    /process\.env\.\w*(?:URL|HOST|ENDPOINT|BASE)/,
    /NEXT_PUBLIC_API/,
  ],
  typedClientPresent: [
    /createApiClient|ApiClient\b|apiClient\s*\.\s*\w+/,
    /\btrpc\s*\.\s*\w+/,
    /openapi-typescript|openapi-fetch/,
    /zodios|zod-fetch/,
  ],
};

// ─── Serverless context detection ─────────────────────────────────────────────

function isServerlessContext(filePath, content) {
  const fp = filePath.replace(/\\/g, '/');
  if (/app\/api\/.+\/route\.(ts|js|tsx|jsx)$/.test(fp)) return true;
  if (/pages\/api\/.+\.(ts|js)$/.test(fp)) return true;
  if (/api\/[^/]+\.(ts|js)$/.test(fp)) return true;
  if (/(?:lambda|functions?)\/[^/]+\.(?:ts|js)$/.test(fp)) return true;
  return IN_MEMORY_PATTERNS.serverlessIndicators.some((p) => p.test(content));
}

// ─── Detector: polling-to-webhook ─────────────────────────────────────────────

function detectPollingCandidates(sourceFiles) {
  const candidates = [];

  for (const { filePath, content } of sourceFiles) {
    const lines = content.split('\n');
    const hasInterval = POLLING_PATTERNS.interval.some((p) => p.test(content));
    const hasPollingLoop = POLLING_PATTERNS.pollingLoop.some((p) => p.test(content));
    const hasHttp = POLLING_PATTERNS.httpCall.some((p) => p.test(content));

    if (!hasHttp) continue;
    if (!hasInterval && !hasPollingLoop) continue;

    const evidence = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      if (POLLING_PATTERNS.interval.some((p) => p.test(line))) {
        const block = lines.slice(i, Math.min(i + 15, lines.length)).join('\n');
        if (POLLING_PATTERNS.httpCall.some((p) => p.test(block))) {
          evidence.push({ lineNumber: lineNum, evidence: line.trim() });
        }
      }

      if (POLLING_PATTERNS.pollingLoop.some((p) => p.test(line))) {
        const block = lines.slice(i, Math.min(i + 30, lines.length)).join('\n');
        const hasSleep = POLLING_PATTERNS.sleepInLoop.some((p) => p.test(block));
        const hasLoopHttp = POLLING_PATTERNS.httpCall.some((p) => p.test(block));
        if (hasSleep && hasLoopHttp) {
          evidence.push({ lineNumber: lineNum, evidence: line.trim() });
        }
      }
    }

    if (evidence.length > 0) {
      candidates.push({ filePath, evidence });
    }
  }

  if (candidates.length === 0) return null;

  return {
    type: 'polling-to-webhook',
    severity: 'high',
    description:
      'Found polling loops (setInterval/setTimeout + HTTP) that should be replaced with ' +
      'webhook receivers. Polling adds latency, wastes bandwidth, and fails under rate limits.',
    files: candidates,
    estimatedEffort: candidates.length > 3 ? 'large' : 'medium',
    benefit:
      'Reduces unnecessary HTTP calls, eliminates latency from poll interval, simplifies error handling.',
  };
}

// ─── Detector: in-memory-to-store ─────────────────────────────────────────────

function detectInMemoryCandidates(sourceFiles) {
  const candidates = [];

  for (const { filePath, content } of sourceFiles) {
    if (!isServerlessContext(filePath, content)) continue;

    const lines = content.split('\n');
    const evidence = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.search(/\S/) > 4) continue; // only top-level (module scope)
      if (IN_MEMORY_PATTERNS.globalState.some((p) => p.test(line))) {
        evidence.push({ lineNumber: i + 1, evidence: line.trim() });
      }
    }

    if (evidence.length > 0) {
      candidates.push({ filePath, evidence });
    }
  }

  if (candidates.length === 0) return null;

  return {
    type: 'in-memory-to-store',
    severity: 'high',
    description:
      'Found module-level Map/Set/Object in serverless function files. ' +
      'Serverless functions are stateless — memory is lost on cold starts and ' +
      'not shared across instances. Replace with Redis, Vercel KV, or Postgres.',
    files: candidates,
    estimatedEffort: 'medium',
    benefit:
      'Fixes silent data loss on cold starts, enables horizontal scaling, eliminates race conditions between instances.',
  };
}

// ─── Detector: untyped-fetch-to-client ────────────────────────────────────────

function detectUntypedFetchCandidates(sourceFiles) {
  const allFiles = [];

  for (const { filePath, content } of sourceFiles) {
    const fp = filePath.replace(/\\/g, '/');
    if (/\.(test|spec)\.(ts|js|tsx|jsx)$/.test(fp)) continue;
    if (/(?:config|setup|fixture)/.test(fp)) continue;

    if (UNTYPED_FETCH_PATTERNS.typedClientPresent.some((p) => p.test(content))) continue;

    const lines = content.split('\n');
    const evidence = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const hasRawFetch = UNTYPED_FETCH_PATTERNS.rawFetch.some((p) => p.test(line));
      if (!hasRawFetch) continue;
      const hasInternalApi = UNTYPED_FETCH_PATTERNS.internalApiIndicator.some((p) => p.test(line));
      if (!hasInternalApi) continue;
      evidence.push({ lineNumber: i + 1, evidence: line.trim() });
    }

    if (evidence.length > 0) {
      allFiles.push({ filePath, evidence });
    }
  }

  if (allFiles.length < 2) return null; // need 2+ files to justify a typed client

  return {
    type: 'untyped-fetch-to-client',
    severity: 'medium',
    description:
      `Found raw fetch/axios calls to internal APIs in ${allFiles.length} files without a typed client. ` +
      'Generate a typed API client with Zod schemas so every call site gets type safety and ' +
      'breaking API changes surface at compile time.',
    files: allFiles,
    estimatedEffort: allFiles.length > 5 ? 'large' : 'medium',
    benefit:
      'Eliminates runtime type errors, surfaces breaking API changes at compile time, centralises auth logic.',
  };
}

// ─── Main entry ───────────────────────────────────────────────────────────────

/**
 * Detect canonical refactor opportunities across a codebase.
 *
 * @param {Array<{filePath: string, content: string}>} sourceFiles
 * @returns {RefactorCandidate[]} sorted by severity (high → medium → low)
 */
function detectRefactors(sourceFiles) {
  const filtered = sourceFiles
    .filter(({ content }) => content && content.length <= MAX_FILE_BYTES)
    .slice(0, MAX_FILES);

  const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

  const results = [
    detectPollingCandidates(filtered),
    detectInMemoryCandidates(filtered),
    detectUntypedFetchCandidates(filtered),
  ].filter(Boolean);

  results.sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9));
  return results;
}

module.exports = {
  detectRefactors,
  detectPollingCandidates,
  detectInMemoryCandidates,
  detectUntypedFetchCandidates,
  isServerlessContext,
  POLLING_PATTERNS,
  IN_MEMORY_PATTERNS,
  UNTYPED_FETCH_PATTERNS,
  MAX_FILES,
  MAX_FILE_BYTES,
};
