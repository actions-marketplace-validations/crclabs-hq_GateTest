'use strict';

/**
 * Phase 6.2.14 — CISO-ready report generator.
 *
 * Produces a board-presentable security report from a Nuclear scan's
 * findings, Claude diagnoses, and cross-finding correlations. Output
 * is rich Markdown that renders cleanly or converts to PDF via
 * browser print / pandoc / WeasyPrint — no heavy PDF library needed.
 *
 * Report sections:
 *   1. Cover page (host, date, tier, classification)
 *   2. Executive summary (Claude-generated narrative)
 *   3. Security posture scorecard (risk matrix table)
 *   4. OWASP Top 10 2021 mapping
 *   5. SOC2 Trust Service Criteria mapping
 *   6. CIS Controls v8 mapping
 *   7. Attack-chain correlation highlights
 *   8. Top findings with remediation owners
 *   9. Remediation roadmap (30/60/90 day)
 *  10. Appendix: full finding inventory
 *
 * Compliance mappings are static lookup tables — no hallucination risk.
 * Claude is asked only to write the executive narrative paragraphs, where
 * creative synthesis of scan data is appropriate.
 *
 * MAX_FINDINGS_FOR_NARRATIVE: cap findings sent to Claude for the
 * narrative so we don't blow the context window on huge scans.
 */

const MAX_FINDINGS_FOR_NARRATIVE = 25;

// ─── Compliance framework mappings ────────────────────────────────────────────
//
// The canonical mapping table lives in compliance-mappings.js. We keep
// thin OWASP_MAPPING / SOC2_MAPPING / CIS_MAPPING projections exported
// here for backward compatibility with the existing tests, but every
// LOOKUP in this file goes through getComplianceMapping() so unmapped
// modules fall through to the central fallback rather than being silently
// dropped from the framework tables.

const {
  getComplianceMapping,
  OWASP_TOP10,
  SOC2_CRITERIA,
  CIS_CONTROLS,
  MODULE_COMPLIANCE,
} = require('./compliance-mappings');

// Back-compat projections — keep the old shape that tests + external
// callers may be importing. Each is a flat module → string[] view onto
// the central table.
const OWASP_MAPPING = Object.fromEntries(
  Object.entries(MODULE_COMPLIANCE).map(([k, v]) => [k, [...v.owasp]])
);
const SOC2_MAPPING = Object.fromEntries(
  Object.entries(MODULE_COMPLIANCE).map(([k, v]) => [k, [...v.soc2]])
);
const CIS_MAPPING = Object.fromEntries(
  Object.entries(MODULE_COMPLIANCE).map(([k, v]) => [k, [...v.cis]])
);

// ─── Severity utilities ───────────────────────────────────────────────────────

function classifySeverity(finding) {
  const sev = (finding.severity || finding.level || '').toLowerCase();
  if (sev === 'critical') return 'Critical';
  if (sev === 'error' || sev === 'high') return 'High';
  if (sev === 'warning' || sev === 'medium') return 'Medium';
  return 'Low';
}


function severityEmoji(severity) {
  return { Critical: '🔴', High: '🟠', Medium: '🟡', Low: '🟢' }[severity] || '⚪';
}

// ─── Compliance gap builder ───────────────────────────────────────────────────

/**
 * Build a per-framework compliance gap summary from a list of findings.
 * Returns { owasp, soc2, cis } each as arrays of { control, title, findingCount }.
 */
function buildComplianceGaps(findings) {
  const owaspHits = {};
  const soc2Hits = {};
  const cisHits = {};

  for (const f of findings) {
    const modName = f.module || f.ruleId || '';
    // Use the central lookup: unknown modules fall through to the
    // FALLBACK mapping so they still appear in framework tables rather
    // than being silently dropped.
    const mapping = getComplianceMapping(modName);

    for (const cat of mapping.owasp) {
      owaspHits[cat] = (owaspHits[cat] || 0) + 1;
    }
    for (const crit of mapping.soc2) {
      soc2Hits[crit] = (soc2Hits[crit] || 0) + 1;
    }
    for (const ctrl of mapping.cis) {
      cisHits[ctrl] = (cisHits[ctrl] || 0) + 1;
    }
  }

  const sortByCount = obj =>
    Object.entries(obj)
      .sort(([, a], [, b]) => b - a)
      .map(([key, count]) => ({ control: key, findingCount: count }));

  return {
    owasp: sortByCount(owaspHits).map(e => ({
      ...e,
      title: OWASP_TOP10[e.control] || e.control,
    })),
    soc2: sortByCount(soc2Hits).map(e => ({
      ...e,
      title: SOC2_CRITERIA[e.control] || e.control,
    })),
    cis: sortByCount(cisHits).map(e => ({
      ...e,
      title: CIS_CONTROLS[e.control] || e.control,
    })),
  };
}

// ─── Prompt builder ───────────────────────────────────────────────────────────

function buildNarrativePrompt({ hostName, scanDate, findings, chains }) {
  const topFindings = findings
    .slice(0, MAX_FINDINGS_FOR_NARRATIVE)
    .map(f => `- [${classifySeverity(f)}] ${f.module || f.ruleId || 'unknown'}: ${f.detail || f.message || ''}`)
    .join('\n');

  const chainSummary = chains && chains.length > 0
    ? chains.map(c => `- ${c.severity || 'HIGH'}: ${c.impact || c.description || ''}`)
        .slice(0, 5).join('\n')
    : 'No attack chains identified.';

  return `You are a CISO writing an executive security summary for a board presentation.

TARGET: ${hostName}
SCAN DATE: ${scanDate}

TOP SECURITY FINDINGS:
${topFindings}

ATTACK CHAIN CORRELATIONS:
${chainSummary}

Write EXACTLY three paragraphs for the board:

PARAGRAPH 1 — SECURITY POSTURE (2-3 sentences):
State the overall security posture in plain language. What is the risk level? Is the organization in a strong or weak position? What is the single most important thing a board member should know?

PARAGRAPH 2 — KEY RISKS (2-3 sentences):
Name the top 2-3 concrete risks and their potential business impact (data breach, compliance failure, service outage, financial loss). Be specific but avoid technical jargon.

PARAGRAPH 3 — BOARD ACTION (2-3 sentences):
What does the board need to decide or authorize? Frame as business decisions, not engineering tasks. Include a timeline.

Do not use bullet points. Write in professional executive prose. Do not mention GateTest by name. Do not include headers or labels.`;
}

// ─── Remediation roadmap builder ─────────────────────────────────────────────

function buildRoadmap(findings) {
  const critical = findings.filter(f => classifySeverity(f) === 'Critical');
  const high = findings.filter(f => classifySeverity(f) === 'High');
  const medium = findings.filter(f => classifySeverity(f) === 'Medium');
  const low = findings.filter(f => classifySeverity(f) === 'Low');

  return {
    thirtyDays: [
      ...critical.slice(0, 5).map(f => ({ finding: f.detail || f.message || 'Critical finding', severity: 'Critical', module: f.module || '' })),
      ...high.slice(0, 3).map(f => ({ finding: f.detail || f.message || 'High finding', severity: 'High', module: f.module || '' })),
    ],
    sixtyDays: [
      ...high.slice(3, 8).map(f => ({ finding: f.detail || f.message || 'High finding', severity: 'High', module: f.module || '' })),
      ...medium.slice(0, 5).map(f => ({ finding: f.detail || f.message || 'Medium finding', severity: 'Medium', module: f.module || '' })),
    ],
    ninetyDays: [
      ...medium.slice(5, 10).map(f => ({ finding: f.detail || f.message || 'Medium finding', severity: 'Medium', module: f.module || '' })),
      ...low.slice(0, 5).map(f => ({ finding: f.detail || f.message || 'Low finding', severity: 'Low', module: f.module || '' })),
    ],
  };
}

// ─── Markdown renderer ────────────────────────────────────────────────────────

function renderReport({ hostName, scanDate, tier, narrative, findings, chains, complianceGaps, roadmap }) {
  const counts = { Critical: 0, High: 0, Medium: 0, Low: 0 };
  for (const f of findings) counts[classifySeverity(f)] = (counts[classifySeverity(f)] || 0) + 1;

  const total = findings.length;
  const riskLevel = counts.Critical > 0 ? '🔴 CRITICAL' :
    counts.High > 5 ? '🟠 HIGH' :
    counts.High > 0 ? '🟠 ELEVATED' :
    counts.Medium > 10 ? '🟡 MODERATE' : '🟢 LOW';

  const lines = [
    `# Security Assessment Report`,
    ``,
    `> **CONFIDENTIAL — FOR BOARD AND EXECUTIVE USE ONLY**`,
    ``,
    `| | |`,
    `|---|---|`,
    `| **Target** | ${hostName} |`,
    `| **Assessment Date** | ${scanDate} |`,
    `| **Assessment Tier** | ${tier || 'Nuclear'} |`,
    `| **Overall Risk** | ${riskLevel} |`,
    `| **Total Findings** | ${total} |`,
    ``,
    `---`,
    ``,
    `## Executive Summary`,
    ``,
    narrative || '_Executive narrative not available._',
    ``,
    `---`,
    ``,
    `## Security Posture Scorecard`,
    ``,
    `| Severity | Count | Description |`,
    `|---|---|---|`,
    `| 🔴 Critical | ${counts.Critical} | Requires immediate board attention |`,
    `| 🟠 High | ${counts.High} | Address within 30 days |`,
    `| 🟡 Medium | ${counts.Medium} | Address within 60–90 days |`,
    `| 🟢 Low | ${counts.Low} | Address in next planning cycle |`,
    ``,
    `---`,
    ``,
    `## OWASP Top 10 2021 Coverage`,
    ``,
    `_OWASP Top 10 is the globally recognized standard for web application security risk._`,
    ``,
    `| OWASP Category | Title | Findings |`,
    `|---|---|---|`,
    ...(complianceGaps.owasp.length > 0
      ? complianceGaps.owasp.map(e => `| ${e.control} | ${e.title} | ${e.findingCount} |`)
      : ['| — | No mapped findings | 0 |']),
    ``,
    `---`,
    ``,
    `## SOC2 Trust Service Criteria`,
    ``,
    `_Relevant for SOC2 Type II audit readiness._`,
    ``,
    `| Criterion | Description | Findings |`,
    `|---|---|---|`,
    ...(complianceGaps.soc2.length > 0
      ? complianceGaps.soc2.map(e => `| ${e.control} | ${e.title} | ${e.findingCount} |`)
      : ['| — | No mapped findings | 0 |']),
    ``,
    `---`,
    ``,
    `## CIS Controls v8`,
    ``,
    `_CIS Controls are internationally recognized best practices for cyber defense._`,
    ``,
    `| Control | Title | Findings |`,
    `|---|---|---|`,
    ...(complianceGaps.cis.length > 0
      ? complianceGaps.cis.map(e => `| CIS ${e.control} | ${e.title} | ${e.findingCount} |`)
      : ['| — | No mapped findings | 0 |']),
    ``,
    `---`,
    ``,
  ];

  if (chains && chains.length > 0) {
    lines.push(
      `## Attack Chain Analysis`,
      ``,
      `_The following finding combinations represent compounded risk beyond individual issues._`,
      ``,
    );
    for (const chain of chains.slice(0, 5)) {
      const sev = chain.severity || 'HIGH';
      lines.push(
        `### ${severityEmoji(sev)} ${sev} — ${chain.impact || chain.description || 'Attack chain'}`,
        ``,
        chain.impact ? `**Impact:** ${chain.impact}` : '',
        chain.fixOrder ? `**Fix Order:** ${chain.fixOrder}` : '',
        ``,
      );
    }
    lines.push(`---`, ``);
  }

  // Remediation roadmap
  lines.push(
    `## Remediation Roadmap`,
    ``,
    `### 30-Day Sprint (Critical & High Priority)`,
    ``,
  );
  if (roadmap.thirtyDays.length > 0) {
    for (const item of roadmap.thirtyDays) {
      lines.push(`- ${severityEmoji(item.severity)} **[${item.severity}]** \`${item.module}\`: ${item.finding.slice(0, 120)}`);
    }
  } else {
    lines.push('_No critical or high findings — strong security posture._');
  }

  lines.push(
    ``,
    `### 60-Day Sprint (High & Medium Priority)`,
    ``,
  );
  if (roadmap.sixtyDays.length > 0) {
    for (const item of roadmap.sixtyDays) {
      lines.push(`- ${severityEmoji(item.severity)} **[${item.severity}]** \`${item.module}\`: ${item.finding.slice(0, 120)}`);
    }
  } else {
    lines.push('_No medium findings in this window._');
  }

  lines.push(
    ``,
    `### 90-Day Sprint (Medium & Low Priority)`,
    ``,
  );
  if (roadmap.ninetyDays.length > 0) {
    for (const item of roadmap.ninetyDays) {
      lines.push(`- ${severityEmoji(item.severity)} **[${item.severity}]** \`${item.module}\`: ${item.finding.slice(0, 120)}`);
    }
  } else {
    lines.push('_No additional findings in this window._');
  }

  lines.push(
    ``,
    `---`,
    ``,
    `## Appendix: Full Finding Inventory`,
    ``,
    `| # | Severity | Module | Finding |`,
    `|---|---|---|---|`,
    ...findings.slice(0, 100).map((f, i) =>
      `| ${i + 1} | ${severityEmoji(classifySeverity(f))} ${classifySeverity(f)} | \`${f.module || f.ruleId || ''}\` | ${(f.detail || f.message || '').slice(0, 150)} |`
    ),
    ...(findings.length > 100 ? [`| … | | | _${findings.length - 100} additional findings omitted_ |`] : []),
    ``,
    `---`,
    ``,
    `*Report generated by GateTest Nuclear — [gatetest.ai](https://gatetest.ai)*`,
    `*Classification: CONFIDENTIAL*`,
  );

  return lines.filter(l => l !== null && l !== undefined).join('\n');
}

// ─── HTML renderer (for print-to-PDF) ─────────────────────────────────────────

/**
 * Tiny markdown → HTML converter for the print-stylesheet variant of the
 * CISO report. Deliberately minimal — only handles the markdown shapes
 * renderReport() actually produces (headings, tables, blockquotes, lists,
 * horizontal rules, paragraphs, inline code, bold, italic). Zero deps.
 *
 * Output is wrapped in a self-contained HTML document with an embedded
 * print stylesheet, so opening it in any browser → File > Print > Save
 * as PDF produces a board-ready document.
 *
 * @param {string} markdown
 * @param {string} hostName - rendered in the <title>
 * @returns {string}
 */
function renderHtmlReport(markdown, hostName = 'Security Assessment') {
  const escape = (s) => String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Render inline-level markdown (code, bold, italic) inside a single cell
  // / paragraph. Order matters: code first (we don't want bold inside code
  // to get processed).
  const inline = (s) => {
    let out = escape(s);
    out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
    return out;
  };

  const lines = String(markdown || '').split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    // Horizontal rule
    if (/^---+\s*$/.test(line)) {
      out.push('<hr/>');
      i++;
      continue;
    }
    // Heading
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      i++;
      continue;
    }
    // Blockquote
    if (/^>\s+/.test(line)) {
      const block = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        block.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${inline(block.join(' '))}</blockquote>`);
      continue;
    }
    // Table — a row that starts with `|` followed by the separator row
    if (line.startsWith('|') && i + 1 < lines.length && /^\|[\s\-|:]+\|$/.test(lines[i + 1].trim())) {
      const header = line.split('|').slice(1, -1).map((c) => c.trim());
      i += 2; // skip separator
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) {
        rows.push(lines[i].split('|').slice(1, -1).map((c) => c.trim()));
        i++;
      }
      const thead = header.map((c) => `<th>${inline(c)}</th>`).join('');
      const tbody = rows
        .map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>')
        .join('');
      out.push(`<table><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table>`);
      continue;
    }
    // Unordered list
    if (/^-\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^-\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^-\s+/, ''));
        i++;
      }
      out.push('<ul>' + items.map((it) => `<li>${inline(it)}</li>`).join('') + '</ul>');
      continue;
    }
    // Blank line
    if (line.trim() === '') {
      i++;
      continue;
    }
    // Plain paragraph — accumulate consecutive non-special lines.
    const para = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^#{1,6}\s/.test(lines[i]) &&
      !/^---+\s*$/.test(lines[i]) &&
      !lines[i].startsWith('|') &&
      !/^-\s+/.test(lines[i]) &&
      !/^>\s+/.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    if (para.length > 0) {
      out.push(`<p>${inline(para.join(' '))}</p>`);
    }
  }

  const body = out.join('\n');
  const titleSafe = escape(`Security Assessment — ${hostName}`);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>${titleSafe}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; line-height: 1.55; color: #1a1a1a; max-width: 900px; margin: 2rem auto; padding: 0 2rem; }
    h1 { font-size: 2rem; border-bottom: 2px solid #333; padding-bottom: 0.5rem; }
    h2 { font-size: 1.4rem; margin-top: 2.5rem; color: #1a1a1a; border-bottom: 1px solid #ccc; padding-bottom: 0.25rem; }
    h3 { font-size: 1.1rem; margin-top: 1.75rem; }
    blockquote { border-left: 4px solid #888; padding: 0.5rem 1rem; background: #f4f4f4; color: #333; margin: 1rem 0; font-weight: 600; }
    table { border-collapse: collapse; width: 100%; margin: 1rem 0; font-size: 0.95rem; }
    th, td { border: 1px solid #ccc; padding: 0.5rem 0.75rem; text-align: left; vertical-align: top; }
    th { background: #f0f0f0; }
    code { background: #f4f4f4; padding: 0.1rem 0.3rem; border-radius: 3px; font-family: SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; font-size: 0.9em; }
    hr { border: none; border-top: 1px solid #ccc; margin: 2rem 0; }
    ul { padding-left: 1.5rem; }
    li { margin: 0.25rem 0; }
    @media print { body { margin: 0; padding: 1rem; max-width: none; } h2 { page-break-before: auto; } table { page-break-inside: avoid; } }
  </style>
</head>
<body>
${body}
</body>
</html>`;
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Generate a CISO-ready security report.
 *
 * @param {Object} opts
 * @param {Array}    opts.findings    - Array of { module, detail/message, severity/level }
 * @param {Array}    [opts.chains]    - Attack chains from cross-finding-correlator
 * @param {string}   opts.hostName    - Hostname/repo being scanned
 * @param {string}   [opts.scanDate]  - ISO date string (defaults to today)
 * @param {string}   [opts.tier]      - Scan tier label
 * @param {Function} [opts.askClaude] - async (prompt) => string. Optional;
 *                                       if omitted or it throws, the executive
 *                                       narrative section is skipped and the
 *                                       rest of the report still ships.
 * @returns {Promise<{ markdown: string, html: string, summary: string,
 *                     complianceGaps: object, sections: string[],
 *                     riskLevel: string, counts: object }>}
 */
async function generateCisoReport({ findings = [], chains = [], hostName = 'Unknown', scanDate, tier = 'Nuclear', askClaude }) {
  const date = scanDate || new Date().toISOString().slice(0, 10);
  const complianceGaps = buildComplianceGaps(findings);
  const roadmap = buildRoadmap(findings);

  const counts = { Critical: 0, High: 0, Medium: 0, Low: 0 };
  for (const f of findings) counts[classifySeverity(f)] = (counts[classifySeverity(f)] || 0) + 1;

  let narrative = null;
  if (typeof askClaude === 'function') {
    try {
      const prompt = buildNarrativePrompt({ hostName, scanDate: date, findings, chains });
      const raw = await askClaude(prompt);
      narrative = raw ? raw.trim() : null;
    } catch {
      // narrative failure is non-blocking — report ships without it
    }
  }

  const markdown = renderReport({ hostName, scanDate: date, tier, narrative, findings, chains, complianceGaps, roadmap });
  const html = renderHtmlReport(markdown, hostName);

  const riskLevel = counts.Critical > 0 ? 'CRITICAL' :
    counts.High > 5 ? 'HIGH' :
    counts.High > 0 ? 'ELEVATED' :
    counts.Medium > 10 ? 'MODERATE' : 'LOW';

  const summary = `CISO report generated for ${hostName}: ${findings.length} findings (${counts.Critical} critical, ${counts.High} high, ${counts.Medium} medium, ${counts.Low} low). Risk level: ${riskLevel}. Compliance gaps: ${complianceGaps.owasp.length} OWASP, ${complianceGaps.soc2.length} SOC2, ${complianceGaps.cis.length} CIS.`;

  return {
    markdown,
    html,
    summary,
    complianceGaps,
    sections: ['cover', 'executiveSummary', 'scorecard', 'owasp', 'soc2', 'cis', 'attackChains', 'roadmap', 'appendix'],
    riskLevel,
    counts,
  };
}

/**
 * Default repository path where the CISO report attaches inside the
 * customer's auto-fix PR. Date-stamped so re-runs don't clobber each
 * other.
 *
 * @param {string} [scanDate] - ISO date string (YYYY-MM-DD)
 * @returns {string}
 */
function cisoReportPath(scanDate) {
  const d = scanDate || new Date().toISOString().slice(0, 10);
  return `gatetest-reports/ciso-board-report-${d}.md`;
}

module.exports = {
  generateCisoReport,
  buildComplianceGaps,
  buildNarrativePrompt,
  buildRoadmap,
  renderReport,
  renderHtmlReport,
  cisoReportPath,
  classifySeverity,
  OWASP_MAPPING,
  SOC2_MAPPING,
  CIS_MAPPING,
  OWASP_TOP10,
  SOC2_CRITERIA,
  CIS_CONTROLS,
  MAX_FINDINGS_FOR_NARRATIVE,
};
