#!/usr/bin/env node
/**
 * gatetest-promote — cross-customer recipe promotion CLI.
 *
 * Reads an aggregated recipe corpus (a local JSON file OR a remote
 * recipe-store URL), evaluates each recipe against the promotion criteria
 * defined in `website/app/lib/recipe-promotion.js`, prints a per-recipe
 * decision table to stdout, and (unless --dry-run) writes new shipped-rule
 * JSON files to the output directory.
 *
 * Promotion is human-supervised — this CLI runs on Craig's laptop or a
 * central server, never automatically in CI. The PR review that follows
 * the rule-file write is the safety net.
 *
 * USAGE
 *   gatetest-promote --recipe-store <path-or-url> [options]
 *
 *   --recipe-store <p>      Path to a JSON file OR an http(s) URL serving
 *                           the recipe corpus. Required.
 *   --min-customers <n>     Default 3
 *   --min-occurrences <n>   Default 5
 *   --min-win-rate <f>      Default 0.9
 *   --max-fp-rate <f>       Default 0.01
 *   --out <dir>             Output directory for new rule JSON files.
 *                           Default: src/shipped-rules/ (relative to repo).
 *   --dry-run               Print decisions but don't write any files.
 *   --json                  Emit machine-readable JSON instead of the table.
 *   -h, --help              This help.
 *
 * EXIT
 *   Always 0 — this is a tooling step, never a CI gate.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const {
  assessPromotionCandidate,
  buildShippedRuleFromRecipe,
  serializeShippedRule,
  DEFAULT_CRITERIA,
} = require('../website/app/lib/recipe-promotion');

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    recipeStore: null,
    minCustomers: DEFAULT_CRITERIA.minCustomers,
    minOccurrences: DEFAULT_CRITERIA.minOccurrences,
    minWinRate: DEFAULT_CRITERIA.minWinRate,
    maxFpRate: DEFAULT_CRITERIA.maxFalsePositives,
    out: path.join(__dirname, '..', 'src', 'shipped-rules'),
    dryRun: false,
    json: false,
    help: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--recipe-store':    args.recipeStore = argv[++i]; break;
      case '--min-customers':   args.minCustomers = Number(argv[++i]); break;
      case '--min-occurrences': args.minOccurrences = Number(argv[++i]); break;
      case '--min-win-rate':    args.minWinRate = Number(argv[++i]); break;
      case '--max-fp-rate':     args.maxFpRate = Number(argv[++i]); break;
      case '--out':             args.out = argv[++i]; break;
      case '--dry-run':         args.dryRun = true; break;
      case '--json':            args.json = true; break;
      case '-h':
      case '--help':            args.help = true; break;
      default:
        process.stderr.write(`gatetest-promote: unknown flag '${a}'\n`);
    }
  }
  return args;
}

function usage() {
  process.stdout.write(
`Usage: gatetest-promote --recipe-store <path-or-url> [options]

Required:
  --recipe-store <p>      Path to a JSON file OR an http(s) URL serving the
                          recipe corpus.

Options:
  --min-customers <n>     Distinct customers required to promote (default ${DEFAULT_CRITERIA.minCustomers})
  --min-occurrences <n>   Total occurrences required to promote (default ${DEFAULT_CRITERIA.minOccurrences})
  --min-win-rate <f>      Minimum win rate, 0..1 (default ${DEFAULT_CRITERIA.minWinRate})
  --max-fp-rate <f>       Max false-positive rate, 0..1 (default ${DEFAULT_CRITERIA.maxFalsePositives})
  --out <dir>             Output directory for new rule JSON files
                          (default src/shipped-rules/)
  --dry-run               Print decisions but don't write any files
  --json                  Emit machine-readable JSON instead of the table

Exit code: always 0 (tooling step — never a CI gate).
`);
}

// ---------------------------------------------------------------------------
// Corpus loading
// ---------------------------------------------------------------------------

function isHttpUrl(s) {
  return typeof s === 'string' && /^https?:\/\//i.test(s);
}

function loadCorpusFromFile(p) {
  const raw = fs.readFileSync(p, 'utf8');
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.recipes)) return parsed.recipes;
  throw new Error(`recipe corpus at ${p} did not contain an array or {recipes:[]}`);
}

function loadCorpusFromUrl(urlStr) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const transport = url.protocol === 'http:' ? http : https;
    const req = transport.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'http:' ? 80 : 443),
      path: `${url.pathname}${url.search || ''}`,
      method: 'GET',
      headers: { Accept: 'application/json', 'User-Agent': 'gatetest-promote' },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf8');
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) resolve(parsed);
          else if (parsed && Array.isArray(parsed.recipes)) resolve(parsed.recipes);
          else reject(new Error('recipe corpus response did not contain an array or {recipes:[]}'));
        } catch (err) { reject(err); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(15_000, () => { req.destroy(new Error('recipe-store request timeout')); });
    req.end();
  });
}

async function loadCorpus(spec) {
  if (!spec) throw new Error('--recipe-store is required');
  if (isHttpUrl(spec)) return loadCorpusFromUrl(spec);
  return loadCorpusFromFile(spec);
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function padRight(s, n) {
  const x = String(s);
  return x.length >= n ? x.slice(0, n) : x + ' '.repeat(n - x.length);
}

function printTable(decisions) {
  const headers = ['RULE KEY', 'MODULE', 'CUST', 'OCCS', 'WIN%', 'DECISION', 'REASON'];
  const widths  = [38, 18, 5, 5, 5, 9, 40];
  process.stdout.write(headers.map((h, i) => padRight(h, widths[i])).join(' ') + '\n');
  process.stdout.write(widths.map((w) => '-'.repeat(w)).join(' ') + '\n');
  for (const d of decisions) {
    const winPct = `${Math.round((Number(d.recipe.winRate) || 0) * 100)}`;
    process.stdout.write([
      padRight(d.recipe.ruleKey || '?',          widths[0]),
      padRight(d.recipe.module || '?',           widths[1]),
      padRight(d.recipe.customers || 0,          widths[2]),
      padRight(d.recipe.occurrences || d.recipe.applicationCount || 0, widths[3]),
      padRight(winPct,                            widths[4]),
      padRight(d.assessment.promote ? 'PROMOTE' : 'skip', widths[5]),
      padRight(d.assessment.reason || '',         widths[6]),
    ].join(' ') + '\n');
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) { usage(); return 0; }
  if (!args.recipeStore) {
    process.stderr.write('gatetest-promote: --recipe-store is required\n');
    usage();
    return 0;
  }

  let corpus;
  try {
    corpus = await loadCorpus(args.recipeStore);
  } catch (err) {
    process.stderr.write(`gatetest-promote: failed to load corpus: ${err.message}\n`);
    return 0;
  }
  if (!Array.isArray(corpus)) {
    process.stderr.write('gatetest-promote: corpus is not an array\n');
    return 0;
  }

  const criteria = {
    minCustomers:      args.minCustomers,
    minOccurrences:    args.minOccurrences,
    minWinRate:        args.minWinRate,
    maxFalsePositives: args.maxFpRate,
  };

  const decisions = [];
  for (const recipe of corpus) {
    const assessment = assessPromotionCandidate(recipe, criteria);
    decisions.push({ recipe, assessment });
  }

  // Output: JSON or table
  if (args.json) {
    process.stdout.write(JSON.stringify({ criteria, decisions }, null, 2) + '\n');
  } else {
    process.stdout.write(`Recipe corpus: ${args.recipeStore} (${decisions.length} recipes)\n`);
    process.stdout.write(`Criteria: ${JSON.stringify(criteria)}\n\n`);
    printTable(decisions);
  }

  // Write rule files for the promoted ones
  const promoted = decisions.filter((d) => d.assessment.promote);
  if (promoted.length === 0) {
    process.stdout.write('\nNo recipes met the promotion criteria.\n');
    return 0;
  }

  if (args.dryRun) {
    process.stdout.write(`\n--dry-run: would write ${promoted.length} rule file(s) to ${args.out}\n`);
    return 0;
  }

  try {
    fs.mkdirSync(args.out, { recursive: true });
  } catch (err) {
    process.stderr.write(`gatetest-promote: cannot create --out dir ${args.out}: ${err.message}\n`);
    return 0;
  }

  const promotedAt = new Date().toISOString();
  for (const { recipe, assessment } of promoted) {
    const rule = buildShippedRuleFromRecipe(recipe, {
      customers: recipe.customers,
      winRate:   recipe.winRate,
      promotedAt,
    });
    const fileName = `promoted-${assessment.recipeFingerprint}.json`;
    const fullPath = path.join(args.out, fileName);
    if (fs.existsSync(fullPath)) {
      process.stdout.write(`  skip ${fileName} (already exists)\n`);
      continue;
    }
    try {
      fs.writeFileSync(fullPath, serializeShippedRule(rule));
      process.stdout.write(`  wrote ${fileName}\n`);
    } catch (err) {
      process.stderr.write(`  failed to write ${fileName}: ${err.message}\n`);
    }
  }

  return 0;
}

if (require.main === module) {
  main(process.argv).then((code) => process.exit(code || 0)).catch((err) => {
    process.stderr.write(`gatetest-promote: unexpected error: ${err && err.message}\n`);
    process.exit(0); // tooling step, never block CI
  });
}

module.exports = { main, parseArgs, loadCorpus };
