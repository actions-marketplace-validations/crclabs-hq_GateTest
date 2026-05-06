'use strict';

/**
 * Phase 6.2.15 — PII flow tracer.
 *
 * "This email field flows from /api/signup to logs/loki/grafana"
 *
 * Static taint analysis focused on Personally Identifiable Information.
 * Traces PII field names from entry points (request bodies, form inputs,
 * env vars) through the codebase to sinks (logs, external APIs, files,
 * databases). Produces a board-readable data-flow map suitable for
 * GDPR Article 30 Records of Processing Activities (RoPA) documentation.
 *
 * DESIGN:
 *   1. Identify PII field names in source files (email, phone, ssn, etc.)
 *   2. Classify each field by sensitivity tier (CRITICAL / HIGH / MEDIUM)
 *   3. For each file containing a PII field, detect which sinks it reaches
 *      in that file: logs, HTTP calls, file writes, DB writes, responses
 *   4. Build flow chains: { field, tier, sourceFile, sinks[] }
 *   5. Ask Claude (optional) to narrate the most risky chains
 *   6. Return structured report + rendered Markdown
 *
 * MAX_FILES_PER_RUN caps processing so Nuclear scans stay fast.
 */

const MAX_FILES_PER_RUN = 50;
const MAX_FILE_BYTES = 100 * 1024; // 100 KB
const MAX_FINDINGS_FOR_NARRATIVE = 10;

// ─── PII field registry ───────────────────────────────────────────────────────

const PII_FIELDS = {
  CRITICAL: [
    'ssn', 'socialSecurityNumber', 'social_security_number',
    'creditCard', 'credit_card', 'cardNumber', 'card_number',
    'cvv', 'cvc', 'pan', 'bankAccount', 'bank_account',
    'passport', 'passportNumber', 'passport_number',
    'driversLicense', 'drivers_license', 'licenseNumber',
    'biometric', 'fingerprint', 'faceData', 'face_data',
    'healthData', 'medical', 'diagnosis', 'prescription',
    'taxId', 'tax_id', 'ein', 'nationalId', 'national_id',
  ],
  HIGH: [
    'email', 'emailAddress', 'email_address',
    'phone', 'phoneNumber', 'phone_number', 'mobile', 'cell',
    'password', 'passwd', 'pwd', 'secret', 'token',
    'dateOfBirth', 'date_of_birth', 'dob', 'birthDate', 'birth_date',
    'address', 'streetAddress', 'street_address', 'postalCode', 'postal_code',
    'zipCode', 'zip_code', 'city', 'state', 'country',
    'ipAddress', 'ip_address', 'ipAddr',
    'deviceId', 'device_id', 'userId', 'user_id', 'accountId', 'account_id',
    'firstName', 'first_name', 'lastName', 'last_name', 'fullName', 'full_name',
    'username', 'handle',
  ],
  MEDIUM: [
    'name', 'displayName', 'display_name',
    'age', 'gender', 'nationality',
    'occupation', 'employer', 'company',
    'salary', 'income', 'wage',
    'location', 'geoLocation', 'geo_location', 'lat', 'lng', 'latitude', 'longitude',
    'browserFingerprint', 'browser_fingerprint', 'userAgent', 'user_agent',
    'sessionId', 'session_id', 'cookieId', 'cookie_id',
    'referrer', 'searchQuery', 'search_query',
  ],
};

// Flat lookup: field name → tier
const FIELD_TIER_MAP = {};
for (const [tier, fields] of Object.entries(PII_FIELDS)) {
  for (const f of fields) {
    FIELD_TIER_MAP[f.toLowerCase()] = tier;
  }
}

// ─── Sink detectors ───────────────────────────────────────────────────────────

const SINK_PATTERNS = {
  log: [
    /console\s*\.\s*(?:log|debug|info|warn|error)\s*\(/,
    /logger\s*\.\s*(?:log|debug|info|warn|error|trace)\s*\(/,
    /log\s*\.\s*(?:log|debug|info|warn|error|trace)\s*\(/,
    /winston\s*\.\s*(?:log|debug|info|warn|error)\s*\(/,
    /pino\s*\.\s*(?:log|debug|info|warn|error)\s*\(/,
    /bunyan\s*\.\s*(?:log|debug|info|warn|error)\s*\(/,
  ],
  externalApi: [
    /fetch\s*\(/,
    /axios\s*\.\s*(?:get|post|put|patch|delete|request)\s*\(/,
    /https?\s*\.\s*request\s*\(/,
    /got\s*\s*\(/,
    /superagent\s*\./,
    /request\s*\(/,
  ],
  database: [
    /prisma\s*\.\s*\w+\s*\.\s*(?:create|update|upsert|insert)\s*\(/,
    /db\s*\.\s*(?:query|execute|run|insert|update)\s*\(/,
    /pool\s*\.\s*(?:query|execute)\s*\(/,
    /client\s*\.\s*(?:query|execute)\s*\(/,
    /\.save\s*\(/,
    /\.insert\s*\(/,
    /\.create\s*\(/,
    /Model\s*\.\s*create\s*\(/,
    /sequelize\s*\.\s*query\s*\(/,
  ],
  fileWrite: [
    /fs\s*\.\s*(?:writeFile|appendFile|writeFileSync|appendFileSync)\s*\(/,
    /fs\s*\.promises\s*\.\s*(?:writeFile|appendFile)\s*\(/,
    /createWriteStream\s*\(/,
  ],
  response: [
    /res\s*\.\s*(?:json|send|end)\s*\(/,
    /response\s*\.\s*(?:json|send|end)\s*\(/,
    /NextResponse\s*\.\s*json\s*\(/,
    /return\s+(?:json|Response)\s*\(/,
  ],
  thirdParty: [
    /sendgrid|mailgun|ses|smtp|nodemailer/i,
    /twilio|vonage|nexmo|messagebird/i,
    /segment|mixpanel|amplitude|heap|datadog/i,
    /stripe\s*\.\s*\w+/i,
    /sentry\s*\.\s*captureException/i,
    /slack|discord|teams/i,
  ],
};

// ─── Source detectors (where PII enters) ─────────────────────────────────────

const SOURCE_PATTERNS = [
  /req\s*\.\s*body/,
  /req\s*\.\s*query/,
  /req\s*\.\s*params/,
  /request\s*\.\s*body/,
  /event\s*\.\s*body/,
  /formData/,
  /getFieldValue/,
  /useState\s*\(/,
  /process\s*\.\s*env/,
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildFieldRegex(fieldName) {
  // Matches: fieldName, obj.fieldName, obj["fieldName"], obj?.fieldName,
  //          fieldName:, "fieldName", 'fieldName'
  const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `(?:^|[^\\w])(?:${escaped})(?:[^\\w]|$)`,
    'i',
  );
}

function detectSinks(content) {
  const found = [];
  for (const [sink, patterns] of Object.entries(SINK_PATTERNS)) {
    if (patterns.some((p) => p.test(content))) {
      found.push(sink);
    }
  }
  return found;
}

function detectSources(content) {
  return SOURCE_PATTERNS.some((p) => p.test(content));
}

function getFileSinkLines(lines, sinkType) {
  const patterns = SINK_PATTERNS[sinkType] || [];
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    if (patterns.some((p) => p.test(lines[i]))) {
      hits.push(i + 1);
    }
  }
  return hits.slice(0, 3); // first 3 occurrences
}

// ─── Main tracer ──────────────────────────────────────────────────────────────

/**
 * Trace PII field flows across source files.
 *
 * @param {Array<{filePath: string, content: string}>} sourceFiles
 * @returns {{ flows, summary, riskCounts }}
 */
function tracePiiFlows(sourceFiles) {
  const flows = [];
  const seenFields = new Set();

  const candidates = sourceFiles.filter(
    ({ content }) => content && content.length <= MAX_FILE_BYTES,
  ).slice(0, MAX_FILES_PER_RUN);

  for (const { filePath, content } of candidates) {
    const lines = content.split('\n');
    const lowerContent = content.toLowerCase();
    const hasSources = detectSources(content);
    const sinks = detectSinks(content);

    if (sinks.length === 0) continue; // no sinks — nothing flows anywhere

    for (const [fieldName, tier] of Object.entries(FIELD_TIER_MAP)) {
      const regex = buildFieldRegex(fieldName);
      if (!regex.test(lowerContent)) continue;

      const key = `${filePath}:${fieldName}`;
      if (seenFields.has(key)) continue;
      seenFields.add(key);

      // Find first line where the field appears
      let sourceLine = null;
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i].toLowerCase())) {
          sourceLine = i + 1;
          break;
        }
      }

      // Collect sink lines
      const sinkDetails = sinks.map((sink) => ({
        type: sink,
        lines: getFileSinkLines(lines, sink),
      }));

      flows.push({
        field: fieldName,
        tier,
        filePath,
        sourceLine,
        hasExternalSource: hasSources,
        sinks: sinkDetails,
      });
    }
  }

  // Sort by tier severity then field name
  const TIER_ORDER = { CRITICAL: 0, HIGH: 1, MEDIUM: 2 };
  flows.sort((a, b) => {
    const td = TIER_ORDER[a.tier] - TIER_ORDER[b.tier];
    return td !== 0 ? td : a.field.localeCompare(b.field);
  });

  const riskCounts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0 };
  for (const f of flows) riskCounts[f.tier]++;

  const summary = flows.length === 0
    ? 'No PII field flows detected.'
    : `Detected ${flows.length} PII field flow(s): ${riskCounts.CRITICAL} critical, ${riskCounts.HIGH} high, ${riskCounts.MEDIUM} medium sensitivity.`;

  return { flows, summary, riskCounts };
}

// ─── Claude narrative ─────────────────────────────────────────────────────────

function buildNarrativePrompt(flows) {
  const top = flows.slice(0, MAX_FINDINGS_FOR_NARRATIVE);
  const lines = top.map((f) =>
    `- [${f.tier}] \`${f.field}\` in \`${f.filePath}\` → sinks: ${f.sinks.map((s) => s.type).join(', ')}`,
  );

  return `You are a privacy engineer writing a board-level summary of PII data flows found in a codebase.

PII FLOWS DETECTED:
${lines.join('\n')}

Write a concise (4-6 sentence) executive paragraph that:
1. States the overall privacy posture
2. Highlights the highest-risk flows (CRITICAL tier first)
3. Names specific sinks that pose regulatory risk (logging PII = GDPR Article 5, external APIs = data transfer obligations)
4. Ends with one prioritised remediation action

Output ONLY the paragraph. No headers. No bullet points. No markdown.`;
}

// ─── Report renderer ──────────────────────────────────────────────────────────

const SINK_LABELS = {
  log: 'Application logs',
  externalApi: 'External HTTP API',
  database: 'Database write',
  fileWrite: 'File system write',
  response: 'HTTP response',
  thirdParty: 'Third-party service',
};

const TIER_EMOJI = { CRITICAL: '🔴', HIGH: '🟠', MEDIUM: '🟡' };

function renderReport({ hostName, scanDate, flows, riskCounts, narrative }) {
  const date = scanDate || new Date().toISOString().split('T')[0];
  const lines = [];

  lines.push(`# PII Data Flow Report — ${hostName || 'Repository'}`);
  lines.push(`**Scan date:** ${date}  `);
  lines.push(`**Flows detected:** ${flows.length} (${riskCounts.CRITICAL} critical · ${riskCounts.HIGH} high · ${riskCounts.MEDIUM} medium)`);
  lines.push('');

  if (narrative) {
    lines.push('## Executive Summary');
    lines.push('');
    lines.push(`> ${narrative}`);
    lines.push('');
  }

  lines.push('## Risk Overview');
  lines.push('');
  lines.push('| Tier | Count | Regulatory Risk |');
  lines.push('|------|-------|----------------|');
  lines.push(`| 🔴 Critical | ${riskCounts.CRITICAL} | GDPR Art. 9, PCI-DSS, HIPAA |`);
  lines.push(`| 🟠 High | ${riskCounts.HIGH} | GDPR Art. 5/6, CCPA |`);
  lines.push(`| 🟡 Medium | ${riskCounts.MEDIUM} | GDPR Art. 5 (data minimisation) |`);
  lines.push('');

  if (flows.length === 0) {
    lines.push('_No PII field flows detected in scanned files._');
    return lines.join('\n');
  }

  lines.push('## PII Flow Map');
  lines.push('');

  // Group by tier
  for (const tier of ['CRITICAL', 'HIGH', 'MEDIUM']) {
    const tierFlows = flows.filter((f) => f.tier === tier);
    if (tierFlows.length === 0) continue;

    lines.push(`### ${TIER_EMOJI[tier]} ${tier} Sensitivity Fields`);
    lines.push('');
    lines.push('| Field | File | Line | Sinks |');
    lines.push('|-------|------|------|-------|');

    for (const f of tierFlows) {
      const sinkLabels = f.sinks
        .map((s) => SINK_LABELS[s.type] || s.type)
        .join(', ');
      const shortPath = f.filePath.replace(/^.*\/(src|app|website)\//, '$1/');
      lines.push(`| \`${f.field}\` | \`${shortPath}\` | ${f.sourceLine || '?'} | ${sinkLabels} |`);
    }
    lines.push('');
  }

  lines.push('## Remediation Guidance');
  lines.push('');
  lines.push('| Sink Type | Action Required |');
  lines.push('|-----------|----------------|');
  lines.push('| Application logs | Remove PII from log statements; use structured logging with field masking |');
  lines.push('| External HTTP API | Document data transfer in RoPA; add DPA with vendor; encrypt in transit |');
  lines.push('| Database write | Ensure field-level encryption for CRITICAL tier; document retention policy |');
  lines.push('| File system write | Encrypt at rest; add access controls; document retention |');
  lines.push('| HTTP response | Ensure HTTPS only; audit what PII clients receive; apply data minimisation |');
  lines.push('| Third-party service | Review vendor DPA; check adequacy decisions for cross-border transfers |');
  lines.push('');

  lines.push('---');
  lines.push('*Generated by GateTest Nuclear — PII Flow Tracer (Phase 6.2.15)*');

  return lines.join('\n');
}

// ─── Main entry ───────────────────────────────────────────────────────────────

/**
 * Trace PII flows and generate a report.
 *
 * @param {Object} opts
 * @param {Array<{filePath: string, content: string}>} opts.sourceFiles
 * @param {string}   [opts.hostName]
 * @param {string}   [opts.scanDate]
 * @param {Function} [opts.askClaude]  async (prompt) => string  (optional)
 * @returns {Promise<{ markdown, flows, riskCounts, summary, narrative }>}
 */
async function generatePiiFlowReport({ sourceFiles = [], hostName, scanDate, askClaude } = {}) {
  const { flows, summary, riskCounts } = tracePiiFlows(sourceFiles);

  let narrative = null;
  if (askClaude && flows.length > 0) {
    try {
      const prompt = buildNarrativePrompt(flows);
      narrative = await askClaude(prompt);
      if (narrative) narrative = narrative.trim();
    } catch {
      // Non-blocking — report ships without narrative
    }
  }

  const markdown = renderReport({ hostName, scanDate, flows, riskCounts, narrative });

  return { markdown, flows, riskCounts, summary, narrative };
}

module.exports = {
  generatePiiFlowReport,
  tracePiiFlows,
  buildNarrativePrompt,
  renderReport,
  detectSinks,
  detectSources,
  PII_FIELDS,
  FIELD_TIER_MAP,
  SINK_PATTERNS,
  MAX_FILES_PER_RUN,
  MAX_FINDINGS_FOR_NARRATIVE,
};
