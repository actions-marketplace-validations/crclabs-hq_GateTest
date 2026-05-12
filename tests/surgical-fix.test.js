/**
 * Tests for the surgical-diff fix module.
 *
 * Keep this suite tight — 10 tests, all fast, no I/O.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  extractIssueContext,
  buildSurgicalPrompt,
  parseReplacementBlock,
  spliceReplacement,
  validateSurgicalFix,
} = require("../website/app/lib/surgical-fix.js");

function makeFile(n, ending = "\n") {
  const lines = [];
  for (let i = 1; i <= n; i++) lines.push(`line${i}`);
  return lines.join(ending);
}

test("extractIssueContext: 50-line file, line 25, ctx 5 -> startLine 20, endLine 30, slice has 11 lines", () => {
  const file = makeFile(50);
  const ctx = extractIssueContext(file, 25, 5);
  assert.equal(ctx.startLine, 20);
  assert.equal(ctx.endLine, 30);
  assert.equal(ctx.totalLines, 50);
  assert.equal(ctx.lineEnding, "\n");
  assert.equal(ctx.slice.split("\n").length, 11);
  assert.equal(ctx.slice.split("\n")[0], "line20");
  assert.equal(ctx.slice.split("\n")[10], "line30");
});

test("extractIssueContext: line near top (line 2, ctx 20) -> startLine 1", () => {
  const file = makeFile(50);
  const ctx = extractIssueContext(file, 2, 20);
  assert.equal(ctx.startLine, 1);
  assert.equal(ctx.endLine, 22);
  assert.equal(ctx.slice.split("\n")[0], "line1");
});

test("extractIssueContext: line near bottom -> endLine clamped to totalLines", () => {
  const file = makeFile(50);
  const ctx = extractIssueContext(file, 48, 20);
  assert.equal(ctx.startLine, 28);
  assert.equal(ctx.endLine, 50);
  assert.equal(ctx.totalLines, 50);
  const last = ctx.slice.split("\n").pop();
  assert.equal(last, "line50");
});

test("extractIssueContext: detects \\r\\n and round-trips line ending", () => {
  const file = makeFile(20, "\r\n");
  const ctx = extractIssueContext(file, 10, 3);
  assert.equal(ctx.lineEnding, "\r\n");
  assert.equal(ctx.startLine, 7);
  assert.equal(ctx.endLine, 13);
  // slice should be joined by CRLF
  assert.ok(ctx.slice.indexOf("\r\n") >= 0);
  assert.equal(ctx.slice.split("\r\n").length, 7);
  assert.equal(ctx.slice.split("\r\n")[0], "line7");
});

test("buildSurgicalPrompt: includes startLine/endLine, lists issues, has line-numbered slice", () => {
  const prompt = buildSurgicalPrompt({
    filePath: "src/foo.js",
    slice: "const a = 1;\nconst b = 2;\nconst c = 3;",
    startLine: 10,
    endLine: 12,
    issues: ["use let instead of const", "missing semicolon"],
  });
  assert.ok(prompt.includes("src/foo.js"));
  assert.ok(prompt.includes("lines 10 to 12"));
  assert.ok(prompt.includes("1. use let instead of const"));
  assert.ok(prompt.includes("2. missing semicolon"));
  assert.ok(prompt.includes("10: const a = 1;"));
  assert.ok(prompt.includes("11: const b = 2;"));
  assert.ok(prompt.includes("12: const c = 3;"));
  // Must instruct no fences
  assert.ok(/code fences/i.test(prompt));
});

test("parseReplacementBlock: strips ```javascript fence", () => {
  const input = "```javascript\nconst x = 1;\nconst y = 2;\n```";
  const out = parseReplacementBlock(input);
  assert.equal(out, "const x = 1;\nconst y = 2;");
});

test("parseReplacementBlock: strips per-line `42: ` prefixes", () => {
  const input = "42: const x = 1;\n43: const y = 2;\n44: const z = 3;";
  const out = parseReplacementBlock(input);
  assert.equal(out, "const x = 1;\nconst y = 2;\nconst z = 3;");
});

test("spliceReplacement: 100-line file, splice lines 30-40 with shorter replacement -> outside lines byte-identical", () => {
  const original = makeFile(100);
  const replacement = "REPLACED_A\nREPLACED_B"; // 2 lines instead of 11
  const result = spliceReplacement(original, 30, 40, replacement, "\n");
  const resultLines = result.split("\n");

  // Lines 1-29 byte-identical
  for (let i = 0; i < 29; i++) {
    assert.equal(resultLines[i], `line${i + 1}`);
  }
  // Splice replaced
  assert.equal(resultLines[29], "REPLACED_A");
  assert.equal(resultLines[30], "REPLACED_B");
  // Lines 41+ in original (line41..line100 -> 60 lines) byte-identical at new offset
  for (let i = 0; i < 60; i++) {
    assert.equal(resultLines[31 + i], `line${41 + i}`);
  }
  // Total length: 29 + 2 + 60 = 91
  assert.equal(resultLines.length, 91);
});

test("validateSurgicalFix: returns ok=false when line 5 was mutated outside a 30-40 splice", () => {
  const original = makeFile(100);
  const tampered = original.split("\n");
  tampered[4] = "TAMPERED_LINE_5"; // mutate line 5 (index 4)
  // also do a legit splice at 30-40
  const fixed = tampered.slice(0, 29).concat(["NEW_30", "NEW_31"], tampered.slice(40)).join("\n");
  const res = validateSurgicalFix({
    originalContent: original,
    fixedContent: fixed,
    startLine: 30,
    endLine: 40,
    lineEnding: "\n",
  });
  assert.equal(res.ok, false);
  assert.ok(Array.isArray(res.mutatedLines));
  assert.ok(res.mutatedLines.includes(5));
});

test("validateSurgicalFix: returns ok=true for a clean splice", () => {
  const original = makeFile(100);
  const replacement = "CLEAN_A\nCLEAN_B\nCLEAN_C";
  const fixed = spliceReplacement(original, 30, 40, replacement, "\n");
  const res = validateSurgicalFix({
    originalContent: original,
    fixedContent: fixed,
    startLine: 30,
    endLine: 40,
    lineEnding: "\n",
  });
  assert.equal(res.ok, true);
  assert.equal(res.reason, undefined);
});
