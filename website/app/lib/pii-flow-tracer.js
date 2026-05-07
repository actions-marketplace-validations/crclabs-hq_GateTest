/**
 * Phase 6.2.15 — Live PII flow tracer.
 *
 * Tracks how personally-identifiable data fields flow through the codebase
 * and flags when they reach high-risk sinks: logs, analytics calls, external
 * HTTP endpoints, database writes without encryption markers, response bodies.
 *
 * Example: "req.body.email → logger.info(req.body) → Slack webhook"
 *          "user.ssn → console.log at line 42 → hits prod logs"
 *
 * Design:
 *   - Single-pass per file: parse imports, identify PII source assignments,
 *     track variable aliases, flag sink calls.
 *   - No AST dependency — regex-based with a variable-binding tracker.
 *   - Pure function: (files: {path, content}[]) → findings[]
 *   - Composable: output can be fed into the nuclear diagnoser for richer
 *     fix recommendations.
 *
 * PII source patterns (fields known to carry personal data):
 *   email, password, passwd, ssn, dob, dateOfBirth, phone, phoneNumber,
 *   firstName, lastName, fullName, address, zipCode, postCode, creditCard,
 *   cardNumber, cvv, cvc, pin, bankAccount, routingNumber, passport,
 *   nationalId, taxId, ipAddress, userAgent, location, latitude, longitude
 *
 * High-risk sinks:
 *   - Logging: console.log/debug/info/warn/error, logger.*, log.*, pino,
 *     winston, bunyan, structlog (Python)
 *   - Analytics: mixpanel.track, analytics.track, segment.track, amplitude,
 *     posthog.capture, heap.track, gtag, ga(), datadog.track, newrelic
 *   - External HTTP: fetch(), axios.*, got.*, http.request, requests.post/get
 *   - Unencrypted DB write: INSERT/UPDATE without encryption comment markers
 */

'use strict';

// ---------------------------------------------------------------------------
// PII field names — conservative set to avoid FP but covering the high-risk
// fields every compliance framework asks about.
// ---------------------------------------------------------------------------
const PII_FIELDS = new Set([
  'email', 'password', 'passwd', 'pwd', 'ssn', 'sin',
  'dob', 'dateofbirth', 'birthdate', 'dateOfBirth',
  'phone', 'phonenumber', 'phoneNumber', 'mobile', 'cellphone',
  'firstname', 'lastname', 'fullname', 'firstName', 'lastName', 'fullName',
  'address', 'streetaddress', 'postalcode', 'zipcode', 'postcode',
  'creditcard', 'cardnumber', 'cvv', 'cvc', 'pin', 'expiry',
  'bankaccount', 'accountnumber', 'routingnumber', 'iban', 'swift',
  'passport', 'nationalid', 'taxid', 'ein', 'tin',
  'ipaddress', 'ip_address', 'useragent', 'user_agent',
  'location', 'latitude', 'longitude', 'geolocation',
  'gender', 'race', 'ethnicity', 'religion', 'healthdata',
  'medicalrecord', 'diagnosis', 'prescription',
]);

// ---------------------------------------------------------------------------
// Sink patterns — calls that ship data to logs, analytics, or external systems
// ---------------------------------------------------------------------------
const LOG_SINK_RE = /\b(?:console\.(log|debug|info|warn|error)|logger\.\w+|log\.\w+|winston\.\w+|pino\.\w+|bunyan\.\w+|structlog\.\w+|logging\.\w+|print)\s*\(/i;

const ANALYTICS_SINK_RE = /\b(?:mixpanel\.track|analytics\.track|segment\.track|amplitude\.track|posthog\.capture|heap\.track|gtag\s*\(|ga\s*\(|datadog\.track|newrelic\.\w+|intercom\.\w+|hotjar\.\w+)\s*\(/i;

const HTTP_SINK_RE = /\b(?:fetch\s*\(|axios\.\w+\s*\(|got\.\w+\s*\(|http\.request\s*\(|https\.request\s*\(|requests?\.(post|get|put|patch|delete)\s*\(|ky\.\w+\s*\()\s*/i;

const DB_SINK_RE = /\b(?:INSERT\s+INTO|UPDATE\s+\w+\s+SET|\.create\s*\(|\.save\s*\(|\.upsert\s*\(|\.insert\s*\()\s*/i;
const DB_ENCRYPTED_MARKER_RE = /encrypt|encrypted|hashed|bcrypt|argon|scrypt|pbkdf2|vault|kms/i;

// ---------------------------------------------------------------------------
// Variable alias tracker — when we see `const userEmail = req.body.email`
// we add `userEmail` to the PII alias set for that file.
// ---------------------------------------------------------------------------
function buildAliasMap(lines) {
  const aliases = new Set();

  for (const line of lines) {
    const stripped = line.trim();
    if (stripped.startsWith('//') || stripped.startsWith('#')) continue;

    // Detect PII field accesses: req.body.email, user.email, body.email, etc.
    // and any assignment from them: const x = req.body.email
    const assignMatch = stripped.match(
      /(?:const|let|var|=)\s+(\w+)\s*=\s*(?:\w+\.)*(\w+)/
    );
    if (assignMatch) {
      const [, varName, field] = assignMatch;
      if (PII_FIELDS.has(field.toLowerCase()) || PII_FIELDS.has(field)) {
        aliases.add(varName);
      }
    }

    // Destructuring: const { email, phone } = req.body
    const destructureMatch = stripped.match(/(?:const|let|var)\s*\{([^}]+)\}\s*=/);
    if (destructureMatch) {
      const fields = destructureMatch[1].split(',').map(f => f.trim().split(':')[0].trim().split(' ').pop());
      for (const field of fields) {
        if (field && (PII_FIELDS.has(field.toLowerCase()) || PII_FIELDS.has(field))) {
          aliases.add(field);
        }
      }
    }

    // Parameter names: function handler(req, { email, phone })
    const paramMatch = stripped.match(/function\s+\w*\s*\([^)]*\{([^}]+)\}/);
    if (paramMatch) {
      const fields = paramMatch[1].split(',').map(f => f.trim());
      for (const field of fields) {
        if (PII_FIELDS.has(field.toLowerCase()) || PII_FIELDS.has(field)) {
          aliases.add(field);
        }
      }
    }
  }

  return aliases;
}

// ---------------------------------------------------------------------------
// Check whether a given line references a PII field or alias
// ---------------------------------------------------------------------------
function lineReferencesPii(line, aliases) {
  const stripped = stripStrings(line);

  // Direct field access: .email, .password, body.email, req.body.ssn
  for (const field of PII_FIELDS) {
    const re = new RegExp(`\\.${field}\\b|\\b${field}\\b`, 'i');
    if (re.test(stripped)) return { matched: true, field };
  }

  // Alias variable
  for (const alias of aliases) {
    if (new RegExp(`\\b${alias}\\b`).test(stripped)) return { matched: true, field: alias };
  }

  return { matched: false, field: null };
}

// ---------------------------------------------------------------------------
// Strip string literal contents to avoid matching PII field names in strings
// ---------------------------------------------------------------------------
function stripStrings(line) {
  return line
    .replace(/"[^"]*"/g, '""')
    .replace(/'[^']*'/g, "''")
    .replace(/`[^`]*`/g, '``');
}

// ---------------------------------------------------------------------------
// Classify the sink type from a line
// ---------------------------------------------------------------------------
function classifySink(line) {
  const sinks = [];
  if (LOG_SINK_RE.test(line)) sinks.push('logging');
  if (ANALYTICS_SINK_RE.test(line)) sinks.push('analytics');
  if (HTTP_SINK_RE.test(line)) sinks.push('external-http');
  if (DB_SINK_RE.test(line) && !DB_ENCRYPTED_MARKER_RE.test(line)) sinks.push('db-unencrypted');
  return sinks;
}

// ---------------------------------------------------------------------------
// Trace PII flows in a single file
// ---------------------------------------------------------------------------
function traceFile(filePath, content) {
  const findings = [];
  const lines = content.split('\n');

  // Skip test files and generated files
  const isTest = /\.(test|spec)\.[jt]sx?$/.test(filePath)
    || filePath.includes('__tests__')
    || filePath.includes('/tests/')
    || filePath.includes('/test/');
  const severity = isTest ? 'warning' : 'error';

  const aliases = buildAliasMap(lines);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip comment lines and blank lines
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('#')) continue;

    // Check if this line is a sink call
    const sinkTypes = classifySink(line);
    if (sinkTypes.length === 0) continue;

    // Check if the sink call references a PII field or alias
    const { matched, field } = lineReferencesPii(line, aliases);
    if (!matched) continue;

    // Suppress if there's a log-safe or pii-ok marker on this or previous line
    const prevLine = i > 0 ? lines[i - 1] : '';
    if (/\/\/\s*(log-safe|pii-ok|pii-flow-ok)/i.test(line) || /\/\/\s*(log-safe|pii-ok|pii-flow-ok)/i.test(prevLine)) continue;

    const sinkLabel = sinkTypes.join(' + ');
    findings.push({
      file: filePath,
      line: i + 1,
      severity,
      rule: 'pii-flow',
      sinks: sinkTypes,
      field,
      detail: `PII field '${field}' flows to ${sinkLabel} sink at line ${i + 1}`,
      snippet: trimmed.slice(0, 120),
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Main entrypoint: trace PII flows across a set of files
// ---------------------------------------------------------------------------
function tracePiiFlows(files, opts = {}) {
  const { maxFindingsPerFile = 10 } = opts;
  const allFindings = [];

  for (const { path: filePath, content } of files) {
    if (!content || typeof content !== 'string') continue;

    // Only scan JS/TS and Python source files
    if (!/\.[jt]sx?$|\.py$/.test(filePath)) continue;

    const findings = traceFile(filePath, content);
    allFindings.push(...findings.slice(0, maxFindingsPerFile));
  }

  // Sort: errors first, then by file + line
  allFindings.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'error' ? -1 : 1;
    if (a.file !== b.file) return a.file.localeCompare(b.file);
    return a.line - b.line;
  });

  const byField = {};
  for (const f of allFindings) {
    byField[f.field] = (byField[f.field] || 0) + 1;
  }

  return {
    findings: allFindings,
    summary: {
      total: allFindings.length,
      errors: allFindings.filter(f => f.severity === 'error').length,
      warnings: allFindings.filter(f => f.severity === 'warning').length,
      bySink: {
        logging: allFindings.filter(f => f.sinks.includes('logging')).length,
        analytics: allFindings.filter(f => f.sinks.includes('analytics')).length,
        externalHttp: allFindings.filter(f => f.sinks.includes('external-http')).length,
        dbUnencrypted: allFindings.filter(f => f.sinks.includes('db-unencrypted')).length,
      },
      byField,
    },
  };
}

/**
 * Render a markdown report for the PII flow findings.
 */
function renderPiiFlowReport(result) {
  if (!result || result.findings.length === 0) {
    return '## PII Flow Tracer\n\nNo PII flows to high-risk sinks detected.';
  }

  const { findings, summary } = result;
  const lines = ['## 🔒 PII Flow Tracer\n'];

  lines.push(`**${summary.total} PII flow${summary.total !== 1 ? 's' : ''} detected** — ${summary.errors} error${summary.errors !== 1 ? 's' : ''}, ${summary.warnings} warning${summary.warnings !== 1 ? 's' : ''}\n`);

  if (summary.bySink.logging > 0) lines.push(`- 🪵 **${summary.bySink.logging}** flowing to **logging sinks** (GDPR Article 5 — data minimisation)`);
  if (summary.bySink.analytics > 0) lines.push(`- 📊 **${summary.bySink.analytics}** flowing to **analytics** (consent required)`);
  if (summary.bySink.externalHttp > 0) lines.push(`- 🌐 **${summary.bySink.externalHttp}** flowing to **external HTTP** (data transfer — SCCs / BCRs may apply)`);
  if (summary.bySink.dbUnencrypted > 0) lines.push(`- 🗄️ **${summary.bySink.dbUnencrypted}** written to **database without encryption markers**`);

  lines.push('');

  // Group by file
  const byFile = {};
  for (const f of findings) {
    (byFile[f.file] = byFile[f.file] || []).push(f);
  }

  for (const [file, filFindings] of Object.entries(byFile)) {
    lines.push(`### \`${file}\``);
    for (const f of filFindings) {
      const sev = f.severity === 'error' ? '🔴' : '🟡';
      lines.push(`- ${sev} **Line ${f.line}** — \`${f.field}\` → ${f.sinks.join(' + ')}`);
      lines.push(`  \`${f.snippet}\``);
    }
    lines.push('');
  }

  lines.push('**Suppression:** Add `// pii-flow-ok` on the same or preceding line to suppress a known-safe flow.');

  return lines.join('\n');
}

module.exports = { tracePiiFlows, renderPiiFlowReport, PII_FIELDS };
