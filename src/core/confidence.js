/**
 * Confidence scoring for findings.
 *
 * Every finding gets a CONFIDENCE score from 0.0 to 1.0 in addition to
 * its severity (`error` / `warning` / `info`). The score is computed
 * from context signals (path, comment-state, surrounding text, etc).
 *
 * The gate's BLOCKING decision is now:
 *   severity === 'error' && confidence >= BLOCK_THRESHOLD
 *
 * Low-confidence error findings still appear in the report — they just
 * don't block the gate. They count toward `softErrorCount` so the
 * summary shows e.g. "3 errors / 1 soft-error (low confidence)".
 *
 * The score is a product of multiplier signals. A finding starts at
 * `DEFAULT_CONFIDENCE` (1.0). Each signal that fires multiplies the
 * score by its multiplier (0.0..1.0). The final confidence is bounded
 * to `[0, 1]`. If no signal fires, the score is 1.0.
 *
 * Per-rule overrides: some rules legitimately fire on test files
 * (flakyTests, prSize) and shouldn't be penalised by the test-path
 * signal. Callers pass `ruleOverrides` keyed by `ruleKey`.
 *
 * Pure functions, no I/O. Backwards-compatible: modules that don't
 * pass `sourceText` still get a path-only score.
 */

'use strict';

const DEFAULT_CONFIDENCE = 1.0;
const BLOCK_THRESHOLD = 0.7;

// Per-rule overrides shipped as defaults. The most obvious cases where
// firing on a test file is the WHOLE POINT of the rule.
const DEFAULT_RULE_OVERRIDES = Object.freeze({
  // flakyTests scans test files BY DEFINITION
  flakyTests: { ignoreTestPath: true, ignoreFixturePath: true },
  // prSize scans the whole diff; test files are part of the diff
  prSize: { ignoreTestPath: true, ignoreFixturePath: true },
  // Test-coverage gate cares about test files
  unitTests: { ignoreTestPath: true },
  integrationTests: { ignoreTestPath: true },
  // Documentation module is supposed to scan .md files
  documentation: { ignoreDocFile: true },
  // links module scans .md files for broken links
  links: { ignoreDocFile: true },
});

// ─── individual signal functions ─────────────────────────────────────────────

/**
 * Doc file: .md / .mdx / .rst → 0.3
 */
function isDocFile(filePath) {
  if (!filePath) return null;
  const p = String(filePath).toLowerCase().replace(/\\/g, '/');
  if (/\.(md|mdx|rst)$/.test(p)) {
    return { multiplier: 0.3, reason: 'doc file' };
  }
  return null;
}

/**
 * Test file: /tests?/, *.test.*, *.spec.*, __tests__/ → 0.6
 */
function isTestFile(filePath) {
  if (!filePath) return null;
  const p = String(filePath).replace(/\\/g, '/');
  if (
    /(?:^|\/)tests?\//i.test(p) ||
    /(?:^|\/)__tests__\//i.test(p) ||
    /\.test\.[A-Za-z0-9]+$/.test(p) ||
    /\.spec\.[A-Za-z0-9]+$/.test(p)
  ) {
    return { multiplier: 0.6, reason: 'test file' };
  }
  return null;
}

/**
 * Fixture file: /fixtures?/, /__fixtures__/, /test-data/, /mocks?/,
 * /stubs?/ → 0.4
 */
function isFixtureFile(filePath) {
  if (!filePath) return null;
  const p = String(filePath).replace(/\\/g, '/');
  if (
    /(?:^|\/)fixtures?\//i.test(p) ||
    /(?:^|\/)__fixtures__\//i.test(p) ||
    /(?:^|\/)test-data\//i.test(p) ||
    /(?:^|\/)mocks?\//i.test(p) ||
    /(?:^|\/)stubs?\//i.test(p)
  ) {
    return { multiplier: 0.4, reason: 'fixture file' };
  }
  return null;
}

/**
 * Example data file: example*, sample*, demo*, /docs/ → 0.4
 */
function isExampleDataFile(filePath) {
  if (!filePath) return null;
  const p = String(filePath).replace(/\\/g, '/').toLowerCase();
  if (/(?:^|\/)docs?\//i.test(p)) {
    return { multiplier: 0.4, reason: 'example data' };
  }
  // Directory-style match: examples/, samples/, demos/
  if (/(?:^|\/)(?:example|sample|demo)s?\//i.test(p)) {
    return { multiplier: 0.4, reason: 'example data' };
  }
  // Basename-style match: example*, sample*, demo*
  const base = p.split('/').pop() || '';
  if (/^(example|sample|demo)/i.test(base)) {
    return { multiplier: 0.4, reason: 'example data' };
  }
  return null;
}

/**
 * Vendor / build output → 0.1 (essentially "don't block on this")
 */
function isHomeworkDir(filePath) {
  if (!filePath) return null;
  const p = String(filePath).replace(/\\/g, '/');
  if (
    /(?:^|\/)node_modules\//.test(p) ||
    /(?:^|\/)dist\//.test(p) ||
    /(?:^|\/)build\//.test(p) ||
    /(?:^|\/)\.next\//.test(p) ||
    /(?:^|\/)coverage\//.test(p) ||
    /(?:^|\/)vendor\//.test(p)
  ) {
    return { multiplier: 0.1, reason: 'vendor / build output' };
  }
  return null;
}

/**
 * Inside block comment: line is between `/*` and `*\/`.
 *
 * Walks the source forward from line 0 to `line` (1-indexed) tracking
 * block-comment state. Returns multiplier 0.2 if the target line is
 * inside an unclosed block comment.
 */
function isInsideBlockComment(sourceText, line) {
  if (!sourceText || !line || line < 1) return null;
  const lines = sourceText.split('\n');
  if (line > lines.length) return null;

  let inBlock = false;
  // Scan up to (but not including) the target line — we want the state
  // ENTERING the target line.
  for (let i = 0; i < line - 1; i += 1) {
    const s = lines[i];
    let j = 0;
    while (j < s.length) {
      if (!inBlock && s[j] === '/' && s[j + 1] === '*') {
        inBlock = true;
        j += 2;
        continue;
      }
      if (inBlock && s[j] === '*' && s[j + 1] === '/') {
        inBlock = false;
        j += 2;
        continue;
      }
      j += 1;
    }
  }

  if (inBlock) {
    return { multiplier: 0.2, reason: 'inside block comment' };
  }

  // Also flag if the line itself is a single-line block comment:
  // /* ... */ on one line
  const target = lines[line - 1] || '';
  if (/^\s*\/\*[\s\S]*\*\//.test(target) && !/[A-Za-z0-9_]\s*=\s*['"`]/.test(target)) {
    return { multiplier: 0.2, reason: 'inside block comment' };
  }
  // Line-comment-only line (//-prefixed)
  if (/^\s*\/\//.test(target)) {
    return { multiplier: 0.2, reason: 'inside line comment' };
  }
  return null;
}

/**
 * Inside string literal: finding position is inside a `"`/`'`/backtick
 * string on `line`. If `column` is undefined, we conservatively answer
 * "is the line dominated by a string?" — used by modules that don't
 * track column.
 */
function isInsideStringLiteral(sourceText, line, column) {
  if (!sourceText || !line || line < 1) return null;
  const lines = sourceText.split('\n');
  if (line > lines.length) return null;
  const lineText = lines[line - 1];
  if (!lineText) return null;

  // If column is given, walk to that column tracking string state.
  if (typeof column === 'number' && column >= 0) {
    let inS = false;
    let inD = false;
    let inT = false;
    for (let i = 0; i < column && i < lineText.length; i += 1) {
      const ch = lineText[i];
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (!inD && !inT && ch === '\'') inS = !inS;
      else if (!inS && !inT && ch === '"') inD = !inD;
      else if (!inS && !inD && ch === '`') inT = !inT;
    }
    if (inS || inD || inT) {
      return { multiplier: 0.4, reason: 'string literal' };
    }
    return null;
  }

  // No column: conservative heuristic. Doc-string-shape line.
  const trimmed = lineText.trim();
  if (/^['"`]/.test(trimmed) && /['"`][,)\s]*$/.test(trimmed)) {
    return { multiplier: 0.4, reason: 'string literal' };
  }
  return null;
}

/**
 * Message itself looks like documentation / a rule description rather
 * than a concrete bug location.
 */
function looksLikeUserFacingDocString(message) {
  if (!message || typeof message !== 'string') return null;
  const m = message.toLowerCase();
  // The classic PR #85 false-positive shapes
  const docPhrases = [
    'in browser bundle',
    'should not be',
    'should not contain',
    'example of',
    'for example',
    'e.g.,',
    ' eg. ',
    'illustrative',
    'placeholder',
  ];
  for (const p of docPhrases) {
    if (m.includes(p)) {
      return { multiplier: 0.5, reason: 'documentation context' };
    }
  }
  return null;
}

// ─── public API ─────────────────────────────────────────────────────────────

/**
 * Score a finding's confidence.
 *
 * @param {object} input
 * @param {string} [input.filePath]    relative or absolute file path
 * @param {string} [input.ruleKey]     e.g. 'prompt-safety:public-api-key'
 * @param {string} [input.module]      module name (e.g. 'promptSafety')
 * @param {string} [input.message]     finding message
 * @param {number} [input.line]        1-indexed line number
 * @param {number} [input.column]      0-indexed column
 * @param {string} [input.sourceText]  full file content
 * @param {object} [input.context]     reserved for future signals
 * @param {object} [ruleOverrides]     per-rule override map.
 *
 * @returns {{ confidence: number, signals: string[] }}
 */
function scoreFinding(input = {}, ruleOverrides = null) {
  const overrides = mergeOverrides(input, ruleOverrides);
  const signals = [];
  let score = DEFAULT_CONFIDENCE;

  // Path-based signals
  const sDoc = isDocFile(input.filePath);
  if (sDoc && !overrides.ignoreDocFile) {
    score *= sDoc.multiplier;
    signals.push(sDoc.reason);
  }

  const sTest = isTestFile(input.filePath);
  if (sTest && !overrides.ignoreTestPath) {
    score *= sTest.multiplier;
    signals.push(sTest.reason);
  }

  const sFix = isFixtureFile(input.filePath);
  if (sFix && !overrides.ignoreFixturePath) {
    score *= sFix.multiplier;
    signals.push(sFix.reason);
  }

  const sEx = isExampleDataFile(input.filePath);
  if (sEx && !overrides.ignoreExamplePath) {
    score *= sEx.multiplier;
    signals.push(sEx.reason);
  }

  const sVendor = isHomeworkDir(input.filePath);
  if (sVendor) {
    score *= sVendor.multiplier;
    signals.push(sVendor.reason);
  }

  // Source-text signals (only fire when source is available)
  if (input.sourceText && input.line) {
    const sBlock = isInsideBlockComment(input.sourceText, input.line);
    if (sBlock) {
      score *= sBlock.multiplier;
      signals.push(sBlock.reason);
    }
    const sStr = isInsideStringLiteral(input.sourceText, input.line, input.column);
    if (sStr) {
      score *= sStr.multiplier;
      signals.push(sStr.reason);
    }
  }

  // Message-based signal
  const sDocStr = looksLikeUserFacingDocString(input.message);
  if (sDocStr) {
    score *= sDocStr.multiplier;
    signals.push(sDocStr.reason);
  }

  // Clamp
  if (score < 0) score = 0;
  if (score > 1) score = 1;

  return { confidence: score, signals };
}

/**
 * Merge default rule overrides with caller-supplied ones, matching by
 * module name or ruleKey prefix.
 */
function mergeOverrides(input, callerOverrides) {
  const merged = {
    ignoreTestPath: false,
    ignoreFixturePath: false,
    ignoreDocFile: false,
    ignoreExamplePath: false,
  };
  const all = {
    ...DEFAULT_RULE_OVERRIDES,
    ...(callerOverrides || {}),
  };

  // Try module-level match
  if (input.module && all[input.module]) {
    Object.assign(merged, all[input.module]);
  }
  // Try exact ruleKey match
  if (input.ruleKey && all[input.ruleKey]) {
    Object.assign(merged, all[input.ruleKey]);
  }
  // Try rulekey prefix match
  if (input.ruleKey) {
    const colonIdx = input.ruleKey.indexOf(':');
    const prefix = colonIdx > 0 ? input.ruleKey.slice(0, colonIdx) : input.ruleKey;
    if (all[prefix]) Object.assign(merged, all[prefix]);
  }

  return merged;
}

/**
 * Convenience: should this check block the gate?
 */
function isBlockingFinding(check, threshold) {
  if (!check) return false;
  if (check.passed === true) return false;
  if (check.severity !== 'error') return false;
  const c = typeof check.confidence === 'number' ? check.confidence : DEFAULT_CONFIDENCE;
  const t = typeof threshold === 'number' ? threshold : BLOCK_THRESHOLD;
  return c >= t;
}

module.exports = {
  DEFAULT_CONFIDENCE,
  BLOCK_THRESHOLD,
  DEFAULT_RULE_OVERRIDES,
  scoreFinding,
  isBlockingFinding,
  // exported for testing
  _signals: {
    isDocFile,
    isTestFile,
    isFixtureFile,
    isExampleDataFile,
    isHomeworkDir,
    isInsideBlockComment,
    isInsideStringLiteral,
    looksLikeUserFacingDocString,
  },
};
