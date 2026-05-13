#!/usr/bin/env node

/**
 * GateTest Pre-Commit Hook
 * Runs quick checks on staged files before allowing a commit.
 * Install: add to .git/hooks/pre-commit or use husky/lint-staged.
 */

const path = require('path');
const { execSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '../../');

async function preCommit() {
  console.log('[GateTest] Running pre-commit checks...\n');

  // Get staged files
  let stagedFiles;
  try {
    stagedFiles = execSync('git diff --cached --name-only --diff-filter=ACMR', {
      encoding: 'utf-8',
      cwd: projectRoot,
    }).trim().split('\n').filter(Boolean);
  } catch {
    console.log('[GateTest] Could not get staged files — skipping.\n');
    process.exit(0);
  }

  if (stagedFiles.length === 0) {
    console.log('[GateTest] No staged files.\n');
    process.exit(0);
  }

  console.log(`[GateTest] Checking ${stagedFiles.length} staged file(s)...\n`);

  let hasErrors = false;

  // 1. Check CLAUDE.md exists and is valid
  const claudeMdPath = path.join(projectRoot, 'CLAUDE.md');
  const fs = require('fs');
  if (!fs.existsSync(claudeMdPath)) {
    console.error('[GateTest] ERROR: CLAUDE.md not found — every project must have one.\n');
    hasErrors = true;
  }

  // 2. Scan staged files for secrets
  const secretPatterns = [
    /(?:api[_-]?key|apikey)\s*[:=]\s*['"][^'"]{8,}/gi,
    /(?:secret|password|passwd|pwd)\s*[:=]\s*['"][^'"]{8,}/gi,
    /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/g,
    /ghp_[A-Za-z0-9_]{36,}/g,
    /sk-[A-Za-z0-9]{32,}/g,
    /AKIA[A-Z0-9]{16}/g,
  ];

  for (const file of stagedFiles) {
    const filePath = path.join(projectRoot, file);
    if (!fs.existsSync(filePath)) continue;

    try {
      const content = fs.readFileSync(filePath, 'utf-8');

      // Check for secrets
      for (const pattern of secretPatterns) {
        pattern.lastIndex = 0;
        if (pattern.test(content)) {
          console.error(`[GateTest] ERROR: Potential secret found in ${file}`);
          hasErrors = true;
        }
      }

      // Check for console.log/debugger in JS/TS files
      if (/\.(js|ts|jsx|tsx)$/.test(file)) {
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (/\bconsole\.(log|debug)\b/.test(lines[i]) && !/eslint-disable/.test(lines[i])) {
            console.error(`[GateTest] ERROR: console.log/debug at ${file}:${i + 1}`);
            hasErrors = true;
          }
          if (/\bdebugger\b/.test(lines[i])) {
            console.error(`[GateTest] ERROR: debugger statement at ${file}:${i + 1}`);
            hasErrors = true;
          }
        }
      }

      // Check JSON syntax
      if (file.endsWith('.json')) {
        try { JSON.parse(content); } catch (e) {
          console.error(`[GateTest] ERROR: Invalid JSON in ${file}: ${e.message}`);
          hasErrors = true;
        }
      }
    } catch {
      // Binary file or can't read — skip
    }
  }

  // 3. Run syntax check on JS files
  const jsFiles = stagedFiles.filter(f => /\.(js|mjs|cjs)$/.test(f));
  for (const file of jsFiles) {
    const filePath = path.join(projectRoot, file);
    if (!fs.existsSync(filePath)) continue;

    try {
      const vm = require('vm');
      const content = fs.readFileSync(filePath, 'utf-8');
      new vm.Script(content, { filename: file });
    } catch (err) {
      if (err instanceof SyntaxError) {
        console.error(`[GateTest] ERROR: Syntax error in ${file}: ${err.message}`);
        hasErrors = true;
      }
    }
  }

  if (hasErrors) {
    console.error('\n[GateTest] Pre-commit checks FAILED. Fix issues above before committing.\n');
    process.exit(1);
  }

  console.log('[GateTest] Pre-commit checks PASSED.\n');
  process.exit(0);
}

preCommit().catch(err => {
  console.error(`[GateTest] Hook error: ${err.message}`);
  process.exit(1);
});
