/**
 * GateTest - Advanced QA Gate System
 *
 * Nothing ships unless it's pristine.
 * This is the main entry point for the GateTest library.
 */

const { GateTestConfig } = require('./core/config');
const { GateTestRunner, TestResult, Severity } = require('./core/runner');
const { ModuleRegistry } = require('./core/registry');
const { ClaudeMdParser } = require('./core/claude-md-parser');
const { ConsoleReporter } = require('./reporters/console-reporter');
const { JsonReporter } = require('./reporters/json-reporter');
const { HtmlReporter } = require('./reporters/html-reporter');
const { SarifReporter } = require('./reporters/sarif-reporter');
const { JunitReporter } = require('./reporters/junit-reporter');
const { GithubAnnotationsReporter } = require('./reporters/github-annotations-reporter');
const { CiSummaryReporter } = require('./reporters/ci-summary-reporter');
const { GateTestCache } = require('./core/cache');
const {
  HostBridge,
  NotImplemented,
  CANONICAL_COMMIT_STATES,
  registerBridge,
  createBridge,
  listBridges,
} = require('./core/host-bridge');
// Importing github-bridge registers the 'github' bridge in the HostBridge
// registry so callers of createBridge('github', ...) get a concrete
// implementation without needing to import it manually.
// TODO(gluecron): when GluecronBridge ships, require it here too.
const { GitHubBridge } = require('./core/github-bridge');

class GateTest {
  constructor(projectRoot, options = {}) {
    this.projectRoot = projectRoot || process.cwd();
    this.config = new GateTestConfig(this.projectRoot);
    this.registry = new ModuleRegistry();
    this.options = options;
  }

  /**
   * Initialize GateTest with all built-in modules.
   */
  init() {
    this.registry.loadBuiltIn();

    // Load custom modules from project
    const customDir = `${this.projectRoot}/.gatetest/modules`;
    this.registry.loadCustom(customDir);

    return this;
  }

  /**
   * Run a specific suite of tests.
   */
  async runSuite(suiteName = 'standard', opts = {}) {
    let modules = this.config.getSuite(suiteName);
    if (opts.skipModules && opts.skipModules.length > 0) {
      const skip = new Set(opts.skipModules);
      modules = modules.filter((m) => !skip.has(m));
    }
    return this._run(modules);
  }

  /**
   * Run a specific module by name.
   */
  async runModule(moduleName) {
    return this._run([moduleName]);
  }

  /**
   * Run all registered modules.
   */
  async runAll() {
    const modules = this.registry.list();
    return this._run(modules);
  }

  /**
   * Validate the CLAUDE.md file.
   */
  validateClaudeMd() {
    const parser = new ClaudeMdParser(this.projectRoot);
    return parser.validate();
  }

  /**
   * Parse the CLAUDE.md file and return structured data.
   */
  parseClaudeMd() {
    const parser = new ClaudeMdParser(this.projectRoot);
    return parser.parse();
  }

  async _run(moduleNames) {
    const runner = new GateTestRunner(this.config, this.options);

    // Register modules
    const allModules = this.registry.getAll();
    for (const [name, mod] of allModules) {
      runner.register(name, mod);
    }

    // Attach reporters — skip ConsoleReporter in silent mode (e.g. MCP server)
    if (!this.options.silent) new ConsoleReporter(runner);
    new JsonReporter(runner, this.config);
    new HtmlReporter(runner, this.config);
    if (this.options.sarif) new SarifReporter(runner, this.config);
    if (this.options.junit) new JunitReporter(runner, this.config);
    // Inline PR annotations — auto-on when running inside GitHub Actions
    // (the GITHUB_ACTIONS env var is set by every Actions runner). Customers
    // get red squiggles on the PR diff with zero configuration. Can be
    // forced on via options.githubAnnotations for non-Actions hosts that
    // also consume workflow commands.
    if (this.options.githubAnnotations || process.env.GITHUB_ACTIONS === 'true') {
      new GithubAnnotationsReporter(runner);
      // Same gating — CiSummaryReporter emits a collapsible timing table
      // and a top-line ::notice:: summary so the PR shows the verdict
      // without expanding the run log.
      new CiSummaryReporter(runner);
    }

    // onProgress hook — lets a caller (e.g. SSE-streaming route) observe
    // module-level events as they happen. Pass a function `(event, payload)`
    // and we forward suite:start, module:start, module:end, module:skip,
    // and suite:end from the runner's EventEmitter. Failures inside the
    // hook are swallowed so they can never crash the scan.
    if (typeof this.options.onProgress === 'function') {
      const hook = this.options.onProgress;
      const safe = (event, payload) => {
        try { hook(event, payload); } catch { /* never crash scan */ }
      };
      runner.on('suite:start', (p) => safe('suite:start', p));
      runner.on('suite:end', (p) => safe('suite:end', p));
      runner.on('module:start', (p) => safe('module:start', p));
      runner.on('module:end', (p) => safe('module:end', p));
      runner.on('module:skip', (p) => safe('module:skip', p));
    }

    // Run and return summary
    const summary = await runner.run(moduleNames);

    // Exit with non-zero if gate is blocked
    if (summary.gateStatus === 'BLOCKED' && this.config.get('gate.blockOnFailure')) {
      process.exitCode = 1;
    }

    return summary;
  }
}

module.exports = {
  GateTest,
  GateTestConfig,
  GateTestRunner,
  TestResult,
  Severity,
  ModuleRegistry,
  ClaudeMdParser,
  GateTestCache,
  ConsoleReporter,
  JsonReporter,
  HtmlReporter,
  SarifReporter,
  JunitReporter,
  GithubAnnotationsReporter,
  CiSummaryReporter,
  // Host abstraction — Gluecron-first (CLAUDE.md → STRATEGIC DIRECTION).
  HostBridge,
  GitHubBridge,
  NotImplemented,
  CANONICAL_COMMIT_STATES,
  registerBridge,
  createBridge,
  listBridges,
};
