// =============================================================================
// WP V3 MODULE TESTS — wpAdminProtection / wpPhpVersionEol /
//                      wpThemeAbandonment / wpBackupValidation
// =============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const WpAdminProtection = require('../src/modules/wp-admin-protection');
const WpPhpVersionEol   = require('../src/modules/wp-php-version-eol');
const WpThemeAbandonment = require('../src/modules/wp-theme-abandonment');
const WpBackupValidation = require('../src/modules/wp-backup-validation');
const { TestResult: Result } = require('../src/core/runner');

const ruleNames = (r) => (r.checks || []).map((c) => c.name);
const findByName = (r, name) => (r.checks || []).find((c) => c.name === name);

// ---------------------------------------------------------------------------
// wpAdminProtection
// ---------------------------------------------------------------------------

describe('WpAdminProtection', () => {
  it('returns no-url skip when no URL provided', async () => {
    const mod = new WpAdminProtection();
    const r = new Result();
    await mod.run(r, {});
    assert.ok(ruleNames(r).includes('wp-admin-protection:no-url'));
  });

  it('flags as ERROR when /wp-login.php is reachable with no WAF + no 2FA', async () => {
    const fetchFn = async (url) => {
      if (url.endsWith('/wp-login.php')) {
        return {
          status: 200,
          headers: {},
          body: '<html><body><form id="loginform"><input name="log"></form></body></html>',
        };
      }
      return { status: 302, headers: {}, body: '' };
    };
    const mod = new WpAdminProtection();
    const r = new Result();
    await mod.run(r, { wpAdminProtection: { url: 'https://x.com', fetchFn } });
    const hit = findByName(r, 'wp-admin-protection:login-unhardened');
    assert.ok(hit, `expected unhardened finding, got: ${ruleNames(r).join(', ')}`);
    assert.equal(hit.severity, 'error');
  });

  it('does NOT flag login-unhardened when Cloudflare WAF is detected', async () => {
    const fetchFn = async (url) => {
      if (url.endsWith('/wp-login.php')) {
        return {
          status: 200,
          headers: { 'cf-ray': 'abc123', 'cf-cache-status': 'MISS' },
          body: '<html><body><form id="loginform"></form></body></html>',
        };
      }
      return { status: 302, headers: {}, body: '' };
    };
    const mod = new WpAdminProtection();
    const r = new Result();
    await mod.run(r, { wpAdminProtection: { url: 'https://x.com', fetchFn } });
    assert.equal(findByName(r, 'wp-admin-protection:login-unhardened'), undefined);
  });

  it('flags warning when WAF present but 2FA missing', async () => {
    const fetchFn = async (url) => {
      if (url.endsWith('/wp-login.php')) {
        return {
          status: 200,
          headers: { 'cf-ray': 'abc123', 'set-cookie': 'wordpress_test_cookie=WP+Cookie; path=/; HttpOnly; Secure' },
          body: '<html><form id="loginform"></form></html>',
        };
      }
      return { status: 302, headers: {}, body: '' };
    };
    const mod = new WpAdminProtection();
    const r = new Result();
    await mod.run(r, { wpAdminProtection: { url: 'https://x.com', fetchFn } });
    assert.ok(findByName(r, 'wp-admin-protection:no-2fa-detected'));
  });

  it('detects 2FA marker and does NOT flag no-2fa', async () => {
    const fetchFn = async (url) => {
      if (url.endsWith('/wp-login.php')) {
        return {
          status: 200,
          headers: { 'cf-ray': 'abc', 'set-cookie': 'x=y; HttpOnly; Secure' },
          body: '<html><div class="wordfence-ls-container">2FA prompt</div></html>',
        };
      }
      return { status: 302, headers: {}, body: '' };
    };
    const mod = new WpAdminProtection();
    const r = new Result();
    await mod.run(r, { wpAdminProtection: { url: 'https://x.com', fetchFn } });
    assert.equal(findByName(r, 'wp-admin-protection:no-2fa-detected'), undefined);
    assert.equal(findByName(r, 'wp-admin-protection:login-unhardened'), undefined);
  });

  it('flags cookie not-HttpOnly when login cookie lacks the flag', async () => {
    const fetchFn = async (url) => {
      if (url.endsWith('/wp-login.php')) {
        return {
          status: 200,
          headers: { 'cf-ray': 'abc', 'set-cookie': 'wordpress_test_cookie=x; path=/' },
          body: '<html><div class="wp-2fa">2FA</div></html>',
        };
      }
      return { status: 302, headers: {}, body: '' };
    };
    const mod = new WpAdminProtection();
    const r = new Result();
    await mod.run(r, { wpAdminProtection: { url: 'https://x.com', fetchFn } });
    assert.ok(findByName(r, 'wp-admin-protection:cookie-not-httponly'));
  });

  it('reports login-blocked when /wp-login.php returns 403 (WAF / .htaccess)', async () => {
    const fetchFn = async (url) => {
      if (url.endsWith('/wp-login.php')) return { status: 403, headers: {}, body: '' };
      return { status: 404, headers: {}, body: '' };
    };
    const mod = new WpAdminProtection();
    const r = new Result();
    await mod.run(r, { wpAdminProtection: { url: 'https://x.com', fetchFn } });
    assert.ok(findByName(r, 'wp-admin-protection:login-blocked'));
  });
});

// ---------------------------------------------------------------------------
// wpPhpVersionEol
// ---------------------------------------------------------------------------

describe('WpPhpVersionEol', () => {
  it('returns no-url skip when no URL provided', async () => {
    const mod = new WpPhpVersionEol();
    const r = new Result();
    await mod.run(r, {});
    assert.ok(ruleNames(r).includes('wp-php-eol:no-url'));
  });

  it('flags EOL when X-Powered-By reports PHP 7.4', async () => {
    const fetchFn = async () => ({
      status: 200,
      headers: { 'x-powered-by': 'PHP/7.4.33' },
      body: '<html></html>',
    });
    const mod = new WpPhpVersionEol();
    const r = new Result();
    await mod.run(r, { wpPhpVersionEol: { url: 'https://x.com', fetchFn } });
    const hit = findByName(r, 'wp-php-eol:eol:7.4');
    assert.ok(hit);
    assert.equal(hit.severity, 'error');
    assert.match(hit.message, /7\.4\.33/);
  });

  it('flags warning for security-only versions', async () => {
    const fetchFn = async () => ({
      status: 200,
      headers: { 'x-powered-by': 'PHP/8.1.20' },
      body: '',
    });
    const mod = new WpPhpVersionEol();
    const r = new Result();
    await mod.run(r, { wpPhpVersionEol: { url: 'https://x.com', fetchFn } });
    const hit = findByName(r, 'wp-php-eol:security-only:8.1');
    assert.ok(hit);
    assert.equal(hit.severity, 'warning');
  });

  it('does NOT flag for actively-supported versions', async () => {
    const fetchFn = async () => ({
      status: 200,
      headers: { 'x-powered-by': 'PHP/8.3.10' },
      body: '',
    });
    const mod = new WpPhpVersionEol();
    const r = new Result();
    await mod.run(r, { wpPhpVersionEol: { url: 'https://x.com', fetchFn } });
    const hit = findByName(r, 'wp-php-eol:active:8.3');
    assert.ok(hit);
    assert.equal(hit.severity, 'info');
  });

  it('reports not-detected when X-Powered-By is stripped (CDN/WP Engine)', async () => {
    const fetchFn = async () => ({ status: 200, headers: {}, body: '<html></html>' });
    const mod = new WpPhpVersionEol();
    const r = new Result();
    await mod.run(r, { wpPhpVersionEol: { url: 'https://x.com', fetchFn } });
    assert.ok(findByName(r, 'wp-php-eol:not-detected'));
  });
});

// ---------------------------------------------------------------------------
// wpThemeAbandonment
// ---------------------------------------------------------------------------

describe('WpThemeAbandonment', () => {
  it('returns no-url skip when no URL provided', async () => {
    const mod = new WpThemeAbandonment();
    const r = new Result();
    await mod.run(r, {});
    assert.ok(ruleNames(r).includes('wp-theme:no-url'));
  });

  it('detects an unknown (not-on-bad-list) theme and reports the slug', async () => {
    const html = `<link rel="stylesheet" href="/wp-content/themes/blocksy/style.css?ver=2.0.0">`;
    const fetchFn = async () => ({ status: 200, body: html });
    const mod = new WpThemeAbandonment();
    const r = new Result();
    await mod.run(r, { wpThemeAbandonment: { url: 'https://x.com', fetchFn } });
    const hit = findByName(r, 'wp-theme:detected:blocksy');
    assert.ok(hit);
    assert.match(hit.message, /blocksy/);
  });

  it('flags as ERROR for theme with known CVE (avada in our list)', async () => {
    const html = `<link rel="stylesheet" href="/wp-content/themes/avada/style.css?ver=7.10.0">`;
    const fetchFn = async () => ({ status: 200, body: html });
    const mod = new WpThemeAbandonment();
    const r = new Result();
    await mod.run(r, { wpThemeAbandonment: { url: 'https://x.com', fetchFn } });
    const hit = findByName(r, 'wp-theme:cve:avada');
    assert.ok(hit);
    assert.equal(hit.severity, 'error');
  });

  it('flags as WARNING for deprecated default theme (twentyfifteen)', async () => {
    const html = `<link rel="stylesheet" href="/wp-content/themes/twentyfifteen/style.css">`;
    const fetchFn = async () => ({ status: 200, body: html });
    const mod = new WpThemeAbandonment();
    const r = new Result();
    await mod.run(r, { wpThemeAbandonment: { url: 'https://x.com', fetchFn } });
    const hit = findByName(r, 'wp-theme:deprecated:twentyfifteen');
    assert.ok(hit);
    assert.equal(hit.severity, 'warning');
  });

  it('reports not-detected when no theme URL in HTML', async () => {
    const fetchFn = async () => ({ status: 200, body: '<html><body>no theme refs</body></html>' });
    const mod = new WpThemeAbandonment();
    const r = new Result();
    await mod.run(r, { wpThemeAbandonment: { url: 'https://x.com', fetchFn } });
    assert.ok(findByName(r, 'wp-theme:not-detected'));
  });
});

// ---------------------------------------------------------------------------
// wpBackupValidation
// ---------------------------------------------------------------------------

describe('WpBackupValidation', () => {
  it('returns no-url skip when no URL provided', async () => {
    const mod = new WpBackupValidation();
    const r = new Result();
    await mod.run(r, {});
    assert.ok(ruleNames(r).includes('wp-backup:no-url'));
  });

  it('detects UpdraftPlus from homepage plugin URL and reports info', async () => {
    const html = `<link href="/wp-content/plugins/updraftplus/assets/style.css?ver=1.0">`;
    const fetchFn = async () => ({ status: 200, body: html });
    const probeFn = async () => ({ status: 404 });
    const mod = new WpBackupValidation();
    const r = new Result();
    await mod.run(r, { wpBackupValidation: { url: 'https://x.com', fetchFn, probeFn } });
    const hit = findByName(r, 'wp-backup:plugin-detected');
    assert.ok(hit);
    assert.match(hit.message, /updraftplus/);
  });

  it('flags no-plugin-detected as warning when no backup plugin found on non-managed host', async () => {
    const fetchFn = async () => ({ status: 200, body: '<html>plain site</html>' });
    const probeFn = async () => ({ status: 404 });
    const mod = new WpBackupValidation();
    const r = new Result();
    await mod.run(r, { wpBackupValidation: { url: 'https://small-business.example', fetchFn, probeFn } });
    const hit = findByName(r, 'wp-backup:no-plugin-detected');
    assert.ok(hit);
    assert.equal(hit.severity, 'warning');
  });

  it('downgrades to info on managed hosts (wpengine, kinsta, etc.)', async () => {
    const fetchFn = async () => ({ status: 200, body: '<html></html>' });
    const probeFn = async () => ({ status: 404 });
    const mod = new WpBackupValidation();
    const r = new Result();
    await mod.run(r, { wpBackupValidation: { url: 'https://mysite.wpengine.com', fetchFn, probeFn } });
    assert.ok(findByName(r, 'wp-backup:managed-host'));
    assert.equal(findByName(r, 'wp-backup:no-plugin-detected'), undefined);
  });

  it('flags EXPOSED backup as ERROR when backup file is publicly accessible', async () => {
    const fetchFn = async () => ({ status: 200, body: '<html></html>' });
    const probeFn = async (url) => {
      if (url.endsWith('/wp-content/updraft/')) return { status: 200 };
      return { status: 404 };
    };
    const mod = new WpBackupValidation();
    const r = new Result();
    await mod.run(r, { wpBackupValidation: { url: 'https://x.com', fetchFn, probeFn } });
    const hit = findByName(r, 'wp-backup:exposed:wp-content/updraft/');
    assert.ok(hit);
    assert.equal(hit.severity, 'error');
    assert.match(hit.message, /catastrophic/);
  });

  it('flags exposed manual backup.zip in webroot', async () => {
    const fetchFn = async () => ({ status: 200, body: '<html></html>' });
    const probeFn = async (url) => {
      if (url.endsWith('/backup.zip')) return { status: 200 };
      return { status: 404 };
    };
    const mod = new WpBackupValidation();
    const r = new Result();
    await mod.run(r, { wpBackupValidation: { url: 'https://x.com', fetchFn, probeFn } });
    assert.ok(findByName(r, 'wp-backup:exposed:backup.zip'));
  });
});
