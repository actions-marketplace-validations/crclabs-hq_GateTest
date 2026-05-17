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

const path = require('path');
const fs = require('fs');
const { GateTest } = require('../src/index');

const HELP = `
  GateTest - Advanced QA Gate System
  Nothing ships unless it's pristine.

  USAGE
    gatetest [options]
    gatetest sweep [sweep-options]   Run the Bible's pre-merge sweep (tests +
                                     build + module load + gate + secrets +
                                     TODOs + self-scan) and exit 0 if green,
                                     1 if any blocking step failed. See
                                     "gatetest sweep --help" for details.
    gatetest scan  [options]         Explicit alias for the default scan flow
                                     (same as running gatetest with no
                                     subcommand). Useful for unambiguous
                                     scripts.
    gatetest replay <run-url>        Reproduce a failing CI run locally
                                     (run 'gatetest replay --help' for detail)

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
    --auto-pr          After a failed gate, AI-fix every finding with a file path
                       and open a pull request with the fixes. Requires gh CLI
                       authenticated (or GH_TOKEN env var) AND ANTHROPIC_API_KEY.
                       Use this in CI to turn "gate blocked" into "gate blocked
                       BUT here is a PR to merge."
    --auto-pr-base <ref>    Base branch for the auto-PR (default: current branch)
    --auto-pr-branch <name> Override the auto-generated branch name
    --diff             Only scan git-changed files (fast pre-commit mode)
    --watch            Watch for file changes and re-scan continuously
    --sarif            Output results in SARIF format (for GitHub Security)
    --junit            Output results in JUnit XML format (for CI)
    --ci-init <type>   Generate CI config: github, gitlab, circleci
    --project <path>   Set project root (default: cwd)
    --help, -h         Show this help message
    --doctor           Audit your environment — checks every prerequisite for
                       auto-fix to work (Node version, gh CLI, ANTHROPIC_API_KEY,
                       workflow file version, etc.) and reports what's missing
                       with copy-paste fix commands. Run this any time you
                       suspect something isn't working.
    --doctor-quick     Same but skips the live Anthropic API ping (offline mode)
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

  EXAMPLES
    gatetest                          Run standard checks
    gatetest sweep                    Run the Bible's full pre-merge sweep
    gatetest sweep --fast             Sweep gate-only (skip tests + build)
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
  // Subcommand routing (backwards-compatible).
  //   gatetest sweep [...]   → run the Bible's pre-merge sweep locally
  //   gatetest replay <url>  → reproduce a failing GitHub Actions run locally
  //   gatetest scan  [...]   → alias for the default scan flow (current
  //                            behavior; the word "scan" is consumed and the
  //                            rest of the flags are parsed as usual)
  //   gatetest <other>       → if the first arg is not a recognised
  //                            subcommand, fall through to flag parsing so
  //                            every existing invocation keeps working.
  const rawArgs = process.argv.slice(2);
  const first = rawArgs[0];
  const KNOWN_SUBCOMMANDS = new Set(['sweep', 'replay', 'scan']);
  if (first === 'sweep') {
    const { runSweep } = require('./gatetest-sweep');
    const code = await runSweep(rawArgs.slice(1));
    process.exit(code);
  }
  if (first === 'replay') {
    const replay = require('./gatetest-replay');
    const code = await replay.main(rawArgs.slice(1));
    process.exit(code || 0);
  }
  // 'scan' is an explicit alias for the default behavior. Consume it.
  const effectiveArgv = first === 'scan' ? rawArgs.slice(1) : rawArgs;
  const args = parseArgs(effectiveArgv);
  // Ignore stale "scan" token if it somehow re-appears later.
  if (args._subcommand === 'scan') delete args._subcommand;
  // (KNOWN_SUBCOMMANDS export only used to keep the route table in one place.)
  void KNOWN_SUBCOMMANDS;

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

  // Doctor — full environment audit, plain-English, for non-experts.
  // Designed so Craig (or any customer) can answer "why isn't auto-fix
  // working?" in 30 seconds without needing a developer to interpret.
  if (args.doctor) {
    const { runDoctor, renderDoctor } = require('../src/core/doctor');
    const result = await runDoctor({
      projectRoot,
      probeAnthropic: !args.doctorQuick,
    });
    console.log(renderDoctor(result));
    process.exit(result.summary.bad > 0 ? 1 : 0);
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

  // --auto-pr: when the gate fails AND the customer wants automated fixes,
  // invoke the AI fix engine for every finding with a file path and open a
  // pull request. Closes the long-standing "gate finds errors but doesn't
  // fix them" UX gap.
  if (args.autoPr && summary.gateStatus !== 'PASSED') {
    const autoPrResult = await runAutoPr(summary, projectRoot, args);
    // The summary's gate verdict still drives the exit code so the original
    // PR remains blocked until reviewed — but the fix-PR is now waiting.
    if (autoPrResult.prUrl) {
      console.log(`\n  \x1b[36m[GateTest auto-PR] Fix PR opened: ${autoPrResult.prUrl}\x1b[0m\n`);
    } else if (autoPrResult.error) {
      console.log(`\n  \x1b[33m[GateTest auto-PR] Could not open fix PR: ${autoPrResult.error}\x1b[0m\n`);
    }
  }

  process.exit(summary.gateStatus === 'PASSED' ? 0 : 1);
}

/**
 * Auto-PR runner — applies AI-driven fixes to every finding that has a file
 * path, then opens a pull request via the `gh` CLI.
 *
 * Returns { prUrl, fixesApplied, error }. Never throws — the gate's exit
 * code is the authoritative signal; the auto-PR is a value-add on top.
 *
 * Pre-conditions checked at runtime:
 *   - We're inside a git repository
 *   - `gh` CLI is on PATH and authenticated (or GH_TOKEN is set)
 *   - ANTHROPIC_API_KEY is set (the AI fix engine no-ops without it)
 */
async function runAutoPr(summary, projectRoot, args) {
  const { execSync } = require('child_process');
  const { aiFix } = require('../src/core/ai-fix-engine');

  function sh(cmd, opts) {
    return execSync(cmd, { cwd: projectRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts });
  }

  // Pre-flight checks
  try { sh('git rev-parse --git-dir'); }
  catch { return { error: 'Not a git repository — auto-PR skipped' }; }

  try { sh('gh --version'); }
  catch { return { error: 'gh CLI not found on PATH. Install: https://cli.github.com/' }; }

  if (!process.env.ANTHROPIC_API_KEY) {
    return { error: 'ANTHROPIC_API_KEY not set — AI fix engine cannot run' };
  }

  // Capture original branch so we can return to it if needed
  let originalBranch = 'main';
  try { originalBranch = sh('git rev-parse --abbrev-ref HEAD').trim(); }
  catch { /* default to main */ }

  const baseBranch = args.autoPrBase || originalBranch;
  const ts = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
  const fixBranch = args.autoPrBranch || `gatetest/auto-fix-${ts}`;

  // Collect every fixable finding from the summary. Use the shared
  // extractFileFromCheck() so we don't silently drop findings that
  // emit their file path in the MESSAGE text rather than a structured
  // field. The old code dropped ~97% of findings (~745/764) because
  // only 19 module addCheck calls set check.file explicitly.
  const { extractFileFromCheck } = require('../src/core/parse-finding');
  const fixable = [];
  const needsManualReview = [];
  for (const moduleResult of summary.results || []) {
    for (const check of moduleResult.checks || []) {
      if (check.passed) continue;
      if (check.severity !== 'error' && check.severity !== 'warning') continue;
      const checkWithModule = { ...check, module: moduleResult.module || moduleResult.name };
      const { file, line } = extractFileFromCheck(checkWithModule);
      const entry = {
        moduleName: moduleResult.module || moduleResult.name || 'unknown',
        checkName: check.name || 'unnamed-check',
        file,
        line,
        message: check.message || check.details?.message || check.name || '',
        severity: check.severity,
      };
      if (file) {
        fixable.push(entry);
      } else {
        // Config-level findings (CI security, dependency hygiene, etc.)
        // often have no file. We can't auto-fix them, but we MUST
        // surface them — silently dropping is what made auto-repair
        // look broken in the first place.
        needsManualReview.push(entry);
      }
    }
  }

  if (fixable.length === 0 && needsManualReview.length === 0) {
    return { error: 'No actionable findings — nothing to fix automatically' };
  }
  if (fixable.length === 0) {
    return { error: `No findings with file paths — ${needsManualReview.length} config-level finding(s) need manual review (see workflow log).`, needsManualReview };
  }

  console.log(`\n  [GateTest auto-PR] ${fixable.length} fixable finding(s). Generating AI fixes...\n`);

  // Create fix branch off the current branch
  try {
    sh(`git checkout -b ${fixBranch}`);
  } catch (err) {
    return { error: `Could not create branch ${fixBranch}: ${err.message?.slice(0, 200) || err}` };
  }

  let fixesApplied = 0;
  const fixesAttempted = [];
  // Cap at 50 fixes per run to bound Anthropic spend
  const FIX_CAP = 50;
  for (const finding of fixable.slice(0, FIX_CAP)) {
    try {
      const result = await aiFix({
        filePath: require('path').isAbsolute(finding.file) ? finding.file : require('path').join(projectRoot, finding.file),
        issueTitle: finding.checkName,
        issueMessage: finding.message,
        lineNumber: finding.line,
        projectRoot,
      });
      fixesAttempted.push({ ...finding, fixed: result.fixed === true, description: result.description });
      if (result.fixed === true) {
        fixesApplied += 1;
        console.log(`  [\x1b[32m✓\x1b[0m] ${finding.file}: ${finding.checkName}`);
      } else {
        console.log(`  [\x1b[33m~\x1b[0m] ${finding.file}: ${finding.checkName} (skipped: ${result.description?.slice(0, 60) || 'no-fix'})`);
      }
    } catch (err) { // error-ok — per-finding failure is logged + tracked in fixesAttempted; one bad finding shouldn't halt the batch
      const reason = err && err.message ? err.message.slice(0, 80) : String(err);
      console.log(`  [\x1b[31m✗\x1b[0m] ${finding.file}: ${reason}`);
      fixesAttempted.push({ ...finding, fixed: false, description: `error: ${reason}` });
    }
  }

  if (fixesApplied === 0) {
    // Restore original branch — nothing to commit
    try { sh(`git checkout ${originalBranch}`); sh(`git branch -D ${fixBranch}`); } catch { /* ignore */ }
    return { error: 'AI fix engine could not generate any fixes' };
  }

  // Commit + push + open PR
  try {
    sh('git add -A');
    const subject = `fix: GateTest auto-fixes for ${fixesApplied}/${fixable.length} findings`;
    const body = fixesAttempted
      .map((f) => `  * ${f.fixed ? '[fixed]' : '[skipped]'} ${f.moduleName}: ${f.file}${f.line ? `:${f.line}` : ''} — ${f.checkName}`)
      .join('\n');
    sh(`git commit -m ${JSON.stringify(subject + '\n\n' + body)}`);
    sh(`git push -u origin ${fixBranch}`);

    const totalActionable = fixable.length + needsManualReview.length;
    const prTitle = `GateTest auto-fix — ${fixesApplied} of ${totalActionable} findings`;
    const manualReviewSection = needsManualReview.length > 0 ? [
      ``,
      `## Findings that need manual review (no fixable file path)`,
      ``,
      `These findings are config-level (CI workflows, dependency lockfiles, environment settings) or summary checks — the auto-fix engine can't safely apply a code change. Review them manually:`,
      ``,
      ...needsManualReview.slice(0, 50).map((f) => `- ⚠️ \`${f.moduleName}:${f.checkName}\` — ${f.message?.slice(0, 200) || '(no message)'}`),
      ...(needsManualReview.length > 50 ? [`- _… plus ${needsManualReview.length - 50} more — see the workflow log for the full list_`] : []),
    ].join('\n') : '';
    const prBody = [
      `# GateTest auto-fix`,
      ``,
      `The CI gate found ${totalActionable} actionable finding(s) on this branch — ${fixable.length} with a file path and ${needsManualReview.length} config-level. This PR applies AI-generated fixes for ${fixesApplied} of the ${fixable.length} file-level findings.`,
      ``,
      `## File-level findings handled`,
      ``,
      ...(fixesAttempted.length > 0
        ? fixesAttempted.map((f) => `- ${f.fixed ? '✅' : '⚠️'} \`${f.file}${f.line ? `:${f.line}` : ''}\` — \`${f.moduleName}:${f.checkName}\` — ${f.message?.slice(0, 200) || '(no message)'}`)
        : ['_(no file-level findings — all the gate failures are config-level, see below)_']),
      manualReviewSection,
      ``,
      `## What to do`,
      ``,
      `1. Review each diff in this PR carefully — AI fixes can introduce subtle changes`,
      `2. Run tests locally if possible`,
      `3. Merge this PR before merging the original PR — the gate is still blocking that one until these fixes land`,
      `4. If there are manual-review findings above, fix them by hand in a follow-up commit`,
      ``,
      `🤖 Generated by GateTest \`--auto-pr\``,
    ].join('\n');

    const prResult = sh(`gh pr create --base ${JSON.stringify(baseBranch)} --head ${JSON.stringify(fixBranch)} --title ${JSON.stringify(prTitle)} --body ${JSON.stringify(prBody)}`);
    const prUrl = prResult.trim().split('\n').filter((l) => l.startsWith('https://')).pop();

    return { prUrl, fixesApplied, fixesAttempted: fixable.length };
  } catch (err) {
    return { error: `Commit/push/PR step failed: ${err.message?.slice(0, 200) || err}`, fixesApplied };
  }
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
    else if (arg === '--doctor') args.doctor = true;
    else if (arg === '--doctor-quick') { args.doctor = true; args.doctorQuick = true; }
    else if (arg === '--parallel') args.parallel = true;
    else if (arg === '--stop-first') args['stop-first'] = true;
    else if (arg === '--fix') args.fix = true;
    else if (arg === '--auto-pr') args.autoPr = true;
    else if (arg === '--auto-pr-base' && argv[i + 1]) args.autoPrBase = argv[++i];
    else if (arg === '--auto-pr-branch' && argv[i + 1]) args.autoPrBranch = argv[++i];
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
