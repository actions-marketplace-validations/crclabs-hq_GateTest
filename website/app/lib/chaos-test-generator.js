/**
 * Phase 6.2.9 — chaos-test generator.
 *
 * Sister to test-generator / property-test-generator / perf-benchmark-
 * generator. Where those answer "is the fix correct?" / "did we miss
 * an edge case?" / "is it fast?", chaos answers **"does the fix
 * survive degraded conditions?"** — slow network, dropped responses,
 * intermittent failures, timeouts, partial JSON.
 *
 * For Nuclear-tier fixes that touch network / async I/O / file ops,
 * we ask Claude to write a node:test file that mocks the relevant
 * surface (fetch / timers / fs) to inject failures, then asserts the
 * fix degrades gracefully — retries, backs off, returns a sensible
 * fallback rather than throwing unhandled.
 *
 * RELIABILITY CONTRACT (mirrors prior generators):
 *   - Per-fix failures NEVER block the underlying fix from shipping
 *   - Resilience-relevance heuristic — only generate chaos tests for
 *     sources that contain at least one of: fetch, await, axios,
 *     setTimeout, Promise pattern, fs operation, .retry/.timeout
 *     pattern, or DB-shaped call. Pure constants / type-only files
 *     skip silently
 *   - JS/TS only today (Python chaos via pytest-asyncio is a future
 *     sub-task)
 *   - Caps at maxFixes=4 (one fewer than other generators because
 *     chaos prompts are heavier — full mock setup + assertion code)
 *
 * Pure / dependency-injected `askClaude`. Tests inject a fake-Claude.
 */

const DEFAULT_MAX_FIXES = 4;
const TESTABLE_EXTS = new Set(['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts']);
const NON_TESTABLE_PATHS = [
  /\.test\./,
  /\.spec\./,
  /\.snap$/,
  /\.d\.ts$/,
  /(?:^|\/)__tests__\//,
  /(?:^|\/)tests?\//,
  /\.config\./,
  /\.json$/,
  /\.md$/,
  /\.gitignore$/,
  /\.env/,
  /^\./,
];

/**
 * Resilience-relevant patterns. These are sources where the fix
 * could plausibly need degraded-condition testing — they make
 * external calls, schedule work, or touch I/O. A mismatched fix
 * (e.g. a pure utility function) silently skips.
 */
const RESILIENCE_PATTERNS = [
  /\bfetch\s*\(/,
  /\baxios\b/,
  /\bgot\s*\(/,
  /\bhttp\.request\b/,
  /\bhttps\.request\b/,
  /\bawait\b/,
  /\.then\s*\(/,
  /\bsetTimeout\s*\(/,
  /\bsetInterval\s*\(/,
  /\bnew\s+Promise\b/,
  /\bfs\.[a-zA-Z]+\s*\(/,
  /\bfs\/promises\b/,
  /\.retry\s*\(/,
  /\.timeout\s*\(/,
  /\bWebSocket\b/,
  /\bEventSource\b/,
  /\bprisma\./,
  /\bsequelize\./,
  /\bdb\.query\b/,
];

function looksResilienceRelevant(fixedContent) {
  if (typeof fixedContent !== 'string' || fixedContent.length === 0) return false;
  for (const pat of RESILIENCE_PATTERNS) {
    if (pat.test(fixedContent)) return true;
  }
  return false;
}

function isChaosTestableFix(fix) {
  if (!fix || typeof fix.file !== 'string') return false;
  if (!fix.fixed || typeof fix.fixed !== 'string') return false;
  if (!fix.original || fix.original === '') return false;
  const lower = fix.file.toLowerCase();
  for (const pattern of NON_TESTABLE_PATHS) {
    if (pattern.test(lower)) return false;
  }
  const dotIdx = lower.lastIndexOf('.');
  if (dotIdx < 0) return false;
  const ext = lower.slice(dotIdx + 1);
  if (!TESTABLE_EXTS.has(ext)) return false;
  return looksResilienceRelevant(fix.fixed);
}

function buildChaosTestPath(sourcePath) {
  const ext = sourcePath.match(/\.(tsx?|mts|cts)$/i) ? 'ts' : 'js';
  const flat = sourcePath.replace(/^\/+/, '').replace(/\//g, '__').replace(/\.[^.]+$/, '');
  return `tests/auto-generated/chaos/${flat}.chaos.${ext}`;
}

function buildChaosTestPrompt({ filePath, fixedContent, issues }) {
  return `You are writing a CHAOS / RESILIENCE test for code that was just
auto-fixed. The goal is to assert the fix degrades gracefully under
realistic failure conditions — slow network, dropped responses,
timeouts, intermittent errors — rather than throwing unhandled.

FILE: ${filePath}
ISSUES THAT WERE FIXED:
${(issues || []).map((i, idx) => `${idx + 1}. ${i}`).join('\n')}

FIXED SOURCE:
\`\`\`
${fixedContent}
\`\`\`

REQUIREMENTS:
- Use \`node:test\` as the runner (zero-config, no jest/vitest setup needed).
- Mock the relevant surface YOUR fix interacts with using only Node's
  built-ins or @std/mock / sinon (do not assume jest globals exist).
  Common mocks needed: \`globalThis.fetch\`, \`setTimeout\`, \`fs.promises.*\`.
  ALWAYS restore the original at the end of each test.
- Cover at least 2 of these failure modes (more is better):
  * Slow network — fetch resolves after a long delay
  * Dropped response — fetch rejects with NetworkError
  * Timeout — operation never resolves
  * Partial / malformed JSON
  * Intermittent failure — fails first N calls then succeeds
- Each assertion must verify the function either returns a sensible
  fallback OR retries / backs off. A test that asserts the function
  THROWS under chaos is acceptable IF the fix's contract is "let it
  throw and the caller handles it" — but it must be explicit, not
  accidental.
- Output ONLY the test file content. No explanations. No markdown fences.
- If the fix doesn't actually depend on resilience-sensitive surface
  (e.g. pure data-transformation function), output exactly:
  SKIP: <one-line reason>`;
}

async function generateChaosTestForFix(opts) {
  const { fix, askClaudeForChaos } = opts || {};
  if (!isChaosTestableFix(fix)) {
    return {
      ok: false,
      skipped: true,
      reason: 'not chaos-testable (no resilience-relevant surface or wrong extension)',
      sourceFile: fix?.file || null,
    };
  }
  if (typeof askClaudeForChaos !== 'function') {
    return { ok: false, skipped: true, reason: 'no Claude wrapper supplied', sourceFile: fix.file };
  }

  const prompt = buildChaosTestPrompt({
    filePath: fix.file,
    fixedContent: fix.fixed,
    issues: fix.issues || [],
  });

  let raw;
  try {
    raw = await askClaudeForChaos(prompt);
  } catch (err) {
    return {
      ok: false,
      skipped: true,
      reason: `Claude error: ${err && err.message ? err.message : String(err)}`,
      sourceFile: fix.file,
    };
  }

  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { ok: false, skipped: true, reason: 'empty Claude output', sourceFile: fix.file };
  }

  const trimmed = raw.trim();
  if (/^SKIP\b/i.test(trimmed)) {
    const reason = trimmed.replace(/^SKIP:?\s*/i, '').split('\n', 1)[0].trim();
    return {
      ok: false,
      skipped: true,
      reason: `model declined: ${reason || 'no reason given'}`,
      sourceFile: fix.file,
    };
  }

  const content = trimmed.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '').trim();

  // Sanity: must reference node:test AND must demonstrate a mock
  // (any of: globalThis.fetch override, setTimeout override, sinon,
  // mock.method, stub). Bare smoke tests that don't inject failure
  // are rejected — defeats the point of the chaos sub-task.
  if (!/node:test|describe|it\(|test\(/i.test(content)) {
    return {
      ok: false,
      skipped: true,
      reason: 'output did not use a recognised test runner',
      sourceFile: fix.file,
    };
  }
  if (!/(globalThis\.fetch|global\.fetch|sinon|mock\.|stub|setTimeout|fs\.|throw\s+new)/.test(content)) {
    return {
      ok: false,
      skipped: true,
      reason: 'output did not include a recognisable failure injection (mock / stub / throw / timer override)',
      sourceFile: fix.file,
    };
  }

  return {
    ok: true,
    path: buildChaosTestPath(fix.file),
    content,
    sourceFile: fix.file,
  };
}

async function generateChaosTestsForFixes(opts) {
  const { fixes, askClaudeForChaos, maxFixes = DEFAULT_MAX_FIXES } = opts || {};
  if (!Array.isArray(fixes)) return { tests: [], skipped: [], summary: 'no fixes provided' };
  if (typeof askClaudeForChaos !== 'function') {
    return {
      tests: [],
      skipped: fixes.map((f) => ({ sourceFile: f?.file || null, reason: 'no Claude wrapper' })),
      summary: 'no Claude wrapper provided',
    };
  }

  const tests = [];
  const skipped = [];
  const sliced = fixes.slice(0, maxFixes);
  for (const fix of sliced) {
    const result = await generateChaosTestForFix({ fix, askClaudeForChaos });
    if (result.ok) {
      tests.push({ path: result.path, content: result.content, sourceFile: result.sourceFile });
    } else {
      skipped.push({ sourceFile: result.sourceFile, reason: result.reason });
    }
  }

  const overflow = fixes.length - sliced.length;
  const summary = overflow > 0
    ? `Chaos tests: ${tests.length} generated, ${skipped.length} skipped, ${overflow} additional fixes deferred (over ${maxFixes}-fix cap)`
    : `Chaos tests: ${tests.length} generated, ${skipped.length} skipped`;
  return { tests, skipped, summary };
}

module.exports = {
  DEFAULT_MAX_FIXES,
  TESTABLE_EXTS,
  RESILIENCE_PATTERNS,
  looksResilienceRelevant,
  isChaosTestableFix,
  buildChaosTestPath,
  buildChaosTestPrompt,
  generateChaosTestForFix,
  generateChaosTestsForFixes,
};
