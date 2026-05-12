/**
 * GateTest GitHub App Server
 *
 * A lightweight GitHub App that:
 *   1. Receives webhooks (push, pull_request)
 *   2. Clones the repo
 *   3. Runs GateTest scan
 *   4. Posts results back (commit status + PR comment)
 *
 * Setup:
 *   1. Create GitHub App at github.com/settings/apps/new
 *   2. Set webhook URL to your server
 *   3. Download private key, set env vars
 *   4. Install the app on your repos
 *
 * Env vars:
 *   GATETEST_APP_ID          — GitHub App ID
 *   GATETEST_PRIVATE_KEY     — Contents of the .pem file (or path)
 *   GATETEST_WEBHOOK_SECRET  — Webhook secret for signature verification
 *   PORT                     — Server port (default: 3333)
 */

const http = require('http');
const crypto = require('crypto');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync, execFile } = require('child_process');

const PORT = process.env.PORT || 3333;
const APP_ID = process.env.GATETEST_APP_ID;
const WEBHOOK_SECRET = process.env.GATETEST_WEBHOOK_SECRET;
const GATETEST_DIR = path.resolve(__dirname, '..');

// ============================================================
//  GitHub App JWT Authentication
// ============================================================

function getPrivateKey() {
  const key = process.env.GATETEST_PRIVATE_KEY || '';
  // If it's a file path, read it
  if (key.startsWith('/') || key.startsWith('.')) {
    return fs.readFileSync(key, 'utf-8');
  }
  // If it's the actual key content
  if (key.includes('BEGIN')) {
    return key;
  }
  // Try default location
  const defaultPath = path.join(__dirname, '..', '.gatetest-app.pem');
  if (fs.existsSync(defaultPath)) {
    return fs.readFileSync(defaultPath, 'utf-8');
  }
  throw new Error('No private key found. Set GATETEST_PRIVATE_KEY env var.');
}

function base64url(data) {
  return Buffer.from(data).toString('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function createJWT() {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    iat: now - 60,
    exp: now + (10 * 60), // 10 min max
    iss: APP_ID,
  }));

  const privateKey = getPrivateKey();
  const signature = crypto.sign('sha256', Buffer.from(`${header}.${payload}`), privateKey);
  return `${header}.${payload}.${base64url(signature)}`;
}

// ============================================================
//  GitHub API helpers
// ============================================================

function githubApi(method, urlPath, token, body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: urlPath,
      method,
      headers: {
        'User-Agent': 'GateTest-App/1.0.0',
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${token}`,
      },
    };
    let payload = null;
    if (body) {
      payload = JSON.stringify(body);
      options.headers['Content-Type'] = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function getInstallationToken(installationId) {
  const jwt = createJWT();
  const result = await githubApi(
    'POST',
    `/app/installations/${installationId}/access_tokens`,
    jwt
  );
  return result.token;
}

// ============================================================
//  Webhook verification
// ============================================================

function verifySignature(payload, signature) {
  if (!WEBHOOK_SECRET) return true; // Skip if no secret configured
  const expected = 'sha256=' + crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(payload)
    .digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature || ''));
}

// ============================================================
//  Core: Clone, Scan, Report
// ============================================================

async function handlePush(event, token) {
  const repo = event.repository;
  const owner = repo.owner.login;
  const name = repo.name;
  const sha = event.after;
  const branch = event.ref.replace('refs/heads/', '');

  // [GateTest-Mute] // [GateTest-Mute] console.log(`[GateTest] Push to ${owner}/${name}@${branch} (${sha.slice(0, 7)})`);

  // Set pending status
  await githubApi('POST', `/repos/${owner}/${name}/statuses/${sha}`, token, {
    state: 'pending',
    context: 'GateTest',
    description: 'Scanning...',
  });

  // Clone and scan
  const result = await cloneAndScan(owner, name, branch, token);

  // Set final status
  await githubApi('POST', `/repos/${owner}/${name}/statuses/${sha}`, token, {
    state: result.passed ? 'success' : 'failure',
    context: 'GateTest',
    description: result.passed
      ? `All clear — ${result.checksPassed} checks passed`
      : `${result.issuesFound} issues found (${result.checksPassed}/${result.checksTotal} passed)`,
  });

  // [GateTest-Mute] // [GateTest-Mute] console.log(`[GateTest] ${owner}/${name}: ${result.passed ? 'PASSED' : 'BLOCKED'} — ${result.issuesFound} issues`);
}

async function handlePullRequest(event, token) {
  const pr = event.pull_request;
  const repo = event.repository;
  const owner = repo.owner.login;
  const name = repo.name;
  const sha = pr.head.sha;
  const branch = pr.head.ref;

  if (!['opened', 'synchronize', 'reopened'].includes(event.action)) return;

  // [GateTest-Mute] // [GateTest-Mute] console.log(`[GateTest] PR #${pr.number} on ${owner}/${name} (${branch})`);

  // Set pending status
  await githubApi('POST', `/repos/${owner}/${name}/statuses/${sha}`, token, {
    state: 'pending',
    context: 'GateTest',
    description: 'Scanning...',
  });

  // Clone and scan
  const result = await cloneAndScan(owner, name, branch, token);

  // Post PR comment with results
  const comment = formatPrComment(result);
  await githubApi('POST', `/repos/${owner}/${name}/issues/${pr.number}/comments`, token, {
    body: comment,
  });

  // Set final status
  await githubApi('POST', `/repos/${owner}/${name}/statuses/${sha}`, token, {
    state: result.passed ? 'success' : 'failure',
    context: 'GateTest',
    description: result.passed
      ? `All clear — ${result.checksPassed} checks passed`
      : `${result.issuesFound} issues found`,
  });
}

async function cloneAndScan(owner, name, branch, token) {
  const tmpDir = path.join('/tmp', `gatetest-${owner}-${name}-${Date.now()}`);

  try {
    // Clone
    const cloneUrl = `https://x-access-token:${token}@github.com/${owner}/${name}.git`;
    execSync(`git clone --depth 1 --branch ${branch} ${cloneUrl} ${tmpDir}`, {
      stdio: 'pipe',
      timeout: 60000,
    });

    // Run GateTest
    let output = '';
    try {
      output = execSync(
        `node ${path.join(GATETEST_DIR, 'bin/gatetest.js')} --suite standard --project ${tmpDir}`,
        { stdio: 'pipe', timeout: 120000, encoding: 'utf-8' }
      );
    } catch (e) {
      output = e.stdout || '';
    }

    // Parse results from JSON report
    const reportPath = path.join(tmpDir, '.gatetest/reports/gatetest-report-latest.json');
    let report = null;
    if (fs.existsSync(reportPath)) {
      try { report = JSON.parse(fs.readFileSync(reportPath, 'utf-8')); } catch {} // error-ok — malformed JSON treated as missing report
    }

    if (report) {
      return {
        passed: report.gatetest.gateStatus === 'PASSED',
        issuesFound: report.summary.checks.failed,
        checksPassed: report.summary.checks.passed,
        checksTotal: report.summary.checks.total,
        modulesPassed: report.summary.modules.passed,
        modulesTotal: report.summary.modules.total,
        results: report.results || [],
        failures: report.failures || [],
        duration: report.summary.duration,
      };
    }

    // Fallback: parse console output
    const issueMatch = output.match(/Checks:\s+(\d+)\/(\d+)/);
    return {
      passed: !output.includes('BLOCKED'),
      issuesFound: issueMatch ? (parseInt(issueMatch[2]) - parseInt(issueMatch[1])) : 0,
      checksPassed: issueMatch ? parseInt(issueMatch[1]) : 0,
      checksTotal: issueMatch ? parseInt(issueMatch[2]) : 0,
      modulesPassed: 0,
      modulesTotal: 0,
      results: [],
      failures: [],
      duration: 0,
    };

  } finally {
    // Cleanup
    try { execSync(`rm -rf ${tmpDir}`, { stdio: 'pipe' }); } catch {} // error-ok — cleanup in finally; failure is harmless
  }
}

function formatPrComment(result) {
  const status = result.passed ? '### ✅ GateTest: PASSED' : '### ❌ GateTest: BLOCKED';
  const summary = `| Metric | Value |
|--------|-------|
| Pass Rate | ${result.checksTotal > 0 ? Math.round((result.checksPassed / result.checksTotal) * 100) : 0}% |
| Modules | ${result.modulesPassed}/${result.modulesTotal} passed |
| Checks | ${result.checksPassed}/${result.checksTotal} passed |
| Issues | ${result.issuesFound} |
| Time | ${result.duration}ms |`;

  let failureList = '';
  if (result.failures.length > 0) {
    failureList = '\n\n**Failed modules:**\n' +
      result.failures.map(f => `- **${f.module}**: ${f.error}`).join('\n');
  }

  // Top 20 issues with details
  let issueDetails = '';
  if (result.failures.length > 0) {
    const allFailed = [];
    for (const f of result.failures) {
      if (f.failedChecks) {
        for (const check of f.failedChecks.slice(0, 5)) {
          allFailed.push({
            module: f.module,
            name: check.name,
            file: check.file || '',
            suggestion: check.suggestion || '',
          });
        }
      }
    }
    if (allFailed.length > 0) {
      issueDetails = '\n\n<details><summary>Top issues (click to expand)</summary>\n\n' +
        '| Module | Issue | File | Fix |\n|--------|-------|------|-----|\n' +
        allFailed.slice(0, 20).map(i =>
          `| ${i.module} | ${i.name} | \`${i.file}\` | ${i.suggestion} |`
        ).join('\n') +
        '\n\n</details>';
    }
  }

  return `${status}\n\n${summary}${failureList}${issueDetails}\n\n---\n*Scanned by [GateTest](https://gatetest.ai) — the QA gate for AI-generated code*`;
}

// ============================================================
//  HTTP Server
// ============================================================

const server = http.createServer(async (req, res) => {
  // Health check
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', app: 'GateTest', version: '1.0.0' }));
    return;
  }

  // Webhook endpoint
  if (req.method === 'POST' && req.url === '/webhook') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks).toString('utf-8');

      // Verify signature
      const sig = req.headers['x-hub-signature-256'];
      if (WEBHOOK_SECRET && !verifySignature(body, sig)) {
        // [GateTest-Mute] // [GateTest-Mute] console.log('[GateTest] Invalid webhook signature — rejected');
        res.writeHead(401);
        res.end('Invalid signature');
        return;
      }

      // Respond immediately (GitHub expects fast response)
      res.writeHead(200);
      res.end('ok');

      // Process async
      try {
        const event = JSON.parse(body);
        const eventType = req.headers['x-github-event'];
        const installationId = event.installation?.id;

        if (!installationId) {
          // [GateTest-Mute] // [GateTest-Mute] console.log(`[GateTest] No installation ID in ${eventType} event`);
          return;
        }

        const token = await getInstallationToken(installationId);

        if (eventType === 'push') {
          await handlePush(event, token);
        } else if (eventType === 'pull_request') {
          await handlePullRequest(event, token);
        } else {
          // [GateTest-Mute] // [GateTest-Mute] console.log(`[GateTest] Ignoring event: ${eventType}`);
        }
      } catch (err) { // error-ok — webhook handler must not crash the server process
        console.error(`[GateTest] Error processing webhook:`, err.message);
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

// ============================================================
//  Start
// ============================================================

if (!APP_ID) {
  // [GateTest-Mute] // [GateTest-Mute] console.log(`
╔══════════════════════════════════════════════════════════╗
║  GateTest GitHub App — Setup Required                    ║
╠══════════════════════════════════════════════════════════╣
║                                                          ║
║  1. Go to: github.com/settings/apps/new                 ║
║                                                          ║
║  2. Fill in:                                             ║
║     Name:        GateTest                                ║
║     Homepage:    https://gatetest.ai                     ║
║     Webhook URL: https://your-server.com/webhook         ║
║     Secret:      (generate one, save it)                 ║
║                                                          ║
║  3. Permissions:                                         ║
║     Repository:                                          ║
║       - Contents:        Read                            ║
║       - Commit statuses: Read & Write                    ║
║       - Pull requests:   Read & Write                    ║
║       - Issues:          Read & Write                    ║
║     Subscribe to events:                                 ║
║       - Push                                             ║
║       - Pull request                                     ║
║                                                          ║
║  4. Generate a private key (.pem file)                   ║
║                                                          ║
║  5. Set environment variables:                           ║
║     GATETEST_APP_ID=123456                               ║
║     GATETEST_PRIVATE_KEY=/path/to/key.pem                ║
║     GATETEST_WEBHOOK_SECRET=your_secret                  ║
║                                                          ║
║  6. Install the app on your repos:                       ║
║     github.com/settings/apps/gatetest/installations      ║
║                                                          ║
║  7. Run this server again                                ║
║                                                          ║
╚══════════════════════════════════════════════════════════╝
`);
  process.exit(1);
}

server.listen(PORT, () => {
  // [GateTest-Mute] // [GateTest-Mute] console.log(`
╔══════════════════════════════════════════════════════════╗
║  GateTest GitHub App — Running                           ║
╠══════════════════════════════════════════════════════════╣
║  Port:    ${String(PORT).padEnd(46)}║
║  App ID:  ${String(APP_ID).padEnd(46)}║
║  Webhook: POST /webhook                                  ║
║  Health:  GET  /                                         ║
╚══════════════════════════════════════════════════════════╝
  `);
});
