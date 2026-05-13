const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { runLanguageChecks, collectLanguageFiles, LANGUAGE_SPECS } = require('../src/core/universal-checker');

function mkResult() {
  return {
    checks: [],
    addCheck(name, passed, details) {
      this.checks.push({ name, passed, ...details });
    },
  };
}

describe('UniversalChecker', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatetest-universal-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exposes all 9 language specs', () => {
    const expected = ['python', 'go', 'rust', 'java', 'ruby', 'php', 'csharp', 'kotlin', 'swift'];
    for (const lang of expected) {
      assert.ok(LANGUAGE_SPECS[lang], `LANGUAGE_SPECS.${lang} must be defined`);
      assert.ok(LANGUAGE_SPECS[lang].extensions.length > 0);
      assert.ok(LANGUAGE_SPECS[lang].patterns.length > 0);
    }
  });

  it('records no-files check when the language is absent', () => {
    const result = mkResult();
    runLanguageChecks('python', tmpDir, result);
    const nofiles = result.checks.find((c) => c.name === 'python:no-files');
    assert.ok(nofiles, 'python:no-files check must be recorded');
  });

  it('detects Python eval() as an error', () => {
    fs.writeFileSync(path.join(tmpDir, 'bad.py'), "user_input = 'x'\nresult = eval(user_input)\n");
    const result = mkResult();
    runLanguageChecks('python', tmpDir, result);
    const issue = result.checks.find((c) => c.name.startsWith('python:eval:'));
    assert.ok(issue, 'eval() must be flagged');
    assert.strictEqual(issue.severity, 'error');
    assert.strictEqual(issue.passed, false);
  });

  it('detects Python bare except as a warning', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'bad.py'),
      "try:\n    x = 1\nexcept:\n    pass\n",
    );
    const result = mkResult();
    runLanguageChecks('python', tmpDir, result);
    const issue = result.checks.find((c) => c.name.startsWith('python:bare-except:'));
    assert.ok(issue, 'bare except must be flagged');
    assert.strictEqual(issue.severity, 'warning');
  });

  it('skips comment lines to avoid false positives', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'good.py'),
      "# eval(user_input) would be dangerous but this is just a comment\nx = 1\n",
    );
    const result = mkResult();
    runLanguageChecks('python', tmpDir, result);
    const issue = result.checks.find((c) => c.name.startsWith('python:eval:'));
    assert.strictEqual(issue, undefined, 'eval in comment must NOT be flagged');
  });

  it('downgrades warnings in test files to info', () => {
    const testDir = path.join(tmpDir, 'tests');
    fs.mkdirSync(testDir);
    fs.writeFileSync(
      path.join(testDir, 'test_foo.py'),
      "try:\n    x = 1\nexcept:\n    pass\n",
    );
    const result = mkResult();
    runLanguageChecks('python', tmpDir, result);
    const issue = result.checks.find((c) => c.name.startsWith('python:bare-except:'));
    assert.ok(issue);
    assert.strictEqual(issue.severity, 'info', 'test file warnings should be downgraded to info');
  });

  it('detects Rust .unwrap() and flags todo!()', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'main.rs'),
      'fn main() {\n    let x: Option<i32> = None;\n    let y = x.unwrap();\n    todo!();\n}\n',
    );
    const result = mkResult();
    runLanguageChecks('rust', tmpDir, result);
    const unwrap = result.checks.find((c) => c.name.startsWith('rust:unwrap:'));
    const todo = result.checks.find((c) => c.name.startsWith('rust:todo-macro:'));
    assert.ok(unwrap);
    assert.ok(todo);
    assert.strictEqual(todo.severity, 'error');
  });

  it('detects Kotlin !! and TODO()', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'Foo.kt'),
      'fun foo(x: String?) {\n    val y = x!!\n    TODO("implement")\n}\n',
    );
    const result = mkResult();
    runLanguageChecks('kotlin', tmpDir, result);
    const notNull = result.checks.find((c) => c.name.startsWith('kotlin:not-null-assert:'));
    const todoCall = result.checks.find((c) => c.name.startsWith('kotlin:todo-call:'));
    assert.ok(notNull);
    assert.ok(todoCall);
  });

  it('detects PHP eval and mysql_ legacy', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'app.php'),
      "<?php\neval($_GET['x']);\nmysql_query('SELECT 1');\n",
    );
    const result = mkResult();
    runLanguageChecks('php', tmpDir, result);
    assert.ok(result.checks.find((c) => c.name.startsWith('php:eval:')));
    assert.ok(result.checks.find((c) => c.name.startsWith('php:mysql-legacy:')));
  });

  it('records a summary check per language run', () => {
    fs.writeFileSync(path.join(tmpDir, 'a.go'), 'package main\n');
    const result = mkResult();
    runLanguageChecks('go', tmpDir, result);
    const summary = result.checks.find((c) => c.name === 'go:summary');
    assert.ok(summary, 'go:summary must be recorded');
  });

  it('handles unknown language gracefully', () => {
    const result = mkResult();
    runLanguageChecks('brainfuck', tmpDir, result);
    const err = result.checks.find((c) => c.name === 'brainfuck:unknown-language');
    assert.ok(err);
    assert.strictEqual(err.passed, false);
  });

  it('collectLanguageFiles walks the project root but skips excludes', () => {
    fs.writeFileSync(path.join(tmpDir, 'a.py'), '');
    fs.mkdirSync(path.join(tmpDir, 'node_modules'));
    fs.writeFileSync(path.join(tmpDir, 'node_modules', 'b.py'), '');
    fs.mkdirSync(path.join(tmpDir, '.gatetest'));
    fs.writeFileSync(path.join(tmpDir, '.gatetest', 'c.py'), '');

    const files = collectLanguageFiles(tmpDir, ['.py']);
    assert.strictEqual(files.length, 1, 'excluded dirs must not be walked');
    assert.ok(files[0].endsWith('a.py'));
  });
});
