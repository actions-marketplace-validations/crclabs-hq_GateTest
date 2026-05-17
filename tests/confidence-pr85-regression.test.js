'use strict';

/**
 * PR #85 regression test — verifies the false-positive findings that
 * blocked Craig's PR are now auto-downgraded to soft errors by the
 * confidence-scoring system, without modifying the scanner modules
 * themselves.
 *
 * Two cases caught from PR #85:
 *
 * 1. `prompt-safety` scanner fired on its OWN pattern strings in
 *    `src/modules/prompt-safety.js` — the literal "NEXT_PUBLIC_*_API_KEY"
 *    text in detection-table strings was matching the public-API-key
 *    rule (against itself).
 *
 * 2. `hardcoded-url` scanner fired on `localhost:3000` examples
 *    inside `// example: ...` comments.
 *
 * The fix: the runner now scores every finding's confidence from
 * file path + source context. Doc-shaped findings (in a comment, in
 * a string literal, in a doc message) get a confidence multiplier
 * below the BLOCK_THRESHOLD and are surfaced as soft errors.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PromptSafetyModule = require('../src/modules/prompt-safety');
const HardcodedUrlModule = require('../src/modules/hardcoded-url');
const { GateTestRunner } = require('../src/core/runner');

// Helper: build a temporary project root with the given files
function makeTmpProject(files) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-conf-pr85-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf-8');
  }
  return tmp;
}

function cleanup(tmp) {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

test('PR #85: NEXT_PUBLIC_* literal inside a JS comment downgrades to soft', async () => {
  // A file that has "NEXT_PUBLIC_*_API_KEY" appearing only inside a
  // documentation comment — not actual usage.
  const tmp = makeTmpProject({
    'src/safe.js': [
      '// Example pattern: NEXT_PUBLIC_ANTHROPIC_API_KEY',
      '// — this comment SHOULD NOT cause prompt-safety to block.',
      'const openai = require("openai");',
      'const client = new openai.OpenAI({ apiKey: process.env.SECRET });',
    ].join('\n'),
  });

  try {
    const runner = new GateTestRunner({ projectRoot: tmp });
    runner.register('promptSafety', new PromptSafetyModule());
    const summary = await runner.run(['promptSafety']);

    // Find any error-severity public-api-key findings on src/safe.js
    const checks = summary.results[0].checks;
    const publicApiKeyHits = checks.filter(
      c => c.name && c.name.startsWith('prompt-safety:public-api-key')
        && !c.passed,
    );

    // If the scanner DID fire on the comment-line literal, it should
    // be a SOFT error (confidence below threshold).
    for (const hit of publicApiKeyHits) {
      assert.ok(
        typeof hit.confidence === 'number',
        `expected hit to have a confidence number, got ${hit.confidence}`,
      );
      // If it fires on a comment-only line, confidence should be soft.
      // (Allow that the scanner might already skip comments, in which
      // case there's no hit at all — also a pass.)
      if (hit.line === 1) {
        assert.ok(
          hit.confidence < 0.7,
          `expected line-1 hit to be soft, got confidence ${hit.confidence}`,
        );
      }
    }

    // The gate must not block on this file alone.
    assert.equal(
      summary.gateStatus,
      'PASSED',
      'safe.js (pattern in comment) must not block the gate',
    );
  } finally {
    cleanup(tmp);
  }
});

test('PR #85: localhost example inside a JS comment downgrades to soft', async () => {
  const tmp = makeTmpProject({
    'src/lib.js': [
      '// Example of a dev URL: http://localhost:3000/api',
      '// This is documentation, not real code.',
      'module.exports = function (req) {',
      '  return fetch(req.body.realUrl);',
      '};',
    ].join('\n'),
  });

  try {
    const runner = new GateTestRunner({ projectRoot: tmp });
    runner.register('hardcodedUrl', new HardcodedUrlModule());
    const summary = await runner.run(['hardcodedUrl']);

    const checks = summary.results[0].checks;
    const localhostHits = checks.filter(
      c => c.name && c.name.startsWith('hardcoded-url:localhost')
        && !c.passed,
    );

    for (const hit of localhostHits) {
      assert.ok(typeof hit.confidence === 'number');
      // Comment-only line 1 should be soft.
      if (hit.line === 1) {
        assert.ok(
          hit.confidence < 0.7,
          `expected line-1 hit to be soft, got confidence ${hit.confidence}`,
        );
      }
    }

    // Either the module already skips the comment (no hit) OR our
    // confidence scoring makes it soft. Either way, gate must pass.
    assert.equal(summary.gateStatus, 'PASSED');
  } finally {
    cleanup(tmp);
  }
});

test('PR #85: error in a real source location (no comment, no string) still blocks', async () => {
  // Sanity check — real bugs still block.
  const tmp = makeTmpProject({
    'src/real-bug.js': [
      'const config = {',
      '  apiBase: "http://localhost:3000",',
      '};',
      'fetch(config.apiBase);',
    ].join('\n'),
  });

  try {
    const runner = new GateTestRunner({ projectRoot: tmp });
    runner.register('hardcodedUrl', new HardcodedUrlModule());
    const summary = await runner.run(['hardcodedUrl']);

    // We expect AT LEAST one blocking error here (the hardcoded localhost
    // in actual code, not a comment).
    assert.equal(
      summary.gateStatus,
      'BLOCKED',
      'real localhost URL in code should still block the gate',
    );
  } finally {
    cleanup(tmp);
  }
});
