/**
 * Phase 6.2.13 — security policy applier.
 *
 * The "shipped without the basics" problem: Express / Fastify / Next.js
 * apps go live missing helmet (CSP), csrf protection, and rate-limiting.
 * These aren't complex architectural decisions — they're 3-line middleware
 * installs. But nobody adds them retroactively, and they're the first
 * three items on every web-security checklist.
 *
 * This module automates the retroactive add:
 *   1. Scan source files for a recognisable framework entry point
 *      (app.js, server.js, middleware.ts, Next.js/Koa/Fastify patterns).
 *   2. Detect which of the three policies are already present.
 *   3. For each missing policy, ask Claude to produce a minimal patch
 *      that wires the middleware in correctly for the detected framework.
 *   4. Sanity-check the patch (must reference the policy being added,
 *      must be syntactically valid, must not remove existing middleware).
 *   5. Return patched files as { path, content, sourceFile, policies }
 *      objects the caller can fold into the PR.
 *
 * Designed for Nuclear-tier. Each entry point costs 1-3 Claude calls
 * (one per missing policy). Hard cap: MAX_FILES_PER_RUN entry files.
 *
 * RELIABILITY CONTRACT:
 *   - Per-policy failures caught in errors[]; never block other policies
 *     or other files.
 *   - Files that Claude can't safely patch (SKIP) surface in skipped[]
 *     as (info), not as failures.
 *   - If a file already has all three policies, it is skipped as
 *     'already-secured'.
 */

'use strict';

const MAX_FILES_PER_RUN = 3;
const MAX_FILE_BYTES = 80 * 1024; // 80KB

const SUPPORTED_EXTS = new Set(['js', 'mjs', 'cjs', 'ts', 'tsx']);

// Entry-point name patterns — files most likely to wire middleware
const ENTRY_POINT_PATTERNS = [
  /(?:^|\/)(?:app|server|index|main)\.[jt]sx?$/,
  /(?:^|\/)middleware\.[jt]sx?$/,
  /(?:^|\/)src\/(?:app|server|index)\.[jt]sx?$/,
];

// Framework detection patterns
const FRAMEWORK_PATTERNS = {
  express: [/\brequire\(['"]express['"]\)/, /\bfrom\s+['"]express['"]/, /express\(\)/],
  fastify: [/\brequire\(['"]fastify['"]\)/, /\bfrom\s+['"]fastify['"]/, /Fastify\(/],
  koa: [/\brequire\(['"]koa['"]\)/, /\bfrom\s+['"]koa['"]/, /new\s+Koa\(\)/],
  nextjs: [/NextResponse/, /NextRequest/, /from\s+['"]next\/server['"]/, /next\.config/],
  hono: [/\bfrom\s+['"]hono['"]/, /new\s+Hono\(\)/],
};

// Already-present policy detection
const POLICY_PRESENCE = {
  csp: [
    /\bhelmet\s*\(/, /content-security-policy/i, /cspHeader/i,
    /['"]Content-Security-Policy['"]/, /setHeader\s*\(\s*['"]csp/i,
    /\bcsp\s*[:(]/i, /next-safe/i,
  ],
  csrf: [
    /\bcsrf\b/, /\bcsurf\b/, /csrf-protection/i, /\bcsrftoken\b/i,
    /@fastify\/csrf/i, /doubleCsrf/i, /csrf\s*\(/,
  ],
  rateLimit: [
    /rate.?limit/i, /ratelimit/i, /express-rate-limit/i,
    /fastify-rate-limit/i, /upstash.*ratelimit/i, /bottleneck/i,
    /limitRate/i,
  ],
};

/**
 * Detect whether a file looks like a framework entry point.
 */
function isEntryPoint(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) return false;
  const norm = filePath.replace(/\\/g, '/');
  const ext = norm.split('.').pop()?.toLowerCase();
  if (!ext || !SUPPORTED_EXTS.has(ext)) return false;
  // Skip tests, types, build output
  if (/\.(?:test|spec)\.[jt]sx?$/.test(norm)) return false;
  if (/\.d\.ts$/.test(norm)) return false;
  if (/(?:^|\/)(?:node_modules|dist|build|\.next|coverage)\//.test(norm)) return false;
  return ENTRY_POINT_PATTERNS.some((p) => p.test(norm));
}

/**
 * Detect which framework is used in a file's content.
 * Returns the first match or 'unknown'.
 */
function detectFramework(content) {
  for (const [name, patterns] of Object.entries(FRAMEWORK_PATTERNS)) {
    if (patterns.some((p) => p.test(content))) return name;
  }
  return 'unknown';
}

/**
 * Detect which security policies are already present.
 * Returns a Set of present policy names.
 */
function detectPresentPolicies(content) {
  const present = new Set();
  for (const [policy, patterns] of Object.entries(POLICY_PRESENCE)) {
    if (patterns.some((p) => p.test(content))) {
      present.add(policy);
    }
  }
  return present;
}

/**
 * Build the Claude prompt to patch a file with missing security policies.
 */
function buildSecurityPolicyPrompt({ filePath, content, framework, missingPolicies }) {
  const policyDescriptions = {
    csp: `Content-Security-Policy (CSP) — add helmet() or equivalent CSP headers to prevent XSS and data injection attacks`,
    csrf: `CSRF protection — add csrf middleware to prevent Cross-Site Request Forgery attacks`,
    rateLimit: `Rate limiting — add rate-limit middleware to prevent brute-force and denial-of-service attacks`,
  };

  const frameworkInstructions = {
    express: `This is an Express.js application. Use:
- CSP: npm package "helmet" — app.use(helmet()) at the top of middleware chain
- CSRF: npm package "csrf-csrf" (doubleCsrf) or "csurf" — app.use(csrf())
- Rate limit: npm package "express-rate-limit" — const limiter = rateLimit({...}); app.use(limiter)`,
    fastify: `This is a Fastify application. Use:
- CSP: @fastify/helmet plugin — await fastify.register(require('@fastify/helmet'))
- CSRF: @fastify/csrf-protection plugin — await fastify.register(require('@fastify/csrf-protection'))
- Rate limit: @fastify/rate-limit plugin — await fastify.register(require('@fastify/rate-limit'), { max: 100, timeWindow: '1 minute' })`,
    nextjs: `This is a Next.js application. Use:
- CSP: Add headers in next.config.js or middleware.ts with Content-Security-Policy header
- CSRF: Use the "csrf-csrf" package or next-csrf in API routes / middleware
- Rate limit: Use Vercel KV + upstash/ratelimit or the "rate-limiter-flexible" package in middleware.ts`,
    koa: `This is a Koa application. Use:
- CSP: "koa-helmet" package — app.use(helmet())
- CSRF: "koa-csrf" package — app.use(csrf())
- Rate limit: "koa-ratelimit" package — app.use(ratelimit({...}))`,
    hono: `This is a Hono application. Use:
- CSP: The built-in secureHeaders middleware — app.use(secureHeaders())
- CSRF: hono/csrf middleware — app.use(csrf())
- Rate limit: @hono/rate-limiter or a custom Durable Object / KV backed limiter`,
    unknown: `This appears to be a web framework file. Add appropriate security middleware:
- CSP: Content-Security-Policy headers (use "helmet" for Node.js or equivalent)
- CSRF: CSRF token validation middleware
- Rate limit: Request rate limiting middleware`,
  };

  const missing = missingPolicies.map((p) => `- ${policyDescriptions[p]}`).join('\n');
  const instructions = frameworkInstructions[framework] || frameworkInstructions.unknown;

  return `You are patching a web application file to add missing security middleware.

FRAMEWORK: ${framework}
FILE: ${filePath}

MISSING SECURITY POLICIES:
${missing}

FRAMEWORK-SPECIFIC GUIDANCE:
${instructions}

CURRENT FILE CONTENT:
\`\`\`
${content}
\`\`\`

Your task:
1. Add ONLY the missing security policies listed above. Do NOT remove, rename, or reorder any existing middleware.
2. Add require/import statements at the top if the packages are not already imported.
3. Wire the middleware at the EARLIEST appropriate point in the middleware chain (after body-parser but before routes).
4. Use secure default configuration (restrictive CSP, SameSite=Strict for CSRF, sensible rate-limit windows).
5. Add a brief inline comment for each added policy explaining what it protects against.
6. If you CANNOT safely add a policy because the file structure does not support it (e.g. it's a pure config file with no middleware chain), output the single token SKIP for that policy — but still add the other policies if they can be safely added.

Output ONLY the complete patched file content. No markdown fences. No explanations. The first line must be the first line of the patched file.`;
}

/**
 * Sanity-check Claude's generated patch. Returns { valid, reason }.
 */
function validatePatch(content, missingPolicies) {
  if (!content || content.trim().length < 20) {
    return { valid: false, reason: 'patch too short' };
  }
  // Must reference at least one of the policies being added
  const policyMarkers = {
    csp: /helmet|Content-Security-Policy|csp/i,
    csrf: /csrf/i,
    rateLimit: /rate.?limit|ratelimit/i,
  };
  const hasAnyPolicy = missingPolicies.some(
    (p) => policyMarkers[p] && policyMarkers[p].test(content)
  );
  if (!hasAnyPolicy) {
    return { valid: false, reason: 'patch does not reference any requested security policy' };
  }
  return { valid: true, reason: null };
}

/**
 * Strip code fences if Claude wrapped the output.
 */
function stripFences(text) {
  return text
    .replace(/^```[a-z]*\r?\n/, '')
    .replace(/\r?\n```$/, '')
    .trim();
}

/**
 * Apply security policies to a single file.
 *
 * @param {Object} opts
 * @param {string} opts.filePath
 * @param {string} opts.content
 * @param {Function} opts.askClaude  async (prompt) => string
 * @returns {Promise<{ ok, patch, reason, policies }>}
 */
async function applySecurityPolicies({ filePath, content, askClaude }) {
  const framework = detectFramework(content);
  const presentPolicies = detectPresentPolicies(content);
  const missingPolicies = ['csp', 'csrf', 'rateLimit'].filter((p) => !presentPolicies.has(p));

  if (missingPolicies.length === 0) {
    return { ok: false, patch: null, reason: 'already-secured', policies: [] };
  }

  const prompt = buildSecurityPolicyPrompt({ filePath, content, framework, missingPolicies });
  // Let Claude errors propagate so the orchestrator puts them in errors[].
  const raw = await askClaude(prompt);

  const trimmed = raw ? raw.trim() : '';
  if (trimmed === 'SKIP' || trimmed.startsWith('SKIP\n')) {
    return { ok: false, patch: null, reason: 'Claude: could not safely patch this file', policies: [] };
  }

  const patchedContent = stripFences(trimmed);
  const validation = validatePatch(patchedContent, missingPolicies);
  if (!validation.valid) {
    return { ok: false, patch: null, reason: `validation failed: ${validation.reason}`, policies: [] };
  }

  return {
    ok: true,
    patch: { path: filePath, content: patchedContent, sourceFile: filePath, policies: missingPolicies },
    reason: null,
    policies: missingPolicies,
  };
}

/**
 * Main entry point. Apply security policies to unprotected entry-point files.
 *
 * @param {Object} opts
 * @param {Array<{ filePath: string, content: string }>} opts.sourceFiles
 * @param {Function} opts.askClaude  async (prompt) => string
 * @param {number}   [opts.maxFiles] Override MAX_FILES_PER_RUN
 * @returns {Promise<{ patches, skipped, errors, totalApplied, summary }>}
 */
async function generateSecurityPatches({
  sourceFiles = [],
  askClaude,
  maxFiles = MAX_FILES_PER_RUN,
}) {
  const patches = [];
  const skipped = [];
  const errors = [];

  const candidates = sourceFiles.filter(({ filePath, content }) => {
    if (!isEntryPoint(filePath)) return false;
    if (!content || content.length > MAX_FILE_BYTES) return false;
    return true;
  });

  if (candidates.length === 0) {
    return {
      patches: [],
      skipped: [{ reason: 'no-entry-points-found' }],
      errors: [],
      totalApplied: 0,
      summary: 'No recognisable web framework entry points found.',
    };
  }

  if (candidates.length > maxFiles) {
    const deferred = candidates.length - maxFiles;
    skipped.push({
      reason: `deferred: ${deferred} additional entry file(s) hit the per-run cap (${maxFiles}); re-run to process remaining`,
    });
  }

  const toProcess = candidates.slice(0, maxFiles);

  for (const { filePath, content } of toProcess) {
    try {
      const result = await applySecurityPolicies({ filePath, content, askClaude });
      if (result.ok && result.patch) {
        patches.push(result.patch);
      } else {
        skipped.push({ file: filePath, reason: result.reason || 'unknown' });
      }
    } catch (err) {
      errors.push(`applySecurityPolicies(${filePath}): ${err.message}`);
      skipped.push({ file: filePath, reason: 'error' });
    }
  }

  const appliedPolicies = patches.flatMap((p) => p.policies);
  const policyCount = {
    csp: appliedPolicies.filter((p) => p === 'csp').length,
    csrf: appliedPolicies.filter((p) => p === 'csrf').length,
    rateLimit: appliedPolicies.filter((p) => p === 'rateLimit').length,
  };
  const summary = patches.length === 0
    ? 'No security policy patches generated.'
    : `Applied security policies to ${patches.length} file(s): ${policyCount.csp} CSP, ${policyCount.csrf} CSRF, ${policyCount.rateLimit} rate-limit additions.`;

  return { patches, skipped, errors, totalApplied: patches.length, summary };
}

module.exports = {
  generateSecurityPatches,
  applySecurityPolicies,
  isEntryPoint,
  detectFramework,
  detectPresentPolicies,
  buildSecurityPolicyPrompt,
  validatePatch,
  MAX_FILES_PER_RUN,
};
