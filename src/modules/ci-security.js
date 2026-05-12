/**
 * CI Security Module — hardens GitHub Actions / GitLab CI workflows.
 *
 * Supply-chain attackers target CI before application code — pinning,
 * permissions, and untrusted-input handling are the three big wins this
 * module enforces across every `.github/workflows/*.yml` and
 * `.gitlab-ci.yml` in the repo.
 *
 * Rules implemented (all line-heuristic, zero network, zero deps):
 *   - `uses: owner/action@<branch>` — pin to a SHA or at least a tag
 *   - `pull_request_target` trigger — warns, then errors if checkout
 *     pulls the PR head commit (the pwn-request sink)
 *   - `run:` containing `${{ github.event.* }}` / `${{ github.head_ref }}`
 *     — shell injection surface
 *   - `run:` echoing `${{ secrets.* }}` — leaks to logs
 *   - `continue-on-error: true` on a step that runs `gatetest` —
 *     explicitly forbidden by the Bible (Forbidden #24: never soft-fail
 *     the gate)
 *   - Workflow missing a top-level `permissions:` block — default
 *     GITHUB_TOKEN is read/write which is rarely needed
 *
 * TODO(gluecron): when Gluecron ships a CI model, mirror these heuristics
 * to Gluecron pipeline YAML (same attack surface, different filename).
 */

const fs = require('fs');
const path = require('path');
const BaseModule = require('./base-module');

// Pinned short SHA or full SHA — 7-40 hex chars.
const SHA_REGEX = /^[a-f0-9]{7,40}$/i;
// Semver-ish tags like v1, v1.2, v1.2.3, 2.0.0, v3-foo — prefer these
// over branch names, but still warn (SHA is the gold standard).
const TAG_LOOKS_SEMVER = /^v?\d+(\.\d+)*([.-][A-Za-z0-9_.-]+)?$/;
// Pull-request-target + untrusted checkout is the classic pwn-request.
const DANGEROUS_PR_REF = /github\.event\.pull_request\.head\.(sha|ref)|github\.head_ref/;

class CiSecurityModule extends BaseModule {
  constructor() {
    super('ciSecurity', 'CI Security — action pinning, pwn-request, shell injection, secrets-in-logs, permissions, forbidden soft-fail');
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;
    const files = this._findWorkflows(projectRoot);

    if (files.length === 0) {
      result.addCheck('ci-security:no-files', true, {
        severity: 'info',
        message: 'No CI workflow files found — skipping',
      });
      return;
    }

    result.addCheck('ci-security:scanning', true, {
      severity: 'info',
      message: `Scanning ${files.length} CI workflow file(s)`,
    });

    let totalIssues = 0;
    for (const file of files) {
      totalIssues += this._scanFile(file, projectRoot, result);
    }

    result.addCheck('ci-security:summary', true, {
      severity: 'info',
      message: `CI security scan: ${files.length} file(s), ${totalIssues} issue(s)`,
    });
  }

  _findWorkflows(projectRoot) {
    const out = [];
    const workflowsDir = path.join(projectRoot, '.github', 'workflows');
    if (fs.existsSync(workflowsDir)) {
      for (const name of fs.readdirSync(workflowsDir)) {
        if (/\.ya?ml$/i.test(name)) out.push(path.join(workflowsDir, name));
      }
    }
    const gitlab = path.join(projectRoot, '.gitlab-ci.yml');
    if (fs.existsSync(gitlab)) out.push(gitlab);
    return out;
  }

  _scanFile(file, projectRoot, result) {
    let content;
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch {
      return 0;
    }

    const rel = path.relative(projectRoot, file);
    const lines = content.split('\n');
    let issues = 0;

    let hasPermissionsBlock = false;
    let hasPullRequestTarget = false;
    let hasCheckoutPrHead = false;
    let isGitHubActions = rel.includes(path.join('.github', 'workflows'));

    // Track the most recent step name so continue-on-error diagnostics
    // can reference the step.
    let lastRun = '';

    for (let i = 0; i < lines.length; i += 1) {
      const raw = lines[i];
      const line = raw.replace(/\s+$/, '');
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      // Top-level permissions detection (left-most indentation).
      if (/^permissions\s*:/.test(line)) hasPermissionsBlock = true;

      // Event triggers
      if (isGitHubActions && /^\s*pull_request_target\s*:/.test(line)) {
        hasPullRequestTarget = true;
      }

      // `uses: ...` pinning check
      const usesMatch = trimmed.match(/^(?:-\s*)?uses\s*:\s*['"]?([^'"#\s]+)['"]?/);
      if (usesMatch) {
        const ref = usesMatch[1];
        // Skip Docker-ref `docker://...` and local paths (`./...`, `./.github/...`)
        if (!/^(docker:|\.\/|\.\.\/)/.test(ref) && ref.includes('@')) {
          const [, version] = ref.split('@');
          if (!version) {
            // "uses: owner/action" with no ref — implicit default branch
            issues += this._flag(result, `ci-security:unpinned:no-ref:${rel}:${i + 1}`, {
              severity: 'warning',
              file: rel,
              line: i + 1,
              message: `"${ref}" has no @ref — defaults to the action's default branch (non-reproducible)`,
              suggestion: 'Pin to a full commit SHA (preferred) or a release tag.',
            });
          } else if (SHA_REGEX.test(version)) {
            // Good — SHA pin.
          } else if (TAG_LOOKS_SEMVER.test(version)) {
            // Acceptable, but worth a gentle info note: semver tags can be moved.
            issues += this._flag(result, `ci-security:tag-pin:${rel}:${i + 1}`, {
              severity: 'info',
              file: rel,
              line: i + 1,
              message: `"${ref}" pinned to a semver tag — tags are mutable; SHA pinning is safer`,
              suggestion: 'Run `gh api /repos/OWNER/REPO/commits/<tag> --jq .sha` to get the SHA and pin to it.',
            });
          } else {
            // Anything else = branch name / unknown.
            issues += this._flag(result, `ci-security:branch-pin:${rel}:${i + 1}`, {
              severity: 'error',
              file: rel,
              line: i + 1,
              message: `"${ref}" pinned to a branch/non-version ref — the action can change under you at any time (supply-chain risk)`,
              suggestion: 'Pin to a specific commit SHA or an immutable tag.',
            });
          }
        }

        // PR-target + untrusted checkout sink
        if (/actions\/checkout/i.test(ref)) {
          // Look ahead a few lines for a `ref: ${{ ... head ... }}` line
          for (let j = i + 1; j < Math.min(i + 12, lines.length); j += 1) {
            if (DANGEROUS_PR_REF.test(lines[j])) {
              hasCheckoutPrHead = true;
              break;
            }
          }
        }
      }

      // `run:` line — track as "last run" and scan for injection / secrets
      if (/^\s*(?:-\s*)?run\s*:/.test(line)) {
        lastRun = trimmed;
        issues += this._scanRunInjection(line, lines, i, rel, result);
      }

      // continue-on-error: true on the gate step
      if (/^\s*continue-on-error\s*:\s*true\b/i.test(line)) {
        // Walk back to the start of THIS step (most recent line beginning
        // with "-" at the step indent), capped at 30 lines for a bounded
        // scan. Then look for gatetest *as an executable* — name: or run:
        // lines referring to the GateTest CLI. Path references inside
        // `with:`/`sarif_file:` (e.g. `.gatetest/reports/`) are not the
        // gate itself, just an output directory, and must not trigger.
        let stepStart = i;
        for (let j = i - 1; j >= Math.max(0, i - 30); j -= 1) {
          if (/^\s*-\s/.test(lines[j])) {
            stepStart = j;
            break;
          }
        }
        const stepBody = lines.slice(stepStart, i);
        const runsGate = stepBody.some((l) =>
          /^\s*(?:-\s*)?(?:name|run|uses)\s*:\s*[^\n]*\bgatetest\b/i.test(l)
        );
        if (runsGate) {
          issues += this._flag(result, `ci-security:soft-fail-gate:${rel}:${i + 1}`, {
            severity: 'error',
            file: rel,
            line: i + 1,
            message: '`continue-on-error: true` on a GateTest step — Bible Forbidden #24: never soft-fail the gate',
            suggestion: 'Remove `continue-on-error` on the GateTest step. If the gate fails, the build MUST fail.',
          });
        }
      }
    }

    if (isGitHubActions && !hasPermissionsBlock) {
      issues += this._flag(result, `ci-security:no-permissions:${rel}`, {
        severity: 'warning',
        file: rel,
        message: `${rel} has no top-level \`permissions:\` block — GITHUB_TOKEN defaults to broad read/write scopes`,
        suggestion: 'Add `permissions: { contents: read }` at the top and opt in to only the scopes each job needs.',
      });
    }

    if (hasPullRequestTarget && hasCheckoutPrHead) {
      issues += this._flag(result, `ci-security:pwn-request:${rel}`, {
        severity: 'error',
        file: rel,
        message: `${rel} uses \`pull_request_target\` AND checks out the PR head — classic pwn-request RCE pattern`,
        suggestion: 'Either use `pull_request` instead, or do not check out the untrusted head in a privileged context.',
      });
    } else if (hasPullRequestTarget) {
      issues += this._flag(result, `ci-security:pr-target:${rel}`, {
        severity: 'warning',
        file: rel,
        message: `${rel} uses \`pull_request_target\` — runs with write tokens and repo secrets; audit carefully`,
        suggestion: 'Prefer `pull_request` unless you genuinely need PR-write permissions. Never check out the PR head in the same job.',
      });
    }

    // Ensure we reference lastRun somewhere so lint doesn't complain.
    void lastRun;

    return issues;
  }

  /**
   * Scan a `run:` line and (for pipe `|` blocks) the lines that follow it
   * for shell-injection and secrets-echo patterns.
   */
  _scanRunInjection(startLine, lines, startIdx, rel, result) {
    let issues = 0;
    const block = [startLine];
    // If it's a block scalar (| or >) collect until indentation drops.
    const indentMatch = startLine.match(/^(\s*)/);
    const baseIndent = indentMatch ? indentMatch[1].length : 0;
    if (/run\s*:\s*[|>]/.test(startLine)) {
      for (let j = startIdx + 1; j < lines.length; j += 1) {
        const l = lines[j];
        if (!l.trim()) { block.push(l); continue; }
        const ind = l.match(/^(\s*)/)[1].length;
        if (ind <= baseIndent) break;
        block.push(l);
      }
    }

    for (let k = 0; k < block.length; k += 1) {
      const l = block[k];
      const lineNo = startIdx + 1 + k;
      if (/\$\{\{\s*github\.event\./.test(l) || /\$\{\{\s*github\.head_ref\s*\}\}/.test(l)) {
        issues += this._flag(result, `ci-security:shell-injection:${rel}:${lineNo}`, {
          severity: 'error',
          file: rel,
          line: lineNo,
          message: 'Untrusted GitHub event data interpolated into a shell script — command injection risk',
          suggestion: 'Assign to an env var via `env:` with ${{ github.event.* }} and reference it as $VAR in the shell. GitHub Actions expansion into a shell is unsafe.',
        });
      }
      if (/\becho\b.*\$\{\{\s*secrets\./.test(l)) {
        issues += this._flag(result, `ci-security:secret-echo:${rel}:${lineNo}`, {
          severity: 'error',
          file: rel,
          line: lineNo,
          message: 'Secret piped to `echo` — shows up in logs and in any downstream action that reads stdout',
          suggestion: 'Never echo secrets. Pass them via env vars; GitHub masks them but logs can still leak transformed versions.',
        });
      }
    }
    return issues;
  }

  _flag(result, name, details) {
    result.addCheck(name, false, details);
    return 1;
  }
}

module.exports = CiSecurityModule;
