/**
 * Hardcoded-URL / Localhost / Private-IP Leak Module.
 *
 * The developer tests against a local service, commits `localhost:3000`
 * inline, and the string makes it through review, CI, and into prod.
 * In prod the URL dead-ends, the call 500s, and a feature that
 * "worked on my machine" is broken for every user.
 *
 * Variants:
 *   - `http://localhost:3000` / `http://127.0.0.1:8080`
 *   - `http://10.x.x.x`, `http://172.16-31.x.x`, `http://192.168.x.x`
 *     (RFC1918) committed to source
 *   - internal staging hostnames (`.internal`, `.local`, `.lan`,
 *     `.staging`, `.dev.mycompany.com`) baked in
 *   - personal IP addresses (the developer's laptop)
 *   - `http://` (non-TLS) in production code — downgrade attacks
 *
 * Legitimate exceptions (must NOT false-positive):
 *   - test / spec / fixture files
 *   - storybook files
 *   - `.env.example`, `.env.local`, docs, README
 *   - dev-only config blocks guarded by `NODE_ENV !== 'production'`
 *   - constants explicitly named `DEV_URL` / `LOCAL_URL` / `TEST_URL`
 *   - URLs inside block/line comments
 *   - `localhost` inside config schema descriptions / JSDoc
 *
 * Competitors:
 *   - ESLint doesn't catch it.
 *   - Semgrep has a localhost rule but no RFC1918 / staging coverage.
 *   - SonarQube has one 127.0.0.1 rule, nothing else.
 *   - Nothing unifies localhost + RFC1918 + internal-TLD + non-TLS.
 *
 * Rules:
 *
 *   error:   Hardcoded `http://localhost` / `http://127.0.0.1` /
 *            `http://0.0.0.0` in non-test production source.
 *            (rule: `hardcoded-url:localhost:<rel>:<line>`)
 *
 *   error:   Hardcoded RFC1918 private-range URL
 *            (10/8, 172.16/12, 192.168/16, 169.254/16) in non-test
 *            production source — usually a developer's internal IP.
 *            (rule: `hardcoded-url:private-ip:<rel>:<line>`)
 *
 *   warning: Hardcoded internal-TLD URL (`.internal`, `.local`,
 *            `.lan`, `.corp`, `.intra`) or staging hostname
 *            (`staging.`, `dev.`, `test.`, `qa.`) in production source.
 *            (rule: `hardcoded-url:internal-tld:<rel>:<line>`)
 *
 *   warning: Hardcoded `http://` (non-TLS) external URL in
 *            production source — downgrade vector / mixed content.
 *            (rule: `hardcoded-url:insecure-scheme:<rel>:<line>`)
 *
 * TODO(gluecron): host-neutral — pure source scan.
 */

const fs = require('fs');
const path = require('path');
const BaseModule = require('./base-module');

const DEFAULT_EXCLUDES = [
  'node_modules', '.git', 'dist', 'build', 'coverage', '.gatetest',
  '.next', '__pycache__', 'target', 'vendor', '.terraform', 'out',
  // Tooling artifacts — `.claude/worktrees/` holds parallel-agent
  // worktrees (separate git checkouts of the repo); scanning into
  // them produces duplicate findings from the parent tree.
  '.claude',
];

const SOURCE_EXTS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);

const TEST_PATH_RE = /(?:^|\/)(?:tests?|__tests__|spec|fixtures?|stories|storybook|e2e)(?:\/|$)|\.(?:test|spec|stories|fixture|e2e)\.(?:js|jsx|ts|tsx|mjs|cjs|mts|cts)$/i;

// Filenames we skip entirely (config examples, docs, local dev infra).
const SKIP_BASENAME_RE = /^(?:\.env(\..*)?|.*\.example|.*\.md|.*\.mdx|README.*|CHANGELOG.*|MIGRATION.*|playwright\.config\..*|vitest\.config\..*|jest\.config\..*|cypress\.config\..*|webpack\.config\..*|vite\.config\..*|rollup\.config\..*)$/i;

// URL-shaped capture. We match `<scheme>://<host>[:port][/path]`.
const URL_RE = /\b(https?):\/\/([A-Za-z0-9_.\-]+(?::\d+)?)(\/[^\s'"`)]*)?/g;

// RFC1918 + link-local + loopback host shapes.
// 10.x, 172.16-31.x, 192.168.x, 169.254.x, 127.x, 0.0.0.0
const PRIVATE_IP_RE = /^(?:10\.\d+\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+)(?::\d+)?$/;
const LOCALHOST_RE = /^(?:localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\]|::1)(?::\d+)?$/i;

// Internal TLDs + common staging subdomain prefixes.
const INTERNAL_TLD_RE = /\.(?:internal|local|lan|corp|intra|localhost|test|example)(?::\d+)?$/i;
const STAGING_HOST_RE = /^(?:staging|stage|dev|test|qa|uat|preprod|pre-prod)\.[A-Za-z0-9_.-]+$/i;

// Variable-name hints that say "this is deliberately dev-only".
const DEV_CONTEXT_LINE_RE = /\b(?:DEV|LOCAL|DEVELOPMENT|TEST|DEBUG|E2E_BASE_URL|MOCK|STUB|FIXTURE|STORYBOOK)[A-Z_]*(?:_URL|_HOST|_ENDPOINT|_BASE|_API)?\b/;

// Dev-guard: `if (process.env.NODE_ENV !== 'production')` / `!== "prod"`
// on the current or a recent line.
const DEV_GUARD_RE = /\bprocess\.env\.NODE_ENV\s*(?:===|!==|==|!=)\s*['"`](?:development|dev|test|local|staging)['"`]|NODE_ENV\s*(?:===|!==|==|!=)\s*['"`]production['"`]|__DEV__\b|isDev(?:elopment)?\b|isLocal\b|isTest\b/;

// Documentation-URL allowlist — common examples.
const DOC_ALLOWLIST = new Set([
  'example.com',
  'www.example.com',
  'example.org',
  'example.net',
  'your-domain.com',
  'yourdomain.com',
  'mydomain.com',
  'foo.com',
  'bar.com',
]);

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

class HardcodedUrlModule extends BaseModule {
  constructor() {
    super(
      'hardcodedUrl',
      'Hardcoded-URL detector — localhost / 127.0.0.1 / RFC1918 / internal TLDs / non-TLS URLs leaking into production code',
    );
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;
    const files = this._findFiles(projectRoot);

    if (files.length === 0) {
      result.addCheck('hardcoded-url:no-files', true, {
        severity: 'info',
        message: 'No JS/TS source files found — skipping',
      });
      return;
    }

    result.addCheck('hardcoded-url:scanning', true, {
      severity: 'info',
      message: `Scanning ${files.length} JS/TS file(s) for hardcoded URLs`,
    });

    let issues = 0;
    for (const file of files) {
      issues += this._scanFile(file, projectRoot, result);
    }

    result.addCheck('hardcoded-url:summary', true, {
      severity: 'info',
      message: `Hardcoded-URL scan: ${files.length} file(s), ${issues} issue(s)`,
    });
  }

  _findFiles(projectRoot) {
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
          if (SKIP_BASENAME_RE.test(entry.name)) continue;
          const ext = path.extname(entry.name).toLowerCase();
          if (SOURCE_EXTS.has(ext)) out.push(full);
        }
      }
    };
    walk(projectRoot);
    return out;
  }

  _scanFile(file, projectRoot, result) {
    let content;
    try { content = fs.readFileSync(file, 'utf-8'); } catch { return 0; }

    const rel = path.relative(projectRoot, file);
    const isTestFile = TEST_PATH_RE.test(rel);
    const lines = content.split('\n');
    let issues = 0;

    let inBlockComment = false;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const trimmed = line.trim();

      if (inBlockComment) {
        if (/\*\//.test(line)) inBlockComment = false;
        continue;
      }
      if (/^\s*\/\*/.test(line) && !/\*\//.test(line)) {
        inBlockComment = true;
        continue;
      }
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*')) continue;

      // Suppressor comment on same or previous line.
      const prevLine = i > 0 ? lines[i - 1] : '';
      if (/\bhardcoded-url-ok\b/.test(line) || /\bhardcoded-url-ok\b/.test(prevLine)) continue;

      // Skip lines whose identifier context says "dev URL".
      if (DEV_CONTEXT_LINE_RE.test(line)) continue;

      // Skip lines under a dev-guard on the current or last 3 lines.
      const guardWindow = lines.slice(Math.max(0, i - 3), i + 1).join('\n');
      if (DEV_GUARD_RE.test(guardWindow)) continue;

      // Reset regex state.
      URL_RE.lastIndex = 0;
      let m;
      while ((m = URL_RE.exec(line)) !== null) {
        // Must be inside a quoted string to count (avoids matching
        // comments we might have missed and package-json-like syntax).
        if (!isInString(line, m.index)) continue;

        const scheme = m[1].toLowerCase();
        const host = m[2];
        const hostNoPort = host.split(':')[0].toLowerCase();

        // Doc-example URLs are fine.
        if (DOC_ALLOWLIST.has(hostNoPort)) continue;

        // URL used inside a string-matching call (`.startsWith(`,
        // `.endsWith(`, `.includes(`, `.indexOf(`, `.match(`, `new RegExp(`,
        // or comparison operators `=== "http..."`) is a filter pattern,
        // not a fetch target.
        const before = line.slice(Math.max(0, m.index - 40), m.index);
        if (/\.(?:startsWith|endsWith|includes|indexOf|lastIndexOf|match|search|test|split|replace|replaceAll)\s*\(\s*['"`]$/.test(before)) continue;
        if (/new\s+RegExp\s*\(\s*['"`]$/.test(before)) continue;
        if (/(?:===|!==|==|!=)\s*['"`]$/.test(before)) continue;

        // Env-fallback: `process.env.X || "http://localhost..."` is
        // explicitly the "use env in prod, localhost in dev" pattern.
        if (/\bprocess\.env\.[A-Z_][A-Z0-9_]*\s*(?:\|\||\?\?)\s*['"`]$/.test(before)) continue;

        if (LOCALHOST_RE.test(host)) {
          issues += this._flag(result, `hardcoded-url:localhost:${rel}:${i + 1}`, {
            severity: isTestFile ? 'info' : 'error',
            file: rel,
            line: i + 1,
            host,
            kind: 'localhost',
            message: `${rel}:${i + 1} hardcoded \`${scheme}://${host}\` in source — localhost leaks break every non-developer machine the moment this ships`,
            suggestion: 'Move the URL to a config file / env var (`process.env.API_BASE_URL`) with a documented default for local development. Guard any local-only fallback with `NODE_ENV !== "production"`.',
          });
          continue;
        }

        if (PRIVATE_IP_RE.test(host)) {
          issues += this._flag(result, `hardcoded-url:private-ip:${rel}:${i + 1}`, {
            severity: isTestFile ? 'info' : 'error',
            file: rel,
            line: i + 1,
            host,
            kind: 'private-ip',
            message: `${rel}:${i + 1} hardcoded RFC1918 private-range URL \`${scheme}://${host}\` — a developer's LAN address escaped into committed code`,
            suggestion: 'Replace with a public hostname, a config/env var, or a service-discovery lookup. Never commit raw private IPs.',
          });
          continue;
        }

        if (INTERNAL_TLD_RE.test(host) || STAGING_HOST_RE.test(host)) {
          issues += this._flag(result, `hardcoded-url:internal-tld:${rel}:${i + 1}`, {
            severity: isTestFile ? 'info' : 'warning',
            file: rel,
            line: i + 1,
            host,
            kind: 'internal-tld',
            message: `${rel}:${i + 1} hardcoded internal/staging URL \`${scheme}://${host}\` — \`.internal\`/\`.local\`/staging subdomains won't resolve for external users`,
            suggestion: 'Move the host to environment-specific config. Use env-driven base URLs so prod targets prod, staging targets staging, without code changes.',
          });
          continue;
        }

        // Non-TLS external URL in production code.
        if (scheme === 'http' && !isTestFile) {
          issues += this._flag(result, `hardcoded-url:insecure-scheme:${rel}:${i + 1}`, {
            severity: 'warning',
            file: rel,
            line: i + 1,
            host,
            kind: 'insecure-scheme',
            message: `${rel}:${i + 1} hardcoded non-TLS \`http://${host}\` URL — downgrade/MITM risk, mixed-content in browsers, blocked by strict CSP`,
            suggestion: 'Use `https://`. If the target only serves HTTP (unlikely in 2026), wrap it in an HTTPS proxy or document the exception via a `// allow-http:` comment on the preceding line.',
          });
        }
      }
    }

    return issues;
  }

  _flag(result, name, details) {
    result.addCheck(name, false, details);
    return 1;
  }
}

module.exports = HardcodedUrlModule;
