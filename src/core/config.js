/**
 * GateTest Configuration - Central configuration management.
 * Loads from .gatetest/config.json, environment variables, and CLI args.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG = {
  // Quality thresholds (from CLAUDE.md)
  thresholds: {
    unitTestCoverage: 90,
    integrationTestCoverage: 85,
    e2eCriticalPathCoverage: 100,
    mutationTestScore: 80,
    lighthousePerformance: 95,
    lighthouseAccessibility: 100,
    lighthouseBestPractices: 100,
    lighthouseSeo: 100,
    wcagLevel: 'AAA',
    maxSecurityVulnerabilities: 0,
    maxBrokenLinks: 0,
    maxConsoleErrors: 0,
    maxTypeScriptErrors: 0,
    maxLintErrors: 0,
    maxBundleSizeJs: 200 * 1024,   // 200KB gzipped
    maxBundleSizeCss: 50 * 1024,   // 50KB gzipped
    maxApiResponseTime: 200,        // ms p95
    maxFcp: 1000,                   // ms
    maxLcp: 2000,                   // ms
    maxCls: 0.05,
    maxInp: 200,                    // ms
    maxTbt: 150,                    // ms
    maxTti: 2500,                   // ms
    maxFunctionLength: 100,          // lines
    maxFileLength: 300,             // lines
    maxCyclomaticComplexity: 10,
  },

  // Test suite configuration
  suites: {
    quick: [
      'memory',
      'syntax',
      'lint',
      'secrets',
      'codeQuality',
      'dependencies',
      'shell',
      'sqlMigrations',
      'terraform',
      'kubernetes',
      'promptSafety',
      'deadCode',
      'secretRotation',
      'webHeaders',
      'typescriptStrictness',
      'flakyTests',
      'errorSwallow',
      'nPlusOne',
      'retryHygiene',
      'raceCondition',
      'resourceLeak',
      'ssrf',
      'hardcodedUrl',
      'envVars',
      'asyncIteration',
      'homoglyph',
      'openapiDrift',
      'prSize',
      'redos',
      'cronExpression',
      'datetimeBug',
      'importCycle',
      'moneyFloat',
      'logPii',
      'featureFlag',
      'tlsSecurity',
      'cookieSecurity',
      'crossFileTaint',
      'fakeFixDetector',
    ],
    standard: [
      'memory',
      'syntax',
      'lint',
      'secrets',
      'codeQuality',
      'unitTests',
      'integrationTests',
      'dependencies',
      'dockerfile',
      'ciSecurity',
      'shell',
      'sqlMigrations',
      'terraform',
      'kubernetes',
      'promptSafety',
      'deadCode',
      'secretRotation',
      'webHeaders',
      'typescriptStrictness',
      'flakyTests',
      'errorSwallow',
      'nPlusOne',
      'retryHygiene',
      'raceCondition',
      'resourceLeak',
      'ssrf',
      'hardcodedUrl',
      'envVars',
      'asyncIteration',
      'homoglyph',
      'openapiDrift',
      'prSize',
      'redos',
      'cronExpression',
      'datetimeBug',
      'importCycle',
      'moneyFloat',
      'logPii',
      'featureFlag',
      'tlsSecurity',
      'cookieSecurity',
      'crossFileTaint',
      'fakeFixDetector',
    ],
    full: [
      'memory',
      'syntax',
      'lint',
      'secrets',
      'codeQuality',
      'unitTests',
      'integrationTests',
      'e2e',
      'visual',
      'accessibility',
      'performance',
      'security',
      'seo',
      'links',
      'compatibility',
      'dataIntegrity',
      'documentation',
      'dependencies',
      'dockerfile',
      'ciSecurity',
      'shell',
      'sqlMigrations',
      'terraform',
      'kubernetes',
      'promptSafety',
      'deadCode',
      'secretRotation',
      'webHeaders',
      'typescriptStrictness',
      'flakyTests',
      'errorSwallow',
      'nPlusOne',
      'retryHygiene',
      'raceCondition',
      'resourceLeak',
      'ssrf',
      'hardcodedUrl',
      'envVars',
      'asyncIteration',
      'homoglyph',
      'openapiDrift',
      'prSize',
      'redos',
      'cronExpression',
      'datetimeBug',
      'importCycle',
      'moneyFloat',
      'logPii',
      'featureFlag',
      'tlsSecurity',
      'cookieSecurity',
      'crossFileTaint',
      'mutation',
      'python',
      'go',
      'rust',
      'java',
      'ruby',
      'php',
      'csharp',
      'kotlin',
      'swift',
      'aiReview',
      'agentic',
      'fakeFixDetector',
    ],
    live: [
      'liveCrawler',
      'explorer',
      'chaos',
    ],
    nuclear: [
      'memory',
      'syntax',
      'lint',
      'secrets',
      'codeQuality',
      'unitTests',
      'integrationTests',
      'e2e',
      'visual',
      'accessibility',
      'performance',
      'security',
      'seo',
      'links',
      'compatibility',
      'dataIntegrity',
      'documentation',
      'dependencies',
      'dockerfile',
      'ciSecurity',
      'shell',
      'sqlMigrations',
      'terraform',
      'kubernetes',
      'promptSafety',
      'deadCode',
      'secretRotation',
      'webHeaders',
      'typescriptStrictness',
      'flakyTests',
      'errorSwallow',
      'nPlusOne',
      'retryHygiene',
      'raceCondition',
      'resourceLeak',
      'ssrf',
      'hardcodedUrl',
      'envVars',
      'asyncIteration',
      'homoglyph',
      'openapiDrift',
      'prSize',
      'redos',
      'cronExpression',
      'datetimeBug',
      'importCycle',
      'moneyFloat',
      'logPii',
      'featureFlag',
      'tlsSecurity',
      'cookieSecurity',
      'crossFileTaint',
      'liveCrawler',
      'explorer',
      'chaos',
      'mutation',
      'python',
      'go',
      'rust',
      'java',
      'ruby',
      'php',
      'csharp',
      'kotlin',
      'swift',
      'aiReview',
      'agentic',
      'fakeFixDetector',
    ],
  },

  // Module-specific settings
  modules: {
    visual: {
      screenshotDir: '.gatetest/screenshots',
      baselineDir: '.gatetest/baselines',
      diffThreshold: 0.01,    // 1% pixel difference tolerance
      viewports: [
        { width: 320, height: 568, name: 'mobile-small' },
        { width: 375, height: 812, name: 'mobile-standard' },
        { width: 414, height: 896, name: 'mobile-large' },
        { width: 768, height: 1024, name: 'tablet-portrait' },
        { width: 1024, height: 768, name: 'tablet-landscape' },
        { width: 1280, height: 800, name: 'desktop-standard' },
        { width: 1920, height: 1080, name: 'desktop-large' },
        { width: 2560, height: 1440, name: 'desktop-ultrawide' },
      ],
    },
    accessibility: {
      standard: 'WCAG2AAA',
      includeWarnings: true,
      includeNotices: false,
    },
    security: {
      scanHeaders: true,
      scanDependencies: true,
      scanSecrets: true,
      scanSourceCode: true,
      owaspZapTarget: null,     // Set to URL for active scanning
      secretPatterns: [
        /(?:api[_-]?key|apikey)\s*[:=]\s*['"][^'"]{8,}/gi,
        /(?:secret|password|passwd|pwd)\s*[:=]\s*['"][^'"]{8,}/gi,
        /(?:token|bearer)\s*[:=]\s*['"][^'"]{8,}/gi,
        /(?:aws|amazon).{0,20}(?:key|secret|token).{0,20}['"][A-Za-z0-9/+=]{20,}/gi,
        /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/g,
        /ghp_[A-Za-z0-9_]{36,}/g,        // GitHub personal access tokens
        /gho_[A-Za-z0-9_]{36,}/g,        // GitHub OAuth tokens
        /github_pat_[A-Za-z0-9_]{22,}/g, // GitHub fine-grained tokens
        /sk-[A-Za-z0-9]{32,}/g,          // OpenAI/Stripe keys
        /sk_live_[A-Za-z0-9]{24,}/g,     // Stripe live keys
      ],
    },
    performance: {
      budget: {
        js: 200 * 1024,
        css: 50 * 1024,
        images: 500 * 1024,
        fonts: 100 * 1024,
        total: 1000 * 1024,
      },
      lighthouseConfig: {
        extends: 'lighthouse:default',
        settings: {
          onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
          formFactor: 'desktop',
          throttling: {
            cpuSlowdownMultiplier: 1,
          },
        },
      },
    },
    seo: {
      validateStructuredData: true,
      validateOpenGraph: true,
      validateTwitterCards: true,
      validateCanonical: true,
      validateSitemap: true,
      validateRobotsTxt: true,
      maxTitleLength: 60,
      maxDescriptionLength: 160,
    },
    links: {
      checkExternal: true,
      checkInternal: true,
      timeout: 10000,
      retries: 2,
      concurrency: 10,
      excludePatterns: [],
    },
    compatibility: {
      browsers: [
        'chrome >= 120',
        'firefox >= 120',
        'safari >= 17',
        'edge >= 120',
        'ios_saf >= 17',
        'and_chr >= 120',
      ],
    },
    fakeFixDetector: {
      patternEngine: true,
      aiEngine: true,
      // `against`: optional git ref — diff HEAD against this (e.g. 'main')
      against: null,
      // `context`: optional string describing the bug being fixed, passed to AI
      context: null,
    },
    prSize: {
      // `against`: optional git ref — if unset, module auto-detects via
      // staged / working-tree / HEAD~1
      against: null,
      maxFilesChangedWarning: 50,
      maxFilesChangedError: 100,
      maxLinesChangedWarning: 500,
      maxLinesChangedError: 1000,
      maxLinesPerFileWarning: 300,
      maxLinesPerFileError: 500,
      maxTopLevelDirs: 3,
      excludePatterns: [],
    },
    codeQuality: {
      forbiddenPatterns: [
        { pattern: /console\.(log|debug|info)\(/g, message: 'console.log/debug/info found' },
        { pattern: /\bdebugger\b/g, message: 'debugger statement found' },
        { pattern: /\/\/\s*(TODO|FIXME|HACK|XXX)/gi, message: 'Unresolved TODO/FIXME/HACK/XXX comment' },
        { pattern: /(?<![\w.$])eval\s*\(/g, message: 'eval() usage detected' },
        { pattern: /new\s+Function\s*\(/g, message: 'Function constructor usage detected' },
        { pattern: /\.innerHTML\s*=/g, message: 'innerHTML assignment detected — use textContent or sanitize' },
      ],
    },
  },

  // Reporting
  reporting: {
    outputDir: '.gatetest/reports',
    formats: ['json', 'html', 'console'],
    retainReports: 30,   // days
    timestamped: true,
  },

  // Scanning (continuous monitoring)
  scanning: {
    enabled: false,
    intervals: {
      dependencyAudit: '0 0 * * *',     // daily at midnight
      brokenLinks: '0 2 * * *',          // daily at 2am
      lighthouseAudit: '0 4 * * *',      // daily at 4am
      securityScan: '0 0 * * 0',         // weekly on Sunday
      loadTest: '0 6 * * 0',             // weekly on Sunday at 6am
      complianceScan: '0 0 1 * *',       // monthly on 1st
    },
    uptimeCheckInterval: 60,   // seconds
    errorRateWindow: 300,      // seconds (5 minutes)
    errorRateThreshold: 0.001, // 0.1%
  },

  // Gate enforcement
  gate: {
    blockOnFailure: true,
    autoFix: true,
    autoRollback: true,
    rollbackWindow: 900,  // seconds (15 minutes)
  },
};

class GateTestConfig {
  constructor(projectRoot) {
    this.projectRoot = projectRoot || process.cwd();
    this.configPath = path.join(this.projectRoot, '.gatetest', 'config.json');
    this.config = this._loadConfig();
  }

  _loadConfig() {
    let fileConfig = {};

    // Priority 1: .gatetest.json at project root (user-facing config)
    const rootConfigPath = path.join(this.projectRoot, '.gatetest.json');
    if (fs.existsSync(rootConfigPath)) {
      try {
        const raw = fs.readFileSync(rootConfigPath, 'utf-8');
        fileConfig = JSON.parse(raw);
      } catch (err) { // error-ok — malformed config warns and falls back to defaults
        console.error(`[GateTest] Warning: Failed to parse ${rootConfigPath}: ${err.message}`);
      }
    }
    // Priority 2: .gatetest/config.json (legacy path)
    else if (fs.existsSync(this.configPath)) {
      try {
        const raw = fs.readFileSync(this.configPath, 'utf-8');
        fileConfig = JSON.parse(raw);
      } catch (err) { // error-ok — malformed config warns and falls back to defaults
        console.error(`[GateTest] Warning: Failed to parse ${this.configPath}: ${err.message}`);
      }
    }

    return this._deepMerge(DEFAULT_CONFIG, fileConfig);
  }

  _deepMerge(target, source) {
    const result = { ...target };
    for (const key of Object.keys(source)) {
      if (
        source[key] &&
        typeof source[key] === 'object' &&
        !Array.isArray(source[key]) &&
        !(source[key] instanceof RegExp)
      ) {
        result[key] = this._deepMerge(target[key] || {}, source[key]);
      } else {
        result[key] = source[key];
      }
    }
    return result;
  }

  get(keyPath) {
    return keyPath.split('.').reduce((obj, key) => obj?.[key], this.config);
  }

  getThreshold(name) {
    return this.config.thresholds[name];
  }

  getModuleConfig(moduleName) {
    return this.config.modules[moduleName] || {};
  }

  getSuite(suiteName) {
    return this.config.suites[suiteName] || this.config.suites.standard;
  }

  save() {
    const dir = path.dirname(this.configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
  }
}

module.exports = { GateTestConfig, DEFAULT_CONFIG };
