/**
 * Web Headers Module — security-header misconfiguration + CORS abuse.
 *
 * Every production web app is one missing header away from a real
 * bug bounty payout. CSP absent? XSS lands every time. HSTS absent?
 * MITM on first-visit wifi. `Access-Control-Allow-Origin: *` combined
 * with `Access-Control-Allow-Credentials: true`? Cross-site credential
 * theft. This module reads the config files where headers actually
 * get set — not just runtime responses — so it works offline against
 * the repo itself.
 *
 * Scanned configs (discovery):
 *
 *   - next.config.{js,mjs,ts} — Next.js `async headers()` block
 *   - vercel.json / vercel.toml — `headers` array
 *   - netlify.toml / _headers — Netlify header config
 *   - Express/Fastify/Koa source — `app.use(helmet())`, manual
 *     `res.setHeader` / `res.header` / `reply.header` calls
 *   - nginx.conf / *.nginx — `add_header` directives
 *   - Cloudfront / ALB / API Gateway snippets are out of scope for
 *     this scan (that's `gatetest --module terraform` or cloud-native
 *     tooling).
 *
 * Rules:
 *
 *   error:   CORS `Access-Control-Allow-Origin: *` co-occurs with
 *            `Access-Control-Allow-Credentials: true` — spec says
 *            browsers reject this, but several frameworks ship it
 *            anyway and old clients / server-to-server usage don't
 *            enforce the rejection.
 *            (rule: `web-headers:cors-wildcard-with-credentials:<rel>:<line>`)
 *   error:   CSP contains `unsafe-eval` — re-enables `eval()`-class
 *            attacks in the browser.
 *            (rule: `web-headers:csp-unsafe-eval:<rel>:<line>`)
 *   warning: CSP contains `unsafe-inline` — re-enables inline-script XSS.
 *            (rule: `web-headers:csp-unsafe-inline:<rel>:<line>`)
 *   warning: Header config exists but no `Content-Security-Policy`
 *            header is set. (per-config file)
 *            (rule: `web-headers:missing-csp:<rel>`)
 *   warning: Header config exists but no `Strict-Transport-Security`
 *            (rule: `web-headers:missing-hsts:<rel>`)
 *   warning: Header config exists but no `X-Frame-Options` and no CSP
 *            `frame-ancestors` — clickjacking surface.
 *            (rule: `web-headers:missing-frame-options:<rel>`)
 *   warning: HSTS max-age < 15552000 (180 days) — below Mozilla guidance.
 *            (rule: `web-headers:hsts-short:<rel>:<line>`)
 *   info:    No `X-Content-Type-Options: nosniff` — MIME-sniff
 *            vectors still exist in some browsers.
 *            (rule: `web-headers:missing-nosniff:<rel>`)
 *
 * Because this scan is line-heuristic, it targets config files and
 * clear header-setting call-sites. We don't try to evaluate runtime
 * middleware chains — that's what a black-box DAST would do.
 *
 * TODO(gluecron): when Gluecron ships deploy-config YAML, mirror
 * these rules to whatever header surface it lands on.
 */

const fs = require('fs');
const path = require('path');
const BaseModule = require('./base-module');

const DEFAULT_EXCLUDES = [
  'node_modules', '.git', '.claude', 'dist', 'build', 'coverage', '.gatetest',
  '.next', '__pycache__', 'target', 'vendor', '.terraform', 'out',
];

// Anything whose content we'll scan for header config. We match by
// filename / path, not by content, because the callsite matters.
const CONFIG_NAMES = [
  'next.config.js', 'next.config.mjs', 'next.config.ts',
  'vercel.json', 'netlify.toml', '_headers',
  'nginx.conf',
];

const CONFIG_EXTENSIONS = ['.nginx'];

// Source files where header-setting calls might appear. Kept tight to
// avoid line-scanning the whole codebase.
const SERVER_SOURCE_EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx']);

const HEADER_HINTS = /\b(?:setHeader|reply\.header|res\.header|helmet|headers\s*:)/;

const HSTS_MIN_MAX_AGE = 15552000; // 180 days, aligns with Mozilla

class WebHeadersModule extends BaseModule {
  constructor() {
    super(
      'webHeaders',
      'Web Headers — CSP/HSTS/XFO/CORS misconfig across Next.js, Vercel, Netlify, Express, Fastify, nginx',
    );
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;
    const files = this._findFiles(projectRoot);

    if (files.length === 0) {
      result.addCheck('web-headers:no-files', true, {
        severity: 'info',
        message: 'No web-header config files found — skipping',
      });
      return;
    }

    result.addCheck('web-headers:scanning', true, {
      severity: 'info',
      message: `Scanning ${files.length} web-header config file(s)`,
    });

    let totalIssues = 0;
    for (const file of files) {
      totalIssues += this._scanFile(file, projectRoot, result);
    }

    result.addCheck('web-headers:summary', true, {
      severity: 'info',
      message: `Web headers scan: ${files.length} file(s), ${totalIssues} issue(s)`,
    });
  }

  _findFiles(projectRoot) {
    const out = [];
    const walk = (dir, depth = 0) => {
      if (depth > 12) return;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (DEFAULT_EXCLUDES.includes(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full, depth + 1);
        } else if (entry.isFile()) {
          if (this._isHeaderFile(full, entry.name)) out.push(full);
        }
      }
    };
    walk(projectRoot);
    return out;
  }

  _isHeaderFile(full, basename) {
    if (CONFIG_NAMES.includes(basename)) return true;
    const ext = path.extname(basename).toLowerCase();
    if (CONFIG_EXTENSIONS.includes(ext)) return true;
    // Server source code that references header-setting APIs
    if (SERVER_SOURCE_EXTS.has(ext)) {
      try {
        const content = fs.readFileSync(full, 'utf-8');
        if (HEADER_HINTS.test(content)) return true;
      } catch { return false; }
    }
    return false;
  }

  _scanFile(file, projectRoot, result) {
    let content;
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch { return 0; }

    const rel = path.relative(projectRoot, file);

    // Skip the module's own source — its pattern strings match its own rules.
    const relUnix = rel.replace(/\\/g, '/');
    if (/(?:^|\/)src[\\/]modules[\\/]/.test(relUnix)) return 0;

    const isTest = /(?:^|\/)(?:tests?|__tests__|spec|fixtures?|e2e)(?:\/|$)|\.(?:test|spec)\.[a-z]+$/i.test(relUnix);

    const lines = content.split('\n');
    let issues = 0;
    const lowerContent = content.toLowerCase();

    // Track which headers appear somewhere in this file
    const seen = {
      csp: /content-security-policy/i.test(content),
      hsts: /strict-transport-security/i.test(content),
      xfo: /x-frame-options/i.test(content),
      frameAncestors: /frame-ancestors/i.test(content),
      nosniff: /x-content-type-options/i.test(content),
      helmetAllDefaults: /\bhelmet\s*\(\s*\)/.test(content),
    };

    // Pass 1: per-line rules
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Suppressor: `// web-headers-ok` on same line or previous line
      const prevLine = i > 0 ? lines[i - 1] : '';
      if (/\bweb-headers-ok\b/.test(line) || /\bweb-headers-ok\b/.test(prevLine)) continue;

      // CSP: unsafe-eval / unsafe-inline. Look only on lines that
      // include a CSP directive marker.
      if (/content-security-policy|frame-ancestors|default-src|script-src|style-src|object-src/i.test(line)) {
        if (/['"`]?unsafe-eval['"`]?/i.test(line)) {
          issues += this._flag(result, `web-headers:csp-unsafe-eval:${rel}:${i + 1}`, {
            severity: isTest ? 'warning' : 'error',
            file: rel,
            line: i + 1,
            message: 'Content-Security-Policy contains `unsafe-eval` — re-enables `eval()`/`new Function()` and the entire class of attacks CSP is supposed to block',
            suggestion: 'Refactor away from eval (bundlers, template engines, JSON.parse). If you truly need it for a known script, use a strict-dynamic + nonce CSP instead.',
          });
        }
        if (/['"`]?unsafe-inline['"`]?/i.test(line)) {
          issues += this._flag(result, `web-headers:csp-unsafe-inline:${rel}:${i + 1}`, {
            severity: 'warning',
            file: rel,
            line: i + 1,
            message: 'Content-Security-Policy contains `unsafe-inline` — inline `<script>` / `onclick=` XSS payloads execute as if CSP weren\'t there',
            suggestion: 'Replace with a per-request nonce (`script-src \'nonce-{nonce}\'`) or strict-dynamic. Move inline handlers to addEventListener.',
          });
        }
      }

      // HSTS max-age check
      const hstsMatch = line.match(/max-age\s*=\s*(\d+)/i);
      if (hstsMatch && /strict-transport-security/i.test(lowerContent.slice(
        Math.max(0, content.toLowerCase().indexOf(line.toLowerCase()) - 200),
        content.toLowerCase().indexOf(line.toLowerCase()) + line.length,
      ))) {
        const val = parseInt(hstsMatch[1], 10);
        if (!Number.isNaN(val) && val < HSTS_MIN_MAX_AGE) {
          issues += this._flag(result, `web-headers:hsts-short:${rel}:${i + 1}`, {
            severity: 'warning',
            file: rel,
            line: i + 1,
            maxAge: val,
            message: `Strict-Transport-Security max-age=${val} — below Mozilla's 180-day (15552000) recommendation`,
            suggestion: 'Use `max-age=31536000; includeSubDomains; preload` once you\'re confident HTTPS works everywhere.',
          });
        }
      }
    }

    // Pass 2: CORS wildcard + credentials co-occurrence (file-level)
    const hasWildcardOrigin = /access-control-allow-origin["'\s:,]+\*/i.test(content);
    const hasCredentialsTrue = /access-control-allow-credentials["'\s:,]+true/i.test(content);
    if (hasWildcardOrigin && hasCredentialsTrue) {
      const idx = content.search(/access-control-allow-origin/i);
      const lineNo = content.slice(0, Math.max(0, idx)).split('\n').length;
      issues += this._flag(result, `web-headers:cors-wildcard-with-credentials:${rel}:${lineNo}`, {
        severity: isTest ? 'warning' : 'error',
        file: rel,
        line: lineNo,
        message: '`Access-Control-Allow-Origin: *` co-occurs with `Access-Control-Allow-Credentials: true` — cross-site credential theft surface, and browsers should (but don\'t always) reject it',
        suggestion: 'Echo the request\'s `Origin` back only for a maintained allow-list of origins, or drop `Allow-Credentials`.',
      });
    }

    // Pass 3: missing-header warnings — ONLY for files that appear to
    // be deliberately setting *some* headers (otherwise a middleware
    // file that uses res.setHeader for one thing gets spammed).
    const looksLikeHeaderConfig =
      CONFIG_NAMES.includes(path.basename(file)) ||
      CONFIG_EXTENSIONS.includes(path.extname(file).toLowerCase()) ||
      /(?:async\s+)?headers\s*\(\s*\)\s*{/.test(content);

    if (looksLikeHeaderConfig) {
      if (!seen.csp) {
        issues += this._flag(result, `web-headers:missing-csp:${rel}`, {
          severity: 'warning',
          file: rel,
          message: `${rel} sets response headers but no Content-Security-Policy — XSS payloads run with the full permissions of the origin`,
          suggestion: 'Add a strict CSP starting from `default-src \'self\'; script-src \'self\'` and open only what you need.',
        });
      }
      if (!seen.hsts) {
        issues += this._flag(result, `web-headers:missing-hsts:${rel}`, {
          severity: 'warning',
          file: rel,
          message: `${rel} sets response headers but no Strict-Transport-Security — first-visit MITM downgrade is still possible`,
          suggestion: 'Add `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload` once HTTPS is universal.',
        });
      }
      if (!seen.xfo && !seen.frameAncestors) {
        issues += this._flag(result, `web-headers:missing-frame-options:${rel}`, {
          severity: 'warning',
          file: rel,
          message: `${rel} sets response headers but no X-Frame-Options and no CSP frame-ancestors — clickjacking surface`,
          suggestion: 'Add `X-Frame-Options: DENY` (or `SAMEORIGIN`), and `frame-ancestors \'none\'` in CSP.',
        });
      }
      if (!seen.nosniff) {
        issues += this._flag(result, `web-headers:missing-nosniff:${rel}`, {
          severity: 'info',
          file: rel,
          message: `${rel} sets response headers but no X-Content-Type-Options — legacy browsers may still MIME-sniff`,
          suggestion: 'Add `X-Content-Type-Options: nosniff`.',
        });
      }
    }

    return issues;
  }

  _flag(result, name, details) {
    result.addCheck(name, false, details);
    return 1;
  }
}

module.exports = WebHeadersModule;
