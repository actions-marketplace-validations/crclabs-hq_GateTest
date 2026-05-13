/**
 * AI-Builder Handoff — convert GateTest scan findings into prompts /
 * task lists / structured payloads that any AI coding tool can ingest
 * directly. This is the "Plan B" when our own iterative fix loop
 * can't or shouldn't ship a PR (Anthropic outage, customer wants to
 * review in Cursor first, customer is on a tier without auto-fix,
 * customer just wants the issues exported).
 *
 * Six output formats:
 *  - claude-code   — paste into `claude` CLI or Claude Code chat
 *  - cursor        — formatted for Cursor's Composer / @-mention chat
 *  - cline-aider   — task description + file list for Cline / Aider
 *  - github-issue  — markdown for filing as one or many GitHub issues
 *  - json          — structured data dump (for any custom tooling)
 *  - markdown      — plain markdown checklist (paste anywhere)
 *
 * All formatters are pure functions: same input → same output, no
 * I/O, no clipboard side-effects. The React component layer wraps
 * them with copy/download UX.
 *
 * Pure-JS so the same module loads from the Next.js client component
 * AND from `node:test` in tests/ai-handoff.test.js.
 */

const SUPPORTED_FORMATS = [
  'claude-code',
  'cursor',
  'cline-aider',
  'github-issue',
  'json',
  'markdown',
];

const FORMAT_LABELS = {
  'claude-code': 'Claude Code',
  cursor: 'Cursor',
  'cline-aider': 'Cline / Aider',
  'github-issue': 'GitHub Issue',
  json: 'JSON',
  markdown: 'Markdown',
};

const FORMAT_FILENAMES = {
  'claude-code': 'gatetest-findings.claude.md',
  cursor: 'gatetest-findings.cursor.md',
  'cline-aider': 'gatetest-findings.cline.md',
  'github-issue': 'gatetest-findings.issue.md',
  json: 'gatetest-findings.json',
  markdown: 'gatetest-findings.md',
};

/**
 * Normalise the modules-with-details shape that runTier returns into
 * a flat findings array with parsed file/line/severity. Mirrors the
 * UI's FindingsPanel.parseFinding so all surfaces extract the same
 * structure.
 *
 * Input:  modules: [{ name, status, details: ["src/foo.ts:42 — message", ...] }]
 * Output: [{ id, module, severity, file, line, message, raw }]
 */
function buildFindings(modules) {
  if (!Array.isArray(modules)) return [];
  const out = [];
  for (const m of modules) {
    if (!m || !Array.isArray(m.details) || m.details.length === 0) continue;
    m.details.forEach((d, idx) => {
      out.push(parseFinding(d, m.name, idx));
    });
  }
  return out;
}

function parseFinding(raw, moduleName, index) {
  const safeRaw = typeof raw === 'string' ? raw : String(raw == null ? '' : raw);
  let rest = safeRaw
    .replace(/^(?:\[[^\]]+\]\s*|(?:error|warn(?:ing)?|info|note|summary)\s*:\s*)/i, '')
    .trim();

  let file = null;
  let line = null;

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

  return {
    id: `${moduleName}-${index}`,
    module: moduleName,
    severity: classifySeverity(safeRaw),
    file,
    line,
    message: rest.trim(),
    raw: safeRaw,
  };
}

// `api[_\- ]?key` so the heuristic catches "api key" (with a space) the same
// way it catches "api_key" / "api-key" / "apikey". Otherwise "hardcoded API
// key in src/foo.ts" — the most natural English form a scanner emits — falls
// through to the warning bucket and gets buried below truly minor issues.
const ERROR_HINTS = /\b(error|fail|vulnerab|exploit|injection|unsafe|critical|leak|exposed|disabled|bypass|impossible|catastrophic|unbounded|never|race|toctou|secret|credential|password|api[_\- ]?key|token|hardcoded)\b/i;
const WARNING_HINTS = /\b(warning|warn|should|consider|prefer|outdated|stale|deprecat|missing|unused|aging)\b/i;
const INFO_HINTS = /\b(summary|ok|note|scanned|info|library-ok)\b/i;

function classifySeverity(raw) {
  const lower = raw.toLowerCase();
  if (/^(error|err|critical|high)\b[:]/i.test(raw)) return 'error';
  if (/^(warning|warn|medium)\b[:]/i.test(raw)) return 'warning';
  if (/^(info|note|low|summary)\b[:]/i.test(raw)) return 'info';
  if (ERROR_HINTS.test(lower)) return 'error';
  if (WARNING_HINTS.test(lower)) return 'warning';
  if (INFO_HINTS.test(lower)) return 'info';
  return 'warning';
}

/**
 * Group findings by file. Files-with-paths first (sorted by error
 * count desc), then a synthetic "(unattributed)" bucket for findings
 * without a file path. Mutating-fn-free.
 */
function groupByFile(findings) {
  const byFile = new Map();
  for (const f of findings) {
    const key = f.file || '(unattributed)';
    if (!byFile.has(key)) byFile.set(key, []);
    byFile.get(key).push(f);
  }
  // Unattributed bucket ALWAYS sinks to the bottom regardless of error
  // count — a developer reading a file list can't action a finding that
  // has no file attached, so it belongs after the actionable rows.
  // Within the actionable bucket: error-count desc → warning-count desc
  // → alphabetical, so the file with the most red flags surfaces first.
  const entries = Array.from(byFile.entries());
  entries.sort((a, b) => {
    if (a[0] === '(unattributed)' && b[0] !== '(unattributed)') return 1;
    if (b[0] === '(unattributed)' && a[0] !== '(unattributed)') return -1;
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

function counts(findings) {
  const c = { total: findings.length, error: 0, warning: 0, info: 0 };
  for (const f of findings) c[f.severity] = (c[f.severity] || 0) + 1;
  return c;
}

/**
 * Filter findings by severity / module / search query. Returns a new
 * array; never mutates input. All filters optional — empty / "all" /
 * empty-string disables that filter.
 */
function filterFindings(findings, opts = {}) {
  const sev = opts.severity || 'all';
  const mod = opts.module || 'all';
  const q = (opts.query || '').trim().toLowerCase();
  return findings.filter((f) => {
    if (sev !== 'all' && f.severity !== sev) return false;
    if (mod !== 'all' && f.module !== mod) return false;
    if (q) {
      const hay = `${f.file || ''} ${f.message} ${f.module}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

// ----------------------------------------------------------------------
// FORMATTERS — every one takes (findings, opts) and returns a string
// (or for 'json', a JSON-stringified object). opts may contain
// `repoUrl` and `tier` for context.
// ----------------------------------------------------------------------

/**
 * Claude Code prompt — meta-prompt that tells Claude what GateTest
 * is, what tier the scan ran at, and asks for a concrete fix plan.
 * Designed to paste straight into Claude Code (the CLI) or
 * claude.ai/chat. Includes the full findings as a structured list
 * grouped by file because Claude reasons better about co-located
 * fixes than a flat dump.
 */
function formatForClaudeCode(findings, opts = {}) {
  const groups = groupByFile(findings);
  const c = counts(findings);
  const ctx = renderContextHeader(opts);
  const body = groups
    .map(([file, items]) => {
      const header = file === '(unattributed)'
        ? '### (issues without a clear file location)'
        : `### \`${file}\``;
      const rows = items
        .map((f) => `- [${f.severity.toUpperCase()}] ${formatLineRef(f)} ${f.message}`)
        .join('\n');
      return `${header}\n${rows}`;
    })
    .join('\n\n');

  return [
    '# GateTest scan — handoff to Claude',
    '',
    ctx,
    `**Total:** ${c.total} finding${c.total === 1 ? '' : 's'} — ${c.error} error, ${c.warning} warning, ${c.info} info.`,
    '',
    '## What I need',
    '',
    'Read every finding below, then propose a concrete fix plan. For each file: (1) explain the root cause, (2) write the corrected code, (3) confirm no new issues are introduced. Errors first, warnings next, info only if cheap. Skip anything you are not certain about — flag it for human review instead of guessing.',
    '',
    '## Findings (grouped by file, errors first)',
    '',
    body,
    '',
    '---',
    '_Generated by GateTest — gatetest.ai_',
  ].join('\n');
}

/**
 * Cursor Composer prompt — uses Cursor's `@filename` mention syntax
 * so the file context auto-loads when pasted into Composer. One
 * `@filename` per file, then a bulleted task list.
 */
function formatForCursor(findings, opts = {}) {
  const groups = groupByFile(findings);
  const c = counts(findings);
  const ctx = renderContextHeader(opts);
  const filesMentioned = groups
    .filter(([file]) => file !== '(unattributed)')
    .map(([file]) => `@${file}`)
    .join(' ');

  const body = groups
    .map(([file, items]) => {
      const header = file === '(unattributed)'
        ? '### (no file path — review by hand)'
        : `### @${file}`;
      const rows = items
        .map((f) => `- ${f.severity.toUpperCase()} ${formatLineRef(f)} ${f.message}`)
        .join('\n');
      return `${header}\n${rows}`;
    })
    .join('\n\n');

  return [
    '# Cursor task — fix GateTest findings',
    '',
    ctx,
    `**${c.total}** finding${c.total === 1 ? '' : 's'} (${c.error}E / ${c.warning}W / ${c.info}I) across **${groups.length}** file${groups.length === 1 ? '' : 's'}.`,
    '',
    filesMentioned ? `Files in scope: ${filesMentioned}` : '',
    '',
    'For each file: read the finding, diagnose, fix at the root cause, run the project tests if they exist. Do not introduce console.log, debugger, eval, var, empty catch, or TODO/FIXME — those are GateTest violations and will fail the next scan.',
    '',
    body,
    '',
    '---',
    '_Generated by GateTest — gatetest.ai_',
  ].filter(Boolean).join('\n');
}

/**
 * Cline / Aider task — Cline reads markdown task files; Aider takes
 * `aider <files>` arg lists. We render BOTH in one document so the
 * developer can use whichever tool they prefer without re-exporting.
 */
function formatForClineAider(findings, opts = {}) {
  const groups = groupByFile(findings);
  const c = counts(findings);
  const ctx = renderContextHeader(opts);
  const filePaths = groups
    .filter(([file]) => file !== '(unattributed)')
    .map(([file]) => file);

  const aiderCmd = filePaths.length > 0
    ? `aider ${filePaths.map((f) => shellQuote(f)).join(' ')}`
    : 'aider  # (no file paths in scan — paste the findings into Aider chat)';

  const body = groups
    .map(([file, items]) => {
      const header = file === '(unattributed)'
        ? '### Findings without a file path'
        : `### \`${file}\``;
      const rows = items
        .map((f) => `- ${f.severity.toUpperCase()} ${formatLineRef(f)} — ${f.message}`)
        .join('\n');
      return `${header}\n${rows}`;
    })
    .join('\n\n');

  return [
    '# GateTest findings — Cline / Aider task',
    '',
    ctx,
    `**${c.total}** finding${c.total === 1 ? '' : 's'} — ${c.error}E / ${c.warning}W / ${c.info}I.`,
    '',
    '## Aider command',
    '',
    '```bash',
    aiderCmd,
    '```',
    '',
    'Then paste this prompt:',
    '',
    '> Fix the following GateTest findings. Address the root cause, not the symptom. Do not introduce new issues. Run the project test suite after each file if one exists.',
    '',
    '## Findings (use as the Cline / Aider task body)',
    '',
    body,
    '',
    '---',
    '_Generated by GateTest — gatetest.ai_',
  ].join('\n');
}

/**
 * GitHub Issue body — markdown formatted for filing one issue per
 * scan. Includes a "what is this" preamble (since GitHub Issues are
 * persistent and may be read by people who haven't used GateTest).
 */
function formatForGitHubIssue(findings, opts = {}) {
  const groups = groupByFile(findings);
  const c = counts(findings);
  const repoLine = opts.repoUrl ? `**Repo:** ${opts.repoUrl}` : '';
  const tierLine = opts.tier ? `**Tier:** ${opts.tier}` : '';
  const tsLine = `**Scanned:** ${new Date().toISOString()}`;
  const meta = [repoLine, tierLine, tsLine].filter(Boolean).join('  \n');

  const body = groups
    .map(([file, items]) => {
      const header = file === '(unattributed)'
        ? '### (findings without a file location)'
        : `### \`${file}\``;
      const rows = items
        .map((f) => `- [ ] **${f.severity.toUpperCase()}** ${formatLineRef(f)} ${f.message}`)
        .join('\n');
      return `${header}\n${rows}`;
    })
    .join('\n\n');

  return [
    '## GateTest scan results',
    '',
    meta,
    '',
    '> Filed automatically from a [GateTest](https://gatetest.ai) scan. GateTest runs 90 modules covering security, supply-chain, accessibility, infra hygiene, AI-app safety, and more.',
    '',
    `**Summary:** ${c.total} finding${c.total === 1 ? '' : 's'} — ${c.error} error${c.error === 1 ? '' : 's'}, ${c.warning} warning${c.warning === 1 ? '' : 's'}, ${c.info} info.`,
    '',
    '## Action items',
    '',
    body,
    '',
    '---',
    '_Generated by GateTest — gatetest.ai_',
  ].join('\n');
}

/**
 * Structured JSON dump. Stable schema for scripted consumers.
 */
function formatAsJson(findings, opts = {}) {
  const c = counts(findings);
  const groups = groupByFile(findings);
  const payload = {
    schema: 'gatetest-findings@1',
    generatedAt: new Date().toISOString(),
    repoUrl: opts.repoUrl || null,
    tier: opts.tier || null,
    counts: c,
    findings: findings.map((f) => ({
      id: f.id,
      module: f.module,
      severity: f.severity,
      file: f.file,
      line: f.line,
      message: f.message,
    })),
    byFile: groups.map(([file, items]) => ({
      file,
      counts: counts(items),
      findings: items.map((f) => ({
        module: f.module,
        severity: f.severity,
        line: f.line,
        message: f.message,
      })),
    })),
  };
  return JSON.stringify(payload, null, 2);
}

/**
 * Plain markdown checklist. Paste into any markdown surface: PRs,
 * Notion, Linear, Slack canvas, etc.
 */
function formatAsMarkdown(findings, opts = {}) {
  const groups = groupByFile(findings);
  const c = counts(findings);
  const ctx = renderContextHeader(opts);
  const body = groups
    .map(([file, items]) => {
      const header = file === '(unattributed)'
        ? '### (findings without a file location)'
        : `### \`${file}\``;
      const rows = items
        .map((f) => `- [ ] **${f.severity.toUpperCase()}** ${formatLineRef(f)} ${f.message}`)
        .join('\n');
      return `${header}\n${rows}`;
    })
    .join('\n\n');

  return [
    '# GateTest findings',
    '',
    ctx,
    `**${c.total}** finding${c.total === 1 ? '' : 's'} (${c.error}E / ${c.warning}W / ${c.info}I)`,
    '',
    body,
  ].join('\n');
}

/**
 * Single dispatch entry. Returns `{ content, filename, mimeType }`.
 * Throws for unknown format so the UI can show a clear error rather
 * than silently shipping the wrong thing.
 */
function formatHandoff(format, findings, opts = {}) {
  if (!SUPPORTED_FORMATS.includes(format)) {
    throw new Error(`Unsupported format: ${format}. Supported: ${SUPPORTED_FORMATS.join(', ')}`);
  }
  const safeFindings = Array.isArray(findings) ? findings : [];
  let content;
  switch (format) {
    case 'claude-code':  content = formatForClaudeCode(safeFindings, opts); break;
    case 'cursor':       content = formatForCursor(safeFindings, opts); break;
    case 'cline-aider':  content = formatForClineAider(safeFindings, opts); break;
    case 'github-issue': content = formatForGitHubIssue(safeFindings, opts); break;
    case 'json':         content = formatAsJson(safeFindings, opts); break;
    case 'markdown':     content = formatAsMarkdown(safeFindings, opts); break;
    default:             content = formatAsMarkdown(safeFindings, opts);
  }
  return {
    content,
    filename: FORMAT_FILENAMES[format],
    mimeType: format === 'json' ? 'application/json' : 'text/markdown',
  };
}

// ----------------------------------------------------------------------
// helpers
// ----------------------------------------------------------------------

function renderContextHeader(opts) {
  const lines = [];
  if (opts.repoUrl) lines.push(`**Repo:** ${opts.repoUrl}`);
  if (opts.tier) lines.push(`**Tier:** ${opts.tier}`);
  lines.push(`**Scanned:** ${new Date().toISOString()}`);
  return lines.join('  \n') + '\n';
}

function formatLineRef(f) {
  if (f.file && f.line) return `\`${f.file}:${f.line}\` —`;
  if (f.file) return `\`${f.file}\` —`;
  return '';
}

function shellQuote(s) {
  if (/^[A-Za-z0-9_./@+\-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

module.exports = {
  SUPPORTED_FORMATS,
  FORMAT_LABELS,
  FORMAT_FILENAMES,
  buildFindings,
  parseFinding,
  classifySeverity,
  groupByFile,
  counts,
  filterFindings,
  formatForClaudeCode,
  formatForCursor,
  formatForClineAider,
  formatForGitHubIssue,
  formatAsJson,
  formatAsMarkdown,
  formatHandoff,
};
