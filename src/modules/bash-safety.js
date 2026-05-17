/**
 * Bash Safety Module — detects error-swallowing patterns in shell scripts,
 * CI YAML run: blocks, and package.json scripts.
 * Flags: || true, 2>/dev/null || true, set +e without set -e, ; true.
 * Requires explicit // gatetest:swallow-ok reason="..." justification.
 */

const BaseModule = require('./base-module');
const fs   = require('fs');
const path = require('path');

const SWALLOW_OK = /gatetest:swallow-ok/;

const RULES = [
  {
    code: 'pipe-true',
    pattern: /\|\|\s*true\b/,
    severity: 'error',
    message: (line) => `"|| true" swallows errors — failures are silently ignored: ${line.trim()}`,
  },
  {
    code: 'devnull-swallow',
    pattern: /2>\/dev\/null\s*\|\|\s*true\b/,
    severity: 'error',
    message: (line) => `"2>/dev/null || true" hides stderr AND swallows exit code — undetectable failure: ${line.trim()}`,
  },
  {
    code: 'semicolon-true',
    pattern: /;\s*true\s*($|;|\n)/,
    severity: 'error',
    message: (line) => `"; true" resets exit code — pipeline failure becomes success: ${line.trim()}`,
  },
  {
    code: 'set-e-disabled',
    pattern: /\bset\s+\+e\b/,
    severity: 'error',
    message: (line) => `"set +e" disables error exit — subsequent failures are swallowed until "set -e" is restored: ${line.trim()}`,
  },
  {
    code: 'devnull-only',
    pattern: /2>\/dev\/null(?!\s*\|\|)/,
    severity: 'warning',
    message: (line) => `"2>/dev/null" hides error messages — debugging production failures becomes much harder: ${line.trim()}`,
  },
  {
    code: 'ignore-exit',
    pattern: /\bignore_errors:\s*yes\b/i,
    severity: 'error',
    message: (line) => `"ignore_errors: yes" (Ansible) swallows task failures: ${line.trim()}`,
  },
];

class BashSafetyModule extends BaseModule {
  constructor() { super('bashSafety', 'Bash / Shell Error-Swallow Detector'); }

  async run(result, config) {
    const root = config.projectRoot;

    // Shell scripts
    for (const file of this._glob(root, /\.(sh|bash)$/, ['node_modules', '.git', '.claude', '.next', 'dist'])) {
      this._scanFile(file, path.relative(root, file), result, 'shell');
    }

    // CI YAML — extract run: blocks
    for (const file of this._glob(root, /\.(yml|yaml)$/, ['node_modules', '.git', '.claude', '.next', 'dist'])) {
      this._scanFile(file, path.relative(root, file), result, 'yaml');
    }

    // package.json scripts
    const pkgFile = path.join(root, 'package.json');
    if (fs.existsSync(pkgFile)) {
      this._scanPackageJson(pkgFile, result);
    }

    if (result.checks.length === 0 || result.checks.every(c => c.passed)) {
      result.addCheck('bash-safety-clean', true, { severity: 'info', fix: 'No error-swallowing patterns found in shell scripts or CI workflows' });
    }
  }

  _scanFile(file, rel, result, mode) {
    let content;
    try { content = fs.readFileSync(file, 'utf8'); } catch { return; }

    const lines = content.split('\n');
    lines.forEach((rawLine, idx) => {
      const lineNum = idx + 1;

      // Check for suppression comment on the same line or the line above
      const prevLine = idx > 0 ? lines[idx - 1] : '';
      if (SWALLOW_OK.test(rawLine) || SWALLOW_OK.test(prevLine)) return;

      // For YAML, only scan inside run: blocks
      if (mode === 'yaml' && !this._isInRunBlock(lines, idx)) return;

      for (const rule of RULES) {
        if (rule.pattern.test(rawLine)) {
          result.addCheck(`bash-safety:${rule.code}:${rel}:${lineNum}`, false, {
            severity: rule.severity,
            file,
            fix: `${rel}:${lineNum} — ${rule.message(rawLine)}\nFix: handle the error explicitly or add "# gatetest:swallow-ok reason=\\"<reason>\\"" if intentional.`,
          });
        }
      }
    });
  }

  _scanPackageJson(file, result) {
    let pkg;
    try { pkg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return; }

    const scripts = pkg.scripts || {};
    for (const [name, cmd] of Object.entries(scripts)) {
      if (typeof cmd !== 'string') continue;
      for (const rule of RULES) {
        if (rule.pattern.test(cmd)) {
          result.addCheck(`bash-safety:${rule.code}:package.json:${name}`, false, {
            severity: rule.severity,
            file,
            fix: `package.json scripts.${name} — ${rule.message(cmd)}\nFix: handle the error or remove the swallow pattern.`,
          });
        }
      }
    }
  }

  _isInRunBlock(lines, idx) {
    // Scan backwards to find if this line is under a "run:" key
    for (let i = idx; i >= Math.max(0, idx - 20); i--) {
      const l = lines[i].trim();
      if (/^-?\s*run:\s*/.test(l)) return true;
      if (/^\w/.test(l) && !l.startsWith('-') && i < idx) break;
    }
    return false;
  }

  _glob(root, pattern, excludes = []) {
    const results = [];
    const walk = (dir) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (excludes.some(x => e.name === x || dir.includes(`/${x}`))) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (pattern.test(full.replace(/\\/g, '/'))) results.push(full);
      }
    };
    walk(root);
    return results;
  }
}

module.exports = BashSafetyModule;
