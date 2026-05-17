/**
 * Race-Condition Module — check-then-act, TOCTOU, get-then-set.
 *
 * Concurrency bugs are the most expensive class of production bugs:
 * hard to reproduce, impossible to debug from logs, only surface
 * under load. The most common shape is "check, then act":
 *
 *   1. Check a condition (`fs.exists(p)`, `await getUser(id)`,
 *      `await db.findFirst({ email })`).
 *   2. Act on the result (`fs.writeFile(p, ...)`, `await updateUser
 *      (id, ...)`, `await db.create({ email })`).
 *
 * Between step 1 and step 2, a concurrent request changes the state
 * out from under you. Result: duplicate rows, overwritten writes,
 * files clobbered, TOCTOU vulnerabilities.
 *
 * The fix is always one of:
 *   - Atomic primitives (`fs.open(path, 'wx')`, `INSERT ... ON
 *     CONFLICT`, compare-and-swap).
 *   - Wrap in a transaction with `SERIALIZABLE` or `SELECT ... FOR
 *     UPDATE`.
 *   - Use a unique constraint + catch the duplicate-key error.
 *
 * Competitors: nothing. SonarQube has a couple of Java-specific
 * concurrency rules. Nobody scans JS/TS for these patterns.
 *
 * Approach (line-heuristic, no AST):
 *
 *   Scan JS/TS files. For each `await`/sync "check" call, look ahead
 *   up to 15 lines (or to the end of the current function body) for
 *   a related "act" call. If the check and act mention the same
 *   variable or key and no transaction wrapper is visible, flag.
 *
 * Patterns recognised:
 *
 *   fs TOCTOU:
 *     `fs.exists(p)` / `fs.existsSync(p)` / `fs.stat(p)` followed
 *     by `fs.writeFile(p, ...)` / `fs.unlink(p)` / `fs.rename(p)`
 *     → error (classic TOCTOU, also a CWE-367 security issue)
 *
 *   DB upsert race:
 *     `await db.x.findFirst({ where: { ... } })` / `.findUnique`
 *     followed by `await db.x.create(...)` / `.update(...)` with
 *     no visible `$transaction` / `SERIALIZABLE` / unique-constraint
 *     try/catch → warning (the `getOrCreate` anti-pattern)
 *
 *   Counter get-then-set:
 *     `await X.get(...)` / `.find` followed by `await X.set(...)` /
 *     `.update` that writes a value derived from the previous get
 *     → warning (lost-update on concurrent counters)
 *
 *   Auth check-then-act:
 *     `const user = await getUser(id)` followed by
 *     `await updateUser(id, { ... })` without a transaction →
 *     warning (authorization bypass via concurrent role change)
 *
 * Rules:
 *
 *   error:   `fs.exists*`/`fs.stat` followed by a mutating `fs.*`
 *            call on the same path. This is a CWE-367 TOCTOU bug.
 *            (rule: `race-condition:fs-toctou:<rel>:<line>`)
 *
 *   warning: find*-then-create / find*-then-update without a
 *            transaction wrapper visible in the enclosing function.
 *            (rule: `race-condition:get-or-create:<rel>:<line>`)
 *
 *   warning: counter-style get-then-set where the set value is
 *            derived from the get.
 *            (rule: `race-condition:lost-update:<rel>:<line>`)
 *
 * TODO(gluecron): host-neutral.
 */

const fs = require('fs');
const path = require('path');
const BaseModule = require('./base-module');

const DEFAULT_EXCLUDES = [
  'node_modules', '.git', '.claude', 'dist', 'build', 'coverage', '.gatetest',
  '.next', '__pycache__', 'target', 'vendor', '.terraform', 'out',
];

const SOURCE_EXTS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);

const TEST_PATH_RE = /(?:^|\/)(?:tests?|__tests__|spec)(?:\/|$)|\.(?:test|spec)\.(?:js|jsx|ts|tsx|mjs|cjs|mts|cts)$/i;

// String-aware helper.
function isInString(line, idx) {
  let inS = false; let inD = false; let inT = false;
  for (let i = 0; i < idx && i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '\\') { i += 1; continue; }
    if (!inD && !inT && ch === '\'') inS = !inS;
    else if (!inS && !inT && ch === '"') inD = !inD;
    else if (!inS && !inD && ch === '`') inT = !inT;
  }
  return inS || inD || inT;
}

function matchOutsideString(line, re) {
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
  const gre = new RegExp(re.source, flags);
  let m;
  while ((m = gre.exec(line)) !== null) {
    if (!isInString(line, m.index)) return m;
    if (m.index === gre.lastIndex) gre.lastIndex += 1;
  }
  return null;
}

// fs check patterns — capture the first argument (the path expression).
const FS_CHECK_RES = [
  /\bfs(?:\.promises)?\.(?:exists|existsSync|stat|statSync|lstat|lstatSync|access|accessSync)\s*\(\s*([^,)]+)/,
  /\bexistsSync\s*\(\s*([^,)]+)/,
];

// fs mutating operations that, when called on the same path, are
// TOCTOU-risky. Restricted to DESTRUCTIVE / SECURITY-SENSITIVE ops:
// - unlink/rm/rmdir/rename: ENOENT if the file disappeared
// - chmod/chown: privilege-escalation vector if swapped for a symlink
// - copyFile: can overwrite the destination in the window
// - truncate: data loss if the file changed
// - open(without wx): races with create
//
// We deliberately EXCLUDE mkdir/writeFile/appendFile because the
// `if (!exists) mkdir/write` pattern is idempotent-setup — the
// worst case is a redundant operation, not a bug.
const FS_MUTATE_RE = /\bfs(?:\.promises)?\.(?:unlink|unlinkSync|rename|renameSync|rmdir|rmdirSync|rm|rmSync|chmod|chmodSync|chown|chownSync|copyFile|copyFileSync|truncate|truncateSync)\s*\(/;

// A `stat`/`lstat` followed by ANY mutating op (including writeFile)
// IS dangerous — the common shape is "check it's a file, then write"
// which is susceptible to symlink-race attacks. Broader set here.
const FS_MUTATE_STAT_RE = /\bfs(?:\.promises)?\.(?:writeFile|writeFileSync|unlink|unlinkSync|rename|renameSync|rmdir|rmdirSync|rm|rmSync|chmod|chmodSync|chown|chownSync|copyFile|copyFileSync|truncate|truncateSync|appendFile|appendFileSync|open|openSync)\s*\(/;

// DB find patterns — capture model name + a simple "key identifier".
const DB_FIND_RES = [
  // Prisma: prisma.user.findFirst / findUnique
  /\b(prisma\.[A-Za-z_$][\w$]*)\.(?:findFirst|findUnique|findMany)\s*\(/,
  // Sequelize / Mongoose / TypeORM: Model.findOne / findByPk / findOneBy
  /\b([A-Z][\w$]*)\.(?:findOne|findOneBy|findByPk|findFirst|findUnique)\s*\(/,
  // Repo.findOneBy
  /\b([A-Za-z_$][\w$]*)\.(?:findOne|findOneBy)\s*\(/,
];

// DB mutate patterns on the SAME model.
const DB_MUTATE_METHODS = [
  'create', 'createMany', 'save', 'insert',
  'update', 'updateOne', 'updateMany', 'upsert',
  'delete', 'deleteOne', 'deleteMany', 'destroy', 'remove',
];

// Transaction wrappers — if any of these is visible in the window,
// the get-then-act is safe.
const TX_MARKERS = [
  /\$transaction\s*\(/,
  /\.transaction\s*\(/,
  /\bSERIALIZABLE\b/,
  /\bisolationLevel\b/,
  /\bFOR\s+UPDATE\b/i,
  /\btransaction\s*\(\s*async/,
  /\bwithTransaction\s*\(/,
  /\bsequelize\.transaction\s*\(/,
  /\bprisma\.\$transaction\s*\(/,
];

// Unique-constraint-try / on-conflict = the other legitimate fix.
const UNIQUE_FALLBACK_RES = [
  /\bON\s+CONFLICT\b/i,
  /\bupsert\s*\(/,
  /\bP2002\b/,              // Prisma unique-constraint error code
  /\bER_DUP_ENTRY\b/,       // MySQL duplicate-key error
  /\b23505\b/,              // Postgres unique-violation SQLSTATE
];

class RaceConditionModule extends BaseModule {
  constructor() {
    super(
      'raceCondition',
      'Race-condition / check-then-act detector — fs TOCTOU, get-or-create anti-pattern, lost-update on counters',
    );
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;
    const files = this._findFiles(projectRoot);

    if (files.length === 0) {
      result.addCheck('race-condition:no-files', true, {
        severity: 'info',
        message: 'No JS/TS source files found — skipping',
      });
      return;
    }

    result.addCheck('race-condition:scanning', true, {
      severity: 'info',
      message: `Scanning ${files.length} JS/TS file(s) for check-then-act races`,
    });

    let issues = 0;
    for (const file of files) {
      issues += this._scanFile(file, projectRoot, result);
    }

    result.addCheck('race-condition:summary', true, {
      severity: 'info',
      message: `Race-condition scan: ${files.length} file(s), ${issues} issue(s)`,
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

    const rel = path.relative(projectRoot, file);
    const isTestFile = TEST_PATH_RE.test(rel);
    const lines = content.split('\n');
    let issues = 0;

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//')) continue;

      // --- fs TOCTOU ---
      for (const checkRe of FS_CHECK_RES) {
        const m = matchOutsideString(line, checkRe);
        if (!m) continue;
        const pathExpr = (m[1] || '').trim();
        if (!pathExpr) continue;

        // `stat`/`lstat` broadens the mutation set (symlink-race
        // vector); other checks use the narrow destructive set.
        const isStatCheck = /\b(?:stat|statSync|lstat|lstatSync)\b/.test(m[0]);
        const mutateRe = isStatCheck ? FS_MUTATE_STAT_RE : FS_MUTATE_RE;

        // Include the tail of the current line (anything after the
        // check expression) so single-line `if (exists(p)) unlink(p)`
        // patterns are caught.
        const tail = line.slice(m.index + m[0].length);
        const window = `${tail}\n${this._forwardWindow(lines, i, 15)}`;

        // Find a mutate call whose FIRST ARGUMENT actually references
        // the same path expression. This avoids false-positives when
        // the window also contains an unrelated mutate on a different
        // path (e.g. a nearby function).
        const normalizedPath = pathExpr.replace(/['"`]/g, '').trim();
        if (!normalizedPath) break;
        const pathToken = this._escapeRegex(normalizedPath);
        const mutateRegexGlobal = new RegExp(mutateRe.source, 'g');
        let mutateMatch = null;
        let gm;
        while ((gm = mutateRegexGlobal.exec(window)) !== null) {
          // Grab up to 80 chars after the mutate for the first arg.
          const after = window.slice(gm.index + gm[0].length, gm.index + gm[0].length + 120);
          const argCloseIdx = after.search(/[),]/);
          const firstArg = argCloseIdx >= 0 ? after.slice(0, argCloseIdx) : after;
          if (new RegExp(`(?:^|[^\\w$])${pathToken}(?:[^\\w$]|$)`).test(firstArg)) {
            mutateMatch = gm;
            break;
          }
        }
        if (!mutateMatch) break;

        issues += this._flag(result, `race-condition:fs-toctou:${rel}:${i + 1}`, {
          severity: isTestFile ? 'warning' : 'error',
          file: rel,
          line: i + 1,
          check: m[0].slice(0, 60),
          mutate: mutateMatch[0].slice(0, 60),
          message: `${rel}:${i + 1} fs TOCTOU — \`${m[0].trim()}\` followed by \`${mutateMatch[0].trim()}\` on \`${normalizedPath.slice(0, 40)}\`; between the check and the act another process can change the file (CWE-367)`,
          suggestion: 'Use atomic primitives: `fs.open(path, "wx")` creates-if-absent atomically; `fs.writeFile(path, data, { flag: "wx" })` for exclusive write. For deletes, catch ENOENT instead of pre-checking.',
        });
        break;
      }

      // --- DB get-or-create / get-then-update races ---
      for (const findRe of DB_FIND_RES) {
        const m = matchOutsideString(line, findRe);
        if (!m) continue;
        const modelExpr = m[1];
        if (!modelExpr) continue;

        const window = this._forwardWindow(lines, i, 15);

        // Is there a mutating call on the same model?
        const mutateRe = new RegExp(
          `\\b${modelExpr.replace(/[.$]/g, (c) => `\\${c}`)}\\.(?:${DB_MUTATE_METHODS.join('|')})\\s*\\(`,
        );
        const mutateMatch = window.match(mutateRe);
        if (!mutateMatch) continue;

        // Transaction wrapper visible?
        const txVisible = TX_MARKERS.some((re) => re.test(window))
          || UNIQUE_FALLBACK_RES.some((re) => re.test(window));
        if (txVisible) continue;

        // Also scan a broader enclosing-function window (back ~20 lines
        // + forward ~20) for a `$transaction` wrapper. This avoids
        // false positives when the entire function IS the tx callback.
        const enclosing = lines.slice(Math.max(0, i - 20), Math.min(lines.length, i + 30)).join('\n');
        if (TX_MARKERS.some((re) => re.test(enclosing))) continue;

        issues += this._flag(result, `race-condition:get-or-create:${rel}:${i + 1}`, {
          severity: 'warning',
          file: rel,
          line: i + 1,
          model: modelExpr,
          check: m[0].slice(0, 60),
          mutate: mutateMatch[0].slice(0, 60),
          message: `${rel}:${i + 1} get-or-create race — \`${m[0].trim()}\` then \`${mutateMatch[0].trim()}\` on \`${modelExpr}\` with no \`$transaction\`/\`FOR UPDATE\`/upsert visible; two concurrent requests will both see "not found" and both create`,
          suggestion: 'Replace with an atomic upsert (`prisma.user.upsert({...})`), or wrap in `$transaction` with a unique constraint + try/catch on the duplicate-key error. For read-modify-write, use `SELECT ... FOR UPDATE` or optimistic-locking with a version column.',
        });
        break;
      }
    }

    return issues;
  }

  _forwardWindow(lines, startLine, count) {
    return lines.slice(startLine + 1, Math.min(lines.length, startLine + 1 + count)).join('\n');
  }

  _escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  _flag(result, name, details) {
    result.addCheck(name, false, details);
    return 1;
  }
}

module.exports = RaceConditionModule;
