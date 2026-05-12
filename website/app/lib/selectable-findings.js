/**
 * Phase 6.1.2 — selectable findings helper.
 *
 * Pure functions used by the FixSelectionPanel UI to compute which
 * findings are eligible for auto-fix, group them, and convert a
 * customer's selection into the IssueInput[] shape /api/scan/fix
 * accepts.
 *
 * Design rationale:
 *   - The auto-fix flow is currently all-or-nothing. Customers who
 *     disagree with one fix (or want to skip the noisy ones) have no
 *     way to filter before clicking "Fix".
 *   - This helper is the algorithmic core: which findings are even
 *     "fixable" (have a parseable file path), how to group them by
 *     file/severity/module, how to flip a selection set into the
 *     payload the route needs.
 *   - Pure JS so the same logic loads from the React component AND
 *     from the test runner.
 */

const SEVERITY_ORDER = ['error', 'warning', 'info'];

const ERROR_HINTS = /\b(error|fail|vulnerab|exploit|injection|unsafe|critical|leak|exposed|disabled|bypass|impossible|catastrophic|unbounded|never|race|toctou|secret|credential|password|api[_\- ]?key|token|hardcoded)\b/i;
const WARNING_HINTS = /\b(warning|warn|should|consider|prefer|outdated|stale|deprecat|missing|unused|aging)\b/i;
const INFO_HINTS = /\b(summary|ok|note|scanned|info|library-ok)\b/i;

/**
 * Severity classification heuristic — mirrored across copy-formatters.js,
 * confidence-aware-report.js, FindingsPanel.tsx, and ai-handoff.js so
 * everything classifies consistently. If you change one, change them all.
 */
function classifySeverity(raw) {
  if (typeof raw !== 'string') return 'warning';
  if (/^(error|err|critical|high)\b[:]/i.test(raw)) return 'error';
  if (/^(warning|warn|medium)\b[:]/i.test(raw)) return 'warning';
  if (/^(info|note|low|summary)\b[:]/i.test(raw)) return 'info';
  const lower = raw.toLowerCase();
  if (ERROR_HINTS.test(lower)) return 'error';
  if (WARNING_HINTS.test(lower)) return 'warning';
  if (INFO_HINTS.test(lower)) return 'info';
  return 'warning';
}

/**
 * Parse a single module-detail string into a structured Selectable
 * finding shape — { id, module, severity, file, line, message, raw,
 * fixable }. fixable is the auto-fix gate: a finding is only sent to
 * /api/scan/fix when it has a parseable file path OR a CREATE_FILE
 * marker. Findings that fail this gate go into a separate "needs
 * manual review" bucket the panel still displays.
 */
function parseSelectableFinding(raw, moduleName, index) {
  const safeRaw = typeof raw === 'string' ? raw : String(raw ?? '');
  let rest = safeRaw
    .replace(/^(?:\[[^\]]+\]\s*|(?:error|warn(?:ing)?|info|note|summary)\s*:\s*)/i, '')
    .trim();

  let file = null;
  let line = null;

  // Standard "file.ts:42 — message" / "file.ts:42:7 message" shape.
  const fileLine = rest.match(/^([A-Za-z0-9_./\-@+]+?\.[A-Za-z0-9]{1,8}):(\d+)(?::\d+)?(?:\s*[-—:]\s*|\s+)(.+)$/);
  if (fileLine) {
    file = fileLine[1];
    line = Number(fileLine[2]);
    rest = fileLine[3];
  } else {
    const fileOnly = rest.match(/^([A-Za-z0-9_./\-@+]+?\.[A-Za-z0-9]{1,8})\s*[:—-]\s*(.+)$/);
    if (fileOnly) {
      file = fileOnly[1];
      rest = fileOnly[2];
    }
  }

  // CREATE_FILE marker — for "missing X" findings the route's auto-fix
  // can synthesise from scratch.
  let issueText = rest.trim();
  let createFile = false;
  if (!file) {
    const missingMatch = safeRaw.match(/(?:missing|no|needs)\s+([.\w/\-]+\.(?:md|json|yml|yaml|toml|gitignore|env|example))/i);
    if (missingMatch) {
      file = missingMatch[1].toLowerCase() === 'gitignore' ? '.gitignore' : missingMatch[1];
      issueText = `CREATE_FILE: ${safeRaw}`;
      createFile = true;
    }
  }

  return {
    id: `${moduleName}-${index}`,
    module: moduleName,
    severity: classifySeverity(safeRaw),
    file,
    line,
    message: issueText,
    raw: safeRaw,
    createFile,
    fixable: Boolean(file),
  };
}

/**
 * Walk an array of module results and return a flat Selectable[]
 * including BOTH fixable and unfixable findings. The fixable=false
 * ones drive the "needs manual review" surface; fixable=true ones
 * drive the checkbox grid.
 */
function buildSelectableFindings(modules) {
  if (!Array.isArray(modules)) return [];
  const out = [];
  for (const m of modules) {
    if (!m || typeof m !== 'object') continue;
    if (m.status !== 'failed') continue;
    const details = Array.isArray(m.details) ? m.details : [];
    details.forEach((d, idx) => {
      out.push(parseSelectableFinding(d, m.name, idx));
    });
  }
  return out;
}

/**
 * Group a Selectable[] by file. Files are sorted by:
 *   1. error count desc (highest-priority files first)
 *   2. warning count desc
 *   3. file name asc (stable tiebreak)
 */
function groupSelectableByFile(findings) {
  const byFile = new Map();
  for (const f of findings) {
    if (!f) continue;
    const key = f.file || '(no file)';
    if (!byFile.has(key)) byFile.set(key, []);
    byFile.get(key).push(f);
  }
  // The "(no file)" bucket ALWAYS sinks to the bottom regardless of
  // error count — a customer reading a file list can't action a finding
  // that has no file attached, so it belongs after the actionable rows.
  // Within the actionable bucket: error-count desc → warning-count desc
  // → file name asc.
  const entries = Array.from(byFile.entries());
  entries.sort((a, b) => {
    if (a[0] === '(no file)' && b[0] !== '(no file)') return 1;
    if (b[0] === '(no file)' && a[0] !== '(no file)') return -1;
    const errA = a[1].filter((f) => f.severity === 'error').length;
    const errB = b[1].filter((f) => f.severity === 'error').length;
    if (errB !== errA) return errB - errA;
    const warnA = a[1].filter((f) => f.severity === 'warning').length;
    const warnB = b[1].filter((f) => f.severity === 'warning').length;
    if (warnB !== warnA) return warnB - warnA;
    return a[0].localeCompare(b[0]);
  });
  return entries;
}

/**
 * Compute counts for the summary header / select-all controls.
 */
function countSelectable(findings) {
  const c = {
    total: 0,
    fixable: 0,
    unfixable: 0,
    error: 0,
    warning: 0,
    info: 0,
    byModule: {},
  };
  if (!Array.isArray(findings)) return c;
  for (const f of findings) {
    if (!f) continue;
    c.total += 1;
    if (f.fixable) c.fixable += 1;
    else c.unfixable += 1;
    c[f.severity] = (c[f.severity] || 0) + 1;
    if (f.module) c.byModule[f.module] = (c.byModule[f.module] || 0) + 1;
  }
  return c;
}

/**
 * Compute the "select all" set of finding IDs given a filter:
 *   - severity: 'all' | 'error' | 'warning' | 'info'
 *   - module: 'all' | <module-name>
 *   - fixableOnly: defaults to true (the panel never auto-selects
 *     unfixable findings — they go to the manual-review surface)
 */
function selectionForFilter(findings, opts = {}) {
  const sev = opts.severity || 'all';
  const mod = opts.module || 'all';
  const fixableOnly = opts.fixableOnly !== false;
  const out = new Set();
  if (!Array.isArray(findings)) return out;
  for (const f of findings) {
    if (!f) continue;
    if (fixableOnly && !f.fixable) continue;
    if (sev !== 'all' && f.severity !== sev) continue;
    if (mod !== 'all' && f.module !== mod) continue;
    out.add(f.id);
  }
  return out;
}

/**
 * Convert the customer's selection (a Set of finding IDs) into the
 * IssueInput[] shape /api/scan/fix accepts. Unfixable findings in the
 * selection are silently dropped — the panel guards against selecting
 * them, but defence-in-depth.
 */
function selectionToIssueInputs(findings, selectedIds) {
  if (!Array.isArray(findings)) return [];
  if (!selectedIds || typeof selectedIds.has !== 'function') return [];
  const out = [];
  for (const f of findings) {
    if (!f || !f.fixable) continue;
    if (!selectedIds.has(f.id)) continue;
    out.push({ file: f.file, issue: f.message, module: f.module });
  }
  return out;
}

/**
 * Quick label for the "Fix N issues with AI" CTA. Renders the right
 * preposition / pluralisation from a count.
 */
function selectionCtaLabel(count) {
  const n = Number(count) || 0;
  if (n === 0) return 'Pick at least one finding to fix';
  if (n === 1) return 'Fix 1 selected finding with AI';
  return `Fix ${n} selected findings with AI`;
}

module.exports = {
  SEVERITY_ORDER,
  classifySeverity,
  parseSelectableFinding,
  buildSelectableFindings,
  groupSelectableByFile,
  countSelectable,
  selectionForFilter,
  selectionToIssueInputs,
  selectionCtaLabel,
};
