/**
 * GateTest VS Code Extension
 *
 * Native VS Code / Cursor / Windsurf integration.
 * - Runs GateTest scans and shows findings as inline diagnostics
 * - Sidebar panel for issues and modules
 * - Status bar showing scan state
 * - Auto-configures MCP server for Claude / Cursor / Windsurf / Cline
 */

import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

// ─── Types ───────────────────────────────────────────────────────────────────

interface GateTestIssue {
  file: string;
  line: number;
  col: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
  module: string;
  rule?: string;
}

interface ScanResult {
  passed: boolean;
  issues: GateTestIssue[];
  modules: { name: string; status: string; checks: number; issues: number }[];
  duration: number;
  summary: string;
}

// ─── Extension state ─────────────────────────────────────────────────────────

let diagnosticCollection: vscode.DiagnosticCollection;
let statusBarItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;
let scanInProgress = false;

// ─── Activate ────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
  diagnosticCollection = vscode.languages.createDiagnosticCollection('gatetest');
  outputChannel = vscode.window.createOutputChannel('GateTest');
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'gatetest.showPanel';
  setStatus('idle');
  statusBarItem.show();

  context.subscriptions.push(
    diagnosticCollection,
    statusBarItem,
    outputChannel,
    vscode.commands.registerCommand('gatetest.scanWorkspace', () => runScan('quick')),
    vscode.commands.registerCommand('gatetest.scanFull', () => runScan('full')),
    vscode.commands.registerCommand('gatetest.scanFile', scanCurrentFile),
    vscode.commands.registerCommand('gatetest.fixIssues', openFixDashboard),
    vscode.commands.registerCommand('gatetest.showPanel', showPanel),
    vscode.commands.registerCommand('gatetest.setupMcp', setupMcpServer),
    vscode.commands.registerCommand('gatetest.openDashboard', openDashboard),
  );

  // Auto-scan on save if configured
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const cfg = vscode.workspace.getConfiguration('gatetest');
      if (cfg.get<boolean>('autoScanOnSave')) {
        void runScan('quick', doc.uri.fsPath);
      }
    })
  );

  // Register MCP server with VS Code Copilot (VS Code 1.99+)
  void autoRegisterMcpServer();
}

export function deactivate() {
  diagnosticCollection?.dispose();
  statusBarItem?.dispose();
}

// ─── MCP server registration ──────────────────────────────────────────────────

async function autoRegisterMcpServer() {
  try {
    // VS Code 1.99+ supports MCP servers via settings
    const config = vscode.workspace.getConfiguration();
    const existing = config.get<Record<string, unknown>>('github.copilot.chat.mcp.servers', {});

    if (!existing['gatetest']) {
      const gatePath = await resolveGatePath();
      if (gatePath) {
        const updated = {
          ...existing,
          gatetest: {
            command: 'node',
            args: [path.join(path.dirname(gatePath), '..', 'bin', 'gatetest-mcp.mjs')],
            env: {},
          },
        };
        await config.update('github.copilot.chat.mcp.servers', updated, vscode.ConfigurationTarget.Global);
      }
    }
  } catch {
    // VS Code version doesn't support this — silently skip
  }
}

// ─── IDE setup command ────────────────────────────────────────────────────────

async function setupMcpServer() {
  const gatePath = await resolveGatePath();
  if (!gatePath) {
    void vscode.window.showErrorMessage('GateTest binary not found. Run: npm install -g gatetest');
    return;
  }

  const mcpBin = path.join(path.dirname(gatePath), 'gatetest-mcp.mjs');
  const mcpEntry = {
    command: 'node',
    args: [mcpBin],
  };

  const picks = await vscode.window.showQuickPick(
    ['Claude Code', 'Cursor', 'Windsurf', 'Cline', 'Zed', 'All of the above'],
    { canPickMany: false, placeHolder: 'Which AI tools do you use?' }
  );
  if (!picks) return;

  const targets = picks === 'All of the above'
    ? ['claude', 'cursor', 'windsurf', 'cline', 'zed']
    : [picks.toLowerCase().replace(' code', '').replace(' ', '')];

  const results: string[] = [];
  for (const target of targets) {
    const ok = writeIdeMcpConfig(target, mcpEntry);
    results.push(ok ? `✓ ${target}` : `✗ ${target} (could not detect config path)`);
  }

  void vscode.window.showInformationMessage(
    `GateTest MCP configured:\n${results.join(', ')}\nRestart your AI tool to apply.`
  );
}

function writeIdeMcpConfig(ide: string, entry: unknown): boolean {
  const home = os.homedir();
  const configPaths: Record<string, string[]> = {
    claude:   [path.join(home, '.claude.json')],
    cursor:   [
      path.join(home, '.cursor', 'mcp.json'),
      path.join(home, '.config', 'Cursor', 'User', 'mcp.json'),
    ],
    windsurf: [path.join(home, '.codeium', 'windsurf', 'mcp_config.json')],
    cline:    [path.join(home, '.cline', 'mcp_servers.json')],
    zed:      [path.join(home, '.config', 'zed', 'settings.json')],
  };

  const targets = configPaths[ide];
  if (!targets) return false;

  for (const configPath of targets) {
    try {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      let existing: Record<string, unknown> = {};
      if (fs.existsSync(configPath)) {
        existing = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      }

      // Each IDE uses a slightly different schema
      if (ide === 'zed') {
        (existing as Record<string, unknown>)['context_servers'] ??= {};
        ((existing as Record<string, unknown>)['context_servers'] as Record<string, unknown>)['gatetest'] = entry;
      } else if (ide === 'claude') {
        (existing as Record<string, unknown>)['mcpServers'] ??= {};
        ((existing as Record<string, unknown>)['mcpServers'] as Record<string, unknown>)['gatetest'] = entry;
      } else {
        // cursor, windsurf, cline all use mcpServers at root
        (existing as Record<string, unknown>)['mcpServers'] ??= {};
        ((existing as Record<string, unknown>)['mcpServers'] as Record<string, unknown>)['gatetest'] = entry;
      }

      fs.writeFileSync(configPath, JSON.stringify(existing, null, 2));
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

// ─── Scan logic ───────────────────────────────────────────────────────────────

async function runScan(suite: string, targetFile?: string) {
  if (scanInProgress) {
    void vscode.window.showWarningMessage('A GateTest scan is already running.');
    return;
  }

  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    void vscode.window.showErrorMessage('Open a workspace folder first.');
    return;
  }

  const gatePath = await resolveGatePath();
  if (!gatePath) {
    void vscode.window.showErrorMessage('GateTest not found. Install: npm install -g gatetest');
    return;
  }

  scanInProgress = true;
  setStatus('scanning');
  outputChannel.clear();
  outputChannel.show(true);
  outputChannel.appendLine(`[GateTest] Starting ${suite} scan…`);

  const args = [
    `--suite`, suite,
    `--format`, `json`,
    `--project`, root,
    ...(targetFile ? ['--file', targetFile] : []),
  ];

  try {
    const result = await runProcess(gatePath, args, root);
    const parsed: ScanResult = JSON.parse(result);
    applyDiagnostics(root, parsed.issues);
    setStatus(parsed.passed ? 'passed' : 'failed', parsed.issues.length);
    outputChannel.appendLine(`[GateTest] ${parsed.summary}`);
    if (!parsed.passed) {
      void vscode.window.showWarningMessage(
        `GateTest found ${parsed.issues.filter(i => i.severity === 'error').length} errors. Check the Problems panel.`,
        'Fix with Claude'
      ).then(choice => {
        if (choice === 'Fix with Claude') void openFixDashboard();
      });
    } else {
      void vscode.window.showInformationMessage('GateTest: All checks passed ✓');
    }
  } catch (err) {
    setStatus('error');
    outputChannel.appendLine(`[GateTest] Scan error: ${err}`);
  } finally {
    scanInProgress = false;
  }
}

async function scanCurrentFile() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  await runScan('quick', editor.document.uri.fsPath);
}

function applyDiagnostics(root: string, issues: GateTestIssue[]) {
  diagnosticCollection.clear();
  const byFile = new Map<string, vscode.Diagnostic[]>();

  for (const issue of issues) {
    const absPath = path.isAbsolute(issue.file) ? issue.file : path.join(root, issue.file);
    const uri = vscode.Uri.file(absPath);
    const key = uri.toString();

    const line = Math.max(0, (issue.line || 1) - 1);
    const col = Math.max(0, (issue.col || 1) - 1);
    const range = new vscode.Range(line, col, line, col + 80);

    const severity =
      issue.severity === 'error' ? vscode.DiagnosticSeverity.Error :
      issue.severity === 'warning' ? vscode.DiagnosticSeverity.Warning :
      vscode.DiagnosticSeverity.Information;

    const diag = new vscode.Diagnostic(range, issue.message, severity);
    diag.source = `GateTest [${issue.module}]`;
    if (issue.rule) diag.code = issue.rule;

    if (!byFile.has(key)) byFile.set(key, []);
    byFile.get(key)!.push(diag);
  }

  for (const [uriStr, diags] of byFile) {
    diagnosticCollection.set(vscode.Uri.parse(uriStr), diags);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function setStatus(state: 'idle' | 'scanning' | 'passed' | 'failed' | 'error', count?: number) {
  const icons = { idle: '$(shield)', scanning: '$(sync~spin)', passed: '$(pass)', failed: '$(error)', error: '$(warning)' };
  const labels = {
    idle: 'GateTest',
    scanning: 'GateTest: Scanning…',
    passed: 'GateTest: Passed',
    failed: `GateTest: ${count} issues`,
    error: 'GateTest: Error',
  };
  statusBarItem.text = `${icons[state]} ${labels[state]}`;
  statusBarItem.backgroundColor =
    state === 'failed' ? new vscode.ThemeColor('statusBarItem.errorBackground') :
    state === 'error' ? new vscode.ThemeColor('statusBarItem.warningBackground') :
    undefined;
}

async function resolveGatePath(): Promise<string | null> {
  const configured = vscode.workspace.getConfiguration('gatetest').get<string>('gatePath', 'gatetest');
  if (configured !== 'gatetest') return configured;

  return new Promise((resolve) => {
    cp.exec('which gatetest || where gatetest 2>/dev/null', (err, stdout) => {
      resolve(err ? null : stdout.trim().split('\n')[0]);
    });
  });
}

function runProcess(bin: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = cp.spawn(bin, args, { cwd });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { err += d.toString(); outputChannel.appendLine(d.toString()); });
    proc.on('close', (code) => {
      if (code !== 0 && !out) reject(new Error(err || `Exit code ${code}`));
      else resolve(out);
    });
  });
}

function openFixDashboard() {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const repoName = root ? path.basename(root) : 'your-repo';
  void vscode.env.openExternal(
    vscode.Uri.parse(`https://gatetest.ai?repo=${encodeURIComponent(repoName)}`)
  );
}

function openDashboard() {
  void vscode.env.openExternal(vscode.Uri.parse('https://gatetest.ai'));
}

function showPanel() {
  void vscode.commands.executeCommand('workbench.panel.markers.view.focus');
}
