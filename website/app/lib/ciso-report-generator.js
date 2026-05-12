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

// ─── OWASP Top 10 2021 mappings ──────────────────────────────────────────────

const OWASP_TOP10 = {
  'A01:2021': 'Broken Access Control',
  'A02:2021': 'Cryptographic Failures',
  'A03:2021': 'Injection',
  'A04:2021': 'Insecure Design',
  'A05:2021': 'Security Misconfiguration',
  'A06:2021': 'Vulnerable and Outdated Components',
  'A07:2021': 'Identification and Authentication Failures',
  'A08:2021': 'Software and Data Integrity Failures',
  'A09:2021': 'Security Logging and Monitoring Failures',
  'A10:2021': 'Server-Side Request Forgery (SSRF)',
};

// Module → OWASP categories (can be multiple)
const OWASP_MAPPING = {
  secrets:              ['A02:2021', 'A07:2021'],
  secretRotation:       ['A02:2021', 'A07:2021'],
  tlsSecurity:          ['A02:2021', 'A05:2021'],
  cookieSecurity:       ['A02:2021', 'A05:2021', 'A07:2021'],
  webHeaders:           ['A05:2021'],
  ciSecurity:           ['A05:2021', 'A08:2021'],
  terraform:            ['A05:2021'],
  kubernetes:           ['A05:2021'],
  promptSafety:         ['A05:2021', 'A08:2021'],
  envVars:              ['A05:2021'],
  featureFlag:          ['A05:2021'],
  ssrf:                 ['A10:2021'],
  crossFileTaint:       ['A03:2021'],
  sqlMigrations:        ['A03:2021'],
  hardcodedUrl:         ['A01:2021', 'A05:2021'],
  deadCode:             ['A04:2021'],
  dependencies:         ['A06:2021'],
  redos:                ['A06:2021'],
  logPii:               ['A09:2021'],
  errorSwallow:         ['A09:2021'],
  moneyFloat:           ['A04:2021'],
  raceCondition:        ['A04:2021'],
  resourceLeak:         ['A04:2021'],
  nPlusOne:             ['A04:2021'],
  asyncIteration:       ['A04:2021'],
  importCycle:          ['A04:2021'],
  typescriptStrictness: ['A04:2021'],
  lint:                 ['A04:2021'],
  codeQuality:          ['A04:2021'],
  homoglyph:            ['A08:2021'],
  flakyTests:           ['A04:2021'],
  retryHygiene:         ['A04:2021'],
  datetimeBug:          ['A04:2021'],
  cronExpression:       ['A04:2021'],
  openapiDrift:         ['A05:2021'],
};

// ─── SOC2 Trust Service Criteria mappings ────────────────────────────────────

const SOC2_CRITERIA = {
  'CC6.1':  'Logical and Physical Access Controls — restrict logical access to software',
  'CC6.6':  'Network and Logical Access — restrict access with security boundaries',
  'CC6.7':  'Transmission and Disclosure — data in transit protected',
  'CC6.8':  'Prevent Unauthorized Access — prevent logical access by unauthorized entities',
  'CC7.1':  'System Operations — detect and monitor for configuration changes',
  'CC7.2':  'Threat Intelligence — monitor for new vulnerabilities',
  'CC8.1':  'Change Management — authorise, design, develop, and implement changes',
  'CC2.2':  'Internal Communications — communicate information to enable entity objectives',
  'CC3.1':  'Specification — identify and assess risks to achieving objectives',
  'CC9.1':  'Risk Mitigation — identify and assess risks from business disruption',
  'A1.1':   'Availability — maintain and monitor performance capacity',
  'PI1.1':  'Processing Integrity — processing is complete, valid, accurate, timely',
  'P4.1':   'Privacy — collect personal information consistent with objectives',
  'P8.1':   'Privacy — remediate privacy incidents and complaints',
};

const SOC2_MAPPING = {
  secrets:              ['CC6.1', 'CC6.8'],
  secretRotation:       ['CC6.1', 'CC6.8'],
  tlsSecurity:          ['CC6.7', 'CC6.6'],
  cookieSecurity:       ['CC6.7', 'CC6.1'],
  webHeaders:           ['CC6.6'],
  ciSecurity:           ['CC8.1', 'CC6.8'],
  terraform:            ['CC7.1', 'CC8.1'],
  kubernetes:           ['CC7.1', 'CC6.6'],
  envVars:              ['CC6.1'],
  logPii:               ['CC2.2', 'P4.1', 'P8.1'],
  ssrf:                 ['CC6.8'],
  crossFileTaint:       ['CC6.8'],
  sqlMigrations:        ['CC7.1', 'A1.1'],
  dependencies:         ['CC7.2', 'CC8.1'],
  promptSafety:         ['CC7.2', 'CC3.1'],
  moneyFloat:           ['PI1.1'],
  raceCondition:        ['PI1.1', 'A1.1'],
  resourceLeak:         ['A1.1'],
  nPlusOne:             ['A1.1'],
  homoglyph:            ['CC6.8', 'CC8.1'],
  errorSwallow:         ['CC7.1'],
  featureFlag:          ['CC8.1'],
  openapiDrift:         ['CC8.1', 'PI1.1'],
  retryHygiene:         ['A1.1', 'CC9.1'],
};

// ─── CIS Controls v8 mappings ─────────────────────────────────────────────────

const CIS_CONTROLS = {
  '1':  'Inventory and Control of Enterprise Assets',
  '2':  'Inventory and Control of Software Assets',
  '3':  'Data Protection',
  '4':  'Secure Configuration of Enterprise Assets and Software',
  '5':  'Account Management',
  '6':  'Access Control Management',
  '7':  'Continuous Vulnerability Management',
  '8':  'Audit Log Management',
  '9':  'Email and Web Browser Protections',
  '10': 'Malware Defenses',
  '11': 'Data Recovery',
  '12': 'Network Infrastructure Management',
  '13': 'Network Monitoring and Defense',
  '14': 'Security Awareness and Skills Training',
  '15': 'Service Provider Management',
  '16': 'Application Software Security',
  '18': 'Penetration Testing',
};

const CIS_MAPPING = {
  secrets:              ['3', '5'],
  secretRotation:       ['3', '5'],
  tlsSecurity:          ['3', '4'],
  cookieSecurity:       ['3', '4', '6'],
  webHeaders:           ['4', '16'],
  ciSecurity:           ['4', '16'],
  terraform:            ['4'],
  kubernetes:           ['4', '12'],
  envVars:              ['3', '4'],
  logPii:               ['3', '8'],
  ssrf:                 ['13', '16'],
  crossFileTaint:       ['16'],
  sqlMigrations:        ['4'],
  dependencies:         ['2', '7'],
  promptSafety:         ['16'],
  moneyFloat:           ['16'],
  raceCondition:        ['16'],
  resourceLeak:         ['16'],
  nPlusOne:             ['16'],
  homoglyph:            ['16'],
  errorSwallow:         ['8'],
  featureFlag:          ['4', '16'],
  openapiDrift:         ['16'],
  retryHygiene:         ['16'],
  redos:                ['16'],
  importCycle:          ['16'],
  asyncIteration:       ['16'],
  datetimeBug:          ['16'],
  deadCode:             ['16'],
};

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
    const baseMod = modName.split(':')[0];

    for (const cat of (OWASP_MAPPING[baseMod] || [])) {
      owaspHits[cat] = (owaspHits[cat] || 0) + 1;
    }
    for (const crit of (SOC2_MAPPING[baseMod] || [])) {
      soc2Hits[crit] = (soc2Hits[crit] || 0) + 1;
    }
    for (const ctrl of (CIS_MAPPING[baseMod] || [])) {
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
 * @param {Function} opts.askClaude   - async (prompt) => string
 * @returns {Promise<{ markdown, summary, complianceGaps, sections }>}
 */
async function generateCisoReport({ findings = [], chains = [], hostName = 'Unknown', scanDate, tier = 'Nuclear', askClaude }) {
  const date = scanDate || new Date().toISOString().slice(0, 10);
  const complianceGaps = buildComplianceGaps(findings);
  const roadmap = buildRoadmap(findings);

  const counts = { Critical: 0, High: 0, Medium: 0, Low: 0 };
  for (const f of findings) counts[classifySeverity(f)] = (counts[classifySeverity(f)] || 0) + 1;

  let narrative = null;
  try {
    const prompt = buildNarrativePrompt({ hostName, scanDate: date, findings, chains });
    const raw = await askClaude(prompt);
    narrative = raw ? raw.trim() : null;
  } catch {
    // narrative failure is non-blocking — report ships without it
  }

  const markdown = renderReport({ hostName, scanDate: date, tier, narrative, findings, chains, complianceGaps, roadmap });

  const riskLevel = counts.Critical > 0 ? 'CRITICAL' :
    counts.High > 5 ? 'HIGH' :
    counts.High > 0 ? 'ELEVATED' :
    counts.Medium > 10 ? 'MODERATE' : 'LOW';

  const summary = `CISO report generated for ${hostName}: ${findings.length} findings (${counts.Critical} critical, ${counts.High} high, ${counts.Medium} medium, ${counts.Low} low). Risk level: ${riskLevel}. Compliance gaps: ${complianceGaps.owasp.length} OWASP, ${complianceGaps.soc2.length} SOC2, ${complianceGaps.cis.length} CIS.`;

  return {
    markdown,
    summary,
    complianceGaps,
    sections: ['cover', 'executiveSummary', 'scorecard', 'owasp', 'soc2', 'cis', 'attackChains', 'roadmap', 'appendix'],
    riskLevel,
    counts,
  };
}

module.exports = {
  generateCisoReport,
  buildComplianceGaps,
  buildNarrativePrompt,
  buildRoadmap,
  renderReport,
  classifySeverity,
  OWASP_MAPPING,
  SOC2_MAPPING,
  CIS_MAPPING,
  OWASP_TOP10,
  SOC2_CRITERIA,
  CIS_CONTROLS,
  MAX_FINDINGS_FOR_NARRATIVE,
};
