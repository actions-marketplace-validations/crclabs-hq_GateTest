/**
 * GateTest Alert Router — dispatches monitoring alerts to configured channels.
 * Channels: console (always), log file, webhook (Slack/Discord/Teams/custom).
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const LEVELS = { critical: 0, error: 1, warning: 2, info: 3 };

class AlertRouter {
  constructor(options = {}) {
    this.webhook = options.webhook || process.env.GATETEST_ALERT_WEBHOOK || null;
    this.logFile = options.logFile || null;
    this.minLevel = options.minLevel || 'warning';
    this.silent = options.silent || false;
  }

  async send(level, title, body, context = {}) {
    if (LEVELS[level] > LEVELS[this.minLevel]) return;

    const ts = new Date().toISOString();
    const entry = { ts, level, title, body, ...context };

    if (!this.silent) this._console(level, title, body);
    if (this.logFile) this._log(entry);
    if (this.webhook) await this._webhook(entry);
  }

  critical(title, body, ctx) { return this.send('critical', title, body, ctx); }
  error(title, body, ctx)    { return this.send('error',    title, body, ctx); }
  warning(title, body, ctx)  { return this.send('warning',  title, body, ctx); }
  info(title, body, ctx)     { return this.send('info',     title, body, ctx); }

  _console(level, title, body) {
    const prefix = { critical: '🔴 CRITICAL', error: '🟠 ERROR', warning: '🟡 WARNING', info: '🔵 INFO' }[level];
    console.log(`\n[GateTest Monitor] ${prefix}: ${title}`); // code-quality-ok — CLI terminal output
    if (body) console.log(`  ${body}`); // code-quality-ok — CLI terminal output
  }

  _log(entry) {
    try {
      fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
      fs.appendFileSync(this.logFile, JSON.stringify(entry) + '\n');
    } catch { /* log errors must never crash the monitor */ }
  }

  async _webhook(entry) {
    try {
      const payload = JSON.stringify({
        text: `*[GateTest] ${entry.level.toUpperCase()}: ${entry.title}*\n${entry.body || ''}`,
        attachments: [{ text: JSON.stringify(entry, null, 2), color: this._color(entry.level) }],
      });

      const url = new URL(this.webhook);
      const client = url.protocol === 'https:' ? https : http;
      await new Promise((resolve, reject) => {
        const req = client.request(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
          timeout: 5000,
        }, (res) => { res.resume(); resolve(); });
        req.on('error', reject);
        req.setTimeout(5000, () => { req.destroy(); reject(new Error('Webhook timeout')); });
        req.write(payload);
        req.end();
      });
    } catch { /* webhook failures must never crash the monitor */ }
  }

  _color(level) {
    return { critical: 'danger', error: 'danger', warning: 'warning', info: 'good' }[level] || 'good';
  }
}

module.exports = AlertRouter;
