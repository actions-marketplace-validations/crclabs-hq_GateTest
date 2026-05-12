/**
 * Bulk-copy formatters — pure functions used by CopyButton hosts to
 * render arrays of findings / log lines / etc. as paste-anywhere
 * markdown.
 *
 * Why a separate file: the React components live under .tsx and can't
 * be require()'d from node:test without a JSX loader. Keeping the
 * pure formatters here lets the test runner exercise them directly.
 *
 * Used by: FindingsPanel (header bulk-copy button), LiveScanTerminal
 * (transcript copy), and the AIBuilderHandoff component.
 */

/**
 * Format an array of findings as a markdown checklist suitable for
 * pasting into Slack, Linear, GitHub Issues, Notion, Cursor chat, etc.
 *
 * @param {object} opts
 * @param {Array} opts.findings - { severity, module, file, line, message }
 * @param {number} [opts.totalCount] - if filtering, the unfiltered total
 * @param {string} [opts.repoUrl] - optional repo header line
 * @param {string} [opts.title] - optional override for the markdown H1
 * @returns {string} markdown ready to clipboard.writeText()
 */
function formatFindingsAsMarkdown(opts) {
  const {
    findings,
    totalCount = null,
    repoUrl = null,
    title = null,
  } = opts || {};

  if (!Array.isArray(findings) || findings.length === 0) return '';

  const lines = [];
  const headerCount =
    typeof totalCount === 'number' && totalCount !== findings.length
      ? `${findings.length} of ${totalCount}`
      : `${findings.length}`;
  lines.push(title ? `# ${title}` : `# GateTest findings — ${headerCount}`);
  if (repoUrl) lines.push(`Repo: ${repoUrl}`);
  lines.push('');

  for (const f of findings) {
    if (!f) continue;
    const sev = String(f.severity || 'finding').toUpperCase();
    const mod = f.module ? `\`${f.module}\`` : '`unknown`';
    const where = f.file
      ? ` \`${f.file}${f.line ? ':' + f.line : ''}\``
      : '';
    const msg = String(f.message ?? '').trim();
    lines.push(`- [ ] **${sev}** ${mod}${where} — ${msg}`);
  }
  return lines.join('\n');
}

/**
 * Format a single finding as a one-liner for in-row copy. Keeps the
 * shape consistent across panels.
 */
function formatFindingAsLine(f) {
  if (!f) return '';
  const sev = String(f.severity || 'finding').toUpperCase();
  const mod = f.module || 'unknown';
  const where = f.file ? ` ${f.file}${f.line ? ':' + f.line : ''}` : '';
  const msg = String(f.message ?? '').trim();
  return `[${sev}] ${mod}${where} — ${msg}`;
}

/**
 * Format a scan-terminal log array as a copyable transcript.
 *
 * @param {object} opts
 * @param {Array} opts.logs - { type, message } entries
 * @param {string} [opts.command] - optional first-line command echo
 * @param {Function} [opts.prefixFor] - inject (type) → string mapper;
 *   defaults to the same prefix scheme LiveScanTerminal uses inline.
 */
function formatScanTranscript(opts) {
  const { logs, command = null, prefixFor = defaultPrefixFor } = opts || {};
  if (!Array.isArray(logs) || logs.length === 0) return '';
  const lines = [];
  if (command) lines.push(`# ${command}`, '');
  for (const l of logs) {
    if (!l) continue;
    lines.push(`${prefixFor(l.type)}${l.message ?? ''}`);
  }
  return lines.join('\n');
}

function defaultPrefixFor(type) {
  switch (type) {
    case 'error': return 'ERROR  ';
    case 'warn':
    case 'warning': return 'WARN   ';
    case 'success': return 'OK     ';
    case 'progress': return 'INFO   ';
    case 'cmd': return '$ ';
    default: return '       ';
  }
}

module.exports = {
  formatFindingsAsMarkdown,
  formatFindingAsLine,
  formatScanTranscript,
  defaultPrefixFor,
};
