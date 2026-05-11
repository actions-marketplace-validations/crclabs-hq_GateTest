/**
 * PR + Branch pruner — cleans up stale GateTest-generated branches
 * and closed/merged PRs across one or more GitHub repositories.
 *
 * Usage (CLI):
 *   gatetest --prune-prs <owner/repo>
 *   gatetest --prune-prs <owner/repo> --prune-pattern "claude/"
 *   gatetest --prune-prs <owner/repo> --prune-dry-run
 *
 * Requires: GATETEST_GITHUB_TOKEN or GITHUB_TOKEN with repo + delete_branch scope.
 *
 * What it does:
 *   1. Lists all branches matching --prune-pattern (default: "gatetest/,claude/")
 *   2. For each branch, checks if its PR is closed or merged
 *   3. Closes any open PRs that are stale (no commits in 7+ days)
 *   4. Deletes branches whose PR is merged or closed
 *   5. Reports a clean summary
 */

'use strict';

const GITHUB_API = 'https://api.github.com';

class PrPruner {
  constructor(options = {}) {
    this.token     = options.token || process.env.GATETEST_GITHUB_TOKEN || process.env.GITHUB_TOKEN || '';
    this.patterns  = options.patterns || ['gatetest/', 'claude/'];
    this.dryRun    = options.dryRun || false;
    this.staledays = options.staleDays || 7;
  }

  async prune(owner, repo) {
    const report = {
      owner, repo,
      scanned: 0,
      closedPRs: [],
      deletedBranches: [],
      skipped: [],
      errors: [],
    };

    const branches = await this._listBranches(owner, repo);
    const matching = branches.filter(b => this.patterns.some(p => b.name.startsWith(p)));
    report.scanned = matching.length;

    for (const branch of matching) {
      try {
        await this._processBranch(owner, repo, branch, report);
      } catch (err) {
        report.errors.push({ branch: branch.name, error: err.message });
      }
    }

    return report;
  }

  async _processBranch(owner, repo, branch, report) {
    // Find PR for this branch
    const prs = await this._findPRsForBranch(owner, repo, branch.name);

    if (prs.length === 0) {
      // Branch with no PR — check age, delete if old enough
      const commit = await this._getCommit(owner, repo, branch.commit.sha);
      const age = this._ageInDays(commit.commit.committer.date);
      if (age >= this.staledays) {
        await this._deleteBranch(owner, repo, branch.name, report, 'no-pr');
      } else {
        report.skipped.push({ branch: branch.name, reason: `no-pr, only ${age}d old` });
      }
      return;
    }

    const pr = prs[0];

    if (pr.state === 'open') {
      // Open PR — check if stale
      const age = this._ageInDays(pr.updated_at);
      if (age >= this.staledays) {
        await this._closePR(owner, repo, pr.number, report);
        await this._deleteBranch(owner, repo, branch.name, report, 'stale-pr-closed');
      } else {
        report.skipped.push({ branch: branch.name, reason: `open PR #${pr.number}, only ${age}d old` });
      }
      return;
    }

    // PR is merged or closed — safe to delete branch
    await this._deleteBranch(owner, repo, branch.name, report, `pr-${pr.state}`);
  }

  // ── GitHub API helpers ───────────────────────────────────────────────────

  async _req(method, path, body = null) {
    const opts = {
      method,
      headers: {
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'GateTest-Pruner/1.0',
        ...(this.token ? { 'Authorization': `Bearer ${this.token}` } : {}),
      },
    };
    if (body) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(`${GITHUB_API}${path}`, opts);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`GitHub API ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  async _listBranches(owner, repo) {
    const all = [];
    let page = 1;
    while (true) {
      const batch = await this._req('GET', `/repos/${owner}/${repo}/branches?per_page=100&page=${page}`);
      if (!batch || batch.length === 0) break;
      all.push(...batch);
      if (batch.length < 100) break;
      page++;
    }
    return all;
  }

  async _findPRsForBranch(owner, repo, branchName) {
    // Search closed + open PRs for this head branch
    const [open, closed] = await Promise.all([
      this._req('GET', `/repos/${owner}/${repo}/pulls?state=open&head=${owner}:${encodeURIComponent(branchName)}&per_page=10`),
      this._req('GET', `/repos/${owner}/${repo}/pulls?state=closed&head=${owner}:${encodeURIComponent(branchName)}&per_page=10`),
    ]);
    return [...(open || []), ...(closed || [])];
  }

  async _getCommit(owner, repo, sha) {
    return this._req('GET', `/repos/${owner}/${repo}/commits/${sha}`);
  }

  async _closePR(owner, repo, prNumber, report) {
    if (this.dryRun) {
      report.closedPRs.push({ number: prNumber, dryRun: true });
      return;
    }
    await this._req('PATCH', `/repos/${owner}/${repo}/pulls/${prNumber}`, { state: 'closed' });
    report.closedPRs.push({ number: prNumber });
  }

  async _deleteBranch(owner, repo, branchName, report, reason) {
    if (this.dryRun) {
      report.deletedBranches.push({ branch: branchName, reason, dryRun: true });
      return;
    }
    await this._req('DELETE', `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branchName)}`);
    report.deletedBranches.push({ branch: branchName, reason });
  }

  _ageInDays(dateStr) {
    return Math.floor((Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24));
  }
}

module.exports = { PrPruner };
