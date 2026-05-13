#!/usr/bin/env node

/**
 * GateTest Project Setup - Installs GateTest into any project.
 *
 * Usage:
 *   node setup.js /path/to/your/project https://your-live-site.com
 *
 * Example:
 *   node setup.js /home/user/Zoobicon.com https://zoobicon.com
 *
 * What it does:
 * 1. Creates .gatetest/ directory with config pointing to your live URL
 * 2. Adds GateTest instructions to your project's CLAUDE.md
 * 3. Creates a simple run script so Claude knows how to test
 * 4. That's it. Next Claude session, it knows to run GateTest.
 */

const fs = require('fs');
const path = require('path');

const projectPath = process.argv[2];
const siteUrl = process.argv[3];

if (!projectPath) {
  console.error('\nUsage: node setup.js <project-path> [site-url]\n');
  console.error('Example: node setup.js /home/user/Zoobicon.com https://zoobicon.com\n');
  process.exit(1);
}

const absProjectPath = path.resolve(projectPath);
const gateTestRoot = path.resolve(__dirname);

if (!fs.existsSync(absProjectPath)) {
  console.error(`\nError: Project path does not exist: ${absProjectPath}\n`);
  process.exit(1);
}

console.log('');
console.log('='.repeat(60));
console.log('  GATETEST SETUP');
console.log(`  Project: ${absProjectPath}`);
if (siteUrl) console.log(`  Site URL: ${siteUrl}`);
console.log('='.repeat(60));
console.log('');

// 1. Create .gatetest directory and config
const gateTestDir = path.join(absProjectPath, '.gatetest');
const reportsDir = path.join(gateTestDir, 'reports');
const screenshotsDir = path.join(gateTestDir, 'screenshots');

for (const dir of [gateTestDir, reportsDir, screenshotsDir]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`  Created: ${path.relative(absProjectPath, dir)}/`);
  }
}

// 2. Create config
const config = {
  gateTestPath: gateTestRoot,
  modules: {
    liveCrawler: {
      url: siteUrl || 'https://your-site.com',
      maxPages: 200,
      timeout: 15000,
      checkExternal: true,
    },
    explorer: {
      url: siteUrl || 'https://your-site.com',
      maxPages: 50,
      viewports: [
        { width: 1280, height: 800, name: 'desktop' },
        { width: 375, height: 812, name: 'mobile' },
      ],
    },
  },
  reporting: {
    formats: ['json', 'html', 'console'],
  },
};

const configPath = path.join(gateTestDir, 'config.json');
fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
console.log(`  Created: .gatetest/config.json`);

// 3. Create the run script
const runScript = `#!/usr/bin/env node
/**
 * Run GateTest against the live site.
 * Usage: node gatetest-scan.js
 */
const { execSync } = require('child_process');
const path = require('path');

const gateTestPath = ${JSON.stringify(gateTestRoot)};
const siteUrl = ${JSON.stringify(siteUrl || 'https://your-site.com')};

console.log('\\n[GateTest] Scanning ' + siteUrl + '...\\n');

try {
  execSync(\`node \${path.join(gateTestPath, 'src/ai-loop.js')} \${siteUrl}\`, {
    stdio: 'inherit',
    cwd: process.cwd(),
  });
} catch (err) {
  // Non-zero exit means issues found — that's expected
  process.exit(err.status || 1);
}
`;

const runScriptPath = path.join(absProjectPath, 'gatetest-scan.js');
fs.writeFileSync(runScriptPath, runScript);
console.log(`  Created: gatetest-scan.js`);

// 4. Update or create CLAUDE.md with GateTest instructions
const claudeMdPath = path.join(absProjectPath, 'CLAUDE.md');
const gateTestBlock = `
## GATETEST QUALITY GATE (MANDATORY)

GateTest is the QA gate for this project. It scans the live site and catches
every error before it reaches users.

### RULES (NON-NEGOTIABLE)

1. **After making ANY changes**, run the GateTest scan:
   \`\`\`
   node gatetest-scan.js
   \`\`\`

2. **Read the report** at \`.gatetest/reports/fix-these.md\`

3. **Fix EVERY issue** listed in the report. No exceptions.

4. **Run the scan again** after fixing. Repeat until it says ALL CLEAR.

5. **Do NOT tell the user "it's fixed"** until the scan returns ALL CLEAR.
   This is the #1 rule. Users are tired of being told things are fixed when
   they're not. The scan is the source of truth, not your confidence.

6. **What GateTest checks on every scan:**
   - Every page loads (no 404s, no 500s)
   - No blank/empty pages
   - No error messages visible to users
   - No broken images
   - No broken links (internal and external)
   - Every page has a title
   - No mixed HTTP/HTTPS content
   - Page load times are reasonable
   - No JavaScript errors in the page

### SCAN COMMANDS

\`\`\`bash
# Quick scan — crawl the live site
node gatetest-scan.js

# Full scan with GateTest CLI (all 19 modules)
node ${path.join(gateTestRoot, 'bin/gatetest.js')} --suite nuclear --project .

# Crawl with max pages
node ${path.join(gateTestRoot, 'src/ai-loop.js')} ${siteUrl || 'https://your-site.com'}
\`\`\`
`;

if (fs.existsSync(claudeMdPath)) {
  const existing = fs.readFileSync(claudeMdPath, 'utf-8');
  if (!existing.includes('GATETEST QUALITY GATE')) {
    // Prepend GateTest section at the top (after any existing title)
    const titleMatch = existing.match(/^(#[^\n]*\n)/);
    let updated;
    if (titleMatch) {
      updated = titleMatch[1] + gateTestBlock + '\n' + existing.slice(titleMatch[0].length);
    } else {
      updated = gateTestBlock + '\n' + existing;
    }
    fs.writeFileSync(claudeMdPath, updated);
    console.log(`  Updated: CLAUDE.md (added GateTest section)`);
  } else {
    console.log(`  Skipped: CLAUDE.md (GateTest section already present)`);
  }
} else {
  fs.writeFileSync(claudeMdPath, `# Project\n${gateTestBlock}`);
  console.log(`  Created: CLAUDE.md`);
}

// 5. Add .gatetest to .gitignore if it exists
const gitignorePath = path.join(absProjectPath, '.gitignore');
if (fs.existsSync(gitignorePath)) {
  const gitignore = fs.readFileSync(gitignorePath, 'utf-8');
  const additions = [];
  if (!gitignore.includes('.gatetest/reports')) additions.push('.gatetest/reports/');
  if (!gitignore.includes('.gatetest/screenshots')) additions.push('.gatetest/screenshots/');

  if (additions.length > 0) {
    fs.appendFileSync(gitignorePath, '\n# GateTest\n' + additions.join('\n') + '\n');
    console.log(`  Updated: .gitignore`);
  }
}

console.log('');
console.log('  SETUP COMPLETE');
console.log('');
console.log('  What happens now:');
console.log('  1. Next time Claude opens this project, it reads CLAUDE.md');
console.log('  2. CLAUDE.md tells Claude to run GateTest after any change');
console.log('  3. GateTest scans the live site and finds every problem');
console.log('  4. Claude reads the report and fixes everything');
console.log('  5. Claude runs GateTest again until ALL CLEAR');
console.log('');
console.log('  To test now:');
console.log(`  cd ${absProjectPath} && node gatetest-scan.js`);
console.log('');
console.log('='.repeat(60));
console.log('');
