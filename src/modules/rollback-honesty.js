/**
 * Rollback Honesty Module — verifies that "rollback on failure" branches in
 * deploy scripts are structurally different from the failing deploy.
 * Catches: rollbacks that re-run the same broken health check, rollbacks that
 * use the same artifact/SHA as the failing deploy, and rollbacks that silently
 * "succeed" while production stays broken.
 */

const BaseModule = require('./base-module');
const fs   = require('fs');
const path = require('path');

// Patterns that indicate a rollback branch
const ROLLBACK_MARKERS  = /rollback|revert|restore|fallback|previous|prev_sha|PREV_SHA|prev_version/i;
const FAILURE_BRANCH    = /(?:else|then|fi|\|\|)\s*.*(?:rollback|revert|restore)/im;
const ON_FAILURE        = /on[-_]?failure|if.*fail|catch|ROLLBACK/i;

// Health check patterns
const HEALTH_CHECK_RE   = /curl\s+.*(?:health|ping|ready|status)|wget\s+.*(?:health|ping|ready|status)/i;

// Same artifact/SHA patterns — rollback should use PREV_SHA not CURRENT/HEAD
const SAME_SHA_PATTERN  = /git\s+reset\s+--hard\s+(?:HEAD|CURRENT|LATEST|\$(?:CURRENT_SHA|NEW_SHA|SHA))/i;
const DIFF_SHA_PATTERN  = /git\s+reset\s+--hard\s+\$(?:PREV|PREVIOUS|OLD|LAST|BEFORE)_?SHA/i;

class RollbackHonestyModule extends BaseModule {
  constructor() { super('rollbackHonesty', 'Rollback Honesty Checker'); }

  async run(result, config) {
    const root = config.projectRoot;
    const deployFiles = this._findDeployFiles(root);

    if (deployFiles.length === 0) {
      result.addCheck('rollback-no-deploy-scripts', true, { severity: 'info', fix: 'No deploy scripts found — nothing to validate' });
      return;
    }

    let foundRollback = false;

    for (const file of deployFiles) {
      const rel = path.relative(root, file);
      const found = this._analyzeScript(file, rel, result);
      if (found) foundRollback = true;
    }

    if (!foundRollback) {
      result.addCheck('rollback-none-found', true, { severity: 'info', fix: 'No rollback branches detected in deploy scripts' });
    }
  }

  _analyzeScript(file, rel, result) {
    let content;
    try { content = fs.readFileSync(file, 'utf8'); } catch { return false; }

    if (!ROLLBACK_MARKERS.test(content)) return false;

    // Split into logical sections — look for rollback blocks
    const rollbackBlocks = this._extractRollbackBlocks(content);
    if (rollbackBlocks.length === 0) return false;

    const mainHealthChecks = this._findHealthChecks(content);

    for (const block of rollbackBlocks) {
      const blockChecks = this._findHealthChecks(block.content);

      // Check 1: Does rollback run the same health check URLs as the main deploy?
      for (const check of blockChecks) {
        const identical = mainHealthChecks.find(mc => mc.url === check.url && check.url);
        if (identical) {
          result.addCheck(`rollback:same-health-check:${rel}`, false, {
            severity: 'error',
            file,
            fix: `${rel}: Rollback block runs the same health check as the failing deploy: "${check.url}"\nIf the URL was wrong in the main deploy, the rollback will also fail — producing a false "rollback succeeded" while production stays broken.\nFix: rollback health check should verify the PREVIOUS version's endpoint, or skip the health check and alert a human instead.`,
          });
        }
      }

      // Check 2: Does rollback use the same SHA as the failing deploy?
      if (SAME_SHA_PATTERN.test(block.content)) {
        result.addCheck(`rollback:same-sha:${rel}`, false, {
          severity: 'error',
          file,
          fix: `${rel}: Rollback uses git reset --hard HEAD/CURRENT_SHA — this resets to the same broken commit it's trying to recover from.\nFix: use git reset --hard \$PREV_SHA or git reset --hard HEAD~1 to go back to the known-good version.`,
        });
      }

      // Check 3: Rollback that just re-runs the same deploy command
      const deployCommands = this._findDeployCommands(content.replace(block.content, ''));
      const rollbackCommands = this._findDeployCommands(block.content);
      const sharedCommands = rollbackCommands.filter(rc => deployCommands.includes(rc));

      if (sharedCommands.length > 0 && !DIFF_SHA_PATTERN.test(block.content)) {
        result.addCheck(`rollback:same-deploy-command:${rel}`, false, {
          severity: 'warning',
          file,
          fix: `${rel}: Rollback runs the same deploy command(s) as the main deploy (${sharedCommands.join(', ')}) without switching to a different SHA/artifact.\nThis is not a rollback — it's a retry of the same broken thing.\nFix: capture \$PREV_SHA before deploying and use it in the rollback branch.`,
        });
      }

      // Check 4: Rollback that exits 0 regardless of outcome
      if (/exit\s+0/.test(block.content) && rollbackBlocks.length > 0) {
        result.addCheck(`rollback:silent-success:${rel}`, false, {
          severity: 'warning',
          file,
          fix: `${rel}: Rollback block contains "exit 0" — this makes CI report success even if the rollback itself fails.\nFix: exit with an error code or alert a human when rollback is triggered.`,
        });
      }

      // Bonus: Good rollback pattern — PREV_SHA reference
      if (DIFF_SHA_PATTERN.test(block.content)) {
        result.addCheck(`rollback:good-sha-pattern:${rel}`, true, {
          severity: 'info',
          fix: `${rel}: Rollback correctly references a previous SHA (PREV_SHA / PREVIOUS_SHA) — structurally different from the failing deploy.`,
        });
      }
    }

    return true;
  }

  _extractRollbackBlocks(content) {
    const blocks = [];
    const lines  = content.split('\n');
    let inBlock  = false;
    let depth    = 0;
    let start    = 0;
    let buffer   = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (!inBlock && (ROLLBACK_MARKERS.test(line) || ON_FAILURE.test(line))) {
        inBlock = true;
        depth   = 0;
        start   = i;
        buffer  = [line];
        continue;
      }

      if (inBlock) {
        buffer.push(line);
        if (/\bif\b|\bfor\b|\bwhile\b|\bfunction\b|\{/.test(line)) depth++;
        if (/\bfi\b|\bdone\b|\}/.test(line)) depth--;
        if (depth < 0 || (buffer.length > 2 && depth === 0 && /^[a-zA-Z]/.test(line) && !ROLLBACK_MARKERS.test(line))) {
          blocks.push({ start, content: buffer.join('\n') });
          inBlock = false;
          buffer  = [];
          depth   = 0;
        }
      }
    }

    if (inBlock && buffer.length > 0) blocks.push({ start, content: buffer.join('\n') });
    return blocks;
  }

  _findHealthChecks(content) {
    const checks = [];
    const re = /curl\s+(?:-[a-zA-Z0-9]+\s+)*['"]?(https?:\/\/[^\s'"]+|localhost[^\s'"]*|127\.[^\s'"]*|\$\{?[A-Z_]+\}?[^\s'"]*)['"]?/g;
    let m;
    while ((m = re.exec(content)) !== null) {
      if (HEALTH_CHECK_RE.test(m[0])) checks.push({ url: m[1] || null, raw: m[0] });
    }
    return checks;
  }

  _findDeployCommands(content) {
    const commands = [];
    const patterns = [
      /\bbun\s+(?:install|run|build)\b/g,
      /\bnpm\s+(?:install|run|ci|build)\b/g,
      /\bsystemctl\s+(?:restart|start)\s+\S+/g,
      /\bpm2\s+(?:restart|start)\s+\S+/g,
      /\bdocker\s+(?:build|push|run)\b/g,
      /\bkubectl\s+(?:apply|rollout)\b/g,
    ];
    for (const pat of patterns) {
      let m;
      while ((m = pat.exec(content)) !== null) commands.push(m[0].split(/\s+/).slice(0, 3).join(' '));
    }
    return commands;
  }

  _findDeployFiles(root) {
    const results = [];
    const walk = (dir) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (['node_modules', '.git', '.claude', '.next', 'dist'].includes(e.name)) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.(sh|bash)$/.test(e.name) || /deploy/.test(e.name.toLowerCase())) {
          results.push(full);
        }
      }
    };

    // Also check GitHub Actions workflows
    const ghWorkflows = path.join(root, '.github', 'workflows');
    if (fs.existsSync(ghWorkflows)) walk(ghWorkflows);

    walk(root);
    return results;
  }
}

module.exports = RollbackHonestyModule;
