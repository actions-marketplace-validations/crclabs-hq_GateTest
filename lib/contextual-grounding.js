/**
 * Contextual Grounding — injects the customer's own project conventions
 * into every Claude fix prompt so Claude stops suggesting fixes that
 * violate documented project patterns (e.g. "use Mongo" when the repo
 * uses Postgres, "use class components" when the repo uses functional).
 *
 * How it works:
 *   1. Look for well-known convention files in the repo (CLAUDE.md,
 *      AGENTS.md, ARCHITECTURE.md, .cursorrules, README.md, CONTRIBUTING.md).
 *   2. Excerpt the first maxBytesPerFile bytes of each one, with a
 *      cumulative cap of maxTotalBytes across all files.
 *   3. Render a Markdown header block that is prepended to the Claude prompt.
 *
 * Pure JS, CommonJS, Node stdlib only. Directly testable under
 * `node --test` without any transform. Style matches `lib/surgical-fix.js`.
 *
 * Five exports:
 *   1. KNOWN_CONVENTION_FILES — priority-ordered filenames to look for
 *   2. extractConventions      — find & excerpt from already-fetched contents
 *   3. formatGroundingHeader   — render the Markdown header block
 *   4. groundPrompt            — convenience: prepend header to base prompt
 *   5. summariseGrounding      — one-line human-readable summary
 */

'use strict';

const path = require('path');

/**
 * Convention files we look for, in priority order.
 * The first match in the repo wins for each name.
 *
 * @type {string[]}
 */
const KNOWN_CONVENTION_FILES = [
  'CLAUDE.md',        // project-specific Claude instructions — highest priority
  'AGENTS.md',        // Cursor / Claude project instructions
  'ARCHITECTURE.md',  // explicit architecture doc
  '.cursorrules',     // Cursor-style rules
  'README.md',        // generic project intro
  'CONTRIBUTING.md',  // dev guidelines
];

/**
 * Truncate a string to at most `maxBytes` bytes (UTF-8), breaking on
 * whitespace when possible so we don't cut mid-word.
 *
 * @param {string} text
 * @param {number} maxBytes
 * @returns {string}
 */
function truncateToBytes(text, maxBytes) {
  const buf = Buffer.from(text, 'utf-8');
  if (buf.length <= maxBytes) return text;

  // Slice the buffer at the byte limit.
  let sliced = buf.slice(0, maxBytes).toString('utf-8');

  // Trim any incomplete multi-byte sequence at the end (can happen when
  // maxBytes lands mid-codepoint). Buffer.toString already handles this,
  // but the replacement character U+FFFD can appear — strip it.
  sliced = sliced.replace(/�$/, '');

  // Try to break on the last whitespace to avoid cutting mid-word.
  const lastWs = sliced.search(/\s\S*$/);
  if (lastWs > 0) {
    sliced = sliced.slice(0, lastWs);
  }

  return sliced.trimEnd();
}

/**
 * Find and excerpt convention files from an already-fetched set of
 * file contents. Does NOT perform any network or filesystem calls.
 *
 * @param {Object} opts
 * @param {string[]}                          opts.files        — all paths in the repo
 * @param {Array<{path:string,content:string}>} opts.fileContents — files already fetched
 * @param {number}  [opts.maxBytesPerFile=2000] — hard cap per individual file
 * @param {number}  [opts.maxTotalBytes=8000]   — cumulative cap across all files
 * @returns {{
 *   found:      Array<{path:string, excerpt:string, bytes:number}>,
 *   totalBytes: number,
 *   omitted:    string[]
 * }}
 */
function extractConventions({
  files = [],
  fileContents = [],
  maxBytesPerFile = 2000,
  maxTotalBytes = 8000,
} = {}) {
  const found = [];
  const omitted = [];
  let totalBytes = 0;

  // Build a lookup: basename → first matching path entry in fileContents.
  // We prefer the shortest path (root-level wins over deep nesting) when
  // multiple files share the same basename, but "first match" is correct
  // for the stated spec ("first match wins").
  const contentMap = new Map();
  for (const fc of fileContents) {
    const base = path.basename(fc.path);
    if (!contentMap.has(base)) {
      contentMap.set(base, fc);
    }
  }

  for (const name of KNOWN_CONVENTION_FILES) {
    if (!contentMap.has(name)) continue;

    const fc = contentMap.get(name);
    const content = fc.content || '';
    if (!content) continue;

    const excerpt = truncateToBytes(content, maxBytesPerFile);
    const bytes = Buffer.byteLength(excerpt, 'utf-8');

    if (totalBytes + bytes > maxTotalBytes) {
      omitted.push(name);
      continue;
    }

    found.push({ path: fc.path, excerpt, bytes });
    totalBytes += bytes;
  }

  return { found, totalBytes, omitted };
}

/**
 * Render the grounding header that gets prepended to the Claude prompt.
 *
 * @param {Array<{path:string, excerpt:string, bytes:number}>} found
 * @returns {string}  — empty string when `found` is empty
 */
function formatGroundingHeader(found) {
  if (!found || found.length === 0) return '';

  const sections = found.map((f) => {
    const heading = path.basename(f.path);
    return `### ${heading}\n${f.excerpt}`;
  });

  return [
    '## Project Conventions (from this repo)',
    '',
    'The following project documentation describes conventions you MUST follow.',
    'Do NOT suggest patterns, frameworks, or libraries that contradict these.',
    '',
    sections.join('\n\n'),
    '',
    '---',
    '',
  ].join('\n');
}

/**
 * Prepend the grounding header to a base prompt.
 *
 * @param {Object} opts
 * @param {string} opts.basePrompt
 * @param {string} opts.conventionsHeader
 * @returns {string}
 */
function groundPrompt({ basePrompt, conventionsHeader }) {
  return conventionsHeader ? conventionsHeader + basePrompt : basePrompt;
}

/**
 * One-line human-readable summary for the API response and PR body.
 *
 * @param {{ found: Array<{path:string,bytes:number}>, totalBytes:number, omitted:string[] }} extractResult
 * @returns {string}
 */
function summariseGrounding(extractResult) {
  const { found = [], totalBytes = 0, omitted = [] } = extractResult || {};

  if (found.length === 0) {
    return 'grounded: no convention files found';
  }

  const fileList = found
    .map((f) => `${path.basename(f.path)} (${(f.bytes / 1024).toFixed(1)}KB)`)
    .join(', ');

  const totalKb = (totalBytes / 1024).toFixed(1);
  let summary = `grounded: ${fileList} — ${totalKb}KB total`;

  if (omitted.length > 0) {
    summary += ` — ${omitted.length} file${omitted.length === 1 ? '' : 's'} skipped (budget)`;
  }

  return summary;
}

module.exports = {
  KNOWN_CONVENTION_FILES,
  extractConventions,
  formatGroundingHeader,
  groundPrompt,
  summariseGrounding,
};
