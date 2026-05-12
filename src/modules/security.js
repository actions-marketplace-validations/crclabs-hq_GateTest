/**
 * Security Module - Comprehensive security scanning.
 * Checks headers, dependencies, OWASP patterns, CSP, CORS, and more.
 */

const BaseModule = require('./base-module');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

class SecurityModule extends BaseModule {
  constructor() {
    super('security', 'Security Analysis');
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;

    // Dependency vulnerability scan
    this._checkDependencies(projectRoot, result);

    // Source code security patterns (OWASP Top 10)
    this._checkSourcePatterns(projectRoot, result);

    // Check for dangerous file permissions
    this._checkFilePermissions(projectRoot, result);

    // Check package.json for suspicious scripts
    this._checkPackageScripts(projectRoot, result);

    // Check for .npmrc with auth tokens
    this._checkNpmAuth(projectRoot, result);

    // Scan for hardcoded secrets, API keys, tokens, and passwords
    this._scanForSecrets(projectRoot, result);

    // Docker security
    this._checkDockerSecurity(projectRoot, result);

    // .gitignore validation — sensitive files must be ignored
    this._checkGitignore(projectRoot, result);

    // Dependency license compliance
    this._checkLicenseCompliance(projectRoot, result);

    // Environment file security
    this._checkEnvFiles(projectRoot, result);

    // Live security headers validation
    await this._checkSecurityHeaders(config, result);
  }

  _checkDependencies(projectRoot, result) {
    const pkgLockPath = path.join(projectRoot, 'package-lock.json');
    const pkgPath = path.join(projectRoot, 'package.json');

    if (!fs.existsSync(pkgPath)) {
      result.addCheck('security:dependencies', true, { message: 'No package.json — skipping dep scan' });
      return;
    }

    const { exitCode, stdout } = this._exec('npm audit --json 2>/dev/null', { cwd: projectRoot });

    if (exitCode === 0) {
      result.addCheck('security:npm-audit', true, { message: 'No known vulnerabilities' });
    } else {
      try {
        const audit = JSON.parse(stdout);
        const vulns = audit.metadata?.vulnerabilities || {};
        const critical = vulns.critical || 0;
        const high = vulns.high || 0;
        const moderate = vulns.moderate || 0;

        if (critical > 0 || high > 0) {
          result.addCheck('security:npm-audit', false, {
            message: `${critical} critical, ${high} high, ${moderate} moderate vulnerabilities`,
            suggestion: 'Run "npm audit fix" or update vulnerable packages',
          });
        } else {
          result.addCheck('security:npm-audit', true, {
            message: `No critical/high vulnerabilities (${moderate} moderate)`,
          });
        }
      } catch {
        result.addCheck('security:npm-audit', false, {
          message: 'npm audit failed to run',
          suggestion: 'Run "npm audit" manually to check for vulnerabilities',
        });
      }
    }
  }

  _checkSourcePatterns(projectRoot, result) {
    const files = this._collectFiles(projectRoot, ['.js', '.ts', '.jsx', '.tsx']);
    const dangerousPatterns = [
      { regex: /eval\s*\(/g, name: 'eval()', severity: 'critical' },
      { regex: /new\s+Function\s*\(/g, name: 'Function constructor', severity: 'critical' },
      { regex: /\.innerHTML\s*=(?!=)/g, name: 'innerHTML assignment', severity: 'high' },
      { regex: /document\.write\s*\(/g, name: 'document.write()', severity: 'high' },
      { regex: /child_process.*exec\s*\(/g, name: 'shell exec without sanitization', severity: 'high' },
      { regex: /\$\{.*req\.(params|query|body)/g, name: 'unsanitized user input in template', severity: 'critical' },
      { regex: /res\.redirect\s*\(\s*req\./g, name: 'open redirect risk', severity: 'high' },
      { regex: /\.createReadStream\s*\(\s*req\./g, name: 'path traversal risk', severity: 'critical' },
      { regex: /Math\.random\s*\(/g, name: 'Math.random() for security (use crypto)', severity: 'moderate' },
      { regex: /disable.*csrf|csrf.*disable/gi, name: 'CSRF protection disabled', severity: 'critical' },
    ];

    for (const file of files) {
      const relPath = path.relative(projectRoot, file).split(path.sep).join('/');
      const content = fs.readFileSync(file, 'utf-8');
      const rawLines = content.split('\n');
      // Strip comments and string literals BEFORE pattern-matching so
      // JSDoc that documents the patterns + string literals naming them
      // don't false-positive. Newlines preserved so line numbers stay 1:1
      // with the original file.
      const stripped = this._stripCommentsAndStrings(content);
      const strippedLines = stripped.split('\n');

      // Test paths and detector source files (modules whose JOB is to
      // detect these patterns) downgrade to info — those calls are
      // either fixtures or legitimate jitter / sampling code.
      const isTestFile = /(?:^|\/)tests?\/|\.test\.|\.spec\./i.test(relPath);
      const isDetectorSource = /(?:^|\/)src\/(?:modules|core)\/|website\/app\/lib\/scan-modules\//i.test(relPath);

      for (const pattern of dangerousPatterns) {
        for (let i = 0; i < strippedLines.length; i++) {
          pattern.regex.lastIndex = 0;
          if (!pattern.regex.test(strippedLines[i])) continue;

          // Honour `// security-ok` suppression on the same or
          // preceding line — consistent with other modules' marker
          // convention (cookie-ok / tls-ok / log-safe / etc.).
          const sameLine = rawLines[i] || '';
          const prevLine = i > 0 ? rawLines[i - 1] : '';
          if (/(?:\/\/|#)\s*security-ok\b/.test(sameLine) ||
              /(?:\/\/|#)\s*security-ok\b/.test(prevLine)) {
            continue;
          }

          const sev = isTestFile || isDetectorSource ? 'info' : pattern.severity;
          result.addCheck(`security:${pattern.name}:${relPath}:${i + 1}`, sev === 'info', {
            file: relPath,
            line: i + 1,
            severity: sev === 'info' ? 'info' : (sev === 'moderate' ? 'warning' : 'error'),
            message: `${pattern.severity.toUpperCase()}: ${pattern.name} detected`,
            suggestion: `Review and replace ${pattern.name} with a safe alternative`,
          });
        }
      }
    }

    if (files.length > 0) {
      result.addCheck('security:source-scan', true, { message: `Scanned ${files.length} source files` });
    }
  }

  // Newline-preserving comment stripper that LEAVES strings intact.
  // Used by the secret-detection pass — real hardcoded secrets live in
  // strings, so we can't strip them — but JSDoc and inline `//` /
  // `/* */` comments documenting credential shapes are the FP source.
  _stripCommentsOnly(source) {
    const lines = source.split('\n');
    const out = [];
    let inBlockComment = false;
    let inString = null; // null | "'" | '"' | '`'
    for (const raw of lines) {
      let line = '';
      let i = 0;
      while (i < raw.length) {
        if (inBlockComment) {
          if (raw[i] === '*' && raw[i + 1] === '/') {
            inBlockComment = false;
            i += 2;
          } else {
            i += 1;
          }
          continue;
        }
        if (inString) {
          line += raw[i];
          if (raw[i] === '\\' && i + 1 < raw.length) {
            line += raw[i + 1];
            i += 2;
            continue;
          }
          if (raw[i] === inString) inString = null;
          i += 1;
          continue;
        }
        if (raw[i] === '/' && raw[i + 1] === '*') {
          inBlockComment = true;
          i += 2;
          continue;
        }
        if (raw[i] === '/' && raw[i + 1] === '/') break;
        if (raw[i] === '"' || raw[i] === "'" || raw[i] === '`') {
          inString = raw[i];
          line += raw[i];
          i += 1;
          continue;
        }
        line += raw[i];
        i += 1;
      }
      out.push(line);
    }
    return out.join('\n');
  }

  // Newline-preserving stripper: removes block / line / template / quoted
  // string contents while keeping the source's line count identical so
  // line-numbered diagnostics from later passes stay correct.
  _stripCommentsAndStrings(source) {
    const lines = source.split('\n');
    const out = [];
    let inBlockComment = false;
    let inTemplate = false;
    for (const raw of lines) {
      let line = '';
      let i = 0;
      while (i < raw.length) {
        if (inBlockComment) {
          if (raw[i] === '*' && raw[i + 1] === '/') {
            inBlockComment = false;
            i += 2;
          } else {
            i += 1;
          }
          continue;
        }
        if (inTemplate) {
          if (raw[i] === '\\') { i += 2; continue; }
          if (raw[i] === '`') { inTemplate = false; i += 1; continue; }
          i += 1;
          continue;
        }
        if (raw[i] === '/' && raw[i + 1] === '*') {
          inBlockComment = true;
          i += 2;
          continue;
        }
        if (raw[i] === '/' && raw[i + 1] === '/') break;
        if (raw[i] === '`') {
          inTemplate = true;
          i += 1;
          continue;
        }
        if (raw[i] === '"' || raw[i] === "'") {
          const quote = raw[i];
          i += 1;
          while (i < raw.length && raw[i] !== quote) {
            if (raw[i] === '\\') i += 1;
            i += 1;
          }
          i += 1;
          continue;
        }
        line += raw[i];
        i += 1;
      }
      out.push(line);
    }
    return out.join('\n');
  }

  _checkFilePermissions(projectRoot, result) {
    const sensitiveFiles = ['.env', 'key.pem', 'cert.pem', 'id_rsa', 'credentials.json'];
    for (const filename of sensitiveFiles) {
      const filePath = path.join(projectRoot, filename);
      if (fs.existsSync(filePath)) {
        try {
          const stats = fs.statSync(filePath);
          const mode = (stats.mode & 0o777).toString(8);
          if (mode !== '600' && mode !== '400') {
            result.addCheck(`security:permissions:${filename}`, false, {
              file: filename,
              expected: '600 or 400',
              actual: mode,
              message: `${filename} has overly permissive permissions: ${mode}`,
              suggestion: `Run "chmod 600 ${filename}" to restrict access`,
            });
          }
        } catch {
          // Can't check permissions, skip
        }
      }
    }
  }

  _checkPackageScripts(projectRoot, result) {
    const pkgPath = path.join(projectRoot, 'package.json');
    if (!fs.existsSync(pkgPath)) return;

    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const scripts = pkg.scripts || {};
      const suspicious = ['curl', 'wget', 'nc ', 'netcat', 'base64', '| sh', '| bash'];

      for (const [name, cmd] of Object.entries(scripts)) {
        for (const pattern of suspicious) {
          if (cmd.includes(pattern)) {
            result.addCheck(`security:script:${name}`, false, {
              message: `Suspicious pattern "${pattern}" in script "${name}"`,
              suggestion: 'Review this script for supply chain attack vectors',
            });
          }
        }
      }
    } catch {
      // Invalid package.json handled by syntax module
    }
  }

  _checkNpmAuth(projectRoot, result) {
    const npmrcPath = path.join(projectRoot, '.npmrc');
    if (fs.existsSync(npmrcPath)) {
      const content = fs.readFileSync(npmrcPath, 'utf-8');
      if (content.includes('_authToken') || content.includes('_auth=')) {
        result.addCheck('security:npmrc-token', false, {
          file: '.npmrc',
          message: 'Auth token found in .npmrc',
          suggestion: 'Use environment variables for npm auth tokens',
        });
      }
    }
  }

  _scanForSecrets(projectRoot, result) {
    const secretExtensions = [
      '.js', '.ts', '.jsx', '.tsx', '.py', '.go', '.java', '.rb',
      '.env', '.yml', '.yaml', '.json', '.toml', '.cfg', '.ini', '.conf',
    ];
    const extraExcludes = ['vendor', '__pycache__', '.next', '.nuxt'];
    const files = this._collectFiles(projectRoot, secretExtensions, extraExcludes);

    const secretPatterns = [
      // AWS keys
      { regex: /(?<![A-Z0-9])AKIA[0-9A-Z]{16}(?![A-Z0-9])/g, name: 'AWS Access Key' },
      // GitHub tokens
      { regex: /(?<![a-zA-Z0-9_])(ghp_[a-zA-Z0-9]{36,}|gho_[a-zA-Z0-9]{36,}|ghu_[a-zA-Z0-9]{36,}|ghs_[a-zA-Z0-9]{36,}|ghr_[a-zA-Z0-9]{36,})/g, name: 'GitHub Token' },
      // Slack tokens
      { regex: /(?<![a-zA-Z0-9_])(xoxb-[a-zA-Z0-9\-]+|xoxp-[a-zA-Z0-9\-]+|xoxs-[a-zA-Z0-9\-]+)/g, name: 'Slack Token' },
      // Stripe keys
      { regex: /(?<![a-zA-Z0-9_])(sk_live_[a-zA-Z0-9]{20,}|pk_live_[a-zA-Z0-9]{20,}|sk_test_[a-zA-Z0-9]{20,})/g, name: 'Stripe Key' },
      // Private keys
      { regex: /-----BEGIN\s+(RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g, name: 'Private Key' },
      // JWT tokens (eyJ followed by base64)
      { regex: /(?<![a-zA-Z0-9_/])(eyJ[a-zA-Z0-9_-]{30,}\.eyJ[a-zA-Z0-9_-]{30,}\.[a-zA-Z0-9_-]+)/g, name: 'JWT Token' },
      // Database connection strings with credentials
      { regex: /(mongodb(\+srv)?|postgres|postgresql|mysql|mariadb|redis|amqp):\/\/[^:\s]+:[^@\s]+@[^\s"'`]+/gi, name: 'Database Connection String with Credentials' },
      // Generic API key assignments
      { regex: /(?:api[_-]?key|apikey)\s*[:=]\s*['"][a-zA-Z0-9_\-/.]{10,}['"]/gi, name: 'API Key' },
      // Generic secrets/passwords/tokens in assignments
      { regex: /(?:secret|password|passwd|pwd|token|auth_token|access_token|refresh_token|client_secret)\s*[:=]\s*['"][a-zA-Z0-9_\-/.+]{8,}['"]/gi, name: 'Hardcoded Secret/Password/Token' },
      // High-entropy hex strings assigned to suspicious variable names
      { regex: /(?:secret|key|token|password|credential|auth)\s*[:=]\s*['"][0-9a-fA-F]{32,}['"]/gi, name: 'High-Entropy Hex String' },
      // High-entropy base64 strings assigned to suspicious variable names
      { regex: /(?:secret|key|token|password|credential|auth)\s*[:=]\s*['"][A-Za-z0-9+/]{32,}={0,2}['"]/gi, name: 'High-Entropy Base64 String' },
    ];

    let totalFindings = 0;

    for (const file of files) {
      const relPath = path.relative(projectRoot, file);
      const basename = path.basename(file);

      // Skip .env.example and similar template files
      if (basename === '.env.example' || basename === '.env.sample' || basename === '.env.template') {
        continue;
      }

      // Skip test files that explicitly test secret patterns
      if (/\.(test|spec|mock|fixture)\./i.test(basename) || /\/__tests__\//.test(relPath) || /\/test\//.test(relPath) || /\/tests\//.test(relPath)) {
        continue;
      }

      let content;
      try {
        content = fs.readFileSync(file, 'utf-8');
      } catch {
        continue;
      }
      const rawLines = content.split('\n');
      // Strip comments only (line + block) — preserves string literals
      // because real hardcoded secrets DO live in strings. JSDoc that
      // documents credential shapes (`-----BEGIN PRIVATE KEY-----` in a
      // module's docstring) is the most common FP source.
      const stripped = this._stripCommentsOnly(content);
      const lines = stripped.split('\n');

      // Skip detector source files — modules that contain credential
      // patterns as documentation or as detection regexes themselves.
      const relPathNorm = relPath.split(path.sep).join('/');
      if (/(?:^|\/)src\/(?:modules\/(?:security|secret-rotation|cross-file-taint|tls-security|cookie-security)|core\/config)\.js$/.test(relPathNorm)) {
        continue;
      }

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        // Honour `// secrets-ok` / `# secrets-ok` suppression on the
        // raw line (so the marker isn't itself stripped) — for cases
        // like error messages that legitimately contain a credential
        // header for user guidance, not a real secret.
        const rawSame = rawLines[i] || '';
        const rawPrev = i > 0 ? rawLines[i - 1] : '';
        if (/(?:\/\/|#)\s*secrets-ok\b/.test(rawSame) ||
            /(?:\/\/|#)\s*secrets-ok\b/.test(rawPrev)) {
          continue;
        }

        // Skip comment lines that document patterns rather than containing real secrets
        if (/^\s*(\/\/|#|\/?\*|--|;)\s*(example|e\.g\.|sample|placeholder|dummy|fake|test|TODO|NOTE|regex|pattern)/i.test(trimmed)) {
          continue;
        }

        for (const pattern of secretPatterns) {
          pattern.regex.lastIndex = 0;
          const match = pattern.regex.exec(line);
          if (match) {
            // Build a redacted preview
            const matchedText = match[0];
            const redacted = matchedText.length > 10
              ? matchedText.slice(0, 6) + '***REDACTED***' + matchedText.slice(-2)
              : '***REDACTED***';

            result.addCheck(`security:secret:${relPath}:${i + 1}`, false, {
              file: relPath,
              line: i + 1,
              patternType: pattern.name,
              message: `Potential ${pattern.name} found in ${relPath}:${i + 1}`,
              preview: redacted,
              suggestion: 'Move this value to environment variables or a secrets manager. Never commit secrets to source control.',
            });
            totalFindings++;
          }
        }
      }
    }

    if (totalFindings === 0) {
      result.addCheck('security:secrets-scan', true, {
        message: `Scanned ${files.length} files for hardcoded secrets — none found`,
      });
    } else {
      result.addCheck('security:secrets-scan', false, {
        message: `Found ${totalFindings} potential secret(s) across scanned files`,
        suggestion: 'Review all findings and move secrets to environment variables or a secrets manager',
      });
    }
  }

  async _checkSecurityHeaders(config, result) {
    let url;
    try {
      url = config.get('liveCrawler.url') || (config.getModuleConfig('security') || {}).url;
    } catch {
      url = null;
    }

    if (!url) {
      result.addCheck('security:headers', true, {
        message: 'No live URL configured — skipping security headers check',
      });
      return;
    }

    try {
      const headers = await this._fetchHeaders(url, 10000);

      const requiredHeaders = [
        { name: 'strict-transport-security', label: 'Strict-Transport-Security (HSTS)',
          check: (v) => v && v.includes('max-age'),
          suggestion: 'Add header: Strict-Transport-Security: max-age=31536000; includeSubDomains' },
        { name: 'content-security-policy', label: 'Content-Security-Policy (CSP)',
          check: (v) => !!v,
          suggestion: 'Add a Content-Security-Policy header to prevent XSS and injection attacks' },
        { name: 'x-frame-options', label: 'X-Frame-Options',
          check: (v) => v && /^(deny|sameorigin)$/i.test(v),
          suggestion: 'Add header: X-Frame-Options: DENY (or SAMEORIGIN)' },
        { name: 'x-content-type-options', label: 'X-Content-Type-Options',
          check: (v) => v === 'nosniff',
          suggestion: 'Add header: X-Content-Type-Options: nosniff' },
        { name: 'referrer-policy', label: 'Referrer-Policy',
          check: (v) => !!v,
          suggestion: 'Add header: Referrer-Policy: strict-origin-when-cross-origin' },
      ];

      for (const req of requiredHeaders) {
        const value = headers[req.name];
        const passed = req.check(value);
        result.addCheck(`security:header:${req.name}`, passed, {
          message: passed
            ? `${req.label}: ${value}`
            : `Missing or invalid ${req.label}`,
          suggestion: passed ? undefined : req.suggestion,
        });
      }

      // Headers that should NOT exist (information disclosure)
      const serverHeader = headers['server'];
      if (serverHeader && /\/[\d.]/.test(serverHeader)) {
        result.addCheck('security:header:server-version', false, {
          message: `Server header reveals version: "${serverHeader}"`,
          suggestion: 'Remove version info from Server header to reduce attack surface',
        });
      }

      if (headers['x-powered-by']) {
        result.addCheck('security:header:x-powered-by', false, {
          message: `X-Powered-By header exposes technology: "${headers['x-powered-by']}"`,
          suggestion: 'Remove X-Powered-By header (e.g., app.disable("x-powered-by") in Express)',
        });
      }

    } catch (err) {
      result.addCheck('security:headers', false, {
        message: `Failed to check security headers: ${err.message}`,
        suggestion: 'Ensure the URL is reachable and the server is running',
      });
    }
  }

  _checkDockerSecurity(projectRoot, result) {
    const dockerfiles = ['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml'];

    for (const df of dockerfiles) {
      const filePath = path.join(projectRoot, df);
      if (!fs.existsSync(filePath)) continue;

      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');

      // Running as root
      if (df === 'Dockerfile') {
        const hasUser = lines.some(l => /^\s*USER\s+(?!root)/i.test(l));
        if (!hasUser) {
          result.addCheck('security:docker-root', false, {
            file: df,
            severity: 'error',
            message: 'Dockerfile runs as root — no USER directive found',
            suggestion: 'Add "USER node" or "USER appuser" before the CMD instruction',
          });
        }

        // Using :latest tag
        for (let i = 0; i < lines.length; i++) {
          if (/^\s*FROM\s+\S+:latest/i.test(lines[i]) || /^\s*FROM\s+\S+\s*$/i.test(lines[i])) {
            result.addCheck(`security:docker-latest:${i + 1}`, false, {
              file: df, line: i + 1,
              severity: 'warning',
              message: 'Using :latest or untagged image — builds are not reproducible',
              suggestion: 'Pin to a specific version: e.g., node:20-alpine',
            });
          }
        }

        // COPY . . without .dockerignore
        if (content.includes('COPY . .') || content.includes('ADD . .')) {
          if (!fs.existsSync(path.join(projectRoot, '.dockerignore'))) {
            result.addCheck('security:docker-no-dockerignore', false, {
              file: df,
              severity: 'error',
              message: 'COPY/ADD entire directory without .dockerignore — secrets may be included',
              suggestion: 'Create a .dockerignore file excluding .env, .git, node_modules, etc.',
            });
          }
        }

        // Exposing secrets via ENV
        for (let i = 0; i < lines.length; i++) {
          if (/^\s*ENV\s+.*(?:password|secret|token|key|api_key)/i.test(lines[i])) {
            result.addCheck(`security:docker-env-secret:${i + 1}`, false, {
              file: df, line: i + 1,
              severity: 'error',
              message: 'Secret exposed in Dockerfile ENV instruction — visible in image layers',
              suggestion: 'Use --mount=type=secret or runtime environment variables instead',
            });
          }
        }
      }

      // docker-compose: privileged mode
      if (df.includes('compose')) {
        if (content.includes('privileged: true')) {
          result.addCheck('security:docker-privileged', false, {
            file: df,
            severity: 'error',
            message: 'Container running in privileged mode — full host access',
            suggestion: 'Remove "privileged: true" unless absolutely necessary',
          });
        }

        // Exposed ports to 0.0.0.0
        const portPattern = /ports:\s*\n(\s+-\s*['"]?\d+:\d+)/g;
        if (portPattern.test(content)) {
          result.addCheck('security:docker-ports', true, {
            file: df,
            severity: 'info',
            message: 'Review exposed ports — bind to 127.0.0.1 for local-only services',
          });
        }
      }
    }
  }

  _checkGitignore(projectRoot, result) {
    const gitignorePath = path.join(projectRoot, '.gitignore');
    if (!fs.existsSync(gitignorePath)) {
      if (fs.existsSync(path.join(projectRoot, '.git'))) {
        result.addCheck('security:gitignore-missing', false, {
          severity: 'error',
          message: 'Git repository has no .gitignore — sensitive files may be committed',
          suggestion: 'Create a .gitignore excluding .env, node_modules, .pem, credentials, etc.',
        });
      }
      return;
    }

    const content = fs.readFileSync(gitignorePath, 'utf-8').toLowerCase();

    const mustIgnore = [
      { pattern: '.env', check: content.includes('.env'), label: '.env files' },
      { pattern: 'node_modules', check: content.includes('node_modules'), label: 'node_modules' },
      { pattern: '.pem', check: content.includes('.pem') || content.includes('*.pem'), label: 'PEM keys' },
    ];

    for (const item of mustIgnore) {
      if (!item.check) {
        // Verify the files actually exist before flagging
        const exists = this._collectFiles(projectRoot, ['*']).some(f =>
          path.basename(f).includes(item.pattern) || f.includes(item.pattern)
        );
        if (item.pattern === 'node_modules' || item.pattern === '.env') {
          result.addCheck(`security:gitignore:${item.pattern}`, false, {
            file: '.gitignore',
            severity: item.pattern === '.env' ? 'error' : 'warning',
            message: `${item.label} not in .gitignore`,
            suggestion: `Add "${item.pattern}" to .gitignore`,
          });
        }
      }
    }
  }

  _checkLicenseCompliance(projectRoot, result) {
    const pkgPath = path.join(projectRoot, 'package.json');
    if (!fs.existsSync(pkgPath)) return;

    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };

      if (Object.keys(allDeps).length === 0) return;

      // Check for known copyleft/restrictive licenses in node_modules
      const nodeModules = path.join(projectRoot, 'node_modules');
      if (!fs.existsSync(nodeModules)) return;

      const copyleftLicenses = ['GPL-2.0', 'GPL-3.0', 'AGPL-3.0', 'AGPL-1.0', 'SSPL-1.0', 'EUPL-1.1', 'EUPL-1.2'];
      const flagged = [];

      for (const dep of Object.keys(allDeps).slice(0, 50)) {
        const depPkgPath = path.join(nodeModules, dep, 'package.json');
        if (!fs.existsSync(depPkgPath)) continue;

        try {
          const depPkg = JSON.parse(fs.readFileSync(depPkgPath, 'utf-8'));
          const license = depPkg.license || '';

          if (copyleftLicenses.some(cl => license.toUpperCase().includes(cl.toUpperCase()))) {
            flagged.push({ name: dep, license });
          }
        } catch { /* skip */ }
      }

      if (flagged.length > 0) {
        for (const dep of flagged.slice(0, 5)) {
          result.addCheck(`security:license:${dep.name}`, false, {
            severity: 'warning',
            message: `Dependency "${dep.name}" has copyleft license: ${dep.license}`,
            suggestion: 'Copyleft licenses may require you to open-source your code. Review compliance.',
          });
        }
      } else {
        result.addCheck('security:licenses', true, {
          severity: 'info',
          message: 'No copyleft license conflicts detected in dependencies',
        });
      }
    } catch { /* skip */ }
  }

  _checkEnvFiles(projectRoot, result) {
    // Check if .env files are committed (should never be)
    const envFiles = ['.env', '.env.local', '.env.production', '.env.staging'];
    const gitDir = path.join(projectRoot, '.git');

    if (!fs.existsSync(gitDir)) return;

    for (const envFile of envFiles) {
      const envPath = path.join(projectRoot, envFile);
      if (!fs.existsSync(envPath)) continue;

      // Check if file is tracked by git
      const { exitCode } = this._exec(`git ls-files --error-unmatch "${envFile}" 2>/dev/null`, {
        cwd: projectRoot,
      });

      if (exitCode === 0) {
        result.addCheck(`security:env-tracked:${envFile}`, false, {
          file: envFile,
          severity: 'error',
          message: `${envFile} is tracked by git — secrets are in your repo history`,
          suggestion: `Add "${envFile}" to .gitignore and remove from tracking: git rm --cached ${envFile}`,
        });
      }

      // Check env file contents for real-looking secrets (not placeholders)
      const content = fs.readFileSync(envPath, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line || line.startsWith('#')) continue;

        const match = line.match(/^([^=]+)=(.+)$/);
        if (match) {
          const value = match[2].trim().replace(/^['"]|['"]$/g, '');
          // Flag values that look like real secrets (high entropy, not placeholders)
          if (value.length > 20 && !/^(your_|changeme|placeholder|example|xxx|test|dummy)/i.test(value)) {
            if (/[A-Za-z]/.test(value) && /[0-9]/.test(value) && /[^A-Za-z0-9]/.test(value)) {
              result.addCheck(`security:env-secret:${envFile}:${match[1]}`, false, {
                file: envFile,
                line: i + 1,
                severity: 'warning',
                message: `${match[1]} in ${envFile} appears to contain a real secret`,
                suggestion: 'Ensure this file is in .gitignore and never committed',
              });
              break; // One warning per file
            }
          }
        }
      }
    }
  }

  _fetchHeaders(url, timeout) {
    return new Promise((resolve, reject) => {
      const parsedUrl = new (require('url').URL)(url);
      const client = parsedUrl.protocol === 'https:' ? https : http;

      const req = client.get(url, { timeout, headers: { 'User-Agent': 'GateTest/1.0' } }, (res) => {
        resolve(res.headers);
        res.resume();
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    });
  }
}

module.exports = SecurityModule;
