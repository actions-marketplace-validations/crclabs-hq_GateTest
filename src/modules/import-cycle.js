/**
 * Import-Cycle / Circular-Dependency Detector Module.
 *
 * Circular imports are the silent killer of large JS/TS codebases.
 * They don't crash at build time (webpack/esbuild/Next.js all
 * tolerate them with varying degrees of correctness), but at
 * runtime one of the two modules wins the race and the other gets
 * an `undefined` for the symbol it imported. The bug reproduces
 * randomly — test order, hot-reload state, module-cache warmth —
 * and the fix is always a refactor because you can't patch a
 * circular dependency without breaking the cycle.
 *
 * Why this matters more than ever:
 *
 *   - Next.js 16 App Router splits server/client boundaries; a
 *     cycle that was fine in v12 now yields "Cannot read property
 *     of undefined" on the server-rendered side.
 *   - ES modules are strictly live bindings. A cycle that CJS
 *     would silently paper over (via the mutable `module.exports`
 *     object) becomes a TDZ error under ESM.
 *   - TypeScript `isolatedModules` + `--verbatimModuleSyntax`
 *     turn a cycle into a hard error if any type is re-exported.
 *
 * We build an import graph from JS/TS source files, run Tarjan's
 * SCC algorithm to find every strongly-connected component of size
 * ≥ 2 (= a cycle), and report one error per distinct cycle. Single-
 * node self-loops (file imports itself) are also flagged because
 * they're always bugs.
 *
 * Design choices:
 *
 *   - Type-only imports (`import type { X } from`, `import { type X }`)
 *     are erased at build time. They don't create runtime cycles.
 *     Skipped.
 *
 *   - Function-scoped `require(...)` / dynamic `import(...)` expressions
 *     are LAZY. They defer resolution to call time, which is the
 *     standard workaround for breaking a cycle. Skipped.
 *
 *   - Only relative imports (`./`, `../`) form cycles. Bare-package
 *     imports (`react`, `lodash`) are external and skipped.
 *
 *   - Resolved to real files via `path.resolve` + extension-retry
 *     (`./x` → `./x.ts`, `./x.tsx`, `./x/index.ts`, etc.). If we
 *     can't resolve, we skip silently — don't false-positive on
 *     path-alias configs (`@/components/x`) that we can't read
 *     without a tsconfig parse.
 *
 * Rules:
 *
 *   error:   runtime cycle of 2+ files. One error per distinct SCC.
 *            (rule: `import-cycle:cycle:<a>|<b>|...|<a>`)
 *
 *   error:   file imports itself (self-loop).
 *            (rule: `import-cycle:self-loop:<rel>`)
 *
 *   info:    summary — number of files, edges, cycles.
 *            (rule: `import-cycle:summary`)
 *
 * Suppressions:
 *   - `// import-cycle-ok` on the import line (tells us this
 *     specific edge is expected and can be ignored for cycle-
 *     formation).
 *   - Test / spec / fixture paths downgrade error → warning.
 *
 * Competitors:
 *   - `madge --circular` (standalone CLI, separate install, no
 *     gate integration).
 *   - `eslint-plugin-import/no-cycle` (opt-in, needs per-project
 *     config, slow, and doesn't handle TS path aliases out of the
 *     box).
 *   - `dependency-cruiser` (heavy config, enterprise-pitch).
 *   - TypeScript itself catches NOTHING — tsc happily compiles
 *     circular modules.
 *   - Nothing unifies JS + TS + cycle reporting + gate-native
 *     enforcement + suppression markers at one call site.
 *
 * TODO(gluecron): host-neutral — pure static scan.
 */

const BaseModule = require('./base-module');
const fs = require('fs');
const path = require('path');

const EXCLUDE_DIRS = new Set([
  'node_modules', '.git', '.claude', 'dist', 'build', 'coverage', '.gatetest',
  '.next', 'out', 'target', 'vendor', '.terraform', '__pycache__',
]);

const JS_EXTS = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts'];
const JS_EXT_SET = new Set(JS_EXTS);

const TEST_PATH_RE = /(?:^|\/)(?:test|tests|__tests__|spec|specs|e2e|fixtures?|stories)\//i;
const TEST_FILE_RE = /\.(?:test|spec|e2e|stories)\.[a-z0-9]+$/i;

const SUPPRESS_RE = /\bimport-cycle-ok\b/;

// Static import / export / require / dynamic-import regexes.
// We deliberately keep these line-level and conservative.
const IMPORT_FROM_RE = /^\s*import\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/;
const IMPORT_TYPE_RE = /^\s*import\s+type\b/;
const EXPORT_FROM_RE = /^\s*export\s+(?:type\s+)?(?:\*|\{[\s\S]*?\})\s+from\s+['"]([^'"]+)['"]/;
const EXPORT_TYPE_RE = /^\s*export\s+type\b/;
const REQUIRE_RE = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/;

class ImportCycleModule extends BaseModule {
  constructor() {
    super('importCycle', 'Import-cycle detector — catches circular dependencies that cause runtime TDZ / undefined-import bugs');
  }

  async run(result, config) {
    const projectRoot = (config && config.projectRoot) || process.cwd();
    const files = this._collect(projectRoot);

    if (files.length === 0) {
      result.addCheck('import-cycle:no-files', true, {
        severity: 'info',
        message: 'No source files to scan',
      });
      return;
    }

    result.addCheck('import-cycle:scanning', true, {
      severity: 'info',
      message: `Scanning ${files.length} file(s)`,
      fileCount: files.length,
    });

    // Build import graph: Map<absPath, Set<absPath>>
    const graph = new Map();
    const fileSet = new Set(files);
    let edgeCount = 0;

    for (const abs of files) {
      const edges = this._edgesFor(abs, fileSet);
      graph.set(abs, edges);
      edgeCount += edges.size;
    }

    // Find SCCs via Tarjan's algorithm (iterative, avoids stack
    // overflow on large graphs).
    const sccs = this._tarjan(graph);

    // A cycle = SCC with 2+ nodes, OR a single-node SCC that has
    // an edge to itself.
    const cycles = [];
    const selfLoops = [];
    for (const scc of sccs) {
      if (scc.length >= 2) {
        cycles.push(scc);
      } else if (scc.length === 1) {
        const n = scc[0];
        if (graph.get(n)?.has(n)) selfLoops.push(n);
      }
    }

    let issues = 0;

    // Report self-loops
    for (const abs of selfLoops) {
      const rel = path.relative(projectRoot, abs).replace(/\\/g, '/');
      const isTest = TEST_PATH_RE.test(rel) || TEST_FILE_RE.test(rel);
      result.addCheck(`import-cycle:self-loop:${rel}`, false, {
        severity: isTest ? 'warning' : 'error',
        message: `${rel} imports itself — runtime undefined import`,
        file: rel,
      });
      issues += 1;
    }

    // Report cycles. Rotate each cycle to start at the lexicographically
    // smallest member for a stable rule name, and include a closing
    // repeat for human readability.
    for (const scc of cycles) {
      const ordered = this._orderCycle(scc, graph, projectRoot);
      const rels = ordered.map((a) => path.relative(projectRoot, a).replace(/\\/g, '/'));
      const isTest = rels.some((r) => TEST_PATH_RE.test(r) || TEST_FILE_RE.test(r));
      const display = [...rels, rels[0]].join(' -> ');
      const ruleKey = rels.join('|');
      result.addCheck(`import-cycle:cycle:${ruleKey}`, false, {
        severity: isTest ? 'warning' : 'error',
        message: `Import cycle (${rels.length} files): ${display}`,
        files: rels,
      });
      issues += 1;
    }

    result.addCheck('import-cycle:summary', true, {
      severity: 'info',
      message: `${files.length} file(s) scanned, ${edgeCount} edge(s), ${cycles.length} cycle(s), ${selfLoops.length} self-loop(s)`,
      fileCount: files.length,
      edgeCount,
      cycleCount: cycles.length,
      selfLoopCount: selfLoops.length,
    });
  }

  _collect(root) {
    const out = [];
    const walk = (dir) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (EXCLUDE_DIRS.has(e.name)) continue;
        if (e.name.startsWith('.') && e.name !== '.') continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          walk(full);
        } else if (e.isFile()) {
          const ext = path.extname(e.name).toLowerCase();
          if (JS_EXT_SET.has(ext)) out.push(full);
        }
      }
    };
    walk(root);
    return out;
  }

  /**
   * Extract relative imports from a file and resolve them to
   * absolute file paths that exist in `fileSet`.
   */
  _edgesFor(absPath, fileSet) {
    const edges = new Set();
    let text;
    try {
      text = fs.readFileSync(absPath, 'utf-8');
    } catch {
      return edges;
    }
    if (text.length > 2 * 1024 * 1024) return edges;

    const lines = text.split('\n');
    const dir = path.dirname(absPath);

    for (let i = 0; i < lines.length; i += 1) {
      const raw = lines[i];
      if (SUPPRESS_RE.test(raw)) continue;

      // Strip line comments (keep simple — don't handle every edge
      // case; block-comment noise is fine because the regexes need
      // line-start anchors or explicit patterns).
      const lineNoComment = this._stripLineComment(raw);

      // Skip type-only imports / exports
      if (IMPORT_TYPE_RE.test(lineNoComment)) continue;
      if (EXPORT_TYPE_RE.test(lineNoComment)) continue;

      const mImp = IMPORT_FROM_RE.exec(lineNoComment);
      if (mImp) {
        this._recordEdge(mImp[1], dir, fileSet, edges, lineNoComment);
        continue;
      }
      const mExp = EXPORT_FROM_RE.exec(lineNoComment);
      if (mExp) {
        this._recordEdge(mExp[1], dir, fileSet, edges, lineNoComment);
        continue;
      }
      // Top-level require — module-scope only. If it's inside a
      // function body, it's lazy and doesn't form a cycle.
      if (this._isTopLevel(lines, i)) {
        const mReq = REQUIRE_RE.exec(lineNoComment);
        if (mReq) this._recordEdge(mReq[1], dir, fileSet, edges, lineNoComment);
      }
    }

    return edges;
  }

  _recordEdge(spec, dir, fileSet, edges, _line) {
    // Only relative imports form cycles
    if (!spec.startsWith('./') && !spec.startsWith('../') && spec !== '.' && spec !== '..') return;
    const resolved = this._resolveImport(dir, spec, fileSet);
    if (resolved) edges.add(resolved);
  }

  _resolveImport(dir, spec, fileSet) {
    const base = path.resolve(dir, spec);
    // Direct hit
    if (fileSet.has(base)) return base;
    // Try extensions
    for (const ext of JS_EXTS) {
      const cand = base + ext;
      if (fileSet.has(cand)) return cand;
    }
    // Try /index.<ext>
    for (const ext of JS_EXTS) {
      const cand = path.join(base, 'index' + ext);
      if (fileSet.has(cand)) return cand;
    }
    return null;
  }

  _stripLineComment(line) {
    // Find `//` not inside a string literal.
    let inStr = null;
    for (let j = 0; j < line.length; j += 1) {
      const ch = line[j];
      if (inStr) {
        if (ch === '\\') { j += 1; continue; }
        if (ch === inStr) inStr = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        inStr = ch;
        continue;
      }
      if (ch === '/' && line[j + 1] === '/') return line.slice(0, j);
    }
    return line;
  }

  /**
   * A simple heuristic: the line is "top level" if its indentation
   * is 0 (no leading whitespace). This is imperfect but in practice
   * catches the case we care about: the ambient module-scope
   * `const x = require('./y')` that forms a real cycle, without
   * false-positiving on lazy in-function `require(...)` calls.
   */
  _isTopLevel(lines, i) {
    const line = lines[i];
    if (!line) return false;
    const m = line.match(/^(\s*)/);
    return m && m[1].length === 0;
  }

  /**
   * Iterative Tarjan's SCC. Returns an array of SCCs (each SCC is
   * an array of nodes).
   */
  _tarjan(graph) {
    const index = new Map();
    const lowlink = new Map();
    const onStack = new Set();
    const stack = [];
    const sccs = [];
    let idx = 0;

    const nodes = Array.from(graph.keys());

    // Iterative DFS with a per-node iterator state
    const call = (startNode) => {
      const workStack = [{ node: startNode, iter: graph.get(startNode).values(), state: 'enter' }];
      while (workStack.length > 0) {
        const frame = workStack[workStack.length - 1];
        const { node } = frame;

        if (frame.state === 'enter') {
          index.set(node, idx);
          lowlink.set(node, idx);
          idx += 1;
          stack.push(node);
          onStack.add(node);
          frame.state = 'iter';
        }

        let nextFound = false;
        for (;;) {
          const next = frame.iter.next();
          if (next.done) break;
          const w = next.value;
          if (!graph.has(w)) continue; // external or unresolved
          if (!index.has(w)) {
            workStack.push({ node: w, iter: graph.get(w).values(), state: 'enter', parent: node });
            nextFound = true;
            break;
          }
          if (onStack.has(w)) {
            lowlink.set(node, Math.min(lowlink.get(node), index.get(w)));
          }
        }
        if (nextFound) continue;

        // Root of SCC?
        if (lowlink.get(node) === index.get(node)) {
          const scc = [];
          for (;;) {
            const w = stack.pop();
            onStack.delete(w);
            scc.push(w);
            if (w === node) break;
          }
          sccs.push(scc);
        }

        // Propagate lowlink to parent
        workStack.pop();
        if (workStack.length > 0) {
          const parent = workStack[workStack.length - 1].node;
          lowlink.set(parent, Math.min(lowlink.get(parent), lowlink.get(node)));
        }
      }
    };

    for (const n of nodes) {
      if (!index.has(n)) call(n);
    }

    return sccs;
  }

  /**
   * Rotate the cycle so it starts at the lexicographically smallest
   * member (stable key for the rule name). Also try to order around
   * the actual cycle direction using the graph edges.
   */
  _orderCycle(scc, graph, projectRoot) {
    const rels = scc.map((a) => ({ abs: a, rel: path.relative(projectRoot, a).replace(/\\/g, '/') }));
    rels.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
    const start = rels[0].abs;

    // Walk edges to produce a traversal order from `start`
    const visited = new Set([start]);
    const order = [start];
    const sccSet = new Set(scc);
    let cur = start;
    while (order.length < scc.length) {
      const outs = graph.get(cur) || new Set();
      let picked = null;
      for (const n of outs) {
        if (sccSet.has(n) && !visited.has(n)) {
          picked = n;
          break;
        }
      }
      if (!picked) {
        // Fallback — append any remaining node
        for (const r of rels) {
          if (!visited.has(r.abs)) { picked = r.abs; break; }
        }
      }
      if (!picked) break;
      visited.add(picked);
      order.push(picked);
      cur = picked;
    }
    return order;
  }
}

module.exports = ImportCycleModule;
