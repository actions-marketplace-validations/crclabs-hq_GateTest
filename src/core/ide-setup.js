'use strict';
/**
 * GateTest IDE auto-setup.
 *
 * Detects which AI-native editors the user has installed and writes the
 * correct MCP server configuration for each one so gatetest-mcp starts
 * automatically without any manual JSON editing.
 *
 * Supported:
 *   claude    — Claude Code  (~/.claude.json)
 *   cursor    — Cursor       (~/.cursor/mcp.json)
 *   windsurf  — Windsurf     (~/.codeium/windsurf/mcp_config.json)
 *   cline     — Cline        (~/.cline/mcp_servers.json)
 *   zed       — Zed          (~/.config/zed/settings.json)
 *   vscode    — VS Code      (~/.config/Code/User/settings.json)
 *
 * Each IDE has a slightly different config schema for MCP servers. This
 * module handles every variation.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();

// Where each IDE stores its MCP config (in order of preference)
const IDE_CONFIG_PATHS = {
  claude: [
    path.join(HOME, '.claude.json'),
    path.join(HOME, '.config', 'claude', 'settings.json'),
  ],
  cursor: [
    path.join(HOME, '.cursor', 'mcp.json'),
    path.join(HOME, 'Library', 'Application Support', 'Cursor', 'User', 'mcp.json'),
    path.join(HOME, '.config', 'Cursor', 'User', 'mcp.json'),
    path.join(process.env.APPDATA || HOME, 'Cursor', 'User', 'mcp.json'),
  ],
  windsurf: [
    path.join(HOME, '.codeium', 'windsurf', 'mcp_config.json'),
    path.join(HOME, 'Library', 'Application Support', 'Windsurf', 'mcp_config.json'),
  ],
  cline: [
    path.join(HOME, '.cline', 'mcp_servers.json'),
    path.join(HOME, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'),
  ],
  zed: [
    path.join(HOME, '.config', 'zed', 'settings.json'),
    path.join(HOME, 'Library', 'Application Support', 'Zed', 'settings.json'),
  ],
  vscode: [
    path.join(HOME, '.config', 'Code', 'User', 'settings.json'),
    path.join(HOME, 'Library', 'Application Support', 'Code', 'User', 'settings.json'),
    path.join(process.env.APPDATA || HOME, 'Code', 'User', 'settings.json'),
  ],
};

// Detection markers — file/dir that proves the IDE is installed
const IDE_MARKERS = {
  claude:   [path.join(HOME, '.claude.json'), '/usr/local/bin/claude', '/usr/bin/claude', path.join(HOME, '.npm', 'bin', 'claude')],
  cursor:   [path.join(HOME, '.cursor'), path.join(HOME, 'Library', 'Application Support', 'Cursor'), '/usr/bin/cursor', '/Applications/Cursor.app'],
  windsurf: [path.join(HOME, '.codeium', 'windsurf'), path.join(HOME, 'Library', 'Application Support', 'Windsurf'), '/Applications/Windsurf.app'],
  cline:    [path.join(HOME, '.cline')],
  zed:      [path.join(HOME, '.config', 'zed'), path.join(HOME, 'Library', 'Application Support', 'Zed'), '/Applications/Zed.app', '/usr/bin/zed'],
  vscode:   [path.join(HOME, '.config', 'Code'), path.join(HOME, 'Library', 'Application Support', 'Code'), '/usr/bin/code', '/Applications/Visual Studio Code.app'],
};

function isIdeInstalled(ide) {
  return (IDE_MARKERS[ide] || []).some(p => {
    try { fs.accessSync(p); return true; } catch { return false; }
  });
}

function detectInstalledIDEs() {
  return Object.keys(IDE_CONFIG_PATHS).filter(isIdeInstalled);
}

function buildMcpEntry(mcpBinPath) {
  return { command: 'node', args: [mcpBinPath], env: {} };
}

function resolveMcpBinPath() {
  // Resolve the gatetest-mcp.mjs path relative to this file (src/core/ide-setup.js)
  return path.join(__dirname, '..', '..', 'bin', 'gatetest-mcp.mjs');
}

/**
 * Write the MCP config for a single IDE.
 * Returns { ok, path, error }.
 */
function configureIde(ide, mcpEntry) {
  const configPaths = IDE_CONFIG_PATHS[ide];
  if (!configPaths) return { ok: false, error: 'Unknown IDE' };

  for (const configPath of configPaths) {
    try {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });

      let existing = {};
      if (fs.existsSync(configPath)) {
        const raw = fs.readFileSync(configPath, 'utf8').trim();
        if (raw) existing = JSON.parse(raw);
      }

      if (ide === 'zed') {
        // Zed uses context_servers
        existing.context_servers = existing.context_servers || {};
        existing.context_servers.gatetest = mcpEntry;
      } else if (ide === 'vscode') {
        // VS Code 1.99+ Copilot MCP
        existing['github.copilot.chat.mcp.servers'] = existing['github.copilot.chat.mcp.servers'] || {};
        existing['github.copilot.chat.mcp.servers'].gatetest = mcpEntry;
      } else {
        // Claude Code, Cursor, Windsurf, Cline — all use mcpServers at root
        existing.mcpServers = existing.mcpServers || {};
        existing.mcpServers.gatetest = mcpEntry;
      }

      fs.writeFileSync(configPath, JSON.stringify(existing, null, 2) + '\n');
      return { ok: true, path: configPath };
    } catch (err) {
      continue; // try next path
    }
  }

  return { ok: false, error: 'Could not write to any known config path' };
}

/**
 * Main entry point.
 * @param {object} opts
 * @param {string[]} [opts.ides]   — specific IDEs to configure (default: auto-detect)
 * @param {boolean}  [opts.all]    — configure all known IDEs (default: false)
 * @param {boolean}  [opts.dry]    — dry run, print what would happen
 */
function setupIdes(opts = {}) {
  const mcpBin = resolveMcpBinPath();
  const mcpEntry = buildMcpEntry(mcpBin);

  const targets = opts.all
    ? Object.keys(IDE_CONFIG_PATHS)
    : (opts.ides && opts.ides.length > 0)
      ? opts.ides
      : detectInstalledIDEs();

  const results = [];
  for (const ide of targets) {
    const installed = isIdeInstalled(ide);
    if (opts.dry) {
      results.push({ ide, installed, action: 'would configure' });
      continue;
    }
    const r = configureIde(ide, mcpEntry);
    results.push({ ide, installed, ...r });
  }
  return { results, mcpBin };
}

module.exports = { setupIdes, detectInstalledIDEs, configureIde, isIdeInstalled, IDE_CONFIG_PATHS };
