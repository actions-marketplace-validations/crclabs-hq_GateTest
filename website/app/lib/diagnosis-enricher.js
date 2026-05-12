/**
 * Diagnosis enricher — couples the Nuclear-tier diagnoser (Phase 3.1) to
 * the per-file fix loop (Phase 1.1) so $399 customers get fixes that
 * reflect the diagnoser's architectural recommendation, not just the
 * raw finding text.
 *
 * The gap this closes: today, /api/scan/server-fix runs the diagnoser
 * and produces a *report* (rich, accurate, but text only). /api/scan/fix
 * runs the iterative fix loop and produces *PRs* (real code changes,
 * but with only the raw "lint:42 — uses var" detail as input). A
 * customer paying $399 for Nuclear sees one tool diagnose brilliantly
 * and another tool ship per-line fixes — and the two never share what
 * they know.
 *
 * This module is the bridge:
 *
 *   1. runDiagnosesForFixInputs(issues, ask, hostname)
 *      Maps the route's IssueInput[] → diagnoser's Finding[] shape,
 *      runs diagnoseFindings, returns the diagnoses array (capped at
 *      MAX_FINDINGS_TO_DIAGNOSE so Claude spend is bounded).
 *
 *   2. enrichIssuesWithDiagnosis(issues, diagnoses)
 *      Prepends each issue's text with "ROOT CAUSE: ... | RECOMMENDED
 *      APPROACH: ..." when a successful diagnosis exists for it. Issues
 *      without a successful diagnosis pass through unchanged.
 *
 *   3. shipDiagnosisAwareFix(opts)
 *      Top-level facade: takes (issues, ask, hostname) and returns
 *      enriched IssueInput[] ready to feed straight into the fix loop.
 *
 * Pure functions. No I/O beyond the injected `askClaudeForDiagnosis`.
 * Tests inject a fake-Claude that returns canned responses.
 *
 * RELIABILITY CONTRACT:
 *   - If diagnosis fails for any reason (Claude down, parse error,
 *     timeout), the original issues pass through unchanged. The fix
 *     loop NEVER waits longer than the unenriched path; it just gets
 *     better input when the brain is healthy.
 *   - Per-finding cap (20) is enforced — diagnosing 200 findings
 *     would cost ~$2 in Claude credit, so we bound it.
 */

const MAX_FINDINGS_TO_DIAGNOSE = 20;

/**
 * Convert a route IssueInput { file, issue, module } into the
 * diagnoser's Finding shape { detail, module, severity, file? }.
 * The diagnoser expects a `detail` string that's the original finding
 * text — we use the route's issue text as the detail.
 */
function issueToFinding(input) {
  if (!input || typeof input !== 'object') return null;
  if (typeof input.issue !== 'string' || input.issue.length === 0) return null;
  return {
    detail: input.issue,
    module: input.module || 'unknown',
    severity: classifySeverity(input.issue),
    file: input.file || null,
  };
}

/**
 * Mirror of the severity heuristic used elsewhere — we don't import
 * confidence-aware-report.js to keep this module dependency-free.
 */
function classifySeverity(raw) {
  if (typeof raw !== 'string') return 'warning';
  if (/^(error|err|critical|high)\b[:]/i.test(raw)) return 'error';
  if (/^(warning|warn|medium)\b[:]/i.test(raw)) return 'warning';
  if (/^(info|note|low|summary)\b[:]/i.test(raw)) return 'info';
  if (/\b(error|fail|vulnerab|exploit|injection|secret|credential|password|api[_\- ]?key|hardcoded|unsafe|critical|leak|exposed)\b/i.test(raw)) {
    return 'error';
  }
  return 'warning';
}

/**
 * Run the Nuclear diagnoser against a set of route issues. Returns the
 * full diagnoseFindings result; caller decides which diagnoses to use
 * for enrichment vs. report rendering.
 *
 * @param {object} opts
 * @param {Array} opts.issues — IssueInput[] from /api/scan/fix
 * @param {Function} opts.askClaudeForDiagnosis — same wrapper /api/scan/fix already has
 * @param {string} [opts.hostname] — for the diagnoser prompt
 * @param {object} [opts.scanContext] — { platform, stack[] }
 * @param {string} [opts.priorArt] — optional cross-repo intelligence string
 * @param {Function} [opts.diagnoseFindings] — injectable for tests
 * @returns {Promise<{ diagnoses, summary }>}
 */
async function runDiagnosesForFixInputs(opts) {
  const {
    issues,
    askClaudeForDiagnosis,
    hostname = 'your-domain.com',
    scanContext = {},
    priorArt = null,
    diagnoseFindings: diagnoseFindingsImpl = null,
  } = opts || {};

  if (!Array.isArray(issues) || issues.length === 0) {
    return { diagnoses: [], summary: 'no issues to diagnose' };
  }
  if (typeof askClaudeForDiagnosis !== 'function') {
    return { diagnoses: [], summary: 'no Claude wrapper supplied — diagnoser skipped' };
  }

  const findings = issues.map(issueToFinding).filter((f) => f !== null);
  if (findings.length === 0) {
    return { diagnoses: [], summary: 'no diagnosable findings' };
  }

  // Lazy-import nuclear-diagnoser unless an override is injected (tests).
   
  const fn = diagnoseFindingsImpl || require('./nuclear-diagnoser.js').diagnoseFindings;

  try {
    const result = await fn({
      findings,
      hostname,
      scanContext,
      priorArt,
      askClaudeForDiagnosis,
      maxFindings: MAX_FINDINGS_TO_DIAGNOSE,
    });
    return result || { diagnoses: [], summary: 'diagnoser returned nothing' };
  } catch (err) {
    return {
      diagnoses: [],
      summary: `diagnoser failed: ${err && err.message ? err.message : String(err)} — falling back to unenriched fix`,
    };
  }
}

/**
 * Take an IssueInput[] and a diagnoses[] (from diagnoseFindings) and
 * return a new IssueInput[] where each issue's `issue` text has been
 * prefixed with the diagnosis context when one exists. The matching is
 * by index — diagnoses[i] corresponds to findings[i] (which corresponds
 * to issues[i] up to the MAX_FINDINGS_TO_DIAGNOSE cap).
 *
 * Issues beyond the cap, or whose diagnosis failed (ok=false), pass
 * through unchanged.
 */
function enrichIssuesWithDiagnosis(issues, diagnoses) {
  if (!Array.isArray(issues)) return [];
  if (!Array.isArray(diagnoses) || diagnoses.length === 0) return issues;

  // Build a lookup by detail text — diagnoseFindings preserves order
  // up to maxFindings, but matching by detail is more robust against
  // any reordering / filtering.
  const byDetail = new Map();
  for (const d of diagnoses) {
    if (!d || !d.ok || !d.diagnosis || !d.finding) continue;
    if (typeof d.finding.detail !== 'string') continue;
    byDetail.set(d.finding.detail, d.diagnosis);
  }

  return issues.map((iss) => {
    if (!iss || typeof iss.issue !== 'string') return iss;
    const diagnosis = byDetail.get(iss.issue);
    if (!diagnosis) return iss;
    const enriched =
      `${iss.issue}\n\n` +
      `--- Nuclear-tier diagnosis ---\n` +
      `ROOT CAUSE: ${diagnosis.rootCause || '(not provided)'}\n` +
      `RECOMMENDED APPROACH: ${diagnosis.recommendation || '(not provided)'}` +
      (diagnosis.platformNotes && Object.keys(diagnosis.platformNotes).length > 0
        ? `\nPLATFORM NOTES: ${Object.entries(diagnosis.platformNotes).map(([k, v]) => `${k}: ${v}`).join('; ')}`
        : '') +
      `\n--- End diagnosis ---`;
    return { ...iss, issue: enriched, _diagnosed: true };
  });
}

/**
 * Top-level facade — diagnose + enrich in one call. Returns the
 * enriched issues ready to feed into attemptFixWithRetries, plus the
 * raw diagnoses array so the caller can also include the diagnosis
 * report in the PR body.
 *
 * Best-effort: any failure in the diagnosis path returns the original
 * issues unchanged + a summary explaining what happened.
 */
async function shipDiagnosisAwareFix(opts) {
  const {
    issues,
    askClaudeForDiagnosis,
    hostname,
    scanContext,
    priorArt,
    diagnoseFindings: diagnoseFindingsImpl,
  } = opts || {};

  const safeIssues = Array.isArray(issues) ? issues : [];
  if (safeIssues.length === 0) {
    return {
      enrichedIssues: [],
      diagnoses: [],
      summary: 'no issues to enrich',
      enrichedCount: 0,
    };
  }

  const diagResult = await runDiagnosesForFixInputs({
    issues: safeIssues,
    askClaudeForDiagnosis,
    hostname,
    scanContext,
    priorArt,
    diagnoseFindings: diagnoseFindingsImpl,
  });

  const enriched = enrichIssuesWithDiagnosis(safeIssues, diagResult.diagnoses);
  const enrichedCount = enriched.filter((i) => i && i._diagnosed === true).length;

  return {
    enrichedIssues: enriched,
    diagnoses: diagResult.diagnoses,
    summary: `${diagResult.summary || 'diagnoser ran'} — ${enrichedCount}/${safeIssues.length} issues enriched`,
    enrichedCount,
  };
}

module.exports = {
  MAX_FINDINGS_TO_DIAGNOSE,
  issueToFinding,
  classifySeverity,
  runDiagnosesForFixInputs,
  enrichIssuesWithDiagnosis,
  shipDiagnosisAwareFix,
};
