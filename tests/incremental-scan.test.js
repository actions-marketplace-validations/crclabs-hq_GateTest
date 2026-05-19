const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const BaseModule = require('../src/modules/base-module');

function makeTmpRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gatetest-incr-'));
  fs.writeFileSync(path.join(root, 'a.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(root, 'b.js'), 'module.exports = 2;\n');
  fs.writeFileSync(path.join(root, 'c.ts'), 'export default 3;\n');
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'sub', 'd.js'), 'module.exports = 4;\n');
  return root;
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

test('_collectFiles returns all matching files when no incremental context set', () => {
  const root = makeTmpRepo();
  try {
    const mod = new BaseModule('test', 'test');
    const files = mod._collectFiles(root, ['.js']);
    assert.equal(files.length, 3, 'finds 3 .js files');
    assert.ok(files.some((f) => f.endsWith('a.js')));
    assert.ok(files.some((f) => f.endsWith('b.js')));
    assert.ok(files.some((f) => f.endsWith(path.join('sub', 'd.js'))));
  } finally {
    cleanup(root);
  }
});

test('_collectFiles filters to changed files when incremental context is set', () => {
  const root = makeTmpRepo();
  try {
    const mod = new BaseModule('test', 'test');
    mod._incrementalContext = {
      changedFilesAbs: new Set([
        path.join(root, 'a.js'),
        path.join(root, 'sub', 'd.js'),
      ]),
    };
    const files = mod._collectFiles(root, ['.js']);
    assert.equal(files.length, 2, 'filters to the 2 changed .js files');
    assert.ok(files.some((f) => f.endsWith('a.js')));
    assert.ok(files.some((f) => f.endsWith(path.join('sub', 'd.js'))));
    assert.ok(!files.some((f) => f.endsWith('b.js')), 'b.js is excluded');
  } finally {
    cleanup(root);
  }
});

test('_collectFiles returns empty when no changed files match the extension', () => {
  const root = makeTmpRepo();
  try {
    const mod = new BaseModule('test', 'test');
    mod._incrementalContext = {
      changedFilesAbs: new Set([path.join(root, 'c.ts')]),
    };
    const files = mod._collectFiles(root, ['.js']);
    assert.equal(files.length, 0, 'changed file is .ts, asking for .js → none');
  } finally {
    cleanup(root);
  }
});

test('_respectsIncremental = false bypasses the filter even when context set', () => {
  const root = makeTmpRepo();
  try {
    const mod = new BaseModule('test', 'test');
    mod._respectsIncremental = false;
    mod._incrementalContext = {
      changedFilesAbs: new Set([path.join(root, 'a.js')]),
    };
    const files = mod._collectFiles(root, ['.js']);
    assert.equal(files.length, 3, 'opt-out module still gets full set');
  } finally {
    cleanup(root);
  }
});

test('empty changedFilesAbs Set returns empty list (no changed files = nothing to scan)', () => {
  const root = makeTmpRepo();
  try {
    const mod = new BaseModule('test', 'test');
    mod._incrementalContext = { changedFilesAbs: new Set() };
    const files = mod._collectFiles(root, ['.js']);
    assert.equal(files.length, 0);
  } finally {
    cleanup(root);
  }
});

test('changedFilesAbs that is not a Set is ignored (defensive)', () => {
  const root = makeTmpRepo();
  try {
    const mod = new BaseModule('test', 'test');
    // Pass an array, not a Set — should not crash, should not filter.
    mod._incrementalContext = { changedFilesAbs: ['a.js'] };
    const files = mod._collectFiles(root, ['.js']);
    assert.equal(files.length, 3, 'malformed context → full set');
  } finally {
    cleanup(root);
  }
});

test('absolute-path filter handles paths inside excluded dirs correctly', () => {
  const root = makeTmpRepo();
  try {
    // Add a file inside node_modules — should be walked-excluded
    // regardless of incremental filter.
    fs.mkdirSync(path.join(root, 'node_modules'));
    fs.writeFileSync(path.join(root, 'node_modules', 'x.js'), '');
    const mod = new BaseModule('test', 'test');
    mod._incrementalContext = {
      changedFilesAbs: new Set([path.join(root, 'node_modules', 'x.js')]),
    };
    const files = mod._collectFiles(root, ['.js']);
    assert.equal(files.length, 0, 'node_modules excluded by walker, intersection is empty');
  } finally {
    cleanup(root);
  }
});

test('runner stamps _incrementalContext on every registered module when diffOnly + changedFiles', () => {
  const { GateTestRunner } = require('../src/core/runner');
  const config = { projectRoot: '/tmp/fake-root' };
  const runner = new GateTestRunner(config, {
    diffOnly: true,
    changedFiles: ['src/a.js', 'src/b.js'],
  });

  // Register a couple of stub modules.
  const mod1 = { name: 'm1', run: async () => {} };
  const mod2 = { name: 'm2', run: async () => {} };
  runner.register('m1', mod1);
  runner.register('m2', mod2);

  // Force the run path that stamps the context (we can't easily run
  // the full pipeline, so call run() with an empty module list which
  // exits early after the stamp).
  return runner.run([]).then(() => {
    assert.ok(mod1._incrementalContext, 'm1 stamped');
    assert.ok(mod2._incrementalContext, 'm2 stamped');
    assert.ok(mod1._incrementalContext.changedFilesAbs instanceof Set);
    assert.equal(mod1._incrementalContext.changedFilesAbs.size, 2);
    assert.ok(mod1._incrementalContext.changedFilesAbs.has(path.resolve('/tmp/fake-root', 'src/a.js')));
  });
});

test('runner does NOT stamp _incrementalContext when diffOnly is off', () => {
  const { GateTestRunner } = require('../src/core/runner');
  const config = { projectRoot: '/tmp/fake-root' };
  const runner = new GateTestRunner(config, { diffOnly: false });

  const mod = { name: 'm', run: async () => {} };
  runner.register('m', mod);

  return runner.run([]).then(() => {
    assert.equal(mod._incrementalContext, undefined, 'no stamp without diffOnly');
  });
});

test('runner does NOT stamp when changedFiles is empty (would block all scans)', () => {
  const { GateTestRunner } = require('../src/core/runner');
  const config = { projectRoot: '/tmp/fake-root' };
  const runner = new GateTestRunner(config, {
    diffOnly: true,
    changedFiles: [],
  });

  const mod = { name: 'm', run: async () => {} };
  runner.register('m', mod);

  return runner.run([]).then(() => {
    assert.equal(mod._incrementalContext, undefined, 'empty changedFiles is treated as "not in diff mode" — no stamp, full scan');
  });
});
