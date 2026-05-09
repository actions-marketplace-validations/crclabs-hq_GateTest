/**
 * Syntax Module - Deep syntax validation across ALL source files.
 * Not just "does it parse" — checks imports resolve, template literals close,
 * config files are valid, and TypeScript strict mode passes clean.
 */

const BaseModule = require('./base-module');
const fs = require('fs');
const path = require('path');

class SyntaxModule extends BaseModule {
  constructor() {
    super('syntax', 'Syntax & Compilation Checks');
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;

    // JavaScript / ESM / CJS
    const jsFiles = this._collectFiles(projectRoot, ['.js', '.mjs', '.cjs']);
    for (const file of jsFiles) {
      this._checkJsSyntax(file, result, projectRoot);
    }

    // TypeScript
    const tsFiles = this._collectFiles(projectRoot, ['.ts', '.tsx']);
    if (tsFiles.length > 0) {
      await this._checkTypeScript(projectRoot, result);
    }

    // JSX (React)
    const jsxFiles = this._collectFiles(projectRoot, ['.jsx']);
    for (const file of jsxFiles) {
      this._checkJsxSyntax(file, result, projectRoot);
    }

    // JSON
    const jsonFiles = this._collectFiles(projectRoot, ['.json']);
    for (const file of jsonFiles) {
      this._checkJsonSyntax(file, result, projectRoot);
    }

    // YAML
    const yamlFiles = this._collectFiles(projectRoot, ['.yml', '.yaml']);
    for (const file of yamlFiles) {
      this._checkYamlSyntax(file, result, projectRoot);
    }

    // TOML
    const tomlFiles = this._collectFiles(projectRoot, ['.toml']);
    for (const file of tomlFiles) {
      this._checkTomlSyntax(file, result, projectRoot);
    }

    // CSS
    const cssFiles = this._collectFiles(projectRoot, ['.css']);
    for (const file of cssFiles) {
      this._checkCssSyntax(file, result, projectRoot);
    }

    // HTML
    const htmlFiles = this._collectFiles(projectRoot, ['.html', '.htm']);
    for (const file of htmlFiles) {
      this._checkHtmlSyntax(file, result, projectRoot);
    }

    // Import resolution
    this._checkImportResolution(projectRoot, jsFiles, result);

    // Dangling patterns
    this._checkDanglingPatterns(projectRoot, [...jsFiles, ...tsFiles, ...jsxFiles], result);

    if (jsFiles.length === 0 && jsonFiles.length === 0 && tsFiles.length === 0) {
      result.addCheck('syntax-scan', true, { message: 'No source files to check', severity: 'info' });
    }
  }

  _checkJsSyntax(file, result, projectRoot) {
    const relPath = path.relative(projectRoot, file);
    try {
      const content = fs.readFileSync(file, 'utf-8');
      const ext = path.extname(file).toLowerCase();

      // .mjs files are ES modules — vm.Script rejects top-level import/export.
      // Use `node --check` (or treat them as syntactically valid if node --check
      // is unavailable) so ESM files don't false-positive.
      if (ext === '.mjs') {
        const { exitCode, stderr } = this._exec(`node --check "${file}" 2>&1`, {
          cwd: projectRoot,
        });
        if (exitCode !== 0 && stderr && /SyntaxError/i.test(stderr)) {
          result.addCheck(`syntax:${relPath}`, false, {
            file: relPath,
            message: stderr.trim().slice(0, 200),
            suggestion: 'Fix the syntax error at the indicated location',
          });
        } else {
          result.addCheck(`syntax:${relPath}`, true);
        }
        return;
      }

      const vm = require('vm');
      new vm.Script(content, { filename: file });
      result.addCheck(`syntax:${relPath}`, true);
    } catch (err) {
      if (err instanceof SyntaxError) {
        result.addCheck(`syntax:${relPath}`, false, {
          file: relPath,
          line: err.lineNumber,
          message: err.message,
          suggestion: 'Fix the syntax error at the indicated location',
        });
      } else {
        result.addCheck(`syntax:${relPath}`, true);
      }
    }
  }

  _checkJsxSyntax(file, result, projectRoot) {
    const relPath = path.relative(projectRoot, file);
    const content = fs.readFileSync(file, 'utf-8');

    // Check for unclosed JSX tags
    const openTags = (content.match(/<[A-Z][a-zA-Z]*(?:\s[^>]*)?>(?!.*\/>)/g) || []).length;
    const closeTags = (content.match(/<\/[A-Z][a-zA-Z]*>/g) || []).length;

    if (Math.abs(openTags - closeTags) > 2) {
      result.addCheck(`syntax:jsx-balance:${relPath}`, false, {
        file: relPath,
        severity: 'warning',
        message: `JSX tag mismatch: ${openTags} opening vs ${closeTags} closing tags`,
        suggestion: 'Check for unclosed JSX components',
      });
    }

    // Check for common JSX mistakes
    if (content.includes('class=') && !content.includes('className=')) {
      result.addCheck(`syntax:jsx-class:${relPath}`, false, {
        file: relPath,
        severity: 'warning',
        message: 'Using "class=" instead of "className=" in JSX',
        suggestion: 'Replace class= with className= in JSX files',
      });
    }
  }

  _checkJsonSyntax(file, result, projectRoot) {
    const relPath = path.relative(projectRoot, file);
    try {
      const content = fs.readFileSync(file, 'utf-8');
      JSON.parse(content);
      result.addCheck(`json:${relPath}`, true);
    } catch (err) {
      result.addCheck(`json:${relPath}`, false, {
        file: relPath,
        message: err.message,
        suggestion: 'Fix the JSON syntax error',
      });
    }
  }

  _checkYamlSyntax(file, result, projectRoot) {
    const relPath = path.relative(projectRoot, file);
    const content = fs.readFileSync(file, 'utf-8');

    // Basic YAML validation — check for common errors
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Tab indentation (YAML requires spaces)
      if (line.match(/^\t/)) {
        result.addCheck(`yaml:tabs:${relPath}:${i + 1}`, false, {
          file: relPath,
          line: i + 1,
          severity: 'error',
          message: 'YAML files must use spaces for indentation, not tabs',
          suggestion: 'Replace tabs with spaces',
        });
        return; // One error per file is enough
      }
    }
    result.addCheck(`yaml:${relPath}`, true);
  }

  _checkTomlSyntax(file, result, projectRoot) {
    const relPath = path.relative(projectRoot, file);
    const content = fs.readFileSync(file, 'utf-8');

    // Basic TOML validation
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith('#')) continue;

      // Check for unclosed brackets in table headers
      if (line.startsWith('[') && !line.includes(']')) {
        result.addCheck(`toml:bracket:${relPath}:${i + 1}`, false, {
          file: relPath,
          line: i + 1,
          message: 'Unclosed bracket in TOML table header',
          suggestion: 'Close the bracket in the table header',
        });
        return;
      }
    }
    result.addCheck(`toml:${relPath}`, true);
  }

  _checkCssSyntax(file, result, projectRoot) {
    const relPath = path.relative(projectRoot, file);
    const content = fs.readFileSync(file, 'utf-8');

    // Check for balanced braces
    const opens = (content.match(/{/g) || []).length;
    const closes = (content.match(/}/g) || []).length;

    if (opens !== closes) {
      result.addCheck(`css:braces:${relPath}`, false, {
        file: relPath,
        message: `Unbalanced braces: ${opens} opening vs ${closes} closing`,
        suggestion: 'Check for missing or extra curly braces',
      });
    }

    // Check for unclosed strings
    const singleQuotes = (content.match(/'/g) || []).length;
    if (singleQuotes % 2 !== 0) {
      result.addCheck(`css:quotes:${relPath}`, false, {
        file: relPath,
        severity: 'warning',
        message: 'Odd number of single quotes — possible unclosed string',
        suggestion: 'Check for unclosed quote marks',
      });
    }
  }

  _checkHtmlSyntax(file, result, projectRoot) {
    const relPath = path.relative(projectRoot, file);
    const content = fs.readFileSync(file, 'utf-8');

    // Check for doctype
    if (!content.trim().toLowerCase().startsWith('<!doctype')) {
      result.addCheck(`html:doctype:${relPath}`, false, {
        file: relPath,
        severity: 'warning',
        message: 'Missing <!DOCTYPE html> declaration',
        suggestion: 'Add <!DOCTYPE html> at the start of the file',
      });
    }

    // Check for unclosed important tags
    const importantTags = ['html', 'head', 'body'];
    for (const tag of importantTags) {
      const openCount = (content.match(new RegExp(`<${tag}[\\s>]`, 'gi')) || []).length;
      const closeCount = (content.match(new RegExp(`</${tag}>`, 'gi')) || []).length;
      if (openCount > closeCount) {
        result.addCheck(`html:unclosed:${tag}:${relPath}`, false, {
          file: relPath,
          severity: 'error',
          message: `Unclosed <${tag}> tag`,
          suggestion: `Add closing </${tag}> tag`,
        });
      }
    }
  }

  async _checkTypeScript(projectRoot, result) {
    // Discover every tsconfig.json in the workspace (depth-limited so we
    // don't walk node_modules). Then run tsc only in directories where
    // the tsconfig is "real" — i.e. has compilerOptions configured. Stub
    // tsconfigs at monorepo roots (Crontech, Turborepo, etc.) often
    // exist only as `extends`-only or empty-shell configs; running
    // `npx tsc` against them produces TS6142 "jsx not set" / TS6053 "no
    // inputs found" noise that drowns out real findings.
    const tscDirs = this._discoverRealTsconfigs(projectRoot);

    // Pre-push / fast-mode short-circuit. Customers run gatetest from the
    // pre-push hook (advisory; should never block past ~30s). On a real
    // monorepo with N tsconfigs and a slow `npx tsc --noEmit`, the
    // serial loop below was hanging the hook for minutes — exact
    // observed in Crontech with N=4 tsconfigs × 60s tsc each = 4-min
    // wedge. GATETEST_FAST=1 (set by the shipped pre-push hook in
    // .husky/pre-push) skips this whole block; full scans on CI still
    // run it.
    if (process.env.GATETEST_FAST === '1' || process.env.GATETEST_SKIP_TSC === '1') {
      result.addCheck('typescript-strict', true, {
        message: 'tsc --noEmit skipped (GATETEST_FAST or GATETEST_SKIP_TSC set — runs in CI)',
        severity: 'info',
      });
      return;
    }

    let anyRan = false;
    let allPass = true;
    const allErrors = [];

    // Per-tsconfig timeout dropped from 120s to 60s. tsc legitimately
    // takes 30-60s on a real codebase; longer than that = something is
    // wedged (file-watch loop, infinite include glob, TS panic). 60s is
    // the honest "we'll wait but won't hang you" — combined with the
    // GATETEST_FAST short-circuit above, the pre-push hook stays under
    // its advisory ~30s budget. CI runs the full uncapped gate.
    // Configurable via GATETEST_TSC_TIMEOUT_MS for environments that
    // genuinely need longer (e.g. cold cache + huge codebase).
    const TSC_TIMEOUT_MS = Number(process.env.GATETEST_TSC_TIMEOUT_MS) || 60000;

    // Note: _exec uses execSync, so a Promise.all wrapper around tscDirs
    // wouldn't actually parallelise. Keeping serial — the real win
    // is the GATETEST_FAST skip above + the 120s→60s per-dir cap.
    for (const dir of tscDirs) {
      anyRan = true;
      const { exitCode, stdout, stderr } = this._exec('npx tsc --noEmit 2>&1', {
        cwd: dir,
        timeout: TSC_TIMEOUT_MS,
      });
      if (exitCode !== 0) {
        allPass = false;
        const output = stdout + stderr;
        const errors = output.split('\n').filter(l => l.includes('error TS'));
        allErrors.push(...errors);
      }
    }

    if (!anyRan) {
      result.addCheck('typescript-strict', true, { message: 'No real tsconfig.json found (stub configs without compilerOptions are skipped)', severity: 'info' });
    } else if (allPass) {
      result.addCheck('typescript-strict', true);
    } else {
      result.addCheck('typescript-strict', false, {
        message: `${allErrors.length} TypeScript error(s)`,
        details: allErrors.slice(0, 10),
        suggestion: 'Run "npx tsc --noEmit" to see all errors',
      });
    }
  }

  /**
   * Discover directories containing a "real" tsconfig.json — one that
   * sets `compilerOptions` (with at least one of jsx / target / module /
   * lib). Stub configs (empty, extends-only, or missing compilerOptions)
   * are deliberately skipped because running tsc against them produces
   * noise that obscures real findings.
   *
   * Walks subdirectories one and two levels deep to cover monorepo
   * patterns (apps/web, apps/api, packages/*, services/*) without
   * descending into node_modules / build output.
   */
  _discoverRealTsconfigs(projectRoot) {
    const found = new Set();
    const skip = new Set([
      'node_modules', '.git', 'dist', 'build', 'coverage',
      '.next', '.nuxt', '.svelte-kit', '.output', '.vercel', '.turbo',
      '.gatetest', '.claude', 'out', 'vendor', '__pycache__',
    ]);

    const isRealConfig = (configPath) => {
      try {
        const raw = fs.readFileSync(configPath, 'utf-8');
        // Strip block + line comments (tsconfig is JSONC).
        const stripped = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
        const cfg = JSON.parse(stripped);
        const co = cfg && cfg.compilerOptions;
        if (!co || typeof co !== 'object') return false;
        // A real config sets at least one of these. Stub configs that
        // only exist to extend a base get filtered out.
        return Boolean(co.target || co.module || co.jsx || co.lib || co.outDir || co.rootDir);
      } catch { return false; }
    };

    const visit = (dir, depth) => {
      if (depth > 2) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

      const tsconfigPath = path.join(dir, 'tsconfig.json');
      if (fs.existsSync(tsconfigPath) && isRealConfig(tsconfigPath)) {
        found.add(dir);
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (skip.has(entry.name)) continue;
        if (entry.name.startsWith('.')) continue; // .claude, .git already in skip; this catches others
        visit(path.join(dir, entry.name), depth + 1);
      }
    };

    visit(projectRoot, 0);
    return [...found];
  }

  _checkImportResolution(projectRoot, jsFiles, result) {
    let unresolvedCount = 0;
    const maxReports = 10;

    for (const file of jsFiles) {
      const relPath = path.relative(projectRoot, file);
      const raw = fs.readFileSync(file, 'utf-8');
      const dir = path.dirname(file);

      // Strip line comments and block comments before scanning to avoid
      // flagging require() calls that appear inside comment examples.
      // Also strip string literals to avoid false positives in template
      // strings and test fixtures.
      const content = this._stripCommentsAndStrings(raw);

      // Match require() calls with relative paths
      const requireRegex = /require\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g;
      let match;
      while ((match = requireRegex.exec(content)) !== null) {
        const importPath = match[1];
        const resolved = this._resolveImport(dir, importPath);
        if (!resolved) {
          unresolvedCount++;
          if (unresolvedCount <= maxReports) {
            result.addCheck(`syntax:import:${relPath}:${importPath}`, false, {
              file: relPath,
              severity: 'error',
              message: `Unresolved import: require('${importPath}')`,
              suggestion: `Check that the file exists: ${importPath}`,
            });
          }
        }
      }
    }

    if (unresolvedCount === 0) {
      result.addCheck('syntax:imports', true, { severity: 'info' });
    } else if (unresolvedCount > maxReports) {
      result.addCheck('syntax:imports-truncated', true, {
        severity: 'info',
        message: `${unresolvedCount - maxReports} more unresolved imports not shown`,
      });
    }
  }

  _stripCommentsAndStrings(source) {
    // Strip block comments, line comments, template literals, and string
    // literals so that pattern-matching code and test fixtures don't
    // produce false positives.
    let out = '';
    let i = 0;
    while (i < source.length) {
      // Block comment
      if (source[i] === '/' && source[i + 1] === '*') {
        while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
        i += 2;
        continue;
      }
      // Line comment
      if (source[i] === '/' && source[i + 1] === '/') {
        while (i < source.length && source[i] !== '\n') i++;
        continue;
      }
      // Template literal
      if (source[i] === '`') {
        i++;
        let depth = 1;
        while (i < source.length && depth > 0) {
          if (source[i] === '\\') { i += 2; continue; }
          if (source[i] === '`') depth--;
          i++;
        }
        continue;
      }
      // Single-quoted string
      if (source[i] === "'") {
        i++;
        while (i < source.length && source[i] !== "'" && source[i] !== '\n') {
          if (source[i] === '\\') i++;
          i++;
        }
        i++;
        continue;
      }
      // Double-quoted string
      if (source[i] === '"') {
        i++;
        while (i < source.length && source[i] !== '"' && source[i] !== '\n') {
          if (source[i] === '\\') i++;
          i++;
        }
        i++;
        continue;
      }
      out += source[i];
      i++;
    }
    return out;
  }

  _resolveImport(dir, importPath) {
    const extensions = ['', '.js', '.ts', '.tsx', '.jsx', '.json', '/index.js', '/index.ts'];
    for (const ext of extensions) {
      const resolved = path.resolve(dir, importPath + ext);
      if (fs.existsSync(resolved)) return resolved;
    }
    return null;
  }

  _checkDanglingPatterns(projectRoot, files, result) {
    for (const file of files) {
      const relPath = path.relative(projectRoot, file);
      const content = fs.readFileSync(file, 'utf-8');

      // Unclosed template literals
      const backticks = (content.match(/`/g) || []).length;
      if (backticks % 2 !== 0) {
        result.addCheck(`syntax:template-literal:${relPath}`, false, {
          file: relPath,
          severity: 'warning',
          message: 'Odd number of backticks — possible unclosed template literal',
          suggestion: 'Check for unclosed template literals',
        });
      }

      // Unbalanced parentheses (rough check, skip strings)
      const stripped = content.replace(/['"`](?:[^'"`\\]|\\.)*['"`]/g, '""');
      const parens = (stripped.match(/\(/g) || []).length - (stripped.match(/\)/g) || []).length;
      if (Math.abs(parens) > 2) {
        result.addCheck(`syntax:parens:${relPath}`, false, {
          file: relPath,
          severity: 'warning',
          message: `Parenthesis imbalance detected (off by ${Math.abs(parens)})`,
          suggestion: 'Check for unclosed or extra parentheses',
        });
      }
    }
  }
}

module.exports = SyntaxModule;
