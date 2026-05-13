/**
 * Tech-stack auto-detection — pure-static read of a customer's repo to
 * build a compact stack profile that we can inject into Claude prompts.
 *
 * The product-perceived-intelligence win: when Claude knows "this customer
 * uses Next.js 16 + Prisma + Vercel" upfront, the diagnosis says "add
 * `withMiddleware` to your next.config.ts" instead of "you might add a
 * middleware somewhere depending on your framework." Same Claude, sharper
 * answer.
 *
 * Inputs:
 *   - projectRoot: absolute path. Required.
 *   - fileContents (optional): { [path: string]: string } pre-loaded contents
 *     for serverless callers that already have files in memory (avoids a
 *     second disk read).
 *
 * Output: { languages, frameworks, databases, deploy, packageManagers,
 *           hosts, summary } where summary is the one-line prompt header.
 *
 * Zero dependencies. Safe to require from CLI, website, MCP server.
 */

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Detection signatures — small, hand-curated. Easy to extend.
// ---------------------------------------------------------------------------

const JS_FRAMEWORK_SIGNATURES = {
  // key in dependencies / devDependencies → label
  'next': 'Next.js',
  'react': 'React',
  'vue': 'Vue',
  '@vue/cli-service': 'Vue',
  'nuxt': 'Nuxt',
  '@angular/core': 'Angular',
  'svelte': 'Svelte',
  '@sveltejs/kit': 'SvelteKit',
  'astro': 'Astro',
  'remix': 'Remix',
  '@remix-run/node': 'Remix',
  'express': 'Express',
  'fastify': 'Fastify',
  '@nestjs/core': 'NestJS',
  'koa': 'Koa',
  'hono': 'Hono',
  'vite': 'Vite',
  'webpack': 'Webpack',
  'rollup': 'Rollup',
  'esbuild': 'esbuild',
  'turbo': 'Turborepo',
  'nx': 'Nx',
};

const JS_DB_SIGNATURES = {
  '@prisma/client': 'Prisma',
  'prisma': 'Prisma',
  'drizzle-orm': 'Drizzle',
  'mongoose': 'Mongoose/MongoDB',
  'mongodb': 'MongoDB',
  'sequelize': 'Sequelize',
  'typeorm': 'TypeORM',
  'knex': 'Knex',
  'pg': 'node-postgres',
  '@neondatabase/serverless': 'Neon (Postgres)',
  'mysql2': 'MySQL2',
  '@supabase/supabase-js': 'Supabase',
  '@upstash/redis': 'Upstash Redis',
  'redis': 'Redis',
  'ioredis': 'Redis (ioredis)',
};

const JS_TEST_SIGNATURES = {
  'jest': 'Jest',
  'vitest': 'Vitest',
  'mocha': 'Mocha',
  '@playwright/test': 'Playwright',
  'cypress': 'Cypress',
  '@testing-library/react': 'React Testing Library',
};

const PYTHON_FRAMEWORK_SIGNATURES = {
  'django': 'Django',
  'flask': 'Flask',
  'fastapi': 'FastAPI',
  'starlette': 'Starlette',
  'aiohttp': 'aiohttp',
  'tornado': 'Tornado',
  'celery': 'Celery',
};

const PYTHON_DB_SIGNATURES = {
  'sqlalchemy': 'SQLAlchemy',
  'psycopg2': 'psycopg2',
  'psycopg': 'psycopg3',
  'pymongo': 'MongoDB (pymongo)',
  'redis': 'Redis',
};

const GO_FRAMEWORK_SIGNATURES = {
  'github.com/gin-gonic/gin': 'Gin',
  'github.com/labstack/echo': 'Echo',
  'github.com/gofiber/fiber': 'Fiber',
  'github.com/go-chi/chi': 'Chi',
};

const RUBY_FRAMEWORK_SIGNATURES = {
  'rails': 'Rails',
  'sinatra': 'Sinatra',
  'roda': 'Roda',
  'hanami': 'Hanami',
};

const PHP_FRAMEWORK_SIGNATURES = {
  'laravel/framework': 'Laravel',
  'symfony/framework-bundle': 'Symfony',
  'cakephp/cakephp': 'CakePHP',
  'codeigniter4/framework': 'CodeIgniter',
};

const JAVA_FRAMEWORK_SIGNATURES = {
  'spring-boot': 'Spring Boot',
  'spring-core': 'Spring',
  'micronaut': 'Micronaut',
  'quarkus': 'Quarkus',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readSafely(filePath, fileContents) {
  if (fileContents && Object.prototype.hasOwnProperty.call(fileContents, filePath)) {
    return fileContents[filePath];
  }
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function safeJsonParse(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function matchSignatures(deps, signatures) {
  if (!deps || typeof deps !== 'object') return [];
  const hits = [];
  for (const key of Object.keys(signatures)) {
    if (deps[key]) hits.push({ label: signatures[key], dep: key, version: deps[key] });
  }
  return hits;
}

function uniqByLabel(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (seen.has(item.label)) continue;
    seen.add(item.label);
    out.push(item);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Language detectors
// ---------------------------------------------------------------------------

function detectJsTs(root, fileContents) {
  const pkgRaw = readSafely(path.join(root, 'package.json'), fileContents);
  if (!pkgRaw) return null;
  const pkg = safeJsonParse(pkgRaw);
  if (!pkg) return null;
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const frameworks = matchSignatures(deps, JS_FRAMEWORK_SIGNATURES);
  const databases = matchSignatures(deps, JS_DB_SIGNATURES);
  const testTools = matchSignatures(deps, JS_TEST_SIGNATURES);
  const isTypescript = Boolean(deps.typescript) || Boolean(readSafely(path.join(root, 'tsconfig.json'), fileContents));
  return {
    language: isTypescript ? 'TypeScript' : 'JavaScript',
    runtime: pkg.engines?.node ? `Node ${pkg.engines.node}` : 'Node',
    frameworks,
    databases,
    testTools,
    packageManager: detectJsPackageManager(root, fileContents),
  };
}

function detectJsPackageManager(root, fileContents) {
  if (readSafely(path.join(root, 'pnpm-lock.yaml'), fileContents)) return 'pnpm';
  if (readSafely(path.join(root, 'yarn.lock'), fileContents)) return 'yarn';
  if (readSafely(path.join(root, 'bun.lockb'), fileContents)) return 'bun';
  if (readSafely(path.join(root, 'package-lock.json'), fileContents)) return 'npm';
  return null;
}

function detectPython(root, fileContents) {
  const reqs = readSafely(path.join(root, 'requirements.txt'), fileContents);
  const pyproject = readSafely(path.join(root, 'pyproject.toml'), fileContents);
  const pipfile = readSafely(path.join(root, 'Pipfile'), fileContents);
  if (!reqs && !pyproject && !pipfile) return null;
  // Build a single token set across all manifests
  const lower = [reqs, pyproject, pipfile].filter(Boolean).join('\n').toLowerCase();
  const deps = {};
  for (const key of Object.keys({ ...PYTHON_FRAMEWORK_SIGNATURES, ...PYTHON_DB_SIGNATURES })) {
    if (lower.includes(key.toLowerCase())) deps[key] = 'detected';
  }
  return {
    language: 'Python',
    runtime: 'Python (version unknown from static read)',
    frameworks: matchSignatures(deps, PYTHON_FRAMEWORK_SIGNATURES),
    databases: matchSignatures(deps, PYTHON_DB_SIGNATURES),
    testTools: lower.includes('pytest') ? [{ label: 'pytest', dep: 'pytest', version: 'detected' }] : [],
    packageManager: pyproject ? 'poetry/uv (pyproject.toml)' : (pipfile ? 'pipenv' : 'pip'),
  };
}

function detectGo(root, fileContents) {
  const gomod = readSafely(path.join(root, 'go.mod'), fileContents);
  if (!gomod) return null;
  const deps = {};
  for (const key of Object.keys(GO_FRAMEWORK_SIGNATURES)) {
    if (gomod.includes(key)) deps[key] = 'detected';
  }
  const moduleMatch = gomod.match(/^module\s+(\S+)/m);
  const goVer = gomod.match(/^go\s+(\S+)/m);
  return {
    language: 'Go',
    runtime: goVer ? `Go ${goVer[1]}` : 'Go',
    moduleName: moduleMatch ? moduleMatch[1] : null,
    frameworks: matchSignatures(deps, GO_FRAMEWORK_SIGNATURES),
    databases: [],
    testTools: [],
    packageManager: 'go modules',
  };
}

function detectRust(root, fileContents) {
  const cargo = readSafely(path.join(root, 'Cargo.toml'), fileContents);
  if (!cargo) return null;
  const lower = cargo.toLowerCase();
  const frameworks = [];
  if (lower.includes('axum')) frameworks.push({ label: 'Axum', dep: 'axum', version: 'detected' });
  if (lower.includes('actix-web')) frameworks.push({ label: 'Actix Web', dep: 'actix-web', version: 'detected' });
  if (lower.includes('rocket')) frameworks.push({ label: 'Rocket', dep: 'rocket', version: 'detected' });
  if (lower.includes('warp')) frameworks.push({ label: 'Warp', dep: 'warp', version: 'detected' });
  return {
    language: 'Rust',
    runtime: 'Rust (rustc version unknown from static read)',
    frameworks,
    databases: lower.includes('sqlx') ? [{ label: 'SQLx', dep: 'sqlx', version: 'detected' }] : [],
    testTools: [],
    packageManager: 'cargo',
  };
}

function detectRuby(root, fileContents) {
  const gemfile = readSafely(path.join(root, 'Gemfile'), fileContents);
  if (!gemfile) return null;
  const deps = {};
  for (const key of Object.keys(RUBY_FRAMEWORK_SIGNATURES)) {
    if (gemfile.includes(`'${key}'`) || gemfile.includes(`"${key}"`)) deps[key] = 'detected';
  }
  return {
    language: 'Ruby',
    runtime: 'Ruby (version unknown from static read)',
    frameworks: matchSignatures(deps, RUBY_FRAMEWORK_SIGNATURES),
    databases: [],
    testTools: gemfile.includes('rspec') ? [{ label: 'RSpec', dep: 'rspec', version: 'detected' }] : [],
    packageManager: 'bundler',
  };
}

function detectPhp(root, fileContents) {
  const composerRaw = readSafely(path.join(root, 'composer.json'), fileContents);
  if (!composerRaw) return null;
  const composer = safeJsonParse(composerRaw);
  if (!composer) return null;
  const deps = { ...(composer.require || {}), ...(composer['require-dev'] || {}) };
  return {
    language: 'PHP',
    runtime: composer.require?.php ? `PHP ${composer.require.php}` : 'PHP',
    frameworks: matchSignatures(deps, PHP_FRAMEWORK_SIGNATURES),
    databases: [],
    testTools: deps['phpunit/phpunit'] ? [{ label: 'PHPUnit', dep: 'phpunit/phpunit', version: deps['phpunit/phpunit'] }] : [],
    packageManager: 'composer',
  };
}

function detectJava(root, fileContents) {
  const pomRaw = readSafely(path.join(root, 'pom.xml'), fileContents);
  const gradleRaw =
    readSafely(path.join(root, 'build.gradle'), fileContents)
    || readSafely(path.join(root, 'build.gradle.kts'), fileContents);
  if (!pomRaw && !gradleRaw) return null;
  const blob = (pomRaw || '') + (gradleRaw || '');
  const deps = {};
  for (const key of Object.keys(JAVA_FRAMEWORK_SIGNATURES)) {
    if (blob.includes(key)) deps[key] = 'detected';
  }
  return {
    language: gradleRaw && /kotlin/i.test(gradleRaw) ? 'Kotlin (or Java)' : 'Java',
    runtime: 'JVM (version unknown from static read)',
    frameworks: matchSignatures(deps, JAVA_FRAMEWORK_SIGNATURES),
    databases: [],
    testTools: blob.toLowerCase().includes('junit') ? [{ label: 'JUnit', dep: 'junit', version: 'detected' }] : [],
    packageManager: pomRaw ? 'maven' : 'gradle',
  };
}

// ---------------------------------------------------------------------------
// Deploy / host detection
// ---------------------------------------------------------------------------

function detectDeploy(root, fileContents) {
  const hits = [];
  if (readSafely(path.join(root, 'vercel.json'), fileContents) || readSafely(path.join(root, '.vercel/project.json'), fileContents)) {
    hits.push('Vercel');
  }
  if (readSafely(path.join(root, 'netlify.toml'), fileContents)) hits.push('Netlify');
  if (readSafely(path.join(root, 'wrangler.toml'), fileContents)) hits.push('Cloudflare Workers');
  if (readSafely(path.join(root, 'fly.toml'), fileContents)) hits.push('Fly.io');
  if (readSafely(path.join(root, 'render.yaml'), fileContents)) hits.push('Render');
  if (readSafely(path.join(root, 'railway.toml'), fileContents) || readSafely(path.join(root, 'railway.json'), fileContents)) hits.push('Railway');
  if (readSafely(path.join(root, 'Dockerfile'), fileContents)) hits.push('Docker');
  if (readSafely(path.join(root, 'docker-compose.yml'), fileContents) || readSafely(path.join(root, 'docker-compose.yaml'), fileContents)) hits.push('Docker Compose');
  if (readSafely(path.join(root, 'kustomization.yaml'), fileContents) || readSafely(path.join(root, 'Chart.yaml'), fileContents)) hits.push('Kubernetes');
  if (readSafely(path.join(root, 'serverless.yml'), fileContents)) hits.push('Serverless Framework');
  if (readSafely(path.join(root, 'sst.config.ts'), fileContents) || readSafely(path.join(root, 'sst.config.js'), fileContents)) hits.push('SST');
  if (readSafely(path.join(root, 'app.yaml'), fileContents)) hits.push('Google App Engine');
  return hits;
}

// ---------------------------------------------------------------------------
// CI detection
// ---------------------------------------------------------------------------

function detectCi(root, fileContents) {
  const hits = [];
  if (readSafely(path.join(root, '.github/workflows/ci.yml'), fileContents)
      || readSafely(path.join(root, '.github/workflows/test.yml'), fileContents)) {
    hits.push('GitHub Actions');
  } else {
    // Cheap fallback: presence of .github/workflows dir, sampled
    try {
      const wfDir = path.join(root, '.github', 'workflows');
      if (fs.existsSync(wfDir) && fs.statSync(wfDir).isDirectory()) {
        hits.push('GitHub Actions');
      }
    } catch { /* ignore */ }
  }
  if (readSafely(path.join(root, '.gitlab-ci.yml'), fileContents)) hits.push('GitLab CI');
  if (readSafely(path.join(root, '.circleci/config.yml'), fileContents)) hits.push('CircleCI');
  if (readSafely(path.join(root, 'azure-pipelines.yml'), fileContents)) hits.push('Azure Pipelines');
  if (readSafely(path.join(root, 'buildkite.yml'), fileContents) || readSafely(path.join(root, '.buildkite/pipeline.yml'), fileContents)) hits.push('Buildkite');
  if (readSafely(path.join(root, 'Jenkinsfile'), fileContents)) hits.push('Jenkins');
  return hits;
}

// ---------------------------------------------------------------------------
// Top-level
// ---------------------------------------------------------------------------

/**
 * @param {Object} opts
 * @param {string} opts.projectRoot   Absolute path to the customer's repo root.
 * @param {Object} [opts.fileContents] Optional pre-loaded { path: content } map.
 * @returns {{
 *   languages: Array<Object>,
 *   frameworks: Array<{label,dep,version}>,
 *   databases: Array<{label,dep,version}>,
 *   testTools: Array<{label,dep,version}>,
 *   deploy: string[],
 *   ci: string[],
 *   packageManagers: string[],
 *   summary: string,
 * }}
 */
function detectStack({ projectRoot, fileContents = null } = {}) {
  if (!projectRoot || typeof projectRoot !== 'string') {
    throw new TypeError('projectRoot is required');
  }
  const detectors = [detectJsTs, detectPython, detectGo, detectRust, detectRuby, detectPhp, detectJava];
  const languages = detectors.map((fn) => fn(projectRoot, fileContents)).filter(Boolean);

  // Flatten cross-language
  const frameworks = uniqByLabel(languages.flatMap((l) => l.frameworks || []));
  const databases = uniqByLabel(languages.flatMap((l) => l.databases || []));
  const testTools = uniqByLabel(languages.flatMap((l) => l.testTools || []));
  const packageManagers = [...new Set(languages.map((l) => l.packageManager).filter(Boolean))];

  const deploy = detectDeploy(projectRoot, fileContents);
  const ci = detectCi(projectRoot, fileContents);

  const summary = renderStackSummary({ languages, frameworks, databases, deploy, ci });

  return {
    languages,
    frameworks,
    databases,
    testTools,
    deploy,
    ci,
    packageManagers,
    summary,
  };
}

/**
 * One-line "stack profile" suitable for injection into a Claude prompt:
 *   `STACK: TypeScript (Next.js, React) + Prisma + Postgres on Vercel`
 *
 * Empty-stack fallback: 'STACK: unknown (no manifest files detected)'.
 */
function renderStackSummary({ languages, frameworks, databases, deploy }) {
  if (!languages.length) return 'STACK: unknown (no manifest files detected)';
  const langPart = languages.map((l) => l.language).join(' + ');
  const fwPart = frameworks.length ? ` (${frameworks.map((f) => f.label).join(', ')})` : '';
  const dbPart = databases.length ? ` + ${databases.map((d) => d.label).join(', ')}` : '';
  const deployPart = deploy.length ? ` on ${deploy.join(' / ')}` : '';
  return `STACK: ${langPart}${fwPart}${dbPart}${deployPart}`;
}

/**
 * Multi-line prompt header. Pair with formatGroundingHeader from
 * contextual-grounding when constructing a Claude prompt — STACK first,
 * then PROJECT CONVENTIONS, then the actual ask.
 */
function formatStackHeader(stack) {
  if (!stack || !stack.summary) return '';
  const lines = [stack.summary];
  if (stack.testTools && stack.testTools.length) {
    lines.push(`TEST TOOLS: ${stack.testTools.map((t) => t.label).join(', ')}`);
  }
  if (stack.ci && stack.ci.length) {
    lines.push(`CI: ${stack.ci.join(', ')}`);
  }
  return lines.join('\n') + '\n\n';
}

module.exports = {
  detectStack,
  renderStackSummary,
  formatStackHeader,
  // Exposed for tests
  detectJsTs,
  detectPython,
  detectGo,
  detectRust,
  detectRuby,
  detectPhp,
  detectJava,
  detectDeploy,
  detectCi,
};
