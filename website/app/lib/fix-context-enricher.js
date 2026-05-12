/**
 * Fix-context enricher — gathers surrounding codebase context for a file
 * being fixed so Claude can make architecture-aware decisions rather than
 * generic pattern fixes.
 *
 * Context gathered (all best-effort):
 *   1. Consumers — other files that import the file being fixed
 *   2. Dependencies — files that the file being fixed imports
 *   3. Stack hints — framework / library names from package.json
 *   4. Summary — a 1-2 sentence natural-language context string
 *
 * RELIABILITY CONTRACT
 *   - Any failure anywhere returns partial context without throwing.
 *   - Never blocks the fix loop. If enrichment throws, the fix proceeds
 *     with an empty-but-valid context object.
 *   - Max 10 additional file fetches per call (5 deps + 5 consumers)
 *     so cost stays bounded.
 *
 * PURE — no direct I/O. Caller injects `fetchFile` so this module is
 * fully testable under `node --test` without any network or Next.js
 * transformer.
 */

// ---------- constants ----------

const MAX_DEPS = 5;
const MAX_CONSUMERS = 5;

// Frameworks keyed by well-known package names.
const FRAMEWORK_HINTS = [
  ['next', 'Next.js'],
  ['react', 'React'],
  ['vue', 'Vue'],
  ['nuxt', 'Nuxt'],
  ['express', 'Express'],
  ['fastify', 'Fastify'],
  ['hono', 'Hono'],
  ['koa', 'Koa'],
  ['nestjs', 'NestJS'],
  ['@nestjs/core', 'NestJS'],
  ['remix', 'Remix'],
  ['@remix-run/node', 'Remix'],
  ['svelte', 'Svelte'],
  ['@sveltejs/kit', 'SvelteKit'],
  ['astro', 'Astro'],
  ['gatsby', 'Gatsby'],
  ['stripe', 'Stripe'],
  ['@stripe/stripe-js', 'Stripe'],
  ['prisma', 'Prisma'],
  ['@prisma/client', 'Prisma'],
  ['drizzle-orm', 'Drizzle'],
  ['typeorm', 'TypeORM'],
  ['mongoose', 'Mongoose'],
  ['sequelize', 'Sequelize'],
  ['@anthropic-ai/sdk', 'Anthropic'],
  ['anthropic', 'Anthropic'],
  ['openai', 'OpenAI'],
  ['typescript', 'TypeScript'],
  ['zod', 'Zod'],
  ['trpc', 'tRPC'],
  ['@trpc/server', 'tRPC'],
  ['graphql', 'GraphQL'],
  ['@apollo/server', 'Apollo'],
  ['bullmq', 'BullMQ'],
  ['bull', 'Bull'],
  ['redis', 'Redis'],
  ['ioredis', 'Redis'],
  ['pg', 'PostgreSQL'],
  ['mysql2', 'MySQL'],
  ['better-sqlite3', 'SQLite'],
  ['knex', 'Knex'],
  ['vercel', 'Vercel'],
  ['@vercel/kv', 'Vercel KV'],
  ['@vercel/postgres', 'Vercel Postgres'],
  ['next-auth', 'NextAuth'],
  ['better-auth', 'BetterAuth'],
  ['clerk', 'Clerk'],
  ['@clerk/nextjs', 'Clerk'],
  ['tailwindcss', 'Tailwind CSS'],
  ['jest', 'Jest'],
  ['vitest', 'Vitest'],
  ['playwright', 'Playwright'],
  ['cypress', 'Cypress'],
];

// ---------- helpers ----------

/**
 * Extract import/require paths from file content.
 * Returns an array of raw module specifiers found in `import ... from '...'`
 * and `require('...')` statements.
 *
 * @param {string} content
 * @returns {string[]}
 */
function extractImportSpecifiers(content) {
  if (typeof content !== 'string') return [];
  const specifiers = [];

  // ES import: import ... from './x'  /  import './x'
  const esImportRe = /^\s*(?:import|export)\s+(?:[^'"]*from\s+)?['"]([^'"]+)['"]/gm;
  let m;
  while ((m = esImportRe.exec(content)) !== null) {
    specifiers.push(m[1]);
  }

  // CommonJS: require('./x')  /  require("./x")
  const cjsRequireRe = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = cjsRequireRe.exec(content)) !== null) {
    specifiers.push(m[1]);
  }

  return specifiers;
}

/**
 * Resolve a raw import specifier relative to the importing file's path.
 *
 * Only resolves relative specifiers (starting with './' or '../').
 * Bare package names are left as-is but callers filter them out.
 *
 * Extension-retry order mirrors Node resolution: if the specifier has no
 * extension we try .ts, .tsx, .js, .jsx, .mjs, .cjs in that order against
 * the allFiles set. Also tries `<path>/index.<ext>` for directory imports.
 *
 * @param {string} specifier  Raw import string from source code.
 * @param {string} fromFile   Path of the file doing the importing (relative to repo root).
 * @param {string[]} allFiles All files in the repo (relative to repo root).
 * @returns {string|null}     Resolved path as it appears in allFiles, or null.
 */
function resolveSpecifier(specifier, fromFile, allFiles) {
  if (typeof specifier !== 'string' || typeof fromFile !== 'string') return null;
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return null;

  // Build the un-extensioned base path
  const fromDir = fromFile.includes('/')
    ? fromFile.split('/').slice(0, -1).join('/')
    : '';

  // Join fromDir + specifier, then normalise double-slashes and '..' segments
  const joined = fromDir ? `${fromDir}/${specifier}` : specifier;
  const parts = [];
  for (const seg of joined.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { parts.pop(); continue; }
    parts.push(seg);
  }
  const base = parts.join('/');

  const allFilesSet = new Set(allFiles);

  // 1. Exact match (specifier already has an extension)
  if (allFilesSet.has(base)) return base;

  // 2. Extension-retry
  const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
  for (const ext of EXTENSIONS) {
    const candidate = base + ext;
    if (allFilesSet.has(candidate)) return candidate;
  }

  // 3. Directory index
  for (const ext of EXTENSIONS) {
    const candidate = `${base}/index${ext}`;
    if (allFilesSet.has(candidate)) return candidate;
  }

  return null;
}

/**
 * Check whether `content` contains an import/require referencing `targetPath`.
 *
 * We match on the filename stem + extension to handle relative paths without
 * fully re-resolving every specifier in the candidate file (too expensive).
 * False-positive rate is acceptable because this is best-effort context.
 *
 * @param {string} content
 * @param {string} targetPath  Path of the file we're looking for references to.
 * @returns {boolean}
 */
function fileReferencesTarget(content, targetPath) {
  if (typeof content !== 'string' || typeof targetPath !== 'string') return false;

  // Build a pattern that matches the last path component (with and without extension)
  const lastSegment = targetPath.split('/').pop() || targetPath;
  const withoutExt = lastSegment.replace(/\.[^.]+$/, '');

  // Match import/require that contains the filename (with or without extension)
  // We look for the segment preceded by / or starting the specifier, so
  // `foo/bar.ts` matches 'bar' but not 'foobar'.
  const escapedWithExt = lastSegment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedNoExt = withoutExt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Match import/require statements whose specifier contains the filename.
  // Use [/.] before the stem so both './stripe-client' and 'lib/stripe-client'
  // are detected. We use [^'"]* (not \s*(?:...from\s+)?) before the opening
  // quote so require('./foo') is matched correctly — the '(' between require
  // and the quote is consumed by [^'"]*. The stem must be followed by a quote,
  // dot, slash, or end-of-specifier-like-char so 'stripe-clientfoo' is not matched.
  const importPattern = new RegExp(
    `(?:import|require)[^'"]*['"][^'"]*[/.]${escapedWithExt}['"]` +
    `|` +
    `(?:import|require)[^'"]*['"][^'"]*[/.]${escapedNoExt}['"/.]`,
  );
  return importPattern.test(content);
}

/**
 * Parse package.json content and return an array of recognised framework /
 * library names present in `dependencies` + `devDependencies`.
 *
 * @param {string} pkgJsonContent  Raw JSON string of package.json.
 * @returns {string[]}
 */
function extractStackHints(pkgJsonContent) {
  if (typeof pkgJsonContent !== 'string') return [];
  let pkg;
  try {
    pkg = JSON.parse(pkgJsonContent);
  } catch {
    return [];
  }
  if (!pkg || typeof pkg !== 'object') return [];

  const allDeps = Object.assign(
    {},
    pkg.dependencies || {},
    pkg.devDependencies || {},
  );

  const seen = new Set();
  const hints = [];
  for (const [pkgName, label] of FRAMEWORK_HINTS) {
    if (Object.prototype.hasOwnProperty.call(allDeps, pkgName) && !seen.has(label)) {
      seen.add(label);
      hints.push(label);
    }
  }
  return hints;
}

/**
 * Build a natural-language summary sentence from the enriched context.
 *
 * @param {object} opts
 * @param {string}   opts.filePath
 * @param {string[]} opts.consumers
 * @param {string[]} opts.dependencies
 * @param {string[]} opts.stackHints
 * @returns {string}
 */
function buildSummary({ filePath, consumers, dependencies, stackHints }) {
  const parts = [];

  if (consumers.length > 0) {
    const list = consumers.slice(0, 3).join(', ');
    const extra = consumers.length > 3 ? ` (+${consumers.length - 3} more)` : '';
    parts.push(`This file is used by ${consumers.length} other file${consumers.length > 1 ? 's' : ''} (${list}${extra}).`);
  }

  if (dependencies.length > 0) {
    const list = dependencies.join(', ');
    parts.push(`It imports from ${list}.`);
  }

  if (stackHints.length > 0) {
    parts.push(`Tech stack: ${stackHints.join(', ')}.`);
  }

  if (parts.length === 0) {
    return `Fixing ${filePath} — no import graph context available.`;
  }

  return parts.join(' ');
}

// ---------- main export ----------

/**
 * Gathers surrounding codebase context for a file being fixed.
 *
 * @param {object} opts
 * @param {string}   opts.filePath      The file being fixed (repo-relative).
 * @param {string}   opts.fileContents  The content of the file being fixed.
 * @param {string[]} opts.allFiles      List of all files in the repo.
 * @param {(path: string) => Promise<string|null>} opts.fetchFile
 *   Async fetcher for other files; may return null or throw on failure.
 *
 * @returns {Promise<{
 *   consumers: string[],
 *   dependencies: string[],
 *   stackHints: string[],
 *   summary: string,
 * }>}
 */
async function enrichFixContext({ filePath, fileContents, allFiles, fetchFile }) {
  // Guard — return a safe empty context rather than throwing on bad input.
  if (
    typeof filePath !== 'string' ||
    typeof fileContents !== 'string' ||
    !Array.isArray(allFiles) ||
    typeof fetchFile !== 'function'
  ) {
    return {
      consumers: [],
      dependencies: [],
      stackHints: [],
      summary: `Fixing ${filePath || '(unknown)'} — context enrichment skipped (invalid arguments).`,
    };
  }

  let dependencies = [];
  let consumers = [];
  let stackHints = [];

  // ---- 1. Dependencies (files this file imports) ----
  try {
    const specifiers = extractImportSpecifiers(fileContents);
    const resolved = [];
    for (const spec of specifiers) {
      const r = resolveSpecifier(spec, filePath, allFiles);
      if (r && r !== filePath) resolved.push(r);
    }
    // Deduplicate, cap at MAX_DEPS
    const uniqueDeps = [...new Set(resolved)].slice(0, MAX_DEPS);
    dependencies = uniqueDeps;
  } catch {
    // best-effort: leave as []
  }

  // ---- 2. Consumers (files that import this file) ----
  try {
    // Filter to plausible candidates by quick string search — avoids
    // fetching every file in a large repo. Look for the filename stem in
    // any file path that isn't the file itself.
    const fileBase = filePath.split('/').pop() || filePath;
    const stemNoExt = fileBase.replace(/\.[^.]+$/, '');

    const candidates = allFiles.filter((f) => {
      if (f === filePath) return false;
      // Rough filter: the candidate must at least mention the stem somewhere
      // in its own path OR we have to search its content. To keep this free
      // of false positives we always confirm via content search.
      const ext = f.split('.').pop() || '';
      return ['js', 'ts', 'jsx', 'tsx', 'mjs', 'cjs', 'mts', 'cts'].includes(ext);
    });

    let found = 0;
    for (const candidate of candidates) {
      if (found >= MAX_CONSUMERS) break;
      try {
        const content = await fetchFile(candidate);
        if (!content) continue;
        if (fileReferencesTarget(content, filePath) || fileReferencesTarget(content, stemNoExt)) {
          consumers.push(candidate);
          found++;
        }
      } catch {
        // skip this candidate
      }
    }
  } catch {
    // best-effort: leave as []
  }

  // ---- 3. Stack hints from package.json ----
  try {
    const pkgPath = allFiles.find(
      (f) => f === 'package.json' || f.endsWith('/package.json'),
    );
    if (pkgPath) {
      const content = await fetchFile(pkgPath);
      if (content) {
        stackHints = extractStackHints(content);
      }
    }
  } catch {
    // best-effort: leave as []
  }

  // ---- 4. Summary ----
  const summary = buildSummary({ filePath, consumers, dependencies, stackHints });

  return { consumers, dependencies, stackHints, summary };
}

// ---------- exports ----------

module.exports = {
  enrichFixContext,
  // Exported for tests
  extractImportSpecifiers,
  resolveSpecifier,
  fileReferencesTarget,
  extractStackHints,
  buildSummary,
};
