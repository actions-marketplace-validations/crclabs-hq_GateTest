/**
 * Duplicate Code Detector — finds copy-pasted blocks that should be extracted.
 *
 * Copy-pasted code is a debt multiplier: every bug must be fixed N times,
 * every security patch applied N times. This module finds blocks of 6+
 * identical (or near-identical) lines appearing in two or more files.
 *
 * Algorithm:
 *   1. Normalise each line (strip leading whitespace, collapse strings to
 *      placeholders) to reduce noise from variable renames.
 *   2. Use a rolling hash (Rabin-Karp style) over windows of 6+ lines.
 *   3. Collect hashes → file locations.
 *   4. Flag any hash appearing in 2+ distinct files.
 *
 * Exclusions: test files, generated files (*.gen.*, *.d.ts), lock files,
 * build output, vendored code.
 *
 * Fix: AI extracts the duplicated block into a shared utility.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const BaseModule    = require('./base-module');
const { makeAutoFix } = require('../core/ai-fix-engine');

const WINDOW_SIZE    = 6;    // minimum duplicate block lines
const MAX_DUPES_REPORT = 10; // cap reported duplicates to avoid noise

// ─── normalisation ─────────────────────────────────────────────────────────

function normaliseLine(line) {
  return line
    .trim()
    // Collapse string literals
    .replace(/'[^']*'/g, "'__STR__'")
    .replace(/"[^"]*"/g, '"__STR__"')
    .replace(/`[^`]*`/g, '`__STR__`')
    // Collapse numbers
    .replace(/\b\d+(\.\d+)?\b/g, '__NUM__')
    // Remove comments
    .replace(/\/\/.*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .trim();
}

function shouldSkipFile(rel) {
  const lower = rel.toLowerCase();
  return (
    lower.includes('node_modules') ||
    lower.includes('.next') ||
    lower.includes('dist/') ||
    lower.includes('build/') ||
    lower.includes('vendor/') ||
    lower.includes('coverage/') ||
    lower.includes('.d.ts') ||
    lower.includes('.gen.') ||
    lower.includes('.generated.') ||
    lower.includes('.min.') ||
    lower.includes('test') ||
    lower.includes('spec') ||
    lower.includes('fixture') ||
    lower.includes('__tests__') ||
    lower.includes('migrations/') || // SQL migrations are often similar
    lower.endsWith('.lock')
  );
}

// Simple rolling hash: FNV-1a over the normalised window
function hashWindow(lines) {
  let hash = 0x811c9dc5;
  for (const line of lines) {
    for (let i = 0; i < line.length; i++) {
      hash ^= line.charCodeAt(i);
      hash = (hash * 0x01000193) >>> 0;
    }
    hash ^= 0x0a; // newline separator
  }
  return hash.toString(16);
}

// ─── module ────────────────────────────────────────────────────────────────

class DuplicateCode extends BaseModule {
  constructor() {
    super('duplicateCode', 'Duplicate Code Detector — finds copy-pasted blocks that should be extracted into utilities');
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;
    const extensions  = ['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs', '.py', '.rb', '.go'];
    const files       = this._collectFiles(projectRoot, extensions);

    // hash → [{ file, startLine, endLine, snippet }]
    const hashMap = new Map();

    for (const file of files) {
      const rel = path.relative(projectRoot, file);
      if (shouldSkipFile(rel)) continue;

      let content;
      try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }

      const rawLines = content.split('\n');
      const normLines = rawLines.map(normaliseLine);

      // Skip trivially short files
      if (normLines.length < WINDOW_SIZE) continue;

      // Slide the window
      for (let i = 0; i <= normLines.length - WINDOW_SIZE; i++) {
        const window = normLines.slice(i, i + WINDOW_SIZE);

        // Skip windows that are mostly empty / comment lines
        const meaningful = window.filter(l => l.length > 3).length;
        if (meaningful < WINDOW_SIZE * 0.6) continue;

        // Skip windows that are all the same line (e.g. console.log loops)
        const unique = new Set(window).size;
        if (unique < 3) continue;

        const hash = hashWindow(window);
        if (!hashMap.has(hash)) hashMap.set(hash, []);

        const locs = hashMap.get(hash);
        // Don't add duplicate locations for the same file+line (overlap prevention)
        const alreadyHere = locs.some(l => l.file === rel && Math.abs(l.startLine - (i + 1)) < WINDOW_SIZE);
        if (!alreadyHere) {
          locs.push({
            file,
            relFile: rel,
            startLine: i + 1,
            endLine: i + WINDOW_SIZE,
            snippet: rawLines.slice(i, i + WINDOW_SIZE).join('\n'),
          });
        }
      }
    }

    // Collect cross-file duplicates
    const crossFileDupes = [];
    for (const [, locs] of hashMap) {
      const distinctFiles = new Set(locs.map(l => l.relFile));
      if (distinctFiles.size >= 2) {
        crossFileDupes.push(locs);
      }
    }

    if (crossFileDupes.length === 0) {
      result.addCheck('duplicate-code:clean', true, {
        severity: 'info',
        message: `No duplicate code blocks (${WINDOW_SIZE}+ lines) found across source files`,
      });
      return;
    }

    const reported = crossFileDupes.slice(0, MAX_DUPES_REPORT);
    for (const locs of reported) {
      const fileList = [...new Set(locs.map(l => `${l.relFile}:${l.startLine}`))].join(', ');
      const primaryLoc = locs[0];

      result.addCheck(`duplicate-code:${primaryLoc.relFile}:${primaryLoc.startLine}`, false, {
        severity: 'warning',
        message: `${WINDOW_SIZE}+ line block duplicated in ${new Set(locs.map(l => l.relFile)).size} files: ${fileList}`,
        file: primaryLoc.relFile,
        line: primaryLoc.startLine,
        fix: `Extract this block into a shared utility function. Locations: ${fileList}`,
        autoFix: makeAutoFix(
          primaryLoc.file,
          'duplicate-code',
          `This block is duplicated in ${new Set(locs.map(l => l.relFile)).size} files: ${fileList}`,
          primaryLoc.startLine,
          `Extract lines ${primaryLoc.startLine}-${primaryLoc.endLine} into a shared utility function and update all ${locs.length} call sites`
        ),
      });
    }

    if (crossFileDupes.length > MAX_DUPES_REPORT) {
      result.addCheck('duplicate-code:truncated', true, {
        severity: 'info',
        message: `${crossFileDupes.length - MAX_DUPES_REPORT} more duplicate blocks found — showing first ${MAX_DUPES_REPORT}`,
      });
    }
  }
}

module.exports = DuplicateCode;
