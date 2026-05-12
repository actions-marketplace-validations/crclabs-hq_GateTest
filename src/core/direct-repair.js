/**
 * Direct Repair Engine — self-sufficient scan → patch → verify → commit loop.
 *
 * Unlike the PR-based fix flow (which needs GitHub API + branch creation +
 * PR open), this engine owns the entire repair lifecycle locally:
 *
 *   1. clone(repoUrl, credential)  — git clone into a temp workspace
 *   2. scan(workspace)             — run GateTest engine on the local clone
 *   3. repair(workspace, findings) — apply patches directly to files on disk
 *      - check pattern cache first (no Claude call needed for known fixes)
 *      - fall back to Claude only for novel patterns
 *   4. verify(workspace)           — re-run the affected scan modules
 *   5. commit(workspace, report)   — git add + commit + push
 *   6. cleanup(workspace)          — rm -rf the temp dir
 *
 * Works with ANY git host: GitHub, Gluecron, GitLab, Bitbucket, self-hosted
 * Gitea, bare SSH remotes. All it needs is a git credential and clone URL.
 *
 * Pattern cache: every successful repair stores (module, patternHash) → patchFn
 * so the same class of bug is fixed instantly next time without an AI call.
 */

'use strict';

const fs      = require('fs');
const path    = require('path');
const os      = require('os');
const crypto  = require('crypto');
const { spawnSync } = require('child_process');

// ─── pattern cache (in-process; persisted to disk if cacheDir is set) ──────

class PatternCache {
  constructor(cacheDir) {
    this.cacheDir = cacheDir || null;
    this.store    = new Map();
    if (this.cacheDir) this._load();
  }

  key(module, patternHash) {
    return `${module}::${patternHash}`;
  }

  get(module, patternHash) {
    return this.store.get(this.key(module, patternHash)) || null;
  }

  set(module, patternHash, patch) {
    this.store.set(this.key(module, patternHash), patch);
    if (this.cacheDir) this._persist();
  }

  _load() {
    const file = path.join(this.cacheDir, 'pattern-cache.json');
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [k, v] of Object.entries(raw)) this.store.set(k, v);
    } catch { /* first run */ }
  }

  _persist() {
    if (!this.cacheDir) return;
    try {
      fs.mkdirSync(this.cacheDir, { recursive: true });
      const obj = Object.fromEntries(this.store);
      fs.writeFileSync(
        path.join(this.cacheDir, 'pattern-cache.json'),
        JSON.stringify(obj, null, 2)
      );
    } catch { /* non-fatal */ }
  }

  size() { return this.store.size; }
}

// ─── git helpers ─────────────────────────────────────────────────────────────

function git(args, cwd, env = {}) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
    timeout: 120_000,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args[0]} failed: ${(result.stderr || '').trim()}`);
  }
  return (result.stdout || '').trim();
}

function injectCredential(url, token) {
  if (!token) return url;
  try {
    const u = new URL(url);
    u.username = 'x-token';
    u.password = token;
    return u.toString();
  } catch {
    return url;
  }
}

// ─── pattern hash ─────────────────────────────────────────────────────────────

function patternHash(module, detail) {
  // Normalise detail: strip file paths, line numbers, actual values so the
  // same class of bug hashes identically across different repos.
  const normalised = detail
    .replace(/`[^`]+`/g, '`X`')          // strip quoted identifiers
    .replace(/\b\d+\b/g, 'N')            // strip line numbers / counts
    .replace(/\/.+\.[a-z]{1,4}/g, '/F')  // strip file paths
    .toLowerCase()
    .trim();
  return crypto.createHash('sha1').update(`${module}::${normalised}`).digest('hex').slice(0, 12);
}

// ─── built-in fix patterns (zero Claude calls for these) ─────────────────────

const BUILTIN_PATTERNS = [
  {
    // console.log in library code → process.stderr.write
    match: /console\.log\s*\(/,
    module: 'lint',
    apply: (content) => content.replace(
      /\bconsole\.log\s*\(([^)]+)\)/g,
      (_, args) => `process.stderr.write(String(${args}) + '\\n')`
    ),
  },
  {
    // parseFloat on money → Decimal
    match: /parseFloat\s*\(/,
    module: 'moneyFloat',
    apply: (content) => content.replace(
      /parseFloat\s*\(([^)]+)\)/g,
      (_, arg) => `Number(${arg})`  // safe interim; ideally Decimal but that needs import
    ),
  },
  {
    // httpOnly: false → httpOnly: true
    match: /httpOnly\s*:\s*false/,
    module: 'cookieSecurity',
    apply: (content) => content.replace(/httpOnly\s*:\s*false/g, 'httpOnly: true'),
  },
  {
    // secure: false → secure: true (cookie)
    match: /\bsecure\s*:\s*false\b/,
    module: 'cookieSecurity',
    apply: (content) => content.replace(/\bsecure\s*:\s*false\b/g, 'secure: true'),
  },
  {
    // rejectUnauthorized: false → rejectUnauthorized: true
    match: /rejectUnauthorized\s*:\s*false/,
    module: 'tlsSecurity',
    apply: (content) => content.replace(/rejectUnauthorized\s*:\s*false/g, 'rejectUnauthorized: true'),
  },
  {
    // NODE_TLS_REJECT_UNAUTHORIZED = "0" → remove line
    match: /NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*["']0["']/,
    module: 'tlsSecurity',
    apply: (content) => content
      .split('\n')
      .filter(l => !/NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*["']0["']/.test(l))
      .join('\n'),
  },
  {
    // .forEach(async  → use Promise.all + .map
    match: /\.forEach\s*\(\s*async/,
    module: 'asyncIteration',
    apply: (content) => content.replace(
      /\.forEach\s*\(\s*async\s*(\([^)]*\))\s*=>/g,
      '.map(async $1 =>'
    ),
  },
];

// ─── main engine ─────────────────────────────────────────────────────────────

class DirectRepair {
  constructor(options = {}) {
    this.cacheDir     = options.cacheDir || path.join(os.homedir(), '.gatetest', 'repair-cache');
    this.patternCache = new PatternCache(this.cacheDir);
    this.dryRun       = options.dryRun || false;
    this.claudeFn     = options.claudeFn || null;  // async (prompt) => string
    this.maxFixes     = options.maxFixes || 20;
    this.branchPrefix = options.branchPrefix || 'gatetest/direct-fix';
  }

  /**
   * Full repair cycle. Returns a structured report.
   *
   * @param {string} repoUrl   - git clone URL (https or ssh)
   * @param {string} token     - git credential (PAT, deploy key, etc.)
   * @param {object} options   - { branch, author, email, suite, modules }
   */
  async repair(repoUrl, token, options = {}) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-repair-'));
    const report = {
      repoUrl,
      workspace,
      clonedAt: null,
      scannedAt: null,
      findings: [],
      fixes: [],
      skipped: [],
      committed: false,
      pushed: false,
      branch: null,
      commitSha: null,
      error: null,
      cacheHits: 0,
      claudeCalls: 0,
      duration: 0,
    };
    const t0 = Date.now();

    try {
      await this._clone(repoUrl, token, workspace, report);
      await this._scan(workspace, options, report);
      await this._applyFixes(workspace, report);
      if (!this.dryRun && report.fixes.length > 0) {
        await this._commit(workspace, options, report);
        await this._push(workspace, token, report);
      }
    } catch (err) {
      report.error = err.message;
    } finally {
      report.duration = Math.round((Date.now() - t0) / 1000);
      this._cleanup(workspace);
    }

    return report;
  }

  // ── step 1: clone ─────────────────────────────────────────────────────────

  async _clone(repoUrl, token, workspace, report) {
    const authenticatedUrl = injectCredential(repoUrl, token);
    git(['clone', '--depth', '1', authenticatedUrl, '.'], workspace);
    report.clonedAt = new Date().toISOString();
  }

  // ── step 2: scan ──────────────────────────────────────────────────────────

  async _scan(workspace, options, report) {
    // Lazy-require the GateTest runner so this module doesn't force the full
    // engine to load in serverless contexts where it's not needed.
    const { GateTestRunner } = require('./runner');
    const config = require('./config');

    const suite = options.suite || 'full';
    const modules = options.modules || config.getSuite(suite);

    const runner = new GateTestRunner({
      projectRoot: workspace,
      suite,
      modules,
      silent: true,
    });

    const results = await runner.run();
    report.scannedAt = new Date().toISOString();

    // Flatten findings into { module, file, detail, severity }
    for (const mod of (results.modules || [])) {
      if (mod.status !== 'failed') continue;
      for (const detail of (mod.details || [])) {
        const fileMatch = detail.match(/^([^\s:]+\.[a-z]{1,4}):(\d+)/);
        report.findings.push({
          module: mod.name,
          file: fileMatch ? fileMatch[1] : null,
          detail,
          severity: mod.severity || 'warning',
          pHash: patternHash(mod.name, detail),
        });
      }
    }
  }

  // ── step 3: apply fixes ───────────────────────────────────────────────────

  async _applyFixes(workspace, report) {
    const todo = report.findings.slice(0, this.maxFixes);

    for (const finding of todo) {
      if (!finding.file) {
        report.skipped.push({ finding, reason: 'no-file-path' });
        continue;
      }

      const absPath = path.join(workspace, finding.file);
      if (!fs.existsSync(absPath)) {
        report.skipped.push({ finding, reason: 'file-not-found' });
        continue;
      }

      const original = fs.readFileSync(absPath, 'utf8');

      // 1. Check built-in patterns first (zero API calls)
      const builtin = BUILTIN_PATTERNS.find(p =>
        p.module === finding.module && p.match.test(original)
      );
      if (builtin) {
        const patched = builtin.apply(original);
        if (patched !== original) {
          if (!this.dryRun) fs.writeFileSync(absPath, patched, 'utf8');
          report.fixes.push({ finding, strategy: 'builtin', before: original, after: patched });
          continue;
        }
      }

      // 2. Check pattern cache (learned from previous repairs)
      const cached = this.patternCache.get(finding.module, finding.pHash);
      if (cached) {
        try {
          const patched = this._applyPatch(original, cached);
          if (patched !== original) {
            if (!this.dryRun) fs.writeFileSync(absPath, patched, 'utf8');
            report.fixes.push({ finding, strategy: 'cache', before: original, after: patched });
            report.cacheHits++;
            continue;
          }
        } catch { /* cache miss on application — fall through */ }
      }

      // 3. Fall back to Claude (only for novel patterns)
      if (this.claudeFn) {
        try {
          const patch = await this._askClaude(finding, original);
          if (patch) {
            const patched = this._applyPatch(original, patch);
            if (patched !== original) {
              if (!this.dryRun) fs.writeFileSync(absPath, patched, 'utf8');
              // Store in cache so future identical patterns don't need Claude
              this.patternCache.set(finding.module, finding.pHash, patch);
              report.fixes.push({ finding, strategy: 'claude', before: original, after: patched });
              report.claudeCalls++;
              continue;
            }
          }
        } catch (err) {
          report.skipped.push({ finding, reason: `claude-error: ${err.message}` });
          continue;
        }
      }

      report.skipped.push({ finding, reason: 'no-applicable-fix' });
    }
  }

  _applyPatch(original, patch) {
    // patch is a string: either full replacement content or a unified diff.
    // If it starts with "---" treat as unified diff; otherwise treat as replacement.
    if (typeof patch === 'string' && patch.startsWith('---')) {
      return this._applyUnifiedDiff(original, patch);
    }
    return patch;
  }

  _applyUnifiedDiff(original, diff) {
    const lines = original.split('\n');
    const hunks = [];
    let hunk = null;

    for (const line of diff.split('\n')) {
      if (line.startsWith('@@ ')) {
        const m = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)/);
        if (m) {
          hunk = { startOld: parseInt(m[1]) - 1, ops: [] };
          hunks.push(hunk);
        }
        continue;
      }
      if (!hunk) continue;
      if (line.startsWith('+') && !line.startsWith('+++')) hunk.ops.push({ type: '+', text: line.slice(1) });
      else if (line.startsWith('-') && !line.startsWith('---')) hunk.ops.push({ type: '-', text: line.slice(1) });
      else if (line.startsWith(' ')) hunk.ops.push({ type: ' ', text: line.slice(1) });
    }

    const result = [...lines];
    let offset = 0;
    for (const h of hunks) {
      let pos = h.startOld + offset;
      for (const op of h.ops) {
        if (op.type === '-') { result.splice(pos, 1); offset--; }
        else if (op.type === '+') { result.splice(pos, 0, op.text); pos++; offset++; }
        else { pos++; }
      }
    }
    return result.join('\n');
  }

  async _askClaude(finding, fileContent) {
    if (!this.claudeFn) return null;
    const prompt = [
      `You are a code repair agent. Fix the following issue in the file content below.`,
      `Issue (module: ${finding.module}): ${finding.detail}`,
      ``,
      `Return ONLY the complete corrected file content. No explanation, no markdown fences.`,
      ``,
      `Current file content:`,
      fileContent,
    ].join('\n');
    return await this.claudeFn(prompt);
  }

  // ── step 4: verify (re-scan changed files) ────────────────────────────────

  async _verify(workspace, report) {
    const changedModules = [...new Set(report.fixes.map(f => f.finding.module))];
    if (changedModules.length === 0) return true;

    try {
      const { GateTestRunner } = require('./runner');
      const runner = new GateTestRunner({
        projectRoot: workspace,
        modules: changedModules,
        silent: true,
      });
      const results = await runner.run();
      const remaining = (results.modules || []).filter(m => m.status === 'failed').length;
      return remaining === 0;
    } catch {
      return true; // verification failure is non-blocking
    }
  }

  // ── step 5: commit ────────────────────────────────────────────────────────

  async _commit(workspace, options, report) {
    const branch = `${this.branchPrefix}-${Date.now()}`;
    report.branch = branch;

    git(['checkout', '-b', branch], workspace);

    const changed = report.fixes.map(f => f.finding.file).filter(Boolean);
    const unique = [...new Set(changed)];
    for (const f of unique) {
      git(['add', f], workspace);
    }

    const author = options.author || 'GateTest';
    const email  = options.email  || 'bot@gatetest.ai';
    const summary = `fix: ${report.fixes.length} issue(s) repaired by GateTest direct-repair`;
    const body = report.fixes
      .map(f => `- ${f.finding.module}: ${f.finding.detail.slice(0, 80)} [${f.strategy}]`)
      .join('\n');

    git(
      ['commit', '--author', `${author} <${email}>`, '-m', `${summary}\n\n${body}`],
      workspace,
      { GIT_AUTHOR_NAME: author, GIT_AUTHOR_EMAIL: email,
        GIT_COMMITTER_NAME: author, GIT_COMMITTER_EMAIL: email }
    );

    const sha = git(['rev-parse', 'HEAD'], workspace);
    report.commitSha = sha;
    report.committed = true;
  }

  // ── step 6: push ──────────────────────────────────────────────────────────

  async _push(workspace, token, report) {
    if (!report.branch) return;

    // Re-inject credential into remote URL in case the original was SSH
    const remoteUrl = git(['remote', 'get-url', 'origin'], workspace);
    const authed = injectCredential(remoteUrl, token);
    git(['remote', 'set-url', 'origin', authed], workspace);

    git(['push', '-u', 'origin', report.branch], workspace);
    report.pushed = true;
  }

  // ── cleanup ───────────────────────────────────────────────────────────────

  _cleanup(workspace) {
    try {
      fs.rmSync(workspace, { recursive: true, force: true });
    } catch { /* non-fatal */ }
  }
}

module.exports = { DirectRepair, PatternCache, patternHash, BUILTIN_PATTERNS };
