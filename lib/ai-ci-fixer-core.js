/**
 * AI CI-fixer core helpers — extracted from scripts/ai-ci-fixer.js to keep
 * the script under the pr-size hard cap (500 lines per file). Every function
 * here is hermetically testable; the script is just the CLI wrapper +
 * orchestrator that wires them together.
 */

'use strict';

const fs    = require('node:fs');
const path  = require('node:path');
const https = require('node:https');
const { spawnSync } = require('node:child_process');

// ── Constants ───────────────────────────────────────────────────────────────

const ANTHROPIC_API_HOST    = 'api.anthropic.com';
const ANTHROPIC_API_PATH    = '/v1/messages';
const ANTHROPIC_VERSION     = '2023-06-01';
const DEFAULT_MODEL         = 'claude-sonnet-4-5';
const DEFAULT_MAX_ATTEMPTS  = 3;
const CLAUDE_TIMEOUT_MS     = 60_000;
const MAX_INPUT_CHARS       = 32_000; // ~8K tokens worst case (4 chars/token)
const MAX_LOG_LINES         = 200;
const MAX_FILE_BYTES        = 50_000;

const CLAUDE_SYSTEM_PROMPT = `\
You are a CI failure-fix expert. Given a CI log + the failing file(s), \
propose the minimum patch that makes the failure go away.

You MUST respond in this strict format and NOTHING ELSE:

FILE: <relative/path/to/file>
PATCH:
<full new contents of the file>
END_PATCH

FILE: <relative/path/to/second-file>
PATCH:
<full new contents of that file>
END_PATCH

Rules:
- One FILE/PATCH/END_PATCH block per file you want to change.
- PATCH must contain the COMPLETE new file contents, not a diff.
- Make the MINIMUM change that fixes the failure. Do not refactor.
- Do not add commentary, explanations, or text outside the FILE/PATCH blocks.
- If you cannot fix the failure, respond with the single word: GIVE_UP`;

// ── Logging (stderr; never pollutes stdout) ─────────────────────────────────

function log(msg) {
  process.stderr.write(`[ai-ci-fixer] ${msg}\n`);
}

function logErr(msg, err) {
  const detail = err && err.message ? `: ${err.message}` : '';
  process.stderr.write(`[ai-ci-fixer] ERROR ${msg}${detail}\n`);
}

// ── GitHub API ──────────────────────────────────────────────────────────────

function githubRequest(token, method, urlPath, body = null, opts = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const reqOpts = {
      hostname: 'api.github.com',
      port: 443,
      path: urlPath,
      method,
      headers: {
        'Accept':              'application/vnd.github+json',
        'Authorization':       `Bearer ${token}`,
        'User-Agent':          'gatetest-ai-ci-fixer',
        'X-GitHub-Api-Version':'2022-11-28',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    };
    const transport = opts.transport || https;
    const req = transport.request(reqOpts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        let parsed = raw;
        if (raw && (res.headers['content-type'] || '').includes('json')) {
          try { parsed = JSON.parse(raw); } catch { /* keep raw */ }
        }
        resolve({ status: res.statusCode, body: parsed, headers: res.headers, raw });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function isRateLimited(response) {
  if (!response || typeof response.status !== 'number') return false;
  if (response.status === 429) return true;
  if (response.status === 403) {
    const remaining = response.headers?.['x-ratelimit-remaining'];
    if (remaining === '0') return true;
    const msg = typeof response.body === 'object' && response.body
      ? (response.body.message || '')
      : '';
    if (/rate limit|abuse|secondary/i.test(String(msg))) return true;
  }
  return false;
}

async function fetchWorkflowRun(token, repo, runId, opts = {}) {
  return githubRequest(token, 'GET', `/repos/${repo}/actions/runs/${runId}`, null, opts);
}

async function fetchWorkflowLogs(token, repo, runId, opts = {}) {
  const jobsRes = await githubRequest(token, 'GET', `/repos/${repo}/actions/runs/${runId}/jobs?per_page=100`, null, opts);
  if (jobsRes.status !== 200 || !jobsRes.body || !Array.isArray(jobsRes.body.jobs)) {
    return { ok: false, response: jobsRes, text: '' };
  }
  const failedJobs = jobsRes.body.jobs.filter((j) => j.conclusion === 'failure');
  if (failedJobs.length === 0) return { ok: true, text: '', failedJobs: [] };
  const j = failedJobs[0];
  const logsRes = await githubRequest(token, 'GET', `/repos/${repo}/actions/jobs/${j.id}/logs`, null, opts);
  const text = typeof logsRes.body === 'string' ? logsRes.body : (logsRes.raw || '');
  return { ok: true, text, failedJobs };
}

async function createPullRequest({ token, repo, head, base, title, body, opts = {} }) {
  return githubRequest(token, 'POST', `/repos/${repo}/pulls`, { title, head, base, body, maintainer_can_modify: true }, opts);
}

async function createIssue({ token, repo, title, body, opts = {} }) {
  return githubRequest(token, 'POST', `/repos/${repo}/issues`, { title, body }, opts);
}

// ── Log parsing ─────────────────────────────────────────────────────────────

function tailLines(text, n = MAX_LOG_LINES) {
  if (!text) return '';
  const lines = String(text).split(/\r?\n/);
  if (lines.length <= n) return lines.join('\n');
  return lines.slice(lines.length - n).join('\n');
}

function _shouldKeepPath(p) {
  if (/^https?:/.test(p)) return false;
  if (p.startsWith('node:')) return false;
  if (p.includes('node_modules')) return false;
  if (p.includes('node:internal')) return false;
  return true;
}

function extractFailingFiles(logText, repoRoot = process.cwd()) {
  if (!logText) return [];
  const out = new Set();
  const reAt   = /\bat\s+([^\s()]+\.[a-zA-Z0-9]+):(\d+)(?::\d+)?/g;
  const reBare = /(?:^|\s|\()((?:\/|[A-Za-z]:\\)?[^\s():]+?\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts|py|go|rs|java|rb|php|cs|kt|swift|json|yaml|yml|md))(?::(\d+))(?::\d+)?/g;
  let m;
  while ((m = reAt.exec(logText)))   { if (_shouldKeepPath(m[1])) out.add(m[1]); }
  while ((m = reBare.exec(logText))) { if (_shouldKeepPath(m[1])) out.add(m[1]); }
  const result = [];
  for (const p of out) {
    let rel = p;
    if (path.isAbsolute(p)) {
      try { rel = path.relative(repoRoot, p); } catch { rel = p; }
    }
    if (rel.startsWith('..') || rel.startsWith('/')) continue;
    result.push(rel);
  }
  return result;
}

// ── Claude prompt + parsing ─────────────────────────────────────────────────

function buildClaudePrompt(logExcerpt, files) {
  const header = `CI log (tail):\n\n${logExcerpt}\n\n`;
  let body = header;
  for (const f of files) {
    const block = `--- FILE: ${f.path} ---\n${f.content}\n--- END FILE: ${f.path} ---\n\n`;
    if (body.length + block.length > MAX_INPUT_CHARS) {
      body += `[truncated — ${files.length - files.indexOf(f)} more file(s) omitted to stay within budget]\n`;
      break;
    }
    body += block;
  }
  if (body.length > MAX_INPUT_CHARS) {
    body = body.slice(0, MAX_INPUT_CHARS - 32) + '\n[...truncated]\n';
  }
  return body;
}

function parseClaudeResponse(text) {
  if (!text || typeof text !== 'string') return [];
  if (/^\s*GIVE_UP\s*$/.test(text)) return [];
  const blocks = [];
  const re = /FILE:\s*(.+?)\s*\r?\nPATCH:\s*\r?\n([\s\S]*?)\r?\nEND_PATCH/g;
  let m;
  while ((m = re.exec(text))) {
    const file = m[1].trim();
    const content = m[2];
    if (!file) continue;
    if (file.includes('..')) continue;
    if (path.isAbsolute(file)) continue;
    blocks.push({ file, content });
  }
  return blocks;
}

function callClaude({ apiKey, model, system, user, timeoutMs = CLAUDE_TIMEOUT_MS, transport }) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model,
      max_tokens: 4096,
      system,
      messages: [{ role: 'user', content: user }],
    });
    const reqOpts = {
      hostname: ANTHROPIC_API_HOST,
      port: 443,
      path: ANTHROPIC_API_PATH,
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'anthropic-version': ANTHROPIC_VERSION,
        'x-api-key':         apiKey,
        'Content-Length':    Buffer.byteLength(payload),
      },
    };
    const t = transport || https;
    const req = t.request(reqOpts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        if (res.statusCode !== 200) {
          reject(new Error(`Anthropic API ${res.statusCode}: ${raw.slice(0, 200)}`));
          return;
        }
        try {
          const parsed = JSON.parse(raw);
          const text = parsed?.content?.[0]?.text || '';
          resolve(text);
        } catch (err) {
          reject(new Error(`Failed to parse Anthropic response: ${err.message}`));
        }
      });
    });
    req.on('error', reject);
    const timer = setTimeout(() => {
      req.destroy(new Error(`Claude call timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    req.on('close', () => clearTimeout(timer));
    req.write(payload);
    req.end();
  });
}

// ── File ops ────────────────────────────────────────────────────────────────

function readFilesForClaude(filePaths, repoRoot) {
  const out = [];
  for (const rel of filePaths) {
    const abs = path.resolve(repoRoot, rel);
    if (!abs.startsWith(repoRoot)) continue;
    if (!fs.existsSync(abs)) continue;
    try {
      const stat = fs.statSync(abs);
      if (!stat.isFile()) continue;
      if (stat.size > MAX_FILE_BYTES) continue;
      const content = fs.readFileSync(abs, 'utf-8');
      out.push({ path: rel, content });
    } catch (err) {
      logErr(`reading ${rel}`, err);
    }
  }
  return out;
}

function applyPatches(patches, repoRoot) {
  const written = [];
  for (const patch of patches) {
    if (!patch || typeof patch.file !== 'string' || typeof patch.content !== 'string') continue;
    if (patch.file.includes('..') || path.isAbsolute(patch.file)) continue;
    const abs = path.resolve(repoRoot, patch.file);
    if (!abs.startsWith(repoRoot)) continue;
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, patch.content, 'utf-8');
      written.push(patch.file);
    } catch (err) {
      logErr(`writing ${patch.file}`, err);
    }
  }
  return written;
}

// ── Gate + git runners ──────────────────────────────────────────────────────

function runGate(repoRoot, opts = {}) {
  const runner = opts.runner || spawnSync;
  const r = runner(process.execPath, ['bin/gatetest.js', '--suite', 'quick'], {
    cwd: repoRoot, encoding: 'utf-8', timeout: opts.timeoutMs || 5 * 60_000,
  });
  return { ok: r.status === 0, status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error || null };
}

function git(args, repoRoot, opts = {}) {
  const runner = opts.runner || spawnSync;
  const r = runner('git', args, {
    cwd: repoRoot, encoding: 'utf-8', timeout: opts.timeoutMs || 60_000,
  });
  return { ok: r.status === 0, status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error || null };
}

// ── PR + issue bodies ───────────────────────────────────────────────────────

function buildPrBody({ runUrl, logExcerpt, attempt, model }) {
  const safeLog = logExcerpt ? logExcerpt.split(/\r?\n/).slice(-80).join('\n') : '(no log captured)';
  return `\
This PR was generated by the AI CI-fixer.

**Failing workflow:** ${runUrl}

**Attempt:** ${attempt}
**Model:** ${model}

<details>
<summary>CI log excerpt</summary>

\`\`\`
${safeLog}
\`\`\`

</details>

Review carefully before merging. The AI may have misread the failure or
proposed a change that masks rather than fixes the underlying bug.

---

Generated by GateTest AI CI-fixer • Powered by Claude
`;
}

function buildIssueBody({ runUrl, logExcerpt, attempted, lastError, model }) {
  const safeLog = (logExcerpt || '').split(/\r?\n/).slice(-80).join('\n');
  const attemptsSummary = attempted.map(
    (a) => `- attempt ${a.attempt}: ${a.patchCount} patch(es) proposed`
  ).join('\n');
  return `\
The AI CI-fixer ran but couldn't repair this workflow run after all attempts.

**Failing workflow:** ${runUrl}
**Model:** ${model}

### Attempts
${attemptsSummary || '(no attempts recorded)'}

${lastError ? `### Last error\n\`\`\`\n${lastError.message}\n\`\`\`` : ''}

<details>
<summary>CI log excerpt</summary>

\`\`\`
${safeLog}
\`\`\`

</details>

A human will need to investigate. Generated by GateTest AI CI-fixer.
`;
}

// ── Env config ──────────────────────────────────────────────────────────────

function readEnv(env = process.env) {
  if (!env.ANTHROPIC_API_KEY) return { ok: false, reason: 'AI CI-fixer disabled (no ANTHROPIC_API_KEY)' };
  if (!env.GITHUB_TOKEN)      return { ok: false, reason: 'AI CI-fixer disabled (no GITHUB_TOKEN)' };
  if (!env.GITHUB_REPOSITORY) return { ok: false, reason: 'AI CI-fixer disabled (no GITHUB_REPOSITORY)' };
  if (!env.WORKFLOW_RUN_ID)   return { ok: false, reason: 'AI CI-fixer disabled (no WORKFLOW_RUN_ID)' };
  const max = parseInt(env.MAX_FIX_ATTEMPTS || '', 10);
  return {
    ok: true,
    apiKey:      env.ANTHROPIC_API_KEY,
    token:       env.GITHUB_TOKEN,
    repo:        env.GITHUB_REPOSITORY,
    runId:       env.WORKFLOW_RUN_ID,
    maxAttempts: Number.isFinite(max) && max > 0 ? max : DEFAULT_MAX_ATTEMPTS,
    model:       env.CLAUDE_MODEL || DEFAULT_MODEL,
  };
}

// ── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  // Constants
  ANTHROPIC_API_HOST, ANTHROPIC_API_PATH, ANTHROPIC_VERSION,
  DEFAULT_MODEL, DEFAULT_MAX_ATTEMPTS, CLAUDE_TIMEOUT_MS,
  MAX_INPUT_CHARS, MAX_LOG_LINES, MAX_FILE_BYTES,
  CLAUDE_SYSTEM_PROMPT,
  // Logging
  log, logErr,
  // GitHub
  githubRequest, isRateLimited,
  fetchWorkflowRun, fetchWorkflowLogs,
  createPullRequest, createIssue,
  // Parsing
  tailLines, extractFailingFiles,
  buildClaudePrompt, parseClaudeResponse, callClaude,
  // I/O
  readFilesForClaude, applyPatches,
  // Runners
  runGate, git,
  // Bodies
  buildPrBody, buildIssueBody,
  // Config
  readEnv,
};
