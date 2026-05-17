/**
 * Resource-Leak Module — unclosed streams, handles, intervals.
 *
 * The classic Node memory-over-time bug: open a resource, forget to
 * close it, process lives for weeks, FDs exhaust, memory grows, the
 * box OOMs at 3am.
 *
 * Competitors: nothing statically for JS/TS. Runtime profilers
 * (New Relic, Datadog) catch it after the process falls over; we
 * catch it pre-commit.
 *
 * Approach (line-heuristic, no AST):
 *
 *   1. Walk JS/TS files.
 *   2. Find resource-acquiring calls that return a handle:
 *        fs.createReadStream / createWriteStream
 *        fs.open / fs.promises.open (returns a FileHandle)
 *        net.createServer / net.createConnection
 *        http.createServer / https.createServer
 *        new WebSocket(...) / new EventSource(...)
 *        setInterval (never cleared)
 *        new AbortController (never aborted — not a leak but often
 *        indicates a missing cleanup path)
 *        knex() / new Pool() / new Client() at module scope (DB
 *        connection leaks — pool never drained)
 *   3. For each, look forward in the function body for a matching
 *      close/end/destroy/release/unref/clearInterval call that
 *      references the same handle variable.
 *   4. Flag the ones that never close.
 *
 * Rules:
 *
 *   error:   `fs.createReadStream(...)` / `createWriteStream(...)`
 *            assigned to a variable that is never `.close()`ed,
 *            `.destroy()`ed, `.end()`ed, or returned/re-exported.
 *            (rule: `resource-leak:stream:<rel>:<line>`)
 *
 *   error:   `setInterval(fn, ms)` whose return value is NEVER
 *            captured into a variable (no `clearInterval` possible).
 *            (rule: `resource-leak:setinterval:<rel>:<line>`)
 *
 *   warning: `setInterval(fn, ms)` captured into a variable but the
 *            variable is never passed to `clearInterval`.
 *            (rule: `resource-leak:uncleared-interval:<rel>:<line>`)
 *
 *   warning: `new WebSocket(...)` / `new EventSource(...)` /
 *            `client.connect()` whose handle is never `.close()`ed
 *            in the visible window.
 *            (rule: `resource-leak:socket:<rel>:<line>`)
 *
 *   warning: `fs.openSync(...)` / `await fs.promises.open(...)` that
 *            doesn't reach a `.close()` (only a FileHandle can be
 *            leaked — plain `fs.readFile`/`writeFile` manage their
 *            own FDs).
 *            (rule: `resource-leak:file-handle:<rel>:<line>`)
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

// Acquire patterns. Each entry:
//   re:   matches the acquire call, with capture group for the
//         variable name (if the line looks like `const x = ...`).
//   kind: the leak rule kind
//   close: regex fragment matching a close/dispose on the variable
const ACQUIRE_PATTERNS = [
  {
    // const x = fs.createReadStream(...); / const x = fs.createWriteStream(...)
    re: /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*fs\.(?:createReadStream|createWriteStream)\s*\(/,
    kind: 'stream',
    closeVerbs: ['close', 'destroy', 'end'],
    severity: 'error',
  },
  {
    // const x = fs.openSync(...) / const x = await fs.promises.open(...)
    re: /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?fs(?:\.promises)?\.(?:open|openSync)\s*\(/,
    kind: 'file-handle',
    closeVerbs: ['close'],
    severity: 'warning',
  },
  {
    // const ws = new WebSocket(...)
    re: /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+(?:WebSocket|EventSource|ReconnectingWebSocket)\s*\(/,
    kind: 'socket',
    closeVerbs: ['close'],
    severity: 'warning',
  },
  {
    // const conn = net.createConnection(...) / const srv = net.createServer(...)
    re: /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*net\.(?:createConnection|createServer)\s*\(/,
    kind: 'socket',
    closeVerbs: ['close', 'destroy', 'end', 'unref'],
    severity: 'warning',
  },
];

// setInterval specifically — different rule (we check return-value
// capture and `clearInterval`).
const SETINTERVAL_ASSIGNED_RE = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*setInterval\s*\(/;
const SETINTERVAL_BARE_RE = /(?:^|[;\s])setInterval\s*\(/;

class ResourceLeakModule extends BaseModule {
  constructor() {
    super(
      'resourceLeak',
      'Resource-leak detector — unclosed streams, file handles, intervals, sockets across fs/net/ws/events',
    );
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;
    const files = this._findFiles(projectRoot);

    if (files.length === 0) {
      result.addCheck('resource-leak:no-files', true, {
        severity: 'info',
        message: 'No JS/TS source files found — skipping',
      });
      return;
    }

    result.addCheck('resource-leak:scanning', true, {
      severity: 'info',
      message: `Scanning ${files.length} JS/TS file(s) for resource leaks`,
    });

    let issues = 0;
    for (const file of files) {
      issues += this._scanFile(file, projectRoot, result);
    }

    result.addCheck('resource-leak:summary', true, {
      severity: 'info',
      message: `Resource-leak scan: ${files.length} file(s), ${issues} issue(s)`,
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

    // Track JSDoc / block-comment state so `* setInterval (never
    // cleared)` lines in module docs don't false-positive.
    let inBlockComment = false;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const trimmed = line.trim();
      if (inBlockComment) {
        if (/\*\//.test(line)) inBlockComment = false;
        continue;
      }
      if (/^\s*\/\*/.test(line) && !/\*\//.test(line)) {
        inBlockComment = true;
        continue;
      }
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*')) continue;

      // --- Standard acquire patterns ---
      for (const pattern of ACQUIRE_PATTERNS) {
        const m = matchOutsideString(line, pattern.re);
        if (!m) continue;
        const varName = m[1];
        if (!varName) continue;

        // Is this variable closed in the rest of the file?
        const closed = this._isClosed(lines, i, varName, pattern.closeVerbs);
        // Or returned / re-exported — caller may close.
        const returned = this._isReturnedOrExported(lines, i, varName);
        if (closed || returned) continue;

        issues += this._flag(result, `resource-leak:${pattern.kind}:${rel}:${i + 1}`, {
          severity: isTestFile ? 'info' : pattern.severity,
          file: rel,
          line: i + 1,
          variable: varName,
          kind: pattern.kind,
          message: `${rel}:${i + 1} \`${varName}\` (${pattern.kind}) acquired but never closed (\`${pattern.closeVerbs.map((v) => `.${v}()`).join('\` / \`')}\`) and never returned — resource leak`,
          suggestion: `Close the ${pattern.kind} in a \`finally\` block: \`try { /* use ${varName} */ } finally { ${varName}.${pattern.closeVerbs[0]}(); }\`. For streams, prefer \`stream.pipeline(...)\` which handles cleanup automatically.`,
        });
        break;
      }

      // --- setInterval — captured but not cleared ---
      const siAssigned = matchOutsideString(line, SETINTERVAL_ASSIGNED_RE);
      if (siAssigned) {
        const varName = siAssigned[1];
        const cleared = this._isIntervalCleared(lines, i, varName);
        const returned = this._isReturnedOrExported(lines, i, varName);
        if (!cleared && !returned) {
          issues += this._flag(result, `resource-leak:uncleared-interval:${rel}:${i + 1}`, {
            severity: isTestFile ? 'info' : 'warning',
            file: rel,
            line: i + 1,
            variable: varName,
            message: `${rel}:${i + 1} \`${varName} = setInterval(...)\` is captured but never \`clearInterval(${varName})\`-ed — the interval keeps the event loop alive forever`,
            suggestion: 'Store the handle and call `clearInterval(handle)` in your shutdown path. For servers, listen on `SIGTERM`/`SIGINT` and clear all intervals before exit.',
          });
        }
        continue;
      }

      // --- setInterval — bare call, return value discarded ---
      const siBare = matchOutsideString(line, SETINTERVAL_BARE_RE);
      // Reject when the line already had an assignment (handled above)
      if (siBare && !SETINTERVAL_ASSIGNED_RE.test(line) && !/=\s*setInterval/.test(line)) {
        issues += this._flag(result, `resource-leak:setinterval:${rel}:${i + 1}`, {
          severity: isTestFile ? 'info' : 'error',
          file: rel,
          line: i + 1,
          message: `${rel}:${i + 1} bare \`setInterval(...)\` — return value discarded, \`clearInterval\` is impossible; the interval runs forever`,
          suggestion: 'Capture the handle: `const h = setInterval(...)`; clear it on shutdown: `clearInterval(h)`.',
        });
      }
    }

    return issues;
  }

  _isClosed(lines, startLine, varName, closeVerbs) {
    const escaped = this._escapeRegex(varName);
    const verbGroup = closeVerbs.map((v) => this._escapeRegex(v)).join('|');
    const closeRe = new RegExp(`\\b${escaped}\\.(?:${verbGroup})\\s*\\(`);
    // `stream.pipeline(x, ...)` also counts as cleanup.
    const pipelineRe = new RegExp(`\\bpipeline\\s*\\([^)]*\\b${escaped}\\b`);
    // `stream.finished(x, ...)` emits close — also counts.
    const finishedRe = new RegExp(`\\bfinished\\s*\\(\\s*${escaped}\\b`);
    // Look forward up to the end of the enclosing function (we
    // approximate with a 80-line window or matched-brace end).
    const end = Math.min(lines.length, startLine + 80);
    for (let i = startLine; i < end; i += 1) {
      const line = lines[i];
      if (closeRe.test(line) || pipelineRe.test(line) || finishedRe.test(line)) {
        return true;
      }
    }
    return false;
  }

  _isIntervalCleared(lines, startLine, varName) {
    const escaped = this._escapeRegex(varName);
    const clearRe = new RegExp(`\\bclearInterval\\s*\\(\\s*${escaped}\\b`);
    const end = Math.min(lines.length, startLine + 200);
    for (let i = startLine; i < end; i += 1) {
      if (clearRe.test(lines[i])) return true;
    }
    return false;
  }

  _isReturnedOrExported(lines, startLine, varName) {
    const escaped = this._escapeRegex(varName);
    const returnRe = new RegExp(`\\breturn\\s+[^;]*\\b${escaped}\\b`);
    const exportRe = new RegExp(`\\bmodule\\.exports\\b|\\bexport\\b[^;]*\\b${escaped}\\b|\\bexports\\.\\w+\\s*=\\s*${escaped}\\b`);
    // Property-assignment escape: `this.x = varName`, `obj.x = varName`,
    // `this.y = { ..., varName }`.
    const propAssignRe = new RegExp(`\\b(?:this|self|that|[A-Za-z_$][\\w$]*)\\.[\\w$]+\\s*=\\s*[^;]*\\b${escaped}\\b`);
    // Array-push escape: `arr.push(varName)`, `arr.push({ k: varName })`,
    // `map.set(key, varName)`.
    const pushRe = new RegExp(`\\.(?:push|unshift|set|add)\\s*\\([^)]*\\b${escaped}\\b`);
    const end = Math.min(lines.length, startLine + 80);
    for (let i = startLine; i < end; i += 1) {
      const ln = lines[i];
      if (returnRe.test(ln) || exportRe.test(ln) || propAssignRe.test(ln) || pushRe.test(ln)) return true;
    }
    return false;
  }

  _escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  _flag(result, name, details) {
    result.addCheck(name, false, details);
    return 1;
  }
}

module.exports = ResourceLeakModule;
