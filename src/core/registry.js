/**
 * GateTest Module Registry - Discovers and loads all test modules.
 */

const path = require('path');
const fs = require('fs');

const BUILT_IN_MODULES = {
  syntax: '../modules/syntax.js',
  lint: '../modules/lint.js',
  secrets: '../modules/secrets.js',
  codeQuality: '../modules/code-quality.js',
  unitTests: '../modules/unit-tests.js',
  integrationTests: '../modules/integration-tests.js',
  e2e: '../modules/e2e.js',
  visual: '../modules/visual.js',
  accessibility: '../modules/accessibility.js',
  performance: '../modules/performance.js',
  security: '../modules/security.js',
  seo: '../modules/seo.js',
  links: '../modules/links.js',
  compatibility: '../modules/compatibility.js',
  dataIntegrity: '../modules/data-integrity.js',
  documentation: '../modules/documentation.js',
  liveCrawler: '../modules/live-crawler.js',
  explorer: '../modules/explorer.js',
  chaos: '../modules/chaos.js',
  runtimeErrors: '../modules/runtime-errors.js',
  mutation: '../modules/mutation.js',
  aiReview: '../modules/ai-review.js',
  fakeFixDetector: '../modules/fake-fix-detector.js',
  memory: '../modules/memory.js',
  agentic: '../modules/agentic.js',
  python: '../modules/python.js',
  go: '../modules/go-lang.js',
  rust: '../modules/rust-lang.js',
  java: '../modules/java.js',
  ruby: '../modules/ruby.js',
  php: '../modules/php.js',
  csharp: '../modules/csharp.js',
  kotlin: '../modules/kotlin.js',
  swift: '../modules/swift.js',
  dependencies: '../modules/dependencies.js',
  dockerfile: '../modules/dockerfile.js',
  ciSecurity: '../modules/ci-security.js',
  shell: '../modules/shell.js',
  sqlMigrations: '../modules/sql-migrations.js',
  terraform: '../modules/terraform.js',
  kubernetes: '../modules/kubernetes.js',
  promptSafety: '../modules/prompt-safety.js',
  deadCode: '../modules/dead-code.js',
  secretRotation: '../modules/secret-rotation.js',
  webHeaders: '../modules/web-headers.js',
  typescriptStrictness: '../modules/typescript-strictness.js',
  flakyTests: '../modules/flaky-tests.js',
  errorSwallow: '../modules/error-swallow.js',
  nPlusOne: '../modules/n-plus-one.js',
  retryHygiene: '../modules/retry-hygiene.js',
  raceCondition: '../modules/race-condition.js',
  resourceLeak: '../modules/resource-leak.js',
  ssrf: '../modules/ssrf.js',
  hardcodedUrl: '../modules/hardcoded-url.js',
  envVars: '../modules/env-vars.js',
  asyncIteration: '../modules/async-iteration.js',
  homoglyph: '../modules/homoglyph.js',
  openapiDrift: '../modules/openapi-drift.js',
  prSize: '../modules/pr-size.js',
  prQuality: '../modules/pr-quality.js',
  wpExposedFiles: '../modules/wp-exposed-files.js',
  wpVersionLeak: '../modules/wp-version-leak.js',
  wpXmlrpcExposed: '../modules/wp-xmlrpc-exposed.js',
  wpPluginCveCheck: '../modules/wp-plugin-cve-check.js',
  wpMalwarePatterns: '../modules/wp-malware-patterns.js',
  wpUserEnumerate: '../modules/wp-user-enumerate.js',
  wpAdminProtection: '../modules/wp-admin-protection.js',
  wpPhpVersionEol: '../modules/wp-php-version-eol.js',
  wpThemeAbandonment: '../modules/wp-theme-abandonment.js',
  wpBackupValidation: '../modules/wp-backup-validation.js',
  redos: '../modules/redos.js',
  cronExpression: '../modules/cron-expression.js',
  datetimeBug: '../modules/datetime-bug.js',
  importCycle: '../modules/import-cycle.js',
  moneyFloat: '../modules/money-float.js',
  logPii: '../modules/log-pii.js',
  featureFlag: '../modules/feature-flag.js',
  tlsSecurity: '../modules/tls-security.js',
  cookieSecurity: '../modules/cookie-security.js',
  crossFileTaint: '../modules/cross-file-taint.js',
  // P0 — deploy & CI integrity
  deployScriptValidator: '../modules/deploy-script-validator.js',
  serviceConsistency: '../modules/service-consistency.js',
  nativeBundlerGuard: '../modules/native-bundler-guard.js',
  ciParamValidator: '../modules/ci-param-validator.js',
  // P1 — security & correctness
  authBypass: '../modules/auth-bypass.js',
  // P2 — code quality (AI-specific)
  aiHallucination: '../modules/ai-hallucination.js',
  monorepoConstraints: '../modules/monorepo-constraints.js',
  zodSchemaPresence: '../modules/zod-schema.js',
  bundleSize: '../modules/bundle-size.js',
  duplicateCode: '../modules/duplicate-code.js',
  // P2/P3 — contract drift
  trpcContract: '../modules/trpc-contract.js',
  webhookPayload: '../modules/webhook-payload.js',
  // AI intelligence layer
  intentVerification: '../modules/intent-verification.js',
  regressionPredictor: '../modules/regression-predictor.js',
  architectureDrift: '../modules/architecture-drift.js',
  deployReadiness: '../modules/deploy-readiness.js',
  // Runtime contract & cache layer
  deployContract: '../modules/deploy-contract.js',
  cacheHeaders: '../modules/cache-headers.js',
  // Infrastructure truth oracles
  bashSafety: '../modules/bash-safety.js',
  envIntegrity: '../modules/env-integrity.js',
  systemd: '../modules/systemd.js',
  rollbackHonesty: '../modules/rollback-honesty.js',
};

class ModuleRegistry {
  constructor() {
    this.modules = new Map();
  }

  loadBuiltIn() {
    for (const [name, relativePath] of Object.entries(BUILT_IN_MODULES)) {
      try {
        const modulePath = path.resolve(__dirname, relativePath);
        if (fs.existsSync(modulePath)) {
          // turbopackIgnore: this dynamic require resolves to one of the ~100 module
          // files listed in BUILT_IN_MODULES above. At Node runtime this works fine.
          // At Turbopack/Next.js build time, however, the bundler tries to enumerate
          // every possible target of the dynamic require — which drags the entire
          // /src/modules tree (and its transitive imports) into the website's
          // server bundle, fails the trace, and crashes the build. The comment
          // tells Turbopack to skip analysis; the runtime behaviour is unchanged.
          const ModuleClass = require(/* turbopackIgnore: true */ modulePath);
          this.modules.set(name, new ModuleClass());
        }
      } catch (err) { // error-ok — failed module load is non-fatal; suite runs without it
        console.warn(`[GateTest] Warning: Could not load module "${name}": ${err.message}`);
      }
    }
    return this;
  }

  loadCustom(modulesDir) {
    if (!fs.existsSync(modulesDir)) return this;

    const files = fs.readdirSync(modulesDir).filter(f => f.endsWith('.js'));
    for (const file of files) {
      try {
        // turbopackIgnore — same reasoning as loadBuiltIn above; this require
        // resolves dynamically at runtime.
        const ModuleClass = require(/* turbopackIgnore: true */ path.join(modulesDir, file));
        const name = path.basename(file, '.js');
        this.modules.set(name, new ModuleClass());
      } catch (err) { // error-ok — failed custom module load is non-fatal; suite runs without it
        console.warn(`[GateTest] Warning: Could not load custom module "${file}": ${err.message}`);
      }
    }
    return this;
  }

  get(name) {
    return this.modules.get(name);
  }

  getAll() {
    return this.modules;
  }

  list() {
    return Array.from(this.modules.keys());
  }
}

module.exports = { ModuleRegistry, BUILT_IN_MODULES };
