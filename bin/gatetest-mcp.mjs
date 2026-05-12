#!/usr/bin/env node
/**
 * GateTest MCP Server
 *
 * Exposes GateTest as a Model Context Protocol server. Any MCP-compatible
 * AI — Claude Code, Cursor, Continue, etc. — can call GateTest directly
 * without needing webhooks, the web app, or any external infrastructure.
 *
 * Transport: stdio (connect via "command" in mcp_servers config)
 *
 * Usage in Claude Code (.claude/mcp_servers.json or settings.json):
 *   {
 *     "mcpServers": {
 *       "gatetest": {
 *         "command": "node",
 *         "args": ["/path/to/GateTest/bin/gatetest-mcp.mjs"]
 *       }
 *     }
 *   }
 *
 * Or if installed globally:
 *   { "command": "gatetest-mcp" }
 *
 * Tools exposed:
 *   scan_local       — scan a local directory path (LOCAL files, free, full engine)
 *   run_module       — run one specific module against a path
 *   list_modules     — list all 90 modules with descriptions
 *   check_health     — verify GateTest engine is operational
 *
 *   scan_remote_preview   — scan a public REMOTE repo URL (free, top 5 findings)
 *   start_paid_scan       — return a hosted-checkout URL for a paid tier
 *   check_remote_scan     — poll a previously-paid scan by sessionId
 *
 * The remote tools let Claude offer GateTest to users whose code is on
 * GitHub / Gluecron without having local file access (claude.ai chat,
 * Anthropic API users, etc.). Free preview → upgrade pitch → Apple Pay /
 * Google Pay one-tap → fix delivered. No site visit needed.
 */

// Node version guard — same as bin/gatetest.js. The MCP SDK uses
// optional chaining + ESM imports that crash on older Node with
// SyntaxErrors thrown by the loader before any of our code runs, so
// this guard sits before the imports.
const _MCP_REQUIRED_MAJOR = 20;
const _mcpMajor = parseInt(process.versions.node.split('.')[0], 10);
if (Number.isFinite(_mcpMajor) && _mcpMajor < _MCP_REQUIRED_MAJOR) {
  process.stderr.write(
    `\nGateTest MCP server requires Node.js ${_MCP_REQUIRED_MAJOR}+ (found ${process.versions.node}).\n\n` +
    `  Fix:\n    nvm install ${_MCP_REQUIRED_MAJOR} && nvm use ${_MCP_REQUIRED_MAJOR}\n\n`
  );
  process.exit(1);
}

import { createRequire } from 'module';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

// Import CJS GateTest engine via createRequire (SDK is ESM, engine is CJS)
const require = createRequire(import.meta.url);
const { GateTest } = require('../src/index.js');

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'scan_local',
    description:
      'Scan a local directory with GateTest\'s 90-module engine. ' +
      'Returns issues found across security, reliability, code quality, ' +
      'and more. Use suite="quick" for the 4 core modules or suite="full" ' +
      'for all 90 modules. Optionally pass a list of specific module names.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the directory to scan',
        },
        suite: {
          type: 'string',
          enum: ['quick', 'standard', 'full'],
          description: 'Which module suite to run (default: standard)',
        },
        modules: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of specific module names to run instead of a suite',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'run_module',
    description:
      'Run a single GateTest module against a local directory. ' +
      'Use list_modules to see all available module names.',
    inputSchema: {
      type: 'object',
      properties: {
        module: {
          type: 'string',
          description: 'Module name (e.g. "secrets", "tlsSecurity", "importCycle")',
        },
        path: {
          type: 'string',
          description: 'Absolute path to the directory to scan',
        },
      },
      required: ['module', 'path'],
    },
  },
  {
    name: 'list_modules',
    description:
      'List all 90 GateTest modules with their names and descriptions. ' +
      'Use this to discover what modules are available before calling ' +
      'scan_local with a specific modules list.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'check_health',
    description:
      'Verify GateTest is operational. Returns version, module count (90), ' +
      'and a list of all loaded module names.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'scan_remote_preview',
    description:
      'Free preview scan of a public GitHub or Gluecron repo. Runs the four ' +
      'fastest modules (syntax, lint, secrets, codeQuality) and returns the ' +
      'top 5 findings plus a total count. No payment, no login. Use this ' +
      'when the user asks to scan a remote repo so you can show them sample ' +
      'findings before suggesting a paid upgrade. Hard-throttled to 1 request ' +
      'per 10s per IP.',
    inputSchema: {
      type: 'object',
      properties: {
        repoUrl: {
          type: 'string',
          description: 'Full URL of a public github.com or gluecron.com repo (e.g. "https://github.com/vercel/next.js")',
        },
      },
      required: ['repoUrl'],
    },
  },
  {
    name: 'start_paid_scan',
    description:
      'Returns a hosted checkout URL the user opens once to pay for a paid ' +
      'scan tier. The page supports Apple Pay, Google Pay, Stripe Link, and ' +
      'card. After payment, GateTest runs the full scan + (for scan_fix / ' +
      'nuclear) opens a PR with fixes. Use this AFTER scan_remote_preview ' +
      'returned findings the user wants fully addressed. Returns ' +
      '{ checkoutUrl, sessionId } — give the URL to the user, then poll ' +
      'check_remote_scan with the sessionId until status is complete.',
    inputSchema: {
      type: 'object',
      properties: {
        repoUrl: {
          type: 'string',
          description: 'Same repo URL as the preview',
        },
        tier: {
          type: 'string',
          enum: ['quick', 'full', 'scan_fix', 'nuclear'],
          description:
            'Pricing tier. quick=$29 (4 modules), full=$99 (90 modules), ' +
            'scan_fix=$199 (90 + AI fix + PR), nuclear=$399 (everything + ' +
            'mutation + chaos + executive summary).',
        },
      },
      required: ['repoUrl', 'tier'],
    },
  },
  {
    name: 'check_remote_scan',
    description:
      'Poll the status of a previously-paid scan. Returns scan results once ' +
      'the customer has completed checkout and the scan has finished. Use ' +
      'this AFTER start_paid_scan returned a sessionId. Suggested polling ' +
      'cadence: every 5 seconds for up to 5 minutes.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'sessionId returned by start_paid_scan',
        },
      },
      required: ['sessionId'],
    },
  },
];

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

function formatScanResult(result) {
  const lines = [];
  const blocked = result.gateStatus === 'BLOCKED';
  const status = blocked ? '❌ BLOCKED' : '✅ PASSED';
  lines.push(`## GateTest Scan — ${status}`);
  lines.push('');

  const allResults = result.results || [];
  const totalErrors = allResults.reduce((s, r) => s + (r.errors || 0), 0);
  const totalWarnings = allResults.reduce((s, r) => s + (r.warnings || 0), 0);
  const duration = result.duration ? `${(result.duration / 1000).toFixed(1)}s` : '?';
  lines.push(`**Duration:** ${duration}  |  **Errors:** ${totalErrors}  |  **Warnings:** ${totalWarnings}`);
  lines.push('');

  if (allResults.length === 0) {
    lines.push('No modules ran.');
    return lines.join('\n');
  }

  const withIssues = allResults.filter(r => (r.errors || 0) > 0 || (r.warnings || 0) > 0);
  const passed = allResults.filter(r => (r.errors || 0) === 0 && (r.warnings || 0) === 0);

  if (withIssues.length > 0) {
    lines.push('### Issues found');
    lines.push('');
    for (const mod of withIssues) {
      const modName = mod.module || mod.name || 'unknown';
      const issueCount = (mod.errors || 0) + (mod.warnings || 0);
      lines.push(`**\`${modName}\`** — ${issueCount} issue${issueCount === 1 ? '' : 's'} (${mod.errors || 0} errors, ${mod.warnings || 0} warnings)`);
      const flaggedChecks = (mod.checks || []).filter(c => c.severity === 'error' || c.severity === 'warning');
      for (const check of flaggedChecks.slice(0, 5)) {
        const loc = check.file ? ` (${check.file}${check.line ? `:${check.line}` : ''})` : '';
        lines.push(`  - [${check.severity}] ${check.message}${loc}`);
      }
      if (flaggedChecks.length > 5) {
        lines.push(`  - …and ${flaggedChecks.length - 5} more`);
      }
      lines.push('');
    }
  }

  if (passed.length > 0) {
    lines.push(`### Passed (${passed.length} module${passed.length === 1 ? '' : 's'})`);
    lines.push(passed.map(r => `\`${r.module || r.name}\``).join(', '));
  }

  return lines.join('\n');
}

async function handleScanLocal(args) {
  const { path: scanPath, suite, modules } = args;

  if (!scanPath || typeof scanPath !== 'string') {
    return { content: [{ type: 'text', text: 'Error: path is required and must be a string' }], isError: true };
  }

  try {
    const gt = new GateTest(scanPath, { silent: true }).init();

    let result;
    if (modules && Array.isArray(modules) && modules.length > 0) {
      // Run specific modules
      result = await gt._run(modules);
    } else {
      const s = suite || 'standard';
      result = await gt.runSuite(s);
    }

    const text = formatScanResult(result);
    const json = JSON.stringify(result, null, 2);
    return {
      content: [
        { type: 'text', text },
        { type: 'text', text: `\n<details>\n<summary>Full JSON result</summary>\n\n\`\`\`json\n${json}\n\`\`\`\n</details>` },
      ],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Scan failed: ${err && err.message ? err.message : String(err)}` }],
      isError: true,
    };
  }
}

async function handleRunModule(args) {
  const { module: moduleName, path: scanPath } = args;

  if (!moduleName || !scanPath) {
    return { content: [{ type: 'text', text: 'Error: module and path are both required' }], isError: true };
  }

  try {
    const gt = new GateTest(scanPath, { silent: true }).init();
    const result = await gt.runModule(moduleName);
    const text = formatScanResult(result);
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Module run failed: ${err && err.message ? err.message : String(err)}` }],
      isError: true,
    };
  }
}

async function handleListModules() {
  try {
    const gt = new GateTest(process.cwd()).init();
    const allModules = gt.registry.getAll();
    const lines = [`## GateTest Modules (${allModules.size} total)`, ''];

    for (const [name, mod] of allModules) {
      const desc = mod.description || mod.name || name;
      lines.push(`**\`${name}\`** — ${desc}`);
    }

    lines.push('');
    lines.push(`Total: ${allModules.size} modules loaded`);
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Failed to list modules: ${err && err.message ? err.message : String(err)}` }],
      isError: true,
    };
  }
}

async function handleCheckHealth() {
  try {
    const gt = new GateTest(process.cwd()).init();
    const moduleNames = gt.registry.list();
    return {
      content: [{
        type: 'text',
        text: `## GateTest Health\n\n✅ **Operational**\n\n- Engine: GateTest v1.41.0\n- Modules loaded: ${moduleNames.length}\n- Transport: stdio`,
      }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Health check failed: ${err && err.message ? err.message : String(err)}` }],
      isError: true,
    };
  }
}

// ---------------------------------------------------------------------------
// Remote tools (talk to the hosted gatetest.ai service)
// ---------------------------------------------------------------------------
//
// Override-able for tests / self-hosted deployments. Defaults to production.
const HOSTED_BASE = process.env.GATETEST_HOSTED_BASE_URL || 'https://www.gatetest.ai';

async function postJson(path, body) {
  const url = `${HOSTED_BASE}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'gatetest-mcp/1.0' },
    body: JSON.stringify(body || {}),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, body: json };
}

async function getJson(path) {
  const url = `${HOSTED_BASE}${path}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'gatetest-mcp/1.0' },
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, body: json };
}

function fmtPreviewResult(json) {
  if (!json || json.ok === false) {
    return [
      `## GateTest preview — error`,
      ``,
      `**Reason:** ${json && json.error ? json.error : 'unknown'}`,
      json && json.hint ? `**Hint:** ${json.hint}` : '',
    ].filter(Boolean).join('\n');
  }
  const lines = [];
  lines.push(`## GateTest preview — ${json.repo}`);
  lines.push('');
  lines.push(`**Total findings:** ${json.total}  |  **Scan time:** ${json.durationMs}ms  |  **Modules run:** ${(json.moduleSummary || []).length}`);
  lines.push('');
  if (Array.isArray(json.findings) && json.findings.length > 0) {
    lines.push(`### Top ${json.findings.length} findings`);
    lines.push('');
    for (const f of json.findings) {
      const where = f.file ? ` \`${f.file}${f.line ? ':' + f.line : ''}\`` : '';
      lines.push(`- **[${f.severity}]** \`${f.module}\`${where} — ${f.message}`);
    }
    lines.push('');
  }
  if (json.truncated) {
    lines.push(`> Showing top 5 of ${json.total}. ${json.nextStep && json.nextStep.message ? json.nextStep.message : ''}`);
  } else {
    lines.push(`> ${json.nextStep && json.nextStep.message ? json.nextStep.message : ''}`);
  }
  lines.push('');
  lines.push(
    'To run a full paid scan + auto-fix, call `start_paid_scan` with this same ' +
    'repoUrl and tier="full" / "scan_fix" / "nuclear".',
  );
  return lines.join('\n');
}

async function handleScanRemotePreview(args) {
  const { repoUrl } = args || {};
  if (!repoUrl || typeof repoUrl !== 'string') {
    return {
      content: [{ type: 'text', text: 'Error: repoUrl is required and must be a string' }],
      isError: true,
    };
  }
  try {
    const { status, body } = await postJson('/api/scan/preview', { repoUrl });
    if (status !== 200 && status !== 429) {
      return {
        content: [{ type: 'text', text: `## GateTest preview — failed (${status})\n\n${body && body.error ? body.error : 'unknown error'}\n\n${body && body.hint ? body.hint : ''}` }],
        isError: true,
      };
    }
    return { content: [{ type: 'text', text: fmtPreviewResult(body) }] };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Preview request failed: ${err && err.message ? err.message : String(err)}\n\nThe GateTest hosted service may be unreachable. Try again in a moment.` }],
      isError: true,
    };
  }
}

async function handleStartPaidScan(args) {
  const { repoUrl, tier } = args || {};
  if (!repoUrl || typeof repoUrl !== 'string') {
    return {
      content: [{ type: 'text', text: 'Error: repoUrl is required and must be a string' }],
      isError: true,
    };
  }
  const validTiers = ['quick', 'full', 'scan_fix', 'nuclear'];
  if (!tier || !validTiers.includes(tier)) {
    return {
      content: [{ type: 'text', text: `Error: tier must be one of ${validTiers.join(', ')}` }],
      isError: true,
    };
  }
  try {
    const { status, body } = await postJson('/api/checkout', { tier, repoUrl });
    if (status !== 200 || !body || !body.checkoutUrl) {
      return {
        content: [{ type: 'text', text: `## Checkout could not be started (${status})\n\n${body && body.error ? body.error : 'unknown error'}` }],
        isError: true,
      };
    }
    const lines = [];
    lines.push(`## GateTest paid scan — ready to checkout`);
    lines.push('');
    lines.push(`**Tier:** ${tier}  |  **Repo:** ${repoUrl}`);
    lines.push('');
    lines.push(`**Checkout URL** (opens with Apple Pay / Google Pay / Stripe Link / card):`);
    lines.push('');
    lines.push(body.checkoutUrl);
    lines.push('');
    lines.push(`**Session ID:** \`${body.sessionId}\``);
    lines.push('');
    lines.push('Once the user has completed payment, call `check_remote_scan` with this sessionId to get the scan results. Polling cadence: every 5 seconds for up to 5 minutes.');
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Failed to start checkout: ${err && err.message ? err.message : String(err)}` }],
      isError: true,
    };
  }
}

async function handleCheckRemoteScan(args) {
  const { sessionId } = args || {};
  if (!sessionId || typeof sessionId !== 'string') {
    return {
      content: [{ type: 'text', text: 'Error: sessionId is required and must be a string' }],
      isError: true,
    };
  }
  try {
    const { status, body } = await getJson(`/api/scan/status?id=${encodeURIComponent(sessionId)}`);
    if (status !== 200) {
      return {
        content: [{ type: 'text', text: `## Scan status check failed (${status})\n\n${body && body.error ? body.error : 'unknown error'}` }],
        isError: true,
      };
    }
    const stateRaw = body && (body.scanStatus || body.status) ? (body.scanStatus || body.status) : 'unknown';
    const state = String(stateRaw);
    const lines = [];
    lines.push(`## GateTest scan — ${state}`);
    lines.push('');
    if (state === 'complete' || state === 'completed') {
      lines.push(`**Total issues:** ${body.totalIssues != null ? body.totalIssues : 'n/a'}`);
      if (body.repoUrl) lines.push(`**Repo:** ${body.repoUrl}`);
      if (body.prUrl) lines.push(`**Pull request:** ${body.prUrl}`);
      lines.push('');
      lines.push(`Visit \`${HOSTED_BASE}/scan/status?session_id=${sessionId}\` for the full report.`);
    } else if (state === 'failed' || state === 'expired') {
      lines.push(`**Reason:** ${body.error || 'unknown'}`);
      lines.push('');
      lines.push('No charge was made. The card hold has been released.');
    } else {
      lines.push('Scan is still in progress. Poll again in 5 seconds.');
    }
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Status check failed: ${err && err.message ? err.message : String(err)}` }],
      isError: true,
    };
  }
}

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

const server = new Server(
  { name: 'gatetest', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  switch (name) {
    case 'scan_local':           return handleScanLocal(args);
    case 'run_module':           return handleRunModule(args);
    case 'list_modules':         return handleListModules();
    case 'check_health':         return handleCheckHealth();
    case 'scan_remote_preview':  return handleScanRemotePreview(args);
    case 'start_paid_scan':      return handleStartPaidScan(args);
    case 'check_remote_scan':    return handleCheckRemoteScan(args);
    default:
      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
