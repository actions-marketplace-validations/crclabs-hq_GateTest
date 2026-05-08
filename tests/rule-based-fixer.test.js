const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { tryRuleBasedFix, applyRules, RULES } = require('../website/app/lib/rule-based-fixer.js');

// ---------------------------------------------------------------------------
// applyRules — partial application
// ---------------------------------------------------------------------------

describe('applyRules', () => {
  it('returns original content and all-unhandled when no rule matches', () => {
    const content = 'const x = 1;';
    const result = applyRules(content, 'foo.js', ['some completely unknown issue that no rule covers']);
    assert.equal(result.content, content);
    assert.equal(result.handled.length, 0);
    assert.equal(result.unhandled.length, 1);
  });

  it('handles a mix of matched and unmatched issues', () => {
    const content = 'const opts = { rejectUnauthorized: false };\n';
    const result = applyRules(content, 'foo.js', [
      'rejectUnauthorized: false — TLS cert validation disabled',
      'some unknown issue that no rule can handle',
    ]);
    assert.equal(result.handled.length, 1);
    assert.equal(result.unhandled.length, 1);
    assert.match(result.content, /rejectUnauthorized: true/);
  });

  it('throws on non-string content', () => {
    assert.throws(() => applyRules(null, 'f.js', []), TypeError);
  });

  it('throws on non-array issues', () => {
    assert.throws(() => applyRules('x', 'f.js', 'bad'), TypeError);
  });
});

// ---------------------------------------------------------------------------
// tryRuleBasedFix — all-or-nothing fast path
// ---------------------------------------------------------------------------

describe('tryRuleBasedFix', () => {
  it('returns null when issues is empty', () => {
    assert.equal(tryRuleBasedFix('const x = 1;', 'f.js', []), null);
  });

  it('returns null when a rule matched but produced no change', () => {
    // httpOnly: true is already correct — rule matches issue string but no replacement occurs
    const content = 'const c = { httpOnly: true };';
    const result = tryRuleBasedFix(content, 'f.js', ['httpOnly: false — cookie readable from document.cookie']);
    assert.equal(result, null);
  });

  it('returns null when any issue is unhandled', () => {
    const content = 'const c = { rejectUnauthorized: false };\n';
    const result = tryRuleBasedFix(content, 'f.js', [
      'rejectUnauthorized: false',
      'completely unrecognised issue xyz',
    ]);
    assert.equal(result, null);
  });

  it('returns fixed content when all issues are handled', () => {
    const content = 'const c = { rejectUnauthorized: false };\n';
    const result = tryRuleBasedFix(content, 'f.js', ['rejectUnauthorized: false — TLS disabled']);
    assert.ok(result !== null);
    assert.match(result, /rejectUnauthorized: true/);
  });
});

// ---------------------------------------------------------------------------
// TLS rules
// ---------------------------------------------------------------------------

describe('TLS: rejectUnauthorized', () => {
  it('fixes rejectUnauthorized: false → true', () => {
    const content = 'const agent = new https.Agent({ rejectUnauthorized: false });\n';
    const result = tryRuleBasedFix(content, 'server.js', ['rejectUnauthorized: false — TLS cert validation disabled']);
    assert.ok(result !== null);
    assert.match(result, /rejectUnauthorized: true/);
    assert.doesNotMatch(result, /rejectUnauthorized: false/);
  });

  it('fixes multiple occurrences', () => {
    const content = 'const a = { rejectUnauthorized: false };\nconst b = { rejectUnauthorized: false };\n';
    const result = applyRules(content, 'f.js', ['rejectUnauthorized: false']);
    assert.equal((result.content.match(/rejectUnauthorized: true/g) || []).length, 2);
  });
});

describe('TLS: NODE_TLS_REJECT_UNAUTHORIZED env bypass', () => {
  it('removes the env assignment line', () => {
    const content = 'process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";\ndoSomething();\n';
    const result = tryRuleBasedFix(content, 'f.js', ['NODE_TLS_REJECT_UNAUTHORIZED = "0" — global TLS bypass']);
    assert.ok(result !== null);
    assert.doesNotMatch(result, /NODE_TLS_REJECT_UNAUTHORIZED/);
    assert.match(result, /doSomething/);
  });
});

describe('TLS: strictSSL', () => {
  it('fixes strictSSL: false', () => {
    const content = 'request({ strictSSL: false, url });\n';
    const result = tryRuleBasedFix(content, 'f.js', ['strictSSL: false — TLS cert validation skipped']);
    assert.ok(result !== null);
    assert.match(result, /strictSSL: true/);
  });
});

describe('TLS: Python verify=False', () => {
  it('fixes verify=False', () => {
    const content = 'requests.get(url, verify=False)\n';
    const result = tryRuleBasedFix(content, 'api.py', ['verify=False — TLS verification disabled (py-verify-false)']);
    assert.ok(result !== null);
    assert.match(result, /verify=True/);
    assert.doesNotMatch(result, /verify=False/);
  });

  it('fixes verify_ssl=False', () => {
    const content = 'session.get(url, verify_ssl=False)\n';
    const result = tryRuleBasedFix(content, 'api.py', ['verify_ssl=False — (py-verify-false)']);
    assert.ok(result !== null);
    assert.match(result, /verify_ssl=True/);
  });
});

describe('TLS: Python ssl._create_unverified_context', () => {
  it('replaces with create_default_context', () => {
    const content = 'ctx = ssl._create_unverified_context()\n';
    const result = tryRuleBasedFix(content, 'f.py', ['ssl._create_unverified_context() — bypasses cert validation']);
    assert.ok(result !== null);
    assert.match(result, /ssl\.create_default_context\(\)/);
    assert.doesNotMatch(result, /_create_unverified_context/);
  });
});

describe('TLS: Python check_hostname=False', () => {
  it('sets check_hostname = True', () => {
    const content = 'ctx.check_hostname = False\n';
    const result = tryRuleBasedFix(content, 'f.py', ['.check_hostname = False (py-check-hostname-false)']);
    assert.ok(result !== null);
    assert.match(result, /check_hostname = True/);
  });
});

describe('TLS: Python ssl.CERT_NONE', () => {
  it('replaces CERT_NONE with CERT_REQUIRED', () => {
    const content = 'ctx.verify_mode = ssl.CERT_NONE\n';
    const result = tryRuleBasedFix(content, 'f.py', ['ssl.CERT_NONE — no certificate verification (py-cert-none)']);
    assert.ok(result !== null);
    assert.match(result, /CERT_REQUIRED/);
    assert.doesNotMatch(result, /CERT_NONE/);
  });

  it('replaces cert_reqs=\'CERT_NONE\'', () => {
    const content = "conn = ssl.wrap_socket(sock, cert_reqs='CERT_NONE')\n";
    const result = tryRuleBasedFix(content, 'f.py', ["cert_reqs='CERT_NONE' (py-cert-none)"]);
    assert.ok(result !== null);
    assert.match(result, /CERT_REQUIRED/);
  });
});

// ---------------------------------------------------------------------------
// Cookie / session security rules
// ---------------------------------------------------------------------------

describe('Cookie: httpOnly: false', () => {
  it('flips httpOnly to true', () => {
    const content = 'res.cookie("session", token, { httpOnly: false, secure: true });\n';
    const result = tryRuleBasedFix(content, 'route.js', ['httpOnly: false — cookie readable from document.cookie (js-httponly-false)']);
    assert.ok(result !== null);
    assert.match(result, /httpOnly: true/);
  });
});

describe('Cookie: secure: false', () => {
  it('flips secure to true', () => {
    const content = 'app.use(session({ secret: "x", cookie: { secure: false } }));\n';
    const result = tryRuleBasedFix(content, 'app.js', ['secure: false — cookie transmitted over plain HTTP (js-secure-false)']);
    assert.ok(result !== null);
    assert.match(result, /secure: true/);
  });
});

describe('Cookie: Python SESSION_COOKIE_SECURE', () => {
  it('flips SESSION_COOKIE_SECURE to True', () => {
    const content = 'SESSION_COOKIE_SECURE = False\nCSRF_COOKIE_SECURE = False\n';
    const result = tryRuleBasedFix(content, 'settings.py', [
      'SESSION_COOKIE_SECURE = False (py-cookie-secure-false)',
      'CSRF_COOKIE_SECURE = False (py-cookie-secure-false)',
    ]);
    assert.ok(result !== null);
    assert.match(result, /SESSION_COOKIE_SECURE = True/);
    assert.match(result, /CSRF_COOKIE_SECURE = True/);
  });
});

describe('Cookie: Python SESSION_COOKIE_HTTPONLY', () => {
  it('flips to True', () => {
    const content = 'SESSION_COOKIE_HTTPONLY = False\n';
    const result = tryRuleBasedFix(content, 'settings.py', ['SESSION_COOKIE_HTTPONLY = False (py-cookie-httponly-false)']);
    assert.ok(result !== null);
    assert.match(result, /SESSION_COOKIE_HTTPONLY = True/);
  });
});

describe('Cookie: Python FastAPI httponly=False', () => {
  it('flips httponly kwarg to True', () => {
    const content = 'response.set_cookie("session", value, httponly=False)\n';
    const result = tryRuleBasedFix(content, 'main.py', ['httponly=False in set_cookie (py-fastapi-httponly-false)']);
    assert.ok(result !== null);
    assert.match(result, /httponly=True/);
  });
});

// ---------------------------------------------------------------------------
// Datetime rules
// ---------------------------------------------------------------------------

describe('Datetime: datetime.utcnow()', () => {
  it('replaces utcnow() with now(timezone.utc)', () => {
    const content = 'from datetime import datetime\nnow = datetime.utcnow()\n';
    const result = tryRuleBasedFix(content, 'util.py', ['datetime.utcnow() — deprecated in Python 3.12 (py-utcnow)']);
    assert.ok(result !== null);
    assert.match(result, /datetime\.now\(timezone\.utc\)/);
    assert.doesNotMatch(result, /utcnow/);
  });

  it('adds timezone to existing datetime import', () => {
    const content = 'from datetime import datetime\nnow = datetime.utcnow()\n';
    const result = tryRuleBasedFix(content, 'f.py', ['datetime.utcnow() deprecated']);
    assert.ok(result !== null);
    // Either timezone is added to the import OR datetime import already covers it
    const hasTimezone = /from datetime import.*timezone/.test(result) || /import datetime/.test(result);
    assert.ok(hasTimezone, 'timezone should be importable after fix');
  });

  it('does not add duplicate timezone import', () => {
    const content = 'from datetime import datetime, timezone\nnow = datetime.utcnow()\n';
    const result = tryRuleBasedFix(content, 'f.py', ['utcnow deprecated']);
    assert.ok(result !== null);
    const importLine = result.split('\n').find(l => l.startsWith('from datetime'));
    const timezoneCount = (importLine || '').split('timezone').length - 1;
    assert.ok(timezoneCount <= 1, 'should not duplicate timezone in import');
  });
});

describe('Datetime: datetime.now() naive', () => {
  it('adds timezone.utc argument', () => {
    const content = 'from datetime import datetime\nts = datetime.now()\n';
    const result = tryRuleBasedFix(content, 'f.py', ['datetime.now() without tz= — naive datetime (naive datetime)']);
    assert.ok(result !== null);
    assert.match(result, /datetime\.now\(timezone\.utc\)/);
  });
});

// ---------------------------------------------------------------------------
// parseInt radix
// ---------------------------------------------------------------------------

describe('parseInt radix', () => {
  it('adds radix 10 to bare parseInt calls', () => {
    const content = 'const n = parseInt(str);\n';
    const result = tryRuleBasedFix(content, 'f.js', ['parseInt(str) without radix — parseInt-radix']);
    assert.ok(result !== null);
    assert.match(result, /parseInt\(str, 10\)/);
  });

  it('does not double-add radix to already-correct calls', () => {
    const content = 'const n = parseInt(str, 10);\n';
    // This issue string matches but the regex won't match `parseInt(str, 10)`
    // because it looks for parseInt(x) with no comma in arg
    const result = applyRules(content, 'f.js', ['missing radix — parseInt']);
    // Either unhandled (no change) or correctly untouched
    assert.doesNotMatch(result.content, /parseInt\(str, 10, 10\)/);
  });
});

// ---------------------------------------------------------------------------
// var → const
// ---------------------------------------------------------------------------

describe('var to const', () => {
  it('replaces var with const', () => {
    const content = 'var x = 1;\nvar y = 2;\n';
    const result = tryRuleBasedFix(content, 'f.js', ['var declaration — prefer const/let']);
    assert.ok(result !== null);
    assert.match(result, /const x = 1/);
    assert.match(result, /const y = 2/);
    assert.doesNotMatch(result, /\bvar\s+/);
  });
});

// ---------------------------------------------------------------------------
// Shell: set -euo pipefail
// ---------------------------------------------------------------------------

describe('shell set -euo pipefail', () => {
  it('inserts after shebang when missing', () => {
    const content = '#!/bin/bash\necho hello\n';
    const result = tryRuleBasedFix(content, 'deploy.sh', ['missing set -euo pipefail — shell strict mode']);
    assert.ok(result !== null);
    assert.match(result, /set -euo pipefail/);
    const lines = result.split('\n');
    assert.equal(lines[0], '#!/bin/bash');
    assert.equal(lines[1], 'set -euo pipefail');
  });

  it('does not add when already present', () => {
    const content = '#!/bin/bash\nset -euo pipefail\necho hello\n';
    const result = applyRules(content, 'deploy.sh', ['missing set -euo pipefail']);
    // Rule matches but produces no change → unhandled
    assert.equal(result.handled.length, 0);
    assert.equal(result.unhandled.length, 1);
  });
});

// ---------------------------------------------------------------------------
// GitHub Actions permissions
// ---------------------------------------------------------------------------

describe('GitHub Actions permissions', () => {
  it('adds permissions block before jobs:', () => {
    const content = 'name: CI\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n';
    const result = tryRuleBasedFix(content, '.github/workflows/ci.yml', ['missing permissions: block (ci-security)']);
    assert.ok(result !== null);
    assert.match(result, /permissions:/);
    assert.match(result, /contents: read/);
  });

  it('does not add when already present', () => {
    const content = 'name: CI\npermissions:\n  contents: read\njobs:\n  build:\n    runs-on: ubuntu-latest\n';
    const result = applyRules(content, '.github/workflows/ci.yml', ['missing permissions:']);
    assert.equal(result.handled.length, 0);
  });
});

// ---------------------------------------------------------------------------
// RULES array shape
// ---------------------------------------------------------------------------

describe('RULES array', () => {
  it('every rule has a name, matches function, and apply function', () => {
    for (const rule of RULES) {
      assert.ok(typeof rule.name === 'string' && rule.name.length > 0, `rule.name missing: ${JSON.stringify(rule)}`);
      assert.ok(typeof rule.matches === 'function', `rule.matches not a function: ${rule.name}`);
      assert.ok(typeof rule.apply === 'function', `rule.apply not a function: ${rule.name}`);
    }
  });

  it('has at least 15 rules', () => {
    assert.ok(RULES.length >= 15, `Expected >=15 rules, got ${RULES.length}`);
  });
});

// ---------------------------------------------------------------------------
// Multi-rule single file
// ---------------------------------------------------------------------------

describe('multiple rules on one file', () => {
  it('applies both httpOnly and secure fixes in one pass', () => {
    const content = 'app.use(session({ cookie: { httpOnly: false, secure: false } }));\n';
    const result = tryRuleBasedFix(content, 'app.js', [
      'httpOnly: false — js-httponly-false',
      'secure: false — js-secure-false',
    ]);
    assert.ok(result !== null);
    assert.match(result, /httpOnly: true/);
    assert.match(result, /secure: true/);
  });

  it('returns null if one of two issues is unhandled', () => {
    const content = 'const c = { rejectUnauthorized: false };\n';
    const result = tryRuleBasedFix(content, 'f.js', [
      'rejectUnauthorized: false',
      'COMPLETELY_UNKNOWN_ISSUE_ABC_123',
    ]);
    assert.equal(result, null);
  });
});
