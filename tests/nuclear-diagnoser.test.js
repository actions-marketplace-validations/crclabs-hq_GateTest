// ============================================================================
// NUCLEAR-DIAGNOSER TEST — Phase 3.1 of THE FIX-FIRST BUILD PLAN
// ============================================================================
// Covers website/app/lib/nuclear-diagnoser.js — the engine that replaces
// the old category-matched shell-command templates in
// website/app/api/scan/server-fix/route.ts. Each finding now gets a
// reasoned, evidence-tied diagnosis from Claude instead of a generic
// snippet.
// ============================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  diagnoseFinding,
  diagnoseFindings,
  renderDiagnosis,
  renderDiagnosesReport,
  buildDiagnosisPrompt,
  parseDiagnosisOutput,
} = require('../website/app/lib/nuclear-diagnoser.js');

const validResponse = `EXPLANATION: Without HSTS, a man-in-the-middle on a hotel WiFi can downgrade your visitor's connection to plain HTTP and silently capture session cookies on the first hit before redirect. Once seen on HTTPS, browsers will refuse the downgrade for the policy's lifetime.
ROOT_CAUSE: The Strict-Transport-Security response header is absent from this origin's responses entirely.
RECOMMENDATION: Add a long-lived HSTS header to every HTTPS response. A 2-year max-age with includeSubDomains and preload is standard. After verifying the header is being served correctly, submit the domain to hstspreload.org so browsers ship the policy by default.
PLATFORM_NOTES:
Vercel: add to vercel.json under headers
Nginx: add_header Strict-Transport-Security in the server block`;

const okFinding = {
  detail: 'Missing HSTS header on HTTPS response',
  module: 'webHeaders',
  severity: 'error',
};

// ---------- buildDiagnosisPrompt ----------

test('buildDiagnosisPrompt — includes finding detail, module, severity', () => {
  const p = buildDiagnosisPrompt({ finding: okFinding, hostname: 'example.com' });
  assert.match(p, /example\.com/);
  assert.match(p, /webHeaders/);
  assert.match(p, /error/);
  assert.match(p, /Missing HSTS header/);
});

test('buildDiagnosisPrompt — includes platform when known, hint when not', () => {
  const known = buildDiagnosisPrompt({ finding: okFinding, hostname: 'x', scanContext: { platform: 'Vercel' } });
  assert.match(known, /KNOWN PLATFORM:/);
  assert.match(known, /Vercel/);

  const unknown = buildDiagnosisPrompt({ finding: okFinding, hostname: 'x' });
  assert.match(unknown, /not detected/);
});

test('buildDiagnosisPrompt — includes stack signals when present', () => {
  const p = buildDiagnosisPrompt({ finding: okFinding, hostname: 'x', scanContext: { stack: ['nextjs', 'tailwind'] } });
  assert.match(p, /nextjs, tailwind/);
});

test('buildDiagnosisPrompt — explicit instruction not to emit category templates', () => {
  const p = buildDiagnosisPrompt({ finding: okFinding, hostname: 'x' });
  assert.match(p, /Do NOT emit category-matched/);
  assert.match(p, /\$399/);
});

test('buildDiagnosisPrompt — output schema documented', () => {
  const p = buildDiagnosisPrompt({ finding: okFinding, hostname: 'x' });
  assert.match(p, /EXPLANATION:/);
  assert.match(p, /ROOT_CAUSE:/);
  assert.match(p, /RECOMMENDATION:/);
  assert.match(p, /PLATFORM_NOTES:/);
  assert.match(p, /^SKIP:/m);
});

// ---------- parseDiagnosisOutput ----------

test('parseDiagnosisOutput — happy path', () => {
  const r = parseDiagnosisOutput(validResponse);
  assert.equal(r.ok, true);
  assert.match(r.diagnosis.explanation, /Without HSTS/);
  assert.match(r.diagnosis.rootCause, /Strict-Transport-Security/);
  assert.match(r.diagnosis.recommendation, /long-lived HSTS/);
  assert.equal(r.diagnosis.platformNotes['Vercel'], 'add to vercel.json under headers');
  assert.equal(r.diagnosis.platformNotes['Nginx'], 'add_header Strict-Transport-Security in the server block');
});

test('parseDiagnosisOutput — SKIP marker', () => {
  const r = parseDiagnosisOutput('SKIP: finding detail too vague');
  assert.equal(r.ok, false);
  assert.match(r.reason, /declined/);
});

test('parseDiagnosisOutput — refusal recognised', () => {
  const r = parseDiagnosisOutput("I cannot diagnose this finding.");
  assert.equal(r.ok, false);
  assert.match(r.reason, /refused/);
});

test('parseDiagnosisOutput — empty / non-string', () => {
  assert.equal(parseDiagnosisOutput('').ok, false);
  assert.equal(parseDiagnosisOutput(null).ok, false);
  assert.equal(parseDiagnosisOutput(42).ok, false);
});

test('parseDiagnosisOutput — missing required section', () => {
  const noRoot = `EXPLANATION: x.\nRECOMMENDATION: do the thing in the way that fixes it for sure across stacks.`;
  const r = parseDiagnosisOutput(noRoot);
  assert.equal(r.ok, false);
  assert.match(r.reason, /missing required section.*ROOT_CAUSE/);
});

test('parseDiagnosisOutput — recommendation too short', () => {
  const tiny = `EXPLANATION: thing.\nROOT_CAUSE: cause.\nRECOMMENDATION: ok`;
  const r = parseDiagnosisOutput(tiny);
  assert.equal(r.ok, false);
  assert.match(r.reason, /too short/);
});

test('parseDiagnosisOutput — platform notes optional', () => {
  const noPlatforms = `EXPLANATION: matters because reasons that take more than a few words.\nROOT_CAUSE: the cause.\nRECOMMENDATION: do this thing in this way to address the underlying issue.`;
  const r = parseDiagnosisOutput(noPlatforms);
  assert.equal(r.ok, true);
  assert.deepEqual(r.diagnosis.platformNotes, {});
});

test('parseDiagnosisOutput — platform notes em-dash separator parsed', () => {
  const withEmDash = `EXPLANATION: matters because reasons that take more than a few words.\nROOT_CAUSE: the cause.\nRECOMMENDATION: do this thing in this way to address the underlying issue.\nPLATFORM_NOTES:\nNetlify — _headers file at publish dir`;
  const r = parseDiagnosisOutput(withEmDash);
  assert.equal(r.ok, true);
  assert.equal(r.diagnosis.platformNotes['Netlify'], '_headers file at publish dir');
});

// ---------- diagnoseFinding ----------

test('diagnoseFinding — happy path', async () => {
  const r = await diagnoseFinding({
    finding: okFinding,
    hostname: 'example.com',
    askClaudeForDiagnosis: async () => validResponse,
  });
  assert.equal(r.ok, true);
  assert.match(r.diagnosis.explanation, /Without HSTS/);
  assert.equal(r.finding, okFinding);
});

test('diagnoseFinding — Claude API error captured', async () => {
  const r = await diagnoseFinding({
    finding: okFinding,
    hostname: 'x',
    askClaudeForDiagnosis: async () => { throw new Error('ECONNRESET'); },
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /Claude API error: ECONNRESET/);
});

test('diagnoseFinding — malformed finding', async () => {
  const r = await diagnoseFinding({
    finding: null,
    askClaudeForDiagnosis: async () => validResponse,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /malformed/);
});

test('diagnoseFinding — finding too short', async () => {
  const r = await diagnoseFinding({
    finding: { detail: 'x' },
    askClaudeForDiagnosis: async () => validResponse,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /too short/);
});

test('diagnoseFinding — input validation throws on missing askClaudeForDiagnosis', async () => {
  await assert.rejects(
    () => diagnoseFinding({ finding: okFinding }),
    /askClaudeForDiagnosis must be a function/
  );
});

// ---------- diagnoseFindings (batch) ----------

test('diagnoseFindings — batch with mixed outcomes', async () => {
  const findings = [
    okFinding,
    { detail: 'x', module: 'm' }, // skipped (too short — under 5 chars)
    { detail: 'Missing CSP — frame-ancestors not set', module: 'webHeaders' },
  ];
  const r = await diagnoseFindings({
    findings,
    hostname: 'example.com',
    askClaudeForDiagnosis: async () => validResponse,
  });
  assert.equal(r.diagnoses.length, 3);
  const ok = r.diagnoses.filter((d) => d.ok);
  const failed = r.diagnoses.filter((d) => !d.ok);
  assert.equal(ok.length, 2);
  assert.equal(failed.length, 1);
  assert.match(r.summary, /2 diagnosed/);
  assert.match(r.summary, /1 skipped/);
});

test('diagnoseFindings — caps at maxFindings, records overflow', async () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ detail: `Finding number ${i}: missing thing`, module: 'm' }));
  const r = await diagnoseFindings({
    findings: many,
    hostname: 'x',
    askClaudeForDiagnosis: async () => validResponse,
    maxFindings: 5,
  });
  assert.equal(r.diagnoses.length, 5);
  assert.match(r.summary, /45 additional findings deferred/);
});

test('diagnoseFindings — empty findings', async () => {
  const r = await diagnoseFindings({
    findings: [],
    askClaudeForDiagnosis: async () => validResponse,
  });
  assert.equal(r.diagnoses.length, 0);
  assert.match(r.summary, /0 diagnosed/);
});

test('diagnoseFindings — Claude failure on one does not abort batch', async () => {
  let calls = 0;
  const findings = [
    okFinding,
    { detail: 'Missing CSP frame-ancestors', module: 'webHeaders' },
    { detail: 'No DMARC record', module: 'dns' },
  ];
  const r = await diagnoseFindings({
    findings,
    hostname: 'x',
    askClaudeForDiagnosis: async () => {
      calls++;
      if (calls === 2) throw new Error('transient');
      return validResponse;
    },
  });
  const ok = r.diagnoses.filter((d) => d.ok);
  const failed = r.diagnoses.filter((d) => !d.ok);
  assert.equal(ok.length, 2);
  assert.equal(failed.length, 1);
});

test('diagnoseFindings — input validation', async () => {
  await assert.rejects(
    () => diagnoseFindings({ findings: 'no', askClaudeForDiagnosis: async () => '' }),
    /findings must be an array/
  );
  await assert.rejects(
    () => diagnoseFindings({ findings: [] }),
    /askClaudeForDiagnosis must be a function/
  );
});

// ---------- renderDiagnosis ----------

test('renderDiagnosis — happy markdown', () => {
  const r = {
    finding: okFinding,
    ok: true,
    diagnosis: {
      explanation: 'Why it matters.',
      rootCause: 'What is broken.',
      recommendation: 'Do these specific things.',
      platformNotes: { Vercel: 'use vercel.json' },
    },
  };
  const md = renderDiagnosis(r);
  assert.match(md, /Missing HSTS header/);
  assert.match(md, /webHeaders/);
  assert.match(md, /\*\*Why this matters\.\*\* Why it matters\./);
  assert.match(md, /\*\*Root cause\.\*\* What is broken\./);
  assert.match(md, /\*\*Recommendation\.\*\* Do these specific things\./);
  assert.match(md, /Vercel/);
  assert.match(md, /use vercel\.json/);
});

test('renderDiagnosis — failure renders friendly placeholder', () => {
  const md = renderDiagnosis({ finding: okFinding, ok: false, reason: 'Claude API error' });
  assert.match(md, /Missing HSTS header/);
  assert.match(md, /Diagnosis not generated/);
  assert.match(md, /Claude API error/);
});

test('renderDiagnosis — null result handled', () => {
  const md = renderDiagnosis(null);
  assert.match(md, /unknown finding/);
});

// ---------- renderDiagnosesReport ----------

test('renderDiagnosesReport — full report with mixed results', () => {
  const ds = [
    { finding: okFinding, ok: true, diagnosis: { explanation: 'a', rootCause: 'b', recommendation: 'c', platformNotes: {} } },
    { finding: { detail: 'No DMARC' }, ok: false, reason: 'too vague' },
  ];
  const out = renderDiagnosesReport(ds, 'Nuclear diagnoser: 1 diagnosed, 1 skipped');
  assert.match(out, /Nuclear Diagnosis Report/);
  assert.match(out, /Each finding below was diagnosed individually/);
  assert.match(out, /1 diagnosed, 1 skipped/);
  assert.match(out, /Missing HSTS/);
  assert.match(out, /No DMARC/);
  assert.match(out, /\$399/);
});

test('renderDiagnosesReport — all-skipped flag', () => {
  const ds = [
    { finding: { detail: 'a thing' }, ok: false, reason: 'too vague' },
    { finding: { detail: 'b thing' }, ok: false, reason: 'too vague' },
  ];
  const out = renderDiagnosesReport(ds, 'Nuclear diagnoser: 0 diagnosed, 2 skipped');
  assert.match(out, /No diagnoses succeeded this run/);
});

test('renderDiagnosesReport — empty diagnoses', () => {
  const out = renderDiagnosesReport([], 'Nuclear diagnoser: 0 diagnosed, 0 skipped');
  assert.match(out, /Nuclear Diagnosis Report/);
  assert.match(out, /0 diagnosed/);
});
