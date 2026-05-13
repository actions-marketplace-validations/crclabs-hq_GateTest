/**
 * GateTest Monitor — continuous URL polling with alerting and auto-healing.
 * Runs as a persistent process. Polls each target on its interval.
 * Alerts on downtime, slowness, content staleness, and cache expiry.
 * Triggers the Healer automatically when issues are found.
 */

const Diagnostics = require('./diagnostics');
const Healer      = require('./healer');
const AlertRouter = require('./alerts');
const fs          = require('fs');
const path        = require('path');

const DEFAULT_INTERVAL = 60;   // seconds
const DEFAULT_FAIL_THRESHOLD = 2;  // consecutive failures before alerting

class Monitor {
  constructor(options = {}) {
    this.diag    = new Diagnostics(options);
    this.healer  = new Healer({ ...options, dryRun: options.healDryRun !== false });
    this.alerts  = new AlertRouter(options);
    this.targets = [];
    this.state   = {};
    this.timers  = [];
    this.running = false;
    this.autoHeal = options.autoHeal || false;
    this.stateFile = options.stateFile || path.join(process.cwd(), '.gatetest', 'monitor', 'state.json');
  }

  addTarget(url, options = {}) {
    const target = {
      url: url.startsWith('http') ? url : `https://${url}`,
      interval: (options.interval || DEFAULT_INTERVAL) * 1000,
      failThreshold: options.failThreshold || DEFAULT_FAIL_THRESHOLD,
      label: options.label || url,
    };
    this.targets.push(target);
    this.state[target.url] = { consecutiveFails: 0, lastStatus: null, lastCheckMs: null };
    return this;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._loadState();

    console.log(`\n[GateTest Monitor] Starting — watching ${this.targets.length} target(s)`); // code-quality-ok — CLI terminal output
    console.log(`[GateTest Monitor] Auto-heal: ${this.autoHeal ? 'ON' : 'OFF (dry-run)'}`); // code-quality-ok — CLI terminal output
    console.log(`[GateTest Monitor] Press Ctrl+C to stop\n`); // code-quality-ok — CLI terminal output

    for (const target of this.targets) {
      // Immediate first check
      this._check(target);
      // Then poll on interval
      const timer = setInterval(() => this._check(target), target.interval);
      this.timers.push(timer);
    }

    process.on('SIGINT', () => this.stop());
    process.on('SIGTERM', () => this.stop());
  }

  stop() {
    this.running = false;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this._saveState();
    console.log('\n[GateTest Monitor] Stopped.\n'); // code-quality-ok — CLI terminal output
    process.exit(0);
  }

  async _check(target) {
    const st = this.state[target.url];
    st.lastCheckMs = Date.now();

    let diagnostic;
    try {
      diagnostic = await this.diag.diagnose(target.url);
    } catch (err) {
      diagnostic = { url: target.url, status: 'critical', issues: [{ severity: 'critical', code: 'unreachable', message: err.message }], actions: [], checks: {} };
    }

    const isHealthy = diagnostic.status === 'healthy';
    const wasFailing = st.consecutiveFails >= target.failThreshold;

    if (!isHealthy) {
      st.consecutiveFails++;
    } else {
      if (wasFailing) {
        await this.alerts.info(`${target.label} recovered`, `Back to healthy after ${st.consecutiveFails} failed checks`, { url: target.url });
      }
      st.consecutiveFails = 0;
    }

    st.lastStatus = diagnostic.status;
    this._printStatus(target, diagnostic);

    // Alert on threshold breach
    if (!isHealthy && st.consecutiveFails === target.failThreshold) {
      await this._alert(target, diagnostic);
    }

    // Auto-heal
    if (!isHealthy && this.autoHeal) {
      try {
        const heal = await this.healer.heal(diagnostic);
        if (heal.automated.length > 0) {
          const msgs = heal.automated.map(a => a.message).join(', ');
          await this.alerts.info(`${target.label} — auto-heal applied`, msgs, { url: target.url });
          console.log(`[GateTest Monitor] Auto-healed: ${msgs}`); // code-quality-ok — CLI terminal output
        }
      } catch { /* heal failures must not crash the monitor */ }
    }

    this._saveState();
  }

  async _alert(target, diagnostic) {
    const issues = diagnostic.issues.map(i => `${i.severity}: ${i.message}`).join('\n');
    const actions = diagnostic.actions.slice(0, 3).join('\n');
    const worstSeverity = diagnostic.issues.some(i => i.severity === 'critical') ? 'critical'
      : diagnostic.issues.some(i => i.severity === 'error') ? 'error' : 'warning';

    await this.alerts[worstSeverity](
      `${target.label} — ${diagnostic.status.toUpperCase()}`,
      `${issues}\n\nRecommended actions:\n${actions}`,
      { url: target.url, consecutiveFails: this.state[target.url].consecutiveFails }
    );
  }

  _printStatus(target, diagnostic) {
    const ts = new Date().toLocaleTimeString();
    const rt = diagnostic.checks?.responseTime;
    const rtStr = rt ? ` | ${rt.p50}ms` : '';
    const cache = diagnostic.checks?.cache?.cdnStatus ? ` | CDN:${diagnostic.checks.cache.cdnStatus}` : '';
    const icon = { healthy: '✓', warning: '!', degraded: '⚠', critical: '✗' }[diagnostic.status] || '?';

    console.log(`[${ts}] ${icon} ${target.label} (${diagnostic.status})${rtStr}${cache}`); // code-quality-ok — CLI terminal output

    if (diagnostic.issues.length > 0 && this.state[target.url].consecutiveFails >= 1) {
      for (const issue of diagnostic.issues) {
        console.log(`         → ${issue.code}: ${issue.message}`); // code-quality-ok — CLI terminal output
      }
    }
  }

  _saveState() {
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      fs.writeFileSync(this.stateFile, JSON.stringify({ saved: Date.now(), state: this.state }, null, 2));
    } catch { /* non-fatal */ }
  }

  _loadState() {
    try {
      if (fs.existsSync(this.stateFile)) {
        const saved = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
        for (const [url, st] of Object.entries(saved.state || {})) {
          if (this.state[url]) this.state[url] = { ...this.state[url], ...st };
        }
      }
    } catch { /* start fresh on parse error */ }
  }
}

module.exports = Monitor;
