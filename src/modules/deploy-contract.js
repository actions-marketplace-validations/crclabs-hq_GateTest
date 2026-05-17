/**
 * Deploy Contract Module — cross-references health-check URLs in deploy scripts
 * and CI YAML run: blocks against actual route handlers in the codebase.
 * Understands framework basePath prefixes (Hono, Express router, Fastify prefix).
 * Catches "curl /health but the route is /api/health" before it reaches production.
 */

const BaseModule = require('./base-module');
const fs   = require('fs');
const path = require('path');

const CURL_PATTERN  = /curl\s+(?:-[a-zA-Z0-9]+\s+)*['"]?(https?:\/\/[^\s'"]+|localhost[^\s'"#]*|127\.[0-9.]+[^\s'"#]*|\$\{?[A-Z_]+\}?[^\s'"#]*)['"]?/g;
const WGET_PATTERN  = /wget\s+(?:-[a-zA-Z0-9]+\s+)*['"]?(https?:\/\/[^\s'"]+|localhost[^\s'"#]*|\$\{?[A-Z_]+\}?[^\s'"#]*)['"]?/g;
const HEALTH_WORDS  = /health|ping|ready|alive|status|liveness|readiness/i;

// Route detection
const EXPRESS_ROUTE = /(?:app|router)\.(get|post|put|patch|delete|all)\s*\(\s*['"`]([^'"`]+)/g;
const FASTIFY_ROUTE = /fastify\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)/g;
const HONO_ROUTE    = /(?:app|hono)\.(get|post|put|patch|delete|all)\s*\(\s*['"`]([^'"`]+)/g;

// Base path / prefix detection — covers Hono .basePath(), Express router prefix, Fastify prefix
// Matches: app.basePath('/api'), new Hono().basePath('/api'), hono.basePath('/api')
const HONO_BASE     = /\.basePath\s*\(\s*['"`]([^'"`]+)/g;
const EXPRESS_USE   = /(?:app|server)\.use\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*(?:router|[a-zA-Z]+Router)/g;
const FASTIFY_PRE   = /fastify\.register\s*\([^,]+,\s*\{[^}]*prefix\s*:\s*['"`]([^'"`]+)/g;

class DeployContractModule extends BaseModule {
  constructor() { super('deployContract', 'Deploy Contract Validator'); }

  async run(result, config) {
    const root = config.projectRoot;

    const basePaths = this._findBasePaths(root);
    const rawRoutes = this._findRoutes(root);
    // Expand routes with all known base-path prefixes
    const routes = this._expandRoutes(rawRoutes, basePaths);

    const healthUrls = this._findHealthCheckUrls(root);

    if (healthUrls.length === 0) {
      result.addCheck('deploy-health-urls', true, { severity: 'info', fix: 'No curl/wget health-check calls found in deploy scripts or CI workflows' });
      return;
    }

    for (const { file, url, path: urlPath, line } of healthUrls) {
      if (!urlPath) {
        result.addCheck('deploy-health-url-unresolvable', true, { severity: 'info', fix: `Dynamic URL in ${path.relative(root, file)} — cannot statically resolve` });
        continue;
      }

      const matched = routes.some(r => this._pathMatches(urlPath, r));

      if (!matched) {
        const rel = path.relative(root, file);
        const knownRoutes = routes.slice(0, 10).join(', ');
        const basePrefixes = basePaths.length > 0 ? ` (detected base paths: ${basePaths.join(', ')})` : '';
        result.addCheck(`deploy-contract:${urlPath}`, false, {
          severity: 'error',
          fix: `${rel}:${line || '?'} — deploy curls "${urlPath}" but no route handler matches this path${basePrefixes}.\nKnown routes: ${knownRoutes || '(none found)'}\nFix: correct the URL in the deploy script or add the missing route.`,
          file,
        });
      } else {
        result.addCheck(`deploy-contract:${urlPath}`, true, { severity: 'info', fix: `Health-check URL "${urlPath}" matched to a route handler` });
      }
    }

    // Check for base-path mismatch specifically
    for (const { path: urlPath, file, line } of healthUrls.filter(u => u.path)) {
      for (const base of basePaths) {
        const routeWithoutBase = rawRoutes.find(r => {
          const withBase = base.replace(/\/$/, '') + r;
          return this._pathMatches(urlPath, r) && !this._pathMatches(urlPath, withBase);
        });
        if (routeWithoutBase) {
          result.addCheck(`deploy-contract:basepath:${urlPath}`, false, {
            severity: 'error',
            fix: `${path.relative(root, file)}:${line || '?'} — deploy curls "${urlPath}" but the route is mounted under basePath "${base}", making the actual URL "${base}${routeWithoutBase}". Missing base-path prefix.`,
            file,
          });
        }
      }
    }
  }

  _findHealthCheckUrls(root) {
    // Shell scripts + CI YAML files
    const files = this._glob(root, /\.(sh|yml|yaml|bash)$/, ['node_modules', '.git', '.claude', '.next', 'dist']);
    const found = [];

    for (const file of files) {
      let content;
      try { content = fs.readFileSync(file, 'utf8'); } catch { continue; }
      const lines = content.split('\n');

      lines.forEach((rawLine, idx) => {
        // Strip YAML 'run: |' prefix noise
        const line = rawLine.replace(/^\s*-?\s*run:\s*\|?\s*/, '').trim();

        for (const pattern of [CURL_PATTERN, WGET_PATTERN]) {
          pattern.lastIndex = 0;
          let m;
          while ((m = pattern.exec(line)) !== null) {
            const raw = m[1] || '';
            // Only flag URLs that look like health-check paths
            if (!HEALTH_WORDS.test(raw) && !HEALTH_WORDS.test(file)) continue;

            let urlPath = null;
            try {
              const placeholder = 'http://localhost'; // hardcoded-url-ok — URL parsing placeholder, never used in network calls
              const full = raw.replace(/\$\{?[A-Z_]+\}?/g, placeholder);
              urlPath = new URL(full.startsWith('http') ? full : `${placeholder}${full}`).pathname;
            } catch { /* dynamic URL */ }

            found.push({ file, url: raw, path: urlPath, line: idx + 1 });
          }
        }
      });
    }
    return found;
  }

  _findBasePaths(root) {
    const bases = new Set();
    const files = this._glob(root, /\.(js|ts|mjs)$/, ['node_modules', '.next', 'dist', '.git', 'tests', '__tests__']);

    for (const file of files) {
      let content;
      try { content = fs.readFileSync(file, 'utf8'); } catch { continue; }

      for (const pattern of [HONO_BASE, EXPRESS_USE, FASTIFY_PRE]) {
        pattern.lastIndex = 0;
        let m;
        while ((m = pattern.exec(content)) !== null) {
          if (m[1] && m[1] !== '/') bases.add(m[1]);
        }
      }
    }
    return [...bases];
  }

  _findRoutes(root) {
    const routes = new Set();

    // Next.js App Router
    for (const file of this._glob(root, /app\/api\/.+\/route\.[jt]sx?$/, ['node_modules'])) {
      const m = file.replace(/\\/g, '/').match(/app\/api\/(.+)\/route\.[jt]sx?$/);
      if (m) routes.add('/api/' + m[1].replace(/\[([^\]]+)\]/g, ':$1'));
    }

    // Express / Fastify / Hono source
    const sourceFiles = this._glob(root, /\.(js|ts|mjs)$/, ['node_modules', '.next', 'dist', '.git']);
    for (const file of sourceFiles) {
      let content;
      try { content = fs.readFileSync(file, 'utf8'); } catch { continue; }
      for (const pattern of [EXPRESS_ROUTE, FASTIFY_ROUTE, HONO_ROUTE]) {
        pattern.lastIndex = 0;
        let m;
        while ((m = pattern.exec(content)) !== null) routes.add(m[2]);
      }
    }
    return [...routes];
  }

  _expandRoutes(rawRoutes, basePaths) {
    const expanded = new Set(rawRoutes);
    for (const base of basePaths) {
      const prefix = base.replace(/\/$/, '');
      for (const r of rawRoutes) {
        expanded.add(prefix + (r.startsWith('/') ? r : '/' + r));
      }
    }
    return [...expanded];
  }

  _pathMatches(urlPath, route) {
    if (urlPath === route) return true;
    const rNorm = route.replace(/:([^/]+)/g, '*').replace(/\{([^}]+)\}/g, '*');
    if (rNorm === urlPath) return true;
    if (urlPath.startsWith(rNorm.replace(/\*$/, '').replace(/\/$/, ''))) return true;
    return false;
  }

  _glob(root, pattern, excludes = []) {
    const results = [];
    const walk = (dir) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (excludes.some(x => e.name === x || dir.includes(`/${x}`))) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (pattern.test(full.replace(/\\/g, '/'))) results.push(full);
      }
    };
    walk(root);
    return results;
  }
}

module.exports = DeployContractModule;
