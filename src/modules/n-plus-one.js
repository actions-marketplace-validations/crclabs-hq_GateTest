/**
 * N+1 Query Module — database queries inside loops.
 *
 * The N+1 query is the single most common performance bug in every
 * backend codebase we've scanned. Fetch a list of 100 users, then
 * iterate and load each user's orders with a separate query = 101
 * round-trips. Fine on 100 users in staging, catastrophic on 10k
 * users in prod. ORMs make this worse because the `await
 * user.orders` syntax hides the SQL completely.
 *
 * Every competitor either:
 *   a) Profiles at runtime (New Relic, Datadog) — too late, already
 *      in prod.
 *   b) Ships an ORM-specific linter (e.g. prisma-lint-find-many) —
 *      catches one ORM, misses the rest.
 *
 * We scan source statically, ORM-agnostic, zero-dep. Catches every
 * major ORM surface + raw SQL driver calls.
 *
 * Approach (line-heuristic, no AST):
 *
 *   1. Walk JS/TS files. For each file, find the start and end of
 *      every loop block (simple brace-matching, string-aware).
 *   2. Inside each loop body, look for a line that both:
 *        a) uses `await` (or a `.then(` chain), AND
 *        b) calls a known query-shaped method.
 *   3. Flag each occurrence with the loop's start line too.
 *
 * Query-shaped methods recognised:
 *
 *   Prisma:    `prisma.<model>.(findUnique|findMany|findFirst|create|update|delete|upsert|count)(`
 *   Sequelize: `<Model>.(findOne|findAll|findByPk|create|update|destroy|count)(`
 *              `sequelize.query(`
 *   TypeORM:   `<repo>.(findOne|findOneBy|find|save|remove|update|count)(`
 *              `getRepository(`, `.manager.(save|remove|find)(`
 *   Mongoose:  `<Model>.(findOne|find|create|updateOne|updateMany|deleteOne|deleteMany|countDocuments|aggregate)(`
 *   Knex:      `knex(`, `db(`, `.where(...).first()`, `.where(...).select()`
 *   node-pg:   `client.query(`, `pool.query(`, `db.query(`
 *   MySQL:     `connection.execute(`, `connection.query(`, `pool.execute(`
 *   Drizzle:   `db.select().from(`, `db.insert(`, `db.update(`, `db.delete(`
 *   Generic:   `db.<anything>(`, `orm.<anything>(`, `repo.<anything>(`
 *
 * Rules:
 *
 *   error:   A query-shaped `await` occurs inside a `for`, `while`,
 *            `do...while`, `for..of`, `for..in`, `.map(`, `.forEach(`,
 *            `.filter(`, `.reduce(`, `.some(`, `.every(` loop body.
 *            Severity error because the runtime cost is linear in
 *            the input size and usually hits prod exactly when it
 *            hurts.
 *            (rule: `n-plus-one:query-in-loop:<rel>:<line>`)
 *
 *   info:    Loop body uses `await Promise.all(...)` over an array
 *            .map that itself contains a query — this is the fix
 *            shape, recorded for dashboard confidence.
 *            (rule: `n-plus-one:batched-ok:<rel>:<line>`)
 *
 * TODO(gluecron): Once Gluecron ships a first-party ORM, add its
 * method signatures to the query-method table.
 */

const fs = require('fs');
const path = require('path');
const BaseModule = require('./base-module');

const DEFAULT_EXCLUDES = [
  'node_modules', '.git', '.claude', 'dist', 'build', 'coverage', '.gatetest',
  '.next', '__pycache__', 'target', 'vendor', '.terraform', 'out',
];

const SOURCE_EXTS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);

// Regexes that, when they match a line INSIDE a loop, signal a
// potential N+1. Any of these matching is sufficient.
const QUERY_METHOD_RES = [
  // Prisma — `prisma.user.findMany(...)`, `prisma.$queryRaw(...)`
  /\bprisma\.[A-Za-z_$][\w$]*\.(?:findUnique|findFirst|findMany|create|update|updateMany|upsert|delete|deleteMany|count|aggregate|groupBy)\s*\(/,
  /\bprisma\.\$(?:queryRaw|executeRaw|queryRawUnsafe|executeRawUnsafe)\s*[`(]/,
  // Sequelize / TypeORM / Mongoose — `Model.findOne(...)` with capitalised identifier
  /\b[A-Z][\w$]*\.(?:findOne|findAll|findByPk|findOneBy|find|create|update|updateOne|updateMany|destroy|deleteOne|deleteMany|remove|save|count|countDocuments|aggregate)\s*\(/,
  // TypeORM repository / Sequelize sequelize.query
  /\bsequelize\.query\s*\(/,
  /\bgetRepository\s*\(/,
  /\.manager\.(?:save|remove|find|findOne|update|delete|count)\s*\(/,
  /\brepo(?:sitory)?\.(?:findOne|findOneBy|find|save|remove|update|count|delete)\s*\(/,
  // Raw drivers — client/pool/db/connection
  /\b(?:client|pool|db|connection|conn)\.(?:query|execute|prepare|run|get|all|each)\s*[`(]/,
  // Knex — typical `knex('table').where(...).first()` or `db('table').select()`
  /\bknex\s*\(/,
  /\bdb\s*\(\s*['"`][\w]+['"`]\s*\)\s*\.(?:where|select|first|insert|update|del|count|returning)/,
  // Drizzle — `db.select().from(users)`, `db.insert(users)`, etc.
  /\bdb\.(?:select|insert|update|delete)\s*\(/,
  // Generic ORM-ish
  /\borm\.[A-Za-z_$][\w$]*\s*\(/,
];

// Loop-opening patterns. Each entry: regex + hint about whether it's
// a "block-form" loop (needs brace matching) or a "callback-form"
// loop (the callback's body is the loop body).
const LOOP_OPENERS = [
  // Block-form: `for (...)`, `while (...)`, `do {`
  { re: /\bfor\s*\(/, kind: 'block' },
  { re: /\bwhile\s*\(/, kind: 'block' },
  { re: /\bdo\s*\{/, kind: 'block' },
  // Callback-form: `.map(`, `.forEach(`, `.filter(`, `.reduce(`,
  // `.some(`, `.every(`, `.flatMap(`
  { re: /\.(?:map|forEach|filter|reduce|some|every|flatMap)\s*\(/, kind: 'callback' },
];

// String-aware `inString(line, idx)` — consistent with other modules.
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

class NPlusOneModule extends BaseModule {
  constructor() {
    super(
      'nPlusOne',
      'N+1 query detector — database calls inside loops across Prisma, Sequelize, TypeORM, Mongoose, Knex, Drizzle, node-pg, MySQL',
    );
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;
    const files = this._findFiles(projectRoot);

    if (files.length === 0) {
      result.addCheck('n-plus-one:no-files', true, {
        severity: 'info',
        message: 'No JS/TS source files found — skipping',
      });
      return;
    }

    result.addCheck('n-plus-one:scanning', true, {
      severity: 'info',
      message: `Scanning ${files.length} JS/TS file(s)`,
    });

    let issues = 0;
    for (const file of files) {
      issues += this._scanFile(file, projectRoot, result);
    }

    result.addCheck('n-plus-one:summary', true, {
      severity: 'info',
      message: `N+1 scan: ${files.length} file(s), ${issues} issue(s)`,
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
    const lines = content.split('\n');
    let issues = 0;

    // Build a depth-map: for each character index, how many braces
    // deep inside a loop we are. This lets us ask "is line N inside a
    // loop?" without parsing.
    const loopRanges = this._findLoopRanges(content, lines);

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//')) continue;

      const loopStart = this._enclosingLoopStart(loopRanges, i);
      if (loopStart == null) continue;

      // Must be an awaited/chained call (to keep false-positive rate
      // low — synchronous reads of in-memory data aren't N+1).
      const hasAwait = /\bawait\b/.test(line);
      const hasThen = /\.(?:then|catch|finally)\s*\(/.test(line);
      if (!hasAwait && !hasThen) continue;

      // Check against every query method regex.
      let matched = null;
      for (const re of QUERY_METHOD_RES) {
        const m = line.match(re);
        if (m && !isInString(line, m.index)) { matched = m[0]; break; }
      }
      if (!matched) continue;

      // Is this a batched fix shape? `await Promise.all(list.map(...))`
      // — the inner `.map()` creates an array of promises; the DB
      // call happens once per array element in parallel, which is
      // *not* an N+1 in the round-trips-per-request sense.
      // Heuristic: if the enclosing loop opener is a `.map(` and the
      // enclosing context is `Promise.all(` (look up a few lines),
      // classify as batched-ok.
      const enclosingLoop = lines[loopStart] || '';
      const isMap = /\.map\s*\(/.test(enclosingLoop);
      const precedingWindow = lines.slice(Math.max(0, loopStart - 2), loopStart + 1).join('\n');
      const isBatched = isMap && /\bPromise\.all\s*\(/.test(precedingWindow);

      if (isBatched) {
        result.addCheck(`n-plus-one:batched-ok:${rel}:${i + 1}`, true, {
          severity: 'info',
          file: rel,
          line: i + 1,
          loopStart: loopStart + 1,
          message: `${rel}:${i + 1} query inside \`Promise.all(arr.map(...))\` — batched-parallel, not an N+1`,
        });
        continue;
      }

      issues += this._flag(result, `n-plus-one:query-in-loop:${rel}:${i + 1}`, {
        severity: 'error',
        file: rel,
        line: i + 1,
        loopStart: loopStart + 1,
        match: matched.slice(0, 60),
        message: `${rel}:${i + 1} database query inside a loop body (loop opens at line ${loopStart + 1}) — every iteration hits the database, producing an N+1 pattern that is fast in staging and slow in prod`,
        suggestion: 'Batch: collect the IDs first and issue one query (e.g. `prisma.user.findMany({ where: { id: { in: ids } } })`), or wrap with `await Promise.all(list.map(async (x) => ...))` to run queries in parallel. For write-heavy loops, use a bulk insert / `createMany`.',
      });
    }

    return issues;
  }

  // Find all loop ranges in the file. Returns an array of
  // { start, end } line indices (inclusive start, exclusive end —
  // the range represents the loop body). Handles both:
  //   - block-form `for (...) {`: body = brace-matched block
  //   - callback-form `.map(async (x) => { ... })`: body = the
  //     arrow-function's block body (or a single-expression arrow)
  _findLoopRanges(content, lines) {
    const ranges = [];

    // Walk line-by-line looking for loop openers.
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      for (const { re, kind } of LOOP_OPENERS) {
        const m = line.match(re);
        if (!m) continue;
        if (isInString(line, m.index)) continue;

        if (kind === 'block') {
          // Find the `{` that opens the body. For `for`/`while` this
          // is the first `{` at depth 0 after the matching `)`. For
          // `do`, it's the `{` on this line.
          const braceLine = this._findOpenBraceLine(lines, i);
          if (braceLine < 0) continue;
          const end = this._findMatchingBrace(lines, braceLine);
          if (end < 0) continue;
          ranges.push({ start: braceLine, end });
        } else {
          // Callback form: the body is inside the method's parens.
          // We use the paren-matching approach: from the `(` after the
          // method name, walk forward, balancing parens, and accept
          // either a `{...}` block body or a single-line arrow.
          const end = this._findCallbackEnd(lines, i, m.index + m[0].length - 1);
          if (end < 0) continue;
          ranges.push({ start: i, end });
        }
      }
    }
    return ranges;
  }

  _findOpenBraceLine(lines, startLine) {
    let depthParen = 0;
    let seenOpenParen = false;
    for (let i = startLine; i < lines.length && i < startLine + 30; i += 1) {
      const line = lines[i];
      for (let j = 0; j < line.length; j += 1) {
        const ch = line[j];
        if (isInString(line, j)) continue;
        if (ch === '(') { depthParen += 1; seenOpenParen = true; }
        else if (ch === ')') { depthParen -= 1; }
        else if (ch === '{' && (depthParen === 0 || !seenOpenParen)) {
          return i;
        }
      }
    }
    return -1;
  }

  _findMatchingBrace(lines, braceLine) {
    let depth = 0;
    let started = false;
    for (let i = braceLine; i < lines.length && i < braceLine + 200; i += 1) {
      const line = lines[i];
      for (let j = 0; j < line.length; j += 1) {
        if (isInString(line, j)) continue;
        const ch = line[j];
        if (ch === '{') { depth += 1; started = true; }
        else if (ch === '}') {
          depth -= 1;
          if (started && depth === 0) return i;
        }
      }
    }
    return -1;
  }

  _findCallbackEnd(lines, startLine, openParenIdx) {
    let depth = 0;
    let started = false;
    for (let i = startLine; i < lines.length && i < startLine + 200; i += 1) {
      const line = lines[i];
      const startCol = i === startLine ? openParenIdx : 0;
      for (let j = startCol; j < line.length; j += 1) {
        if (isInString(line, j)) continue;
        const ch = line[j];
        if (ch === '(') { depth += 1; started = true; }
        else if (ch === ')') {
          depth -= 1;
          if (started && depth === 0) return i;
        }
      }
    }
    return -1;
  }

  _enclosingLoopStart(ranges, lineIdx) {
    // Return the start line of the INNERMOST loop that strictly
    // encloses `lineIdx`, or null.
    let best = null;
    for (const r of ranges) {
      if (r.start < lineIdx && lineIdx <= r.end) {
        if (best == null || r.start > best) best = r.start;
      }
    }
    return best;
  }

  _flag(result, name, details) {
    result.addCheck(name, false, details);
    return 1;
  }
}

module.exports = NPlusOneModule;
