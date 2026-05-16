'use strict';

/**
 * Drift-alert email template.
 *
 * Renders a scan-diff into a customer-friendly email (markdown body +
 * subject line). The diff comes from scan-diff.js. The output is a
 * pure structure — the email-sending side is wired separately, since
 * email-provider choice is a Boss Rule decision.
 *
 * Output shape lets the caller decide whether to render as HTML, plain
 * text, or both, depending on the provider.
 */

const DIRECTION_EMOJI = { up: '🟢', down: '🔴', flat: '⚪' };
const GRADE_EMOJI = { A: '🌟', B: '👌', C: '👀', D: '⚠️', F: '🚨' };

/**
 * @param {Object} opts
 * @param {string} opts.targetUrl
 * @param {string} opts.customerName       — display name for the salutation
 * @param {ReturnType<typeof require('./scan-diff').diffScans>} opts.diff
 * @param {string}  [opts.dashboardUrl]    — link to the customer's history
 * @param {string}  [opts.unsubscribeUrl]
 * @returns {{ subject: string, markdown: string, plainText: string }}
 */
function renderDriftAlert(opts) {
  const { targetUrl, customerName, diff, dashboardUrl, unsubscribeUrl } = opts;
  const score = diff.scoreChange;

  // ── Subject line ─────────────────────────────────────────────────────
  let subject;
  if (diff.regression && score.delta != null && score.delta <= -5) {
    subject = `🔴 ${targetUrl} health score dropped ${Math.abs(score.delta)} points (now ${score.to}/${score.gradeTo})`;
  } else if (diff.regression) {
    subject = `🔴 New issues found on ${targetUrl}`;
  } else if (diff.improvement) {
    subject = `🟢 ${targetUrl} health score improved (${score.from} → ${score.to})`;
  } else if (diff.resolvedFindings.length > 0 && diff.newFindings.length === 0) {
    subject = `🟢 Issues resolved on ${targetUrl}`;
  } else {
    subject = `Weekly scan report for ${targetUrl}`;
  }

  // ── Markdown body ────────────────────────────────────────────────────
  const lines = [];
  const greeting = customerName ? `Hi ${customerName},` : 'Hi,';
  lines.push(greeting);
  lines.push('');
  lines.push(`We just re-scanned **${targetUrl}** and here's what changed since last time.`);
  lines.push('');

  // Score change card
  const dirEmoji = DIRECTION_EMOJI[score.direction] || '⚪';
  if (score.from != null && score.to != null) {
    lines.push('## Health Score');
    lines.push('');
    const gradeIconFrom = GRADE_EMOJI[score.gradeFrom] || '';
    const gradeIconTo = GRADE_EMOJI[score.gradeTo] || '';
    lines.push(`${gradeIconFrom} **${score.from} / ${score.gradeFrom}** &nbsp;→&nbsp; ${gradeIconTo} **${score.to} / ${score.gradeTo}**`);
    if (score.delta !== 0) {
      const sign = score.delta > 0 ? '+' : '';
      lines.push('');
      lines.push(`Change: ${dirEmoji} **${sign}${score.delta} points**`);
    }
    lines.push('');
  }

  // New findings
  if (diff.newFindings.length > 0) {
    lines.push(`## 🔴 ${diff.newFindings.length} new issue${diff.newFindings.length === 1 ? '' : 's'} since last scan`);
    lines.push('');
    diff.newFindings.slice(0, 15).forEach((f, i) => {
      const sevTag = f.severity === 'error' ? '**[ERROR]**' : f.severity === 'warning' ? '*[Warning]*' : '[Info]';
      const flag = f.highSignal ? ' 🔥' : '';
      const count = f.instanceCount && f.instanceCount > 1 ? ` × ${f.instanceCount}` : '';
      lines.push(`${i + 1}. ${sevTag}${flag} ${f.title}${count}`);
      if (f.ruleKey) lines.push(`   - Rule: \`${f.ruleKey}\``);
    });
    if (diff.newFindings.length > 15) {
      lines.push(`   _… + ${diff.newFindings.length - 15} more_`);
    }
    lines.push('');
  }

  // Resolved findings
  if (diff.resolvedFindings.length > 0) {
    lines.push(`## 🟢 ${diff.resolvedFindings.length} issue${diff.resolvedFindings.length === 1 ? '' : 's'} resolved`);
    lines.push('');
    diff.resolvedFindings.slice(0, 10).forEach((f, i) => {
      lines.push(`${i + 1}. ${f.title}`);
    });
    if (diff.resolvedFindings.length > 10) {
      lines.push(`   _… + ${diff.resolvedFindings.length - 10} more_`);
    }
    lines.push('');
  }

  // Persistent ones — worth surfacing if count moved meaningfully
  const movedPersistent = diff.persistentFindings.filter((p) => Math.abs(p.countDelta) >= 2);
  if (movedPersistent.length > 0) {
    lines.push('## 📊 Existing issues that moved');
    lines.push('');
    movedPersistent.slice(0, 10).forEach((p) => {
      const dir = p.countDelta > 0 ? `+${p.countDelta} occurrence(s)` : `${p.countDelta} (fewer)`;
      lines.push(`- ${p.current.title} — ${dir}`);
    });
    lines.push('');
  }

  if (
    diff.newFindings.length === 0 &&
    diff.resolvedFindings.length === 0 &&
    movedPersistent.length === 0
  ) {
    lines.push('## No change since last scan');
    lines.push('');
    lines.push('Your site\'s scan looks identical to last week. That\'s a good sign — no regressions, no new vulnerabilities or quality issues introduced.');
    lines.push('');
  }

  // Footer
  lines.push('---');
  if (dashboardUrl) {
    lines.push(`📈 [View full history and trends →](${dashboardUrl})`);
  }
  if (unsubscribeUrl) {
    lines.push('');
    lines.push(`[Unsubscribe](${unsubscribeUrl}) — you'll stop receiving these alerts immediately.`);
  }

  const markdown = lines.join('\n');

  // Plain-text version — strip markdown decorators (headings, bold, code).
  const plainText = markdown
    .replace(/^#+\s*/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/&nbsp;/g, ' ');

  return { subject, markdown, plainText };
}

module.exports = { renderDriftAlert };
