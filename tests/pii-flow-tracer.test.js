'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  tracePiiFlows,
  detectSinks,
  detectSources,
  buildNarrativePrompt,
  renderReport,
  generatePiiFlowReport,
  PII_FIELDS,
  FIELD_TIER_MAP,
  MAX_FILES_PER_RUN,
  MAX_FINDINGS_FOR_NARRATIVE,
} = require('../website/app/lib/pii-flow-tracer.js');

// ─── PII_FIELDS / FIELD_TIER_MAP ─────────────────────────────────────────────

describe('PII_FIELDS', () => {
  it('has CRITICAL, HIGH, MEDIUM tiers', () => {
    assert.ok(Array.isArray(PII_FIELDS.CRITICAL));
    assert.ok(Array.isArray(PII_FIELDS.HIGH));
    assert.ok(Array.isArray(PII_FIELDS.MEDIUM));
  });

  it('CRITICAL includes ssn', () => {
    assert.ok(PII_FIELDS.CRITICAL.includes('ssn'));
  });

  it('HIGH includes email', () => {
    assert.ok(PII_FIELDS.HIGH.includes('email'));
  });

  it('MEDIUM includes name', () => {
    assert.ok(PII_FIELDS.MEDIUM.includes('name'));
  });
});

describe('FIELD_TIER_MAP', () => {
  it('maps email to HIGH', () => {
    assert.equal(FIELD_TIER_MAP['email'], 'HIGH');
  });

  it('maps ssn to CRITICAL', () => {
    assert.equal(FIELD_TIER_MAP['ssn'], 'CRITICAL');
  });

  it('maps name to MEDIUM', () => {
    assert.equal(FIELD_TIER_MAP['name'], 'MEDIUM');
  });

  it('all keys are lowercase', () => {
    for (const key of Object.keys(FIELD_TIER_MAP)) {
      assert.equal(key, key.toLowerCase());
    }
  });
});

// ─── detectSinks ─────────────────────────────────────────────────────────────

describe('detectSinks', () => {
  it('detects console.log as log sink', () => {
    const sinks = detectSinks('console.log(user.email)');
    assert.ok(sinks.includes('log'));
  });

  it('detects fetch as externalApi sink', () => {
    const sinks = detectSinks('await fetch("https://api.example.com", { body })');
    assert.ok(sinks.includes('externalApi'));
  });

  it('detects prisma.create as database sink', () => {
    const sinks = detectSinks('await prisma.user.create({ data: { email } })');
    assert.ok(sinks.includes('database'));
  });

  it('detects fs.writeFile as fileWrite sink', () => {
    const sinks = detectSinks('fs.writeFile("log.txt", content)');
    assert.ok(sinks.includes('fileWrite'));
  });

  it('detects res.json as response sink', () => {
    const sinks = detectSinks('res.json({ user })');
    assert.ok(sinks.includes('response'));
  });

  it('detects sendgrid as thirdParty sink', () => {
    const sinks = detectSinks('sendgrid.send({ to: email })');
    assert.ok(sinks.includes('thirdParty'));
  });

  it('returns empty array for code with no sinks', () => {
    const sinks = detectSinks('const x = 1 + 2;');
    assert.deepEqual(sinks, []);
  });

  it('detects multiple sinks in same file', () => {
    const code = `
      console.log(email);
      await fetch(url, { body: JSON.stringify({ email }) });
      await prisma.user.create({ data: { email } });
    `;
    const sinks = detectSinks(code);
    assert.ok(sinks.includes('log'));
    assert.ok(sinks.includes('externalApi'));
    assert.ok(sinks.includes('database'));
  });
});

// ─── detectSources ───────────────────────────────────────────────────────────

describe('detectSources', () => {
  it('detects req.body as source', () => {
    assert.ok(detectSources('const { email } = req.body'));
  });

  it('detects req.query as source', () => {
    assert.ok(detectSources('const q = req.query.search'));
  });

  it('detects event.body as source', () => {
    assert.ok(detectSources('const data = JSON.parse(event.body)'));
  });

  it('returns false for internal data with no sources', () => {
    assert.ok(!detectSources('const config = { maxRetries: 3 }'));
  });
});

// ─── tracePiiFlows ───────────────────────────────────────────────────────────

describe('tracePiiFlows', () => {
  it('returns empty flows for empty input', () => {
    const { flows, riskCounts } = tracePiiFlows([]);
    assert.equal(flows.length, 0);
    assert.equal(riskCounts.CRITICAL, 0);
    assert.equal(riskCounts.HIGH, 0);
    assert.equal(riskCounts.MEDIUM, 0);
  });

  it('returns empty flows when files have no sinks', () => {
    const sourceFiles = [
      { filePath: 'src/utils.js', content: 'const email = "test@test.com"; return email;' },
    ];
    const { flows } = tracePiiFlows(sourceFiles);
    assert.equal(flows.length, 0);
  });

  it('detects email field flowing to log sink', () => {
    const sourceFiles = [
      {
        filePath: 'src/api/signup.js',
        content: `
          const { email } = req.body;
          console.log('User signed up:', email);
        `,
      },
    ];
    const { flows } = tracePiiFlows(sourceFiles);
    const emailFlow = flows.find((f) => f.field === 'email');
    assert.ok(emailFlow, 'should detect email flow');
    assert.equal(emailFlow.tier, 'HIGH');
    assert.ok(emailFlow.sinks.some((s) => s.type === 'log'));
  });

  it('detects ssn field as CRITICAL tier', () => {
    const sourceFiles = [
      {
        filePath: 'src/api/verify.js',
        content: `
          const { ssn } = req.body;
          await fetch('/verify', { body: JSON.stringify({ ssn }) });
        `,
      },
    ];
    const { flows, riskCounts } = tracePiiFlows(sourceFiles);
    const ssnFlow = flows.find((f) => f.field === 'ssn');
    assert.ok(ssnFlow, 'should detect ssn flow');
    assert.equal(ssnFlow.tier, 'CRITICAL');
    assert.equal(riskCounts.CRITICAL, 1);
  });

  it('includes sourceLine for the field', () => {
    const sourceFiles = [
      {
        filePath: 'src/user.js',
        content: `const x = 1;\nconst email = req.body.email;\nconsole.log(email);\n`,
      },
    ];
    const { flows } = tracePiiFlows(sourceFiles);
    const f = flows.find((f) => f.field === 'email');
    assert.ok(f);
    assert.equal(f.sourceLine, 2);
  });

  it('sorts by tier: CRITICAL first, then HIGH, then MEDIUM', () => {
    const sourceFiles = [
      {
        filePath: 'src/api.js',
        content: `
          const { name, email, ssn } = req.body;
          console.log(name, email, ssn);
        `,
      },
    ];
    const { flows } = tracePiiFlows(sourceFiles);
    if (flows.length >= 2) {
      const tiers = flows.map((f) => f.tier);
      const order = { CRITICAL: 0, HIGH: 1, MEDIUM: 2 };
      for (let i = 1; i < tiers.length; i++) {
        assert.ok(order[tiers[i]] >= order[tiers[i - 1]]);
      }
    }
  });

  it('populates riskCounts correctly', () => {
    const sourceFiles = [
      {
        filePath: 'src/api.js',
        content: `
          const { email, ssn } = req.body;
          console.log(email, ssn);
          await prisma.user.create({ data: { email, ssn } });
        `,
      },
    ];
    const { riskCounts } = tracePiiFlows(sourceFiles);
    assert.ok(riskCounts.CRITICAL >= 1); // ssn
    assert.ok(riskCounts.HIGH >= 1);     // email
  });

  it('skips files larger than MAX_FILE_BYTES', () => {
    const bigContent = 'x'.repeat(200 * 1024); // 200KB
    const sourceFiles = [{ filePath: 'big.js', content: bigContent }];
    const { flows } = tracePiiFlows(sourceFiles);
    assert.equal(flows.length, 0);
  });

  it('caps at MAX_FILES_PER_RUN files', () => {
    // All files contain email + console.log but we have more than MAX
    const manyFiles = Array.from({ length: MAX_FILES_PER_RUN + 10 }, (_, i) => ({
      filePath: `src/file${i}.js`,
      content: 'const email = req.body.email; console.log(email);',
    }));
    const { flows } = tracePiiFlows(manyFiles);
    // Should only have processed MAX_FILES_PER_RUN files worth of flows
    const uniqueFiles = new Set(flows.map((f) => f.filePath));
    assert.ok(uniqueFiles.size <= MAX_FILES_PER_RUN);
  });

  it('sets hasExternalSource true when req.body is present', () => {
    const sourceFiles = [
      {
        filePath: 'src/api.js',
        content: 'const { email } = req.body; console.log(email);',
      },
    ];
    const { flows } = tracePiiFlows(sourceFiles);
    const f = flows.find((f) => f.field === 'email');
    assert.ok(f);
    assert.ok(f.hasExternalSource);
  });

  it('produces a non-empty summary string', () => {
    const sourceFiles = [
      {
        filePath: 'src/api.js',
        content: 'const { email } = req.body; console.log(email);',
      },
    ];
    const { summary } = tracePiiFlows(sourceFiles);
    assert.ok(typeof summary === 'string');
    assert.ok(summary.length > 0);
  });

  it('returns "No PII field flows detected" summary for empty results', () => {
    const { summary } = tracePiiFlows([]);
    assert.ok(summary.includes('No PII'));
  });
});

// ─── buildNarrativePrompt ────────────────────────────────────────────────────

describe('buildNarrativePrompt', () => {
  const flows = [
    {
      field: 'ssn',
      tier: 'CRITICAL',
      filePath: 'src/api/verify.js',
      sinks: [{ type: 'log' }, { type: 'externalApi' }],
    },
    {
      field: 'email',
      tier: 'HIGH',
      filePath: 'src/api/signup.js',
      sinks: [{ type: 'database' }],
    },
  ];

  it('returns a non-empty string', () => {
    const prompt = buildNarrativePrompt(flows);
    assert.ok(typeof prompt === 'string' && prompt.length > 0);
  });

  it('mentions GDPR', () => {
    const prompt = buildNarrativePrompt(flows);
    assert.ok(prompt.includes('GDPR'));
  });

  it('includes field names from flows', () => {
    const prompt = buildNarrativePrompt(flows);
    assert.ok(prompt.includes('ssn') || prompt.includes('email'));
  });

  it('caps at MAX_FINDINGS_FOR_NARRATIVE flows', () => {
    const manyFlows = Array.from({ length: MAX_FINDINGS_FOR_NARRATIVE + 5 }, (_, i) => ({
      field: `field${i}`,
      tier: 'HIGH',
      filePath: `src/file${i}.js`,
      sinks: [{ type: 'log' }],
    }));
    const prompt = buildNarrativePrompt(manyFlows);
    // Should not include field names beyond the cap
    assert.ok(!prompt.includes(`field${MAX_FINDINGS_FOR_NARRATIVE + 1}`));
  });
});

// ─── renderReport ────────────────────────────────────────────────────────────

describe('renderReport', () => {
  const sampleFlows = [
    {
      field: 'email',
      tier: 'HIGH',
      filePath: 'src/api/signup.js',
      sourceLine: 5,
      sinks: [{ type: 'log', lines: [10] }, { type: 'database', lines: [15] }],
    },
    {
      field: 'ssn',
      tier: 'CRITICAL',
      filePath: 'src/api/verify.js',
      sourceLine: 3,
      sinks: [{ type: 'externalApi', lines: [8] }],
    },
  ];

  const sampleCounts = { CRITICAL: 1, HIGH: 1, MEDIUM: 0 };

  it('includes the hostName in the title', () => {
    const md = renderReport({ hostName: 'acme.com', flows: sampleFlows, riskCounts: sampleCounts });
    assert.ok(md.includes('acme.com'));
  });

  it('includes risk overview table', () => {
    const md = renderReport({ flows: sampleFlows, riskCounts: sampleCounts });
    assert.ok(md.includes('Risk Overview'));
    assert.ok(md.includes('CRITICAL'));
    assert.ok(md.includes('HIGH'));
  });

  it('includes PII Flow Map section', () => {
    const md = renderReport({ flows: sampleFlows, riskCounts: sampleCounts });
    assert.ok(md.includes('PII Flow Map'));
  });

  it('includes remediation guidance', () => {
    const md = renderReport({ flows: sampleFlows, riskCounts: sampleCounts });
    assert.ok(md.includes('Remediation'));
  });

  it('includes narrative when provided', () => {
    const md = renderReport({
      flows: sampleFlows,
      riskCounts: sampleCounts,
      narrative: 'This codebase has significant PII exposure.',
    });
    assert.ok(md.includes('Executive Summary'));
    assert.ok(md.includes('significant PII exposure'));
  });

  it('omits Executive Summary section when no narrative', () => {
    const md = renderReport({ flows: sampleFlows, riskCounts: sampleCounts });
    assert.ok(!md.includes('Executive Summary'));
  });

  it('renders "No PII field flows detected" for empty flows', () => {
    const md = renderReport({ flows: [], riskCounts: { CRITICAL: 0, HIGH: 0, MEDIUM: 0 } });
    assert.ok(md.includes('No PII field flows detected'));
  });

  it('groups fields by tier with emoji headers', () => {
    const md = renderReport({ flows: sampleFlows, riskCounts: sampleCounts });
    assert.ok(md.includes('🔴'));
    assert.ok(md.includes('🟠'));
  });

  it('includes scanDate in header', () => {
    const md = renderReport({
      flows: sampleFlows,
      riskCounts: sampleCounts,
      scanDate: '2026-05-06',
    });
    assert.ok(md.includes('2026-05-06'));
  });

  it('defaults scanDate to today when not provided', () => {
    const md = renderReport({ flows: [], riskCounts: { CRITICAL: 0, HIGH: 0, MEDIUM: 0 } });
    const today = new Date().toISOString().split('T')[0];
    assert.ok(md.includes(today));
  });
});

// ─── generatePiiFlowReport ───────────────────────────────────────────────────

describe('generatePiiFlowReport', () => {
  it('returns markdown, flows, riskCounts, summary', async () => {
    const result = await generatePiiFlowReport({
      sourceFiles: [
        {
          filePath: 'src/api.js',
          content: 'const { email } = req.body; console.log(email);',
        },
      ],
    });
    assert.ok(typeof result.markdown === 'string');
    assert.ok(Array.isArray(result.flows));
    assert.ok(typeof result.riskCounts === 'object');
    assert.ok(typeof result.summary === 'string');
  });

  it('works with no sourceFiles', async () => {
    const result = await generatePiiFlowReport({});
    assert.equal(result.flows.length, 0);
    assert.ok(result.markdown.includes('No PII'));
  });

  it('calls askClaude when provided and flows exist', async () => {
    let called = false;
    const askClaude = async () => { called = true; return 'narrative text'; };
    const result = await generatePiiFlowReport({
      sourceFiles: [
        {
          filePath: 'src/api.js',
          content: 'const { email } = req.body; console.log(email);',
        },
      ],
      askClaude,
    });
    assert.ok(called);
    assert.equal(result.narrative, 'narrative text');
    assert.ok(result.markdown.includes('narrative text'));
  });

  it('does not call askClaude when flows are empty', async () => {
    let called = false;
    const askClaude = async () => { called = true; return 'narrative'; };
    await generatePiiFlowReport({ sourceFiles: [], askClaude });
    assert.ok(!called);
  });

  it('survives askClaude throwing', async () => {
    const askClaude = async () => { throw new Error('API down'); };
    const result = await generatePiiFlowReport({
      sourceFiles: [
        {
          filePath: 'src/api.js',
          content: 'const { email } = req.body; console.log(email);',
        },
      ],
      askClaude,
    });
    assert.ok(result.markdown); // report still generated
    assert.equal(result.narrative, null);
  });

  it('includes hostName in generated markdown', async () => {
    const result = await generatePiiFlowReport({
      hostName: 'myapp.io',
      sourceFiles: [],
    });
    assert.ok(result.markdown.includes('myapp.io'));
  });
});
