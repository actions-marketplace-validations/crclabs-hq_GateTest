const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const LogPiiModule = require('../src/modules/log-pii');

function makeResult() {
  return {
    checks: [],
    addCheck(name, passed, details = {}) {
      this.checks.push({ name, passed, ...details });
    },
  };
}

function run(projectRoot) {
  const mod = new LogPiiModule();
  const result = makeResult();
  return mod.run(result, { projectRoot }).then(() => result);
}

function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

describe('LogPiiModule — discovery', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-lp-disc-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('no-op when nothing to scan', async () => {
    write(tmp, 'README.md', '# hi\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name === 'log-pii:no-files'));
  });

  it('summary when files are scanned', async () => {
    write(tmp, 'src/a.ts', 'const x = 1;\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name === 'log-pii:summary'));
  });
});

describe('LogPiiModule — JS sensitive identifier', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-lp-sens-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('errors on console.log(password)', async () => {
    write(tmp, 'src/a.js', 'console.log(password);\n');
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name && c.name.startsWith('log-pii:sensitive-arg:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'error');
  });

  it('errors on logger.info(token)', async () => {
    write(tmp, 'src/a.js', 'logger.info(token);\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name && c.name.startsWith('log-pii:sensitive-arg:')));
  });

  it('errors on log.debug(apiKey)', async () => {
    write(tmp, 'src/a.js', 'log.debug(apiKey);\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name && c.name.startsWith('log-pii:sensitive-arg:')));
  });

  it('errors on console.warn(authorization)', async () => {
    write(tmp, 'src/a.js', 'console.warn(authorization);\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name && c.name.startsWith('log-pii:sensitive-arg:')));
  });

  it('does not flag non-sensitive identifiers', async () => {
    write(tmp, 'src/a.js', 'console.log(username);\nlogger.info(email);\n');
    const r = await run(tmp);
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('log-pii:'),
    );
    assert.strictEqual(hits.length, 0);
  });
});

describe('LogPiiModule — JS object-dump', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-lp-obj-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('warns on console.log(req)', async () => {
    write(tmp, 'src/a.js', 'console.log(req);\n');
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name && c.name.startsWith('log-pii:object-dump:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'warning');
  });

  it('warns on logger.info(user)', async () => {
    write(tmp, 'src/a.js', 'logger.info(user);\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name && c.name.startsWith('log-pii:object-dump:')));
  });

  it('warns on log.debug(headers)', async () => {
    write(tmp, 'src/a.js', 'log.debug(headers);\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name && c.name.startsWith('log-pii:object-dump:')));
  });
});

describe('LogPiiModule — JSON.stringify dump', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-lp-str-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('warns on console.log(JSON.stringify(user))', async () => {
    write(tmp, 'src/a.js', 'console.log(JSON.stringify(user));\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name && c.name.startsWith('log-pii:stringify-dump:')));
  });

  it('warns on logger.info(JSON.stringify(req))', async () => {
    write(tmp, 'src/a.js', 'logger.info(JSON.stringify(req));\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name && c.name.startsWith('log-pii:stringify-dump:')));
  });
});

describe('LogPiiModule — template-string interpolation', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-lp-tpl-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('errors on sensitive identifier in template', async () => {
    write(tmp, 'src/a.js', 'console.log(`auth=${password}`);\n');
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name && c.name.startsWith('log-pii:sensitive-interp:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'error');
  });

  it('warns on object in template', async () => {
    write(tmp, 'src/a.js', 'logger.info(`user=${user}`);\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name && c.name.startsWith('log-pii:object-interp:')));
  });
});

describe('LogPiiModule — Python', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-lp-py-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('errors on print(password)', async () => {
    write(tmp, 'src/a.py', 'print(password)\n');
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name && c.name.startsWith('log-pii:py-print-sensitive:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'error');
  });

  it('errors on logger.info(token)', async () => {
    write(tmp, 'src/a.py', 'logger.info(token)\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name && c.name.startsWith('log-pii:py-print-sensitive:')));
  });

  it('warns on print(request)', async () => {
    write(tmp, 'src/a.py', 'print(request)\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name && c.name.startsWith('log-pii:py-object-dump:')));
  });
});

describe('LogPiiModule — suppressions', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-lp-sup-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('honours // log-safe on the same line (JS)', async () => {
    write(tmp, 'src/a.js', 'console.log(password); // log-safe — test fixture\n');
    const r = await run(tmp);
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('log-pii:'),
    );
    assert.strictEqual(hits.length, 0);
  });

  it('honours # log-safe on the same line (Python)', async () => {
    write(tmp, 'src/a.py', 'print(password)  # log-safe\n');
    const r = await run(tmp);
    const hits = r.checks.filter(
      (c) => c.passed === false && c.name && c.name.startsWith('log-pii:'),
    );
    assert.strictEqual(hits.length, 0);
  });
});

describe('LogPiiModule — test path downgrade', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-lp-t-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('downgrades error -> warning in test paths (JS)', async () => {
    write(tmp, 'tests/a.test.js', 'console.log(password);\n');
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name && c.name.startsWith('log-pii:sensitive-arg:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'warning');
  });

  it('downgrades warning -> info in test paths (JS object-dump)', async () => {
    write(tmp, 'tests/a.test.js', 'console.log(req);\n');
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name && c.name.startsWith('log-pii:object-dump:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'info');
  });
});
