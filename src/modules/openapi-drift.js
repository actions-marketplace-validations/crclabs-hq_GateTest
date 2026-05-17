/**
 * OpenAPI ↔ Code Drift Module.
 *
 * Every team with an OpenAPI spec has this bug: the spec and the
 * actual routes drift apart. Someone adds a route to Express and
 * forgets to update the spec. Someone deletes a route and forgets
 * to remove it from the spec. Six months later the generated
 * client starts failing in production because the endpoint it
 * expects is 404, OR a new endpoint silently ships with no
 * documented contract and external integrators don't know about it.
 *
 * The universe where this matters:
 *   - You publish `openapi.yaml` / `swagger.json` for consumers.
 *   - You generate types / client from the spec (openapi-typescript,
 *     openapi-generator, swagger-codegen).
 *   - You use FastAPI / drf-spectacular / NestJS @nestjs/swagger,
 *     which *claim* to keep spec and code in sync but only for the
 *     routes they see — missed decorators drift silently.
 *
 * Why mainstream tooling misses this:
 *   - `openapi-cli lint` validates spec syntax, not spec↔code.
 *   - `dredd` runs contract tests but only against a running server
 *     — a missing test-covered endpoint isn't caught.
 *   - `schemathesis` is fuzzing, not drift detection.
 *   - Zero tools do static spec↔code cross-reference for Express /
 *     Fastify / Next.js App Router / Hono / Koa simultaneously.
 *
 * Detection:
 *
 *   Phase 1 — Harvest OpenAPI paths:
 *     - Scan `openapi.{yaml,yml,json}` / `swagger.{yaml,yml,json}` /
 *       `api-spec/*`, `docs/openapi.*`, `openapi/*.yaml` etc.
 *     - Extract path+method pairs from the `paths:` block.
 *
 *   Phase 2 — Harvest code routes:
 *     - Express / Connect: `app.get('/x', ...)`, `router.post('/y', ...)`
 *     - Fastify: `fastify.get('/x', ...)`, `fastify.route({ url, method })`
 *     - Koa + koa-router: `router.get('/x', ...)`
 *     - Hono: `app.get('/x', ...)`, `app.post('/y', ...)`
 *     - Next.js App Router: `app/api/<path>/route.ts` files that
 *       export `GET` / `POST` / `PATCH` / `PUT` / `DELETE` functions.
 *
 *   Phase 3 — Cross-reference:
 *     - Code route not in spec → error: `undocumented-route`
 *     - Spec route not in code → warning: `spec-ghost-route` (could be
 *       a real implementation in a file pattern we don't scan, so
 *       warning rather than error)
 *     - Path-param name mismatch (`/users/{userId}` vs `/users/:id`)
 *       → info (different languages use different conventions)
 *
 * Rules:
 *
 *   error:   Route exists in code but is missing from OpenAPI spec
 *            — consumers using the generated client won't know it
 *            exists, or worse, won't know its exact contract.
 *            (rule: `openapi-drift:undocumented-route:<METHOD>:<path>`)
 *
 *   warning: Route exists in OpenAPI spec but no matching handler
 *            found in code — either the spec is out of date or the
 *            handler lives in a file we don't parse. Review.
 *            (rule: `openapi-drift:spec-ghost-route:<METHOD>:<path>`)
 *
 * TODO(gluecron): host-neutral — static spec and source scan.
 */

const fs = require('fs');
const path = require('path');
const BaseModule = require('./base-module');

const DEFAULT_EXCLUDES = [
  'node_modules', '.git', '.claude', 'dist', 'build', 'coverage', '.gatetest',
  '.next', '__pycache__', 'target', 'vendor', '.terraform', 'out',
];

const SOURCE_EXTS = new Set([
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts',
]);

const SPEC_BASENAME_RE = /^(?:openapi|swagger|api-spec|api)(?:\.[A-Za-z0-9_-]+)?\.(?:ya?ml|json)$/i;
const SPEC_DIR_RE = /(?:^|\/)(?:openapi|swagger|api-spec|specs?|docs?)\//i;

const TEST_PATH_RE = /(?:^|\/)(?:tests?|__tests__|spec|fixtures?|stories|storybook|e2e)(?:\/|$)|\.(?:test|spec|stories|fixture|e2e)\.(?:js|jsx|ts|tsx|mjs|cjs|mts|cts)$/i;

// Route-definition shapes across common Node frameworks.
// Captures: method (lowercase), path literal (quoted).
const ROUTE_RE = /\b(?:app|router|fastify|server|api)\s*\.\s*(get|post|put|patch|delete|options|head|all)\s*\(\s*['"`]([^'"`]+)['"`]/g;

// Fastify alt shape: `fastify.route({ method: 'GET', url: '/x', ... })`
const FASTIFY_ROUTE_OBJ_RE = /\bfastify\s*\.\s*route\s*\(\s*\{[^}]*?\bmethod\s*:\s*['"`]([A-Z]+)['"`][^}]*?\burl\s*:\s*['"`]([^'"`]+)['"`]/gms;
const FASTIFY_ROUTE_OBJ_ALT_RE = /\bfastify\s*\.\s*route\s*\(\s*\{[^}]*?\burl\s*:\s*['"`]([^'"`]+)['"`][^}]*?\bmethod\s*:\s*['"`]([A-Z]+)['"`]/gms;

class OpenApiDriftModule extends BaseModule {
  constructor() {
    super(
      'openapiDrift',
      'OpenAPI ↔ code drift detector — flags routes defined in code but missing from openapi.yaml, and spec paths with no matching handler',
    );
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;

    // Phase 1: harvest spec paths.
    const specFiles = this._findSpecs(projectRoot);

    if (specFiles.length === 0) {
      result.addCheck('openapi-drift:no-spec', true, {
        severity: 'info',
        message: 'No OpenAPI / Swagger spec found — skipping drift check',
      });
      return;
    }

    const specPaths = new Map(); // "METHOD /path" -> { file }
    for (const sf of specFiles) {
      this._harvestSpec(sf, projectRoot, specPaths);
    }

    result.addCheck('openapi-drift:spec-loaded', true, {
      severity: 'info',
      message: `Loaded ${specPaths.size} path+method pair(s) from ${specFiles.length} spec file(s)`,
    });

    // Phase 2: harvest code routes.
    const codeFiles = this._findCodeFiles(projectRoot);
    const codeRoutes = new Map(); // "METHOD /path" -> { file, line }
    for (const cf of codeFiles) {
      this._harvestCode(cf, projectRoot, codeRoutes);
    }
    this._harvestNextAppRouter(projectRoot, codeRoutes);

    result.addCheck('openapi-drift:code-scanned', true, {
      severity: 'info',
      message: `Found ${codeRoutes.size} route(s) across code`,
    });

    // Phase 3: cross-reference.
    let issues = 0;

    for (const [key, meta] of codeRoutes) {
      if (!this._matchesAnySpec(key, specPaths)) {
        const [method, p] = key.split(' ', 2);
        issues += this._flag(result, `openapi-drift:undocumented-route:${method}:${p}`, {
          severity: 'error',
          file: meta.file,
          line: meta.line,
          method,
          path: p,
          message: `${meta.file}:${meta.line} route \`${method} ${p}\` is defined in code but missing from the OpenAPI spec — consumers using the generated client don't know this endpoint exists`,
          suggestion: `Add \`${p}\` under \`paths:\` in the OpenAPI spec with method \`${method.toLowerCase()}\` and document its request / response schemas. Keeping spec and code aligned is the only thing that makes a generated client trustworthy.`,
        });
      }
    }

    for (const [key, meta] of specPaths) {
      if (!this._matchesAnyCode(key, codeRoutes)) {
        const [method, p] = key.split(' ', 2);
        issues += this._flag(result, `openapi-drift:spec-ghost-route:${method}:${p}`, {
          severity: 'warning',
          file: meta.file,
          method,
          path: p,
          message: `${meta.file} declares \`${method} ${p}\` but no matching handler was found in scanned source — either the spec is stale or the handler lives in a file we don't parse`,
          suggestion: `Either implement \`${method} ${p}\` in code, remove it from the spec if it was never shipped, or if the handler genuinely lives in a language / framework the static scan doesn't cover (Python FastAPI, Go, etc.), this warning can be ignored.`,
        });
      }
    }

    result.addCheck('openapi-drift:summary', true, {
      severity: 'info',
      message: `OpenAPI drift: ${specPaths.size} spec path(s), ${codeRoutes.size} code route(s), ${issues} drift issue(s)`,
    });
  }

  _findSpecs(projectRoot) {
    const out = [];
    const walk = (dir, depth = 0) => {
      if (depth > 6) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (DEFAULT_EXCLUDES.includes(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, depth + 1);
        else if (entry.isFile() && SPEC_BASENAME_RE.test(entry.name)) out.push(full);
      }
    };
    walk(projectRoot);
    return out;
  }

  _findCodeFiles(projectRoot) {
    const out = [];
    const walk = (dir, depth = 0) => {
      if (depth > 12) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (DEFAULT_EXCLUDES.includes(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, depth + 1);
        else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (SOURCE_EXTS.has(ext)) out.push(full);
        }
      }
    };
    walk(projectRoot);
    return out;
  }

  _harvestSpec(file, projectRoot, specPaths) {
    let content;
    try { content = fs.readFileSync(file, 'utf-8'); } catch { return; }
    const rel = path.relative(projectRoot, file);

    if (file.toLowerCase().endsWith('.json')) {
      let parsed;
      try { parsed = JSON.parse(content); } catch { return; }
      this._walkOpenApiPaths(parsed, rel, specPaths);
      return;
    }

    // YAML — minimal extractor. We look for the `paths:` top-level
    // section and walk indented entries.
    const lines = content.split('\n');
    let inPaths = false;
    let pathsIndent = 0;
    let currentPath = null;
    let currentPathIndent = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (/^\s*#/.test(line)) continue;
      const m = /^(\s*)paths\s*:\s*$/.exec(line);
      if (m) {
        inPaths = true;
        pathsIndent = m[1].length;
        continue;
      }
      if (!inPaths) continue;

      // Exit when we leave the paths block.
      const leadMatch = /^(\s*)\S/.exec(line);
      if (leadMatch && leadMatch[1].length <= pathsIndent && !/^\s*$/.test(line)) {
        // A new top-level key started — only exit if it's strictly
        // at-or-under pathsIndent and it's not a continuation.
        if (leadMatch[1].length <= pathsIndent) {
          inPaths = false;
          continue;
        }
      }

      // A path entry looks like:   `  /users/{id}:` at pathsIndent + n.
      // Note: `:` must NOT be in the char class — it's the YAML
      // field separator, and including it would greedily consume the
      // trailing `:` and make the regex fail to match.
      const pm = /^(\s*)(\/[A-Za-z0-9_{}\-./]*)\s*:\s*$/.exec(line);
      if (pm && pm[1].length > pathsIndent) {
        currentPath = pm[2];
        currentPathIndent = pm[1].length;
        continue;
      }

      // A method line matches both block form (`    get:`) and inline
      // form (`    get: { summary: x }`). We require the method word,
      // a colon, then either end-of-line or whitespace/inline-object.
      const mm = /^(\s*)(get|post|put|patch|delete|options|head|trace)\s*:\s*(?:$|[\s{])/i.exec(line);
      if (mm && currentPath && mm[1].length > currentPathIndent) {
        const method = mm[2].toUpperCase();
        const normalized = this._normalizeSpecPath(currentPath);
        specPaths.set(`${method} ${normalized}`, { file: rel });
      }
    }
  }

  _walkOpenApiPaths(obj, rel, specPaths) {
    if (!obj || typeof obj !== 'object') return;
    const paths = obj.paths;
    if (!paths || typeof paths !== 'object') return;
    for (const p of Object.keys(paths)) {
      const entry = paths[p];
      if (!entry || typeof entry !== 'object') continue;
      for (const method of ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace']) {
        if (entry[method]) {
          const normalized = this._normalizeSpecPath(p);
          specPaths.set(`${method.toUpperCase()} ${normalized}`, { file: rel });
        }
      }
    }
  }

  _harvestCode(file, projectRoot, codeRoutes) {
    let content;
    try { content = fs.readFileSync(file, 'utf-8'); } catch { return; }

    const rel = path.relative(projectRoot, file);
    if (TEST_PATH_RE.test(rel)) return;

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*')) continue;

      ROUTE_RE.lastIndex = 0;
      let m;
      while ((m = ROUTE_RE.exec(line)) !== null) {
        const method = m[1].toUpperCase();
        if (method === 'ALL') {
          // Express's .all() registers every method. Skip — too noisy
          // to cross-reference.
          continue;
        }
        const p = m[2];
        if (!p.startsWith('/')) continue;
        const normalized = this._normalizeCodePath(p);
        const key = `${method} ${normalized}`;
        if (!codeRoutes.has(key)) {
          codeRoutes.set(key, { file: rel, line: i + 1 });
        }
      }
    }

    // Fastify object-form routes (can span multiple lines).
    FASTIFY_ROUTE_OBJ_RE.lastIndex = 0;
    let m;
    while ((m = FASTIFY_ROUTE_OBJ_RE.exec(content)) !== null) {
      const method = m[1].toUpperCase();
      const p = m[2];
      if (!p.startsWith('/')) continue;
      const before = content.slice(0, m.index);
      const lineNum = before.split('\n').length;
      const key = `${method} ${this._normalizeCodePath(p)}`;
      if (!codeRoutes.has(key)) codeRoutes.set(key, { file: rel, line: lineNum });
    }
    FASTIFY_ROUTE_OBJ_ALT_RE.lastIndex = 0;
    while ((m = FASTIFY_ROUTE_OBJ_ALT_RE.exec(content)) !== null) {
      const p = m[1];
      const method = m[2].toUpperCase();
      if (!p.startsWith('/')) continue;
      const before = content.slice(0, m.index);
      const lineNum = before.split('\n').length;
      const key = `${method} ${this._normalizeCodePath(p)}`;
      if (!codeRoutes.has(key)) codeRoutes.set(key, { file: rel, line: lineNum });
    }
  }

  _harvestNextAppRouter(projectRoot, codeRoutes) {
    // Look for app/api/**/route.{ts,js}
    const walk = (dir, urlParts, depth = 0) => {
      if (depth > 12) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (DEFAULT_EXCLUDES.includes(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          // Convert [param] → {param}, (group) → nothing, other → literal.
          const segName = entry.name;
          if (segName.startsWith('(') && segName.endsWith(')')) {
            walk(full, urlParts, depth + 1);
          } else if (segName.startsWith('[') && segName.endsWith(']')) {
            const paramName = segName.slice(1, -1).replace(/^\.\.\.|\.\.\./g, '');
            walk(full, [...urlParts, `{${paramName}}`], depth + 1);
          } else {
            walk(full, [...urlParts, segName], depth + 1);
          }
        } else if (entry.isFile() && /^route\.(?:ts|tsx|js|jsx|mts|cts|mjs|cjs)$/i.test(entry.name)) {
          let content;
          try { content = fs.readFileSync(full, 'utf-8'); } catch { continue; }
          const rel = path.relative(projectRoot, full);
          const pathStr = '/' + urlParts.join('/');
          const normalized = pathStr === '/' ? '/' : pathStr.replace(/\/+$/, '');
          for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']) {
            // Look for `export async function GET(` / `export function GET(` / `export const GET =`.
            const methodRe = new RegExp(`\\bexport\\s+(?:async\\s+)?function\\s+${method}\\s*\\(|\\bexport\\s+const\\s+${method}\\s*=`, 'm');
            if (methodRe.test(content)) {
              const key = `${method} ${normalized}`;
              const m = content.match(methodRe);
              const lineNum = content.slice(0, m.index).split('\n').length;
              if (!codeRoutes.has(key)) codeRoutes.set(key, { file: rel, line: lineNum });
            }
          }
        }
      }
    };

    // Look for app/api under root and under common dirs like `website/`.
    // We start the walk with `['api']` because Next.js maps
    // `app/api/foo/route.ts` → URL `/api/foo`.
    const candidates = [
      path.join(projectRoot, 'app', 'api'),
      path.join(projectRoot, 'src', 'app', 'api'),
      path.join(projectRoot, 'website', 'app', 'api'),
      path.join(projectRoot, 'web', 'app', 'api'),
    ];
    for (const root of candidates) {
      if (!fs.existsSync(root)) continue;
      walk(root, ['api'], 0);
    }
  }

  _normalizeSpecPath(p) {
    // Leave as-is — OpenAPI uses {param} style.
    return p.replace(/\/+$/, '').replace(/^$/, '/');
  }

  _normalizeCodePath(p) {
    // Convert :param → {param} for matching.
    let out = p.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}');
    // Strip trailing slash, but leave root `/` alone.
    if (out.length > 1) out = out.replace(/\/+$/, '');
    return out;
  }

  _matchesAnySpec(codeKey, specPaths) {
    if (specPaths.has(codeKey)) return true;
    // Try match with any param name — i.e., `{id}` ~= `{userId}`.
    const [method, p] = codeKey.split(' ', 2);
    const codeShape = p.replace(/\{[^}]+\}/g, '{*}');
    for (const key of specPaths.keys()) {
      const [sMethod, sPath] = key.split(' ', 2);
      if (sMethod !== method) continue;
      if (sPath.replace(/\{[^}]+\}/g, '{*}') === codeShape) return true;
    }
    return false;
  }

  _matchesAnyCode(specKey, codeRoutes) {
    if (codeRoutes.has(specKey)) return true;
    const [method, p] = specKey.split(' ', 2);
    const specShape = p.replace(/\{[^}]+\}/g, '{*}');
    for (const key of codeRoutes.keys()) {
      const [cMethod, cPath] = key.split(' ', 2);
      if (cMethod !== method) continue;
      if (cPath.replace(/\{[^}]+\}/g, '{*}') === specShape) return true;
    }
    return false;
  }

  _flag(result, name, details) {
    result.addCheck(name, false, details);
    return 1;
  }
}

module.exports = OpenApiDriftModule;
