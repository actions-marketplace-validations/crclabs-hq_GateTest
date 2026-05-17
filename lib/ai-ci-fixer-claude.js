/**
 * Claude API client + retry policy — extracted from ai-ci-fixer-core.js
 * to keep the core file under the 500-line PR-size budget.
 *
 * This file owns:
 *   - The Anthropic endpoint constants
 *   - The system prompt that drives the fixer
 *   - Prompt assembly + response parsing
 *   - Single-call HTTP request to Anthropic
 *   - Retry policy: 3 attempts, 1s/3s/9s backoff, 90s total budget,
 *     retries 429 / 529 / 503 + ECONNRESET / ETIMEDOUT family.
 *
 * No external dependencies (`node:https` + `node:path` only).
 */

'use strict';

const path  = require('node:path');
const https = require('node:https');

// ── Constants ───────────────────────────────────────────────────────────────

const ANTHROPIC_API_HOST    = 'api.anthropic.com';
const ANTHROPIC_API_PATH    = '/v1/messages';
const ANTHROPIC_VERSION     = '2023-06-01';
const DEFAULT_MODEL         = 'claude-sonnet-4-5';
const CLAUDE_TIMEOUT_MS     = 60_000;
const MAX_INPUT_CHARS       = 32_000;

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

// Backoff for transient Claude failures.
const CLAUDE_RETRY_ATTEMPTS  = 3;
const CLAUDE_RETRY_DELAYS_MS = [1_000, 3_000, 9_000];
const CLAUDE_RETRY_BUDGET_MS = 90_000;
const RETRYABLE_NET_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'EPIPE']);

// ── stderr-only logging ─────────────────────────────────────────────────────

function _log(msg) {
  try { process.stderr.write(`[ai-ci-fixer] ${msg}\n`); } catch { /* ignore */ }
}

// ── Prompt assembly + response parsing ──────────────────────────────────────

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

// ── HTTP — single Claude call ───────────────────────────────────────────────

function _callClaudeOnce({ apiKey, model, system, user, timeoutMs = CLAUDE_TIMEOUT_MS, transport }) {
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
          const err = new Error(`Anthropic API ${res.statusCode}: ${raw.slice(0, 200)}`);
          err._status = res.statusCode;
          const retryAfter = res.headers && res.headers['retry-after'];
          if (retryAfter != null) err._retryAfter = retryAfter;
          reject(err);
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
    req.on('error', (err) => {
      if (err && err.code) err._code = err.code;
      reject(err);
    });
    const timer = setTimeout(() => {
      const err = new Error(`Claude call timed out after ${timeoutMs}ms`);
      err._code = 'ETIMEDOUT';
      req.destroy(err);
    }, timeoutMs);
    req.on('close', () => clearTimeout(timer));
    req.write(payload);
    req.end();
  });
}

// ── Retry policy ────────────────────────────────────────────────────────────

function _isRetryableClaudeError(err) {
  if (!err) return false;
  if (err._status === 429 || err._status === 529 || err._status === 503) return true;
  const code = err._code || err.code;
  if (code && RETRYABLE_NET_CODES.has(code)) return true;
  return false;
}

function _parseRetryAfter(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  const n = Number(s);
  if (Number.isFinite(n) && n >= 0) return Math.min(n * 1000, CLAUDE_RETRY_BUDGET_MS);
  const d = Date.parse(s);
  if (!Number.isNaN(d)) {
    const ms = d - Date.now();
    if (ms > 0) return Math.min(ms, CLAUDE_RETRY_BUDGET_MS);
  }
  return null;
}

function _sleep(ms, sleepFn) {
  if (typeof sleepFn === 'function') return sleepFn(ms);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Claude wrapper with exponential backoff retry on 429 / 529 / 503 / network
 * errors. Honors a `Retry-After` header when present. Total budget across
 * all attempts: CLAUDE_RETRY_BUDGET_MS (90s).
 *
 * `opts.sleep` may be injected for tests; `opts.transport` for HTTPS mocking.
 */
async function callClaude(opts) {
  const sleepFn = opts && opts.sleep;
  const start = Date.now();
  let lastErr = null;
  for (let i = 0; i < CLAUDE_RETRY_ATTEMPTS; i++) {
    try {
      return await _callClaudeOnce(opts);
    } catch (err) {
      lastErr = err;
      if (!_isRetryableClaudeError(err)) throw err;
      if (i === CLAUDE_RETRY_ATTEMPTS - 1) break;
      let delay = _parseRetryAfter(err._retryAfter);
      if (delay == null) delay = CLAUDE_RETRY_DELAYS_MS[i] || CLAUDE_RETRY_DELAYS_MS[CLAUDE_RETRY_DELAYS_MS.length - 1];
      const elapsed = Date.now() - start;
      const remaining = CLAUDE_RETRY_BUDGET_MS - elapsed;
      if (remaining <= 0) break;
      delay = Math.min(delay, remaining);
      _log(`Claude retry ${i + 1}/${CLAUDE_RETRY_ATTEMPTS - 1} after ${delay}ms (status=${err._status || ''} code=${err._code || ''})`);
      await _sleep(delay, sleepFn);
    }
  }
  throw lastErr || new Error('Claude call failed after retries');
}

// ── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  // Constants
  ANTHROPIC_API_HOST, ANTHROPIC_API_PATH, ANTHROPIC_VERSION,
  DEFAULT_MODEL, CLAUDE_TIMEOUT_MS, MAX_INPUT_CHARS,
  CLAUDE_SYSTEM_PROMPT,
  CLAUDE_RETRY_ATTEMPTS, CLAUDE_RETRY_DELAYS_MS, CLAUDE_RETRY_BUDGET_MS,
  // Public API
  buildClaudePrompt, parseClaudeResponse, callClaude,
  // Test helpers
  _callClaudeOnce, _isRetryableClaudeError, _parseRetryAfter,
};
