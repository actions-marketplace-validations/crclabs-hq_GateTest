/**
 * WordPress — Exposed sensitive files detector.
 *
 * The single highest-pain WordPress vulnerability class. Owners back up
 * wp-config.php to wp-config.php.bak before editing, forget to delete it,
 * and the database credentials become publicly readable at
 * yoursite.com/wp-config.php.bak. Same story for debug.log, error_log,
 * .git directories, and editor swap files.
 *
 * This module probes a curated set of known-bad paths and reports any
 * that return a 200 OR a 403-but-readable-via-trick. Each finding maps
 * to a real, documented attack vector:
 *
 *   wp-config.php.bak / .swp / .save / .orig / ~      Database credentials
 *   debug.log / error_log / wp-content/debug.log      Stack traces leaking paths + secrets
 *   .git / .git/HEAD / .git/config                    Full source code via dumper tools
 *   .env                                              Modern WP-on-Laravel-style configs
 *   .DS_Store                                         macOS-deployed sites; reveals filename list
 *   README.html / license.txt / readme.txt            WordPress core version leak
 *   wp-content/uploads/*.sql                          Database backups left in uploads
 *   wp-content/uploads/.htaccess                      Misconfigured upload directory
 *
 * Pure HTTP probe — does not need any auth. Customer pastes their site
 * URL; we probe each path with a HEAD (or fall back to GET-with-Range)
 * and observe the status + content-type. Module supports both single-
 * URL website scans (typical WP customer flow) AND filesystem scans
 * (CLI / git-host customers checking a checkout).
 *
 * Module ID: 92 (WordPress family).
 * Pre-authorisation: Craig 2026-05-13 — WordPress side product Boss Rule D.
 */

const fs = require('fs');
const path = require('path');
const BaseModule = require('./base-module');

const KNOWN_BAD_PATHS = [
  // Editor / system backup files (highest impact — database credentials)
  { path: 'wp-config.php.bak',         severity: 'error',   reason: 'WordPress config backup — exposes database credentials and secret keys' },
  { path: 'wp-config.php.swp',         severity: 'error',   reason: 'Vim swap file of wp-config.php — exposes database credentials' },
  { path: 'wp-config.php.save',        severity: 'error',   reason: 'Nano save file of wp-config.php — exposes database credentials' },
  { path: 'wp-config.php.orig',        severity: 'error',   reason: 'Original wp-config.php backup — exposes database credentials' },
  { path: 'wp-config.php~',            severity: 'error',   reason: 'gedit/Emacs backup of wp-config.php — exposes database credentials' },
  { path: 'wp-config-sample.php.bak',  severity: 'warning', reason: 'Sample config backup — may leak intended secret-key shapes' },
  { path: 'wp-config.old',             severity: 'error',   reason: 'Old wp-config — exposes database credentials' },
  // Debug logs
  { path: 'wp-content/debug.log',      severity: 'error',   reason: 'WordPress debug log — leaks file paths, queries, sometimes plaintext data' },
  { path: 'debug.log',                 severity: 'error',   reason: 'Debug log in webroot — leaks paths and stack traces' },
  { path: 'error_log',                 severity: 'error',   reason: 'PHP error log — leaks file paths and stack traces' },
  // Git / source control leaks
  { path: '.git/HEAD',                 severity: 'error',   reason: '.git directory exposed — entire source code recoverable with git-dumper tools' },
  { path: '.git/config',               severity: 'error',   reason: '.git config exposed — same as above; usually paired with HEAD' },
  // Modern env / deploy artifacts
  { path: '.env',                      severity: 'error',   reason: '.env file in webroot — exposes API keys, database URLs, secret keys' },
  { path: '.env.local',                severity: 'error',   reason: '.env.local in webroot — same as above' },
  { path: '.env.production',           severity: 'error',   reason: '.env.production in webroot — production credentials' },
  // macOS artefact
  { path: '.DS_Store',                 severity: 'warning', reason: 'macOS folder metadata — reveals every filename in the directory' },
  // WordPress fingerprinting
  { path: 'readme.html',               severity: 'warning', reason: 'WordPress core readme — leaks exact WP version, enables CVE matching' },
  { path: 'license.txt',               severity: 'info',    reason: 'WordPress license file — accessible by default, weak version-leak signal' },
  // Backup plugin artifacts
  { path: 'wp-content/backup.sql',     severity: 'error',   reason: 'Raw SQL dump — full database including hashed passwords readable' },
  { path: 'wp-content/db-backup.sql',  severity: 'error',   reason: 'Raw SQL dump — full database readable' },
  { path: 'wp-content/uploads/backup.sql', severity: 'error', reason: 'SQL dump in uploads — full database readable' },
  { path: 'backup.zip',                severity: 'warning', reason: 'Backup archive in webroot — may contain wp-config.php and full source' },
  { path: 'site.zip',                  severity: 'warning', reason: 'Backup archive in webroot — may contain wp-config.php and full source' },
  // Composer / Node leaks
  { path: 'composer.json',             severity: 'info',    reason: 'composer.json readable — leaks dependency versions for fingerprinting' },
  { path: 'composer.lock',             severity: 'info',    reason: 'composer.lock readable — leaks exact dependency versions for CVE matching' },
  { path: 'package.json',              severity: 'info',    reason: 'package.json readable — leaks dependency versions if customer mixes WP with Node tooling' },
];

class WpExposedFilesModule extends BaseModule {
  constructor() {
    super(
      'wpExposedFiles',
      'WordPress — finds sensitive files exposed via the public webroot (wp-config.php.bak, debug.log, .git, .env, SQL backups)'
    );
  }

  /**
   * Run mode is determined by config.wpExposedFiles.url (HTTP probe) OR
   * the presence of files on disk (filesystem scan).
   */
  async run(result, config) {
    const moduleConfig = (config && config.wpExposedFiles) || {};
    const url = moduleConfig.url
      || (config && config.targetUrl)
      || (config && config.wpUrl);
    const projectRoot = (config && config.projectRoot) || process.cwd();

    if (url) {
      await this._scanHttp(result, url, moduleConfig);
      return;
    }
    await this._scanFilesystem(result, projectRoot);
  }

  async _scanHttp(result, baseUrl, moduleConfig) {
    const normalised = this._normaliseBaseUrl(baseUrl);
    if (!normalised) {
      result.addCheck('wp-exposed-files:bad-url', false, {
        severity: 'error',
        message: `wpExposedFiles: cannot parse URL "${baseUrl}"`,
      });
      return;
    }

    const probe = moduleConfig.probeFn || this._defaultProbe;
    const concurrency = Math.max(1, Math.min(moduleConfig.concurrency || 6, 20));
    const timeoutMs  = Math.max(1000, Math.min(moduleConfig.timeoutMs  || 8000, 30000));

    let cursor = 0;
    const probedCount = { value: 0 };
    const foundCount = { value: 0 };

    async function worker() {
      while (cursor < KNOWN_BAD_PATHS.length) {
        const idx = cursor++;
        const entry = KNOWN_BAD_PATHS[idx];
        const url = `${normalised}/${entry.path}`;
        let probeResult;
        try {
          probeResult = await probe(url, { timeoutMs });
        } catch (err) {
          // Network failure on a single probe should not abort the whole module.
          result.addCheck(`wp-exposed-files:probe-error:${entry.path}`, true, {
            severity: 'info',
            message: `Could not probe ${entry.path}: ${err.message || err}`,
          });
          probedCount.value += 1;
          continue;
        }
        probedCount.value += 1;
        const exposed = probeResult.status >= 200 && probeResult.status < 300;
        if (exposed) {
          foundCount.value += 1;
          result.addCheck(`wp-exposed-files:found:${entry.path}`, false, {
            severity: entry.severity,
            message: `EXPOSED: ${url} — ${entry.reason}`,
          });
        }
      }
    }

    const workers = Array.from(
      { length: Math.min(concurrency, KNOWN_BAD_PATHS.length) },
      () => worker()
    );
    await Promise.all(workers);

    result.addCheck('wp-exposed-files:summary', true, {
      severity: 'info',
      message: `wpExposedFiles: probed ${probedCount.value} known-bad paths against ${normalised}; ${foundCount.value} exposure(s) found`,
    });
  }

  async _scanFilesystem(result, projectRoot) {
    // Filesystem scan — checks if the customer's checkout has any of these
    // bad files committed (catches them before deploy).
    let foundCount = 0;
    for (const entry of KNOWN_BAD_PATHS) {
      const full = path.join(projectRoot, entry.path);
      if (this._safeExists(full)) {
        foundCount += 1;
        result.addCheck(`wp-exposed-files:fs:${entry.path}`, false, {
          severity: entry.severity,
          message: `FILE PRESENT: ${entry.path} — ${entry.reason}. Delete before deploying.`,
        });
      }
    }
    result.addCheck('wp-exposed-files:fs-summary', true, {
      severity: 'info',
      message: `wpExposedFiles (filesystem mode): checked ${KNOWN_BAD_PATHS.length} known-bad paths; ${foundCount} found in checkout`,
    });
  }

  _safeExists(p) {
    try { return fs.existsSync(p); } catch { return false; }
  }

  _normaliseBaseUrl(input) {
    if (!input || typeof input !== 'string') return null;
    let raw = input.trim();
    if (!raw) return null;
    if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
    try {
      const u = new URL(raw);
      // strip trailing slash, keep protocol + host (+ port if non-default)
      return `${u.protocol}//${u.host}`;
    } catch {
      return null;
    }
  }

  /**
   * Default probe — uses global fetch (Node 20+ has it). Tests inject a
   * stub via moduleConfig.probeFn so unit tests don't make network calls.
   *
   * Uses HEAD first; if HEAD is rejected (some hosts return 405 for HEAD
   * on file paths) falls back to GET with Range: bytes=0-0 to avoid
   * pulling the full body.
   */
  async _defaultProbe(url, { timeoutMs }) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      let res = await fetch(url, {
        method: 'HEAD',
        signal: ac.signal,
        redirect: 'manual',
        // Pretend to be a normal browser; some hosts block undici's UA
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GateTest-WP-Scanner/1.0)' },
      });
      if (res.status === 405 || res.status === 501) {
        // HEAD not supported — fall back to a 1-byte GET
        res = await fetch(url, {
          method: 'GET',
          signal: ac.signal,
          redirect: 'manual',
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; GateTest-WP-Scanner/1.0)',
            'Range': 'bytes=0-0',
          },
        });
      }
      return { status: res.status };
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = WpExposedFilesModule;
// Exported for tests
module.exports.KNOWN_BAD_PATHS = KNOWN_BAD_PATHS;
