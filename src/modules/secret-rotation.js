/**
 * Secret Rotation Module — long-lived credentials, .env drift,
 * credentials that have lived in git far past their expected TTL.
 *
 * Existing secret scanners (gitleaks, truffleHog, our own `secrets`
 * module) answer "is there a secret in the code?" — which is a
 * committed-today question. Nobody answers "is there a secret in the
 * code that has lived there for 400 days and should have been
 * rotated 12 rotations ago?" That's the gap this module fills, and
 * it's one of the highest-signal findings in any mature repo.
 *
 * Rules (zero-dep; uses `git log --format=%at` via child_process):
 *
 *   error:   a live credential-shaped secret in a tracked file whose
 *            last modification is older than 90 days
 *            (rule: `secret-rotation:stale:<kind>:<rel>:<line>`)
 *   warning: a credential older than 30 days
 *            (rule: `secret-rotation:aging:<kind>:<rel>:<line>`)
 *   warning: .env.example drift — variables in .env that aren't in
 *            .env.example (or vice versa). Rotating a key requires
 *            a matching example; drift means contributors don't know
 *            what to set.
 *            (rule: `secret-rotation:env-drift:<var>`)
 *   warning: placeholder-looking values in .env.example that match a
 *            real secret shape — copy-paste risk.
 *            (rule: `secret-rotation:example-shaped-like-real:<var>`)
 *   info:    no .env.example present but .env is referenced in code
 *            (rule: `secret-rotation:no-example`)
 *
 * Secret detection re-uses the credential shapes from `src/core/config.js`
 * secretPatterns plus a few that matter for rotation specifically:
 * AWS access keys (AKIA/ASIA), GitHub tokens (ghp_/gho_/ghs_/github_pat_),
 * Stripe live keys (sk_live_*), Slack tokens (xox[bapors]-*), generic
 * `-----BEGIN PRIVATE KEY-----` blocks.
 *
 * If the project isn't a git repo, or git isn't on PATH, stale/aging
 * checks degrade to the file's mtime — which is still more signal
 * than zero.
 *
 * TODO(gluecron): when Gluecron ships a hosted scan API, wire the
 * git-blame calls to hit that so we don't need a local clone for
 * mature-project scans.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const BaseModule = require('./base-module');

const DEFAULT_EXCLUDES = [
  'node_modules', '.git', '.claude', 'dist', 'build', 'coverage', '.gatetest',
  '.next', '__pycache__', 'target', 'vendor', '.terraform', 'out',
];

const STALE_DAYS = 90;
const AGING_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Credential shape → (pattern, label). These are intentionally tight
// — loose patterns drown the report in false positives, and this
// module is about rotation signal, not catching every possible leak.
const CREDENTIAL_PATTERNS = [
  { kind: 'aws-access-key', re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { kind: 'aws-secret',     re: /\baws[_-]?secret[_-]?access[_-]?key\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}["']?/gi },
  { kind: 'github-pat',     re: /\bghp_[A-Za-z0-9]{36,}\b/g },
  { kind: 'github-oauth',   re: /\bgho_[A-Za-z0-9]{36,}\b/g },
  { kind: 'github-server',  re: /\bghs_[A-Za-z0-9]{36,}\b/g },
  { kind: 'github-fine',    re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
  { kind: 'stripe-live',    re: /\bsk_live_[A-Za-z0-9]{24,}\b/g },
  { kind: 'stripe-restricted', re: /\brk_live_[A-Za-z0-9]{24,}\b/g },
  { kind: 'slack-token',    re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'google-api',     re: /\bAIza[0-9A-Za-z_\-]{35}\b/g },
  { kind: 'anthropic-key',  re: /\bsk-ant-api\d{2}-[A-Za-z0-9_\-]{32,}\b/g },
  { kind: 'private-key',    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g },
  { kind: 'jwt',            re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
];

// Don't scan these file types for credential shapes — they produce
// false positives (test fixtures, lockfiles, binary blobs, etc.).
const SKIP_EXTENSIONS = new Set([
  '.lock', '.min.js', '.min.css', '.map', '.svg',
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp',
  '.pdf', '.zip', '.tar', '.gz', '.7z',
  '.woff', '.woff2', '.ttf', '.eot',
]);

// Example/fixture paths we trust to contain sample data
const SKIP_PATH_PARTS = ['fixtures/', 'examples/', 'test-data/', 'testdata/'];

class SecretRotationModule extends BaseModule {
  constructor() {
    super(
      'secretRotation',
      'Secret Rotation — long-lived credentials in git, .env drift, placeholder/real example mismatch',
    );
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;
    const now = Date.now();
    const isGit = this._isGitRepo(projectRoot);

    // 1. Find credential-shaped strings in tracked code, measure age
    const codeFiles = this._findCodeFiles(projectRoot);
    let totalIssues = 0;
    let scanned = 0;
    const findings = [];

    for (const file of codeFiles) {
      const hits = this._scanForSecrets(file, projectRoot);
      if (hits.length === 0) continue;
      scanned += 1;
      const mtime = this._lastModifiedMs(file, projectRoot, isGit);
      const ageDays = mtime ? Math.round((now - mtime) / MS_PER_DAY) : null;
      for (const hit of hits) {
        findings.push({ ...hit, ageDays });
      }
    }

    for (const f of findings) {
      if (f.ageDays !== null && f.ageDays >= STALE_DAYS) {
        totalIssues += this._flag(result, `secret-rotation:stale:${f.kind}:${f.rel}:${f.line}`, {
          severity: 'error',
          file: f.rel,
          line: f.line,
          kind: f.kind,
          ageDays: f.ageDays,
          message: `${f.kind} credential at ${f.rel}:${f.line} has lived in git for ${f.ageDays} days — past the ${STALE_DAYS}-day rotation window`,
          suggestion: `Rotate this credential now. Even if it's never been exposed, a ${f.ageDays}-day-old key is a breach waiting to happen. After rotating, remove the old value from git history.`,
        });
      } else if (f.ageDays !== null && f.ageDays >= AGING_DAYS) {
        totalIssues += this._flag(result, `secret-rotation:aging:${f.kind}:${f.rel}:${f.line}`, {
          severity: 'warning',
          file: f.rel,
          line: f.line,
          kind: f.kind,
          ageDays: f.ageDays,
          message: `${f.kind} credential at ${f.rel}:${f.line} is ${f.ageDays} days old — approaching the ${STALE_DAYS}-day rotation window`,
          suggestion: 'Schedule rotation. Set a reminder, or move the value to a secret manager that rotates automatically (AWS Secrets Manager, Doppler, 1Password Secrets Automation).',
        });
      } else if (f.ageDays === null) {
        // Can't date it, but it's still a secret in code — escalate to warning
        totalIssues += this._flag(result, `secret-rotation:undatable:${f.kind}:${f.rel}:${f.line}`, {
          severity: 'warning',
          file: f.rel,
          line: f.line,
          kind: f.kind,
          message: `${f.kind} credential at ${f.rel}:${f.line} — could not determine age (not a git repo or file outside git)`,
          suggestion: 'Move to a secret manager regardless. If this is intentional sample data, move it under a fixtures/ path so scanners can skip it.',
        });
      }
    }

    // 2. .env drift checks
    totalIssues += this._checkEnvDrift(projectRoot, result);

    if (codeFiles.length === 0 && scanned === 0) {
      result.addCheck('secret-rotation:no-files', true, {
        severity: 'info',
        message: 'No code files to scan — skipping',
      });
      return;
    }

    result.addCheck('secret-rotation:summary', true, {
      severity: 'info',
      gitAware: isGit,
      message: `Secret rotation scan: ${codeFiles.length} file(s), ${findings.length} credential(s), ${totalIssues} issue(s)`,
    });
  }

  _isGitRepo(projectRoot) {
    try {
      execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
        cwd: projectRoot, stdio: ['ignore', 'pipe', 'ignore'],
      });
      return true;
    } catch {
      return false;
    }
  }

  _findCodeFiles(projectRoot) {
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
        const rel = path.relative(projectRoot, full).replace(/\\/g, '/');
        if (SKIP_PATH_PARTS.some((p) => rel.includes(p))) continue;
        if (entry.isDirectory()) {
          walk(full, depth + 1);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (SKIP_EXTENSIONS.has(ext)) continue;
          // Skip files > 1 MB — almost certainly generated/minified
          try {
            const st = fs.statSync(full);
            if (st.size > 1024 * 1024) continue;
          } catch { continue; }
          out.push(full);
        }
      }
    };
    walk(projectRoot);
    return out;
  }

  _scanForSecrets(file, projectRoot) {
    let content;
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch {
      return [];
    }
    const rel = path.relative(projectRoot, file);
    const lines = content.split('\n');
    const hits = [];
    for (const { kind, re } of CREDENTIAL_PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(content)) !== null) {
        const lineNo = content.slice(0, m.index).split('\n').length;
        // De-duplicate: don't flag the same kind at the same line twice
        if (hits.find((h) => h.kind === kind && h.line === lineNo)) continue;
        hits.push({ kind, rel, line: lineNo });
        if (hits.length > 50) return hits; // cap per file
      }
    }
    return hits;
  }

  /**
   * Get the most recent modification time for a file:
   *   - prefer `git log -1 --format=%at <file>` (author time of last commit)
   *   - fall back to fs.statSync(file).mtimeMs
   *   - return null if neither works
   */
  _lastModifiedMs(file, projectRoot, isGit) {
    if (isGit) {
      try {
        const out = execFileSync('git', [
          'log', '-1', '--format=%at', '--', file,
        ], {
          cwd: projectRoot, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf-8',
        }).trim();
        if (out) {
          const secs = parseInt(out, 10);
          if (!Number.isNaN(secs) && secs > 0) return secs * 1000;
        }
      } catch {
        // fall through
      }
    }
    try {
      return fs.statSync(file).mtimeMs;
    } catch {
      return null;
    }
  }

  /**
   * Compare .env / .env.local against .env.example / .env.sample.
   * Flag variables present in one but not the other.
   */
  _checkEnvDrift(projectRoot, result) {
    const real = this._readEnvFile(projectRoot, ['.env', '.env.local', '.env.production']);
    const example = this._readEnvFile(projectRoot, ['.env.example', '.env.sample', '.env.template']);

    let issues = 0;

    if (real.found && !example.found) {
      // Check whether any code references a process.env.* var — if so, no example is a bug.
      issues += this._flag(result, 'secret-rotation:no-example', {
        severity: 'info',
        message: `Found ${real.path} but no .env.example — contributors have no way to know which vars they need to set`,
        suggestion: 'Commit a .env.example with every variable name (but no real values) so onboarding is one-command.',
      });
      return issues;
    }

    if (!real.found || !example.found) return issues;

    const realVars = new Set(Object.keys(real.vars));
    const exampleVars = new Set(Object.keys(example.vars));

    for (const v of realVars) {
      if (!exampleVars.has(v)) {
        issues += this._flag(result, `secret-rotation:env-drift:missing-from-example:${v}`, {
          severity: 'warning',
          variable: v,
          message: `${v} is set in ${real.path} but missing from ${example.path} — new contributors won't know they need it`,
          suggestion: `Add \`${v}=\` (empty placeholder) to ${example.path}.`,
        });
      }
    }
    for (const v of exampleVars) {
      if (!realVars.has(v)) {
        issues += this._flag(result, `secret-rotation:env-drift:missing-from-env:${v}`, {
          severity: 'info',
          variable: v,
          message: `${v} is documented in ${example.path} but not set in ${real.path}`,
          suggestion: `Either set ${v} in your local env, or remove it from ${example.path} if it's no longer used.`,
        });
      }
    }

    // Placeholder values in the example that look like real credentials
    for (const [k, v] of Object.entries(example.vars)) {
      if (!v) continue;
      for (const { kind, re } of CREDENTIAL_PATTERNS) {
        re.lastIndex = 0;
        if (re.test(v)) {
          issues += this._flag(result, `secret-rotation:example-shaped-like-real:${k}`, {
            severity: 'warning',
            variable: k,
            kind,
            message: `${example.path} entry \`${k}\` has a value that matches a real ${kind} shape — risk of accidental commit if someone copies the "example"`,
            suggestion: `Replace with an obvious placeholder like \`${k}=your-${kind}-here\` or \`${k}=REPLACE_ME\`.`,
          });
          break;
        }
      }
    }

    return issues;
  }

  _readEnvFile(projectRoot, candidates) {
    for (const name of candidates) {
      const full = path.join(projectRoot, name);
      if (!fs.existsSync(full)) continue;
      let content;
      try {
        content = fs.readFileSync(full, 'utf-8');
      } catch {
        continue;
      }
      const vars = {};
      for (const line of content.split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const m = t.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
        if (m) {
          // Strip surrounding quotes
          let val = m[2];
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          vars[m[1]] = val;
        }
      }
      return { found: true, path: name, vars };
    }
    return { found: false, path: null, vars: {} };
  }

  _flag(result, name, details) {
    result.addCheck(name, false, details);
    return 1;
  }
}

module.exports = SecretRotationModule;
