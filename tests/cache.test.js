const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { GateTestCache } = require('../src/core/cache');

describe('GateTestCache', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatetest-cache-'));
    fs.mkdirSync(path.join(tmpDir, '.gatetest'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should detect new files as changed', () => {
    const cache = new GateTestCache(tmpDir);
    const testFile = path.join(tmpDir, 'test.js');
    fs.writeFileSync(testFile, 'console.log("hello");');

    assert.strictEqual(cache.hasChanged(testFile), true);
  });

  it('should detect unchanged files after update', () => {
    const cache = new GateTestCache(tmpDir);
    const testFile = path.join(tmpDir, 'test.js');
    fs.writeFileSync(testFile, 'console.log("hello");');

    cache.update(testFile);
    assert.strictEqual(cache.hasChanged(testFile), false);
  });

  it('should detect modified files', () => {
    const cache = new GateTestCache(tmpDir);
    const testFile = path.join(tmpDir, 'test.js');
    fs.writeFileSync(testFile, 'console.log("hello");');

    cache.update(testFile);
    assert.strictEqual(cache.hasChanged(testFile), false);

    // Modify the file
    fs.writeFileSync(testFile, 'console.log("world");');
    assert.strictEqual(cache.hasChanged(testFile), true);
  });

  it('should persist cache to disk', () => {
    const cache = new GateTestCache(tmpDir);
    const testFile = path.join(tmpDir, 'test.js');
    fs.writeFileSync(testFile, 'content');
    cache.update(testFile);
    cache.save();

    // Load fresh cache
    const cache2 = new GateTestCache(tmpDir);
    assert.strictEqual(cache2.hasChanged(testFile), false);
  });

  it('should filter changed files from a list', () => {
    const cache = new GateTestCache(tmpDir);
    const f1 = path.join(tmpDir, 'a.js');
    const f2 = path.join(tmpDir, 'b.js');
    fs.writeFileSync(f1, 'a');
    fs.writeFileSync(f2, 'b');

    cache.update(f1); // f1 is cached
    // f2 is not cached

    const changed = cache.filterChanged([f1, f2]);
    assert.strictEqual(changed.length, 1);
    assert.ok(changed[0].includes('b.js'));
  });

  it('should report cache stats', () => {
    const cache = new GateTestCache(tmpDir);
    const testFile = path.join(tmpDir, 'test.js');
    fs.writeFileSync(testFile, 'content');
    cache.update(testFile);

    const stats = cache.stats();
    assert.strictEqual(stats.entries, 1);
  });

  it('should clear cache', () => {
    const cache = new GateTestCache(tmpDir);
    const testFile = path.join(tmpDir, 'test.js');
    fs.writeFileSync(testFile, 'content');
    cache.update(testFile);
    cache.save();

    cache.clear();
    assert.strictEqual(cache.hasChanged(testFile), true);
    assert.strictEqual(cache.stats().entries, 0);
  });

  it('should handle nonexistent files gracefully', () => {
    const cache = new GateTestCache(tmpDir);
    assert.strictEqual(cache.hasChanged('/nonexistent/file.js'), true);
  });
});
