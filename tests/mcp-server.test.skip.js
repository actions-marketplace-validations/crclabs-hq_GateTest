// =============================================================================
// MCP SERVER TEST — bin/gatetest-mcp.mjs
// =============================================================================
// Validates the MCP server via JSON-RPC over a spawned child process.
// We spawn the server and pipe messages in/out exactly as an MCP client
// would. Tests cover: tools/list, tools/call for all four tools, error
// handling for bad inputs, and silent mode (no stdout leakage from engine).
// =============================================================================

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const path = require('path');

const SERVER_PATH = path.resolve(__dirname, '..', 'bin', 'gatetest-mcp.mjs');
const SCAN_PATH   = path.resolve(__dirname, '..');   // GateTest repo root

// ---------------------------------------------------------------------------
// Helper: send one JSON-RPC request, collect the response line
// ---------------------------------------------------------------------------

// Per-call timeout. 20s was originally chosen for solo runs; under the full
// 1142-test sweep the very first cold-spawn (Node startup + 90-module
// registry load + JSON-RPC roundtrip) regularly lands at 18-22s on a loaded
// runner, intermittently tripping the timeout and producing a flaky "tools/list"
// failure that vanishes on rerun. 60s gives 3x headroom on cold start while
// still bounding a genuinely-stuck server. Sweep duration impact is zero
// because successful calls return in 1-3s and the timeout only matters when
// the server is broken.
function callMcp(method, params = {}, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [SERVER_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill();
        reject(new Error(`MCP call timed out after ${timeoutMs}ms: ${method}`));
      }
    }, timeoutMs);

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      // The server writes one JSON object per line.
      const lines = stdout.split('\n').filter(l => l.trim());
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            proc.kill();
            resolve(parsed);
          }
        } catch {
          // incomplete line — wait for more
        }
      }
    });

    proc.stderr.on('data', (c) => { stderr += c.toString(); });

    proc.on('error', (err) => {
      if (!settled) { settled = true; clearTimeout(timer); reject(err); }
    });

    const id = Math.floor(Math.random() * 100000);
    const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    proc.stdin.write(msg);
    proc.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// tools/list
// ---------------------------------------------------------------------------

describe('MCP server — tools/list', () => {
  it('returns exactly 9 tools', async () => {
    const res = await callMcp('tools/list', {});
    assert.ok(res.result, `expected result, got: ${JSON.stringify(res).slice(0, 200)}`);
    assert.ok(Array.isArray(res.result.tools), 'tools should be an array');
    assert.strictEqual(res.result.tools.length, 9);
  });

  it('includes the original 4 + the 5 added in the autopilot push', async () => {
    const res = await callMcp('tools/list', {});
    const names = res.result.tools.map(t => t.name);
    // Original 4
    assert.ok(names.includes('scan_local'),    'missing scan_local');
    assert.ok(names.includes('run_module'),    'missing run_module');
    assert.ok(names.includes('list_modules'),  'missing list_modules');
    assert.ok(names.includes('check_health'),  'missing check_health');
    // Added: fix_issue, compose_pr, explain_finding, audit_log, compare_repos
    assert.ok(names.includes('fix_issue'),       'missing fix_issue');
    assert.ok(names.includes('compose_pr'),      'missing compose_pr');
    assert.ok(names.includes('explain_finding'), 'missing explain_finding');
    assert.ok(names.includes('audit_log'),       'missing audit_log');
    assert.ok(names.includes('compare_repos'),   'missing compare_repos');
  });

  it('each tool has name, description, and inputSchema', async () => {
    const res = await callMcp('tools/list', {});
    for (const tool of res.result.tools) {
      assert.ok(tool.name,        `tool missing name: ${JSON.stringify(tool)}`);
      assert.ok(tool.description, `tool missing description: ${tool.name}`);
      assert.ok(tool.inputSchema, `tool missing inputSchema: ${tool.name}`);
    }
  });
});

// ---------------------------------------------------------------------------
// check_health
// ---------------------------------------------------------------------------

describe('MCP server — check_health', () => {
  it('returns operational status with 90 modules', async () => {
    const res = await callMcp('tools/call', { name: 'check_health', arguments: {} });
    assert.ok(res.result, `expected result: ${JSON.stringify(res).slice(0, 200)}`);
    const text = res.result.content[0].text;
    assert.ok(text.includes('Operational') || text.includes('✅'), `expected operational: ${text.slice(0, 200)}`);
    assert.ok(text.includes('90'), `expected 90 modules in health output: ${text}`);
  });

  it('returns content array with at least one text item', async () => {
    const res = await callMcp('tools/call', { name: 'check_health', arguments: {} });
    assert.ok(Array.isArray(res.result.content), 'content should be array');
    assert.ok(res.result.content.length > 0, 'content should be non-empty');
    assert.strictEqual(res.result.content[0].type, 'text');
  });
});

// ---------------------------------------------------------------------------
// list_modules
// ---------------------------------------------------------------------------

describe('MCP server — list_modules', () => {
  it('returns a list containing 90 modules', async () => {
    const res = await callMcp('tools/call', { name: 'list_modules', arguments: {} });
    const text = res.result.content[0].text;
    assert.ok(text.includes('90'), `expected 90 modules count: ${text.slice(0, 200)}`);
  });

  it('includes well-known module names in the output', async () => {
    const res = await callMcp('tools/call', { name: 'list_modules', arguments: {} });
    const text = res.result.content[0].text;
    assert.ok(text.includes('secrets'), `expected "secrets" module`);
    assert.ok(text.includes('tlsSecurity'), `expected "tlsSecurity" module`);
    assert.ok(text.includes('importCycle'), `expected "importCycle" module`);
  });
});

// ---------------------------------------------------------------------------
// run_module
// ---------------------------------------------------------------------------

describe('MCP server — run_module', () => {
  it('runs the syntax module and returns a formatted result', async () => {
    const res = await callMcp(
      'tools/call',
      { name: 'run_module', arguments: { module: 'syntax', path: SCAN_PATH } },
      30000
    );
    assert.ok(res.result, `expected result: ${JSON.stringify(res).slice(0, 200)}`);
    const text = res.result.content[0].text;
    assert.ok(text.includes('GateTest Scan'), `expected GateTest header: ${text.slice(0, 200)}`);
  });

  it('returns an error result for an unknown module', async () => {
    const res = await callMcp(
      'tools/call',
      { name: 'run_module', arguments: { module: 'nonExistentModule999', path: SCAN_PATH } },
      15000
    );
    const text = res.result.content[0].text;
    // Could be an error message or an empty/failed result — either is acceptable
    assert.ok(typeof text === 'string' && text.length > 0, 'should return some text');
  });

  it('returns isError for missing required arguments', async () => {
    const res = await callMcp(
      'tools/call',
      { name: 'run_module', arguments: { module: 'syntax' } }, // missing path
      10000
    );
    const text = res.result.content[0].text;
    assert.ok(
      res.result.isError === true || text.toLowerCase().includes('error') || text.toLowerCase().includes('required'),
      `expected error indication: ${text}`
    );
  });
});

// ---------------------------------------------------------------------------
// scan_local
// ---------------------------------------------------------------------------

describe('MCP server — scan_local', () => {
  it('runs a quick scan and returns structured results', async () => {
    const res = await callMcp(
      'tools/call',
      { name: 'scan_local', arguments: { path: SCAN_PATH, suite: 'quick' } },
      60000
    );
    assert.ok(res.result, `expected result: ${JSON.stringify(res).slice(0, 200)}`);
    const text = res.result.content[0].text;
    assert.ok(text.includes('GateTest Scan'), `expected scan header`);
    assert.ok(text.includes('Duration:'), `expected duration in output`);
  });

  it('returns isError for missing path', async () => {
    const res = await callMcp(
      'tools/call',
      { name: 'scan_local', arguments: {} },
      10000
    );
    assert.ok(
      res.result.isError === true || res.result.content[0].text.toLowerCase().includes('error'),
      'should flag missing path as error'
    );
  });
});

// ---------------------------------------------------------------------------
// Silent mode — engine must not write to stdout during MCP calls
// ---------------------------------------------------------------------------

describe('MCP server — silent mode', () => {
  it('does not leak engine console output to stdout (clean JSON-RPC)', async () => {
    const proc = spawn(process.execPath, [SERVER_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';

    proc.stdout.on('data', (c) => { stdout += c.toString(); });

    await new Promise((resolve) => {
      const id = 99;
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'check_health', arguments: {} } }) + '\n');
      proc.stdin.end();

      setTimeout(() => { proc.kill(); resolve(); }, 5000);
      proc.stdout.once('data', () => setTimeout(() => { proc.kill(); resolve(); }, 500));
    });

    // Every line must be valid JSON — no ANSI escape codes or plain text from ConsoleReporter
    const lines = stdout.split('\n').filter(l => l.trim());
    assert.ok(lines.length > 0, 'should have received at least one line');
    for (const line of lines) {
      try {
        JSON.parse(line);
      } catch {
        assert.fail(`Non-JSON line leaked to stdout (engine output contamination): ${line.slice(0, 100)}`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Unknown tool name
// ---------------------------------------------------------------------------

describe('MCP server — unknown tool', () => {
  it('returns an error for an unknown tool name', async () => {
    const res = await callMcp(
      'tools/call',
      { name: 'not_a_real_tool', arguments: {} },
      10000
    );
    const text = res.result.content[0].text;
    assert.ok(
      res.result.isError === true || text.toLowerCase().includes('unknown'),
      `expected unknown-tool error: ${text}`
    );
  });
});
