#!/usr/bin/env node

/**
 * GateTest CLI - Command-line interface for the GateTest QA system.
 *
 * Usage:
 *   gatetest                    Run standard test suite
 *   gatetest --suite full       Run the full test suite
 *   gatetest --suite quick      Run quick checks only
 *   gatetest --module security  Run a specific module
 *   gatetest --module visual    Run visual regression tests
 *   gatetest --validate         Validate CLAUDE.md file
 *   gatetest --report           Show latest report
 *   gatetest --list             List available modules
 *   gatetest --init             Initialize GateTest in a project
 */

// ---- Node version guard (Phase 6 launch hardening, item 4) ----
// engines.node in package.json is advisory; npm warns but doesn't block.
// A user on Node 18 hitting an `??` or top-level await would get a cryptic
// SyntaxError far from the call site. Surface a clean message instead.
const REQUIRED_MAJOR = 20;
const currentMajor = parseInt(process.versions.node.split('.')[0], 10);
if (Number.isFinite(currentMajor) && currentMajor < REQUIRED_MAJOR) {
  process.stderr.write(
    `\nGateTest requires Node.js ${REQUIRED_MAJOR}+ (found ${process.versions.node}).\n\n` +
    `  Fix:\n` +
    `    nvm install ${REQUIRED_MAJOR} && nvm use ${REQUIRED_MAJOR}\n` +
    `    or download Node ${REQUIRED_MAJOR}+ from https://nodejs.org\n\n`
  );
  process.exit(1);
}

const path = require('path');
const fs = require('fs');
const { GateTest } = require('../src/index');

const HELP = `
  GateTest - Advanced QA Gate System
  Nothing ships unless it's pristine.

  USAGE
    gatetest [options]

  OPTIONS
    --suite <name>     Run a test suite: quick, standard, full (default: standard)
    --module <name>    Run a specific module by name
    --validate         Validate the CLAUDE.md file
    --report           Display the latest test report
    --list             List all available test modules
    --init             Initialize GateTest in the current project
    --parallel         Run modules in parallel
    --stop-first       Stop on first module failure
    --fix              Auto-fix safe issues (formatting, imports, etc.)
    --diff             Only scan git-changed files (fast pre-commit mode)
    --watch            Watch for file changes and re-scan continuously
    --sarif            Output results in SARIF format (for GitHub Security)
    --junit            Output results in JUnit XML format (for CI)
    --ci-init <type>   Generate CI config: github, gitlab, circleci
    --project <path>   Set project root (default: cwd)
    --help, -h         Show this help message
    --version, -v      Show version

    --server <url>     Scan a live server: SSL, headers, DNS, performance
    --crawl <url>      Crawl a live website and test every page
    --crawl-loop <url> Crawl, report failures, wait for fixes, repeat until clean
    --crawl-max <n>    Max pages to crawl (default: 100)
    --feedback         Show the latest crawl feedback report

    --diagnose <url>   Full real-time diagnosis: availability, response time, cache, bottleneck, action plan
    --monitor <url>    Continuous monitoring: polls every 60s, alerts on downtime/slowness/stale content
    --monitor-interval <n>  Polling interval in seconds (default: 60)
    --monitor-heal     Auto-apply safe fixes (cache flush) when issues detected
    --flush <url>      Flush CDN cache: tries Vercel, Cloudflare, custom webhook, then gives manual steps

    --repair <url>     Self-sufficient repair: clone → scan → patch → verify → push (no external API needed)
    --repair-token <t> Git credential for clone + push (PAT, deploy token, etc.)
    --repair-dry-run   Show what would be fixed without writing or pushing
    --repair-suite <s> Which scan suite to run during repair (default: full)

    --prune-prs <owner/repo>  Delete stale GateTest/Claude branches + close abandoned PRs
    --prune-pattern <prefix>  Branch prefix to match (default: "gatetest/,claude/")
    --prune-dry-run           Show what would be deleted without actually deleting
    --prune-stale-days <n>    Age threshold in days before a branch is considered stale (default: 7)

  EXAMPLES
    gatetest                          Run standard checks
    gatetest --suite full             Run every single check
    gatetest --module security        Security scan only
    gatetest --module visual          Visual regression only
    gatetest --suite quick            Fast pre-commit checks
    gatetest --server https://gatetest.ai    Scan server SSL, headers, DNS
    gatetest --crawl https://zoobicon.com   Crawl and test live site
    gatetest --diagnose https://mysite.com  Full real-time diagnosis + action plan
    gatetest --monitor https://mysite.com   Start continuous monitoring (60s poll)
    gatetest --monitor https://mysite.com --monitor-interval 30 --monitor-heal
    gatetest --flush https://mysite.com     Flush CDN cache (Vercel/Cloudflare/webhook)
    gatetest --crawl-loop https://zoobicon.com  Continuous test-fix loop

  MODULES
    syntax         Syntax & compilation validation
    lint           ESLint, Stylelint, Markdownlint
    secrets        Secret & credential detection
    codeQuality    Code quality analysis
    unitTests      Unit test execution
    integrationTests  Integration test execution
    e2e            End-to-end test execution
    visual         Visual regression testing
    accessibility  WCAG 2.2 AAA compliance
    performance    Performance & Web Vitals
    security       Security analysis
    seo            SEO & metadata validation
    links          Broken link detection
    compatibility  Browser compatibility
    dataIntegrity  Data integrity validation
    documentation  Documentation completeness
    liveCrawler    Live site crawl & verification
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(HELP);
    process.exit(0);
  }

  if (args.version) {
    const pkg = require('../package.json');
    console.log(`GateTest v${pkg.version}`);
    process.exit(0);
  }

  const projectRoot = args.project || process.cwd();

  if (args.init) {
    initProject(projectRoot);
    return;
  }

  // Health check — verify GitHub API access before starting scans
  if (args.health) {
    const { GitHubBridge } = require('../src/core/github-bridge');
    const bridge = new GitHubBridge({ projectRoot });
    console.log('\n[GateTest] GitHub API Health Check\n');

    const health = await bridge.healthCheck();
    if (health.available) {
      console.log(`  Status:     CONNECTED`);
      console.log(`  Latency:    ${health.latencyMs}ms`);
      console.log(`  Rate Limit: ${health.rateLimit.remaining}/${health.rateLimit.limit} remaining`);
      if (health.rateLimit.resetsAt) {
        console.log(`  Resets At:  ${health.rateLimit.resetsAt}`);
      }
    } else {
      console.log(`  Status:     UNREACHABLE`);
      console.log(`  Error:      ${health.error || `HTTP ${health.statusCode}`}`);
    }

    console.log(`  Circuit:    ${health.circuitBreaker.status} (${health.circuitBreaker.failures} failures)`);

    const status = bridge.getAccessStatus();
    console.log(`  Retry:      ${status.retryConfig.maxRetries} retries, ${status.retryConfig.baseDelayMs}ms base delay\n`);

    // Try auth verification
    try {
      const auth = await bridge.verifyAuth();
      console.log(`  Auth:       ${auth.type} — ${auth.login || auth.name}`);
    } catch (err) { // error-ok — auth check in CLI health output; failure message shown to user
      console.log(`  Auth:       ${err.message}`);
    }

    console.log('');
    process.exit(health.available ? 0 : 1);
  }

  if (args.initClaudeMd) {
    const { ClaudeMdGenerator } = require('../src/core/claude-md-generator');
    const siteUrl = args.crawl || args.crawlLoop || null;
    const generator = new ClaudeMdGenerator(projectRoot, { siteUrl });
    const outPath = await generator.generateAndWrite();
    console.log(`\n[GateTest] CLAUDE.md generated at: ${outPath}`);
    console.log('[GateTest] Hooks installed at: .claude/settings.json');
    console.log('[GateTest] Scan script created: gatetest-scan.js\n');
    return;
  }

  // CI config generation
  if (args.ciInit) {
    const { CiGenerator } = require('../src/core/ci-generator');
    const gen = new CiGenerator(projectRoot);
    const outPath = gen.generate(args.ciInit);
    console.log(`\n[GateTest] CI config generated: ${outPath}\n`);
    return;
  }

  const gatetest = new GateTest(projectRoot, {
    parallel: args.parallel || false,
    stopOnFirstFailure: args['stop-first'] || false,
    autoFix: args.fix || false,
    diffOnly: args.diff || false,
    sarif: args.sarif || false,
    junit: args.junit || false,
  });

  gatetest.init();

  // Watch mode
  if (args.watch) {
    await runWatchMode(gatetest, args);
    return;
  }

  if (args.validate) {
    const validation = gatetest.validateClaudeMd();
    console.log('\nCLAUDE.md Validation:');
    console.log(`  Valid: ${validation.valid}`);
    console.log(`  Sections: ${validation.stats.sections}`);
    console.log(`  Checklist Items: ${validation.stats.totalItems}`);
    console.log(`  Gate Rules: ${validation.stats.gateRules}`);
    console.log(`  Version: ${validation.stats.version}`);
    if (validation.issues.length > 0) {
      console.log('\n  Issues:');
      for (const issue of validation.issues) {
        console.log(`    - ${issue}`);
      }
    }
    process.exit(validation.valid ? 0 : 1);
  }

  if (args.list) {
    const modules = gatetest.registry.list();
    console.log('\nAvailable GateTest Modules:\n');
    for (const name of modules) {
      const mod = gatetest.registry.get(name);
      console.log(`  ${name.padEnd(20)} ${mod?.description || ''}`);
    }
    console.log('');
    process.exit(0);
  }

  if (args.report) {
    showLatestReport(projectRoot);
    return;
  }

  if (args.feedback) {
    showCrawlFeedback(projectRoot);
    return;
  }

  // Live site crawl
  if (args.crawl) {
    await runCrawl(gatetest, args.crawl, args.crawlMax || 100);
    return;
  }

  // Continuous crawl-fix loop
  if (args.crawlLoop) {
    await runCrawlLoop(gatetest, args.crawlLoop, args.crawlMax || 100);
    return;
  }

  // Full real-time diagnosis
  if (args.diagnose) {
    const Diagnostics = require('../src/runtime/diagnostics');
    const diag = new Diagnostics();
    const url = args.diagnose.startsWith('http') ? args.diagnose : `https://${args.diagnose}`;
    console.log(`\n  GATETEST — Real-Time Diagnosis\n  Target: ${url}\n`);
    try {
      const r = await diag.diagnose(url);
      const icon = { healthy: '\x1b[32m✓ HEALTHY\x1b[0m', warning: '\x1b[33m! WARNING\x1b[0m', degraded: '\x1b[33m⚠ DEGRADED\x1b[0m', critical: '\x1b[31m✗ CRITICAL\x1b[0m' }[r.status] || r.status;
      console.log(`  Status: ${icon}`);
      if (r.checks.responseTime) console.log(`  Response: p50=${r.checks.responseTime.p50}ms, p95=${r.checks.responseTime.p95}ms`);
      if (r.checks.cache) console.log(`  Cache: ${r.checks.cache.strategy || 'unknown'} | CDN: ${r.checks.cache.cdnStatus || 'n/a'}`);
      if (r.checks.bottleneck?.classification !== 'none') console.log(`  Bottleneck: ${r.checks.bottleneck?.classification || 'none'}`);
      if (r.issues.length > 0) {
        console.log('\n  Issues found:');
        for (const i of r.issues) console.log(`    ${i.severity === 'critical' ? '\x1b[31m✗\x1b[0m' : i.severity === 'error' ? '\x1b[33m!\x1b[0m' : '·'} [${i.code}] ${i.message}`);
      }
      if (r.actions.length > 0) {
        console.log('\n  Recommended actions:');
        for (const a of r.actions) console.log(`    → ${a}`);
      }
      console.log('');
      process.exit(r.status === 'healthy' ? 0 : 1);
    } catch (err) {
      console.error(`\n  \x1b[31mDiagnosis failed: ${err.message}\x1b[0m\n`);
      process.exit(1);
    }
  }

  // Direct repair — self-sufficient clone → scan → patch → push
  // PR + branch pruner
  if (args.prunePrs) {
    const { PrPruner } = require('../src/core/pr-pruner');
    const [owner, repo] = args.prunePrs.includes('/') ? args.prunePrs.split('/') : [args.prunePrs, null];
    if (!owner || !repo) {
      console.error('  Usage: gatetest --prune-prs <owner/repo>');
      process.exit(1);
    }
    const patterns = args.prunePattern ? args.prunePattern.split(',') : ['gatetest/', 'claude/'];
    const pruner = new PrPruner({
      token: process.env.GATETEST_GITHUB_TOKEN || process.env.GITHUB_TOKEN,
      patterns,
      dryRun: args.pruneDryRun || false,
      staleDays: args.pruneStale || 7,
    });

    console.log(`\n  GATETEST — PR + Branch Pruner`);
    console.log(`  Repository : ${owner}/${repo}`);
    console.log(`  Patterns   : ${patterns.join(', ')}`);
    console.log(`  Stale days : ${args.pruneStale || 7}`);
    console.log(`  Dry run    : ${args.pruneDryRun ? 'yes (nothing will be deleted)' : 'no'}\n`);

    const report = await pruner.prune(owner, repo);

    console.log(`  Scanned    : ${report.scanned} matching branches`);
    if (report.closedPRs.length > 0) {
      console.log(`  Closed PRs : ${report.closedPRs.map(p => `#${p.number}${p.dryRun ? ' (dry)' : ''}`).join(', ')}`);
    }
    if (report.deletedBranches.length > 0) {
      console.log(`  Deleted    : ${report.deletedBranches.length} branches`);
      for (const b of report.deletedBranches) {
        console.log(`    ${b.dryRun ? '[dry] ' : ''}${b.branch}  (${b.reason})`);
      }
    }
    if (report.skipped.length > 0) {
      console.log(`  Skipped    : ${report.skipped.length} (too new or active)`);
    }
    if (report.errors.length > 0) {
      console.log(`  Errors     :`);
      for (const e of report.errors) console.log(`    ${e.branch}: ${e.error}`);
    }
    if (report.deletedBranches.length === 0 && report.closedPRs.length === 0) {
      console.log(`  Nothing to clean up.`);
    }
    console.log();
    process.exit(report.errors.length > 0 ? 1 : 0);
  }

  if (args.repair) {
    const { DirectRepair } = require('../src/core/direct-repair');
    const repoUrl = args.repair.startsWith('http') || args.repair.startsWith('git@')
      ? args.repair : `https://github.com/${args.repair}`;
    const token = args.repairToken || process.env.GATETEST_GITHUB_TOKEN || process.env.GLUECRON_API_TOKEN || '';
    const engine = new DirectRepair({
      dryRun: args.repairDryRun || false,
      claudeFn: process.env.ANTHROPIC_API_KEY ? async (prompt) => {
        const Anthropic = require('@anthropic-ai/sdk');
        const client = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });
        const msg = await client.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 8192,
          messages: [{ role: 'user', content: prompt }],
        });
        return msg.content[0]?.text || null;
      } : null,
    });

    console.log(`\n  GATETEST — Direct Repair`);
    console.log(`  Repository : ${repoUrl}`);
    console.log(`  Suite      : ${args.repairSuite || 'full'}`);
    console.log(`  Dry run    : ${args.repairDryRun ? 'yes' : 'no'}`);
    console.log(`  Claude     : ${process.env.ANTHROPIC_API_KEY ? 'available (novel patterns)' : 'not configured (builtin + cache only)'}\n`);

    const report = await engine.repair(repoUrl, token, { suite: args.repairSuite || 'full' });

    if (report.error) {
      console.error(`  ERROR: ${report.error}`);
      process.exit(1);
    }

    console.log(`  Findings   : ${report.findings.length}`);
    console.log(`  Fixed      : ${report.fixes.length} (${report.cacheHits} cache hits, ${report.claudeCalls} Claude calls)`);
    console.log(`  Skipped    : ${report.skipped.length}`);
    if (report.committed) console.log(`  Committed  : ${report.commitSha} on branch ${report.branch}`);
    if (report.pushed)    console.log(`  Pushed     : yes`);
    console.log(`  Duration   : ${report.duration}s\n`);

    if (report.fixes.length > 0) {
      console.log('  Fixed issues:');
      for (const f of report.fixes) {
        console.log(`    [${f.strategy}] ${f.finding.module}: ${f.finding.detail.slice(0, 70)}`);
      }
    }
    process.exit(report.fixes.length > 0 ? 0 : 1);
  }

  // Continuous monitoring
  if (args.monitor) {
    const Monitor = require('../src/runtime/monitor');
    const url = args.monitor.startsWith('http') ? args.monitor : `https://${args.monitor}`;
    const monitor = new Monitor({
      autoHeal: args.monitorHeal || false,
      webhook: process.env.GATETEST_ALERT_WEBHOOK,
      logFile: require('path').join(process.cwd(), '.gatetest', 'monitor', 'monitor.log'),
    });
    monitor.addTarget(url, { interval: args.monitorInterval || 60, label: url });
    monitor.start();
    return;
  }

  // Cache flush
  if (args.flush) {
    const CacheManager = require('../src/runtime/cache-manager');
    const cm = new CacheManager();
    const url = args.flush.startsWith('http') ? args.flush : `https://${args.flush}`;
    console.log(`\n  GATETEST — Cache Flush\n  Target: ${url}\n`);
    try {
      const r = await cm.flush(url);
      for (const a of r.actions) {
        const icon = a.success ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
        console.log(`  ${icon} ${a.provider}: ${a.message}`);
      }
      if (r.manualSteps.length > 0) {
        console.log('\n  Manual steps:');
        for (const s of r.manualSteps) console.log(`    ${s}`);
      }
      console.log('');
      process.exit(r.actions.some(a => a.success) ? 0 : 1);
    } catch (err) {
      console.error(`\n  \x1b[31mFlush failed: ${err.message}\x1b[0m\n`);
      process.exit(1);
    }
  }

  // Server scan — check SSL, headers, DNS, performance on a live URL
  if (args.server) {
    const ServerScanner = require('../src/scanners/server-scanner');
    const scanner = new ServerScanner();
    const url = args.server.startsWith('http') ? args.server : `https://${args.server}`;
    console.log(`\n  GATETEST — Server Scan\n  Target: ${url}\n`);

    try {
      const result = await scanner.scan(url);
      for (const mod of result.modules) {
        const icon = mod.status === 'passed' ? '\x1b[32m✓\x1b[0m' : mod.status === 'warning' ? '\x1b[33m!\x1b[0m' : '\x1b[31m✗\x1b[0m';
        console.log(`  ${icon} ${mod.label || mod.name} — ${mod.checks} checks, ${mod.issues} issues`);
        for (const d of (mod.details || [])) {
          const color = d.startsWith('error') ? '\x1b[31m' : d.startsWith('warning') ? '\x1b[33m' : d.startsWith('pass') ? '\x1b[32m' : '\x1b[90m';
          console.log(`      ${color}${d}\x1b[0m`);
        }
      }
      console.log(`\n  ${result.totalIssues === 0 ? '\x1b[32mSERVER: CLEAN\x1b[0m' : `\x1b[33mSERVER: ${result.totalIssues} ISSUES\x1b[0m`} — ${result.totalChecks} checks, ${result.duration}ms\n`);
      process.exit(result.totalIssues === 0 ? 0 : 1);
    } catch (err) {
      console.error(`\n  \x1b[31mError: ${err.message}\x1b[0m\n`);
      process.exit(1);
    }
  }

  // Run tests
  let summary;
  if (args.module) {
    summary = await gatetest.runModule(args.module);
  } else {
    summary = await gatetest.runSuite(args.suite || 'standard');
  }

  process.exit(summary.gateStatus === 'PASSED' ? 0 : 1);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--version' || arg === '-v') args.version = true;
    else if (arg === '--validate') args.validate = true;
    else if (arg === '--list') args.list = true;
    else if (arg === '--report') args.report = true;
    else if (arg === '--init') args.init = true;
    else if (arg === '--init-claude-md') args.initClaudeMd = true;
    else if (arg === '--health') args.health = true;
    else if (arg === '--parallel') args.parallel = true;
    else if (arg === '--stop-first') args['stop-first'] = true;
    else if (arg === '--fix') args.fix = true;
    else if (arg === '--diff') args.diff = true;
    else if (arg === '--watch') args.watch = true;
    else if (arg === '--sarif') args.sarif = true;
    else if (arg === '--junit') args.junit = true;
    else if (arg === '--ci-init' && argv[i + 1]) args.ciInit = argv[++i];
    else if (arg === '--suite' && argv[i + 1]) args.suite = argv[++i];
    else if (arg === '--module' && argv[i + 1]) args.module = argv[++i];
    else if (arg === '--project' && argv[i + 1]) args.project = argv[++i];
    else if (arg === '--server' && argv[i + 1]) args.server = argv[++i];
    else if (arg === '--crawl' && argv[i + 1]) args.crawl = argv[++i];
    else if (arg === '--crawl-loop' && argv[i + 1]) args.crawlLoop = argv[++i];
    else if (arg === '--crawl-max' && argv[i + 1]) args.crawlMax = parseInt(argv[++i]);
    else if (arg === '--feedback') args.feedback = true;
    else if (arg === '--diagnose' && argv[i + 1]) args.diagnose = argv[++i];
    else if (arg === '--monitor' && argv[i + 1]) args.monitor = argv[++i];
    else if (arg === '--monitor-interval' && argv[i + 1]) args.monitorInterval = parseInt(argv[++i]);
    else if (arg === '--monitor-heal') args.monitorHeal = true;
    else if (arg === '--repair' && argv[i + 1]) args.repair = argv[++i];
    else if (arg === '--repair-token' && argv[i + 1]) args.repairToken = argv[++i];
    else if (arg === '--repair-dry-run') args.repairDryRun = true;
    else if (arg === '--repair-suite' && argv[i + 1]) args.repairSuite = argv[++i];
    else if (arg === '--prune-prs' && argv[i + 1]) args.prunePrs = argv[++i];
    else if (arg === '--prune-pattern' && argv[i + 1]) args.prunePattern = argv[++i];
    else if (arg === '--prune-dry-run') args.pruneDryRun = true;
    else if (arg === '--prune-stale-days' && argv[i + 1]) args.pruneStale = parseInt(argv[++i]);
    else if (arg === '--flush' && argv[i + 1]) args.flush = argv[++i];
  }
  return args;
}

function initProject(projectRoot) {
  const configDir = path.join(projectRoot, '.gatetest');
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  const dirs = ['reports', 'screenshots', 'baselines', 'modules'];
  for (const dir of dirs) {
    const fullPath = path.join(configDir, dir);
    if (!fs.existsSync(fullPath)) {
      fs.mkdirSync(fullPath, { recursive: true });
    }
  }

  // Create default config
  const configPath = path.join(configDir, 'config.json');
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify({
      thresholds: {},
      modules: {},
      reporting: { formats: ['json', 'html', 'console'] },
    }, null, 2));
  }

  console.log('\nGateTest initialized successfully!');
  console.log(`  Config: ${configDir}/config.json`);
  console.log(`  Reports: ${configDir}/reports/`);
  console.log('\nRun "gatetest --suite quick" to test your setup.\n');
}

function showLatestReport(projectRoot) {
  const reportPath = path.join(projectRoot, '.gatetest/reports/gatetest-report-latest.json');
  if (!fs.existsSync(reportPath)) {
    console.log('\nNo reports found. Run "gatetest" first.\n');
    process.exit(1);
  }

  const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
  console.log('\nLatest GateTest Report:');
  console.log(`  Status: ${report.gatetest.gateStatus}`);
  console.log(`  Time: ${report.gatetest.timestamp}`);
  console.log(`  Modules: ${report.summary.modules.passed}/${report.summary.modules.total} passed`);
  console.log(`  Checks: ${report.summary.checks.passed}/${report.summary.checks.total} passed`);
  console.log(`  Duration: ${report.summary.duration}ms`);

  if (report.failures.length > 0) {
    console.log('\n  Failures:');
    for (const f of report.failures) {
      console.log(`    - ${f.module}: ${f.error}`);
    }
  }
  console.log('');
}

async function runCrawl(gatetest, url, maxPages) {
  // Inject crawl URL into config
  gatetest.config.config.modules.liveCrawler = {
    url,
    maxPages,
    timeout: 10000,
    checkExternal: true,
  };

  console.log(`\n[GateTest] Crawling ${url} (max ${maxPages} pages)...\n`);
  const summary = await gatetest.runModule('liveCrawler');

  // Show the feedback report
  const feedbackPath = path.join(gatetest.projectRoot, '.gatetest/reports/crawl-feedback.md');
  if (fs.existsSync(feedbackPath)) {
    console.log('\n' + fs.readFileSync(feedbackPath, 'utf-8'));
  }

  process.exit(summary.gateStatus === 'PASSED' ? 0 : 1);
}

async function runCrawlLoop(gatetest, url, maxPages) {
  gatetest.config.config.modules.liveCrawler = {
    url,
    maxPages,
    timeout: 10000,
    checkExternal: true,
  };

  let round = 1;
  const maxRounds = 20;

  while (round <= maxRounds) {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`[GateTest] CRAWL LOOP — Round ${round}/${maxRounds}`);
    console.log(`[GateTest] Testing: ${url}`);
    console.log(`${'='.repeat(50)}\n`);

    const summary = await gatetest.runModule('liveCrawler');

    const feedbackPath = path.join(gatetest.projectRoot, '.gatetest/reports/crawl-feedback.md');
    if (fs.existsSync(feedbackPath)) {
      const feedback = fs.readFileSync(feedbackPath, 'utf-8');
      console.log('\n' + feedback);

      if (feedback.includes('ALL CLEAR')) {
        console.log('\n[GateTest] SITE IS CLEAN. All pages verified. Loop complete.\n');
        process.exit(0);
      }
    }

    console.log(`\n[GateTest] Issues found. Waiting for fixes...`);
    console.log(`[GateTest] Fix the issues above, then press ENTER to re-test.`);
    console.log(`[GateTest] Or press Ctrl+C to exit.\n`);

    // Wait for user input (or for Claude to signal it's done fixing)
    await new Promise((resolve) => {
      process.stdin.once('data', resolve);
    });

    round++;
  }

  console.log(`\n[GateTest] Maximum rounds (${maxRounds}) reached. Exiting.\n`);
  process.exit(1);
}

function showCrawlFeedback(projectRoot) {
  const feedbackPath = path.join(projectRoot, '.gatetest/reports/crawl-feedback.md');
  if (!fs.existsSync(feedbackPath)) {
    console.log('\nNo crawl feedback found. Run "gatetest --crawl <url>" first.\n');
    process.exit(1);
  }
  console.log('\n' + fs.readFileSync(feedbackPath, 'utf-8'));
}

/**
 * Watch mode — monitors file changes and re-runs GateTest continuously.
 * Uses fs.watch for near-instant feedback during development.
 */
async function runWatchMode(gatetest, args) {
  const watchDirs = ['src', 'lib', 'app', 'pages', 'components', 'website', 'tests', 'test'];
  const projectRoot = gatetest.projectRoot;
  const debounceMs = 500;
  let timer = null;
  let running = false;
  let round = 0;

  const runScan = async () => {
    if (running) return;
    running = true;
    round++;

    console.log(`\n${'='.repeat(50)}`);
    console.log(`[GateTest] WATCH MODE — Scan #${round}`);
    console.log(`[GateTest] ${new Date().toLocaleTimeString()}`);
    console.log(`${'='.repeat(50)}\n`);

    try {
      if (args.module) {
        await gatetest.runModule(args.module);
      } else {
        await gatetest.runSuite(args.suite || 'quick');
      }
    } catch (err) { // error-ok — watch mode must keep running after a scan error
      console.error(`[GateTest] Error: ${err.message}`);
    }

    running = false;
    console.log(`\n${'-'.repeat(50)}`);
    console.log(`[GateTest] Watching for changes... (Ctrl+C to exit)`);
  };

  // Initial scan
  await runScan();

  // Watch directories
  for (const dir of watchDirs) {
    const fullPath = path.join(projectRoot, dir);
    if (!fs.existsSync(fullPath)) continue;

    try {
      fs.watch(fullPath, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        // Ignore generated files
        if (filename.includes('.gatetest') || filename.includes('node_modules')) return;
        if (filename.endsWith('.map') || filename.endsWith('.d.ts')) return;

        if (timer) clearTimeout(timer);
        timer = setTimeout(runScan, debounceMs);
      });
    } catch {
      // fs.watch may not support recursive on all platforms
    }
  }

  // Keep process alive
  await new Promise(() => {});
}

main().catch(err => {
  console.error(`\n[GateTest] Fatal error: ${err.message}\n`);
  process.exit(1);
});
