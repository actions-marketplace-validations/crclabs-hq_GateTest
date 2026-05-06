/**
 * Phase 6.2.11 — dependency-upgrade + breaking-change patcher.
 *
 * The most common maintenance burden in any codebase: a major-version bump
 * breaks API call sites. `axios` v1 changed `.get(url, {params})` option
 * shapes. `react-router` v6 changed `<Switch>` to `<Routes>`. `next` v13+
 * moved pages to the App Router. Teams either stay pinned (accumulate debt)
 * or manually hunt every call site (takes days).
 *
 * This module automates that loop:
 *   1. Detect outdated dependencies via package.json + npm dist-tags
 *      (or a pre-populated `outdatedDeps` input from the scan).
 *   2. For each dep with a major-version gap, ask Claude to enumerate the
 *      BREAKING API changes between the installed and latest version.
 *   3. Scan every source file for usage of that dep's exported API.
 *   4. Ask Claude to patch each affected call site to the new API.
 *   5. Run the cross-fix syntax gate on every patched file.
 *   6. Return structured results: upgraded deps, patched files, skipped
 *      files, Claude cost estimate.
 *
 * Designed to run inside `/api/scan/fix` at the Nuclear tier ONLY — it calls
 * Claude multiple times per dep and can be expensive. Guard: caller must
 * pass `tier === "nuclear"`.
 *
 * Dependency injection: `askClaude` is passed in so tests run offline.
 *
 * RELIABILITY CONTRACT:
 *   - Per-dep failures are caught and surfaced in errors[]; they never
 *     block other deps from being processed.
 *   - Syntax gate failure rolls back the patch for that file (no broken
 *     code ships).
 *   - Hard cap: MAX_DEPS_PER_RUN to bound Anthropic spend per call.
 */

const { pickChecker } = require('./cross-fix-syntax-gate');

const MAX_DEPS_PER_RUN = 3;
const MAX_FILES_PER_DEP = 10;
const MAX_FILE_BYTES = 80 * 1024; // 80KB — skip huge generated files

const MAJOR_BREAKING_THRESHOLD = 1; // only process major-version gaps ≥ 1

/**
 * Parse a semver string and extract the major version number.
 * Returns null when the string is not parseable (workspace:*, file:, etc.).
 */
function parseMajor(versionStr) {
  if (!versionStr) return null;
  const cleaned = versionStr.replace(/^[^0-9]*/, '');
  const match = cleaned.match(/^(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Determine which deps have a major-version gap between installed and latest.
 *
 * @param {Object} installedVersions - { depName: "1.2.3", ... }
 * @param {Object} latestVersions    - { depName: "3.0.0", ... }
 * @returns {Array<{ name, installed, latest, gapMajors }>}
 */
function findMajorUpgrades(installedVersions, latestVersions) {
  const upgrades = [];
  for (const [name, installed] of Object.entries(installedVersions)) {
    const latest = latestVersions[name];
    if (!latest) continue;
    const installedMajor = parseMajor(installed);
    const latestMajor = parseMajor(latest);
    if (installedMajor === null || latestMajor === null) continue;
    const gap = latestMajor - installedMajor;
    if (gap >= MAJOR_BREAKING_THRESHOLD) {
      upgrades.push({ name, installed, latest, gapMajors: gap });
    }
  }
  // Largest gap first — those are the most urgent
  upgrades.sort((a, b) => b.gapMajors - a.gapMajors);
  return upgrades;
}

/**
 * Extract import/require references to a given package name from source.
 * Returns true if the file references the dep.
 */
function fileReferencesDep(content, depName) {
  // Match: import ... from 'depName' / import('depName') / require('depName')
  // Also match sub-path imports like 'depName/utils'
  const escaped = depName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `(?:import\\s*\\(|import\\s|from\\s|require\\s*\\()\\s*['"\`]${escaped}(?:[/'"\`]|$)`,
    'm'
  );
  return re.test(content);
}

/**
 * Build the breaking-changes prompt for Claude.
 */
function buildBreakingChangesPrompt(depName, fromVersion, toVersion) {
  return `You are a senior JavaScript/TypeScript engineer documenting breaking API changes.

Package: ${depName}
From version: ${fromVersion}
To version: ${toVersion}

List ONLY the breaking API changes a developer who imports "${depName}" would need to fix in their source code. Focus on:
- Renamed exports / functions / classes
- Changed function signatures (new required params, removed params, renamed options)
- Removed exports
- Changed return types that require call-site changes
- Import path changes (e.g. named imports that moved to a different subpath)

Do NOT include:
- Internal implementation changes
- Performance improvements
- Bug fixes with no API impact
- Changes only affecting CommonJS / ESM interop internals

Output format — one breaking change per line, exactly this shape:
BREAKING: <concise one-line description of what changed and how to update>

If there are no breaking API changes, output exactly:
NO_BREAKING_CHANGES

Example output:
BREAKING: \`createStore\` is removed — use \`configureStore\` from '@reduxjs/toolkit' instead
BREAKING: \`connect()\` now requires \`mapStateToProps\` to be a selector created with \`createSelector\`
`;
}

/**
 * Build the call-site patch prompt for Claude.
 */
function buildPatchPrompt(depName, fromVersion, toVersion, breakingChanges, fileContent, filePath) {
  return `You are a senior JavaScript/TypeScript engineer migrating code.

Package being upgraded: ${depName} from v${fromVersion} → v${toVersion}

Breaking changes in this upgrade:
${breakingChanges.map(b => `- ${b}`).join('\n')}

File to migrate: ${filePath}

\`\`\`
${fileContent}
\`\`\`

Apply ONLY the changes needed to update call sites for the breaking changes listed above.
- Do NOT reformat code that doesn't need changing.
- Do NOT add comments explaining your changes.
- Do NOT refactor unrelated code.
- If a breaking change does not affect this file, skip it.
- If no changes are needed, output exactly: NO_CHANGES_NEEDED

Output the complete updated file content (no fences, no explanation, just the code):`;
}

/**
 * Parse breaking changes from Claude's response.
 * Returns an array of change strings, or empty array if none.
 */
function parseBreakingChanges(response) {
  if (!response || response.trim() === 'NO_BREAKING_CHANGES') return [];
  return response
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('BREAKING:'))
    .map(l => l.replace(/^BREAKING:\s*/, '').trim())
    .filter(Boolean);
}

/**
 * Strip code fences if Claude wrapped the output.
 */
function stripFences(text) {
  return text
    .replace(/^```[a-z]*\r?\n/, '')
    .replace(/\r?\n```$/, '')
    .trim();
}

/**
 * Upgrade a single dependency across all affected source files.
 *
 * @param {Object} opts
 * @param {string} opts.depName
 * @param {string} opts.fromVersion
 * @param {string} opts.toVersion
 * @param {string[]} opts.sourceFiles  - All file paths to scan (relative)
 * @param {Function} opts.readFile     - async (path) => string
 * @param {Function} opts.askClaude   - async (prompt) => string
 * @returns {Object} { depName, breakingChanges, patchedFiles, skippedFiles, errors }
 */
async function upgradeDep({ depName, fromVersion, toVersion, sourceFiles, readFile, askClaude }) {
  const result = {
    depName,
    fromVersion,
    toVersion,
    breakingChanges: [],
    patchedFiles: [],
    skippedFiles: [],
    errors: [],
  };

  // Step 1: Get breaking changes from Claude
  let breakingChanges = [];
  try {
    const bcPrompt = buildBreakingChangesPrompt(depName, fromVersion, toVersion);
    const bcResponse = await askClaude(bcPrompt);
    breakingChanges = parseBreakingChanges(bcResponse);
  } catch (err) {
    result.errors.push(`Failed to get breaking changes for ${depName}: ${err.message}`);
    return result;
  }

  result.breakingChanges = breakingChanges;

  if (breakingChanges.length === 0) {
    result.skippedFiles.push({ reason: 'no-breaking-changes' });
    return result;
  }

  // Step 2: Find affected files
  const candidateFiles = sourceFiles
    .filter(f => /\.(js|jsx|ts|tsx|mjs|cjs|mts|cts)$/.test(f))
    .slice(0, MAX_FILES_PER_DEP * 3); // over-fetch, then filter by reference

  const affectedFiles = [];
  for (const filePath of candidateFiles) {
    if (affectedFiles.length >= MAX_FILES_PER_DEP) break;
    try {
      const content = await readFile(filePath);
      if (!content || content.length > MAX_FILE_BYTES) {
        result.skippedFiles.push({ file: filePath, reason: 'too-large' });
        continue;
      }
      if (fileReferencesDep(content, depName)) {
        affectedFiles.push({ filePath, content });
      }
    } catch {
      // Unreadable file — skip silently
    }
  }

  if (affectedFiles.length === 0) {
    result.skippedFiles.push({ reason: 'no-affected-files' });
    return result;
  }

  // Step 3: Patch each affected file
  for (const { filePath, content } of affectedFiles) {
    try {
      const patchPrompt = buildPatchPrompt(
        depName, fromVersion, toVersion, breakingChanges, content, filePath
      );
      const patchResponse = await askClaude(patchPrompt);
      const trimmed = patchResponse.trim();

      if (trimmed === 'NO_CHANGES_NEEDED') {
        result.skippedFiles.push({ file: filePath, reason: 'no-changes-needed' });
        continue;
      }

      const patched = stripFences(trimmed);

      // Syntax gate — never ship broken code
      const checker = pickChecker(filePath);
      if (checker) {
        const gateResult = checker(patched);
        if (!gateResult.valid) {
          result.skippedFiles.push({
            file: filePath,
            reason: 'syntax-gate-failed',
            detail: gateResult.error,
          });
          continue;
        }
      }

      result.patchedFiles.push({ filePath, before: content, after: patched });
    } catch (err) {
      result.errors.push(`Failed to patch ${filePath} for ${depName}: ${err.message}`);
      result.skippedFiles.push({ file: filePath, reason: 'patch-error' });
    }
  }

  return result;
}

/**
 * Main entry point. Process up to MAX_DEPS_PER_RUN outdated dependencies.
 *
 * @param {Object} opts
 * @param {Object} opts.installedVersions  - { depName: "1.2.3", ... }
 * @param {Object} opts.latestVersions     - { depName: "3.0.0", ... }
 * @param {string[]} opts.sourceFiles      - All source file paths to consider
 * @param {Function} opts.readFile         - async (path) => string content
 * @param {Function} opts.askClaude        - async (prompt) => string response
 * @returns {Object} { upgrades: [...], totalPatched, totalSkipped, errors[] }
 */
async function patchDependencyUpgrades({
  installedVersions = {},
  latestVersions = {},
  sourceFiles = [],
  readFile,
  askClaude,
}) {
  const upgrades = findMajorUpgrades(installedVersions, latestVersions)
    .slice(0, MAX_DEPS_PER_RUN);

  if (upgrades.length === 0) {
    return { upgrades: [], totalPatched: 0, totalSkipped: 0, errors: [] };
  }

  const results = [];
  const errors = [];

  for (const { name, installed, latest } of upgrades) {
    try {
      const depResult = await upgradeDep({
        depName: name,
        fromVersion: installed,
        toVersion: latest,
        sourceFiles,
        readFile,
        askClaude,
      });
      results.push(depResult);
    } catch (err) {
      errors.push(`upgradeDep(${name}): ${err.message}`);
      results.push({
        depName: name,
        fromVersion: installed,
        toVersion: latest,
        breakingChanges: [],
        patchedFiles: [],
        skippedFiles: [],
        errors: [err.message],
      });
    }
  }

  const totalPatched = results.reduce((s, r) => s + r.patchedFiles.length, 0);
  const totalSkipped = results.reduce((s, r) => s + r.skippedFiles.length, 0);

  return { upgrades: results, totalPatched, totalSkipped, errors };
}

/**
 * Render a markdown summary suitable for a PR comment.
 */
function renderUpgradeSummary(result) {
  const { upgrades, totalPatched, totalSkipped, errors } = result;

  if (upgrades.length === 0) {
    const base = '## Dependency Upgrade Patcher\n\nNo major-version upgrades detected.';
    if (errors.length === 0) return base;
    return base + '\n\n**Errors:**\n' + errors.map(e => `- ${e}`).join('\n') +
      '\n\n---\n_Generated by [GateTest](https://gatetest.ai) — Nuclear tier dependency-upgrade patcher_';
  }

  const lines = [
    '## Dependency Upgrade Patcher',
    '',
    `Processed **${upgrades.length}** major-version upgrade(s). ` +
      `Patched **${totalPatched}** file(s), skipped **${totalSkipped}**.`,
    '',
  ];

  for (const upg of upgrades) {
    lines.push(`### \`${upg.depName}\` v${upg.fromVersion} → v${upg.toVersion}`);
    if (upg.breakingChanges.length > 0) {
      lines.push('', '**Breaking changes addressed:**');
      for (const bc of upg.breakingChanges) {
        lines.push(`- ${bc}`);
      }
    }
    if (upg.patchedFiles.length > 0) {
      lines.push('', '**Patched files:**');
      for (const { filePath } of upg.patchedFiles) {
        lines.push(`- \`${filePath}\``);
      }
    }
    if (upg.errors.length > 0) {
      lines.push('', '**Errors (manual review needed):**');
      for (const e of upg.errors) {
        lines.push(`- ${e}`);
      }
    }
    lines.push('');
  }

  if (errors.length > 0) {
    lines.push('**Top-level errors:**');
    for (const e of errors) lines.push(`- ${e}`);
  }

  lines.push(
    '---',
    '_Generated by [GateTest](https://gatetest.ai) — Nuclear tier dependency-upgrade patcher_'
  );

  return lines.join('\n');
}

module.exports = {
  patchDependencyUpgrades,
  findMajorUpgrades,
  parseMajor,
  fileReferencesDep,
  parseBreakingChanges,
  buildBreakingChangesPrompt,
  buildPatchPrompt,
  renderUpgradeSummary,
  upgradeDep,
  MAX_DEPS_PER_RUN,
  MAX_FILES_PER_DEP,
};
