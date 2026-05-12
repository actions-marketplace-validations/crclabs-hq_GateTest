/**
 * AI Fix Engine — the fix layer that makes scanning actionable.
 *
 * Every module in GateTest can detect issues. This engine fixes them.
 * It takes any check result that has a file path + issue description,
 * sends the file to Claude with targeted surgical instructions, and
 * writes back the corrected version.
 *
 * Design principles:
 *   - Minimal diffs. Claude is instructed to change ONLY the offending lines.
 *   - Idempotent. Running twice on an already-fixed file does nothing.
 *   - Never destructive. Original is backed up before write; restored on failure.
 *   - Cost-capped. Haiku for small files, Sonnet for complex changes.
 *   - Graceful fallback. If AI fix fails, the fix string is returned as a
 *     human-readable suggestion — the scan result is never lost.
 *
 * Two fix modes:
 *   - Surgical (lineNumber provided): sends only a ±20-line window to Claude,
 *     parses back a same-shape replacement block, splices it in. Anything
 *     outside the window is byte-identical by construction, and validated
 *     post-splice. Prevents reformats/renames of unrelated code.
 *   - Whole-file fallback (no lineNumber): sends the full file, reads back
 *     correctedContent JSON, then evaluates the diff via the mutation guard
 *     before writing. Large unrelated diffs are rejected.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const https = require('https');

// Pure helpers — also used by the website route. Live in website/ for path-alias
// reasons; CLI imports via relative path because the gate workflow clones the
// whole repo and both directories are present at runtime.
const surgicalFix  = require('../../lib/surgical-fix');
const mutationGuard = require('../../lib/whole-file-mutation-guard');

const ANTHROPIC_HOST   = 'api.anthropic.com';
const MODEL_FAST       = 'claude-haiku-4-5-20251001';   // small/simple fixes
const MODEL_SMART      = 'claude-sonnet-4-20250514';    // complex/multi-line
const MAX_FILE_BYTES   = 120_000;   // skip files larger than 120 KB
const TIMEOUT_MS       = 45_000;
const SMART_THRESHOLD  = 8_000;     // files > 8 KB get Sonnet

// ─── low-level Anthropic call ──────────────────────────────────────────────

function callAnthropic(apiKey, model, systemPrompt, userMessage) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });

    const req = https.request(
      {
        hostname: ANTHROPIC_HOST,
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
            if (parsed.error) return reject(new Error(parsed.error.message));
            resolve(parsed?.content?.[0]?.text || '');
          } catch (e) {
            reject(e);
          }
        });
      }
    );

    req.setTimeout(TIMEOUT_MS, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── JSON extraction helper ────────────────────────────────────────────────

function extractJson(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw   = fence ? fence[1] : text;
  const start = raw.indexOf('{');
  const end   = raw.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try { return JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
}

// ─── core fix function ─────────────────────────────────────────────────────

/**
 * Apply an AI-generated fix to a single file.
 *
 * @param {object} opts
 * @param {string}  opts.filePath        - Absolute path to the file to fix.
 * @param {string}  opts.issueTitle      - Short name of the issue (e.g. "js-httponly-false").
 * @param {string}  opts.issueMessage    - Human-readable description of what's wrong.
 * @param {number}  [opts.lineNumber]    - 1-based line number where issue was found.
 * @param {string}  [opts.fixSuggestion] - Human-readable fix hint from the module.
 * @param {string}  [opts.apiKey]        - Anthropic API key (falls back to env).
 * @param {Function} [opts._callAnthropic] - Override for callAnthropic (test injection).
 *
 * @returns {Promise<{fixed:boolean, description:string, filesChanged:string[]}>}
 */
async function aiFix(opts) {
  const {
    filePath,
    issueTitle,
    issueMessage,
    lineNumber,
    fixSuggestion,
  } = opts;
  const apiKey = opts.apiKey || process.env.ANTHROPIC_API_KEY;
  // Allow tests to inject a mock callAnthropic without touching the https module.
  const _callAnthropic = opts._callAnthropic || callAnthropic;

  if (!apiKey) {
    return { fixed: false, description: fixSuggestion || issueMessage, filesChanged: [] };
  }

  // Read the file
  let originalContent;
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_FILE_BYTES) {
      return { fixed: false, description: `File too large for AI fix (${stat.size} bytes)`, filesChanged: [] };
    }
    originalContent = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    return { fixed: false, description: `Could not read file: ${err.message}`, filesChanged: [] };
  }

  const model = Buffer.byteLength(originalContent) > SMART_THRESHOLD ? MODEL_SMART : MODEL_FAST;

  // ── SURGICAL MODE (lineNumber provided) ───────────────────────────────────
  if (Number.isInteger(lineNumber) && lineNumber > 0) {
    const ctx = surgicalFix.extractIssueContext(originalContent, lineNumber, 20);
    const prompt = surgicalFix.buildSurgicalPrompt({
      filePath,
      slice: ctx.slice,
      startLine: ctx.startLine,
      endLine: ctx.endLine,
      issues: [issueMessage],
    });

    let rawResponse;
    try {
      // System prompt is minimal — buildSurgicalPrompt carries all the rules.
      rawResponse = await _callAnthropic(apiKey, model, 'Return ONLY the replacement block. No markdown fences. No JSON. Plain text.', prompt);
    } catch (err) {
      return { fixed: false, description: `AI call failed: ${err.message}`, filesChanged: [] };
    }

    const replacement = surgicalFix.parseReplacementBlock(rawResponse);
    if (!replacement) {
      return { fixed: false, description: 'AI returned empty replacement block', filesChanged: [] };
    }

    const fixedContent = surgicalFix.spliceReplacement(
      originalContent,
      ctx.startLine,
      ctx.endLine,
      replacement,
      ctx.lineEnding
    );

    const validation = surgicalFix.validateSurgicalFix({
      originalContent,
      fixedContent,
      startLine: ctx.startLine,
      endLine: ctx.endLine,
      lineEnding: ctx.lineEnding,
    });

    if (!validation.ok) {
      return {
        fixed: false,
        description: `Surgical fix mutated outside slice (rejected by validator): ${validation.reason}`,
        filesChanged: [],
      };
    }

    // Back up, write, verify, clean up.
    const backupPath = filePath + '.gatetest-backup';
    try {
      fs.writeFileSync(backupPath, originalContent, 'utf-8');
      fs.writeFileSync(filePath, fixedContent, 'utf-8');
      fs.readFileSync(filePath, 'utf-8'); // verify write
      try { fs.unlinkSync(backupPath); } catch { /* non-fatal */ }
    } catch (writeErr) {
      try { fs.writeFileSync(filePath, originalContent, 'utf-8'); } catch { /* best effort */ }
      try { fs.unlinkSync(backupPath); } catch { /* non-fatal */ }
      return { fixed: false, description: `Write failed: ${writeErr.message}`, filesChanged: [] };
    }

    return {
      fixed: true,
      description: `Surgical fix applied at line ${lineNumber}`,
      filesChanged: [filePath],
    };
  }

  // ── WHOLE-FILE FALLBACK (no lineNumber) ───────────────────────────────────
  const fixHint  = fixSuggestion ? `\n\nSuggested fix: ${fixSuggestion}` : '';

  const systemPrompt = `You are a precise code fixer. You receive a source file with a specific issue and you fix ONLY that issue — nothing else. You do not reformat, rename, or improve unrelated code. You return JSON only.`;

  const userMessage = `Fix this issue in the file below:

Issue: ${issueTitle}
Description: ${issueMessage}${fixHint}

Return ONLY valid JSON (no markdown, no explanation) in this exact shape:
{
  "fixed": true,
  "correctedContent": "<the entire corrected file content as a string>",
  "description": "<one sentence: what you changed and why>"
}

If the issue is already fixed or you cannot determine a safe fix, return:
{"fixed": false, "correctedContent": "", "description": "<reason>"}

FILE (${path.basename(filePath)}):
\`\`\`
${originalContent}
\`\`\``;

  let response;
  try {
    response = await _callAnthropic(apiKey, model, systemPrompt, userMessage);
  } catch (err) {
    return { fixed: false, description: `AI call failed: ${err.message}`, filesChanged: [] };
  }

  const parsed = extractJson(response);
  if (!parsed || !parsed.fixed || !parsed.correctedContent) {
    return {
      fixed: false,
      description: parsed?.description || 'AI could not determine a safe fix',
      filesChanged: [],
    };
  }

  // Safety check: don't write back identical content
  if (parsed.correctedContent.trim() === originalContent.trim()) {
    return { fixed: false, description: 'File already correct — no changes needed', filesChanged: [] };
  }

  // Mutation guard: reject if the diff is too large relative to the issue count
  const guardResult = mutationGuard.evaluateMutation({
    original: originalContent,
    fixed: parsed.correctedContent,
    issueCount: 1,
  });
  if (!guardResult.ok) {
    return {
      fixed: false,
      description: `Whole-file fix rejected by mutation guard: ${mutationGuard.summariseMutation(guardResult)}`,
      filesChanged: [],
    };
  }

  // Back up the original, then write the fix
  const backupPath = filePath + '.gatetest-backup';
  try {
    fs.writeFileSync(backupPath, originalContent, 'utf-8');
    fs.writeFileSync(filePath, parsed.correctedContent, 'utf-8');
    // Verify the write succeeded and is parseable UTF-8
    fs.readFileSync(filePath, 'utf-8');
    // Clean up backup on success
    try { fs.unlinkSync(backupPath); } catch { /* non-fatal */ }
  } catch (writeErr) {
    // Restore original on failure
    try { fs.writeFileSync(filePath, originalContent, 'utf-8'); } catch { /* best effort */ }
    try { fs.unlinkSync(backupPath); } catch { /* non-fatal */ }
    return { fixed: false, description: `Write failed: ${writeErr.message}`, filesChanged: [] };
  }

  return {
    fixed: true,
    description: parsed.description || `Fixed: ${issueTitle}`,
    filesChanged: [filePath],
  };
}

// ─── batch fixer ──────────────────────────────────────────────────────────

/**
 * Fix all fixable checks in a TestResult array.
 * Injects autoFix functions onto checks that have a file path and fix string
 * but no existing autoFix function.
 *
 * Call this BEFORE the runner's own autoFix pass so every module gets coverage.
 *
 * @param {TestResult[]} results  - Array of module results from the runner.
 * @param {string} projectRoot    - Absolute path to the project root.
 */
function injectAutoFixes(results, projectRoot) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return; // nothing to inject without a key

  for (const result of results) {
    for (const check of result.checks) {
      if (check.passed) continue;
      if (typeof check.autoFix === 'function') continue; // already has one

      // Need at minimum a file reference and either a fix hint or a message
      const filePath = check.file || check.filePath || check.location?.file;
      const fixHint  = check.fix || check.suggestion || check.fixSuggestion;
      const message  = check.message || check.description || check.name;

      if (!filePath) continue;

      const absPath = path.isAbsolute(filePath)
        ? filePath
        : path.join(projectRoot, filePath);

      if (!fs.existsSync(absPath)) continue;

      // Inject a closure that calls aiFix when the runner triggers it
      check.autoFix = () => aiFix({
        filePath: absPath,
        issueTitle: check.name,
        issueMessage: message,
        lineNumber: check.line || check.lineNumber || check.location?.line,
        fixSuggestion: fixHint,
        apiKey,
      });
    }
  }
}

// ─── single-file convenience wrapper ──────────────────────────────────────

/**
 * Fix a specific issue in a specific file. Convenience wrapper around aiFix.
 * Suitable for calling from module autoFix closures directly.
 */
function makeAutoFix(filePath, issueName, message, lineNumber, suggestion) {
  return () => aiFix({
    filePath,
    issueTitle: issueName,
    issueMessage: message,
    lineNumber,
    fixSuggestion: suggestion,
  });
}

module.exports = { aiFix, injectAutoFixes, makeAutoFix };
