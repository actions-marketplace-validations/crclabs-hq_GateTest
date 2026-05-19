/**
 * GitHub scan-result callback helper — dual-host Phase 2.
 *
 * After a scan triggered by a GitHub App webhook completes, this module
 * posts the result back to GitHub as:
 *   1. A commit status check (visible in the PR checks tab and branch
 *      protection rules).
 *   2. A PR comment with a formatted summary (only when the job came from
 *      a pull_request event, i.e. pull_request_number is set).
 *
 * Equivalent of gluecron-callback.js for the GitHub host path.
 *
 * Auth: GATETEST_GITHUB_TOKEN (preferred PAT) → GITHUB_TOKEN (fallback).
 * Requires `repo` scope to post statuses and PR comments on private repos;
 * public repos only need `public_repo`.
 *
 * Design rules (serverless):
 *   - Never throws. All errors are caught, logged, and returned as
 *     { sent: false, reason } so callers can log-and-move-on.
 *   - Uses global `fetch` (available in Next.js 13+ server routes).
 *   - `fetchImpl` override allows unit testing without real HTTP calls.
 */

const GITHUB_API = 'https://api.github.com';
const STATUS_CONTEXT = 'gatetest / scan';
const USER_AGENT = 'GateTest/1.0';

/**
 * Pick the best available GitHub token from env.
 * @param {Record<string, string|undefined>} env
 * @returns {string|null}
 */
function resolveGitHubToken(env) {
  return env.GATETEST_GITHUB_TOKEN || env.GITHUB_TOKEN || null;
}

/**
 * Map a scan result to a GitHub commit-status state.
 * @param {object} scanResult
 * @returns {'success'|'failure'|'error'}
 */
function toCommitState(scanResult) {
  if (!scanResult || scanResult.error) return 'error';
  if (scanResult.status !== 'complete') return 'error';
  // Any error-severity issue → failure; warnings alone → success.
  const modules = Array.isArray(scanResult.modules) ? scanResult.modules : [];
  const hasErrors = modules.some((m) => {
    const checks = Array.isArray(m.checks) ? m.checks : [];
    return checks.some((c) => c.severity === 'error');
  });
  return hasErrors ? 'failure' : 'success';
}

/**
 * Build the short status description (max 140 chars).
 * @param {object} scanResult
 * @returns {string}
 */
function buildDescription(scanResult) {
  if (!scanResult || scanResult.error) {
    return String(scanResult && scanResult.error ? scanResult.error : 'Scan failed').slice(0, 140);
  }
  const totalIssues = typeof scanResult.totalIssues === 'number' ? scanResult.totalIssues : 0;
  const modules = Array.isArray(scanResult.modules) ? scanResult.modules : [];
  const moduleCount = modules.length;
  if (totalIssues === 0) {
    return `All ${moduleCount} module${moduleCount === 1 ? '' : 's'} passed — 0 issues found`;
  }
  return `${totalIssues} issue${totalIssues === 1 ? '' : 's'} found across ${moduleCount} module${moduleCount === 1 ? '' : 's'}`.slice(0, 140);
}

/**
 * Linkify "path/to/file.ext:42" patterns in a detail string so each
 * finding is one click from the offending line in the GitHub UI.
 *
 * Matches the longest leading `relpath:line` token (no spaces, has a
 * known source extension or path separator), turns it into
 *   [`relpath:line`](https://github.com/owner/repo/blob/sha/relpath#L42)
 * and leaves the rest of the detail string as-is.
 *
 * @param {string} detail
 * @param {string} owner
 * @param {string} repo
 * @param {string} sha
 * @returns {string} markdown
 */
function linkifyFinding(detail, owner, repo, sha) {
  // Pattern: optional leading whitespace, then a path-like token
  // (letters/digits/underscores/dots/slashes/hyphens) ending in .ext,
  // followed by :line[:col]. Captures: path, line.
  const m = String(detail).match(
    /(^|[\s(])([A-Za-z0-9_./-]+\.[A-Za-z0-9]+):(\d+)(?::\d+)?\b/,
  );
  if (!m || !owner || !repo || !sha) return detail;
  const [matchedStr, lead, filePath, lineNum] = m;
  const url = `https://github.com/${owner}/${repo}/blob/${sha}/${filePath}#L${lineNum}`;
  const link = `[\`${filePath}:${lineNum}\`](${url})`;
  return detail.replace(matchedStr, `${lead}${link}`);
}

/**
 * Build a markdown PR comment body from a scan result.
 * @param {string} repository  "owner/name"
 * @param {string} sha
 * @param {object} scanResult
 * @param {string|null} [targetUrl]
 * @returns {string}
 */
function buildMarkdownComment(repository, sha, scanResult, targetUrl) {
  const ownerRepoParts = String(repository || '').split('/');
  const owner = ownerRepoParts[0] || '';
  const repoName = ownerRepoParts[1] || '';
  const state = toCommitState(scanResult);
  const icon = state === 'success' ? '✅' : state === 'failure' ? '❌' : '⚠️';
  const headline = state === 'success' ? 'All checks passed' : state === 'failure' ? 'Issues found' : 'Scan error';
  const shortSha = sha ? sha.slice(0, 7) : '???????';

  const lines = [
    `## ${icon} GateTest — ${headline}`,
    '',
    `**Commit:** \`${shortSha}\` · **Repo:** \`${repository}\``,
    '',
  ];

  if (scanResult && scanResult.error) {
    lines.push(`**Error:** ${String(scanResult.error).slice(0, 300)}`);
  } else {
    const modules = Array.isArray(scanResult && scanResult.modules) ? scanResult.modules : [];
    const totalIssues = typeof (scanResult && scanResult.totalIssues) === 'number' ? scanResult.totalIssues : 0;
    const durationSec = typeof (scanResult && scanResult.duration) === 'number'
      ? (scanResult.duration / 1000).toFixed(1)
      : '?';

    lines.push(`**${modules.length} modules** scanned in **${durationSec}s** — **${totalIssues} issue${totalIssues === 1 ? '' : 's'}** found`);
    lines.push('');

    // Modules with issues first, then passed modules (collapsed).
    const failed = modules.filter((m) => m.issues > 0 || m.status === 'failed');
    const passed = modules.filter((m) => m.issues === 0 && m.status !== 'failed');

    if (failed.length > 0) {
      lines.push('### Issues by module');
      lines.push('');
      for (const mod of failed.slice(0, 15)) {
        const modIssues = typeof mod.issues === 'number' ? mod.issues : '?';
        lines.push(`**\`${mod.name}\`** — ${modIssues} issue${modIssues === 1 ? '' : 's'}`);
        const details = Array.isArray(mod.details) ? mod.details : [];
        for (const d of details.slice(0, 3)) {
          // Linkify any leading "path:line" so the reader can click
          // straight to the offending line in the GitHub diff view.
          const linkified = linkifyFinding(String(d).slice(0, 240), owner, repoName, sha);
          lines.push(`  - ${linkified}`);
        }
        if (details.length > 3) {
          lines.push(`  - *…and ${details.length - 3} more*`);
        }
      }
      if (failed.length > 15) {
        lines.push('');
        lines.push(`*…and ${failed.length - 15} more modules with issues*`);
      }
    }

    if (passed.length > 0) {
      lines.push('');
      lines.push(`<details><summary>✅ ${passed.length} module${passed.length === 1 ? '' : 's'} passed</summary>`);
      lines.push('');
      lines.push(passed.map((m) => `\`${m.name}\``).join(', '));
      lines.push('');
      lines.push('</details>');
    }
  }

  if (targetUrl) {
    lines.push('');
    lines.push(`[View full report](${targetUrl})`);
  }

  // Auto-fix CTA — only on gate failure, only when scanResult doesn't
  // report a fix PR was already opened. Tells the customer how to flip
  // auto-repair on without leaving the PR. Composite-action customers
  // who already set ANTHROPIC_API_KEY have nothing to do — their auto-fix
  // job runs server-side and posts its own annotation; the website-side
  // callback can't see that state, so we keep the CTA short and honest.
  if (toCommitState(scanResult) === 'failure' && !scanResult?.autoFixPrUrl) {
    lines.push('');
    lines.push('<details><summary>Want these fixed automatically?</summary>');
    lines.push('');
    lines.push('Add `ANTHROPIC_API_KEY` as a repository or organisation secret. GateTest will diagnose every finding with Claude, write the fix, generate a regression test, and open a follow-up PR — all before you next refresh.');
    lines.push('');
    lines.push('1. Repo Settings → Secrets and variables → Actions → New repository secret');
    lines.push('2. Name: `ANTHROPIC_API_KEY` (get one at https://console.anthropic.com)');
    lines.push('3. Push again. The auto-fix PR opens within the same CI run.');
    lines.push('');
    lines.push('</details>');
  } else if (scanResult?.autoFixPrUrl) {
    lines.push('');
    lines.push(`🤖 **Auto-fix PR opened:** ${scanResult.autoFixPrUrl}`);
  }

  lines.push('');
  lines.push('---');
  lines.push('*Posted by [GateTest](https://gatetest.ai) — unified code quality*');

  return lines.join('\n');
}

/**
 * POST a commit status to GitHub.
 * @returns {Promise<{ok: boolean, status?: number, reason?: string}>}
 */
async function postCommitStatus({ owner, repo, sha, state, description, targetUrl, token, fetchImpl }) {
  const body = JSON.stringify({
    state,
    description: description.slice(0, 140),
    context: STATUS_CONTEXT,
    ...(targetUrl ? { target_url: targetUrl } : {}),
  });

  try {
    const res = await fetchImpl(`${GITHUB_API}/repos/${owner}/${repo}/statuses/${sha}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
      },
      body,
    });
    if (res.status !== 201) {
      console.error(`[github-callback] setCommitStatus non-201: ${res.status} for ${owner}/${repo}@${sha.slice(0, 7)}`);
      return { ok: false, status: res.status, reason: 'non-201' };
    }
    return { ok: true, status: 201 };
  } catch (err) {
    console.error('[github-callback] setCommitStatus fetch error:', err && err.message ? err.message : err);
    return { ok: false, reason: 'fetch-error' };
  }
}

/**
 * POST a PR comment to GitHub.
 * @returns {Promise<{ok: boolean, status?: number, reason?: string}>}
 */
async function postPrComment({ owner, repo, prNumber, body, token, fetchImpl }) {
  try {
    const res = await fetchImpl(`${GITHUB_API}/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify({ body }),
    });
    if (res.status !== 201) {
      console.error(`[github-callback] addPrComment non-201: ${res.status} for ${owner}/${repo}#${prNumber}`);
      return { ok: false, status: res.status, reason: 'non-201' };
    }
    return { ok: true, status: 201 };
  } catch (err) {
    console.error('[github-callback] addPrComment fetch error:', err && err.message ? err.message : err);
    return { ok: false, reason: 'fetch-error' };
  }
}

/**
 * Fire-and-forget GitHub feedback after a scan completes.
 * Posts a commit status and (when triggered by a PR) a formatted PR comment.
 * Never throws.
 *
 * @param {object} opts
 * @param {string} opts.repository         "owner/name"
 * @param {string} opts.sha                full 40-char commit SHA
 * @param {string|null} [opts.ref]
 * @param {number|null} [opts.pullRequestNumber]
 * @param {object} opts.scanResult
 * @param {typeof fetch} [opts.fetchImpl]  override for testing
 * @param {Record<string, string|undefined>} [opts.env]
 * @returns {Promise<{statusSent: boolean, commentSent: boolean, reason?: string}>}
 */
async function sendGithubCallback(opts) {
  const env = opts.env || process.env;
  const token = resolveGitHubToken(env);

  if (!token) {
    console.warn('[github-callback] no GitHub token configured — skipping feedback');
    return { statusSent: false, commentSent: false, reason: 'no-token' };
  }

  const { repository, sha, pullRequestNumber, scanResult } = opts;

  if (!repository || !sha) {
    return { statusSent: false, commentSent: false, reason: 'missing-repo-or-sha' };
  }

  const parts = repository.split('/');
  if (parts.length !== 2) {
    return { statusSent: false, commentSent: false, reason: 'invalid-repository' };
  }
  const [owner, repo] = parts;

  const doFetch = opts.fetchImpl || fetch;
  const baseUrl = env.NEXT_PUBLIC_BASE_URL || 'https://gatetest.ai';
  const targetUrl = `${baseUrl}/scan/status`;

  const state = toCommitState(scanResult);
  const description = buildDescription(scanResult);

  const statusResult = await postCommitStatus({
    owner, repo, sha, state, description, targetUrl, token, fetchImpl: doFetch,
  });

  let commentResult = { ok: false, reason: 'no-pr' };
  if (pullRequestNumber && typeof pullRequestNumber === 'number') {
    const body = buildMarkdownComment(repository, sha, scanResult, targetUrl);
    commentResult = await postPrComment({
      owner, repo, prNumber: pullRequestNumber, body, token, fetchImpl: doFetch,
    });
  }

  return {
    statusSent: statusResult.ok,
    commentSent: commentResult.ok,
    ...(statusResult.reason ? { statusReason: statusResult.reason } : {}),
    ...(commentResult.reason ? { commentReason: commentResult.reason } : {}),
  };
}

module.exports = {
  resolveGitHubToken,
  toCommitState,
  buildDescription,
  buildMarkdownComment,
  linkifyFinding,
  sendGithubCallback,
};
