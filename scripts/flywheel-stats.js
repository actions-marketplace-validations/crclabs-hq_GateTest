#!/usr/bin/env node
/**
 * flywheel-stats.js — read the telemetry JSONL written by the production
 * fix pipeline + the training harness and aggregate it into the moat
 * metrics we care about:
 *
 *   - Claude-call ratio (lower = better, the headline metric)
 *   - Layer hit-rate breakdown (ast / rule / recipe / claude / null)
 *   - 7-day rolling trend (so a single noisy day doesn't scare anyone)
 *   - Top successful rule keys (which rules are paying off)
 *
 * Usage:
 *   node scripts/flywheel-stats.js                   # human summary
 *   node scripts/flywheel-stats.js --json            # machine-readable
 *   node scripts/flywheel-stats.js --path <file>     # alternate JSONL path
 *
 * The default JSONL path is `~/.gatetest/telemetry/fix-attempts.jsonl`
 * (same path the production telemetry module writes to). Records are
 * single-line JSON objects with at minimum: { layer, success, durationMs,
 * ruleKey, ts }.
 *
 * Read-only — never modifies the JSONL.
 */

'use strict';

const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');

const DEFAULT_PATH = path.join(os.homedir(), '.gatetest', 'telemetry', 'fix-attempts.jsonl');
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function readEntries(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8');
  const entries = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { entries.push(JSON.parse(trimmed)); }
    catch { /* skip malformed lines — telemetry is best-effort */ }
  }
  return entries;
}

function aggregate(entries, opts = {}) {
  const now = opts.now || Date.now();
  const cutoff = now - SEVEN_DAYS_MS;

  const all = { total: 0, byLayer: {}, accurateByLayer: {}, accurate: 0 };
  const recent = { total: 0, byLayer: {}, accurateByLayer: {}, accurate: 0 };
  const ruleKeyHits = {};

  for (const e of entries) {
    if (typeof e !== 'object' || e === null) continue;
    const layer = e.layer == null ? 'unhandled' : String(e.layer);
    const success = !!e.success;

    all.total += 1;
    all.byLayer[layer] = (all.byLayer[layer] || 0) + 1;
    if (success) {
      all.accurate += 1;
      all.accurateByLayer[layer] = (all.accurateByLayer[layer] || 0) + 1;
    }

    const ts = typeof e.ts === 'number' ? e.ts : Date.parse(e.ts || '');
    if (Number.isFinite(ts) && ts >= cutoff) {
      recent.total += 1;
      recent.byLayer[layer] = (recent.byLayer[layer] || 0) + 1;
      if (success) {
        recent.accurate += 1;
        recent.accurateByLayer[layer] = (recent.accurateByLayer[layer] || 0) + 1;
      }
    }

    // Production telemetry writes `issueRuleKey`; older synthetic records
    // may use `ruleKey`. Accept both.
    const ruleKey = e.issueRuleKey || e.ruleKey;
    if (success && ruleKey) {
      ruleKeyHits[ruleKey] = (ruleKeyHits[ruleKey] || 0) + 1;
    }
  }

  function claudeRatio(window) {
    const paid = (window.byLayer.claude || 0) + (window.byLayer.unhandled || 0);
    return window.total === 0 ? 0 : paid / window.total;
  }

  return {
    all: {
      ...all,
      claudeRatioPct: claudeRatio(all) * 100,
      accuracyPct: all.total === 0 ? 0 : (all.accurate / all.total) * 100,
    },
    recent7d: {
      ...recent,
      claudeRatioPct: claudeRatio(recent) * 100,
      accuracyPct: recent.total === 0 ? 0 : (recent.accurate / recent.total) * 100,
    },
    topRules: Object.entries(ruleKeyHits)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([ruleKey, hits]) => ({ ruleKey, hits })),
  };
}

function printHuman(stats, sourcePath) {
  console.log('\n──────────────────────────────────────────');
  console.log(' GateTest Flywheel — telemetry stats');
  console.log('──────────────────────────────────────────');
  console.log(` Source:  ${sourcePath}`);
  console.log(` Entries: ${stats.all.total}   (last 7d: ${stats.recent7d.total})`);
  console.log('');
  console.log(' Moat metric — Claude-call ratio (LOWER = BETTER):');
  console.log(`   All-time:   ${stats.all.claudeRatioPct.toFixed(1)}%`);
  console.log(`   Last 7d:    ${stats.recent7d.claudeRatioPct.toFixed(1)}%`);
  console.log('');
  console.log(' Accuracy:');
  console.log(`   All-time:   ${stats.all.accuracyPct.toFixed(1)}%`);
  console.log(`   Last 7d:    ${stats.recent7d.accuracyPct.toFixed(1)}%`);
  console.log('');
  console.log(' Layer breakdown (all-time, hits / accurate):');
  for (const layer of ['ast', 'rule', 'recipe', 'claude', 'unhandled']) {
    const hits = stats.all.byLayer[layer] || 0;
    const acc  = stats.all.accurateByLayer[layer] || 0;
    console.log(`   ${layer.padEnd(10)} ${hits} / ${acc}`);
  }
  if (stats.topRules.length > 0) {
    console.log('');
    console.log(' Top rule keys (by successful hits):');
    for (const r of stats.topRules.slice(0, 10)) {
      console.log(`   ${String(r.hits).padStart(5)}  ${r.ruleKey}`);
    }
  }
  console.log('──────────────────────────────────────────\n');
}

function parseArgs(argv) {
  const args = { path: DEFAULT_PATH, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--path') { args.path = argv[++i]; continue; }
    if (a === '--json') { args.json = true; continue; }
    if (a === '--help' || a === '-h') { args.help = true; continue; }
  }
  return args;
}

function usage() {
  return `\
Usage: node scripts/flywheel-stats.js [--path <jsonl>] [--json]

  --path <jsonl>  Telemetry JSONL path. Default: ~/.gatetest/telemetry/fix-attempts.jsonl
  --json          Emit machine-readable JSON.
  --help, -h      Show this message.
`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { process.stdout.write(usage()); return 0; }
  const entries = readEntries(args.path);
  const stats = aggregate(entries);
  if (args.json) {
    process.stdout.write(JSON.stringify(stats, null, 2) + '\n');
  } else {
    printHuman(stats, args.path);
  }
  return 0;
}

module.exports = { readEntries, aggregate };

if (require.main === module) {
  try { process.exit(main()); }
  catch (err) { process.stderr.write(`flywheel-stats: ${err.stack || err}\n`); process.exit(1); }
}
