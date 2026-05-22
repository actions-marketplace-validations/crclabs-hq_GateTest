/**
 * Cross-finding correlation engine.
 *
 * Phase 3.2 of THE FIX-FIRST BUILD PLAN. The Nuclear-tier
 * differentiator no other AI scanner ships. The per-finding diagnoser
 * (3.1) reasons about ONE finding at a time. This correlator reads
 * the full findings list and identifies CHAINS — combinations of
 * findings that, individually look like warnings, but TOGETHER form
 * a real attack path.
 *
 * Examples:
 *   - CSP unsafe-inline + CORS wildcard + cookie httpOnly:false
 *     → XSS-to-session-takeover chain
 *   - missing rate limiter + exposed admin route + weak default secret
 *     → admin brute force chain
 *   - hardcoded localhost URL + prod deploy + missing healthcheck
 *     → silent prod failure chain
 *
 * Per-finding scanners can never see these because they're cross-file
 * cross-module patterns. Only Claude reading all findings together
 * can identify them.
 *
 * Pure JS, dependency-injected.
 *
 * Output:
 *   {
 *     chains: Array<{
 *       title: string,
 *       severity: 'critical'|'high'|'medium'|'low',
 *       findingsInvolved: string[],   // detail strings of the findings in the chain
 *       impact: string,
 *       fixOrder: string,             // recommended order of fixes
 *     }>,
 *     summary: string,
 *   }
 */

const { ANTI_INJECTION_PREAMBLE, wrapUntrusted, scanOutputForLeaks } = require('./prompt-injection-guard');

/**
 * Build the prompt. Exposed for tests.
 */
function buildCorrelationPrompt({ findings, hostname }) {
  const findingsBlock = findings.map((f, idx) => {
    const sev = f.severity ? `[${f.severity}] ` : '';
    const mod = f.module ? `(${f.module}) ` : '';
    return `${idx + 1}. ${sev}${mod}${f.detail}`;
  }).join('\n');

  const hostLine = hostname ? `\nHOST: ${wrapUntrusted('host', hostname)}` : '';

  return `${ANTI_INJECTION_PREAMBLE}
You are the cross-finding correlation engine for GateTest's $399 Nuclear tier. Per-finding diagnoses already exist (those are produced separately). YOUR job is different — find COMBINATIONS of findings that together form a real attack chain or an unintended interaction.

Examples of valid chains:
- CSP unsafe-inline + CORS wildcard + cookie httpOnly:false → XSS to session takeover
- missing rate limiter + exposed admin route + weak default secret → admin brute force
- hardcoded localhost URL + production deploy → DNS-resolution failure in prod

Rules:
- Only report chains where the COMBINED severity is materially worse than the worst individual finding. If two findings are independent, ignore them — that's not a chain.
- Reference specific findings by number (e.g. "Findings #3, #7, #12"). Do not invent findings.
- Be specific about the IMPACT — describe the actual attack or failure mode in plain language, not generic "this is bad" platitudes.
- Provide a fix order — which finding to address FIRST to break the chain.
- 0-5 chains max. If no real chains exist, output zero chains and the SKIP marker. Do not pad with weak chains.
${hostLine}

FINDINGS:
${wrapUntrusted('findings', findingsBlock)}

Output format — STRICTLY this exact shape, one chain per block, blocks separated by a blank line:

CHAIN: <one-line title naming the chain — what attack or failure it represents>
SEVERITY: <critical|high|medium|low>
INVOLVES: <comma-separated finding numbers e.g. "3, 7, 12">
IMPACT: <2-3 sentences describing the specific attack path or failure mode in plain language>
FIX_ORDER: <one sentence explaining which to fix first and why — what breaks the chain fastest>

(Repeat the block for each chain. Blank line between blocks.)

If no real chains exist, output exactly the single line:
SKIP: no chains identified — findings appear independent`;
}

/**
 * Parse the strict correlation output. Returns either { ok, chains }
 * or { ok: false, reason }. Permissive — minor formatting variations
 * tolerated.
 */
function parseCorrelationOutput(raw, totalFindings) {
  if (typeof raw !== 'string') return { ok: false, reason: 'response was not a string' };
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'empty response' };

  if (/^SKIP\b/i.test(trimmed)) {
    return { ok: true, chains: [] };
  }
  if (/^I (cannot|can't|won't)\b|^I'm unable to\b|^As an AI\b/.test(trimmed)) {
    return { ok: false, reason: 'correlator refused' };
  }

  // Split into blocks separated by 1+ blank lines
  const blocks = trimmed.split(/\n\s*\n/).filter((b) => b.trim().length > 0);
  if (blocks.length === 0) return { ok: false, reason: 'no chain blocks detected' };

  const chains = [];
  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim());
    const get = (label) => {
      const line = lines.find((l) => l.toUpperCase().startsWith(`${label}:`));
      if (!line) return null;
      return line.slice(label.length + 1).trim();
    };

    const title = get('CHAIN');
    const severity = (get('SEVERITY') || '').toLowerCase();
    const involvesRaw = get('INVOLVES');
    const impact = get('IMPACT');
    const fixOrder = get('FIX_ORDER');

    if (!title || !severity || !involvesRaw || !impact || !fixOrder) {
      // Skip malformed block — don't fail the whole batch over one bad block
      continue;
    }
    if (!['critical', 'high', 'medium', 'low'].includes(severity)) {
      continue;
    }

    // Parse comma-separated finding numbers, validate against bounds
    const numbers = involvesRaw
      .split(/[,\s]+/)
      .map((s) => Number(s.replace(/[^0-9]/g, '')))
      .filter((n) => Number.isInteger(n) && n >= 1 && (totalFindings === undefined || n <= totalFindings));
    if (numbers.length < 2) {
      // A chain by definition involves 2+ findings. Skip this block.
      continue;
    }

    chains.push({
      title,
      severity,
      findingNumbers: numbers,
      impact,
      fixOrder,
    });
  }

  if (chains.length === 0) {
    return { ok: false, reason: 'no valid chain blocks parsed (all malformed or single-finding)' };
  }
  return { ok: true, chains };
}

/**
 * Run the correlator end-to-end.
 *
 * @param {Object} opts
 * @param {Array<{ detail, module?, severity? }>} opts.findings
 * @param {string} [opts.hostname]
 * @param {(prompt: string) => Promise<string>} opts.askClaudeForCorrelation
 * @param {number} [opts.maxFindings=40]  Cap on findings sent to Claude
 *   to bound the prompt size and Anthropic spend.
 * @returns {Promise<{
 *   ok: boolean,
 *   chains: Array<{ title, severity, findingNumbers, findingsInvolved, impact, fixOrder }>,
 *   summary: string,
 *   reason: string | null,
 * }>}
 */
async function correlateFindings(opts) {
  const { findings, hostname, askClaudeForCorrelation, maxFindings = 40 } = opts || {};
  if (!Array.isArray(findings)) throw new TypeError('findings must be an array');
  if (typeof askClaudeForCorrelation !== 'function') throw new TypeError('askClaudeForCorrelation must be a function');

  if (findings.length < 2) {
    return {
      ok: true,
      chains: [],
      summary: 'cross-finding correlation: skipped (need ≥ 2 findings)',
      reason: null,
    };
  }

  const sliced = findings.slice(0, maxFindings);
  const overflow = findings.length - sliced.length;
  const prompt = buildCorrelationPrompt({ findings: sliced, hostname });

  let raw;
  try {
    raw = await askClaudeForCorrelation(prompt);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    return {
      ok: false,
      chains: [],
      summary: `cross-finding correlation: failed (${message})`,
      reason: `Claude API error: ${message}`,
    };
  }

  const leakScan = scanOutputForLeaks(raw);
  if (!leakScan.safe) {
    const ids = leakScan.leaks.map((l) => l.id).join(', ');
    return {
      ok: false,
      chains: [],
      summary: `cross-finding correlation: output suppressed (${ids})`,
      reason: `output suppressed — leak detected: ${ids}`,
    };
  }
  raw = leakScan.redacted;

  const parsed = parseCorrelationOutput(raw, sliced.length);
  if (!parsed.ok) {
    return {
      ok: false,
      chains: [],
      summary: `cross-finding correlation: failed (${parsed.reason})`,
      reason: parsed.reason,
    };
  }

  // Resolve finding numbers to actual detail strings
  const chains = parsed.chains.map((c) => ({
    ...c,
    findingsInvolved: c.findingNumbers.map((n) => sliced[n - 1]?.detail || `(unknown finding #${n})`),
  }));

  const baseSummary = chains.length === 0
    ? 'cross-finding correlation: 0 chains identified — findings appear independent'
    : `cross-finding correlation: ${chains.length} attack chain${chains.length > 1 ? 's' : ''} identified`;
  const summary = overflow > 0
    ? `${baseSummary} (${overflow} findings beyond ${maxFindings}-cap not analysed for correlation)`
    : baseSummary;

  return { ok: true, chains, summary, reason: null };
}

const SEVERITY_BADGE = {
  critical: '🔴 critical',
  high: '🟠 high',
  medium: '🟡 medium',
  low: '⚪ low',
};

/**
 * Render the correlation report as markdown PR comment / report
 * section.
 */
function renderCorrelationReport(result) {
  if (!result || !result.ok) {
    const reason = result?.reason || 'no correlation generated';
    return `## GateTest Cross-Finding Correlation\n\n*Correlation report not generated — ${reason}.*`;
  }
  const lines = ['## GateTest Cross-Finding Correlation', ''];
  if (result.chains.length === 0) {
    lines.push('No attack chains detected — your findings appear independent of each other.');
    lines.push('');
    lines.push('This is the *good* outcome. It means your security posture has no compounding weaknesses.');
  } else {
    lines.push(`Claude analysed ${result.chains.length === 1 ? 'this chain' : `these ${result.chains.length} chains`} across the full finding set. Each chain combines individually-survivable findings into something materially worse than the sum of its parts.`);
    lines.push('');
    for (const chain of result.chains) {
      lines.push(`### ${SEVERITY_BADGE[chain.severity] || chain.severity} — ${chain.title}`);
      lines.push('');
      lines.push(`**Findings involved:**`);
      for (const f of chain.findingsInvolved) {
        lines.push(`- \`${f}\``);
      }
      lines.push('');
      lines.push(`**Impact.** ${chain.impact}`);
      lines.push('');
      lines.push(`**Fix order.** ${chain.fixOrder}`);
      lines.push('');
    }
  }
  lines.push('---');
  lines.push('');
  lines.push('<sub>Cross-finding correlation is part of the <a href="https://gatetest.ai">GateTest $399 Nuclear</a> tier. No per-finding scanner can see these patterns — only an agent reading all findings together can identify the attack chains.</sub>');
  return lines.join('\n');
}

module.exports = {
  correlateFindings,
  renderCorrelationReport,
  // Exported for tests / advanced callers.
  buildCorrelationPrompt,
  parseCorrelationOutput,
  SEVERITY_BADGE,
};
