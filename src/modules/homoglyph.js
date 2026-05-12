/**
 * Homoglyph / Unicode-Lookalike Module.
 *
 * Trojan Source (CVE-2021-42574, Cambridge 2021) showed the world you
 * can hide malicious logic in source code using Unicode bidirectional
 * override characters. Reviewers see one thing; the compiler sees
 * another. It got through review at real companies.
 *
 * The broader family:
 *
 *   - Bidi-override chars (U+202A..U+202E, U+2066..U+2069) inside
 *     comments or strings — Trojan Source. Reviewer sees:
 *         if (access == "admin") {  // legit check
 *     Compiler sees:
 *         if (access == "user") {   // override reverses the text
 *
 *   - Cyrillic / Greek letters that are visually identical to Latin
 *     letters (`а` U+0430 vs `a` U+0061, `е` U+0435 vs `e`, `о` U+043E
 *     vs `o`, `р` U+0440 vs `p`, `ѕ` U+0455 vs `s`, `с` U+0441 vs `c`,
 *     `х` U+0445 vs `x`, `у` U+0443 vs `y`) used inside identifiers.
 *     Supply chain: a fn `administer` where the `a` is Cyrillic — the
 *     "real" `administer` never gets called, the shadow function runs.
 *
 *   - Zero-width characters (U+200B ZWSP, U+200C ZWNJ, U+200D ZWJ,
 *     U+FEFF BOM embedded mid-file) inside identifiers. Two identifiers
 *     look identical, compare unequal. Attackers use this to shadow
 *     legitimate symbols.
 *
 *   - Right-to-left marker (U+200F) smuggled inside comments around
 *     a forbidden keyword — reviewers skim and miss it.
 *
 * Why mainstream tooling misses this:
 *   - ESLint has no rule for bidi chars.
 *   - GitHub renders a warning on bidi chars in the diff view but
 *     nothing in the IDE, pre-commit hook, or CI gate.
 *   - Semgrep has one rule for bidi, nothing for mixed-script.
 *   - SonarQube has one rule for bidi, nothing for zero-width.
 *   - There is no unified scanner.
 *
 * Legitimate exceptions:
 *   - `.po`, `.pot`, `.xliff`, `.lang`, `.arb`, `.locale` files —
 *     translation strings legitimately contain any Unicode.
 *   - `tests/i18n/`, `tests/fixtures/unicode/` paths.
 *   - Files under a `locales/`, `i18n/`, `lang/`, `translations/` dir.
 *   - `README.*` and `.md` docs — allowed to contain Unicode examples.
 *
 * Rules:
 *
 *   error:   Bidi-override / isolate characters (U+202A..U+202E,
 *            U+2066..U+2069) in non-locale source — Trojan Source
 *            attack shape.
 *            (rule: `homoglyph:bidi-override:<rel>:<line>`)
 *
 *   error:   Identifier contains Cyrillic/Greek letters visually
 *            identical to Latin — supply-chain / code-review bypass
 *            vector.
 *            (rule: `homoglyph:mixed-script-ident:<rel>:<line>`)
 *
 *   warning: Zero-width character (U+200B / U+200C / U+200D / U+FEFF
 *            mid-file) inside source — identifier-shadow vector.
 *            (rule: `homoglyph:zero-width:<rel>:<line>`)
 *
 *   warning: Non-allowlisted control / format characters in source.
 *            (rule: `homoglyph:control-char:<rel>:<line>`)
 *
 * TODO(gluecron): host-neutral — pure source scan.
 */

const fs = require('fs');
const path = require('path');
const BaseModule = require('./base-module');

const DEFAULT_EXCLUDES = [
  'node_modules', '.git', 'dist', 'build', 'coverage', '.gatetest',
  '.next', '__pycache__', 'target', 'vendor', '.terraform', 'out',
];

const SOURCE_EXTS = new Set([
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts',
  '.py', '.go', '.rs', '.java', '.rb', '.php', '.cs', '.kt', '.swift',
  '.c', '.cc', '.cpp', '.h', '.hpp', '.sh', '.bash', '.zsh',
  '.sql', '.yml', '.yaml', '.toml', '.json',
]);

// Paths / basenames where unicode is expected and allowed.
const LOCALE_PATH_RE = /(?:^|\/)(?:locales?|i18n|lang(?:uages?)?|translations?|intl|l10n)(?:\/|$)/i;
const LOCALE_EXT_RE = /\.(?:po|pot|xliff|xlf|arb|lang|locale|mo)$/i;
const DOC_EXT_RE = /\.(?:md|mdx|markdown|rst|txt)$/i;
const TEST_PATH_RE = /(?:^|\/)(?:tests?|__tests__|spec|fixtures?)(?:\/|$)/i;

// Bidi-override / isolate — the Trojan Source range.
// U+202A LRE, U+202B RLE, U+202C PDF, U+202D LRO, U+202E RLO,
// U+2066 LRI, U+2067 RLI, U+2068 FSI, U+2069 PDI
const BIDI_RE = /[\u202A-\u202E\u2066-\u2069]/;

// Zero-width space / joiner / non-joiner / BOM-mid-file.
// ZWSP U+200B, ZWNJ U+200C, ZWJ U+200D, BOM U+FEFF, WORD JOINER U+2060
const ZERO_WIDTH_RE = /[\u200B\u200C\u200D\u2060\uFEFF]/;

// Other format / control chars we don't expect in source.
// Excludes tab (U+0009), LF (U+000A), CR (U+000D).
const CONTROL_RE = /[\u0000-\u0008\u000B-\u000C\u000E-\u001F\u007F]/;

// Visually-Latin Cyrillic / Greek letters commonly used in attacks.
// (Non-exhaustive, but covers the ones with documented look-alike
// confusables in the Unicode TR39 tables.)
const CYRILLIC_LOOKALIKES = new Set([
  '\u0430', // а (a)
  '\u0435', // е (e)
  '\u043E', // о (o)
  '\u0440', // р (p)
  '\u0441', // с (c)
  '\u0445', // х (x)
  '\u0443', // у (y)
  '\u0455', // ѕ (s)
  '\u0456', // і (i)
  '\u0458', // ј (j)
  '\u0501', // ԁ (d)
  '\u051B', // ԛ (q)
  '\u051D', // ԝ (w)
  '\u0432', // в (looks like v in some fonts)
  '\u043A', // к (k)
  '\u043C', // м (m)
  '\u043D', // н (n/h)
  '\u0442', // т (t)
  '\u0410', // А (A)
  '\u0412', // В (B)
  '\u0415', // Е (E)
  '\u041A', // К (K)
  '\u041C', // М (M)
  '\u041D', // Н (H)
  '\u041E', // О (O)
  '\u0420', // Р (P)
  '\u0421', // С (C)
  '\u0422', // Т (T)
  '\u0425', // Х (X)
  '\u0423', // У (Y)
]);

const GREEK_LOOKALIKES = new Set([
  '\u03BF', // ο (o)
  '\u03C1', // ρ (p)
  '\u03BD', // ν (v)
  '\u03B9', // ι (i)
  '\u0391', // Α (A)
  '\u0392', // Β (B)
  '\u0395', // E (E)
  '\u0396', // Ζ (Z)
  '\u0397', // Η (H)
  '\u0399', // Ι (I)
  '\u039A', // Κ (K)
  '\u039C', // Μ (M)
  '\u039D', // Ν (N)
  '\u039F', // Ο (O)
  '\u03A1', // Ρ (P)
  '\u03A4', // Τ (T)
  '\u03A5', // Υ (Y)
  '\u03A7', // Χ (X)
]);

// Identifier-ish run: letter / digit / underscore / $, plus any
// Cyrillic / Greek letter that might be mixed in.
const IDENT_CHAR_RE = /[A-Za-z0-9_$\u0370-\u03FF\u0400-\u04FF\u0500-\u052F]/;

function classifyLetter(ch) {
  if (CYRILLIC_LOOKALIKES.has(ch)) return 'cyrillic';
  if (GREEK_LOOKALIKES.has(ch)) return 'greek';
  const code = ch.charCodeAt(0);
  if (code >= 0x0400 && code <= 0x04FF) return 'cyrillic-other';
  if (code >= 0x0370 && code <= 0x03FF) return 'greek-other';
  if ((code >= 0x0041 && code <= 0x005A) || (code >= 0x0061 && code <= 0x007A)) return 'latin';
  return 'other';
}

class HomoglyphModule extends BaseModule {
  constructor() {
    super(
      'homoglyph',
      'Homoglyph / Unicode-lookalike detector — Trojan Source bidi overrides, Cyrillic/Greek letters in Latin identifiers, zero-width chars, and hidden control chars',
    );
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;
    const files = this._findFiles(projectRoot);

    if (files.length === 0) {
      result.addCheck('homoglyph:no-files', true, {
        severity: 'info',
        message: 'No source files found — skipping',
      });
      return;
    }

    result.addCheck('homoglyph:scanning', true, {
      severity: 'info',
      message: `Scanning ${files.length} source file(s) for homoglyphs / bidi / zero-width`,
    });

    let issues = 0;
    for (const file of files) {
      issues += this._scanFile(file, projectRoot, result);
    }

    result.addCheck('homoglyph:summary', true, {
      severity: 'info',
      message: `Homoglyph scan: ${files.length} file(s), ${issues} issue(s)`,
    });
  }

  _findFiles(projectRoot) {
    const out = [];
    const walk = (dir, depth = 0) => {
      if (depth > 12) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (DEFAULT_EXCLUDES.includes(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, depth + 1);
        else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (SOURCE_EXTS.has(ext)) out.push(full);
        }
      }
    };
    walk(projectRoot);
    return out;
  }

  _scanFile(file, projectRoot, result) {
    let content;
    try { content = fs.readFileSync(file, 'utf-8'); } catch { return 0; }

    // Normalize to forward-slash so the LOCALE/TEST path regexes match
    // identically on Windows (path.relative emits `\` separators there).
    const rel = path.relative(projectRoot, file).split(path.sep).join('/');
    const isLocale = LOCALE_PATH_RE.test(rel) || LOCALE_EXT_RE.test(rel);
    const isDoc = DOC_EXT_RE.test(rel);
    const isTestFile = TEST_PATH_RE.test(rel);

    // Locale and doc files are allowed any Unicode.
    if (isLocale || isDoc) return 0;

    const lines = content.split('\n');
    let issues = 0;

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];

      // Skip BOM on the very first character of the very first line.
      const scanLine = (i === 0 && line.charCodeAt(0) === 0xFEFF) ? line.slice(1) : line;

      // Rule 1: Bidi-override / isolate chars anywhere in the line.
      if (BIDI_RE.test(scanLine)) {
        const codepoints = [...scanLine]
          .filter((ch) => BIDI_RE.test(ch))
          .map((ch) => 'U+' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0'));
        issues += this._flag(result, `homoglyph:bidi-override:${rel}:${i + 1}`, {
          severity: isTestFile ? 'warning' : 'error',
          file: rel,
          line: i + 1,
          codepoints,
          message: `${rel}:${i + 1} contains bidirectional-override character${codepoints.length > 1 ? 's' : ''} ${codepoints.join(', ')} — Trojan Source (CVE-2021-42574) attack shape; what reviewers see is not what the compiler sees`,
          suggestion: 'Remove the override characters. If you genuinely need RTL text (e.g., Arabic / Hebrew content in a string), keep it inside a locale file under `locales/` / `i18n/` rather than inline in source.',
        });
      }

      // Rule 2: Zero-width chars anywhere in the line.
      if (ZERO_WIDTH_RE.test(scanLine)) {
        const codepoints = [...scanLine]
          .filter((ch) => ZERO_WIDTH_RE.test(ch))
          .map((ch) => 'U+' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0'));
        issues += this._flag(result, `homoglyph:zero-width:${rel}:${i + 1}`, {
          severity: isTestFile ? 'info' : 'warning',
          file: rel,
          line: i + 1,
          codepoints,
          message: `${rel}:${i + 1} contains zero-width character${codepoints.length > 1 ? 's' : ''} ${codepoints.join(', ')} — identifier-shadow vector (two identifiers look identical but compare unequal)`,
          suggestion: 'Remove the zero-width characters. They should never appear in source code outside of genuinely text-content strings.',
        });
      }

      // Rule 3: Other control / format chars.
      if (CONTROL_RE.test(scanLine)) {
        const codepoints = [...scanLine]
          .filter((ch) => CONTROL_RE.test(ch))
          .map((ch) => 'U+' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0'));
        issues += this._flag(result, `homoglyph:control-char:${rel}:${i + 1}`, {
          severity: isTestFile ? 'info' : 'warning',
          file: rel,
          line: i + 1,
          codepoints,
          message: `${rel}:${i + 1} contains non-printable control character${codepoints.length > 1 ? 's' : ''} ${codepoints.join(', ')} — source should be ASCII-safe outside string literals`,
          suggestion: 'Remove the control characters. If the file was saved from a terminal paste, re-type the content or paste-as-plain-text.',
        });
      }

      // Rule 4: Mixed-script identifiers.
      // Walk each identifier-ish run and check if it mixes Latin with
      // Cyrillic/Greek lookalikes. Skip string-literal interiors so
      // translation strings in non-locale files don't false-positive.
      const scrubbed = this._stripStringsAndComments(scanLine);
      let j = 0;
      while (j < scrubbed.length) {
        if (!IDENT_CHAR_RE.test(scrubbed[j])) { j += 1; continue; }
        let k = j;
        let hasLatin = false;
        let hasCyrillic = false;
        let hasGreek = false;
        let offending = null;
        while (k < scrubbed.length && IDENT_CHAR_RE.test(scrubbed[k])) {
          const cls = classifyLetter(scrubbed[k]);
          if (cls === 'latin') hasLatin = true;
          if (cls === 'cyrillic' || cls === 'cyrillic-other') {
            hasCyrillic = true;
            if (!offending) offending = scrubbed[k];
          }
          if (cls === 'greek' || cls === 'greek-other') {
            hasGreek = true;
            if (!offending) offending = scrubbed[k];
          }
          k += 1;
        }
        if (hasLatin && (hasCyrillic || hasGreek)) {
          const cp = 'U+' + offending.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0');
          issues += this._flag(result, `homoglyph:mixed-script-ident:${rel}:${i + 1}`, {
            severity: isTestFile ? 'warning' : 'error',
            file: rel,
            line: i + 1,
            codepoint: cp,
            identifier: scrubbed.slice(j, k),
            message: `${rel}:${i + 1} identifier \`${scrubbed.slice(j, k)}\` mixes Latin with ${hasCyrillic ? 'Cyrillic' : 'Greek'} lookalike (${cp}) — supply-chain / code-review bypass vector`,
            suggestion: 'Replace the non-Latin character with its Latin equivalent. If this identifier is genuinely non-English, keep the entire word in one script rather than mixing.',
          });
          j = k;
          continue;
        }
        j = k;
      }
    }

    return issues;
  }

  /**
   * Replace string-literal and comment contents with spaces so
   * identifier extraction doesn't walk into them. Keeps positions
   * stable so line indexing still lines up.
   */
  _stripStringsAndComments(line) {
    const out = [];
    let inS = false; let inD = false; let inT = false;
    let i = 0;
    while (i < line.length) {
      const ch = line[i];
      if (!inS && !inD && !inT && ch === '/' && line[i + 1] === '/') {
        // Rest of line is a line comment.
        while (i < line.length) { out.push(' '); i += 1; }
        break;
      }
      if (!inS && !inD && !inT && ch === '#') {
        // Python / shell / YAML comment.
        while (i < line.length) { out.push(' '); i += 1; }
        break;
      }
      if (!inS && !inD && !inT && ch === '/' && line[i + 1] === '*') {
        out.push(' '); out.push(' '); i += 2;
        while (i < line.length) {
          if (line[i] === '*' && line[i + 1] === '/') {
            out.push(' '); out.push(' '); i += 2; break;
          }
          out.push(' '); i += 1;
        }
        continue;
      }
      if (ch === '\\') {
        out.push(ch);
        if (i + 1 < line.length) { out.push(line[i + 1]); i += 2; continue; }
        i += 1; continue;
      }
      if (!inD && !inT && ch === '\'') { inS = !inS; out.push(' '); i += 1; continue; }
      if (!inS && !inT && ch === '"') { inD = !inD; out.push(' '); i += 1; continue; }
      if (!inS && !inD && ch === '`') { inT = !inT; out.push(' '); i += 1; continue; }
      if (inS || inD || inT) { out.push(' '); i += 1; continue; }
      out.push(ch); i += 1;
    }
    return out.join('');
  }

  _flag(result, name, details) {
    result.addCheck(name, false, details);
    return 1;
  }
}

module.exports = HomoglyphModule;
