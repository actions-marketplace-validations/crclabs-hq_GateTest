/**
 * Env-Vars Module — cross-check code references against declared env.
 *
 * Three silent footguns every team has:
 *
 *   1. `process.env.STRIPE_SECRET_KEY` appears in code but isn't in
 *      `.env.example`. The developer has it locally; nobody else
 *      does. Production deploy: app boots, endpoint 500s on first
 *      request. "Works on my machine" squared.
 *
 *   2. `.env.example` lists `FEATURE_FLAG_OLD_CHECKOUT` that no code
 *      reads anymore. Dead config accumulates. New engineers copy
 *      it into their `.env`, wonder what it does, ship pull requests
 *      toggling a flag that no longer exists.
 *
 *   3. (NEW) The team declares `DATABASE_URL` in `.env.example`, sets
 *      it in their local `.env`, but forgets to add it to Vercel /
 *      GitHub Actions / Railway. GateTest runs in that CI environment,
 *      sees `DATABASE_URL` is NOT in `process.env`, and flags it as
 *      an error before the deploy goes live.
 *
 * Competitors:
 *   - `dotenv-linter` (Rust) checks `.env` file syntax only — not
 *     cross-reference with code.
 *   - `@dotenvx/dotenvx` has a `diff` subcommand but only between two
 *     `.env` files — not against source.
 *   - Nothing unifies code-↔-env contract verification.
 *
 * Approach (two-phase, line-heuristic):
 *
 *   Phase 1 — Harvest declared env keys from:
 *     - `.env.example` / `.env.sample` / `.env.template` /
 *       `.env.local.example` (these are the public contract)
 *     - `.env` (local defaults — counts as "declared" for the purpose
 *       of "is this accessible")
 *     - `config.yml` / `docker-compose.yml` env blocks
 *     - `.github/workflows/*.yml` `env:` blocks
 *     - `vercel.json` / `netlify.toml` env blocks
 *
 *   Phase 2 — Harvest referenced env keys from source:
 *     - JS/TS: `process.env.FOO` / `process.env["FOO"]`
 *     - Python: `os.environ["FOO"]` / `os.environ.get("FOO")` /
 *       `os.getenv("FOO")`
 *     - Go: `os.Getenv("FOO")` / `os.LookupEnv("FOO")`
 *     - Next.js: `process.env.NEXT_PUBLIC_*` (client-exposed)
 *
 *   Phase 3 — Cross-reference and flag:
 *     - Referenced in code, NOT declared anywhere → error
 *     - Declared in `.env.example`, NOT referenced in code → warning
 *     - `NEXT_PUBLIC_*` referenced server-side only → info
 *
 * Rules:
 *
 *   error:   `process.env.X` read in source but `X` is absent from
 *            every declared env source (deploy will boot a broken app).
 *            (rule: `env-vars:missing-from-example:<KEY>`)
 *
 *   warning: `X=...` declared in `.env.example` but nothing reads it
 *            anywhere in source.
 *            (rule: `env-vars:unused-in-code:<KEY>`)
 *
 *   info:    `NEXT_PUBLIC_*` key — recorded for visibility (these
 *            are bundled into client code and visible to end users,
 *            so "secret-shaped" names here are dangerous).
 *            (rule: `env-vars:client-exposed:<KEY>`)
 *
 * TODO(gluecron): host-neutral — but the CI env harvest will need a
 * Gluecron adapter once Gluecron publishes its workflow schema.
 */

const fs = require('fs');
const path = require('path');
const BaseModule = require('./base-module');

const DEFAULT_EXCLUDES = [
  'node_modules', '.git', 'dist', 'build', 'coverage', '.gatetest',
  '.next', '__pycache__', 'target', 'vendor', '.terraform', 'out',
];

const CODE_EXTS = new Set([
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts',
  '.py', '.go',
]);

const ENV_BASENAME_RE = /^\.env(?:\.(?:example|sample|template|local\.example|production\.example))?$/i;

const CI_WORKFLOW_RE = /\.ya?ml$/i;

// Test paths contain scanner fixtures like `"process.env.FOO"` embedded
// as string literals; they'd pollute the reference set with keys that
// are not real app env reads. Skip.
const TEST_PATH_RE = /(?:^|\/)(?:tests?|__tests__|spec|fixtures?|stories|storybook|e2e)(?:\/|$)|\.(?:test|spec|stories|fixture|e2e)\.(?:js|jsx|ts|tsx|mjs|cjs|mts|cts|py)$/i;

// Local-dev config files legitimately read env vars (BASE_URL, CI)
// that CI sets at runtime; they don't need `.env.example` entries.
const DEV_CONFIG_BASENAME_RE = /^(?:playwright|vitest|jest|cypress|webpack|vite|rollup|next|tailwind|postcss|babel|eslint|prettier)\.config\.(?:js|mjs|cjs|ts|mts|cts)$/i;

function isInString(line, idx) {
  let inS = false; let inD = false; let inT = false;
  for (let i = 0; i < idx && i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '\\') { i += 1; continue; }
    if (!inD && !inT && ch === '\'') inS = !inS;
    else if (!inS && !inT && ch === '"') inD = !inD;
    else if (!inS && !inD && ch === '`') inT = !inT;
  }
  return inS || inD || inT;
}

// Detect which deployment platform we're running inside.
// Returns { inCI: boolean, platform: string, addEnvUrl: string }
function detectPlatform() {
  const e = process.env;
  if (e.VERCEL)                      return { inCI: true, platform: 'Vercel',          addEnvUrl: 'https://vercel.com/docs/projects/environment-variables' };
  if (e.NETLIFY)                     return { inCI: true, platform: 'Netlify',         addEnvUrl: 'https://docs.netlify.com/environment-variables/overview/' };
  if (e.GITHUB_ACTIONS)              return { inCI: true, platform: 'GitHub Actions',  addEnvUrl: 'https://docs.github.com/en/actions/security-guides/encrypted-secrets' };
  if (e.GITLAB_CI)                   return { inCI: true, platform: 'GitLab CI',       addEnvUrl: 'https://docs.gitlab.com/ee/ci/variables/' };
  if (e.CIRCLECI)                    return { inCI: true, platform: 'CircleCI',        addEnvUrl: 'https://circleci.com/docs/env-vars/' };
  if (e.RENDER)                      return { inCI: true, platform: 'Render',          addEnvUrl: 'https://render.com/docs/environment-variables' };
  if (e.FLY_APP_NAME)                return { inCI: true, platform: 'Fly.io',          addEnvUrl: 'https://fly.io/docs/reference/secrets/' };
  if (e.RAILWAY_ENVIRONMENT)         return { inCI: true, platform: 'Railway',         addEnvUrl: 'https://docs.railway.app/develop/variables' };
  if (e.HEROKU_APP_NAME || e.DYNO)   return { inCI: true, platform: 'Heroku',          addEnvUrl: 'https://devcenter.heroku.com/articles/config-vars' };
  if (e.AWS_LAMBDA_FUNCTION_NAME)    return { inCI: true, platform: 'AWS Lambda',      addEnvUrl: 'https://docs.aws.amazon.com/lambda/latest/dg/configuration-envvars.html' };
  if (e.CI)                          return { inCI: true, platform: 'CI',              addEnvUrl: null };
  return { inCI: false, platform: 'local', addEnvUrl: null };
}

// Keys that are _always_ considered declared — they come from the
// runtime/platform, not from the app.
const RUNTIME_ENV_ALLOWLIST = new Set([
  'NODE_ENV', 'PORT', 'HOST', 'HOME', 'PATH', 'USER', 'PWD', 'LANG',
  'TZ', 'TMPDIR', 'TEMP', 'TMP', 'CI', 'VERCEL', 'VERCEL_ENV',
  'VERCEL_URL', 'VERCEL_REGION', 'VERCEL_GIT_COMMIT_SHA',
  'VERCEL_GIT_COMMIT_REF', 'VERCEL_GIT_COMMIT_MESSAGE',
  'VERCEL_GIT_COMMIT_AUTHOR_LOGIN', 'VERCEL_GIT_REPO_SLUG',
  'VERCEL_GIT_REPO_OWNER', 'NEXT_RUNTIME', 'NEXT_PHASE',
  'RENDER', 'HEROKU', 'NETLIFY', 'AWS_LAMBDA_FUNCTION_NAME',
  'AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_EXECUTION_ENV',
  'GITHUB_ACTIONS', 'GITHUB_WORKFLOW', 'GITHUB_REPOSITORY',
  'GITHUB_SHA', 'GITHUB_REF', 'GITHUB_TOKEN', 'GITHUB_ACTOR',
  'GITLAB_CI', 'CI_COMMIT_SHA', 'CI_PIPELINE_ID',
  'DEBUG', '__NEXT_PRIVATE_ORIGIN',
  // Windows OS variables — never app-controlled
  'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'WINDIR', 'SYSTEMROOT',
  'COMPUTERNAME', 'USERNAME', 'USERDOMAIN', 'PROCESSOR_ARCHITECTURE',
]);

// Env-key shape: UPPER_SNAKE, at least 2 chars.
const ENV_KEY_RE = /^[A-Z][A-Z0-9_]{1,}$/;

// process.env.FOO  /  process.env['FOO']  /  process.env["FOO"]
const NODE_ENV_REF_RE = /\bprocess\.env\.([A-Z][A-Z0-9_]+)\b|\bprocess\.env\[\s*['"`]([A-Z][A-Z0-9_]+)['"`]\s*\]/g;

// os.environ["FOO"] / os.environ.get("FOO") / os.getenv("FOO")
const PY_ENV_REF_RE = /\bos\.(?:environ\[|environ\.get\(|getenv\()\s*['"]([A-Z][A-Z0-9_]+)['"]/g;

// Go: os.Getenv("FOO") / os.LookupEnv("FOO")
const GO_ENV_REF_RE = /\bos\.(?:Getenv|LookupEnv)\(\s*"([A-Z][A-Z0-9_]+)"/g;

class EnvVarsModule extends BaseModule {
  constructor() {
    super(
      'envVars',
      'Env-vars — cross-reference process.env / os.environ reads against .env.example and CI env blocks; flag missing and unused keys',
    );
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;

    const { all: declared, root: rootDeclared } = this._harvestDeclared(projectRoot);
    const referenced = this._harvestReferenced(projectRoot);

    if (declared.size === 0 && referenced.size === 0) {
      result.addCheck('env-vars:no-env', true, {
        severity: 'info',
        message: 'No `.env.example` / no `process.env.*` references found — skipping',
      });
      return;
    }

    result.addCheck('env-vars:scanning', true, {
      severity: 'info',
      message: `Env audit: ${declared.size} declared key(s), ${referenced.size} referenced key(s)`,
    });

    let issues = 0;

    // Missing-from-example: referenced in code, not declared.
    for (const [key, refs] of referenced) {
      if (RUNTIME_ENV_ALLOWLIST.has(key)) continue;
      if (declared.has(key)) continue;
      const firstRef = refs[0];
      issues += this._flag(result, `env-vars:missing-from-example:${key}`, {
        severity: 'error',
        key,
        file: firstRef.file,
        line: firstRef.line,
        references: refs.length,
        message: `\`process.env.${key}\` is read in ${refs.length} location(s) (first: ${firstRef.file}:${firstRef.line}) but \`${key}\` is NOT in \`.env.example\` / \`.env.sample\` / CI env — production deploy will boot a broken app`,
        suggestion: `Add \`${key}=\` to \`.env.example\` with a comment explaining what it is. If it has a safe default, use \`process.env.${key} || <default>\` at the call site.`,
      });
    }

    // Unused-in-code: declared in .env.example, not referenced.
    for (const key of declared) {
      if (RUNTIME_ENV_ALLOWLIST.has(key)) continue;
      if (referenced.has(key)) continue;
      issues += this._flag(result, `env-vars:unused-in-code:${key}`, {
        severity: 'warning',
        key,
        message: `\`${key}\` is declared in \`.env.example\` but nothing in the codebase reads it — dead configuration`,
        suggestion: `Either delete \`${key}\` from \`.env.example\`, or add the \`process.env.${key}\` reference that was planned.`,
      });
    }

    // Runtime completeness: when running inside CI/a deployment platform,
    // cross-reference .env.example keys against the ACTUAL process.env.
    // Any key that is declared in .env.example, is read in code, and is
    // NOT set in the current environment will crash the app on boot.
    //
    // Only check root-level env files — subdirectory env files (e.g.
    // website/.env.example) represent a different deployment context
    // (Vercel, a sub-package, etc.) and should not be checked against
    // the parent repo's CI environment.
    //
    // This check can be disabled via .gatetest.json:
    //   { "modules": { "envVars": { "skipRuntimeCheck": true } } }
    const moduleConfig = typeof config.getModuleConfig === 'function'
      ? config.getModuleConfig('envVars')
      : {};
    const { inCI, platform, addEnvUrl } = detectPlatform();
    if (!moduleConfig.skipRuntimeCheck && inCI && rootDeclared.size > 0) {
      for (const key of rootDeclared) {
        if (RUNTIME_ENV_ALLOWLIST.has(key)) continue;
        if (!(key in process.env) || process.env[key] === '') {
          const isReferenced = referenced.has(key);
          const severity = isReferenced ? 'error' : 'warning';
          const tip = addEnvUrl ? ` See: ${addEnvUrl}` : '';
          issues += this._flag(result, `env-vars:missing-from-runtime:${key}`, {
            severity,
            key,
            platform,
            message: isReferenced
              ? `\`${key}\` is declared in \`.env.example\` and read in code but is NOT set in this ${platform} environment — app will crash on boot`
              : `\`${key}\` is declared in \`.env.example\` but is NOT set in this ${platform} environment`,
            suggestion: `Add \`${key}\` to your ${platform} environment variables.${tip}`,
          });
        }
      }
    }

    // NEXT_PUBLIC_* info pass.
    for (const [key, refs] of referenced) {
      if (!key.startsWith('NEXT_PUBLIC_') && !key.startsWith('VITE_') && !key.startsWith('REACT_APP_')) continue;
      const firstRef = refs[0];
      issues += this._flag(result, `env-vars:client-exposed:${key}`, {
        severity: 'info',
        key,
        file: firstRef.file,
        line: firstRef.line,
        message: `\`${key}\` is a client-bundled env var — its value ships to every browser. Never put secrets here.`,
        suggestion: `If \`${key}\` holds a secret, rename it to drop the \`NEXT_PUBLIC_\` / \`VITE_\` / \`REACT_APP_\` prefix and move reads to server-only code.`,
      });
    }

    result.addCheck('env-vars:summary', true, {
      severity: 'info',
      message: `Env-vars scan: declared=${declared.size}, referenced=${referenced.size}, issues=${issues}`,
    });
  }

  _harvestDeclared(projectRoot) {
    const declared = new Set(); // all keys from any depth
    const root = new Set();    // keys from root-level env files only
    const walk = (dir, depth = 0) => {
      if (depth > 12) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (DEFAULT_EXCLUDES.includes(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full, depth + 1); continue; }
        if (!entry.isFile()) continue;

        if (ENV_BASENAME_RE.test(entry.name)) {
          // Root-level .env.example files represent THIS deployment context;
          // subdirectory ones represent separate contexts (Vercel sub-app, etc.)
          const target = depth === 0 ? root : declared;
          this._harvestEnvFile(full, target);
          if (depth === 0) this._harvestEnvFile(full, declared);
        } else if (
          entry.name === 'vercel.json' ||
          entry.name === 'netlify.toml' ||
          entry.name === 'docker-compose.yml' ||
          entry.name === 'docker-compose.yaml' ||
          entry.name === 'compose.yml' ||
          entry.name === 'compose.yaml'
        ) {
          this._harvestConfigFile(full, declared);
        } else if (full.split(path.sep).join('/').includes('.github/workflows/') && CI_WORKFLOW_RE.test(entry.name)) {
          this._harvestWorkflowFile(full, declared);
        }
      }
    };
    walk(projectRoot);
    return { all: declared, root };
  }

  _harvestEnvFile(file, out) {
    let content;
    try { content = fs.readFileSync(file, 'utf-8'); } catch { return; }
    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      // Remove optional `export `
      const body = line.replace(/^export\s+/, '');
      const eq = body.indexOf('=');
      if (eq <= 0) continue;
      const key = body.slice(0, eq).trim();
      if (ENV_KEY_RE.test(key)) out.add(key);
    }
  }

  _harvestConfigFile(file, out) {
    let content;
    try { content = fs.readFileSync(file, 'utf-8'); } catch { return; }
    // Match ${VAR} interpolations (docker-compose, netlify.toml).
    const interp = /\$\{([A-Z][A-Z0-9_]+)(?::-[^}]*)?\}/g;
    let m;
    while ((m = interp.exec(content)) !== null) out.add(m[1]);
    // vercel.json has `"env": { "KEY": "@..." }`.
    if (file.endsWith('vercel.json')) {
      try {
        const json = JSON.parse(content);
        const env = json.env || {};
        for (const k of Object.keys(env)) {
          if (ENV_KEY_RE.test(k)) out.add(k);
        }
      } catch { /* ignore */ }
    }
    // docker-compose environment: KEY: value lines (cheap YAML peek).
    // Only consume lines that look like `  KEY: value` inside an
    // `environment:` block. We approximate state with a flag.
    let inEnv = false;
    for (const ln of content.split('\n')) {
      if (/^\s*environment\s*:\s*$/.test(ln)) { inEnv = true; continue; }
      if (inEnv) {
        if (/^\S/.test(ln)) { inEnv = false; }
        const match = ln.match(/^\s+-?\s*([A-Z][A-Z0-9_]+)\s*[:=]/);
        if (match) out.add(match[1]);
      }
    }
  }

  _harvestWorkflowFile(file, out) {
    let content;
    try { content = fs.readFileSync(file, 'utf-8'); } catch { return; }
    // `env:` block: lines indented under `env:` header look like
    // `  FOO: ${{ secrets.FOO }}` or `  FOO: bar`.
    let inEnv = false;
    let envIndent = -1;
    for (const ln of content.split('\n')) {
      const headerMatch = ln.match(/^(\s*)env\s*:\s*$/);
      if (headerMatch) { inEnv = true; envIndent = headerMatch[1].length; continue; }
      if (inEnv) {
        const lineIndent = ln.match(/^(\s*)/)[1].length;
        if (ln.trim() === '' ) continue;
        if (lineIndent <= envIndent) { inEnv = false; continue; }
        const km = ln.match(/^\s+([A-Z][A-Z0-9_]+)\s*:/);
        if (km) out.add(km[1]);
      }
    }
    // Also harvest `secrets.X` and `vars.X` refs — `secrets.X` means
    // the maintainer has decided `X` is a platform secret, so treat as
    // "declared at CI level".
    const secretsRe = /\b(?:secrets|vars)\.([A-Z][A-Z0-9_]+)\b/g;
    let m;
    while ((m = secretsRe.exec(content)) !== null) out.add(m[1]);
  }

  _harvestReferenced(projectRoot) {
    const referenced = new Map(); // key → [{file, line}]
    const walk = (dir, depth = 0) => {
      if (depth > 12) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (DEFAULT_EXCLUDES.includes(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full, depth + 1); continue; }
        if (!entry.isFile()) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (!CODE_EXTS.has(ext)) continue;
        const rel = path.relative(projectRoot, full).split(path.sep).join('/');
        if (TEST_PATH_RE.test(rel)) continue;
        if (DEV_CONFIG_BASENAME_RE.test(entry.name)) continue;
        this._scanReferences(full, projectRoot, referenced);
      }
    };
    walk(projectRoot);
    return referenced;
  }

  _scanReferences(file, projectRoot, referenced) {
    let content;
    try { content = fs.readFileSync(file, 'utf-8'); } catch { return; }
    const rel = path.relative(projectRoot, file);
    const lines = content.split('\n');
    const ext = path.extname(file).toLowerCase();

    const patterns = [];
    const isJs = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts'].includes(ext);
    const isPy = ext === '.py';
    const isGo = ext === '.go';
    if (isJs) patterns.push(NODE_ENV_REF_RE);
    if (isPy) patterns.push(PY_ENV_REF_RE);
    if (isGo) patterns.push(GO_ENV_REF_RE);

    let inBlockComment = false;
    let inPyDoc = false;
    for (let i = 0; i < lines.length; i += 1) {
      const raw = lines[i];
      let line = raw;
      const trimmed = raw.trim();

      // JS / Go block-comment awareness.
      if (isJs || isGo) {
        if (inBlockComment) {
          if (/\*\//.test(line)) inBlockComment = false;
          continue;
        }
        if (/^\s*\/\*/.test(line) && !/\*\//.test(line)) {
          inBlockComment = true;
          continue;
        }
        // Strip inline line-comment and inline block-comment.
        line = line.replace(/\/\/.*$/, '');
        line = line.replace(/\/\*.*?\*\//g, '');
        if (trimmed.startsWith('*')) continue;
      }
      // Python docstring awareness (triple-quoted).
      if (isPy) {
        const tripleMatches = (raw.match(/"""/g) || []).length + (raw.match(/'''/g) || []).length;
        if (inPyDoc) {
          if (tripleMatches % 2 === 1) inPyDoc = false;
          continue;
        }
        if (tripleMatches % 2 === 1) { inPyDoc = true; continue; }
        if (trimmed.startsWith('#')) continue;
      }

      for (const re of patterns) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(line)) !== null) {
          const key = m[1] || m[2];
          if (!key || !ENV_KEY_RE.test(key)) continue;
          // For JS, skip matches inside a string literal (these are
          // documentation / advice strings, not real reads).
          if (isJs && isInString(raw, m.index)) continue;
          if (!referenced.has(key)) referenced.set(key, []);
          referenced.get(key).push({ file: rel, line: i + 1 });
        }
      }
    }
  }

  _flag(result, name, details) {
    result.addCheck(name, false, details);
    return 1;
  }
}

module.exports = EnvVarsModule;
