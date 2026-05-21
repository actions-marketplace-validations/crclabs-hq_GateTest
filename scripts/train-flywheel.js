#!/usr/bin/env node
/**
 * train-flywheel.js — replay a corpus of (broken → fixed) instances through
 * the deterministic flywheel layers and record which layer (if any) produced
 * the correct fix.
 *
 * Why this exists: the flywheel layers (AST + Rule + Recipe) run BEFORE
 * Claude on every customer fix. Every layer hit = one Anthropic call we
 * didn't make. Over time, as we add rules + distil Claude wins into recipes,
 * the **Claude-call ratio drops**. That ratio over time is the moat metric
 * — when it crosses below 50% on real-world inputs, GateTest is structurally
 * cheaper per fix than any competitor who still pays Claude every time.
 *
 * Run nightly via `.github/workflows/flywheel-train.yml`. Output telemetry
 * feeds `scripts/flywheel-stats.js` and the admin dashboard.
 *
 * Usage:
 *   node scripts/train-flywheel.js --corpus corpus/seed/instances.json
 *   node scripts/train-flywheel.js --corpus <path> [--strict] [--json]
 *
 * Flags:
 *   --corpus <path>  Required. Path to a corpus JSON file (see corpus/seed/README.md).
 *   --strict         Exit non-zero if the Claude-fallthrough ratio is > 95%.
 *                    (Future: compare against previous run, fail on regression.)
 *   --json           Emit machine-readable summary on stdout.
 *
 * Exit codes:
 *   0  — corpus replayed, summary printed
 *   1  — corpus malformed / file missing / no instances loaded
 *   2  — --strict tripped (regression)
 */

'use strict';

const fs   = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------------------
// Flywheel layers — lazy-load so a missing transitive dep (e.g. @babel/parser
// not installed at the root) doesn't crash the harness; we just skip that
// layer and record `unavailable` in the result.
// ---------------------------------------------------------------------------

function loadFlywheel() {
  const layers = { ast: null, rule: null, available: { ast: false, rule: false } };
  try {
    const astFixerPath = require.resolve('../website/app/lib/ast-fixer');
    layers.ast = require(astFixerPath);
    // Probe babel from the ast-fixer's own directory — Babel is a website
    // workspace dep, not a root dep, so a bare require.resolve from this
    // script's directory misses it.
    const fromDir = path.dirname(astFixerPath);
    require.resolve('@babel/parser',    { paths: [fromDir] });
    require.resolve('@babel/traverse',  { paths: [fromDir] });
    require.resolve('@babel/generator', { paths: [fromDir] });
    layers.available.ast = true;
  } catch {
    // AST layer unavailable in this environment — Babel not installed.
  }
  try {
    layers.rule = require('../website/app/lib/rule-based-fixer');
    layers.available.rule = true;
  } catch {
    // Rule layer unavailable.
  }
  return layers;
}

// ---------------------------------------------------------------------------
// Telemetry — write per-instance result to the same JSONL the production
// fix pipeline writes to. Tests and CI override the path via --telemetry-path
// (defaults to the standard ~/.gatetest/telemetry/fix-attempts.jsonl).
// ---------------------------------------------------------------------------

function loadTelemetry() {
  try { return require('../website/app/lib/fix-telemetry'); }
  catch { return null; }
}

// ---------------------------------------------------------------------------
// Corpus loading
// ---------------------------------------------------------------------------

function loadCorpus(corpusPath) {
  if (!fs.existsSync(corpusPath)) {
    throw new Error(`corpus file not found: ${corpusPath}`);
  }
  const raw = fs.readFileSync(corpusPath, 'utf8');
  let envelope;
  try { envelope = JSON.parse(raw); }
  catch (err) { throw new Error(`corpus JSON parse failed: ${err.message}`); }
  const instances = Array.isArray(envelope) ? envelope : envelope.instances;
  if (!Array.isArray(instances) || instances.length === 0) {
    throw new Error(`corpus has no instances`);
  }
  // Validate shape lightly so a typo doesn't ghost-pass.
  for (const inst of instances) {
    if (!inst.id || typeof inst.broken !== 'string' || typeof inst.fixed !== 'string') {
      throw new Error(`corpus instance missing id / broken / fixed: ${JSON.stringify(inst).slice(0, 120)}`);
    }
  }
  return { version: envelope.version || 1, instances };
}

// ---------------------------------------------------------------------------
// Per-instance replay
// ---------------------------------------------------------------------------

/**
 * Try the AST layer on this instance. Returns either:
 *   { layer: 'ast', content, handled: [...] } — fix produced
 *   { layer: 'ast', miss: true, reason }      — layer didn't fire
 *   { layer: 'ast', error: '...' }            — layer crashed
 */
function tryAst(layers, inst) {
  if (!layers.available.ast) return { layer: 'ast', miss: true, reason: 'unavailable' };
  if (!layers.ast.isJsOrTs(inst.file)) return { layer: 'ast', miss: true, reason: 'not-js-or-ts' };
  try {
    const out = layers.ast.applyAstTransforms(inst.broken, inst.file, inst.issues || []);
    if (out && out.content !== inst.broken && out.handled && out.handled.length > 0) {
      return { layer: 'ast', content: out.content, handled: out.handled };
    }
    return { layer: 'ast', miss: true, reason: 'no-transform-fired' };
  } catch (err) {
    return { layer: 'ast', error: err.message || String(err) };
  }
}

function tryRule(layers, inst) {
  if (!layers.available.rule) return { layer: 'rule', miss: true, reason: 'unavailable' };
  try {
    const fixed = layers.rule.tryRuleBasedFix(inst.broken, inst.file, inst.issues || []);
    if (typeof fixed === 'string' && fixed !== inst.broken) {
      return { layer: 'rule', content: fixed, handled: ['rule'] };
    }
    return { layer: 'rule', miss: true, reason: 'no-rule-matched' };
  } catch (err) {
    return { layer: 'rule', error: err.message || String(err) };
  }
}

/**
 * Run one instance through the flywheel. Returns:
 *   {
 *     id, layer: 'ast'|'rule'|'claude'|'unhandled',
 *     accurate: bool,        // produced output === expected fixed content
 *     durationMs, errors: [...]
 *   }
 *
 * "claude" means we WOULD have fallen through to Claude (we don't actually
 * call Claude in this harness — that requires an API key and budget. The
 * training signal is "did the free layers handle it?"; Claude fallthrough
 * is just a count). Set `opts.callClaude` to a function to enable real Claude.
 */
async function replayInstance(layers, inst, opts = {}) {
  const t0 = Date.now();
  const errors = [];

  // AST first.
  const astResult = tryAst(layers, inst);
  if (astResult.error) errors.push(`ast: ${astResult.error}`);
  if (astResult.content !== undefined) {
    return {
      id: inst.id, layer: 'ast', accurate: astResult.content === inst.fixed,
      durationMs: Date.now() - t0, errors,
    };
  }

  // Rule next.
  const ruleResult = tryRule(layers, inst);
  if (ruleResult.error) errors.push(`rule: ${ruleResult.error}`);
  if (ruleResult.content !== undefined) {
    return {
      id: inst.id, layer: 'rule', accurate: ruleResult.content === inst.fixed,
      durationMs: Date.now() - t0, errors,
    };
  }

  // Recipe layer: not implemented here yet — recipes live in
  // website/app/lib/recipe-store-remote.js but need a backing store; the
  // harness will pick them up automatically once `tryRecipe` is added.

  // Claude fallthrough — optionally call Claude if a callable is provided.
  if (typeof opts.callClaude === 'function') {
    try {
      const claudeOut = await opts.callClaude(inst);
      if (typeof claudeOut === 'string') {
        return {
          id: inst.id, layer: 'claude', accurate: claudeOut === inst.fixed,
          durationMs: Date.now() - t0, errors,
        };
      }
    } catch (err) {
      errors.push(`claude: ${err.message || err}`);
    }
  }

  return { id: inst.id, layer: 'unhandled', accurate: false, durationMs: Date.now() - t0, errors };
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function summarise(results) {
  const total = results.length;
  const byLayer = { ast: 0, rule: 0, recipe: 0, claude: 0, unhandled: 0 };
  const accurateByLayer = { ast: 0, rule: 0, recipe: 0, claude: 0 };
  let accurate = 0;
  for (const r of results) {
    byLayer[r.layer] = (byLayer[r.layer] || 0) + 1;
    if (r.accurate) {
      accurate += 1;
      accurateByLayer[r.layer] = (accurateByLayer[r.layer] || 0) + 1;
    }
  }
  const freeLayerHits = byLayer.ast + byLayer.rule + byLayer.recipe;
  const claudeFallthrough = byLayer.claude + byLayer.unhandled;
  const claudeRatio = total === 0 ? 0 : claudeFallthrough / total;
  return {
    total,
    accurate,
    accuracyPct: total === 0 ? 0 : (accurate / total) * 100,
    byLayer,
    accurateByLayer,
    freeLayerHits,
    claudeFallthrough,
    claudeRatio,
    claudeRatioPct: claudeRatio * 100,
  };
}

function printHumanSummary(summary, layers) {
  console.log('\n──────────────────────────────────────────');
  console.log(' Flywheel training run');
  console.log('──────────────────────────────────────────');
  console.log(` Layers loaded:   AST=${layers.available.ast ? 'yes' : 'NO'}  Rule=${layers.available.rule ? 'yes' : 'NO'}`);
  console.log(` Instances:       ${summary.total}`);
  console.log(` Accurate fixes:  ${summary.accurate} (${summary.accuracyPct.toFixed(1)}%)`);
  console.log('');
  console.log(` Layer breakdown (hits / accurate):`);
  console.log(`   AST       ${summary.byLayer.ast || 0} / ${summary.accurateByLayer.ast || 0}`);
  console.log(`   Rule      ${summary.byLayer.rule || 0} / ${summary.accurateByLayer.rule || 0}`);
  console.log(`   Recipe    ${summary.byLayer.recipe || 0} / ${summary.accurateByLayer.recipe || 0}`);
  console.log(`   Claude    ${summary.byLayer.claude || 0} / ${summary.accurateByLayer.claude || 0}  (paid fallback)`);
  console.log(`   Unhandled ${summary.byLayer.unhandled || 0}                  (would also pay Claude)`);
  console.log('');
  console.log(` Claude fallthrough: ${summary.claudeFallthrough} / ${summary.total} (${summary.claudeRatioPct.toFixed(1)}%)`);
  console.log(` Moat metric:        the lower this gets, the further ahead we are.`);
  console.log('──────────────────────────────────────────\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { corpus: null, strict: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--corpus') { args.corpus = argv[++i]; continue; }
    if (a === '--strict') { args.strict = true;     continue; }
    if (a === '--json')   { args.json = true;       continue; }
    if (a === '--help' || a === '-h') { args.help = true; continue; }
  }
  return args;
}

function usage() {
  return `\
Usage: node scripts/train-flywheel.js --corpus <path> [--strict] [--json]

  --corpus <path>  Required. Corpus JSON (see corpus/seed/README.md).
  --strict         Exit 2 if Claude fallthrough > 95%.
  --json           Print summary as JSON instead of human text.
  --help, -h       Show this message.
`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { process.stdout.write(usage()); return 0; }
  if (!args.corpus) { process.stderr.write(usage()); return 1; }

  let corpus;
  try { corpus = loadCorpus(args.corpus); }
  catch (err) { process.stderr.write(`train-flywheel: ${err.message}\n`); return 1; }

  const layers    = loadFlywheel();
  const telemetry = loadTelemetry();

  const results = [];
  for (const inst of corpus.instances) {
    const r = await replayInstance(layers, inst);
    results.push(r);
    if (telemetry && typeof telemetry.recordFixAttempt === 'function') {
      try {
        telemetry.recordFixAttempt({
          layer:        r.layer === 'unhandled' ? null : r.layer,
          success:      r.accurate,
          issueRuleKey: (inst.issues && inst.issues[0]) || inst.id,
          module:       'flywheel-training',
          durationMs:   r.durationMs,
        });
      } catch { /* telemetry is best-effort */ }
    }
  }

  const summary = summarise(results);
  if (args.json) {
    process.stdout.write(JSON.stringify({ summary, results }, null, 2) + '\n');
  } else {
    printHumanSummary(summary, layers);
  }

  if (args.strict && summary.claudeRatioPct > 95) {
    process.stderr.write(`train-flywheel: STRICT — Claude fallthrough ${summary.claudeRatioPct.toFixed(1)}% > 95%\n`);
    return 2;
  }
  return 0;
}

// Exports for tests.
module.exports = {
  loadFlywheel,
  loadCorpus,
  tryAst,
  tryRule,
  replayInstance,
  summarise,
};

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((err) => {
    process.stderr.write(`train-flywheel: unhandled: ${err.stack || err}\n`);
    process.exit(1);
  });
}
