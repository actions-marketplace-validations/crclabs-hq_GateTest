'use strict';

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const path     = require('node:path');

const {
  KNOWN_CONVENTION_FILES,
  extractConventions,
  formatGroundingHeader,
  groundPrompt,
  summariseGrounding,
} = require('../lib/contextual-grounding');

// ─── extractConventions ────────────────────────────────────────────────────

test('extractConventions returns empty found when fileContents is empty', () => {
  const result = extractConventions({ files: [], fileContents: [] });
  assert.deepEqual(result.found, []);
  assert.equal(result.totalBytes, 0);
  assert.deepEqual(result.omitted, []);
});

test('extractConventions finds README.md at repo root', () => {
  const result = extractConventions({
    files: ['README.md', 'src/index.js'],
    fileContents: [{ path: 'README.md', content: '# My Project\n\nWe use Postgres.' }],
  });
  assert.equal(result.found.length, 1);
  assert.equal(path.basename(result.found[0].path), 'README.md');
  assert.match(result.found[0].excerpt, /Postgres/);
});

test('extractConventions finds README.md at a subdirectory path', () => {
  const result = extractConventions({
    files: ['docs/README.md'],
    fileContents: [{ path: 'docs/README.md', content: '# Subdirectory readme' }],
  });
  assert.equal(result.found.length, 1);
  assert.equal(result.found[0].path, 'docs/README.md');
});

test('extractConventions respects priority: CLAUDE.md comes before README.md', () => {
  const result = extractConventions({
    files: ['CLAUDE.md', 'README.md'],
    fileContents: [
      { path: 'README.md',  content: 'Generic readme' },
      { path: 'CLAUDE.md',  content: 'Claude instructions' },
    ],
  });
  // Both found; CLAUDE.md must be first per KNOWN_CONVENTION_FILES order
  assert.ok(result.found.length >= 2);
  assert.equal(path.basename(result.found[0].path), 'CLAUDE.md');
  assert.equal(path.basename(result.found[1].path), 'README.md');
});

test('extractConventions truncates a 10KB file to maxBytesPerFile=2000', () => {
  const bigContent = 'A'.repeat(10_000);
  const result = extractConventions({
    files: ['README.md'],
    fileContents: [{ path: 'README.md', content: bigContent }],
    maxBytesPerFile: 2000,
  });
  assert.equal(result.found.length, 1);
  // excerpt must be at most 2000 bytes
  assert.ok(Buffer.byteLength(result.found[0].excerpt, 'utf-8') <= 2000);
});

test('extractConventions stops adding files once maxTotalBytes is hit and records them in omitted', () => {
  // Two files, each just over half of maxTotalBytes — second should be omitted.
  const halfKb = 'B'.repeat(600);
  const result = extractConventions({
    files: ['CLAUDE.md', 'README.md'],
    fileContents: [
      { path: 'CLAUDE.md', content: halfKb },
      { path: 'README.md', content: halfKb },
    ],
    maxBytesPerFile: 2000,
    maxTotalBytes: 800, // first 600-byte file fits; second would push total to 1200 > 800
  });
  assert.equal(result.found.length, 1);
  assert.equal(path.basename(result.found[0].path), 'CLAUDE.md');
  assert.ok(result.omitted.includes('README.md'));
});

// ─── formatGroundingHeader ────────────────────────────────────────────────

test('formatGroundingHeader returns empty string for empty found array', () => {
  assert.equal(formatGroundingHeader([]), '');
  assert.equal(formatGroundingHeader(null), '');
});

test('formatGroundingHeader includes the heading and each file basename as sub-heading', () => {
  const found = [
    { path: 'CLAUDE.md',  excerpt: 'Use functional components.', bytes: 26 },
    { path: 'README.md',  excerpt: 'We use Postgres, not Mongo.', bytes: 27 },
  ];
  const header = formatGroundingHeader(found);
  assert.match(header, /## Project Conventions/);
  assert.match(header, /### CLAUDE\.md/);
  assert.match(header, /### README\.md/);
  assert.match(header, /Use functional components/);
  assert.match(header, /Postgres, not Mongo/);
  assert.match(header, /---/);   // trailing separator
});

// ─── groundPrompt ────────────────────────────────────────────────────────

test('groundPrompt returns the base prompt unchanged when conventionsHeader is empty string', () => {
  const base = 'Fix the bug.';
  assert.equal(groundPrompt({ basePrompt: base, conventionsHeader: '' }), base);
});

test('groundPrompt prepends conventionsHeader to base prompt when non-empty', () => {
  const header = '## Conventions\n\nUse Postgres.\n\n---\n\n';
  const base = 'Fix the bug.';
  const result = groundPrompt({ basePrompt: base, conventionsHeader: header });
  assert.equal(result, header + base);
  assert.ok(result.startsWith('## Conventions'));
  assert.ok(result.endsWith('Fix the bug.'));
});

// ─── summariseGrounding ────────────────────────────────────────────────────

test('summariseGrounding: no convention files found', () => {
  const result = summariseGrounding({ found: [], totalBytes: 0, omitted: [] });
  assert.equal(result, 'grounded: no convention files found');
});

test('summariseGrounding: files found, none omitted', () => {
  const result = summariseGrounding({
    found: [
      { path: 'CLAUDE.md', bytes: 1843 },
      { path: 'README.md', bytes: 2000 },
    ],
    totalBytes: 3843,
    omitted: [],
  });
  assert.match(result, /^grounded:/);
  assert.match(result, /CLAUDE\.md/);
  assert.match(result, /README\.md/);
  assert.match(result, /KB total/);
  assert.ok(!result.includes('skipped'));
});

test('summariseGrounding: some files skipped by budget', () => {
  const result = summariseGrounding({
    found:  [{ path: 'CLAUDE.md', bytes: 2000 }],
    totalBytes: 2000,
    omitted: ['README.md'],
  });
  assert.match(result, /1 file skipped \(budget\)/);
});
