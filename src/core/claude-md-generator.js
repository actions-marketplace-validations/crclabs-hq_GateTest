/**
 * CLAUDE.md Generator — Scans a project and generates a tailored CLAUDE.md
 *
 * GateTest writes the rules, not Claude. The student doesn't write the exam.
 *
 * Detects:
 *   - Tech stack (Next.js, React, Node, Python, etc.)
 *   - Package manager (npm, yarn, pnpm, pip)
 *   - Test framework (Jest, Vitest, Mocha, Playwright, etc.)
 *   - Build tools and scripts
 *   - Existing CLAUDE.md (merges, doesn't overwrite)
 *   - Live site URL (if provided)
 *   - Current issues from a quick scan
 */

const fs = require('fs');
const path = require('path');

class ClaudeMdGenerator {
  constructor(projectRoot, options = {}) {
    this.root = projectRoot;
    this.siteUrl = options.siteUrl || null;
    this.projectName = path.basename(projectRoot);
    this.stack = {};
  }

  async generate() {
    this._detectStack();
    const md = this._buildClaudeMd();
    return md;
  }

  async generateAndWrite() {
    const md = await this.generate();
    const claudeMdPath = path.join(this.root, 'CLAUDE.md');

    // If CLAUDE.md exists, prepend GateTest section
    if (fs.existsSync(claudeMdPath)) {
      const existing = fs.readFileSync(claudeMdPath, 'utf-8');
      if (existing.includes('GATETEST QUALITY GATE')) {
        // Already has GateTest section — update it
        const marker = '## GATETEST QUALITY GATE';
        const endMarker = '\n---\n';
        const startIdx = existing.indexOf(marker);
        const endIdx = existing.indexOf(endMarker, startIdx);

        if (startIdx >= 0 && endIdx >= 0) {
          const updated = existing.slice(0, startIdx) + md + existing.slice(endIdx);
          fs.writeFileSync(claudeMdPath, updated);
        } else {
          // Can't find end marker, prepend fresh
          fs.writeFileSync(claudeMdPath, md + '\n---\n\n' + existing);
        }
      } else {
        // Prepend GateTest section to existing CLAUDE.md
        fs.writeFileSync(claudeMdPath, md + '\n---\n\n' + existing);
      }
    } else {
      fs.writeFileSync(claudeMdPath, md);
    }

    // Also generate hooks
    this._writeHooks();

    return claudeMdPath;
  }

  _detectStack() {
    const s = this.stack;

    // Package.json
    const pkgPath = path.join(this.root, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        s.packageJson = true;
        s.name = pkg.name || this.projectName;
        s.scripts = pkg.scripts || {};

        const allDeps = {
          ...(pkg.dependencies || {}),
          ...(pkg.devDependencies || {}),
        };

        // Frameworks
        if (allDeps.next) s.nextjs = true;
        if (allDeps.react) s.react = true;
        if (allDeps.vue) s.vue = true;
        if (allDeps.svelte || allDeps['@sveltejs/kit']) s.svelte = true;
        if (allDeps.express) s.express = true;
        if (allDeps.fastify) s.fastify = true;

        // Styling
        if (allDeps.tailwindcss) s.tailwind = true;
        if (allDeps['styled-components']) s.styledComponents = true;

        // Testing
        if (allDeps.jest) s.jest = true;
        if (allDeps.vitest) s.vitest = true;
        if (allDeps.mocha) s.mocha = true;
        if (allDeps['@playwright/test'] || allDeps.playwright) s.playwright = true;
        if (allDeps.cypress) s.cypress = true;

        // TypeScript
        if (allDeps.typescript) s.typescript = true;

        // Linting
        if (allDeps.eslint) s.eslint = true;
        if (allDeps.prettier) s.prettier = true;

        // Database
        if (allDeps.prisma || allDeps['@prisma/client']) s.prisma = true;
        if (allDeps.drizzle || allDeps['drizzle-orm']) s.drizzle = true;
        if (allDeps.mongoose) s.mongoose = true;

        // Auth
        if (allDeps['next-auth'] || allDeps['@auth/core']) s.auth = true;
        if (allDeps['@supabase/supabase-js']) s.supabase = true;
        if (allDeps['@clerk/nextjs']) s.clerk = true;

        // Package manager
        if (fs.existsSync(path.join(this.root, 'pnpm-lock.yaml'))) s.pnpm = true;
        else if (fs.existsSync(path.join(this.root, 'yarn.lock'))) s.yarn = true;
        else s.npm = true;

      } catch {} // error-ok — stack detection is best-effort; use defaults if package.json unreadable
    }

    // Python
    if (fs.existsSync(path.join(this.root, 'requirements.txt')) ||
        fs.existsSync(path.join(this.root, 'pyproject.toml'))) {
      s.python = true;
    }

    // Detect build command
    if (s.scripts) {
      s.buildCmd = s.scripts.build ? this._pkgRunner() + ' run build' : null;
      s.testCmd = s.scripts.test ? this._pkgRunner() + ' test' : null;
      s.devCmd = s.scripts.dev ? this._pkgRunner() + ' run dev' : null;
      s.lintCmd = s.scripts.lint ? this._pkgRunner() + ' run lint' : null;
    }

    // Detect site URL from vercel.json, .env, etc.
    if (!this.siteUrl) {
      const envPath = path.join(this.root, '.env');
      if (fs.existsSync(envPath)) {
        try {
          const env = fs.readFileSync(envPath, 'utf-8');
          const match = env.match(/NEXT_PUBLIC_(?:APP_|SITE_)?URL\s*=\s*["']?([^\s"']+)/);
          if (match) this.siteUrl = match[1];
        } catch {} // error-ok — .env read is best-effort; siteUrl stays null if unreadable
      }
    }
  }

  _pkgRunner() {
    if (this.stack.pnpm) return 'pnpm';
    if (this.stack.yarn) return 'yarn';
    return 'npm';
  }

  _buildClaudeMd() {
    const s = this.stack;
    const runner = this._pkgRunner();
    const lines = [];

    // Header
    lines.push(`# ${s.name || this.projectName} — Project Rules`);
    lines.push('');
    lines.push(`## READ THIS FIRST — MANDATORY FOR EVERY SESSION`);
    lines.push('');
    lines.push(`**You are working on ${s.name || this.projectName}.** Before doing ANYTHING:`);
    lines.push('');
    lines.push('1. **READ this entire file.** Do not code until you understand the project.');
    lines.push('2. **Run `git status` and `git log --oneline -10`** to see where the last session left off.');
    lines.push('3. **Do NOT start from scratch.** This is an existing project. Build on what\'s here.');
    lines.push('4. **Do NOT reorganize, refactor, or "improve"** unless explicitly asked.');
    lines.push('5. **Do NOT create new files** unless absolutely necessary. Edit existing files first.');
    lines.push('6. **Check the current branch** with `git branch` — stay on it unless told otherwise.');
    lines.push('7. **Commit and push** when work is complete.');
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push(`## GATETEST QUALITY GATE`);
    lines.push('');
    lines.push(`GateTest is the QA gate for **${s.name || this.projectName}**.`);
    lines.push('It scans code and the live site, catches every error, and blocks deployment until clean.');
    lines.push('');

    // Rules
    lines.push('### RULES (NON-NEGOTIABLE)');
    lines.push('');
    lines.push('1. **After making ANY changes**, run the GateTest scan:');
    lines.push('   ```');
    lines.push('   node gatetest-scan.js');
    lines.push('   ```');
    lines.push('');
    lines.push('2. **Read the report** at `.gatetest/reports/fix-these.md`');
    lines.push('');
    lines.push('3. **SHOW THE USER THE RESULTS.** After every scan, display:');
    lines.push('   ```');
    lines.push('   ## GateTest Scan Results');
    lines.push('   - Pages scanned: X');
    lines.push('   - Issues found: X');
    lines.push('   - What broke: [list]');
    lines.push('   - Status: PASS / FAIL');
    lines.push('   ```');
    lines.push('   The user must SEE what\'s happening. Do not fix silently.');
    lines.push('');
    lines.push('4. **Fix EVERY issue** in the report. No exceptions.');
    lines.push('');
    lines.push('5. **Rescan after fixing.** Repeat until ALL CLEAR.');
    lines.push('   Show updated results after each rescan.');
    lines.push('');
    lines.push('6. **Do NOT tell the user "it\'s fixed"** until the scan returns ALL CLEAR.');
    lines.push('   This is the #1 rule. The scan is the source of truth, not your confidence.');
    lines.push('');
    lines.push('7. **When ALL CLEAR**, show:');
    lines.push('   ```');
    lines.push('   ## GateTest — ALL CLEAR');
    lines.push('   - Issues found: 0');
    lines.push('   - Scan rounds: X');
    lines.push('   - What was fixed: [list]');
    lines.push('   ```');
    lines.push('');

    // Tech stack detected
    lines.push('### PROJECT STACK');
    lines.push('');
    const stackParts = [];
    if (s.nextjs) stackParts.push('Next.js');
    else if (s.react) stackParts.push('React');
    if (s.vue) stackParts.push('Vue');
    if (s.svelte) stackParts.push('Svelte');
    if (s.express) stackParts.push('Express');
    if (s.fastify) stackParts.push('Fastify');
    if (s.typescript) stackParts.push('TypeScript');
    if (s.tailwind) stackParts.push('Tailwind CSS');
    if (s.prisma) stackParts.push('Prisma');
    if (s.drizzle) stackParts.push('Drizzle');
    if (s.supabase) stackParts.push('Supabase');
    if (s.python) stackParts.push('Python');
    if (stackParts.length > 0) {
      lines.push(`- Stack: ${stackParts.join(', ')}`);
    }
    if (s.buildCmd) lines.push(`- Build: \`${s.buildCmd}\``);
    if (s.testCmd) lines.push(`- Test: \`${s.testCmd}\``);
    if (s.devCmd) lines.push(`- Dev: \`${s.devCmd}\``);
    if (s.lintCmd) lines.push(`- Lint: \`${s.lintCmd}\``);
    lines.push(`- Package manager: ${runner}`);
    if (this.siteUrl) lines.push(`- Live site: ${this.siteUrl}`);
    lines.push('');

    // Scan commands
    lines.push('### SCAN COMMANDS');
    lines.push('');
    lines.push('```bash');
    lines.push('# Quick scan (syntax, lint, secrets, quality)');
    lines.push('node gatetest-scan.js');
    lines.push('');
    lines.push('# Full scan (all 16 modules)');
    lines.push(`gatetest --suite full --project .`);
    if (this.siteUrl) {
      lines.push('');
      lines.push('# Crawl live site');
      lines.push(`gatetest --crawl ${this.siteUrl}`);
    }
    lines.push('```');
    lines.push('');

    // Pre-commit rules based on detected stack
    lines.push('### BEFORE EVERY COMMIT');
    lines.push('');
    if (s.typescript) lines.push('- [ ] `npx tsc --noEmit` — zero TypeScript errors');
    if (s.eslint) lines.push(`- [ ] \`${runner} run lint\` — zero ESLint errors`);
    if (s.buildCmd) lines.push(`- [ ] \`${s.buildCmd}\` — build succeeds`);
    if (s.testCmd) lines.push(`- [ ] \`${s.testCmd}\` — all tests pass`);
    lines.push('- [ ] No console.log or debugger statements in production code');
    lines.push('- [ ] No hardcoded secrets or API keys');
    lines.push('- [ ] No unused imports or variables');
    if (s.nextjs || s.react) {
      lines.push('- [ ] All images have alt text');
      lines.push('- [ ] All form inputs have labels');
      lines.push('- [ ] No accessibility violations');
    }
    lines.push('');

    // What GateTest checks
    lines.push('### WHAT GATETEST CHECKS');
    lines.push('');
    lines.push('| Module | What It Scans |');
    lines.push('|--------|--------------|');
    lines.push('| syntax | JS/TS/JSON parse errors, TypeScript strict |');
    lines.push('| lint | ESLint, Stylelint errors |');
    lines.push('| secrets | API keys, tokens, passwords in code |');
    lines.push('| codeQuality | Console.logs, long functions, unused imports, TODOs |');
    lines.push('| security | eval(), innerHTML, Math.random for crypto, dependency CVEs |');
    lines.push('| accessibility | Alt text, form labels, ARIA, keyboard navigation |');
    lines.push('| visual | Layout shifts, broken images, font loading |');
    lines.push('| performance | Bundle size, lazy loading, render-blocking resources |');
    lines.push('| seo | Title tags, meta descriptions, Open Graph, structured data |');
    lines.push('| links | Broken internal/external links |');
    lines.push('| unitTests | Test suite passes |');
    if (this.siteUrl) {
      lines.push('| liveCrawler | Every page loads, no errors, no broken images |');
    }
    lines.push('');

    return lines.join('\n');
  }

  _writeHooks() {
    const claudeDir = path.join(this.root, '.claude');
    if (!fs.existsSync(claudeDir)) {
      fs.mkdirSync(claudeDir, { recursive: true });
    }

    // Session health check script
    const healthScript = `#!/bin/bash
PROJECT_DIR="${this.root}"
cd "$PROJECT_DIR" 2>/dev/null
BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")
LAST_5=$(git log --oneline -5 2>/dev/null || echo "no commits")
STATUS=$(git status --short 2>/dev/null || echo "unknown")
CLAUDE_MD_EXISTS="false"
if [ -f "CLAUDE.md" ]; then CLAUDE_MD_EXISTS="true"; fi

cat <<EOJSON
{
  "systemMessage": "SESSION START — MANDATORY COMPLIANCE CHECK\\n\\n=== PROJECT: ${this.projectName} ===\\nBranch: $BRANCH\\nCLAUDE.md exists: $CLAUDE_MD_EXISTS\\n\\nRecent commits:\\n$LAST_5\\n\\nWorking tree status:\\n$STATUS\\n\\n=== MANDATORY INSTRUCTIONS ===\\n1. READ CLAUDE.md NOW. It contains quality gate rules and project context.\\n2. Do NOT start from scratch. Continue where the last session left off.\\n3. Do NOT reorganize or refactor unless explicitly asked.\\n4. After ANY code change, run: node gatetest-scan.js\\n5. SHOW the user ALL scan results. Do not fix silently.\\n6. Do NOT say it is fixed until gatetest-scan.js returns ALL CLEAR.\\n7. Commit and push when work is complete."
}
EOJSON
`;

    const healthPath = path.join(claudeDir, 'session-health-check.sh');
    fs.writeFileSync(healthPath, healthScript);
    try { fs.chmodSync(healthPath, '755'); } catch {} // error-ok — chmod failure is harmless; script still runs

    // Settings with hooks
    const settings = {
      hooks: {
        SessionStart: [{
          type: 'command',
          command: `bash ${healthPath} 2>&1 | head -100`,
        }],
        PreToolUse: [{
          type: 'command',
          command: `if [ "$TOOL_NAME" = "Edit" ] || [ "$TOOL_NAME" = "Write" ]; then echo '{"systemMessage": "REMINDER: GateTest is ACTIVE. After this edit, run node gatetest-scan.js and SHOW results to the user."}'; fi`,
          timeout: 3,
        }],
        Stop: [{
          hooks: [{
            type: 'command',
            command: `cd ${this.root} && REPORT='.gatetest/reports/fix-these.md'; if [ -f "$REPORT" ]; then ISSUES=$(grep -c 'FAIL\\|ERROR\\|CRITICAL' "$REPORT" 2>/dev/null || echo 0); if [ "$ISSUES" -gt 0 ]; then echo '{"systemMessage": "GateTest report still has issues. Fix before ending."}'; else echo '{"systemMessage": "GateTest: clean."}'; fi; else echo '{"systemMessage": "No GateTest scan was run this session."}'; fi`,
            timeout: 5,
          }],
        }],
      },
    };

    fs.writeFileSync(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify(settings, null, 2)
    );

    // GateTest scan script
    const scanScript = `const { execSync } = require('child_process');
const path = require('path');

const GATETEST_DIR = ${JSON.stringify(path.resolve(__dirname, '..'))};
const PROJECT_DIR = __dirname;
${this.siteUrl ? `const SITE_URL = ${JSON.stringify(this.siteUrl)};` : ''}

console.log('[GateTest] Scanning ${this.projectName}...\\n');

// Run code scan
try {
  execSync(\`node \${path.join(GATETEST_DIR, 'bin/gatetest.js')} --suite standard --project \${PROJECT_DIR}\`, { stdio: 'inherit' });
} catch {} // error-ok — exit code surfaces scan result; swallow to keep script running

${this.siteUrl ? `// Crawl live site
try {
  execSync(\`node \${path.join(GATETEST_DIR, 'src/ai-loop.js')} \${SITE_URL}\`, { stdio: 'inherit', cwd: PROJECT_DIR });
} catch {} // error-ok — crawl failure must not break the scan script` : ''}
`;

    fs.writeFileSync(path.join(this.root, 'gatetest-scan.js'), scanScript);

    // Config
    const configDir = path.join(this.root, '.gatetest');
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    const config = {
      project: this.projectName,
      stack: Object.keys(this.stack).filter(k => this.stack[k] === true),
      siteUrl: this.siteUrl,
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(config, null, 2));
  }
}

module.exports = { ClaudeMdGenerator };
