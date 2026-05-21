#!/usr/bin/env node
/**
 * mine-mutations.js — generate an UNLIMITED-supply training corpus by
 * mutating real source files in this repo.
 *
 * Why: the seed corpus (corpus/seed/instances.json) is 10 hand-curated
 * instances. Replaying the same 10 forever isn't training — it's
 * measurement. For real 24/7 training the flywheel needs FRESH instances
 * every cycle so we're not just memorising one fixture set.
 *
 * How: use the existing mutation engine (src/core/mutation-engine.js)
 * to flip operators in real source lines. Each (file, mutation candidate)
 * becomes a synthetic training instance where:
 *   broken = file content with the mutation applied
 *   fixed  = original file content
 *
 * This is a free, unlimited corpus that's also REPRESENTATIVE because the
 * lines are real production code, not synthetic snippets. Every nightly
 * run sees a different randomised subset of mutations, so we're testing
 * the deterministic layers against thousands of variations a week.
 *
 * Usage:
 *   node scripts/mine-mutations.js --root src/ --out corpus/mined-mutations.json
 *   node scripts/mine-mutations.js --root src/modules/ --files 30 --per-file 3
 *
 * Flags:
 *   --root <dir>      Directory to mine. Default: src/
 *   --out  <path>     Output corpus JSON. Default: corpus/mined-mutations.json
 *   --files <n>       Max files to sample. Default: 40.
 *   --per-file <n>    Max mutation candidates per file. Default: 3.
 *   --seed <n>        Random seed for reproducibility. Default: time-based.
 *
 * The output is identical in shape to corpus/seed/instances.json — the
 * existing train-flywheel.js consumes it without changes.
 */

'use strict';

const fs   = require('node:fs');
const path = require('node:path');
const { generateMutations, applyCandidate } = require('../src/core/mutation-engine');

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

const SOURCE_EXTS = new Set(['.js', '.mjs', '.cjs', '.jsx']);
const EXCLUDE_DIRS = new Set([
  'node_modules', '.git', '.next', 'build', 'dist', 'coverage',
  'corpus', 'tests', '__tests__', 'fixtures', '.flywheel-home',
]);

function walk(root, out) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch { return; }
  for (const ent of entries) {
    const p = path.join(root, ent.name);
    if (ent.isDirectory()) {
      if (EXCLUDE_DIRS.has(ent.name)) continue;
      walk(p, out);
    } else if (ent.isFile()) {
      const ext = path.extname(ent.name).toLowerCase();
      if (SOURCE_EXTS.has(ext)) out.push(p);
    }
  }
}

// ---------------------------------------------------------------------------
// Seeded random — deterministic when --seed is provided.
// xorshift32 — small, fast, good-enough for sampling.
// ---------------------------------------------------------------------------

function makeRng(seed) {
  let s = (seed >>> 0) || 0x9e3779b9;
  return function rng() {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17; s >>>= 0;
    s ^= s << 5;  s >>>= 0;
    return s / 0xffffffff;
  };
}

function shuffleInPlace(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    root: 'src/',
    out:  'corpus/mined-mutations.json',
    files: 40,
    perFile: 3,
    seed: Date.now() & 0x7fffffff,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root')     { args.root = argv[++i]; continue; }
    if (a === '--out')      { args.out = argv[++i]; continue; }
    if (a === '--files')    { args.files = Number(argv[++i]) || args.files; continue; }
    if (a === '--per-file') { args.perFile = Number(argv[++i]) || args.perFile; continue; }
    if (a === '--seed')     { args.seed = Number(argv[++i]) || args.seed; continue; }
    if (a === '--help' || a === '-h') { args.help = true; continue; }
  }
  return args;
}

function usage() {
  return `\
Usage: node scripts/mine-mutations.js [options]

  --root <dir>      Directory to mine. Default: src/
  --out  <path>     Output corpus JSON. Default: corpus/mined-mutations.json
  --files <n>       Max files to sample. Default: 40.
  --per-file <n>    Max mutation candidates per file. Default: 3.
  --seed <n>        Random seed for reproducibility.
  --help, -h        Show this message.
`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { process.stdout.write(usage()); return 0; }

  const rng = makeRng(args.seed);

  // Collect all candidate files under root.
  const allFiles = [];
  walk(args.root, allFiles);
  if (allFiles.length === 0) {
    process.stderr.write(`mine-mutations: no source files found under ${args.root}\n`);
    return 1;
  }

  // Randomly sample up to `args.files` files.
  shuffleInPlace(allFiles, rng);
  const picked = allFiles.slice(0, args.files);

  const instances = [];
  for (const filePath of picked) {
    let content;
    try { content = fs.readFileSync(filePath, 'utf8'); } catch { continue; }
    if (!content || content.length < 50) continue;

    const candidates = generateMutations(content, { maxPerFile: args.perFile * 4 });
    if (candidates.length === 0) continue;

    shuffleInPlace(candidates, rng);
    const chosen = candidates.slice(0, args.perFile);

    for (const c of chosen) {
      const broken = applyCandidate(content, c);
      if (broken === content) continue; // mutation didn't change anything
      const rel = path.relative(process.cwd(), filePath);
      instances.push({
        id: `mutation-${path.basename(filePath, path.extname(filePath))}-L${c.lineNumber}-${c.mutation.id || 'op'}`,
        language: 'javascript',
        file: rel,
        // Issue string in the shape rule/AST layers see: "mutation:<op>:file:line"
        // The current free layers won't match this synthetic key — that's
        // intentional. The metric is "would Claude be called?" not "do our
        // rules already cover synthetic mutations?". Future rules trained
        // ON mutation patterns will pick these up.
        issues: [`mutation:${c.mutation.id || 'op'}:${rel}:${c.lineNumber}`],
        broken,
        fixed: content,
        note: `Synthetic mutation: ${c.mutation.id || 'op'} on line ${c.lineNumber}`,
      });
    }
  }

  if (instances.length === 0) {
    process.stderr.write(`mine-mutations: produced 0 instances from ${picked.length} files — nothing to write\n`);
    return 1;
  }

  // Ensure parent dir.
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  const envelope = {
    version: 1,
    generatedAt: new Date().toISOString(),
    seed: args.seed,
    source: `mined from ${args.root} — ${picked.length} files`,
    instances,
  };
  fs.writeFileSync(args.out, JSON.stringify(envelope, null, 2) + '\n');

  process.stdout.write(`mine-mutations: wrote ${instances.length} instances to ${args.out}\n`);
  return 0;
}

module.exports = { walk, parseArgs, main };

if (require.main === module) {
  try { process.exit(main()); }
  catch (err) { process.stderr.write(`mine-mutations: ${err.stack || err}\n`); process.exit(1); }
}
