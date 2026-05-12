/**
 * Nuclear-tier diagnosis engine.
 *
 * Phase 3.1 of THE FIX-FIRST BUILD PLAN. Replaces the category-matched
 * shell-command templates in `server-fix/route.ts` with real
 * Claude-driven diagnosis tied to each specific finding's evidence.
 *
 * The old behaviour: see "Missing HSTS" → emit a hardcoded snippet
 * for nginx + vercel + netlify, regardless of the customer's actual
 * setup. Lawsuit-shape because the snippet might be wrong for their
 * stack and they paste it in trusting our "fix."
 *
 * The new behaviour: for each finding, Claude reads the specific
 * detail string, the hostname, what platform we know they're on,
 * and writes a reasoned diagnosis: explanation of WHY it matters,
 * the root cause, and a recommendation expressed in plain language
 * with code samples ONLY when the platform is confidently known.
 *
 * Pure JS, dependency-injected.
 *
 * Per-finding outcome:
 *   {
 *     finding: { detail, module, severity },
 *     ok: boolean,
 *     diagnosis: {
 *       explanation: string,
 *       rootCause: string,
 *       recommendation: string,
 *       platformNotes: Record<string, string>,
 *     } | null,
 *     reason: string | null,    // populated on failure
 *   }
 */

/**
 * Build the prompt for Claude. Exposed for tests so the prompt
 * shape can be asserted.
 */
function buildDiagnosisPrompt({ finding, hostname, scanContext, priorArt }) {
  const platformLine = scanContext?.platform
    ? `KNOWN PLATFORM: ${scanContext.platform}`
    : 'KNOWN PLATFORM: not detected — provide platform-agnostic guidance';

  const stackLine = scanContext?.stack && scanContext.stack.length > 0
    ? `KNOWN STACK SIGNALS: ${scanContext.stack.join(', ')}`
    : '';

  // Phase 5.1.3 — prior-art context from the cross-repo intelligence brain.
  // Optional. Injected by the route handler when the brain has enough
  // similar past scans to draw conclusions from. Strict shape: a single
  // multi-line string already rendered by cross-repo-lookup.js. Claude
  // is told to USE the prior-art for prioritisation but NEVER copy from
  // it verbatim — the recommendation must still be specific to the
  // customer's finding.
  const priorArtBlock = priorArt
    ? `\n${priorArt}\n\nUse this prior-art ONLY to prioritise + sanity-check your diagnosis. Do not copy from it. Your recommendation must still be specific to the customer's finding above.\n`
    : '';

  return `You are the Nuclear-tier diagnosis agent for GateTest. The customer paid $399 for a deep, honest assessment. Do NOT emit category-matched shell-command templates — those are exactly the dishonest pattern this tier replaces.

Your job: read the SPECIFIC finding, the customer's host, and any platform signals. Write a reasoned diagnosis. The customer's senior engineer should read this and feel like they got a specialist's answer, not a fortune cookie.

HOST: ${hostname}
${platformLine}
${stackLine}
${priorArtBlock}
FINDING:
- module: ${finding.module || '(unknown)'}
- severity: ${finding.severity || '(unknown)'}
- detail: ${finding.detail}

Output format — STRICTLY this exact shape, no markdown fences around the whole response:

EXPLANATION: <1-2 sentences. Why this finding matters in plain language. Specific to the customer's evidence — do not paste boilerplate.>

ROOT_CAUSE: <1 sentence. What is actually wrong, technically. Distinguish "missing config" from "wrong config" from "vulnerable code".>

RECOMMENDATION: <2-4 sentences. Concrete steps the customer should take, in order. If the platform is known, you may include a short code/config sample. If the platform is NOT known, describe the fix in plain language and let them adapt it. Never paste a multi-platform snippet wall — that's the bad pattern this tier replaces.>

PLATFORM_NOTES: <only if relevant. Empty string if the recommendation already covers it. Otherwise: one short note per platform that materially differs (e.g. "On Vercel, add to vercel.json instead of nginx.conf"). Maximum 3 platforms.>

If the finding is too vague to diagnose (the detail string lacks specifics), output exactly:
SKIP: <one-line reason>`;
}

/**
 * Parse the strict diagnosis output. Returns either a structured
 * diagnosis object or { ok: false, reason }.
 */
function parseDiagnosisOutput(raw) {
  if (typeof raw !== 'string') return { ok: false, reason: 'response was not a string' };
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'empty response' };

  if (/^SKIP\b/i.test(trimmed)) {
    const reason = trimmed.replace(/^SKIP:?\s*/i, '').split('\n', 1)[0].trim() || 'diagnoser declined';
    return { ok: false, reason: `diagnoser declined: ${reason}` };
  }
  if (/^I (cannot|can't|won't)\b|^I'm unable to\b|^As an AI\b/.test(trimmed)) {
    return { ok: false, reason: 'diagnoser refused' };
  }

  // Permissive section extraction — line-based scan stops at the next
  // ALL-CAPS section header. More reliable than regex lookahead with
  // multiline flag (where `$` is end-of-LINE not end-of-input and
  // truncates multi-line section content).
  const linesArr = trimmed.split('\n');
  const extract = (label) => {
    const idx = linesArr.findIndex((l) => l.startsWith(`${label}:`));
    if (idx === -1) return null;
    const firstLine = linesArr[idx].slice(`${label}:`.length).trim();
    const buf = firstLine ? [firstLine] : [];
    for (let i = idx + 1; i < linesArr.length; i++) {
      // Stop at next ALL-CAPS section header
      // Stop at next ALL-CAPS section header. Trailing token must be
      // whitespace OR end-of-line — `split('\n')` strips the newline
      // so a header line like "ROOT_CAUSE:" has no trailing whitespace.
      if (/^[A-Z_]+:(\s|$)/.test(linesArr[i])) break;
      buf.push(linesArr[i]);
    }
    const joined = buf.join('\n').trim();
    return joined || null;
  };

  const explanation = extract('EXPLANATION');
  const rootCause = extract('ROOT_CAUSE');
  const recommendation = extract('RECOMMENDATION');
  const platformNotesRaw = extract('PLATFORM_NOTES');

  const missing = [];
  if (!explanation) missing.push('EXPLANATION');
  if (!rootCause) missing.push('ROOT_CAUSE');
  if (!recommendation) missing.push('RECOMMENDATION');
  if (missing.length > 0) {
    return { ok: false, reason: `missing required section(s): ${missing.join(', ')}` };
  }
  if (recommendation.length < 20) {
    return { ok: false, reason: 'recommendation too short to be useful' };
  }

  // platformNotes is optional. Parse "Vercel: ..." lines into a map
  // when present. If empty/absent, return an empty map.
  const platformNotes = {};
  if (platformNotesRaw) {
    const lines = platformNotesRaw.split('\n').map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      const m = line.match(/^([A-Za-z][A-Za-z0-9._\-+ ]*?)\s*[:—-]\s*(.+)$/);
      if (m) platformNotes[m[1].trim()] = m[2].trim();
    }
  }

  return {
    ok: true,
    diagnosis: { explanation, rootCause, recommendation, platformNotes },
  };
}

/**
 * Diagnose a single finding.
 *
 * @param {Object} opts
 * @param {{ detail: string, module?: string, severity?: string }} opts.finding
 * @param {string} [opts.hostname]
 * @param {{ platform?: string, stack?: string[] }} [opts.scanContext]
 * @param {(prompt: string) => Promise<string>} opts.askClaudeForDiagnosis
 * @returns {Promise<{
 *   finding: object,
 *   ok: boolean,
 *   diagnosis: { explanation, rootCause, recommendation, platformNotes } | null,
 *   reason: string | null,
 * }>}
 */
async function diagnoseFinding(opts) {
  const { finding, hostname = 'your-domain.com', scanContext = {}, askClaudeForDiagnosis, priorArt = null } = opts || {};
  if (!finding || typeof finding.detail !== 'string') {
    return { finding: finding || null, ok: false, diagnosis: null, reason: 'malformed finding' };
  }
  if (typeof askClaudeForDiagnosis !== 'function') {
    throw new TypeError('askClaudeForDiagnosis must be a function');
  }
  if (finding.detail.length < 5) {
    return { finding, ok: false, diagnosis: null, reason: 'finding detail too short' };
  }

  const prompt = buildDiagnosisPrompt({ finding, hostname, scanContext, priorArt });

  let raw;
  try {
    raw = await askClaudeForDiagnosis(prompt);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    return { finding, ok: false, diagnosis: null, reason: `Claude API error: ${message}` };
  }

  const parsed = parseDiagnosisOutput(raw);
  if (!parsed.ok) {
    return { finding, ok: false, diagnosis: null, reason: parsed.reason };
  }
  return { finding, ok: true, diagnosis: parsed.diagnosis, reason: null };
}

/**
 * Diagnose a batch of findings. Per-finding failures are recorded
 * but never abort the batch — a missing diagnosis for one finding
 * never blocks the rest.
 *
 * @param {Object} opts
 * @param {Array<{ detail, module?, severity? }>} opts.findings
 * @param {string} [opts.hostname]
 * @param {object} [opts.scanContext]
 * @param {(prompt: string) => Promise<string>} opts.askClaudeForDiagnosis
 * @param {number} [opts.maxFindings=20]  Cap on findings per batch
 *   (Nuclear scans can find hundreds — we don't want one /api/scan/nuclear
 *   call to spend $50 of Anthropic credit).
 * @returns {Promise<{
 *   diagnoses: Array<{ finding, ok, diagnosis, reason }>,
 *   summary: string,
 * }>}
 */
async function diagnoseFindings(opts) {
  const { findings, hostname, scanContext, askClaudeForDiagnosis, maxFindings = 20, priorArt = null } = opts || {};
  if (!Array.isArray(findings)) throw new TypeError('findings must be an array');
  if (typeof askClaudeForDiagnosis !== 'function') throw new TypeError('askClaudeForDiagnosis must be a function');

  const sliced = findings.slice(0, maxFindings);
  const overflow = findings.length - sliced.length;
  const diagnoses = [];

  for (const finding of sliced) {
    const result = await diagnoseFinding({ finding, hostname, scanContext, askClaudeForDiagnosis, priorArt });
    diagnoses.push(result);
  }

  const ok = diagnoses.filter((d) => d.ok).length;
  const failed = diagnoses.filter((d) => !d.ok).length;
  const summary = overflow > 0
    ? `Nuclear diagnoser: ${ok} diagnosed, ${failed} skipped, ${overflow} additional findings deferred (over ${maxFindings}-finding cap)`
    : `Nuclear diagnoser: ${ok} diagnosed, ${failed} skipped`;

  return { diagnoses, summary };
}

/**
 * Render a diagnosis result as a markdown block — for the PR comment
 * or the customer-facing report.
 */
function renderDiagnosis(result) {
  if (!result || !result.ok || !result.diagnosis) {
    const reason = result?.reason || 'no diagnosis generated';
    const detail = result?.finding?.detail || '(unknown finding)';
    return `### \`${detail}\`\n\n*Diagnosis not generated — ${reason}.*`;
  }
  const { explanation, rootCause, recommendation, platformNotes } = result.diagnosis;
  const lines = [];
  lines.push(`### \`${result.finding.detail}\``);
  lines.push('');
  if (result.finding.module) {
    lines.push(`*Module:* \`${result.finding.module}\` · *Severity:* ${result.finding.severity || 'unknown'}`);
    lines.push('');
  }
  lines.push(`**Why this matters.** ${explanation}`);
  lines.push('');
  lines.push(`**Root cause.** ${rootCause}`);
  lines.push('');
  lines.push(`**Recommendation.** ${recommendation}`);
  const platformKeys = Object.keys(platformNotes || {});
  if (platformKeys.length > 0) {
    lines.push('');
    lines.push('**Platform notes:**');
    for (const k of platformKeys) {
      lines.push(`- *${k}* — ${platformNotes[k]}`);
    }
  }
  return lines.join('\n');
}

/**
 * Render a full diagnoses report (header + each diagnosis +
 * branded footer) suitable for posting as a single PR comment.
 */
function renderDiagnosesReport(diagnoses, summary) {
  const ok = diagnoses.filter((d) => d.ok).length;
  const lines = [];
  lines.push('## GateTest Nuclear Diagnosis Report');
  lines.push('');
  lines.push(`Each finding below was diagnosed individually by Claude — explanation, root cause, recommendation, platform notes. No category-matched templates.`);
  if (summary) {
    lines.push('');
    lines.push(`*${summary}*`);
  }
  lines.push('');
  if (ok === 0 && diagnoses.length > 0) {
    lines.push('_No diagnoses succeeded this run — every finding was skipped or errored. The summary above lists per-finding reasons._');
  }
  for (const d of diagnoses) {
    lines.push('');
    lines.push(renderDiagnosis(d));
  }
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('<sub>This report is part of the <a href="https://gatetest.ai">GateTest $399 Nuclear</a> tier. Each diagnosis is reasoned from your specific evidence — not a category-matched template.</sub>');
  return lines.join('\n');
}

module.exports = {
  diagnoseFinding,
  diagnoseFindings,
  renderDiagnosis,
  renderDiagnosesReport,
  // Exported for tests / advanced callers.
  buildDiagnosisPrompt,
  parseDiagnosisOutput,
};
