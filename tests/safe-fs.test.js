// =============================================================================
// SAFE-FS TEST — phase-6 launch hardening
// =============================================================================
// Covers safeReadFile (size cap + EACCES + encoding), detectEncoding,
// walkFiles (max-files / max-depth / symlink loop / skip-dirs), and
// readTextFiles convenience wrapper.
// =============================================================================

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  detectEncoding,
  errorReason,
  safeReadFile,
  walkFiles,
  readTextFiles,
  DEFAULT_MAX_BYTES,
} = require('../src/core/safe-fs');

// =============================================================================
// detectEncoding
// =============================================================================

describe('detectEncoding', () => {
  it('returns utf-8 for ASCII-with-high-bytes (typical source)', () => {
    const buf = Buffer.from('export const greeting = "héllo";');
    assert.strictEqual(detectEncoding(buf), 'utf-8');
  });

  it('returns ascii for plain 7-bit', () => {
    assert.strictEqual(detectEncoding(Buffer.from('hello world')), 'ascii');
  });

  it('detects UTF-8 BOM', () => {
    const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hi')]);
    assert.strictEqual(detectEncoding(buf), 'utf-8');
  });

  it('detects UTF-16-LE BOM', () => {
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('h\0i\0')]);
    assert.strictEqual(detectEncoding(buf), 'utf-16-le');
  });

  it('detects UTF-16-BE BOM', () => {
    const buf = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('\0h\0i')]);
    assert.strictEqual(detectEncoding(buf), 'utf-16-be');
  });

  it('treats high-null density as binary', () => {
    const arr = new Array(200).fill(0).map((_, i) => i % 5 === 0 ? 0 : 65);
    assert.strictEqual(detectEncoding(Buffer.from(arr)), 'binary');
  });

  it('returns utf-8 for empty buffer', () => {
    assert.strictEqual(detectEncoding(Buffer.alloc(0)), 'utf-8');
  });
});

// =============================================================================
// errorReason
// =============================================================================

describe('errorReason', () => {
  it('maps EACCES → permission-denied', () => {
    assert.strictEqual(errorReason({ code: 'EACCES' }), 'permission-denied');
    assert.strictEqual(errorReason({ code: 'EPERM' }), 'permission-denied');
  });
  it('maps ENOENT → not-found', () => {
    assert.strictEqual(errorReason({ code: 'ENOENT' }), 'not-found');
  });
  it('maps EMFILE → file-handle-exhausted', () => {
    assert.strictEqual(errorReason({ code: 'EMFILE' }), 'file-handle-exhausted');
    assert.strictEqual(errorReason({ code: 'ENFILE' }), 'file-handle-exhausted');
  });
  it('returns the code verbatim for unknown', () => {
    assert.strictEqual(errorReason({ code: 'EWHATEVER' }), 'EWHATEVER');
  });
  it('returns "unknown" for non-error input', () => {
    assert.strictEqual(errorReason(null), 'unknown');
    assert.strictEqual(errorReason({}), 'unknown');
  });
});

// =============================================================================
// safeReadFile — fixture
// =============================================================================

let TMP;

before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-safefs-'));
  fs.writeFileSync(path.join(TMP, 'small.js'), 'export const x = 1;');
  fs.writeFileSync(path.join(TMP, 'utf16.txt'),
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('h\0i\0')])
  );
  fs.writeFileSync(path.join(TMP, 'binary.bin'),
    Buffer.from(new Array(600).fill(0).map((_, i) => i % 4 === 0 ? 0 : 65))
  );
  // 2MB file (well above the 1MB default cap)
  fs.writeFileSync(path.join(TMP, 'huge.js'), Buffer.alloc(2 * 1024 * 1024, 65));
  fs.mkdirSync(path.join(TMP, 'nested', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(TMP, 'nested', 'a.js'), 'a');
  fs.writeFileSync(path.join(TMP, 'nested', 'deep', 'b.ts'), 'b');
  fs.mkdirSync(path.join(TMP, 'node_modules', 'lodash'), { recursive: true });
  fs.writeFileSync(path.join(TMP, 'node_modules', 'lodash', 'index.js'), 'should be skipped');
  fs.mkdirSync(path.join(TMP, '.git'), { recursive: true });
  fs.writeFileSync(path.join(TMP, '.git', 'HEAD'), 'should be skipped');
});

after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('safeReadFile', () => {
  it('reads a normal file successfully', () => {
    const r = safeReadFile(path.join(TMP, 'small.js'));
    assert.strictEqual(r.ok, true);
    assert.match(r.content, /export const x = 1;/);
  });

  it('refuses files over maxBytes', () => {
    const r = safeReadFile(path.join(TMP, 'huge.js'));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'too-large');
    assert.ok(r.size > DEFAULT_MAX_BYTES);
  });

  it('honours an override maxBytes', () => {
    const r = safeReadFile(path.join(TMP, 'huge.js'), { maxBytes: 5 * 1024 * 1024 });
    assert.strictEqual(r.ok, true);
  });

  it('returns binary for a binary file', () => {
    const r = safeReadFile(path.join(TMP, 'binary.bin'));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'binary');
  });

  it('decodes UTF-16-LE', () => {
    const r = safeReadFile(path.join(TMP, 'utf16.txt'));
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.encoding, 'utf-16-le');
    assert.strictEqual(r.content, 'hi');
  });

  it('returns not-found for a missing file', () => {
    const r = safeReadFile(path.join(TMP, 'does-not-exist.js'));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'not-found');
  });

  it('returns is-directory for a directory path', () => {
    const r = safeReadFile(path.join(TMP, 'nested'));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'is-directory');
  });
});

// =============================================================================
// walkFiles
// =============================================================================

describe('walkFiles', () => {
  it('walks the tree, skipping node_modules + .git by default', () => {
    const out = walkFiles(TMP);
    const rels = out.files.map(f => path.relative(TMP, f).split(path.sep).join('/')).sort();
    assert.ok(rels.includes('small.js'));
    assert.ok(rels.includes('nested/a.js'));
    assert.ok(rels.includes('nested/deep/b.ts'));
    // node_modules / .git skipped
    assert.ok(!rels.some(r => r.startsWith('node_modules/')));
    assert.ok(!rels.some(r => r.startsWith('.git/')));
  });

  it('respects maxFiles and reports truncation', () => {
    const out = walkFiles(TMP, { maxFiles: 2 });
    assert.strictEqual(out.files.length, 2);
    assert.strictEqual(out.truncatedAt, 2);
  });

  it('respects maxDepth', () => {
    const out = walkFiles(TMP, { maxDepth: 1 });
    const rels = out.files.map(f => path.relative(TMP, f).split(path.sep).join('/'));
    // small.js + utf16.txt + binary.bin + huge.js are at depth 0, nested/a.js is depth 1
    assert.ok(!rels.some(r => r.includes('deep/')));
  });

  it('honours a path filter', () => {
    const out = walkFiles(TMP, {
      filter: rel => rel.endsWith('.ts'),
    });
    assert.deepStrictEqual(
      out.files.map(f => path.relative(TMP, f).split(path.sep).join('/')),
      ['nested/deep/b.ts'],
    );
  });

  it('returns truncatedAt=null when below the cap', () => {
    const out = walkFiles(TMP, { maxFiles: 100 });
    assert.strictEqual(out.truncatedAt, null);
  });

  it('respectGitignore=true skips files matched by .gitignore', () => {
    fs.writeFileSync(path.join(TMP, '.gitignore'), 'utf16.txt\n');
    const out = walkFiles(TMP, { respectGitignore: true });
    const rels = out.files.map(f => path.relative(TMP, f).split(path.sep).join('/'));
    assert.ok(!rels.includes('utf16.txt'), 'utf16.txt should be ignored');
    assert.ok(rels.includes('small.js'), 'small.js should still be included');
    fs.unlinkSync(path.join(TMP, '.gitignore'));
  });
});

// =============================================================================
// readTextFiles
// =============================================================================

describe('readTextFiles', () => {
  it('returns successfully-read files only; binary + huge end up in skipped', () => {
    const out = readTextFiles(TMP);
    const okPaths = out.files.map(f => f.relativePath).sort();
    const skippedReasons = new Set(out.skipped.map(s => s.reason));
    assert.ok(okPaths.includes('small.js'));
    assert.ok(okPaths.includes('utf16.txt'));
    assert.ok(skippedReasons.has('binary'));
    assert.ok(skippedReasons.has('too-large'));
  });

  it('exposes content + encoding on each kept file', () => {
    const out = readTextFiles(TMP);
    const small = out.files.find(f => f.relativePath === 'small.js');
    assert.ok(small);
    assert.match(small.content, /export const x/);
    assert.ok(['utf-8', 'ascii'].includes(small.encoding));
  });
});
