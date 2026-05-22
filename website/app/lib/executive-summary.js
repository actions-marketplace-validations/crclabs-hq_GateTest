/**
 * Executive summary composer.
 *
 * Phase 3.5 of THE FIX-FIRST BUILD PLAN. The customer-facing report
 * a non-technical CTO can read in five minutes and walk away with a
 * clear picture: what state is my code in, what are the top three
 * things to do, what's working well, what's the recommended path.
 *
 * The Nuclear tier already produces the technical artifacts:
 *   - per-finding diagnosis (3.1)
 *   - cross-finding correlations (3.2)
 *   - eventual mutation + chaos passes (3.3, 3.4)
 *
 * This composer reads all of those + the bare scan result and
 * synthesises the executive layer. Plain language. No jargon. No
 * platitudes ("security is important"). Concrete.
 *
 * Pure JS, dependency-injected.
 *
 * Output: structured markdown with named sections suitable to
 * attach as the Nuclear tier's primary deliverable, separate from
 * the technical report blocks.
 */

const { ANTI_INJECTION_PREAMBLE, wrapUntrusted, scanOutputForLeaks } = require('./prompt-injection-guard');

/**
 * Build the prompt. Exposed for tests.
 */
function buildSummaryPrompt({ scanStats, topFindings, chains, hostname }) {
  const findingsBlock = (topFindings || []).slice(0, 10).map((f, idx) => {
    const sev = f.severity ? `[${f.severity}] ` : '';
    const mod = f.module ? `(${f.module}) ` : '';
    return `${idx + 1}. ${sev}${mod}${f.detail}`;
  }).join('\n');

  const chainsBlock = (chains || []).slice(0, 5).map((c, idx) => {
    return `${idx + 1}. [${c.severity || 'unknown'}] ${c.title} — ${c.impact || ''}`;
  }).join('\n');

  const statsLine = scanStats
    ? `${scanStats.modulesPassed ?? '?'}/${scanStats.modulesTotal ?? '?'} modules passed, ${scanStats.errors ?? '?'} errors, ${scanStats.warnings ?? '?'} warnings, ${scanStats.checksPerformed ?? '?'} checks performed in ${scanStats.durationMs ?? '?'}ms`
    : '(no scan stats provided)';

  const hostLine = hostname ? `\nHOST: ${wrapUntrusted('host', hostname)}` : '';

  return `${ANTI_INJECTION_PREAMBLE}
You are the executive-summary composer for GateTest's $399 Nuclear tier. The customer's CTO will read this report. They are technical but they don't have time for jargon. Keep every sentence concrete and specific.

Source material:

SCAN STATS: ${statsLine}
${hostLine}

TOP FINDINGS (most severe first; up to 10):
${findingsBlock ? wrapUntrusted('findings', findingsBlock) : '(no findings supplied)'}

ATTACK CHAINS (cross-finding correlations; up to 5):
${chainsBlock ? wrapUntrusted('chains', chainsBlock) : '(no chains supplied)'}

Your output structure — STRICTLY this exact shape, markdown OK inside the values, no fences around the whole response:

HEADLINE: <one sentence — overall posture in plain language. e.g. "Production-ready with three high-priority security fixes outstanding." or "Significant unaddressed risk in auth and supply-chain — recommend immediate action.">

POSTURE: <3-5 bullet points. Each starts with "- " on a new line. Each is one sentence. Together they paint the overall picture without repeating the same point.>

TOP_3_ACTIONS: <three lines, each "1." / "2." / "3." . The most important things to do this week. Specific. Not "improve security" — "remove unsafe-inline from CSP and rotate the admin JWT secret".>

WORKING_WELL: <2-3 bullet points. Each starts with "- ". What's solid? Don't fish for compliments — only mention if genuinely true (e.g. "All 47 source files pass syntax + lint cleanly", "No hardcoded secrets in the repo").>

RECOMMENDED_NEXT: <one sentence. The single recommended path forward. Could be "Address Top 3 Actions, then re-scan" or "Engage GateTest Continuous tier for ongoing protection" — but only when justified.>

If the scan stats and findings are too sparse to write a meaningful summary (e.g. zero findings AND zero chains), output exactly:
SKIP: scan results too sparse for executive summary`;
}

/**
 * Parse the executive-summary output. Returns either the structured
 * sections or { ok: false, reason }.
 */
function parseSummaryOutput(raw) {
  if (typeof raw !== 'string') return { ok: false, reason: 'response was not a string' };
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'empty response' };

  if (/^SKIP\b/i.test(trimmed)) {
    const reason = trimmed.replace(/^SKIP:?\s*/i, '').split('\n', 1)[0].trim() || 'composer declined';
    return { ok: false, reason: `composer declined: ${reason}` };
  }
  if (/^I (cannot|can't|won't)\b|^I'm unable to\b|^As an AI\b/.test(trimmed)) {
    return { ok: false, reason: 'composer refused' };
  }

  const linesArr = trimmed.split('\n');
  const extract = (label) => {
    const idx = linesArr.findIndex((l) => l.startsWith(`${label}:`));
    if (idx === -1) return null;
    const firstLine = linesArr[idx].slice(`${label}:`.length).trim();
    const buf = firstLine ? [firstLine] : [];
    for (let i = idx + 1; i < linesArr.length; i++) {
      // Stop at next ALL-CAPS section header. The trailing token must
      // be either whitespace OR end-of-line, since `split('\n')` strips
      // the newline so a header line like "POSTURE:" has no trailing
      // whitespace at all.
      if (/^[A-Z_]+:(\s|$)/.test(linesArr[i])) break;
      buf.push(linesArr[i]);
    }
    return buf.join('\n').trim() || null;
  };

  const headline = extract('HEADLINE');
  const posture = extract('POSTURE');
  const topActions = extract('TOP_3_ACTIONS');
  const workingWell = extract('WORKING_WELL');
  const recommendedNext = extract('RECOMMENDED_NEXT');

  const missing = [];
  if (!headline) missing.push('HEADLINE');
  if (!posture) missing.push('POSTURE');
  if (!topActions) missing.push('TOP_3_ACTIONS');
  if (!workingWell) missing.push('WORKING_WELL');
  if (!recommendedNext) missing.push('RECOMMENDED_NEXT');
  if (missing.length > 0) {
    return { ok: false, reason: `missing required section(s): ${missing.join(', ')}` };
  }

  // Light shape validation — headline should be a single sentence,
  // recommendedNext likewise. Truncate gently if Claude wrote prose.
  if (headline.length < 10) return { ok: false, reason: 'headline too short' };
  if (recommendedNext.length < 10) return { ok: false, reason: 'recommendedNext too short' };

  return {
    ok: true,
    sections: {
      headline,
      posture,
      topActions,
      workingWell,
      recommendedNext,
    },
  };
}

/**
 * Run the composer end-to-end.
 *
 * @param {Object} opts
 * @param {{ modulesPassed, modulesTotal, errors, warnings, checksPerformed, durationMs }} [opts.scanStats]
 * @param {Array<{ detail, module?, severity? }>} [opts.topFindings]
 * @param {Array<{ title, severity, impact }>} [opts.chains]
 * @param {string} [opts.hostname]
 * @param {(prompt: string) => Promise<string>} opts.askClaudeForSummary
 * @returns {Promise<{
 *   ok: boolean,
 *   sections: { headline, posture, topActions, workingWell, recommendedNext } | null,
 *   reason: string | null,
 * }>}
 */
async function composeExecutiveSummary(opts) {
  const { scanStats, topFindings, chains, hostname, askClaudeForSummary } = opts || {};
  if (typeof askClaudeForSummary !== 'function') throw new TypeError('askClaudeForSummary must be a function');

  const findingsCount = Array.isArray(topFindings) ? topFindings.length : 0;
  const chainsCount = Array.isArray(chains) ? chains.length : 0;

  if (findingsCount === 0 && chainsCount === 0) {
    return {
      ok: false,
      sections: null,
      reason: 'no findings or chains supplied — nothing to summarise',
    };
  }

  const prompt = buildSummaryPrompt({ scanStats, topFindings, chains, hostname });

  let raw;
  try {
    raw = await askClaudeForSummary(prompt);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    return {
      ok: false,
      sections: null,
      reason: `Claude API error: ${message}`,
    };
  }

  const leakScan = scanOutputForLeaks(raw);
  if (!leakScan.safe) {
    const ids = leakScan.leaks.map((l) => l.id).join(', ');
    return {
      ok: false,
      sections: null,
      reason: `output suppressed — leak detected: ${ids}`,
    };
  }
  raw = leakScan.redacted;

  const parsed = parseSummaryOutput(raw);
  if (!parsed.ok) {
    return { ok: false, sections: null, reason: parsed.reason };
  }
  return { ok: true, sections: parsed.sections, reason: null };
}

/**
 * Render the executive summary as a customer-facing markdown
 * document. Distinct from the technical report — designed to be
 * read top-to-bottom by a non-technical CTO.
 */
function renderExecutiveSummary(result, { hostname } = {}) {
  if (!result || !result.ok || !result.sections) {
    const reason = result?.reason || 'no executive summary generated';
    return `# Executive Summary\n\n*Executive summary not generated — ${reason}.*`;
  }
  const { headline, posture, topActions, workingWell, recommendedNext } = result.sections;
  const lines = [];
  lines.push('# Executive Summary');
  if (hostname) {
    lines.push(`**Subject:** \`${hostname}\``);
  }
  lines.push('');
  lines.push(`> ${headline}`);
  lines.push('');
  lines.push('## Risk posture');
  lines.push('');
  lines.push(posture);
  lines.push('');
  lines.push('## Top 3 actions for this week');
  lines.push('');
  lines.push(topActions);
  lines.push('');
  lines.push('## What is working well');
  lines.push('');
  lines.push(workingWell);
  lines.push('');
  lines.push('## Recommended next step');
  lines.push('');
  lines.push(recommendedNext);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('<sub>This executive summary is part of the <a href="https://gatetest.ai">GateTest $399 Nuclear</a> tier. It synthesises the per-finding diagnosis and cross-finding correlation reports into a single read for senior stakeholders.</sub>');
  return lines.join('\n');
}

module.exports = {
  composeExecutiveSummary,
  renderExecutiveSummary,
  // Exported for tests / advanced callers.
  buildSummaryPrompt,
  parseSummaryOutput,
};
