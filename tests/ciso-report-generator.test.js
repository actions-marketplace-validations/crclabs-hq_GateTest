'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  generateCisoReport,
  buildComplianceGaps,
  buildNarrativePrompt,
  buildRoadmap,
  renderReport,
  classifySeverity,
  OWASP_MAPPING,
  SOC2_MAPPING,
  CIS_MAPPING,
  MAX_FINDINGS_FOR_NARRATIVE,
} = require('../website/app/lib/ciso-report-generator');

// ─── Test helpers ─────────────────────────────────────────────────────────────

const makeF = (module, severity, detail = 'finding detail') => ({ module, severity, detail });

const SAMPLE_FINDINGS = [
  makeF('secrets', 'error', 'Hardcoded API key found'),
  makeF('secrets', 'error', 'Stripe secret in source'),
  makeF('tlsSecurity', 'error', 'rejectUnauthorized: false'),
  makeF('cookieSecurity', 'error', 'httpOnly: false'),
  makeF('cookieSecurity', 'warning', 'secure: false'),
  makeF('webHeaders', 'warning', 'Missing CSP header'),
  makeF('ssrf', 'error', 'SSRF vector via req.body.url'),
  makeF('logPii', 'error', 'PII in logs: password'),
  makeF('dependencies', 'warning', 'lodash@4.17.15 outdated'),
  makeF('moneyFloat', 'error', 'parseFloat on price field'),
];

// ─── classifySeverity ─────────────────────────────────────────────────────────

describe('classifySeverity', () => {
  it('maps error → High', () => {
    assert.equal(classifySeverity({ severity: 'error' }), 'High');
  });

  it('maps warning → Medium', () => {
    assert.equal(classifySeverity({ severity: 'warning' }), 'Medium');
  });

  it('maps critical → Critical', () => {
    assert.equal(classifySeverity({ severity: 'critical' }), 'Critical');
  });

  it('maps info/unknown → Low', () => {
    assert.equal(classifySeverity({ severity: 'info' }), 'Low');
    assert.equal(classifySeverity({}), 'Low');
  });

  it('reads level field as fallback', () => {
    assert.equal(classifySeverity({ level: 'error' }), 'High');
  });
});

// ─── buildComplianceGaps ──────────────────────────────────────────────────────

describe('buildComplianceGaps', () => {
  it('returns owasp/soc2/cis arrays', () => {
    const gaps = buildComplianceGaps(SAMPLE_FINDINGS);
    assert.ok(Array.isArray(gaps.owasp));
    assert.ok(Array.isArray(gaps.soc2));
    assert.ok(Array.isArray(gaps.cis));
  });

  it('maps secrets to OWASP A02 and A07', () => {
    const gaps = buildComplianceGaps([makeF('secrets', 'error')]);
    const owaspIds = gaps.owasp.map(e => e.control);
    assert.ok(owaspIds.includes('A02:2021'));
    assert.ok(owaspIds.includes('A07:2021'));
  });

  it('maps ssrf to OWASP A10', () => {
    const gaps = buildComplianceGaps([makeF('ssrf', 'error')]);
    const owaspIds = gaps.owasp.map(e => e.control);
    assert.ok(owaspIds.includes('A10:2021'));
  });

  it('maps secrets to SOC2 CC6.1', () => {
    const gaps = buildComplianceGaps([makeF('secrets', 'error')]);
    const soc2Ids = gaps.soc2.map(e => e.control);
    assert.ok(soc2Ids.includes('CC6.1'));
  });

  it('maps secrets to CIS Control 3', () => {
    const gaps = buildComplianceGaps([makeF('secrets', 'error')]);
    const cisIds = gaps.cis.map(e => e.control);
    assert.ok(cisIds.includes('3'));
  });

  it('sorts by findingCount descending', () => {
    const findings = [
      ...Array(3).fill(makeF('secrets', 'error')),
      makeF('ssrf', 'error'),
    ];
    const gaps = buildComplianceGaps(findings);
    // secrets maps to A02 and A07 (3 hits each); ssrf maps to A10 (1 hit)
    const a02 = gaps.owasp.find(e => e.control === 'A02:2021');
    const a10 = gaps.owasp.find(e => e.control === 'A10:2021');
    assert.ok(a02.findingCount > a10.findingCount);
    // sorted: a02/a07 before a10
    assert.ok(gaps.owasp.indexOf(a02) < gaps.owasp.indexOf(a10));
  });

  it('returns empty arrays for unknown modules', () => {
    const gaps = buildComplianceGaps([makeF('unknownModule', 'error')]);
    assert.equal(gaps.owasp.length, 0);
    assert.equal(gaps.soc2.length, 0);
    assert.equal(gaps.cis.length, 0);
  });

  it('handles module names with colon prefix (ruleId form)', () => {
    const gaps = buildComplianceGaps([{ module: 'secrets:hardcoded-key', severity: 'error' }]);
    const owaspIds = gaps.owasp.map(e => e.control);
    // 'secrets' extracted from 'secrets:hardcoded-key'
    assert.ok(owaspIds.includes('A02:2021'));
  });

  it('handles empty findings array', () => {
    const gaps = buildComplianceGaps([]);
    assert.equal(gaps.owasp.length, 0);
    assert.equal(gaps.soc2.length, 0);
    assert.equal(gaps.cis.length, 0);
  });
});

// ─── buildNarrativePrompt ─────────────────────────────────────────────────────

describe('buildNarrativePrompt', () => {
  it('includes hostName and scanDate', () => {
    const prompt = buildNarrativePrompt({
      hostName: 'acme.com',
      scanDate: '2026-05-06',
      findings: SAMPLE_FINDINGS,
      chains: [],
    });
    assert.ok(prompt.includes('acme.com'));
    assert.ok(prompt.includes('2026-05-06'));
  });

  it('includes top findings', () => {
    const prompt = buildNarrativePrompt({
      hostName: 'x.com',
      scanDate: '2026-01-01',
      findings: [makeF('secrets', 'error', 'Hardcoded API key')],
      chains: [],
    });
    assert.ok(prompt.includes('secrets'));
    assert.ok(prompt.includes('Hardcoded API key'));
  });

  it('caps findings at MAX_FINDINGS_FOR_NARRATIVE', () => {
    const many = Array(50).fill(makeF('lint', 'warning', 'lint issue'));
    const prompt = buildNarrativePrompt({
      hostName: 'x.com',
      scanDate: '2026-01-01',
      findings: many,
      chains: [],
    });
    // Only MAX_FINDINGS_FOR_NARRATIVE items should appear in the list
    const lineCount = prompt.split('\n').filter(l => l.startsWith('- [')).length;
    assert.ok(lineCount <= MAX_FINDINGS_FOR_NARRATIVE);
  });

  it('includes chain information when chains provided', () => {
    const prompt = buildNarrativePrompt({
      hostName: 'x.com',
      scanDate: '2026-01-01',
      findings: SAMPLE_FINDINGS,
      chains: [{ severity: 'CRITICAL', impact: 'Full compromise via auth bypass' }],
    });
    assert.ok(prompt.includes('Full compromise via auth bypass'));
  });

  it('shows no-chains message when chains empty', () => {
    const prompt = buildNarrativePrompt({
      hostName: 'x.com',
      scanDate: '2026-01-01',
      findings: SAMPLE_FINDINGS,
      chains: [],
    });
    assert.ok(prompt.includes('No attack chains identified'));
  });
});

// ─── buildRoadmap ──────────────────────────────────────────────────────────────

describe('buildRoadmap', () => {
  it('returns thirtyDays/sixtyDays/ninetyDays arrays', () => {
    const roadmap = buildRoadmap(SAMPLE_FINDINGS);
    assert.ok(Array.isArray(roadmap.thirtyDays));
    assert.ok(Array.isArray(roadmap.sixtyDays));
    assert.ok(Array.isArray(roadmap.ninetyDays));
  });

  it('puts High severity findings in thirtyDays', () => {
    const findings = [makeF('secrets', 'error', 'High finding')];
    const roadmap = buildRoadmap(findings);
    assert.ok(roadmap.thirtyDays.some(i => i.severity === 'High'));
  });

  it('puts Medium findings in sixtyDays', () => {
    const findings = [makeF('webHeaders', 'warning', 'Medium finding')];
    const roadmap = buildRoadmap(findings);
    assert.ok(roadmap.sixtyDays.some(i => i.severity === 'Medium'));
  });

  it('puts Low findings in ninetyDays', () => {
    const findings = [makeF('lint', 'info', 'Low finding')];
    const roadmap = buildRoadmap(findings);
    assert.ok(roadmap.ninetyDays.some(i => i.severity === 'Low'));
  });

  it('caps thirtyDays at 8 items (5 critical + 3 high)', () => {
    const many = Array(20).fill(makeF('secrets', 'error', 'finding'));
    const roadmap = buildRoadmap(many);
    assert.ok(roadmap.thirtyDays.length <= 8);
  });

  it('returns empty arrays for empty findings', () => {
    const roadmap = buildRoadmap([]);
    assert.equal(roadmap.thirtyDays.length, 0);
    assert.equal(roadmap.sixtyDays.length, 0);
    assert.equal(roadmap.ninetyDays.length, 0);
  });
});

// ─── renderReport ─────────────────────────────────────────────────────────────

describe('renderReport', () => {
  const gaps = buildComplianceGaps(SAMPLE_FINDINGS);
  const roadmap = buildRoadmap(SAMPLE_FINDINGS);

  it('includes host name in cover', () => {
    const md = renderReport({
      hostName: 'myapp.io',
      scanDate: '2026-05-06',
      tier: 'Nuclear',
      narrative: 'Test narrative.',
      findings: SAMPLE_FINDINGS,
      chains: [],
      complianceGaps: gaps,
      roadmap,
    });
    assert.ok(md.includes('myapp.io'));
  });

  it('includes OWASP section', () => {
    const md = renderReport({
      hostName: 'x',
      scanDate: '2026-01-01',
      tier: 'Nuclear',
      narrative: 'n/a',
      findings: SAMPLE_FINDINGS,
      chains: [],
      complianceGaps: gaps,
      roadmap,
    });
    assert.ok(md.includes('OWASP Top 10'));
  });

  it('includes SOC2 section', () => {
    const md = renderReport({
      hostName: 'x',
      scanDate: '2026-01-01',
      tier: 'Nuclear',
      narrative: 'n/a',
      findings: SAMPLE_FINDINGS,
      chains: [],
      complianceGaps: gaps,
      roadmap,
    });
    assert.ok(md.includes('SOC2'));
  });

  it('includes CIS Controls section', () => {
    const md = renderReport({
      hostName: 'x',
      scanDate: '2026-01-01',
      tier: 'Nuclear',
      narrative: 'n/a',
      findings: SAMPLE_FINDINGS,
      chains: [],
      complianceGaps: gaps,
      roadmap,
    });
    assert.ok(md.includes('CIS Controls'));
  });

  it('includes remediation roadmap section', () => {
    const md = renderReport({
      hostName: 'x',
      scanDate: '2026-01-01',
      tier: 'Nuclear',
      narrative: 'n/a',
      findings: SAMPLE_FINDINGS,
      chains: [],
      complianceGaps: gaps,
      roadmap,
    });
    assert.ok(md.includes('Remediation Roadmap'));
    assert.ok(md.includes('30-Day Sprint'));
    assert.ok(md.includes('60-Day Sprint'));
    assert.ok(md.includes('90-Day Sprint'));
  });

  it('includes appendix with findings', () => {
    const md = renderReport({
      hostName: 'x',
      scanDate: '2026-01-01',
      tier: 'Nuclear',
      narrative: 'n/a',
      findings: SAMPLE_FINDINGS,
      chains: [],
      complianceGaps: gaps,
      roadmap,
    });
    assert.ok(md.includes('Appendix'));
    assert.ok(md.includes('secrets'));
  });

  it('includes attack chains section when chains provided', () => {
    const md = renderReport({
      hostName: 'x',
      scanDate: '2026-01-01',
      tier: 'Nuclear',
      narrative: 'n/a',
      findings: SAMPLE_FINDINGS,
      chains: [{ severity: 'HIGH', impact: 'Session takeover via XSS chain' }],
      complianceGaps: gaps,
      roadmap,
    });
    assert.ok(md.includes('Attack Chain Analysis'));
    assert.ok(md.includes('Session takeover via XSS chain'));
  });

  it('shows placeholder when narrative is null', () => {
    const md = renderReport({
      hostName: 'x',
      scanDate: '2026-01-01',
      tier: 'Nuclear',
      narrative: null,
      findings: [],
      chains: [],
      complianceGaps: { owasp: [], soc2: [], cis: [] },
      roadmap: { thirtyDays: [], sixtyDays: [], ninetyDays: [] },
    });
    assert.ok(md.includes('Executive narrative not available') || md.includes('not available'));
  });

  it('caps appendix at 100 findings and shows overflow message', () => {
    const many = Array(150).fill(makeF('lint', 'warning', 'lint issue'));
    const md = renderReport({
      hostName: 'x',
      scanDate: '2026-01-01',
      tier: 'Nuclear',
      narrative: null,
      findings: many,
      chains: [],
      complianceGaps: buildComplianceGaps(many),
      roadmap: buildRoadmap(many),
    });
    assert.ok(md.includes('additional findings omitted'));
  });
});

// ─── generateCisoReport ───────────────────────────────────────────────────────

describe('generateCisoReport', () => {
  it('returns markdown, summary, complianceGaps, sections, riskLevel, counts', async () => {
    const result = await generateCisoReport({
      findings: SAMPLE_FINDINGS,
      hostName: 'test.io',
      askClaude: async () => 'Board narrative paragraph one. Board narrative paragraph two. Board narrative paragraph three.',
    });
    assert.ok(typeof result.markdown === 'string');
    assert.ok(result.markdown.length > 100);
    assert.ok(typeof result.summary === 'string');
    assert.ok(Array.isArray(result.sections));
    assert.ok(result.complianceGaps);
    assert.ok(result.riskLevel);
    assert.ok(result.counts);
  });

  it('includes claude narrative in output', async () => {
    const result = await generateCisoReport({
      findings: SAMPLE_FINDINGS,
      hostName: 'acme.com',
      askClaude: async () => 'The security posture is elevated risk.',
    });
    assert.ok(result.markdown.includes('The security posture is elevated risk.'));
  });

  it('returns valid report when claude throws (non-blocking)', async () => {
    const result = await generateCisoReport({
      findings: SAMPLE_FINDINGS,
      hostName: 'test.io',
      askClaude: async () => { throw new Error('API timeout'); },
    });
    assert.ok(typeof result.markdown === 'string');
    assert.ok(result.markdown.length > 100);
    assert.ok(result.summary.includes('test.io'));
  });

  it('computes HIGH risk level when many high findings', async () => {
    const manyHigh = Array(10).fill(makeF('secrets', 'error', 'secret'));
    const result = await generateCisoReport({
      findings: manyHigh,
      hostName: 'x.com',
      askClaude: async () => 'narrative',
    });
    assert.ok(['HIGH', 'ELEVATED', 'CRITICAL'].includes(result.riskLevel));
  });

  it('computes LOW risk level for empty findings', async () => {
    const result = await generateCisoReport({
      findings: [],
      hostName: 'secure.io',
      askClaude: async () => 'narrative',
    });
    assert.equal(result.riskLevel, 'LOW');
    assert.equal(result.counts.High, 0);
    assert.equal(result.counts.Critical, 0);
  });

  it('defaults scanDate to today when not provided', async () => {
    const result = await generateCisoReport({
      findings: [],
      hostName: 'x.com',
      askClaude: async () => 'n',
    });
    const today = new Date().toISOString().slice(0, 10);
    assert.ok(result.markdown.includes(today));
  });

  it('includes attack chains in markdown when provided', async () => {
    const result = await generateCisoReport({
      findings: SAMPLE_FINDINGS,
      chains: [{ severity: 'CRITICAL', impact: 'Full database compromise chain' }],
      hostName: 'x.com',
      askClaude: async () => 'narrative',
    });
    assert.ok(result.markdown.includes('Full database compromise chain'));
  });

  it('sections array contains expected section names', async () => {
    const result = await generateCisoReport({
      findings: [],
      hostName: 'x.com',
      askClaude: async () => 'n',
    });
    assert.ok(result.sections.includes('owasp'));
    assert.ok(result.sections.includes('soc2'));
    assert.ok(result.sections.includes('cis'));
    assert.ok(result.sections.includes('roadmap'));
  });

  it('summary includes finding counts', async () => {
    const result = await generateCisoReport({
      findings: SAMPLE_FINDINGS,
      hostName: 'test.io',
      askClaude: async () => 'n',
    });
    assert.ok(result.summary.includes(String(SAMPLE_FINDINGS.length)));
    assert.ok(result.summary.includes('test.io'));
  });

  it('OWASP_MAPPING covers known security modules', () => {
    assert.ok(OWASP_MAPPING.secrets);
    assert.ok(OWASP_MAPPING.tlsSecurity);
    assert.ok(OWASP_MAPPING.ssrf);
    assert.ok(OWASP_MAPPING.logPii);
    assert.ok(OWASP_MAPPING.dependencies);
  });

  it('SOC2_MAPPING covers key controls', () => {
    assert.ok(SOC2_MAPPING.secrets);
    assert.ok(SOC2_MAPPING.ciSecurity);
    assert.ok(SOC2_MAPPING.logPii);
  });

  it('CIS_MAPPING covers known modules', () => {
    assert.ok(CIS_MAPPING.secrets);
    assert.ok(CIS_MAPPING.webHeaders);
    assert.ok(CIS_MAPPING.dependencies);
  });
});
