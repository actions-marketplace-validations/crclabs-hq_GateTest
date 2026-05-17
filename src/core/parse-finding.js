'use strict';

/**
 * Shared finding-parser used by the CLI auto-PR path and the website
 * scan/handoff layer. The previous bug: modules emit ~764 addCheck
 * calls but only 19 set a structured `file` field. The auto-PR code
 * filtered on the structured field and silently dropped 97% of
 * findings — making auto-repair look broken even when configured.
 *
 * This module extracts the file path (and line number when present)
 * from the finding's MESSAGE text using the same regexes the website
 * has had in ai-handoff.js for months. Both surfaces now share one
 * implementation so a regex fix in one place benefits the other.
 *
 * Pure JS. No I/O. Deterministic. Tested.
 */

/**
 * @typedef {{
 *   id: string,
 *   module: string,
 *   severity: 'error'|'warning'|'info',
 *   file: string|null,
 *   line: number|null,
 *   message: string,
 *   raw: string,
 * }} Finding
 */

const ERROR_HINTS = /\b(error|fail|vulnerab|exploit|injection|unsafe|critical|leak|exposed|disabled|bypass|impossible|catastrophic|unbounded|never|race|toctou|secret|credential|password|api[_\- ]?key|token|hardcoded)\b/i;
const WARNING_HINTS = /\b(warning|warn|should|consider|prefer|outdated|stale|deprecat|missing|unused|aging)\b/i;
const INFO_HINTS = /\b(summary|ok|note|scanned|info|library-ok)\b/i;

/**
 * Classify severity from a raw message string.
 * @param {string} raw
 * @returns {'error'|'warning'|'info'}
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
 * Parse a single raw finding string into a structured Finding.
 *
 * Recognised input shapes:
 *   - "src/foo.ts:42:3 — message"            → file + line + message
 *   - "src/foo.ts:42 - message"              → file + line + message
 *   - "src/foo.ts: message"                  → file + message
 *   - "[severity] src/foo.ts:42 — message"   → file + line + message
 *   - "error: src/foo.ts:42 — message"       → file + line + message
 *   - "any other format"                     → message only, file/line null
 *
 * @param {string} raw            the finding text emitted by addCheck()
 * @param {string} moduleName     the module that emitted it (for id)
 * @param {number} index          monotonic index per module (for unique id)
 * @returns {Finding}
 */
function parseFinding(raw, moduleName, index) {
  const safeRaw = typeof raw === 'string' ? raw : String(raw == null ? '' : raw);
  // Strip leading severity tags: "[error] ..." or "error: ..."
  let rest = safeRaw
    .replace(/^(?:\[[^\]]+\]\s*|(?:error|warn(?:ing)?|info|note|summary)\s*:\s*)/i, '')
    .trim();

  let file = null;
  let line = null;

  // Shape 1: file.ext:line:col — message   (or :line)
  const fileLine = rest.match(
    /^([A-Za-z0-9_./\-@+]+?\.[A-Za-z0-9]{1,8}):(\d+)(?::\d+)?(?:\s*[-—:]\s*|\s+)(.+)$/
  );
  if (fileLine) {
    file = fileLine[1];
    line = Number(fileLine[2]);
    rest = fileLine[3];
  } else {
    // Shape 2: file.ext — message  (or :message, no line)
    const fileOnly = rest.match(/^([A-Za-z0-9_./\-@+]+?\.[A-Za-z0-9]{1,8})\s*[:—-]\s*(.+)$/);
    if (fileOnly) {
      file = fileOnly[1];
      rest = fileOnly[2];
    }
  }

  return {
    id: `${moduleName || 'unknown'}-${index}`,
    module: moduleName || 'unknown',
    severity: classifySeverity(safeRaw),
    file,
    line,
    message: rest.trim(),
    raw: safeRaw,
  };
}

/**
 * Pull a file path out of a finding regardless of which slot it's in.
 * Used by the auto-PR loop. Returns `{file, line}` (either may be null).
 *
 * Lookup order:
 *   1. check.file
 *   2. check.details.file
 *   3. check.path
 *   4. Parse check.message via parseFinding
 *
 * @param {Object} check
 * @returns {{file: string|null, line: number|null}}
 */
function extractFileFromCheck(check) {
  if (!check || typeof check !== 'object') return { file: null, line: null };
  if (typeof check.file === 'string' && check.file)
    return { file: check.file, line: typeof check.line === 'number' ? check.line : null };
  if (check.details && typeof check.details === 'object') {
    if (typeof check.details.file === 'string' && check.details.file) {
      return {
        file: check.details.file,
        line: typeof check.details.line === 'number' ? check.details.line : null,
      };
    }
  }
  if (typeof check.path === 'string' && check.path) return { file: check.path, line: null };
  // Last resort: parse the message text.
  const msg = (check.message || (check.details && check.details.message) || check.name || '');
  const parsed = parseFinding(msg, check.module || 'unknown', 0);
  return { file: parsed.file, line: parsed.line };
}

module.exports = {
  parseFinding,
  classifySeverity,
  extractFileFromCheck,
};
