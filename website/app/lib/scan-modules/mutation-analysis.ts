/**
 * Mutation analysis — static coverage-gap detection.
 *
 * True mutation testing (apply a mutation, run the test suite, check if a test
 * fails) requires executing customer test suites which serverless functions
 * cannot safely do. This module performs the STATIC half of that work:
 *
 *   1. Identify mutation candidates — source lines with operators that could
 *      be flipped to introduce a latent bug (boundaries, equality, arithmetic,
 *      logical operators, return-value literals).
 *   2. Identify which source functions have zero test-file coverage (no test
 *      file imports or references the function or its file).
 *   3. Flag functions with mutation candidates AND no test coverage as
 *      "untested mutation surface" — the exact shape a bug would hide in.
 *   4. Flag critical-path functions (payment, auth, crypto, database ops)
 *      with ANY mutation surface as elevated risk.
 *
 * This is honest work: we make no claim that a mutation would survive — only
 * that the mutation surface exists and tests don't cover it. The full runtime
 * mutation testing pass is a CLI feature (`gatetest --suite nuclear`).
 */

import type { ModuleContext, ModuleOutput, RepoFile } from "./types";

const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/i;
const TEST_PATH = /(^|\/)(test|tests|__tests__|spec)(\/|$)/i;
const TEST_FILE = /\.(test|spec)\.(ts|tsx|js|jsx|mjs)$/i;

// Operator patterns that represent mutation candidates.
// Each maps to the bug class it would introduce if mutated.
const MUTATION_PATTERNS: Array<{ re: RegExp; label: string; severity: "error" | "warning" }> = [
  // Boundary conditions — off-by-one bugs are the most common mutation-escape class
  { re: /[^=!<>]=== *\d|[^=!<>]!== *\d/, label: "strict-equality-check on numeric literal", severity: "warning" },
  { re: /(?<![<>=!])[<>](?![<>=])/, label: "boundary comparison (</>)", severity: "warning" },
  { re: /(?<![<>=!])[<>]=(?![=])/, label: "boundary comparison (<=/>= )", severity: "warning" },
  // Arithmetic in business logic
  { re: /[\w\s][+\-][=\s]*[\w(]/, label: "arithmetic operator (+/-)", severity: "warning" },
  { re: /[\w\s][*\/][=\s]*[\w(]/, label: "arithmetic operator (*//)", severity: "warning" },
  // Return-value literals — flipping true↔false is the most trivially survivable mutation
  { re: /return\s+true\b/, label: "return-true (could silently become return-false)", severity: "error" },
  { re: /return\s+false\b/, label: "return-false (could silently become return-true)", severity: "error" },
  { re: /return\s+0\b/, label: "return-zero literal", severity: "warning" },
  // Logical operators — && vs || is the hardest mutation to catch without branch coverage
  { re: /&&/, label: "logical-AND (&&)", severity: "warning" },
  { re: /\|\|/, label: "logical-OR (||)", severity: "warning" },
];

// Critical-path keywords — functions handling these get elevated findings
// No word boundaries — intentionally matches substrings like processPayment, stripeKey, authToken
const CRITICAL_PATH_RE = /(payment|charge|stripe|price|amount|balance|auth|login|token|password|secret|crypto|hash|sign|verify|encrypt|decrypt|permission|role|admin|sql|query|insert|update|delete|transaction)/i;

function isTestFile(path: string): boolean {
  return TEST_PATH.test(path) || TEST_FILE.test(path);
}

function isSourceFile(path: string): boolean {
  return SOURCE_EXT.test(path) && !isTestFile(path);
}

/**
 * Extract exported function names from a source file.
 * Handles: export function foo, export const foo = ..., export default function foo,
 * module.exports.foo, exports.foo, class method names (basic).
 */
function extractExportedNames(content: string): string[] {
  const names = new Set<string>();
  const patterns = [
    /export\s+(?:async\s+)?function\s+(\w+)/g,
    /export\s+const\s+(\w+)\s*=/g,
    /export\s+default\s+(?:async\s+)?function\s+(\w+)/g,
    /exports\.(\w+)\s*=/g,
    /module\.exports\.(\w+)\s*=/g,
    /module\.exports\s*=\s*\{([^}]+)\}/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      if (m[1]) {
        // module.exports = { a, b, c } — parse the keys
        if (m[0].startsWith("module.exports")) {
          m[1].split(",").forEach((k) => {
            const kn = k.trim().split(":")[0].trim();
            if (kn && /^\w+$/.test(kn)) names.add(kn);
          });
        } else {
          names.add(m[1]);
        }
      }
    }
  }
  return Array.from(names);
}

/**
 * Count mutation candidates in a block of content.
 * Returns { count, samples[] } where samples are the first few descriptions.
 */
function countMutationCandidates(content: string): { count: number; samples: string[] } {
  // Strip comments to avoid false positives in doc strings.
  const stripped = content
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, '""');

  let count = 0;
  const samples: string[] = [];
  for (const { re, label } of MUTATION_PATTERNS) {
    const hits = stripped.match(new RegExp(re.source, "g"));
    if (hits && hits.length > 0) {
      count += hits.length;
      if (samples.length < 3) samples.push(`${hits.length}× ${label}`);
    }
  }
  return { count, samples };
}

export async function mutationAnalysis(ctx: ModuleContext): Promise<ModuleOutput> {
  const details: string[] = [];
  let checks = 0;
  let issues = 0;

  const sourceFiles = ctx.fileContents.filter((f) => isSourceFile(f.path));
  const testFiles = ctx.fileContents.filter((f) => isTestFile(f.path));

  if (sourceFiles.length === 0) {
    return { checks: 1, issues: 0, details: [], skipped: "no source files to analyse" };
  }

  checks++; // baseline check

  // Build a set of all names/paths referenced in any test file
  const testCoverage = new Set<string>();
  for (const tf of testFiles) {
    // Import paths: import ... from './foo' or require('./foo')
    const importPaths = tf.content.match(/(?:from|require)\s*\(['"]([^'"]+)['"]\)/g) || [];
    for (const imp of importPaths) {
      const m = imp.match(/['"]([^'"]+)['"]/);
      if (m) {
        // Normalise: strip leading ./ ../ and extensions
        const p = m[1].replace(/^\.\//, "").replace(/\.[^.]+$/, "");
        testCoverage.add(p);
      }
    }
    // Also capture any function names called in the test body
    const idents = tf.content.match(/\b([A-Za-z_]\w{3,})\b/g) || [];
    for (const id of idents) testCoverage.add(id);
  }

  // Analyse source files
  const filesByPath = new Map<string, RepoFile>(sourceFiles.map((f) => [f.path, f]));

  for (const f of sourceFiles) {
    checks++;

    const { count, samples } = countMutationCandidates(f.content);
    if (count === 0) continue;

    // Does any test file reference this source file?
    const baseName = f.path.replace(/\.[^.]+$/, "").replace(/^.*\//, ""); // filename without ext
    const pathBaseName = f.path.replace(/^.*\//, "").replace(/\.[^.]+$/, ""); // same
    const isCovered = testCoverage.has(baseName) || testCoverage.has(pathBaseName) ||
      testCoverage.has(f.path) || testCoverage.has(f.path.replace(/\.[^.]+$/, ""));

    const isCritical = CRITICAL_PATH_RE.test(f.path) || CRITICAL_PATH_RE.test(f.content.slice(0, 2000));

    if (!isCovered) {
      issues++;
      const severity = isCritical ? "error" : "warning";
      const tier = isCritical ? "CRITICAL-PATH" : "untested";
      details.push(
        `${f.path}: ${severity === "error" ? "error" : "warning"}: ${tier} mutation surface — ${count} mutation candidate${count > 1 ? "s" : ""} (${samples.join("; ")}) with no test coverage. Risk: logic bugs here would pass your test suite undetected.`
      );
    } else if (isCritical && count > 5) {
      // Even covered critical-path files with heavy mutation surface get a note
      const exportedNames = extractExportedNames(f.content);
      const uncoveredFns = exportedNames.filter((n) => !testCoverage.has(n));
      if (uncoveredFns.length > 0) {
        issues++;
        details.push(
          `${f.path}: warning: critical-path file has ${count} mutation candidates — exported functions not found in any test: ${uncoveredFns.slice(0, 5).join(", ")}. Add targeted tests for ${samples[0] || "boundary conditions"}.`
        );
      }
    }
  }

  // Summary finding — always emitted so customers know the check ran
  const coveredCount = sourceFiles.length - issues;
  details.push(
    `info: mutation-surface analysis — ${sourceFiles.length} source files, ${testFiles.length} test files, ${issues} file${issues !== 1 ? "s" : ""} with untested mutation candidates identified`
  );
  void coveredCount; // suppress unused warning
  void filesByPath;  // suppress unused warning

  return { checks, issues, details };
}
