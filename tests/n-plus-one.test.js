const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const NPlusOneModule = require('../src/modules/n-plus-one');

function makeResult() {
  return {
    checks: [],
    addCheck(name, passed, details = {}) {
      this.checks.push({ name, passed, ...details });
    },
  };
}

function run(projectRoot) {
  const mod = new NPlusOneModule();
  const result = makeResult();
  return mod.run(result, { projectRoot }).then(() => result);
}

function write(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

describe('NPlusOneModule — discovery', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-np-disc-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('skips when no source files exist', async () => {
    write(tmp, 'README.md', '# hi\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name === 'n-plus-one:no-files'));
  });

  it('scans JS/TS sources', async () => {
    write(tmp, 'src/a.ts', 'export const x = 1;\n');
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name === 'n-plus-one:scanning'));
  });
});

describe('NPlusOneModule — block-form loops', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-np-block-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('errors on Prisma query in for..of loop', async () => {
    write(tmp, 'src/a.ts', [
      'async function loadAll(userIds) {',
      '  const out = [];',
      '  for (const id of userIds) {',
      '    const u = await prisma.user.findUnique({ where: { id } });',
      '    out.push(u);',
      '  }',
      '  return out;',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const hit = r.checks.find((c) => c.name.startsWith('n-plus-one:query-in-loop:'));
    assert.ok(hit);
    assert.strictEqual(hit.severity, 'error');
    assert.strictEqual(hit.loopStart, 3);
  });

  it('errors on Sequelize query in while loop', async () => {
    write(tmp, 'src/a.js', [
      'async function run() {',
      '  let i = 0;',
      '  while (i < 10) {',
      '    const u = await User.findOne({ where: { id: i } });',
      '    i += 1;',
      '  }',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('n-plus-one:query-in-loop:')));
  });

  it('errors on raw pool.query in for loop', async () => {
    write(tmp, 'src/a.js', [
      'async function run(ids) {',
      '  for (let i = 0; i < ids.length; i += 1) {',
      '    await pool.query("SELECT * FROM users WHERE id = $1", [ids[i]]);',
      '  }',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('n-plus-one:query-in-loop:')));
  });
});

describe('NPlusOneModule — callback-form loops', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-np-cb-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('errors on prisma query in forEach', async () => {
    write(tmp, 'src/a.ts', [
      'async function run(users) {',
      '  users.forEach(async (u) => {',
      '    await prisma.order.findMany({ where: { userId: u.id } });',
      '  });',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('n-plus-one:query-in-loop:')));
  });

  it('records info on `await Promise.all(arr.map(async () => await db.query(...)))` (batched-ok)', async () => {
    write(tmp, 'src/a.ts', [
      'async function run(userIds) {',
      '  return await Promise.all(userIds.map(async (id) => {',
      '    return await prisma.user.findUnique({ where: { id } });',
      '  }));',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const issues = r.checks.filter((c) => c.passed === false);
    assert.strictEqual(issues.length, 0, `expected zero issues, got: ${JSON.stringify(issues)}`);
    assert.ok(r.checks.find((c) => c.name.startsWith('n-plus-one:batched-ok:')));
  });
});

describe('NPlusOneModule — negatives', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-np-neg-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('does NOT flag a query NOT in a loop', async () => {
    write(tmp, 'src/a.ts', [
      'async function loadOne(id) {',
      '  return await prisma.user.findUnique({ where: { id } });',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('n-plus-one:query-in-loop:')),
      undefined,
    );
  });

  it('does NOT flag a synchronous operation in a loop', async () => {
    write(tmp, 'src/a.ts', [
      'function run(items) {',
      '  for (const item of items) {',
      '    const x = item.id * 2;',
      '    console.log(x);',
      '  }',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('n-plus-one:query-in-loop:')),
      undefined,
    );
  });

  it('does NOT flag a non-query await in a loop (e.g. crypto)', async () => {
    write(tmp, 'src/a.ts', [
      'async function run(items) {',
      '  for (const item of items) {',
      '    const hash = await crypto.subtle.digest("SHA-256", item.buf);',
      '    item.hash = hash;',
      '  }',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('n-plus-one:query-in-loop:')),
      undefined,
    );
  });

  it('does NOT flag query shape embedded in a string literal', async () => {
    write(tmp, 'src/a.ts', [
      'function docs() {',
      '  const example = "for (const x of arr) { await prisma.user.findUnique(); }";',
      '  return example;',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.strictEqual(
      r.checks.find((c) => c.name.startsWith('n-plus-one:query-in-loop:')),
      undefined,
    );
  });
});

describe('NPlusOneModule — ORM coverage', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-np-orm-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('detects Mongoose Model.findOne in a loop', async () => {
    write(tmp, 'src/a.js', [
      'async function run(ids) {',
      '  for (const id of ids) {',
      '    const u = await User.findOne({ _id: id });',
      '  }',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('n-plus-one:query-in-loop:')));
  });

  it('detects TypeORM repo.findOneBy in a loop', async () => {
    write(tmp, 'src/a.ts', [
      'async function run(ids) {',
      '  for (const id of ids) {',
      '    const u = await repo.findOneBy({ id });',
      '  }',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('n-plus-one:query-in-loop:')));
  });

  it('detects Drizzle db.select in a loop', async () => {
    write(tmp, 'src/a.ts', [
      'async function run(ids) {',
      '  for (const id of ids) {',
      '    const u = await db.select().from(users).where(eq(users.id, id));',
      '  }',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    assert.ok(r.checks.find((c) => c.name.startsWith('n-plus-one:query-in-loop:')));
  });
});

describe('NPlusOneModule — clean baseline', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-np-clean-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('emits zero findings for batched code', async () => {
    write(tmp, 'src/a.ts', [
      'async function loadAll(ids) {',
      '  return await prisma.user.findMany({ where: { id: { in: ids } } });',
      '}',
      '',
    ].join('\n'));
    const r = await run(tmp);
    const issues = r.checks.filter((c) => c.passed === false);
    assert.strictEqual(issues.length, 0);
  });

  it('records a summary', async () => {
    write(tmp, 'src/a.ts', 'export const x = 1;\n');
    const r = await run(tmp);
    const s = r.checks.find((c) => c.name === 'n-plus-one:summary');
    assert.ok(s);
    assert.match(s.message, /1 file\(s\)/);
  });
});
