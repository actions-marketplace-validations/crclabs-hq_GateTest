/**
 * WordPress — Backup-existence + exposed-backup detection.
 *
 * Painkiller #7 from docs/wp-painkillers-v1.md: "No tested backup —
 * host had an outage and I lost a week." The single most common reason
 * for catastrophic data loss in WordPress is "I assumed my host was
 * backing up; they weren't / the backup was corrupt / I couldn't
 * restore it." Owners who SAW a recent backup file referenced sleep
 * better than owners who didn't.
 *
 * Detection strategy:
 *
 *   1. Backup plugin fingerprinting:
 *      Detect installed backup plugins via the same plugin-asset URL
 *      pattern as wpPluginCveCheck (UpdraftPlus, BackWPup, Duplicator,
 *      BlogVault, WPBackItUp, UpdraftCentral, etc.).
 *      → Tells the customer they HAVE a backup tool.
 *
 *   2. Exposed-backup detection:
 *      Probe known backup-output paths for accessible files. Find any
 *      and the finding is CRITICAL — anyone can download your full
 *      site. Paths probed include the canonical output directories
 *      for UpdraftPlus, BackWPup, Duplicator, All-in-One WP Migration,
 *      plus generic /backup.zip /backup.sql /site.zip in the webroot.
 *
 *   3. Missing-backup signal:
 *      If no backup plugin detected AND the customer's URL is on a
 *      managed host known for backup-by-default (WP Engine, Kinsta,
 *      SiteGround Cloud), we can downgrade severity. Otherwise the
 *      finding is "you appear to have no backup plugin AND we can't
 *      confirm host-level backups — verify both."
 *
 * Module ID: 101 (WordPress family).
 * Pre-authorisation: Craig 2026-05-13 — WordPress side product Boss Rule D.
 */

const BaseModule = require('./base-module');

const BACKUP_PLUGIN_SLUGS = [
  'updraftplus',
  'backwpup',
  'duplicator',
  'duplicator-pro',
  'wpbackitup',
  'blogvault',
  'all-in-one-wp-migration',
  'wp-time-capsule',
  'backupbuddy',
  'jetpack-backup',
  'vaultpress',
  'wpvivid-backuprestore',
  'wp-database-backup',
];

// Known exposed-backup paths to probe. Each entry is a known artefact of
// a popular backup plugin.
const EXPOSED_BACKUP_PATHS = [
  // UpdraftPlus
  { path: 'wp-content/updraft/', severity: 'error', plugin: 'UpdraftPlus' },
  { path: 'wp-content/uploads/updraft/', severity: 'error', plugin: 'UpdraftPlus' },
  // BackWPup
  { path: 'wp-content/uploads/backwpup-logs/', severity: 'error', plugin: 'BackWPup' },
  // Duplicator
  { path: 'wp-snapshots/', severity: 'error', plugin: 'Duplicator' },
  { path: 'wp-content/uploads/duplicator/', severity: 'error', plugin: 'Duplicator' },
  // All-in-One WP Migration
  { path: 'wp-content/ai1wm-backups/', severity: 'error', plugin: 'All-in-One WP Migration' },
  // Generic / manual backups in webroot
  { path: 'backup.zip', severity: 'error', plugin: 'manual backup file' },
  { path: 'backup.sql', severity: 'error', plugin: 'manual backup file' },
  { path: 'site.zip', severity: 'error', plugin: 'manual backup file' },
  { path: 'dump.sql', severity: 'error', plugin: 'manual backup file' },
  { path: 'database.sql', severity: 'error', plugin: 'manual backup file' },
  { path: 'wp-content/uploads/backup.sql', severity: 'error', plugin: 'manual backup in uploads' },
  { path: 'wp-content/uploads/db-backup.sql', severity: 'error', plugin: 'manual backup in uploads' },
];

const PLUGIN_URL_REGEX = /\/wp-content\/plugins\/([a-z0-9-]+)\//gi;

// Hosts with backup-by-default — used to downgrade severity if no plugin found.
const MANAGED_HOST_DOMAINS = [
  '.wpengine.com',
  '.kinsta.com',
  '.kinsta.cloud',
  '.siteground.com',
  '.pantheon.io',
  '.flywheel.io',
  '.wpvip.com',
  '.cloudways.com',
];

class WpBackupValidationModule extends BaseModule {
  constructor() {
    super(
      'wpBackupValidation',
      'WordPress — checks whether a backup plugin is installed AND whether any backup files are publicly exposed (catastrophic data leak)'
    );
  }

  async run(result, config) {
    const moduleConfig = (config && config.wpBackupValidation) || {};
    const url = moduleConfig.url
      || (config && config.targetUrl)
      || (config && config.wpUrl);
    if (!url) {
      result.addCheck('wp-backup:no-url', true, {
        severity: 'info',
        message: 'wpBackupValidation: no URL provided — skipped (WP-URL mode only)',
      });
      return;
    }
    const normalised = this._normaliseBaseUrl(url);
    if (!normalised) {
      result.addCheck('wp-backup:bad-url', false, {
        severity: 'error',
        message: `wpBackupValidation: cannot parse URL "${url}"`,
      });
      return;
    }

    const fetchFn = moduleConfig.fetchFn || this._defaultFetch;
    const probeFn = moduleConfig.probeFn || this._defaultProbe;
    const timeoutMs = Math.max(1000, Math.min(moduleConfig.timeoutMs || 8000, 30000));

    // 1. Detect backup plugins from homepage HTML
    let html = '';
    try {
      const res = await fetchFn(`${normalised}/`, { timeoutMs });
      if (res.status >= 200 && res.status < 300 && typeof res.body === 'string') {
        html = res.body;
      }
    } catch (err) {
      result.addCheck('wp-backup:homepage-error', true, {
        severity: 'info',
        message: `Could not fetch homepage: ${err.message || err}`,
      });
    }
    const detectedSlugs = new Set();
    let m;
    PLUGIN_URL_REGEX.lastIndex = 0;
    while ((m = PLUGIN_URL_REGEX.exec(html)) !== null) {
      if (BACKUP_PLUGIN_SLUGS.includes(m[1])) detectedSlugs.add(m[1]);
    }

    if (detectedSlugs.size > 0) {
      result.addCheck('wp-backup:plugin-detected', true, {
        severity: 'info',
        message:
          `wpBackupValidation: backup plugin(s) detected on the site: ${[...detectedSlugs].join(', ')}. ` +
          `Good. Confirm your most recent backup is recent (last 7 days) and that you've TESTED a restore — ` +
          `an untested backup is no backup.`,
      });
    } else {
      // Check if site is on a managed host with backup-by-default
      const isManaged = MANAGED_HOST_DOMAINS.some((d) => normalised.toLowerCase().includes(d));
      if (isManaged) {
        result.addCheck('wp-backup:managed-host', true, {
          severity: 'info',
          message:
            `wpBackupValidation: no backup plugin detected but URL appears to be on a managed host that backs up by default. ` +
            `Verify in your hosting dashboard that the auto-backup schedule is active and you know how to restore.`,
        });
      } else {
        result.addCheck('wp-backup:no-plugin-detected', false, {
          severity: 'warning',
          message:
            `wpBackupValidation: no backup plugin detected on the site, and the URL is not on a managed host known for default backups. ` +
            `This is the #7 cause of WordPress catastrophic data loss — owners assume the host is backing up; the host isn't. ` +
            `Fix: install UpdraftPlus (free, mature) AND verify a successful restore on a staging copy before you need it. ` +
            `Alternative: BlogVault for managed off-site backups.`,
        });
      }
    }

    // 2. Probe for exposed-backup paths
    let exposedCount = 0;
    for (const entry of EXPOSED_BACKUP_PATHS) {
      const probeUrl = `${normalised}/${entry.path}`;
      let res;
      try {
        res = await probeFn(probeUrl, { timeoutMs });
      } catch {
        continue; // per-probe failure is fine
      }
      if (res.status >= 200 && res.status < 300) {
        exposedCount += 1;
        result.addCheck(`wp-backup:exposed:${entry.path}`, false, {
          severity: entry.severity,
          message:
            `EXPOSED BACKUP: ${probeUrl} returns ${res.status}. Anyone on the internet can download your ${entry.plugin} backup, ` +
            `which contains your ENTIRE database (including hashed admin passwords) and uploaded files. ` +
            `This is a catastrophic data leak. ` +
            `Fix immediately: (1) delete the file or directory from the server, ` +
            `(2) rotate ALL WordPress passwords + your database password, ` +
            `(3) generate fresh WordPress secret keys (https://api.wordpress.org/secret-key/1.1/salt/), ` +
            `(4) audit recent admin logins for unauthorised access.`,
        });
      }
    }

    result.addCheck('wp-backup:summary', true, {
      severity: 'info',
      message:
        `wpBackupValidation: plugins detected=${detectedSlugs.size}, exposed-backup files=${exposedCount}. ` +
        `Best state: at least one plugin detected AND zero exposed files.`,
    });
  }

  _normaliseBaseUrl(input) {
    if (!input || typeof input !== 'string') return null;
    let raw = input.trim();
    if (!raw) return null;
    if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
    try {
      const u = new URL(raw);
      return `${u.protocol}//${u.host}`;
    } catch {
      return null;
    }
  }

  async _defaultFetch(url, { timeoutMs }) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'GET',
        signal: ac.signal,
        redirect: 'follow',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GateTest-WP-Scanner/1.0)' },
      });
      const text = await res.text();
      return { status: res.status, body: text.slice(0, 64 * 1024) };
    } finally {
      clearTimeout(timer);
    }
  }

  async _defaultProbe(url, { timeoutMs }) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'HEAD',
        signal: ac.signal,
        redirect: 'manual',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GateTest-WP-Scanner/1.0)' },
      });
      return { status: res.status };
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = WpBackupValidationModule;
module.exports.BACKUP_PLUGIN_SLUGS = BACKUP_PLUGIN_SLUGS;
module.exports.EXPOSED_BACKUP_PATHS = EXPOSED_BACKUP_PATHS;
module.exports.MANAGED_HOST_DOMAINS = MANAGED_HOST_DOMAINS;
