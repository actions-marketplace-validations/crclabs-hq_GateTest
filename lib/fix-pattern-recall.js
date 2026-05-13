/**
 * Fix-pattern recall — read the customer's prior-fix history and surface
 * relevant past fixes as prior-art in the Claude prompt.
 *
 * The mechanism: GateTest's CLI runs save successful fixes to
 * `.gatetest/memory/fix-patterns.json` (see src/core/memory.js). Customers
 * who commit that file get a compounding moat — each scan benefits from
 * every prior fix. This helper takes the file's parsed contents plus the
 * current scan's findings and synthesises a short "PRIOR FIXES" header
 * to inject into the prompt.
 *
 * Pure data transformation. No disk read, no network. Caller passes the
 * file contents in.
 *
 * Why this is high-leverage:
 *   - The customer already has the fix patterns they prefer (committed)
 *   - We surface only RELEVANT patterns (matched against current findings)
 *   - Claude sees "you fixed X this way 4 times in the last 6 months —
 *     stay consistent" before generating the fix
 *
 * Without a central brain, this is per-customer. With one (Memory-as-a-
 * Service, Boss-Rule item), the same helper feeds cross-customer prior-art.
 */

const FIX_PATTERNS_PATH = '.gatetest/memory/fix-patterns.json';
const DEFAULT_MAX_PATTERNS_IN_PROMPT = 5;
const DEFAULT_MAX_EXAMPLES_PER_PATTERN = 2;

/**
 * Mirror of MemoryStore._patternKeyFromCheckName so the recall helper can
 * compute the same lookup key the recorder uses, without requiring the
 * MemoryStore class itself (which depends on fs).
 *
 * Shape: "moduleName:checkName" → "moduleName:checkName" (truncated to
 * the first two ':'-separated parts).
 */
function patternKeyFromCheckName(checkName) {
  if (!checkName) return null;
  const s = String(checkName);
  const parts = s.split(':');
  if (parts.length < 2) return parts[0] || null;
  return `${parts[0]}:${parts[1]}`;
}

/**
 * Locate the fix-patterns file inside the in-memory file map. Customers
 * who commit `.gatetest/memory/fix-patterns.json` get their prior-fix
 * history surfaced; everyone else gets no-op.
 *
 * fileContents may be an array of { path, content } objects (the shape
 * scan/fix/route.ts uses) OR a flat { [path]: content } map.
 */
function findFixPatternsJson(fileContents) {
  if (!fileContents) return null;

  // Array form
  if (Array.isArray(fileContents)) {
    for (const f of fileContents) {
      if (f && typeof f.path === 'string' && f.path.endsWith(FIX_PATTERNS_PATH) && typeof f.content === 'string') {
        return f.content;
      }
    }
    return null;
  }

  // Map form
  if (typeof fileContents === 'object') {
    for (const [p, c] of Object.entries(fileContents)) {
      if (p.endsWith(FIX_PATTERNS_PATH) && typeof c === 'string') {
        return c;
      }
    }
  }
  return null;
}

/**
 * Parse fix-patterns.json safely. Returns the patterns map or empty {}
 * on malformed input.
 */
function parseFixPatterns(jsonText) {
  if (!jsonText) return {};
  let parsed;
  try { parsed = JSON.parse(jsonText); } catch { return {}; }
  if (!parsed || typeof parsed !== 'object') return {};
  return (parsed.patterns && typeof parsed.patterns === 'object') ? parsed.patterns : {};
}

/**
 * Match a current finding against a pattern key. Heuristic: extract the
 * leading module name from the finding (first ':'-separated token) and
 * check if any pattern key starts with that module.
 *
 * Examples:
 *   finding "secrets: hardcoded API key found in src/x.js"
 *   pattern keys "secrets:hardcoded-credential", "lint:no-var"
 *   → matches "secrets:hardcoded-credential"
 */
function findMatchingPatterns(finding, patternsByKey) {
  if (typeof finding !== 'string' || !patternsByKey) return [];
  const firstColon = finding.indexOf(':');
  if (firstColon < 1) return [];
  const moduleHint = finding.slice(0, firstColon).trim().toLowerCase();
  if (!moduleHint) return [];
  const hits = [];
  for (const [key, entry] of Object.entries(patternsByKey)) {
    if (typeof key !== 'string') continue;
    const keyModule = key.split(':')[0].toLowerCase();
    if (keyModule === moduleHint) {
      hits.push({ key, entry });
    }
  }
  return hits;
}

/**
 * Build a compact "PRIOR FIXES" prompt header for the given findings.
 * Only includes patterns relevant to at least one current finding.
 *
 * Output shape (when patterns matched):
 *
 *   PRIOR FIXES (from this repo's memory store):
 *   - secrets:hardcoded-credential (fixed 4x, last 2026-04-12):
 *     • Replaced with process.env read (src/db.js)
 *     • Moved to .env.example placeholder (src/api.js)
 *   - lint:no-var (fixed 12x, last 2026-04-15):
 *     • Converted var → const where reassignment absent (src/main.js)
 *
 *   The customer fixes these the same way every time. Stay consistent
 *   unless the current finding genuinely requires a different shape.
 *
 * Empty findings or no matches → empty string (no prompt pollution).
 */
function buildPriorArtHeader({
  fileContents,
  findings = [],
  maxPatterns = DEFAULT_MAX_PATTERNS_IN_PROMPT,
  maxExamplesPerPattern = DEFAULT_MAX_EXAMPLES_PER_PATTERN,
} = {}) {
  const raw = findFixPatternsJson(fileContents);
  if (!raw) return '';
  const patternsByKey = parseFixPatterns(raw);
  if (!Object.keys(patternsByKey).length) return '';
  if (!Array.isArray(findings) || findings.length === 0) return '';

  // Collect matched patterns deduplicated by key, ranked by occurrence count.
  const matchedByKey = new Map();
  for (const finding of findings) {
    const hits = findMatchingPatterns(finding, patternsByKey);
    for (const { key, entry } of hits) {
      if (!matchedByKey.has(key)) matchedByKey.set(key, entry);
    }
  }
  if (matchedByKey.size === 0) return '';

  const ranked = [...matchedByKey.entries()]
    .map(([key, entry]) => ({ key, entry }))
    .sort((a, b) => (b.entry.count || 0) - (a.entry.count || 0))
    .slice(0, maxPatterns);

  const lines = ['PRIOR FIXES (from this repo\'s memory store):'];
  for (const { key, entry } of ranked) {
    const count = entry.count || 0;
    const last = entry.lastAt ? new Date(entry.lastAt).toISOString().slice(0, 10) : 'unknown';
    lines.push(`- ${key} (fixed ${count}x, last ${last}):`);
    const examples = Array.isArray(entry.examples) ? entry.examples.slice(0, maxExamplesPerPattern) : [];
    for (const ex of examples) {
      const where = Array.isArray(ex.filesChanged) && ex.filesChanged.length
        ? ` (${ex.filesChanged.slice(0, 3).join(', ')})`
        : '';
      const desc = ex.description ? String(ex.description).slice(0, 140) : '(no description)';
      lines.push(`  • ${desc}${where}`);
    }
  }
  lines.push('');
  lines.push("The customer fixes these the same way every time. Stay consistent unless the current finding genuinely requires a different shape.");
  lines.push('');

  return lines.join('\n') + '\n';
}

/**
 * Summary the caller can log / surface in the response so the customer
 * knows the prior-art injection actually happened (and which patterns
 * it pulled from).
 */
function summarisePriorArt({ fileContents, findings = [] } = {}) {
  const raw = findFixPatternsJson(fileContents);
  if (!raw) return { available: false, reason: 'no fix-patterns.json found in repo' };
  const patternsByKey = parseFixPatterns(raw);
  const patternKeys = Object.keys(patternsByKey);
  if (!patternKeys.length) return { available: false, reason: 'fix-patterns.json is empty' };

  const matched = new Set();
  for (const f of findings) {
    for (const { key } of findMatchingPatterns(f, patternsByKey)) matched.add(key);
  }

  return {
    available: matched.size > 0,
    totalPatternsInStore: patternKeys.length,
    matchedThisScan: matched.size,
    matchedKeys: [...matched],
  };
}

module.exports = {
  buildPriorArtHeader,
  summarisePriorArt,
  // Exposed for tests
  findFixPatternsJson,
  parseFixPatterns,
  findMatchingPatterns,
  patternKeyFromCheckName,
  FIX_PATTERNS_PATH,
};
