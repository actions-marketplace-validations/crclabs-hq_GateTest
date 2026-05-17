/**
 * Systemd Unit Checker — validates systemd .service files under infra/ and deploy/.
 * Checks:
 *   1. ExecStart= binary path exists in repo or is a known system binary
 *   2. WorkingDirectory= directory exists in repo
 *   3. User=X + ProtectHome=true combination that blocks ~/.bun, ~/.nvm, ~/.cargo, etc.
 *   4. Missing Restart= directive (no restart policy = single crash = downtime)
 *   5. Missing StandardOutput/StandardError logging config
 */

const BaseModule = require('./base-module');
const fs   = require('fs');
const path = require('path');

// Binaries that are typically pre-installed system-wide
const SYSTEM_BINARIES = new Set([
  '/usr/bin/node', '/usr/local/bin/node', '/usr/bin/npm', '/usr/local/bin/npm',
  '/usr/bin/python3', '/usr/bin/python', '/usr/bin/ruby',
  '/usr/bin/bash', '/bin/bash', '/usr/bin/sh', '/bin/sh',
  '/usr/bin/env', '/usr/bin/java',
]);

// Paths under home dirs that ProtectHome=true blocks
const HOME_BIN_PATTERNS = [
  { pattern: /\/root\/\.bun\/bin/, tool: 'Bun' },
  { pattern: /\/home\/[^/]+\/\.bun\/bin/, tool: 'Bun' },
  { pattern: /\/root\/\.nvm\//, tool: 'nvm Node' },
  { pattern: /\/home\/[^/]+\/\.nvm\//, tool: 'nvm Node' },
  { pattern: /\/root\/\.cargo\/bin/, tool: 'Rust/Cargo' },
  { pattern: /\/home\/[^/]+\/\.cargo\/bin/, tool: 'Rust/Cargo' },
  { pattern: /\/root\/go\/bin/, tool: 'Go' },
  { pattern: /\/home\/[^/]+\/go\/bin/, tool: 'Go' },
];

class SystemdModule extends BaseModule {
  constructor() { super('systemd', 'Systemd Unit File Validator'); }

  async run(result, config) {
    const root = config.projectRoot;
    const serviceFiles = this._findServiceFiles(root);

    if (serviceFiles.length === 0) {
      result.addCheck('systemd-no-units', true, { severity: 'info', fix: 'No .service unit files found under infra/ or deploy/' });
      return;
    }

    for (const file of serviceFiles) {
      this._validateUnit(file, path.relative(root, file), root, result);
    }
  }

  _validateUnit(file, rel, root, result) {
    let content;
    try { content = fs.readFileSync(file, 'utf8'); } catch { return; }

    const lines = content.split('\n');
    const get = (key) => {
      for (const line of lines) {
        const m = line.match(new RegExp(`^${key}\\s*=\\s*(.+)$`));
        if (m) return m[1].trim();
      }
      return null;
    };

    const execStart    = get('ExecStart');
    const workingDir   = get('WorkingDirectory');
    const user         = get('User');
    const protectHome  = get('ProtectHome');
    const restart      = get('Restart');
    const stdOut       = get('StandardOutput');
    const stdErr       = get('StandardError');

    // 1. ExecStart binary validation
    if (execStart) {
      const binary = execStart.split(' ')[0];
      this._checkBinary(binary, rel, file, root, workingDir, result);
    } else {
      result.addCheck(`systemd:no-execstart:${rel}`, false, {
        severity: 'error',
        file,
        fix: `${rel}: No ExecStart= directive found — unit will fail to start.`,
      });
    }

    // 2. WorkingDirectory exists
    if (workingDir && !workingDir.includes('$')) {
      const absWork = workingDir.startsWith('/') ? workingDir : path.join(root, workingDir);
      if (!fs.existsSync(absWork)) {
        result.addCheck(`systemd:missing-workdir:${rel}`, false, {
          severity: 'warning',
          file,
          fix: `${rel}: WorkingDirectory=${workingDir} does not exist in this repo. The service will fail to start if this path is missing on the deployment server.`,
        });
      }
    }

    // 3. User + ProtectHome conflict
    if (user && protectHome && protectHome.toLowerCase() !== 'false' && protectHome !== 'no' && protectHome !== '0') {
      if (execStart) {
        const binary = execStart.split(' ')[0];
        for (const { pattern, tool } of HOME_BIN_PATTERNS) {
          if (pattern.test(binary)) {
            result.addCheck(`systemd:protect-home-conflict:${rel}`, false, {
              severity: 'error',
              file,
              fix: `${rel}: User=${user} + ProtectHome=${protectHome} blocks access to ${tool} binary at ${binary}.\nFix: either set ProtectHome=false, use a system-wide binary path (/usr/local/bin/${path.basename(binary)}), or create a symlink in /usr/local/bin.`,
            });
          }
        }
      }
    }

    // 4. Missing Restart directive
    if (!restart) {
      result.addCheck(`systemd:no-restart:${rel}`, false, {
        severity: 'warning',
        file,
        fix: `${rel}: No Restart= directive — a single crash will leave the service down permanently.\nFix: add Restart=always + RestartSec=5 under [Service].`,
      });
    }

    // 5. Missing logging config (without it, output goes to journal but errors may be missed)
    if (!stdOut && !stdErr) {
      result.addCheck(`systemd:no-logging:${rel}`, false, {
        severity: 'info',
        file,
        fix: `${rel}: No StandardOutput/StandardError configured. Add:\n  StandardOutput=journal\n  StandardError=journal\nfor reliable log capture via journalctl.`,
      });
    }

    // All checks pass for this unit
    const hasErrors = result.checks.some(c => !c.passed && c.severity === 'error' && (c.fix || '').includes(rel));
    if (!hasErrors) {
      result.addCheck(`systemd:valid:${rel}`, true, { severity: 'info', fix: `${rel}: Unit file passes all validation checks` });
    }
  }

  _checkBinary(binary, rel, file, root, workingDir, result) {
    if (!binary || binary.startsWith('$')) return; // dynamic — can't resolve

    // System binary
    if (SYSTEM_BINARIES.has(binary)) return;

    // Absolute path — check if it looks like a home-dir binary
    if (binary.startsWith('/')) {
      for (const { pattern, tool } of HOME_BIN_PATTERNS) {
        if (pattern.test(binary)) return; // handled in protect-home check
      }
      // Flag non-standard absolute paths that we can't verify exist
      if (!binary.startsWith('/usr') && !binary.startsWith('/bin') && !binary.startsWith('/opt')) {
        result.addCheck(`systemd:unusual-binary:${rel}`, false, {
          severity: 'info',
          file,
          fix: `${rel}: ExecStart binary "${binary}" is at an unusual path. Verify it exists on the deployment server and is executable.`,
        });
      }
      return;
    }

    // Relative path — check it exists in the repo
    const baseDir = workingDir && !workingDir.startsWith('/') ? path.join(root, workingDir) : root;
    const absPath = path.join(baseDir, binary);
    if (!fs.existsSync(absPath)) {
      result.addCheck(`systemd:missing-binary:${rel}`, false, {
        severity: 'warning',
        file,
        fix: `${rel}: ExecStart binary "${binary}" not found in repo at ${absPath}. It must exist on the deployment server or be created by the install step (e.g. bun install, npm ci).`,
      });
    }
  }

  _findServiceFiles(root) {
    const results = [];
    const searchDirs = ['infra', 'deploy', 'systemd', 'services', '.'];
    for (const dir of searchDirs) {
      const fullDir = path.join(root, dir);
      if (!fs.existsSync(fullDir)) continue;
      this._walkForServices(fullDir, results);
    }
    return [...new Set(results)];
  }

  _walkForServices(dir, results) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (['node_modules', '.git', '.claude', '.next'].includes(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) this._walkForServices(full, results);
      else if (e.name.endsWith('.service')) results.push(full);
    }
  }
}

module.exports = SystemdModule;
