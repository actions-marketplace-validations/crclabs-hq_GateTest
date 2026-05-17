/**
 * Env-File Integrity Module — scans .env, .env.*, .env.example files for:
 *   1. Non-ASCII / Unicode leading bytes on variable lines (U+2248, BOM, etc.)
 *   2. Smart / curly quotes in values ('...' "..." « »)
 *   3. Trailing whitespace on value lines
 *   4. Unpaired quotes in values
 *   5. Variable names with invalid characters
 * Provides auto-fix suggestions.
 */

const BaseModule = require('./base-module');
const fs   = require('fs');
const path = require('path');

const SMART_QUOTE_RE   = /[‘’“”«»‹›`]/;
const NON_ASCII_LEAD   = /^[^\x00-\x7F]/;
const TRAILING_SPACE   = /[^\S\n]\r?$/;
const VALID_VAR_NAME   = /^[A-Za-z_][A-Za-z0-9_]*$/;
const COMMENT_LINE     = /^\s*#/;
const BLANK_LINE       = /^\s*$/;
const CONTINUATION     = /\\$/;

class EnvIntegrityModule extends BaseModule {
  constructor() { super('envIntegrity', 'Env-File Integrity Linter'); }

  async run(result, config) {
    const root = config.projectRoot;
    const envFiles = this._findEnvFiles(root);

    if (envFiles.length === 0) {
      result.addCheck('env-integrity-no-files', true, { severity: 'info', fix: 'No .env files found to lint' });
      return;
    }

    let totalIssues = 0;
    for (const file of envFiles) {
      const count = this._lintFile(file, path.relative(root, file), result);
      totalIssues += count;
    }

    if (totalIssues === 0) {
      result.addCheck('env-integrity-clean', true, { severity: 'info', fix: `${envFiles.length} env file(s) passed integrity checks` });
    }
  }

  _lintFile(file, rel, result) {
    let content;
    try {
      const raw = fs.readFileSync(file);

      // Check for BOM (EF BB BF) at file start
      if (raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF) {
        result.addCheck(`env-bom:${rel}`, false, {
          severity: 'error',
          file,
          fix: `${rel}: File has UTF-8 BOM at start — many parsers will include the BOM in the first variable name. Remove with: sed -i '1s/^\\xef\\xbb\\xbf//' ${rel}`,
        });
      }
      content = raw.toString('utf8');
    } catch { return 0; }

    let issues = 0;
    const lines = content.split('\n');

    lines.forEach((line, idx) => {
      const lineNum = idx + 1;
      if (COMMENT_LINE.test(line) || BLANK_LINE.test(line) || CONTINUATION.test(line)) return;

      const eqIdx = line.indexOf('=');
      if (eqIdx === -1) return; // not a key=value line

      const varName = line.slice(0, eqIdx).trim();
      const value   = line.slice(eqIdx + 1);

      // 1. Non-ASCII leading byte on variable name
      if (NON_ASCII_LEAD.test(varName)) {
        const codePoint = varName.codePointAt(0).toString(16).padStart(4, '0').toUpperCase();
        result.addCheck(`env-non-ascii:${rel}:${lineNum}`, false, {
          severity: 'error',
          file,
          fix: `${rel}:${lineNum} — variable name starts with non-ASCII character U+${codePoint} (looks like "${varName[0]}" but is a Unicode lookalike). systemd/dotenv will silently ignore this line.\nFix: delete and retype the variable name using only ASCII characters.`,
        });
        issues++;
      }

      // 2. Invalid variable name characters
      if (varName && VALID_VAR_NAME.test(varName) === false && !NON_ASCII_LEAD.test(varName)) {
        result.addCheck(`env-invalid-name:${rel}:${lineNum}`, false, {
          severity: 'warning',
          file,
          fix: `${rel}:${lineNum} — variable name "${varName}" contains invalid characters. Use only [A-Za-z0-9_] starting with a letter or underscore.`,
        });
        issues++;
      }

      // 3. Smart / curly quotes in value
      if (SMART_QUOTE_RE.test(value)) {
        const chars = [...value].filter(c => SMART_QUOTE_RE.test(c)).map(c => `U+${c.codePointAt(0).toString(16).padStart(4, '0').toUpperCase()}`).join(', ');
        result.addCheck(`env-smart-quote:${rel}:${lineNum}`, false, {
          severity: 'error',
          file,
          fix: `${rel}:${lineNum} — value for ${varName} contains smart/curly quotes (${chars}). These look like normal quotes but are different characters — parsers will include them in the value.\nFix: retype the quotes using " or ' (ASCII).`,
        });
        issues++;
      }

      // 4. Trailing whitespace in value
      if (TRAILING_SPACE.test(value)) {
        result.addCheck(`env-trailing-space:${rel}:${lineNum}`, false, {
          severity: 'warning',
          file,
          fix: `${rel}:${lineNum} — value for ${varName} has trailing whitespace. Some parsers include it in the value, causing subtle mismatches.\nFix: remove trailing whitespace: sed -i 's/[[:space:]]*$//' ${rel}`,
        });
        issues++;
      }

      // 5. Unpaired quotes (value starts with " or ' but doesn't end with matching)
      const trimVal = value.trim();
      if ((trimVal.startsWith('"') && !trimVal.endsWith('"')) ||
          (trimVal.startsWith("'") && !trimVal.endsWith("'"))) {
        result.addCheck(`env-unpaired-quote:${rel}:${lineNum}`, false, {
          severity: 'warning',
          file,
          fix: `${rel}:${lineNum} — value for ${varName} has an unpaired quote. The parser may read beyond this line or misparse the value.`,
        });
        issues++;
      }
    });

    return issues;
  }

  _findEnvFiles(root) {
    const results = [];
    let entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return results; }

    for (const e of entries) {
      if (e.isDirectory()) continue;
      const name = e.name;
      // Match: .env, .env.local, .env.production, .env.example, .env.*.example, etc.
      if (/^\.env(\.|$)/.test(name) || name === '.env') {
        results.push(path.join(root, name));
      }
    }

    // Also scan one level deep (apps/web/.env, packages/api/.env, etc.)
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (['node_modules', '.git', '.claude', '.next', 'dist', 'build'].includes(e.name)) continue;
      const sub = path.join(root, e.name);
      try {
        for (const se of fs.readdirSync(sub, { withFileTypes: true })) {
          if (!se.isDirectory() && /^\.env(\.|$)/.test(se.name)) {
            results.push(path.join(sub, se.name));
          }
        }
      } catch { /* skip */ }
    }

    return results;
  }
}

module.exports = EnvIntegrityModule;
