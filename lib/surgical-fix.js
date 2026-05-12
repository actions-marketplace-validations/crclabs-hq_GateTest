/**
 * Surgical-diff fix mode.
 *
 * Lets Claude fix a finding without ever seeing or rewriting unrelated
 * parts of the file. Earlier "rewrite the whole file" mode is the
 * dangerous default everyone else ships — Claude reformats imports,
 * touches unrelated functions, drops trailing commas, mutates
 * whitespace, and the diff balloons. Surgical mode hands Claude a
 * window (default +/- 20 lines around the offending line), takes back
 * a same-shape replacement, and splices it into the original. Anything
 * outside the window is byte-identical by construction, and we
 * validate that post-splice as a belt-and-braces check.
 *
 * Pure JS, CommonJS, Node stdlib only — directly testable under
 * `node --test` without any transform. Style matches
 * `fix-attempt-loop.js`.
 *
 * Five exports:
 *   1. extractIssueContext  — pull the slice for Claude
 *   2. buildSurgicalPrompt  — render the prompt
 *   3. parseReplacementBlock — strip fences + line-number prefixes
 *   4. spliceReplacement    — paste the replacement back into the original
 *   5. validateSurgicalFix  — confirm nothing outside the window moved
 */

/**
 * Detect the line ending of a string. Returns "\r\n" if any CRLF is
 * present, "\n" otherwise.
 *
 * @param {string} content
 * @returns {string}
 */
function detectLineEnding(content) {
  return content.indexOf("\r\n") >= 0 ? "\r\n" : "\n";
}

/**
 * Pull a +/- contextLines window around a 1-indexed line number.
 *
 * @param {string} fileContent
 * @param {number} lineNumber  1-indexed.
 * @param {number} [contextLines=20]
 * @returns {{
 *   slice: string,
 *   startLine: number,
 *   endLine: number,
 *   totalLines: number,
 *   lineEnding: string
 * }}
 */
function extractIssueContext(fileContent, lineNumber, contextLines = 20) {
  const lineEnding = detectLineEnding(fileContent);
  const lines = fileContent.split(lineEnding);
  const totalLines = lines.length;

  const startLine = Math.max(1, lineNumber - contextLines);
  const endLine = Math.min(totalLines, lineNumber + contextLines);

  // 1-indexed inclusive -> 0-indexed slice
  const sliceLines = lines.slice(startLine - 1, endLine);
  const slice = sliceLines.join(lineEnding);

  return { slice, startLine, endLine, totalLines, lineEnding };
}

/**
 * Build the prompt Claude sees for a surgical fix. Demands ONLY the
 * replacement block back — no fences, no commentary, same shape.
 *
 * @param {Object} opts
 * @param {string} opts.filePath
 * @param {string} opts.slice
 * @param {number} opts.startLine
 * @param {number} opts.endLine
 * @param {string[]} opts.issues
 * @returns {string}
 */
function buildSurgicalPrompt({ filePath, slice, startLine, endLine, issues }) {
  const sliceLines = slice.split(/\r?\n/);
  const numberedSlice = sliceLines
    .map((line, idx) => `${startLine + idx}: ${line}`)
    .join("\n");

  const issueList = (issues || [])
    .map((issue, idx) => `${idx + 1}. ${issue}`)
    .join("\n");

  return [
    `You are performing a SURGICAL fix on a single window of a source file.`,
    ``,
    `File: ${filePath}`,
    `Window: lines ${startLine} to ${endLine} (inclusive, 1-indexed).`,
    ``,
    `Issues to fix in this window:`,
    issueList || "(none listed)",
    ``,
    `Window content (each line prefixed with its 1-indexed line number):`,
    numberedSlice,
    ``,
    `RESPONSE RULES — read carefully:`,
    `- Return ONLY the replacement block for lines ${startLine}..${endLine}.`,
    `- Do NOT include markdown code fences (no \`\`\`js, no \`\`\`).`,
    `- Do NOT include any explanation, commentary, or preamble.`,
    `- Do NOT include line-number prefixes — return raw source only.`,
    `- Keep the same line count, plus or minus a few lines.`,
    `- Do NOT modify code outside the listed issues.`,
    `- Preserve indentation and whitespace style of the surrounding code.`,
    ``,
    `Replacement block:`,
  ].join("\n");
}

/**
 * Strip Claude's typical wrapping artefacts from a replacement block:
 * surrounding markdown code fences, per-line `42: ` line-number
 * prefixes, and leading/trailing blank lines. Internal whitespace is
 * preserved exactly.
 *
 * @param {string} claudeResponse
 * @returns {string}
 */
function parseReplacementBlock(claudeResponse) {
  if (typeof claudeResponse !== "string") return "";

  let lines = claudeResponse.split(/\r?\n/);

  // Strip a leading fence line: ```, ```js, ```typescript, etc.
  if (lines.length > 0 && /^\s*```[a-zA-Z0-9_-]*\s*$/.test(lines[0])) {
    lines = lines.slice(1);
  }
  // Strip a trailing fence line.
  if (lines.length > 0 && /^\s*```\s*$/.test(lines[lines.length - 1])) {
    lines = lines.slice(0, -1);
  }

  // Strip leading "42: " / "  42: " line-number prefixes per line.
  lines = lines.map((line) => line.replace(/^\s*\d+:\s?/, ""));

  // Trim leading/trailing blank lines (preserve internal blanks).
  while (lines.length > 0 && lines[0].trim() === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();

  return lines.join("\n");
}

/**
 * Splice a replacement block into the original content, replacing
 * lines startLine..endLine (1-indexed inclusive). Trailing newline is
 * preserved if and only if the original had one.
 *
 * @param {string} originalContent
 * @param {number} startLine  1-indexed inclusive.
 * @param {number} endLine    1-indexed inclusive.
 * @param {string} replacement
 * @param {string} [lineEnding="\n"]
 * @returns {string}
 */
function spliceReplacement(originalContent, startLine, endLine, replacement, lineEnding = "\n") {
  const hadTrailingNewline = originalContent.endsWith(lineEnding);

  // If the original ends with a newline, splitting yields a trailing
  // empty element. Strip it for the splice math, restore it after.
  let originalLines = originalContent.split(lineEnding);
  let hadSplitTrailingEmpty = false;
  if (hadTrailingNewline && originalLines.length > 0 && originalLines[originalLines.length - 1] === "") {
    originalLines = originalLines.slice(0, -1);
    hadSplitTrailingEmpty = true;
  }

  // Replacement may itself have been split with "\n" by the parser —
  // accept either, and re-split on the target line ending.
  const replacementLines = replacement.split(lineEnding === "\r\n" ? /\r?\n/ : "\n");

  const before = originalLines.slice(0, startLine - 1);
  const after = originalLines.slice(endLine);
  const rejoined = [...before, ...replacementLines, ...after].join(lineEnding);

  return hadSplitTrailingEmpty ? rejoined + lineEnding : rejoined;
}

/**
 * Confirm that everything OUTSIDE the splice window is byte-identical
 * between the original and fixed content. Lines before startLine must
 * match exactly. Lines after endLine in the original must match the
 * corresponding tail of the fixed file (offset by however much the
 * replacement grew or shrank).
 *
 * @param {Object} opts
 * @param {string} opts.originalContent
 * @param {string} opts.fixedContent
 * @param {number} opts.startLine  1-indexed inclusive.
 * @param {number} opts.endLine    1-indexed inclusive.
 * @param {string} [opts.lineEnding="\n"]
 * @returns {{ ok: boolean, reason?: string, mutatedLines?: number[] }}
 */
function validateSurgicalFix({ originalContent, fixedContent, startLine, endLine, lineEnding = "\n" }) {
  const origLines = originalContent.split(lineEnding);
  const fixedLines = fixedContent.split(lineEnding);

  // Lines before startLine: indices 0..startLine-2 must match.
  const beforeCount = startLine - 1;
  const mutatedBefore = [];
  for (let i = 0; i < beforeCount; i++) {
    if (origLines[i] !== fixedLines[i]) {
      mutatedBefore.push(i + 1); // report 1-indexed
    }
  }
  if (mutatedBefore.length > 0) {
    return {
      ok: false,
      reason: `Lines before splice window (${startLine}) were modified`,
      mutatedLines: mutatedBefore,
    };
  }

  // Lines after endLine in original: original indices endLine..end.
  // Corresponding fixed indices are at offset (fixedLines.length - origLines.length).
  const offset = fixedLines.length - origLines.length;
  const mutatedAfter = [];
  for (let i = endLine; i < origLines.length; i++) {
    const fixedIdx = i + offset;
    if (fixedIdx < 0 || fixedIdx >= fixedLines.length) {
      mutatedAfter.push(i + 1);
      continue;
    }
    if (origLines[i] !== fixedLines[fixedIdx]) {
      mutatedAfter.push(i + 1);
    }
  }
  if (mutatedAfter.length > 0) {
    return {
      ok: false,
      reason: `Lines after splice window (${endLine}) were modified`,
      mutatedLines: mutatedAfter,
    };
  }

  return { ok: true };
}

module.exports = {
  extractIssueContext,
  buildSurgicalPrompt,
  parseReplacementBlock,
  spliceReplacement,
  validateSurgicalFix,
};
