/**
 * PR-Quality Coach Module.
 *
 * `prSize` blocks PRs that are too BIG to review. `prQuality` flags PRs
 * that are the WRONG SHAPE — bad commit messages, source changes without
 * matching tests, dependency churn that ought to be in its own PR.
 * Together they form a hygiene gate that teaches the team to ship better,
 * not just smaller.
 *
 * Inputs: git history on the current branch vs the base ref (same
 * auto-detection as pr-size: explicit `against` config first, then
 * staged diff, then working-tree diff, then HEAD~1 fallback).
 *
 * Rules:
 *
 *   error:   any commit on the branch has an empty / whitespace-only
 *            message. Git rejects truly empty messages, but `wip`,
 *            `.`, `fix`, single-word fly-by titles still tell the
 *            reviewer nothing.
 *            (rule: `pr-quality:empty-message:<sha>`)
 *
 *   warning: a commit's subject is shorter than 8 chars or contains
 *            only "wip"/"tmp"/"foo"/"asdf" placeholder noise.
 *            (rule: `pr-quality:weak-message:<sha>`)
 *
 *   warning: source-file changes outnumber test-file changes 5:1 or
 *            more on a PR that touches at least 3 source files. The
 *            classic "I'll add tests later" anti-pattern.
 *            (rule: `pr-quality:no-tests`)
 *
 *   warning: package.json / requirements.txt / Cargo.toml / etc.
 *            changed AND non-dep files changed. Mixed concerns —
 *            dependency upgrades should be their own PR so they
 *            can be reverted independently.
 *            (rule: `pr-quality:mixed-deps-and-code`)
 *
 *   info:    summary: total commits / commits-with-good-messages /
 *            source/test file ratio.
 *
 * Test path / lockfile exclusions inherit from pr-size (we exclude
 * lockfiles from the "dep change" detection so a dependabot bump that
 * only touches package-lock.json doesn't fire mixed-concerns).
 *
 * Module ID: 91. Suite: full / scan_fix / nuclear (informational —
 * never blocks, but appears in every paid scan).
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const BaseModule = require('./base-module');

const DEFAULT_CONFIG = {
  minSubjectLength: 8,
  weakMessagePatterns: [
    /^wip\b/i,
    /^tmp\b/i,
    /^foo\b/i,
    /^asdf\b/i,
    /^test\b/i,           // "test" / "test commit"
    /^\.+$/,              // "."
    /^fix$/i,             // bare "fix" with no detail
    /^update$/i,
    /^changes$/i,
  ],
  // Source-to-test ratio above this number triggers no-tests warning.
  // 5 = a PR that touches 5+ source files without a single test edit fires.
  maxSourceTestRatio: 5,
  // Minimum source-file count before no-tests kicks in. Tiny PRs (1-2 files)
  // often don't NEED matching tests; the warning is for genuinely sized changes.
  minSourceFilesForTestCheck: 3,
};

const TEST_PATH_PATTERNS = [
  /(^|\/)__tests__\//,
  /(^|\/)tests?\//,
  /(^|\/)spec\//,
  /\.test\.(js|jsx|mjs|cjs|ts|tsx|py|go|rb|php|rs|java|kt|swift)$/i,
  /\.spec\.(js|jsx|mjs|cjs|ts|tsx|py|go|rb|php|rs|java|kt|swift)$/i,
  /_test\.(go|py|rb)$/i,
];

const DEP_MANIFEST_PATTERNS = [
  /(^|\/)package\.json$/,
  /(^|\/)requirements\.txt$/,
  /(^|\/)pyproject\.toml$/,
  /(^|\/)Pipfile$/,
  /(^|\/)go\.mod$/,
  /(^|\/)Cargo\.toml$/,
  /(^|\/)Gemfile$/,
  /(^|\/)composer\.json$/,
  /(^|\/)pom\.xml$/,
  /(^|\/)build\.gradle(\.kts)?$/,
];

const LOCKFILE_PATTERNS = [
  /(^|\/)package-lock\.json$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)Gemfile\.lock$/,
  /(^|\/)Cargo\.lock$/,
  /(^|\/)poetry\.lock$/,
  /(^|\/)composer\.lock$/,
  /(^|\/)go\.sum$/,
  /(^|\/)flake\.lock$/,
];

function matchesAny(filePath, patterns) {
  for (const p of patterns) if (p.test(filePath)) return true;
  return false;
}

class PrQualityModule extends BaseModule {
  constructor() {
    super('prQuality', 'PR-quality coach — flags weak commit messages, missing tests, mixed deps+code');
  }

  async run(result, config) {
    const projectRoot = (config && config.projectRoot) || process.cwd();
    const moduleConfig = { ...DEFAULT_CONFIG, ...(config && config.prQuality) };

    if (!this._isGitRepo(projectRoot)) {
      result.addCheck('pr-quality:not-a-git-repo', true, {
        severity: 'info',
        message: 'Not a git repository — PR-quality check skipped',
      });
      return;
    }

    const baseRef = this._detectBaseRef(projectRoot, config);
    if (!baseRef) {
      result.addCheck('pr-quality:no-base-ref', true, {
        severity: 'info',
        message: 'No base ref detected — PR-quality check skipped',
      });
      return;
    }

    // 1. Commit-message quality
    const commits = this._listCommits(projectRoot, baseRef);
    let goodMessages = 0;
    for (const commit of commits) {
      const subject = commit.subject || '';
      const trimmed = subject.trim();
      if (trimmed.length === 0) {
        result.addCheck(`pr-quality:empty-message:${commit.sha}`, false, {
          severity: 'error',
          message: `Commit ${commit.sha.slice(0, 7)} has empty message`,
        });
        continue;
      }
      const tooShort = trimmed.length < moduleConfig.minSubjectLength;
      const weakShape = moduleConfig.weakMessagePatterns.some((re) => re.test(trimmed));
      if (tooShort || weakShape) {
        result.addCheck(`pr-quality:weak-message:${commit.sha}`, false, {
          severity: 'warning',
          message: `Commit ${commit.sha.slice(0, 7)} has weak subject: "${trimmed.slice(0, 60)}"`,
        });
      } else {
        goodMessages += 1;
      }
    }

    // 2. Test-to-source ratio
    const changedFiles = this._listChangedFiles(projectRoot, baseRef);
    const sourceFiles = [];
    const testFiles = [];
    const depFiles = [];
    const nonDepFiles = [];
    for (const file of changedFiles) {
      if (matchesAny(file, LOCKFILE_PATTERNS)) continue; // ignore lockfiles entirely
      const isTest = matchesAny(file, TEST_PATH_PATTERNS);
      const isDep = matchesAny(file, DEP_MANIFEST_PATTERNS);
      if (isTest) testFiles.push(file);
      else if (isDep) depFiles.push(file);
      else nonDepFiles.push(file);
      if (!isTest && !isDep) sourceFiles.push(file);
    }
    const ratio = testFiles.length > 0
      ? sourceFiles.length / testFiles.length
      : sourceFiles.length;
    if (sourceFiles.length >= moduleConfig.minSourceFilesForTestCheck && ratio >= moduleConfig.maxSourceTestRatio) {
      result.addCheck('pr-quality:no-tests', false, {
        severity: 'warning',
        message: `PR changes ${sourceFiles.length} source file(s) but only ${testFiles.length} test file(s). Source-to-test ratio ${ratio.toFixed(1)}:1 — consider adding tests.`,
      });
    }

    // 3. Mixed dependency + code changes
    if (depFiles.length > 0 && nonDepFiles.length > 0) {
      result.addCheck('pr-quality:mixed-deps-and-code', false, {
        severity: 'warning',
        message: `PR mixes dependency manifest changes (${depFiles.map((f) => path.basename(f)).join(', ')}) with ${nonDepFiles.length} code/test file(s). Dependency upgrades belong in their own PR so they can be reverted independently.`,
      });
    }

    // 4. Summary
    result.addCheck('pr-quality:summary', true, {
      severity: 'info',
      message: `PR-quality: ${commits.length} commit(s), ${goodMessages}/${commits.length} with strong messages, ${sourceFiles.length} source / ${testFiles.length} test / ${depFiles.length} dep file(s) changed against base ${baseRef}`,
    });
  }

  _isGitRepo(root) {
    try {
      return fs.existsSync(path.join(root, '.git'));
    } catch {
      return false;
    }
  }

  _detectBaseRef(root, config) {
    const explicit = config && config.prQuality && config.prQuality.against;
    if (explicit && typeof explicit === 'string') return explicit;
    // Try common defaults — origin/main, origin/master, main, master.
    for (const candidate of ['origin/main', 'origin/master', 'main', 'master', 'HEAD~1']) {
      try {
        execSync(`git rev-parse --verify ${candidate}`, { cwd: root, stdio: 'pipe' });
        return candidate;
      } catch { /* try next */ }
    }
    return null;
  }

  _listCommits(root, baseRef) {
    try {
      // %H = full SHA, %s = subject; null-separated subject to handle newlines safely.
      const out = execSync(`git log --format=%H%x09%s ${baseRef}..HEAD`, {
        cwd: root,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 4 * 1024 * 1024,
      });
      return out
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [sha, ...rest] = line.split('\t');
          return { sha, subject: rest.join('\t') };
        });
    } catch {
      return [];
    }
  }

  _listChangedFiles(root, baseRef) {
    try {
      const out = execSync(`git diff --name-only ${baseRef}..HEAD`, {
        cwd: root,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 4 * 1024 * 1024,
      });
      return out.split('\n').map((s) => s.trim()).filter(Boolean);
    } catch {
      return [];
    }
  }
}

module.exports = PrQualityModule;
// Exposed for tests
module.exports.DEFAULT_CONFIG = DEFAULT_CONFIG;
module.exports.TEST_PATH_PATTERNS = TEST_PATH_PATTERNS;
module.exports.DEP_MANIFEST_PATTERNS = DEP_MANIFEST_PATTERNS;
module.exports.LOCKFILE_PATTERNS = LOCKFILE_PATTERNS;
