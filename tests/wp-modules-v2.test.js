// =============================================================================
// WP V2 MODULE TESTS — wpPluginCveCheck / wpMalwarePatterns / wpUserEnumerate
// =============================================================================
// All three are HTTP-probe-driven and accept a fetchFn for test injection.
// =============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const WpPluginCveCheck = require('../src/modules/wp-plugin-cve-check');
const WpMalwarePatterns = require('../src/modules/wp-malware-patterns');
const WpUserEnumerate = require('../src/modules/wp-user-enumerate');
const { TestResult: Result } = require('../src/core/runner');

function ruleNames(r) { return (r.checks || []).map((c) => c.name); }
function findByName(r, name) { return (r.checks || []).find((c) => c.name === name); }

// ---------------------------------------------------------------------------
// wpPluginCveCheck
// ---------------------------------------------------------------------------

describe('WpPluginCveCheck — shape', () => {
  it('has expected name + description', () => {
    const m = new WpPluginCveCheck();
    assert.equal(m.name, 'wpPluginCveCheck');
    assert.match(m.description, /CVE/);
  });

  it('exposes CURATED_PLUGIN_CVES with the expected shape', () => {
    assert.ok(Array.isArray(WpPluginCveCheck.CURATED_PLUGIN_CVES));
    assert.ok(WpPluginCveCheck.CURATED_PLUGIN_CVES.length >= 10);
    for (const entry of WpPluginCveCheck.CURATED_PLUGIN_CVES) {
      assert.ok(typeof entry.slug === 'string' && entry.slug.length > 0);
      assert.ok(typeof entry.versionMaxBad === 'string');
      assert.ok(['error', 'warning'].includes(entry.severity));
      assert.ok(entry.cve && entry.summary);
    }
  });
});

describe('WpPluginCveCheck.compareVersions', () => {
  const cmp = WpPluginCveCheck.compareVersions;
  it('orders dotted versions correctly', () => {
    assert.equal(cmp('1.0.0', '1.0.0'), 0);
    assert.equal(cmp('1.0.0', '1.0.1'), -1);
    assert.equal(cmp('1.2.0', '1.1.9'), 1);
    assert.equal(cmp('2.0', '1.99.99'), 1);
  });
  it('handles different segment counts', () => {
    assert.equal(cmp('1.2', '1.2.0'), 0);
    assert.equal(cmp('1.2.3', '1.2'), 1);
  });
  it('returns 0 when either input is empty', () => {
    assert.equal(cmp('', '1.0'), 0);
    assert.equal(cmp(null, '1.0'), 0);
  });
});

describe('WpPluginCveCheck.isVulnerable', () => {
  const v = WpPluginCveCheck.isVulnerable;
  it('flags as vulnerable when detected version <= versionMaxBad', () => {
    assert.equal(v('1.2.3', { versionMaxBad: '1.2.3', cve: 'X', severity: 'error' }), true);
    assert.equal(v('1.2.2', { versionMaxBad: '1.2.3', cve: 'X', severity: 'error' }), true);
  });
  it('does NOT flag when detected version > versionMaxBad', () => {
    assert.equal(v('1.2.4', { versionMaxBad: '1.2.3', cve: 'X', severity: 'error' }), false);
  });
  it('treats no-version + non-ABANDONED CVE as not-vulnerable (avoid noise)', () => {
    assert.equal(v(null, { versionMaxBad: '1.0', cve: 'CVE-2024-X', severity: 'error' }), false);
  });
  it('flags no-version case for ABANDONED entries (apply to all)', () => {
    assert.equal(v(null, { versionMaxBad: '9999', cve: 'ABANDONED', severity: 'warning' }), true);
  });
});

describe('WpPluginCveCheck — end-to-end', () => {
  it('returns no-url skip when no URL provided', async () => {
    const mod = new WpPluginCveCheck();
    const r = new Result();
    await mod.run(r, {});
    assert.ok(ruleNames(r).includes('wp-plugin-cve:no-url'));
  });

  it('detects vulnerable plugin from homepage HTML', async () => {
    const html = `<html><head>
      <link rel="stylesheet" href="https://x.com/wp-content/plugins/elementor/assets/css/elementor.min.css?ver=3.0.0">
    </head></html>`;
    const fetchFn = async () => ({ status: 200, body: html });
    const mod = new WpPluginCveCheck();
    const r = new Result();
    await mod.run(r, { wpPluginCveCheck: { url: 'https://x.com', fetchFn } });
    const hit = findByName(r, 'wp-plugin-cve:vuln:elementor');
    assert.ok(hit, `expected elementor finding, got: ${ruleNames(r).join(', ')}`);
    assert.equal(hit.severity, 'error');
    assert.match(hit.message, /CVE-2024-2326/);
    assert.match(hit.message, /3\.18\.2/);
  });

  it('does NOT flag when detected version is newer than the CVE patch', async () => {
    const html = `<link href="/wp-content/plugins/elementor/assets/css/elementor.min.css?ver=3.18.5">`;
    const fetchFn = async () => ({ status: 200, body: html });
    const mod = new WpPluginCveCheck();
    const r = new Result();
    await mod.run(r, { wpPluginCveCheck: { url: 'https://x.com', fetchFn } });
    assert.equal(findByName(r, 'wp-plugin-cve:vuln:elementor'), undefined);
  });

  it('detects ABANDONED plugins even without a version', async () => {
    const html = `<link href="/wp-content/plugins/tinymce-advanced/css/style.css">`;
    const fetchFn = async () => ({ status: 200, body: html });
    const mod = new WpPluginCveCheck();
    const r = new Result();
    await mod.run(r, { wpPluginCveCheck: { url: 'https://x.com', fetchFn } });
    const hit = findByName(r, 'wp-plugin-cve:vuln:tinymce-advanced');
    assert.ok(hit);
    assert.match(hit.message, /ABANDONED/);
  });

  it('emits no-plugins-detected when HTML has no plugin URLs', async () => {
    const fetchFn = async () => ({ status: 200, body: '<html><body>plain</body></html>' });
    const mod = new WpPluginCveCheck();
    const r = new Result();
    await mod.run(r, { wpPluginCveCheck: { url: 'https://x.com', fetchFn } });
    assert.ok(ruleNames(r).includes('wp-plugin-cve:no-plugins-detected'));
  });

  it('handles fetch failure gracefully', async () => {
    const fetchFn = async () => ({ status: 503, body: '' });
    const mod = new WpPluginCveCheck();
    const r = new Result();
    await mod.run(r, { wpPluginCveCheck: { url: 'https://x.com', fetchFn } });
    assert.ok(ruleNames(r).includes('wp-plugin-cve:fetch-failed'));
  });
});

// ---------------------------------------------------------------------------
// wpMalwarePatterns
// ---------------------------------------------------------------------------

describe('WpMalwarePatterns — shape', () => {
  it('has expected name + description', () => {
    const m = new WpMalwarePatterns();
    assert.equal(m.name, 'wpMalwarePatterns');
    assert.match(m.description, /malware/i);
  });

  it('exposes MALWARE_PATTERNS array with regex + severity + summary', () => {
    assert.ok(Array.isArray(WpMalwarePatterns.MALWARE_PATTERNS));
    assert.ok(WpMalwarePatterns.MALWARE_PATTERNS.length >= 5);
    for (const p of WpMalwarePatterns.MALWARE_PATTERNS) {
      assert.ok(p.regex instanceof RegExp);
      assert.ok(['error', 'warning'].includes(p.severity));
      assert.ok(p.summary && p.name);
    }
  });
});

describe('WpMalwarePatterns — end-to-end', () => {
  it('flags eval(atob(...)) pattern as error', async () => {
    const html = `<script>eval(atob('YWxlcnQoMSk='));</script>`;
    const fetchFn = async () => ({ status: 200, body: html });
    const mod = new WpMalwarePatterns();
    const r = new Result();
    await mod.run(r, { wpMalwarePatterns: { url: 'https://x.com', fetchFn } });
    const hit = findByName(r, 'wp-malware:eval-atob');
    assert.ok(hit);
    assert.equal(hit.severity, 'error');
  });

  it('flags hidden iframe', async () => {
    const html = `<iframe src="https://evil.example" style="display:none"></iframe>`;
    const fetchFn = async () => ({ status: 200, body: html });
    const mod = new WpMalwarePatterns();
    const r = new Result();
    await mod.run(r, { wpMalwarePatterns: { url: 'https://x.com', fetchFn } });
    assert.ok(findByName(r, 'wp-malware:hidden-iframe'));
  });

  it('flags long base64 payload in inline script', async () => {
    const longBase64 = 'A'.repeat(260);
    const html = `<script>var x = "${longBase64}";</script>`;
    const fetchFn = async () => ({ status: 200, body: html });
    const mod = new WpMalwarePatterns();
    const r = new Result();
    await mod.run(r, { wpMalwarePatterns: { url: 'https://x.com', fetchFn } });
    assert.ok(findByName(r, 'wp-malware:long-base64'));
  });

  it('flags PHP eval leak (server-side compromise signal)', async () => {
    const html = `<html>eval(base64_decode("ZGFuZ2Vy"));</html>`;
    const fetchFn = async () => ({ status: 200, body: html });
    const mod = new WpMalwarePatterns();
    const r = new Result();
    await mod.run(r, { wpMalwarePatterns: { url: 'https://x.com', fetchFn } });
    const hit = findByName(r, 'wp-malware:php-eval-leak');
    assert.ok(hit);
    assert.equal(hit.severity, 'error');
  });

  it('flags references to known-malicious domains', async () => {
    const html = `<script src="https://wptaim.com/track.js"></script>`;
    const fetchFn = async () => ({ status: 200, body: html });
    const mod = new WpMalwarePatterns();
    const r = new Result();
    await mod.run(r, { wpMalwarePatterns: { url: 'https://x.com', fetchFn } });
    const names = ruleNames(r);
    assert.ok(names.some((n) => n.startsWith('wp-malware:known-bad-domain:')));
  });

  it('emits clean-summary on clean homepage', async () => {
    const html = `<html><body><h1>Clean WordPress site</h1></body></html>`;
    const fetchFn = async () => ({ status: 200, body: html });
    const mod = new WpMalwarePatterns();
    const r = new Result();
    await mod.run(r, { wpMalwarePatterns: { url: 'https://x.com', fetchFn } });
    const sum = findByName(r, 'wp-malware:summary');
    assert.ok(sum);
    assert.match(sum.message, /no malware signatures detected/);
  });

  it('does NOT flag legitimate WordPress CDN scripts', async () => {
    const html = `<script src="https://s.w.org/_static/js/foo.js"></script>
                  <link href="https://secure.gravatar.com/style.css">`;
    const fetchFn = async () => ({ status: 200, body: html });
    const mod = new WpMalwarePatterns();
    const r = new Result();
    await mod.run(r, { wpMalwarePatterns: { url: 'https://x.com', fetchFn } });
    const names = ruleNames(r).filter((n) => n.startsWith('wp-malware:') && n !== 'wp-malware:summary');
    assert.equal(names.length, 0, `expected no findings on legit WP CDN, got: ${names.join(', ')}`);
  });
});

// ---------------------------------------------------------------------------
// wpUserEnumerate
// ---------------------------------------------------------------------------

describe('WpUserEnumerate', () => {
  it('returns no-url skip when no URL provided', async () => {
    const mod = new WpUserEnumerate();
    const r = new Result();
    await mod.run(r, {});
    assert.ok(ruleNames(r).includes('wp-user-enum:no-url'));
  });

  it('flags /?author=1 redirect leak', async () => {
    const fetchFn = async (url) => {
      if (url.endsWith('/?author=1')) {
        return { status: 301, location: '/author/admin/', body: '' };
      }
      return { status: 404, body: '' };
    };
    const mod = new WpUserEnumerate();
    const r = new Result();
    await mod.run(r, { wpUserEnumerate: { url: 'https://x.com', fetchFn } });
    const hit = findByName(r, 'wp-user-enum:author-redirect');
    assert.ok(hit);
    assert.equal(hit.severity, 'error');
    assert.match(hit.message, /admin/);
  });

  it('flags /wp-json/wp/v2/users REST API exposure', async () => {
    const fetchFn = async (url) => {
      if (url.endsWith('/wp-json/wp/v2/users')) {
        return {
          status: 200,
          body: JSON.stringify([
            { id: 1, slug: 'admin', name: 'Administrator' },
            { id: 2, slug: 'editor1', name: 'Editor One' },
          ]),
        };
      }
      return { status: 404, body: '' };
    };
    const mod = new WpUserEnumerate();
    const r = new Result();
    await mod.run(r, { wpUserEnumerate: { url: 'https://x.com', fetchFn } });
    const hit = findByName(r, 'wp-user-enum:rest-api');
    assert.ok(hit);
    assert.equal(hit.severity, 'error');
    assert.match(hit.message, /admin/);
    assert.match(hit.message, /editor1/);
  });

  it('flags common-username probe success', async () => {
    const fetchFn = async (url) => {
      if (url.includes('/author/admin/')) return { status: 200, body: '' };
      return { status: 404, body: '' };
    };
    const mod = new WpUserEnumerate();
    const r = new Result();
    await mod.run(r, { wpUserEnumerate: { url: 'https://x.com', fetchFn } });
    const hit = findByName(r, 'wp-user-enum:common-usernames');
    assert.ok(hit);
    assert.match(hit.message, /admin/);
  });

  it('emits clean-summary when no leaks', async () => {
    const fetchFn = async () => ({ status: 404, body: '' });
    const mod = new WpUserEnumerate();
    const r = new Result();
    await mod.run(r, { wpUserEnumerate: { url: 'https://x.com', fetchFn } });
    const sum = findByName(r, 'wp-user-enum:summary');
    assert.ok(sum);
    assert.match(sum.message, /no username leaks/);
  });
});
