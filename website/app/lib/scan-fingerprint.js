/**
 * Phase 5.1.2 — fingerprint extractor.
 *
 * Pure function. Given a scan result + a workspace shape, emit a stable
 * fingerprint that the storage layer (5.1.1) persists and the lookup
 * layer (5.1.3) queries against. Same input → same output, every time.
 *
 * The fingerprint has four layers, each more abstract than the last:
 *
 *   1. frameworkVersions  { next: '16.2.4', react: '19', stripe: '...' }
 *      Read from package.json / requirements.txt / go.mod / etc.
 *
 *   2. languageMix        { ts: 0.85, js: 0.10, json: 0.05 }
 *      Per-extension byte share of the workspace.
 *
 *   3. moduleFindings     { lint: { count: 3, patternHashes: ['abc'] }, ... }
 *      Per-module finding count + de-duplicated pattern hashes. The
 *      pattern hash is what makes the brain smart: every "money-named
 *      var stored as parseFloat" finding hashes to the same string,
 *      regardless of file path or variable name. Cross-repo matches
 *      surface "this exact bug shipped in 23% of similar codebases."
 *
 *   4. fingerprintSignature  sha256 of canonical layers 1-3
 *      Single string for the high-signal exact-match lookup. Signature
 *      is stable across re-scans of the same repo if nothing changed,
 *      changes when frameworks shift or new finding patterns appear.
 *
 * PRIVACY CONTRACT (matches the storage layer's contract):
 *   - NO source code is hashed or stored.
 *   - NO file paths leave the extractor — only file extensions for
 *     language mix.
 *   - NO secret values, env vars, or credentials.
 *   - Finding messages are reduced to a CATEGORY signature (rule
 *     identifier + module name + file extension), so two repos with
 *     "uses var" findings hash to the same pattern even though the
 *     finding text varies.
 */

const crypto = require('crypto');

const FINGERPRINT_VERSION = 1;

// Mapping of file-extension → language label. Anything unknown bucket
// goes into 'other'. Order matters for tie-breaks (longest first).
const LANGUAGE_BY_EXT = {
  ts: 'ts', tsx: 'ts', mts: 'ts', cts: 'ts',
  js: 'js', jsx: 'js', mjs: 'js', cjs: 'js',
  py: 'py',
  go: 'go',
  rs: 'rs',
  java: 'java',
  kt: 'kt', kts: 'kt',
  swift: 'swift',
  rb: 'rb',
  php: 'php',
  cs: 'cs',
  json: 'json',
  yaml: 'yaml', yml: 'yaml',
  toml: 'toml',
  md: 'md', mdx: 'md',
  html: 'html', htm: 'html',
  css: 'css', scss: 'css', sass: 'css', less: 'css',
  sql: 'sql',
  sh: 'sh', bash: 'sh', zsh: 'sh',
  dockerfile: 'docker',
  proto: 'proto',
  graphql: 'graphql', gql: 'graphql',
};

// Framework names we look for in package.json / requirements.txt / go.mod.
// The keys are normalised display names; the values are the substring(s)
// that appear in dependency manifests.
const FRAMEWORK_PATTERNS = [
  { key: 'next', match: /^next$/ },
  { key: 'react', match: /^react$/ },
  { key: 'vue', match: /^vue$/ },
  { key: 'svelte', match: /^svelte$/ },
  { key: 'angular', match: /^@angular\/core$/ },
  { key: 'astro', match: /^astro$/ },
  { key: 'remix', match: /^@remix-run\/react$/ },
  { key: 'express', match: /^express$/ },
  { key: 'fastify', match: /^fastify$/ },
  { key: 'koa', match: /^koa$/ },
  { key: 'hono', match: /^hono$/ },
  { key: 'nestjs', match: /^@nestjs\/core$/ },
  { key: 'prisma', match: /^@prisma\/client$/ },
  { key: 'drizzle', match: /^drizzle-orm$/ },
  { key: 'sequelize', match: /^sequelize$/ },
  { key: 'typeorm', match: /^typeorm$/ },
  { key: 'mongoose', match: /^mongoose$/ },
  { key: 'stripe', match: /^stripe$/ },
  { key: 'anthropic', match: /^@anthropic-ai\/sdk$/ },
  { key: 'openai', match: /^openai$/ },
  { key: 'tailwind', match: /^tailwindcss$/ },
  { key: 'vite', match: /^vite$/ },
  { key: 'webpack', match: /^webpack$/ },
  { key: 'jest', match: /^jest$/ },
  { key: 'vitest', match: /^vitest$/ },
  { key: 'playwright', match: /^@playwright\/test$/ },
  // Python
  { key: 'django', match: /^django$/i },
  { key: 'flask', match: /^flask$/i },
  { key: 'fastapi', match: /^fastapi$/i },
  // Go
  { key: 'gin', match: /github\.com\/gin-gonic\/gin/ },
  { key: 'echo', match: /github\.com\/labstack\/echo/ },
];

/**
 * Strip a semver to major.minor.patch (drop leading ^ ~ >= < etc., drop
 * pre-release / build metadata, keep at least the major).
 */
function normaliseVersion(raw) {
  if (typeof raw !== 'string') return null;
  const m = raw.match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return null;
  if (m[3] !== undefined) return `${m[1]}.${m[2]}.${m[3]}`;
  if (m[2] !== undefined) return `${m[1]}.${m[2]}`;
  return m[1];
}

/**
 * Extract framework versions from a package-manifest map. The caller
 * passes a flattened {name: version} object; this fn only knows about
 * the versions it cares about.
 */
function extractFrameworks(deps) {
  if (!deps || typeof deps !== 'object') return {};
  const out = {};
  for (const [name, version] of Object.entries(deps)) {
    for (const fw of FRAMEWORK_PATTERNS) {
      if (fw.match.test(name)) {
        const v = normaliseVersion(version);
        if (v) out[fw.key] = v;
      }
    }
  }
  return out;
}

/**
 * Compute a per-extension byte-share map from a list of files. Each
 * file is { path: string, bytes: number }. Result sums to 1.0 (within
 * floating-point tolerance) when there are any files; empty in if no
 * files.
 */
function computeLanguageMix(files) {
  if (!Array.isArray(files) || files.length === 0) return {};
  const totals = {};
  let grand = 0;
  for (const f of files) {
    if (!f || typeof f.path !== 'string' || typeof f.bytes !== 'number' || f.bytes <= 0) continue;
    const ext = (f.path.match(/\.([a-zA-Z0-9]+)$/) || ['', ''])[1].toLowerCase();
    const lang = LANGUAGE_BY_EXT[ext] || 'other';
    totals[lang] = (totals[lang] || 0) + f.bytes;
    grand += f.bytes;
  }
  if (grand === 0) return {};
  const mix = {};
  for (const [lang, bytes] of Object.entries(totals)) {
    // Round to 4dp so trivial whitespace-only changes don't flip the
    // signature.
    mix[lang] = Math.round((bytes / grand) * 10000) / 10000;
  }
  return mix;
}

/**
 * Hash a single finding into a category signature. The hash is stable
 * for the same (module, ruleId, fileExtension) triple across any number
 * of files / repos / messages.
 *
 * Input: { module, message, file? }
 * Output: short hex string (16 chars) suitable for clustering.
 */
function hashFindingPattern(finding) {
  if (!finding || typeof finding !== 'object') return '';
  const moduleName = finding.module || '';
  const message = typeof finding.message === 'string' ? finding.message : '';
  const file = typeof finding.file === 'string' ? finding.file : '';
  // Try to extract a rule-ID-ish prefix from the message. Most
  // GateTest modules emit "ruleName: detail" or "[rule] detail" or a
  // capitalised snake_case rule like "always-true-if".
  let ruleId = '';
  const ruleMatch =
    message.match(/^([a-z][a-z0-9-]+):/i) ||
    message.match(/^\[([a-z][a-z0-9-]+)\]/i) ||
    message.match(/\b([a-z]+(?:-[a-z]+){1,4})\b/);
  if (ruleMatch) ruleId = ruleMatch[1].toLowerCase();
  // Bucket by file extension only — never the path.
  const ext = (file.match(/\.([a-zA-Z0-9]+)$/) || ['', ''])[1].toLowerCase();
  const lang = LANGUAGE_BY_EXT[ext] || 'other';
  const seed = `${moduleName}|${ruleId}|${lang}`;
  return crypto.createHash('sha256').update(seed).digest('hex').slice(0, 16);
}

/**
 * Reduce a scan's modules array to a per-module summary {count, patternHashes}.
 * The patternHashes array is de-duplicated and sorted so two scans that
 * found the same set of pattern signatures emit identical hashes regardless
 * of finding-order.
 */
function summariseModuleFindings(modules) {
  if (!Array.isArray(modules)) return {};
  const out = {};
  for (const m of modules) {
    if (!m || !m.name) continue;
    const details = Array.isArray(m.details) ? m.details : [];
    const seen = new Set();
    let count = 0;
    for (const detail of details) {
      const finding = parseFindingDetail(detail, m.name);
      if (!finding) continue;
      count++;
      const h = hashFindingPattern(finding);
      if (h) seen.add(h);
    }
    out[m.name] = {
      count,
      patternHashes: Array.from(seen).sort(),
    };
  }
  return out;
}

/**
 * Light-weight inline parser — same shape that ai-handoff.js / FindingsPanel
 * use, replicated here so the extractor has zero dependencies on the UI
 * layer. Returns { module, message, file } or null.
 */
function parseFindingDetail(raw, moduleName) {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  let rest = raw
    .replace(/^(?:\[[^\]]+\]\s*|(?:error|warn(?:ing)?|info|note|summary)\s*:\s*)/i, '')
    .trim();
  let file = null;
  const fileLine = rest.match(/^([A-Za-z0-9_./\-@+]+?\.[A-Za-z0-9]{1,8}):(\d+)(?::\d+)?(?:\s*[-—:]\s*|\s+)(.+)$/);
  if (fileLine) { file = fileLine[1]; rest = fileLine[3]; }
  else {
    const fileOnly = rest.match(/^([A-Za-z0-9_./\-@+]+?\.[A-Za-z0-9]{1,8})\s*[:—-]\s*(.+)$/);
    if (fileOnly) { file = fileOnly[1]; rest = fileOnly[2]; }
  }
  return { module: moduleName, message: rest, file };
}

/**
 * Reduce a fix-result to per-module {attempted, succeeded}. Used as
 * input to per-module fix-success-rate aggregation in the brain.
 */
function summariseFixOutcomes(fixes, errors) {
  const out = {};
  if (Array.isArray(fixes)) {
    for (const f of fixes) {
      if (!f || !Array.isArray(f.issues)) continue;
      // Best-effort: associate fix with the module(s) whose issues
      // appear. The fix shape doesn't carry module names directly so
      // we record under a synthetic "_total" bucket alongside any
      // module hint we can recover from the issue text.
      const bucket = (f.module || '_total');
      if (!out[bucket]) out[bucket] = { attempted: 0, succeeded: 0 };
      out[bucket].attempted += f.issues.length;
      out[bucket].succeeded += f.issues.length;
    }
  }
  if (Array.isArray(errors)) {
    for (const e of errors) {
      if (typeof e !== 'string') continue;
      // Try to extract a module hint from the error string, otherwise
      // attribute to _total.
      const m = e.match(/Skipped\s+(\S+)/) || e.match(/Failed to fix\s+(\S+)/);
      const bucket = '_total';
      if (!out[bucket]) out[bucket] = { attempted: 0, succeeded: 0 };
      out[bucket].attempted += 1;
      // Errors are non-success — no increment to succeeded.
      // The matched module is recorded as a feature only.
      void m;
    }
  }
  return out;
}

/**
 * Recursive canonical-JSON stringify: every object's keys are sorted
 * lexicographically before serialisation. Two semantically-equal
 * inputs (same data, different key order) produce the exact same
 * string. Required for stable fingerprint signatures across runs and
 * across machines.
 *
 * Note: passing `JSON.stringify(x, allowedKeys)` does NOT do this —
 * the array form of replacer only filters top-level keys and breaks
 * nested objects.
 */
function canonicalStringify(value) {
  if (value === null || value === undefined) return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalStringify).join(',') + ']';
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return (
      '{' +
      keys
        .map((k) => JSON.stringify(k) + ':' + canonicalStringify(value[k]))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(value);
}

/**
 * Build the canonical fingerprint signature. Sorts every map's keys
 * before stringifying so semantically-equal fingerprints hash to the
 * exact same string.
 */
function computeFingerprintSignature(parts) {
  const canon = canonicalStringify(parts);
  return crypto
    .createHash('sha256')
    .update(`gatetest:fingerprint:v${FINGERPRINT_VERSION}|${canon}`)
    .digest('hex');
}

/**
 * Top-level extractor. Pure function. Given a scan-result + workspace
 * metadata, emits the full fingerprint shape ready to hand to
 * insertFingerprint() in the storage layer.
 *
 * @param {object} opts
 * @param {Array<{name, status, details?}>} opts.modules - scan result modules
 * @param {object} [opts.dependencies] - flat name→version map from package.json
 * @param {Array<{path, bytes}>} [opts.files] - file metadata (path, bytes)
 * @param {Array} [opts.fixes] - successful fixes from /api/scan/fix
 * @param {Array<string>} [opts.fixErrors] - error strings from /api/scan/fix
 * @param {string} [opts.tier]
 * @param {number} [opts.durationMs]
 * @returns {{frameworkVersions, languageMix, moduleFindings, fixOutcomes, totalFindings, totalFixed, fingerprintSignature, version}}
 */
function extractFingerprint(opts = {}) {
  const {
    modules = [],
    dependencies = {},
    files = [],
    fixes = [],
    fixErrors = [],
    tier = 'unknown',
    durationMs = null,
  } = opts;

  const frameworkVersions = extractFrameworks(dependencies);
  const languageMix = computeLanguageMix(files);
  const moduleFindings = summariseModuleFindings(modules);
  const fixOutcomes = summariseFixOutcomes(fixes, fixErrors);

  let totalFindings = 0;
  for (const summary of Object.values(moduleFindings)) {
    totalFindings += summary.count;
  }
  let totalFixed = 0;
  for (const o of Object.values(fixOutcomes)) {
    totalFixed += o.succeeded || 0;
  }

  // Build a sorted, deterministic pattern-hash list across all modules
  // for the signature. We don't include module-by-module counts here
  // because count varies with codebase size — only PRESENCE of a pattern
  // matters for similarity.
  const allPatternHashes = new Set();
  for (const summary of Object.values(moduleFindings)) {
    for (const h of summary.patternHashes || []) allPatternHashes.add(h);
  }

  const sigParts = {
    frameworkVersions,
    languageMix,
    patterns: Array.from(allPatternHashes).sort(),
    tier,
  };
  const fingerprintSignature = computeFingerprintSignature(sigParts);

  return {
    version: FINGERPRINT_VERSION,
    frameworkVersions,
    languageMix,
    moduleFindings,
    fixOutcomes,
    totalFindings,
    totalFixed,
    durationMs,
    fingerprintSignature,
  };
}

module.exports = {
  FINGERPRINT_VERSION,
  LANGUAGE_BY_EXT,
  FRAMEWORK_PATTERNS,
  normaliseVersion,
  extractFrameworks,
  computeLanguageMix,
  hashFindingPattern,
  summariseModuleFindings,
  summariseFixOutcomes,
  canonicalStringify,
  computeFingerprintSignature,
  extractFingerprint,
};
