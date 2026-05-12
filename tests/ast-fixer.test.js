const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { tryAstFix, applyAstTransforms, TRANSFORMS, isJsOrTs } = require('../website/app/lib/ast-fixer.js');

// ---------------------------------------------------------------------------
// isJsOrTs helper
// ---------------------------------------------------------------------------

describe('isJsOrTs', () => {
  it('returns true for JS/TS extensions', () => {
    for (const ext of ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']) {
      assert.ok(isJsOrTs(`foo${ext}`), `expected true for ${ext}`);
    }
  });

  it('returns false for Python / YAML / shell', () => {
    for (const ext of ['.py', '.yml', '.sh', '.rb', '.go']) {
      assert.ok(!isJsOrTs(`foo${ext}`), `expected false for ${ext}`);
    }
  });

  it('returns false for null / empty', () => {
    assert.ok(!isJsOrTs(null));
    assert.ok(!isJsOrTs(''));
  });
});

// ---------------------------------------------------------------------------
// tryAstFix — fast path
// ---------------------------------------------------------------------------

describe('tryAstFix', () => {
  it('returns null for empty issues', () => {
    assert.equal(tryAstFix('const x = 1;', 'f.js', []), null);
  });

  it('returns null for Python files', () => {
    assert.equal(tryAstFix('verify=False', 'f.py', ['verify=False']), null);
  });

  it('returns null when no transform matches', () => {
    assert.equal(tryAstFix('const x = 1;', 'f.js', ['COMPLETELY_UNKNOWN_XYZ_ISSUE']), null);
  });

  it('returns null when a transform matched but made no change', () => {
    // rejectUnauthorized is already true — transform matches but changes nothing
    const content = 'const o = { rejectUnauthorized: true };';
    assert.equal(tryAstFix(content, 'f.js', ['rejectUnauthorized: false']), null);
  });

  it('returns null when any issue is unhandled', () => {
    const content = 'const o = { rejectUnauthorized: false };';
    assert.equal(tryAstFix(content, 'f.js', ['rejectUnauthorized: false', 'UNKNOWN_XYZ']), null);
  });

  it('returns fixed content when all issues are handled', () => {
    const content = 'const o = { rejectUnauthorized: false };';
    const result = tryAstFix(content, 'f.js', ['rejectUnauthorized: false — TLS disabled']);
    assert.ok(result !== null);
    assert.match(result, /rejectUnauthorized: true/);
  });
});

// ---------------------------------------------------------------------------
// rejectUnauthorized
// ---------------------------------------------------------------------------

describe('AST: rejectUnauthorized', () => {
  it('flips nested property in multi-line object', () => {
    const content = `const agent = new https.Agent({
  keepAlive: true,
  rejectUnauthorized: false,
  timeout: 5000,
});`;
    const result = tryAstFix(content, 'server.js', ['rejectUnauthorized: false']);
    assert.ok(result !== null);
    assert.match(result, /rejectUnauthorized: true/);
    assert.doesNotMatch(result, /rejectUnauthorized: false/);
  });

  it('flips deeply nested property', () => {
    const content = `export default {
  https: {
    agent: {
      rejectUnauthorized: false,
    },
  },
};`;
    const result = tryAstFix(content, 'config.ts', ['rejectUnauthorized: false']);
    assert.ok(result !== null);
    assert.match(result, /rejectUnauthorized: true/);
  });

  it('fixes multiple occurrences in same file', () => {
    const content = `const a = { rejectUnauthorized: false };\nconst b = { rejectUnauthorized: false };\n`;
    const result = applyAstTransforms(content, 'f.js', ['rejectUnauthorized: false']);
    assert.equal((result.content.match(/rejectUnauthorized: true/g) || []).length, 2);
  });
});

// ---------------------------------------------------------------------------
// TLS env bypass
// ---------------------------------------------------------------------------

describe('AST: NODE_TLS_REJECT_UNAUTHORIZED', () => {
  it('removes the assignment statement', () => {
    const content = `process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";\nconst x = 1;\n`;
    const result = tryAstFix(content, 'f.js', ['NODE_TLS_REJECT_UNAUTHORIZED = "0"']);
    assert.ok(result !== null);
    assert.doesNotMatch(result, /NODE_TLS_REJECT_UNAUTHORIZED/);
    assert.match(result, /const x = 1/);
  });

  it('also handles bracket notation process.env["NODE_TLS_REJECT_UNAUTHORIZED"]', () => {
    const content = `process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";\n`;
    const result = tryAstFix(content, 'f.js', ['NODE_TLS_REJECT_UNAUTHORIZED']);
    assert.ok(result !== null);
    assert.doesNotMatch(result, /NODE_TLS_REJECT_UNAUTHORIZED/);
  });
});

// ---------------------------------------------------------------------------
// strictSSL
// ---------------------------------------------------------------------------

describe('AST: strictSSL', () => {
  it('flips strictSSL: false to true', () => {
    const content = `request({
  url,
  strictSSL: false,
  method: 'GET',
});\n`;
    const result = tryAstFix(content, 'f.js', ['strictSSL: false']);
    assert.ok(result !== null);
    assert.match(result, /strictSSL: true/);
  });
});

// ---------------------------------------------------------------------------
// insecure: true
// ---------------------------------------------------------------------------

describe('AST: insecure flag', () => {
  it('flips insecure: true to false', () => {
    const content = `got(url, { insecure: true });\n`;
    const result = tryAstFix(content, 'f.js', ['insecure: true (js-insecure-flag)']);
    assert.ok(result !== null);
    assert.match(result, /insecure: false/);
  });
});

// ---------------------------------------------------------------------------
// httpOnly
// ---------------------------------------------------------------------------

describe('AST: httpOnly', () => {
  it('flips httpOnly: false in nested cookie options', () => {
    const content = `app.use(session({
  secret: 'x',
  cookie: {
    httpOnly: false,
    maxAge: 86400000,
  },
}));\n`;
    const result = tryAstFix(content, 'app.js', ['httpOnly: false — js-httponly-false']);
    assert.ok(result !== null);
    assert.match(result, /httpOnly: true/);
  });
});

// ---------------------------------------------------------------------------
// secure
// ---------------------------------------------------------------------------

describe('AST: secure cookie', () => {
  it('flips secure: false in object literal', () => {
    const content = `res.cookie('auth', token, {\n  secure: false,\n  httpOnly: true,\n});\n`;
    const result = tryAstFix(content, 'f.js', ['secure: false — js-secure-false']);
    assert.ok(result !== null);
    assert.match(result, /secure: true/);
  });
});

// ---------------------------------------------------------------------------
// parseInt radix
// ---------------------------------------------------------------------------

describe('AST: parseInt radix', () => {
  it('adds radix 10 to bare parseInt call', () => {
    const content = `const n = parseInt(str);\n`;
    const result = tryAstFix(content, 'f.js', ['parseInt without radix']);
    assert.ok(result !== null);
    assert.match(result, /parseInt\(str,\s*10\)/);
  });

  it('does not double-add radix when already present', () => {
    const content = `const n = parseInt(str, 10);\n`;
    const r = applyAstTransforms(content, 'f.js', ['parseInt without radix']);
    // Transform matches but makes no changes (already has radix)
    assert.equal(r.unhandled.length, 1);
    assert.doesNotMatch(r.content, /parseInt\(str, 10, 10\)/);
  });

  it('handles window.parseInt', () => {
    const content = `const n = window.parseInt(str);\n`;
    const result = tryAstFix(content, 'f.js', ['missing radix — parseInt']);
    assert.ok(result !== null);
    assert.match(result, /parseInt\(str,\s*10\)/);
  });
});

// ---------------------------------------------------------------------------
// var → const
// ---------------------------------------------------------------------------

describe('AST: var to const', () => {
  it('converts var declaration to const', () => {
    const content = `var x = 1;\nvar y = 2;\n`;
    const result = tryAstFix(content, 'f.js', ['var declaration — prefer const']);
    assert.ok(result !== null);
    assert.doesNotMatch(result, /\bvar\b/);
    assert.match(result, /const x/);
    assert.match(result, /const y/);
  });

  it('handles var inside a function', () => {
    const content = `function foo() {\n  var msg = "hello";\n  return msg;\n}\n`;
    const result = tryAstFix(content, 'f.ts', ['var declaration — use const/let']);
    assert.ok(result !== null);
    assert.match(result, /const msg/);
  });
});

// ---------------------------------------------------------------------------
// Empty catch block
// ---------------------------------------------------------------------------

describe('AST: empty catch block', () => {
  it('adds throw statement to empty catch with named param', () => {
    const content = `try {\n  doSomething();\n} catch (err) {\n}\n`;
    const result = tryAstFix(content, 'f.js', ['empty catch block — error swallowed']);
    assert.ok(result !== null);
    assert.match(result, /throw err/);
  });
});

// ---------------------------------------------------------------------------
// Multiple transforms on one file
// ---------------------------------------------------------------------------

describe('AST: multiple transforms', () => {
  it('applies httpOnly and rejectUnauthorized in single AST pass', () => {
    const content = `const agent = { rejectUnauthorized: false };\nconst cookie = { httpOnly: false };\n`;
    const result = tryAstFix(content, 'f.js', [
      'rejectUnauthorized: false',
      'httpOnly: false — js-httponly-false',
    ]);
    assert.ok(result !== null);
    assert.match(result, /rejectUnauthorized: true/);
    assert.match(result, /httpOnly: true/);
  });
});

// ---------------------------------------------------------------------------
// TypeScript-specific parsing
// ---------------------------------------------------------------------------

describe('AST: TypeScript', () => {
  it('parses TypeScript files with type annotations', () => {
    const content = `const opts: AgentOptions = { rejectUnauthorized: false };\n`;
    const result = tryAstFix(content, 'server.ts', ['rejectUnauthorized: false']);
    assert.ok(result !== null);
    assert.match(result, /rejectUnauthorized: true/);
  });

  it('parses TSX files', () => {
    const content = `const opts = { httpOnly: false };\nexport default function Page() { return <div />; }\n`;
    const result = tryAstFix(content, 'page.tsx', ['httpOnly: false']);
    assert.ok(result !== null);
    assert.match(result, /httpOnly: true/);
  });
});

// ---------------------------------------------------------------------------
// Parse failure graceful degradation
// ---------------------------------------------------------------------------

describe('AST: graceful degradation', () => {
  it('returns null (not crash) on unparseable content', () => {
    const garbage = 'const x = {{{{{{{{{{ this is not valid JS';
    const result = tryAstFix(garbage, 'f.js', ['rejectUnauthorized: false']);
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// TRANSFORMS array shape
// ---------------------------------------------------------------------------

describe('TRANSFORMS array', () => {
  it('every transform has name, matches, transform', () => {
    for (const t of TRANSFORMS) {
      assert.ok(typeof t.name === 'string' && t.name.length > 0);
      assert.ok(typeof t.matches === 'function');
      assert.ok(typeof t.transform === 'function');
    }
  });

  it('has at least 6 transforms', () => {
    assert.ok(TRANSFORMS.length >= 6);
  });
});
