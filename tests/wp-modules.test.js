// =============================================================================
// WP MODULE TESTS — src/modules/wp-{exposed-files,version-leak,xmlrpc-exposed}.js
// =============================================================================
// Three high-pain WordPress probe modules. All use HTTP probes against a
// customer-supplied URL. Tests inject a stub `probeFn` / `fetchFn` so
// nothing makes a real network call.
// =============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const WpExposedFiles = require('../src/modules/wp-exposed-files');
const WpVersionLeak  = require('../src/modules/wp-version-leak');
const WpXmlrpc       = require('../src/modules/wp-xmlrpc-exposed');
const { TestResult: Result } = require('../src/core/runner');

function ruleNames(result) {
  return (result.checks || result._checks || []).map((c) => c.name);
}
function firedSeverities(result) {
  return (result.checks || result._checks || [])
    .filter((c) => c.passed === false)
    .map((c) => c.severity);
}

// ---------------------------------------------------------------------------
// wpExposedFiles — shape + URL probe
// ---------------------------------------------------------------------------

describe('WpExposedFiles — shape', () => {
  it('has expected name + description', () => {
    const m = new WpExposedFiles();
    assert.equal(m.name, 'wpExposedFiles');
    assert.match(m.description, /WordPress/);
  });

  it('exposes KNOWN_BAD_PATHS with the expected shape', () => {
    assert.ok(Array.isArray(WpExposedFiles.KNOWN_BAD_PATHS));
    assert.ok(WpExposedFiles.KNOWN_BAD_PATHS.length >= 15);
    for (const entry of WpExposedFiles.KNOWN_BAD_PATHS) {
      assert.ok(entry.path, 'has path');
      assert.ok(['error', 'warning', 'info'].includes(entry.severity));
      assert.ok(entry.reason, 'has human-readable reason');
    }
  });

  it('every path entry mentions a real WP-relevant file', () => {
    const allPaths = WpExposedFiles.KNOWN_BAD_PATHS.map((e) => e.path).join(' ');
    for (const must of ['wp-config', 'debug.log', '.git', '.env', 'readme']) {
      assert.match(allPaths, new RegExp(must));
    }
  });
});

describe('WpExposedFiles — HTTP probe', () => {
  function makeProbe(statusByPath) {
    return async function probe(url, _opts) {
      const u = new URL(url);
      const p = u.pathname.replace(/^\//, '');
      return { status: statusByPath[p] !== undefined ? statusByPath[p] : 404 };
    };
  }

  it('flags wp-config.php.bak when probe returns 200', async () => {
    const mod = new WpExposedFiles();
    const r = new Result();
    await mod.run(r, {
      wpExposedFiles: {
        url: 'https://example.test',
        probeFn: makeProbe({ 'wp-config.php.bak': 200 }),
      },
    });
    const names = ruleNames(r);
    assert.ok(names.includes('wp-exposed-files:found:wp-config.php.bak'),
      `expected wp-config.php.bak finding, got: ${names.join(', ')}`);
    assert.ok(firedSeverities(r).includes('error'));
  });

  it('flags .git/HEAD when exposed (full-source recovery)', async () => {
    const mod = new WpExposedFiles();
    const r = new Result();
    await mod.run(r, {
      wpExposedFiles: {
        url: 'https://example.test',
        probeFn: makeProbe({ '.git/HEAD': 200 }),
      },
    });
    assert.ok(ruleNames(r).includes('wp-exposed-files:found:.git/HEAD'));
  });

  it('flags .DS_Store as warning (not error)', async () => {
    const mod = new WpExposedFiles();
    const r = new Result();
    await mod.run(r, {
      wpExposedFiles: {
        url: 'https://example.test',
        probeFn: makeProbe({ '.DS_Store': 200 }),
      },
    });
    const check = (r.checks || r._checks || []).find((c) => c.name === 'wp-exposed-files:found:.DS_Store');
    assert.ok(check);
    assert.equal(check.severity, 'warning');
  });

  it('does NOT flag paths that return 404', async () => {
    const mod = new WpExposedFiles();
    const r = new Result();
    await mod.run(r, {
      wpExposedFiles: {
        url: 'https://example.test',
        probeFn: makeProbe({}),
      },
    });
    const findings = ruleNames(r).filter((n) => n.startsWith('wp-exposed-files:found:'));
    assert.equal(findings.length, 0);
  });

  it('rejects malformed URL with an error finding', async () => {
    const mod = new WpExposedFiles();
    const r = new Result();
    await mod.run(r, { wpExposedFiles: { url: 'not a url at all !!!' } });
    assert.ok(ruleNames(r).includes('wp-exposed-files:bad-url'));
  });

  it('emits the summary finding regardless of result', async () => {
    const mod = new WpExposedFiles();
    const r = new Result();
    await mod.run(r, {
      wpExposedFiles: { url: 'https://example.test', probeFn: makeProbe({}) },
    });
    assert.ok(ruleNames(r).includes('wp-exposed-files:summary'));
  });

  it('handles probe errors per-path without aborting the whole run', async () => {
    let calls = 0;
    const flakeyProbe = async (url) => {
      calls += 1;
      if (calls === 3) throw new Error('connection reset');
      return { status: 404 };
    };
    const mod = new WpExposedFiles();
    const r = new Result();
    await mod.run(r, {
      wpExposedFiles: {
        url: 'https://example.test',
        probeFn: flakeyProbe,
        concurrency: 1, // ensure deterministic ordering
      },
    });
    assert.ok(ruleNames(r).includes('wp-exposed-files:summary'));
  });
});

// ---------------------------------------------------------------------------
// wpVersionLeak
// ---------------------------------------------------------------------------

describe('WpVersionLeak', () => {
  it('has expected name + description', () => {
    const m = new WpVersionLeak();
    assert.equal(m.name, 'wpVersionLeak');
    assert.match(m.description, /WordPress/);
  });

  it('returns no-op skip when no URL provided', async () => {
    const mod = new WpVersionLeak();
    const r = new Result();
    await mod.run(r, {});
    assert.ok(ruleNames(r).includes('wp-version-leak:no-url'));
  });

  it('detects WordPress version from <meta generator> on homepage', async () => {
    const fetchFn = async (url) => {
      if (url.endsWith('/')) {
        return {
          status: 200,
          body: '<html><head><meta name="generator" content="WordPress 6.5.4"><title>Site</title></head></html>',
        };
      }
      return { status: 404, body: '' };
    };
    const mod = new WpVersionLeak();
    const r = new Result();
    await mod.run(r, { wpVersionLeak: { url: 'https://example.test', fetchFn } });
    const meta = (r.checks || r._checks || []).find((c) => c.name === 'wp-version-leak:meta-generator');
    assert.ok(meta);
    assert.match(meta.message, /6\.5\.4/);
  });

  it('detects version from readme.html', async () => {
    const fetchFn = async (url) => {
      if (url.endsWith('/readme.html')) {
        return { status: 200, body: '<h1>WordPress</h1><p>Version 6.4.2</p>' };
      }
      return { status: 404, body: '' };
    };
    const mod = new WpVersionLeak();
    const r = new Result();
    await mod.run(r, { wpVersionLeak: { url: 'https://example.test', fetchFn } });
    const hit = (r.checks || r._checks || []).find((c) => c.name === 'wp-version-leak:found:readme.html');
    assert.ok(hit);
    assert.match(hit.message, /6\.4\.2/);
  });

  it('detects version from RSS feed <generator>', async () => {
    const fetchFn = async (url) => {
      if (url.endsWith('/feed/')) {
        return { status: 200, body: '<rss><channel><generator>https://wordpress.org/?v=6.3.1</generator></channel></rss>' };
      }
      return { status: 404, body: '' };
    };
    const mod = new WpVersionLeak();
    const r = new Result();
    await mod.run(r, { wpVersionLeak: { url: 'https://example.test', fetchFn } });
    const hit = (r.checks || r._checks || []).find((c) => c.name === 'wp-version-leak:found:feed/');
    assert.ok(hit);
    assert.match(hit.message, /6\.3\.1/);
  });

  it('flags license.txt accessibility even without version regex (weak signal)', async () => {
    const fetchFn = async (url) => {
      if (url.endsWith('/license.txt')) return { status: 200, body: 'GPL v2 license text...' };
      return { status: 404, body: '' };
    };
    const mod = new WpVersionLeak();
    const r = new Result();
    await mod.run(r, { wpVersionLeak: { url: 'https://example.test', fetchFn } });
    assert.ok(ruleNames(r).includes('wp-version-leak:accessible:license.txt'));
  });

  it('emits clean-summary when no leaks detected', async () => {
    const fetchFn = async () => ({ status: 404, body: '' });
    const mod = new WpVersionLeak();
    const r = new Result();
    await mod.run(r, { wpVersionLeak: { url: 'https://example.test', fetchFn } });
    const summary = (r.checks || r._checks || []).find((c) => c.name === 'wp-version-leak:summary');
    assert.ok(summary);
    assert.match(summary.message, /no version leaks detected/);
  });

  it('rejects malformed URL', async () => {
    const mod = new WpVersionLeak();
    const r = new Result();
    await mod.run(r, { wpVersionLeak: { url: ':::::' } });
    assert.ok(ruleNames(r).includes('wp-version-leak:bad-url'));
  });
});

// ---------------------------------------------------------------------------
// wpXmlrpcExposed
// ---------------------------------------------------------------------------

describe('WpXmlrpcExposed', () => {
  it('has expected name + description', () => {
    const m = new WpXmlrpc();
    assert.equal(m.name, 'wpXmlrpcExposed');
    assert.match(m.description, /xmlrpc/i);
  });

  it('returns no-op skip when no URL provided', async () => {
    const mod = new WpXmlrpc();
    const r = new Result();
    await mod.run(r, {});
    assert.ok(ruleNames(r).includes('wp-xmlrpc:no-url'));
  });

  it('flags as ERROR when pingback.ping is available (DDoS reflector)', async () => {
    const fetchFn = async (url, opts) => {
      if (opts.method === 'POST') {
        return {
          status: 200,
          body: '<methodResponse><params><param><value><array><data>' +
            '<value><string>pingback.ping</string></value>' +
            '<value><string>system.listMethods</string></value>' +
            '</data></array></value></param></params></methodResponse>',
        };
      }
      return { status: 200, body: 'XML-RPC server accepts POST requests only.' };
    };
    const mod = new WpXmlrpc();
    const r = new Result();
    await mod.run(r, { wpXmlrpcExposed: { url: 'https://example.test', fetchFn } });
    const hit = (r.checks || r._checks || []).find((c) => c.name === 'wp-xmlrpc:pingback-available');
    assert.ok(hit);
    assert.equal(hit.severity, 'error');
  });

  it('flags as WARNING when xmlrpc is exposed but pingback is disabled', async () => {
    const fetchFn = async (url, opts) => {
      if (opts.method === 'POST') {
        return {
          status: 200,
          body: '<methodResponse><params><param><value><array><data>' +
            '<value><string>system.listMethods</string></value>' +
            '<value><string>system.getCapabilities</string></value>' +
            '</data></array></value></param></params></methodResponse>',
        };
      }
      return { status: 200, body: 'XML-RPC server accepts POST requests only.' };
    };
    const mod = new WpXmlrpc();
    const r = new Result();
    await mod.run(r, { wpXmlrpcExposed: { url: 'https://example.test', fetchFn } });
    const hit = (r.checks || r._checks || []).find((c) => c.name === 'wp-xmlrpc:exposed');
    assert.ok(hit);
    assert.equal(hit.severity, 'warning');
  });

  it('emits not-exposed when both probes return 403/404', async () => {
    const fetchFn = async () => ({ status: 403, body: 'Forbidden' });
    const mod = new WpXmlrpc();
    const r = new Result();
    await mod.run(r, { wpXmlrpcExposed: { url: 'https://example.test', fetchFn } });
    assert.ok(ruleNames(r).includes('wp-xmlrpc:not-exposed'));
  });

  it('handles GET fingerprint alone (POST might be blocked even if endpoint is live)', async () => {
    const fetchFn = async (url, opts) => {
      if (opts.method === 'POST') throw new Error('POST blocked by host');
      return { status: 200, body: 'XML-RPC server accepts POST requests only.' };
    };
    const mod = new WpXmlrpc();
    const r = new Result();
    await mod.run(r, { wpXmlrpcExposed: { url: 'https://example.test', fetchFn } });
    // GET fingerprint alone is enough to mark exposed
    assert.ok(
      ruleNames(r).includes('wp-xmlrpc:exposed') ||
      ruleNames(r).includes('wp-xmlrpc:pingback-available'),
      'should have flagged based on GET signal alone'
    );
  });

  it('rejects malformed URL', async () => {
    const mod = new WpXmlrpc();
    const r = new Result();
    await mod.run(r, { wpXmlrpcExposed: { url: 'not.a.url..:::' } });
    assert.ok(
      ruleNames(r).includes('wp-xmlrpc:bad-url') ||
      ruleNames(r).includes('wp-xmlrpc:not-exposed'),
      'malformed URLs should not crash'
    );
  });
});
