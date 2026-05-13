/**
 * Static-quality scan modules: syntax, lint, codeQuality, documentation.
 *
 * Every check inspects real file content. No defaults, no placeholders.
 */

import type { ModuleContext, ModuleOutput, ModuleRunner, RepoFile } from "./types";

const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/i;

function isTestPath(p: string): boolean {
  return /(^|\/)(test|tests|__tests__|spec)(\/|$)/i.test(p) || /\.(test|spec)\./i.test(p);
}

function countOccurrences(haystack: string, ch: string): number {
  let n = 0;
  for (let i = 0; i < haystack.length; i++) if (haystack[i] === ch) n++;
  return n;
}

function sourceFiles(fc: RepoFile[]): RepoFile[] {
  return fc.filter((f) => SOURCE_EXT.test(f.path));
}

export const syntax: ModuleRunner = async (ctx: ModuleContext): Promise<ModuleOutput> => {
  const details: string[] = [];
  let checks = 0;
  let issues = 0;

  for (const f of ctx.fileContents) {
    if (SOURCE_EXT.test(f.path)) {
      const openBr = countOccurrences(f.content, "{");
      const closeBr = countOccurrences(f.content, "}");
      checks++;
      if (Math.abs(openBr - closeBr) > 2) {
        issues++;
        details.push(`${f.path}: brace imbalance (${openBr} open vs ${closeBr} close)`);
      }

      const openP = countOccurrences(f.content, "(");
      const closeP = countOccurrences(f.content, ")");
      checks++;
      if (Math.abs(openP - closeP) > 2) {
        issues++;
        details.push(`${f.path}: parenthesis imbalance (${openP} vs ${closeP})`);
      }

      const openSq = countOccurrences(f.content, "[");
      const closeSq = countOccurrences(f.content, "]");
      checks++;
      if (Math.abs(openSq - closeSq) > 2) {
        issues++;
        details.push(`${f.path}: bracket imbalance (${openSq} vs ${closeSq})`);
      }

      const backticks = countOccurrences(f.content, "`");
      checks++;
      if (backticks % 2 !== 0) {
        issues++;
        details.push(`${f.path}: unterminated template literal (${backticks} backticks)`);
      }
    }

    if (f.path.toLowerCase().endsWith(".json")) {
      checks++;
      try {
        JSON.parse(f.content);
      } catch (e) {
        issues++;
        const msg = e instanceof Error ? e.message : String(e);
        details.push(`${f.path}: invalid JSON (${msg})`);
      }
    }
  }

  if (checks === 0) return { checks: 0, issues: 0, details, skipped: "no readable files to parse" };
  return { checks, issues, details };
};

export const lint: ModuleRunner = async (ctx: ModuleContext): Promise<ModuleOutput> => {
  const details: string[] = [];
  let checks = 0;
  let issues = 0;

  const targets = ctx.fileContents.filter(
    (f) => SOURCE_EXT.test(f.path) && !isTestPath(f.path)
  );

  for (const f of targets) {
    checks++;
    if (/\bvar\s+\w/.test(f.content)) {
      issues++;
      details.push(`${f.path}: uses legacy 'var' declaration`);
    }

    checks++;
    if (/[^=!]==[^=]|[^!]!=[^=]/.test(f.content)) {
      issues++;
      details.push(`${f.path}: uses loose equality (== or !=) instead of === / !==`);
    }

    const lines = f.content.split("\n");
    let longLineCount = 0;
    for (const ln of lines) if (ln.length > 200) longLineCount++;
    checks++;
    if (longLineCount > 0) {
      issues++;
      details.push(`${f.path}: ${longLineCount} line(s) exceed 200 characters`);
    }

    checks++;
    let run = 0;
    let maxRun = 0;
    let inFn = false;
    for (const ln of lines) {
      if (!inFn && /\bfunction\b|=>/.test(ln)) inFn = true;
      if (inFn) {
        if (ln.trim() === "") {
          if (run > maxRun) maxRun = run;
          run = 0;
          inFn = false;
        } else run++;
      }
    }
    if (run > maxRun) maxRun = run;
    if (maxRun > 50) {
      issues++;
      details.push(`${f.path}: function spans ${maxRun} consecutive non-empty lines (>50)`);
    }

    let trailingCount = 0;
    for (const ln of lines) if (/[ \t]+$/.test(ln)) trailingCount++;
    checks++;
    if (trailingCount > 5) {
      issues++;
      details.push(`${f.path}: ${trailingCount} lines with trailing whitespace`);
    }
  }

  if (checks === 0) return { checks: 0, issues: 0, details, skipped: "no lintable source files" };
  return { checks, issues, details };
};

export const codeQuality: ModuleRunner = async (ctx: ModuleContext): Promise<ModuleOutput> => {
  const details: string[] = [];
  let checks = 0;
  let issues = 0;

  const targets = sourceFiles(ctx.fileContents).filter((f) => !isTestPath(f.path));

  for (const f of targets) {
    checks++;
    if (/console\.(log|debug|info)\(/.test(f.content)) {
      issues++;
      details.push(`${f.path}: contains console.log/debug/info call`);
    }

    checks++;
    if (/\bdebugger\b/.test(f.content)) {
      issues++;
      details.push(`${f.path}: contains 'debugger' statement`);
    }

    checks++;
    if (/\/\/\s*(todo|fixme|hack|xxx)\b/i.test(f.content)) {
      issues++;
      details.push(`${f.path}: contains TODO/FIXME/HACK/XXX marker`);
    }

    checks++;
    if (/\beval\s*\(/.test(f.content)) {
      issues++;
      details.push(`${f.path}: uses eval()`);
    }

    const lines = f.content.split("\n");
    checks++;
    if (lines.length > 500) {
      issues++;
      details.push(`${f.path}: ${lines.length} lines (>500)`);
    }

    checks++;
    let deep = false;
    for (const ln of lines) {
      const leadingSpaces = ln.match(/^ +/)?.[0].length ?? 0;
      const leadingTabs = ln.match(/^\t+/)?.[0].length ?? 0;
      if (leadingSpaces > 20 || leadingTabs > 5) {
        deep = true;
        break;
      }
    }
    if (deep) {
      issues++;
      details.push(`${f.path}: deep nesting detected (indent >20 spaces or >5 tabs)`);
    }

    checks++;
    let longFn = false;
    for (const ln of lines) {
      if (ln.length > 200 && /\bfunction\b|=>/.test(ln)) {
        longFn = true;
        break;
      }
    }
    if (longFn) {
      issues++;
      details.push(`${f.path}: single-line function declaration over 200 chars`);
    }
  }

  if (checks === 0) return { checks: 0, issues: 0, details, skipped: "no source files to inspect" };
  return { checks, issues, details };
};

export const documentation: ModuleRunner = async (ctx: ModuleContext): Promise<ModuleOutput> => {
  const details: string[] = [];
  let checks = 0;
  let issues = 0;

  const hasFile = (name: string): boolean =>
    ctx.files.some((p) => p.toLowerCase() === name.toLowerCase());
  const hasAny = (names: string[]): boolean => names.some((n) => hasFile(n));

  checks++;
  if (!hasFile("README.md")) {
    issues++;
    details.push("repo: missing README.md at root");
  }

  checks++;
  if (!hasAny(["LICENSE", "LICENSE.md", "LICENSE.txt"])) {
    issues++;
    details.push("repo: missing LICENSE file");
  }

  checks++;
  if (!hasAny(["CHANGELOG.md", "CHANGES.md"])) {
    issues++;
    details.push("repo: missing CHANGELOG.md / CHANGES.md");
  }

  checks++;
  if (!hasFile(".env.example")) {
    issues++;
    details.push("repo: missing .env.example (required env vars not documented)");
  }

  const pkg = ctx.fileContents.find((f) => f.path === "package.json");
  if (pkg) {
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(pkg.content) as Record<string, unknown>;
    } catch {
      parsed = null;
    }
    for (const field of ["description", "repository", "license"]) {
      checks++;
      if (!parsed || !parsed[field]) {
        issues++;
        details.push(`package.json: missing '${field}' field`);
      }
    }
  }

  const src = sourceFiles(ctx.fileContents);
  if (src.length > 0) {
    checks++;
    let documented = 0;
    for (const f of src) {
      if (f.content.trimStart().startsWith("/**")) documented++;
    }
    const ratio = documented / src.length;
    if (ratio < 0.2) {
      issues++;
      details.push(
        `docs: only ${documented}/${src.length} source files (${Math.round(ratio * 100)}%) have file-level JSDoc (<20%)`
      );
    }
  }

  if (checks === 0) return { checks: 0, issues: 0, details, skipped: "repo tree empty" };
  return { checks, issues, details };
};
