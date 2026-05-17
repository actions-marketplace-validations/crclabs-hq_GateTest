/**
 * Cron-Expression Validator Module.
 *
 * The backup job was configured to run "first of every month at
 * midnight" but someone typed `0 0 0 1 *` instead of `0 0 1 * *`.
 * Now it silently never runs — cron swallows the impossible
 * "day-of-month 0" and schedules nothing. Six months pass. The
 * database has no backups. The outage that forces you to discover
 * this is the most expensive outage of the year.
 *
 * Invalid cron strings fail in three ways depending on the runner:
 *
 *   1. Silently never fire (GitHub Actions, k8s CronJob, Vercel Cron
 *      — they accept the string, validate it against "does this look
 *      like 5 or 6 fields", and if fields have impossible values the
 *      scheduler simply never triggers).
 *
 *   2. Throw a parse error at runtime (node-cron, croner — caught by
 *      unit tests if you're lucky, silently logged to stderr and
 *      ignored if you're not).
 *
 *   3. Fire at unintended times (ambiguous day-of-month + day-of-week
 *      semantics: `* * 1 * 1` = "1st of month OR Monday", not AND).
 *
 * Detection runs across:
 *   - `.github/workflows/*.yml` — `schedule: [{ cron: "..." }]`
 *   - Kubernetes manifests — `kind: CronJob` `spec.schedule: "..."`
 *   - `vercel.json` — `crons[].schedule`
 *   - Source code: `cron.schedule('...', fn)` (node-cron),
 *     `new Cron('...')` (croner), `schedule.scheduleJob('...', fn)`
 *     (node-schedule), `CronTrigger.from_crontab('...')` (APScheduler),
 *     Spring `@Scheduled(cron = "...")`
 *
 * Rules:
 *
 *   error:   Wrong number of fields (must be 5, 6, or a predefined
 *            alias like `@daily`).
 *            (rule: `cron:field-count:<where>:<line>`)
 *
 *   error:   Out-of-range value in a field (e.g. minute=60,
 *            hour=25, month=13).
 *            (rule: `cron:out-of-range:<where>:<line>`)
 *
 *   error:   Impossible day-of-month / month combination that never
 *            fires (Feb 30/31, Apr 31, Jun 31, Sep 31, Nov 31).
 *            (rule: `cron:impossible-date:<where>:<line>`)
 *
 *   warning: Suspiciously-frequent cron (`* * * * *` — every minute).
 *            Almost always unintended unless you really mean it.
 *            (rule: `cron:too-frequent:<where>:<line>`)
 *
 *   warning: Unparseable alias (e.g. `@weekly` typo as `@weely`).
 *            (rule: `cron:unknown-alias:<where>:<line>`)
 *
 * Suppressions:
 *   - `# cron-ok` / `// cron-ok` on the same or preceding line.
 *
 * Competitors:
 *   - `crontab-guru` is a web tool, not a linter.
 *   - `actionlint` validates GitHub Actions syntax but not cron-
 *     impossible-date semantics.
 *   - Kubernetes `kubeval` / `kubeconform` validate schema structure
 *     but not the cron string contents.
 *   - `node-cron` / `croner` throw at runtime if you're lucky.
 *   - Nothing unifies cron validation across CI + k8s + Vercel +
 *     source code simultaneously.
 *
 * TODO(gluecron): host-neutral — pure static source scan.
 *   Gluecron will likely ship its own scheduler; add a harvest
 *   hook when its cron-string format is announced.
 */

const BaseModule = require('./base-module');
const fs = require('fs');
const path = require('path');

const EXCLUDE_DIRS = new Set([
  'node_modules', '.git', '.claude', 'dist', 'build', 'coverage', '.gatetest',
  '.next', 'out', 'target', 'vendor', '.terraform', '__pycache__',
]);

const SOURCE_EXTS = new Set([
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts',
  '.py', '.java', '.kt', '.scala',
]);

const YAML_EXTS = new Set(['.yml', '.yaml']);
const JSON_EXTS = new Set(['.json']);

const SUPPRESS_RE = /\bcron-ok\b/;

const TEST_PATH_RE = /(?:^|\/)(?:test|tests|__tests__|spec|specs|e2e|fixtures?|stories)\//i;
const TEST_FILE_RE = /\.(?:test|spec|e2e|stories)\.[a-z0-9]+$/i;

// Predefined aliases accepted by most cron implementations.
const ALIASES = new Set([
  '@reboot', '@yearly', '@annually', '@monthly', '@weekly',
  '@daily', '@midnight', '@hourly', '@every',
]);

// Month / day-of-week name → number. All cron implementations are
// case-insensitive on these.
const MONTH_NAMES = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const DOW_NAMES = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

// Field index → {min, max, names}. Ordering matches 5-field standard;
// 6-field form prepends `seconds`.
const STANDARD_FIELDS_5 = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTH_NAMES },
  { name: 'day-of-week', min: 0, max: 7, names: DOW_NAMES }, // 0 and 7 both = Sunday
];
const STANDARD_FIELDS_6 = [
  { name: 'second', min: 0, max: 59 },
  ...STANDARD_FIELDS_5,
];

// ---- Module harvest regexes ----

const JS_CRON_CALL_RE = /(?:cron|schedule|scheduleJob|Cron|nodeSchedule)\s*(?:\.(?:schedule|scheduleJob|fromCronTab))?\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g;
const JS_NEW_CRON_RE = /\bnew\s+Cron\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g;
const PY_CRON_CALL_RE = /\b(?:CronTrigger\.from_crontab|CronTab)\s*\(\s*r?(['"])((?:\\.|(?!\1).)*)\1/g;
const SPRING_SCHEDULED_RE = /@Scheduled\s*\(\s*cron\s*=\s*(['"])((?:\\.|(?!\1).)*)\1/g;
// YAML GitHub Actions schedule: `- cron: '...'`
const YAML_CRON_RE = /^\s*-?\s*cron\s*:\s*(['"]?)([^'"#\n]+?)\1\s*(?:#.*)?$/;
// Kubernetes: `schedule: '...'`
const K8S_SCHEDULE_RE = /^\s*schedule\s*:\s*(['"]?)([^'"#\n]+?)\1\s*(?:#.*)?$/;
// vercel.json: "schedule": "..."
const VERCEL_CRON_RE = /"schedule"\s*:\s*"([^"]+)"/;

class CronExpressionModule extends BaseModule {
  constructor() {
    super('cronExpression', 'Cron-expression validator — catches invalid / impossible / too-frequent cron strings');
  }

  async run(result, config) {
    const projectRoot = (config && config.projectRoot) || process.cwd();
    const files = this._collect(projectRoot);

    if (files.length === 0) {
      result.addCheck('cron:no-files', true, {
        severity: 'info',
        message: 'No source files to scan',
      });
      return;
    }

    let harvested = 0;
    let issues = 0;

    for (const abs of files) {
      const rel = path.relative(projectRoot, abs).replace(/\\/g, '/');
      let text;
      try {
        text = fs.readFileSync(abs, 'utf-8');
      } catch {
        continue;
      }
      if (text.length > 2 * 1024 * 1024) continue;

      const ext = path.extname(abs).toLowerCase();
      const found = this._harvestCronStrings(rel, text, ext);
      harvested += found.length;
      for (const { expr, line } of found) {
        // Suppression: cron-ok on same or preceding line
        const lines = text.split('\n');
        const suppressed =
          (lines[line - 1] && SUPPRESS_RE.test(lines[line - 1])) ||
          (line > 1 && lines[line - 2] && SUPPRESS_RE.test(lines[line - 2]));
        if (suppressed) continue;

        const inTest = TEST_PATH_RE.test(rel) || TEST_FILE_RE.test(rel);
        issues += this._validateCron(expr, rel, line, result, inTest);
      }
    }

    result.addCheck('cron:summary', true, {
      severity: 'info',
      message: `${harvested} cron expression(s) validated, ${issues} issue(s)`,
      expressions: harvested,
      issueCount: issues,
    });
  }

  _collect(root) {
    const out = [];
    const walk = (dir) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (EXCLUDE_DIRS.has(e.name)) continue;
        // Allow .github/ through — GitHub Actions schedules live there.
        if (e.name.startsWith('.') && e.name !== '.' && e.name !== '.github') continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          walk(full);
        } else if (e.isFile()) {
          const ext = path.extname(e.name).toLowerCase();
          if (SOURCE_EXTS.has(ext) || YAML_EXTS.has(ext) || JSON_EXTS.has(ext)) {
            out.push(full);
          }
        }
      }
    };
    walk(root);
    return out;
  }

  _harvestCronStrings(rel, text, ext) {
    const found = [];
    const lines = text.split('\n');

    if (YAML_EXTS.has(ext)) {
      // Context-aware: we want `cron:` inside `schedule:` (GitHub
      // Actions) and `schedule:` on a CronJob resource. Simple
      // line-scan is enough for 99% of real cases.
      for (let i = 0; i < lines.length; i += 1) {
        const m1 = lines[i].match(YAML_CRON_RE);
        if (m1) {
          found.push({ expr: m1[2].trim(), line: i + 1 });
          continue;
        }
        const m2 = lines[i].match(K8S_SCHEDULE_RE);
        if (m2 && this._looksLikeCron(m2[2])) {
          found.push({ expr: m2[2].trim(), line: i + 1 });
        }
      }
      return found;
    }

    if (JSON_EXTS.has(ext)) {
      // vercel.json: { "crons": [ { "path": ..., "schedule": "..." } ] }
      for (let i = 0; i < lines.length; i += 1) {
        const m = lines[i].match(VERCEL_CRON_RE);
        if (m) found.push({ expr: m[1], line: i + 1 });
      }
      return found;
    }

    // Source code: JS/TS/Python/Java
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      // Skip pure comment lines
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*')) continue;

      for (const rx of [JS_CRON_CALL_RE, JS_NEW_CRON_RE, PY_CRON_CALL_RE, SPRING_SCHEDULED_RE]) {
        rx.lastIndex = 0;
        let m;
        while ((m = rx.exec(line)) !== null) {
          const expr = m[2];
          if (this._looksLikeCron(expr)) {
            found.push({ expr: expr.trim(), line: i + 1 });
          }
        }
      }
    }
    return found;
  }

  _looksLikeCron(s) {
    if (!s) return false;
    const trimmed = s.trim();
    if (trimmed.startsWith('@')) return true;
    // Heuristic: 3-7 whitespace-separated tokens (broad enough to
    // catch field-count bugs too), each made of digits, `*`, `/`,
    // `,`, `-`, `?`, `L`, `W`, `#`, or names.
    const parts = trimmed.split(/\s+/);
    if (parts.length < 3 || parts.length > 7) return false;
    const FIELD_RE = /^[\d*/,\-?LW#A-Za-z]+$/;
    if (!parts.every((p) => FIELD_RE.test(p))) return false;
    // Require at least one `*` or digit-or-slash token to
    // distinguish "sentence fragment" from cron. (`"hello world foo"`
    // shouldn't look like cron.)
    return parts.some((p) => /[*/\d]/.test(p));
  }

  // ------------------------------------------------------------------
  // Cron validation
  // ------------------------------------------------------------------

  _validateCron(expr, rel, line, result, inTest = false) {
    const raw = expr.trim();
    const errSev = inTest ? 'warning' : 'error';

    // Aliases
    if (raw.startsWith('@')) {
      const alias = raw.split(/\s+/)[0].toLowerCase();
      if (!ALIASES.has(alias)) {
        result.addCheck(`cron:unknown-alias:${rel}:${line}`, false, {
          severity: 'warning',
          message: `Unknown cron alias "${raw.split(/\s+/)[0]}" — did you mean @daily / @hourly / @weekly?`,
          file: rel,
          line,
          expression: raw,
        });
        return 1;
      }
      return 0;
    }

    const parts = raw.split(/\s+/);
    if (parts.length !== 5 && parts.length !== 6) {
      result.addCheck(`cron:field-count:${rel}:${line}`, false, {
        severity: errSev,
        message: `Cron expression has ${parts.length} field(s); expected 5 (standard) or 6 (with seconds): "${raw}"`,
        file: rel,
        line,
        expression: raw,
      });
      return 1;
    }

    const spec = parts.length === 5 ? STANDARD_FIELDS_5 : STANDARD_FIELDS_6;

    let issues = 0;
    const fieldValues = [];
    for (let i = 0; i < parts.length; i += 1) {
      const field = spec[i];
      const token = parts[i];
      const err = this._validateField(token, field);
      if (err) {
        result.addCheck(`cron:out-of-range:${rel}:${line}`, false, {
          severity: errSev,
          message: `Cron field "${field.name}" has invalid value "${token}": ${err}. Expression: "${raw}"`,
          file: rel,
          line,
          expression: raw,
          field: field.name,
          value: token,
        });
        issues += 1;
      }
      fieldValues.push(token);
    }

    // Impossible date: Feb 30/31, Apr/Jun/Sep/Nov 31.
    if (issues === 0) {
      const dayIdx = parts.length === 5 ? 2 : 3;
      const monthIdx = parts.length === 5 ? 3 : 4;
      const impossible = this._checkImpossibleDate(fieldValues[dayIdx], fieldValues[monthIdx]);
      if (impossible) {
        result.addCheck(`cron:impossible-date:${rel}:${line}`, false, {
          severity: errSev,
          message: `Cron specifies ${impossible} — this date never exists, the job will never fire. Expression: "${raw}"`,
          file: rel,
          line,
          expression: raw,
        });
        issues += 1;
      }
    }

    // Too frequent: `* * * * *`
    if (issues === 0 && raw === '* * * * *') {
      result.addCheck(`cron:too-frequent:${rel}:${line}`, false, {
        severity: 'warning',
        message: `Cron fires every minute — almost certainly not intended. Use @daily / @hourly or a more specific schedule.`,
        file: rel,
        line,
        expression: raw,
      });
      issues += 1;
    }

    return issues;
  }

  _validateField(token, field) {
    if (token === '*' || token === '?') return null; // wildcards

    // Step: `*/5`, `0-30/5`
    if (token.includes('/')) {
      const [range, stepStr] = token.split('/');
      if (!/^\d+$/.test(stepStr)) return `step "${stepStr}" is not a positive integer`;
      const step = parseInt(stepStr, 10);
      if (step === 0) return 'step is zero';
      if (range === '*') return null;
      const rangeErr = this._validateRangeOrList(range, field);
      return rangeErr;
    }

    return this._validateRangeOrList(token, field);
  }

  _validateRangeOrList(token, field) {
    // List: `1,5,10`
    if (token.includes(',')) {
      for (const part of token.split(',')) {
        const err = this._validateRangeOrList(part, field);
        if (err) return err;
      }
      return null;
    }

    // Range: `1-5`
    if (token.includes('-')) {
      const [lo, hi] = token.split('-');
      const loVal = this._parseValue(lo, field);
      const hiVal = this._parseValue(hi, field);
      if (loVal === null) return `"${lo}" is not a valid ${field.name} value`;
      if (hiVal === null) return `"${hi}" is not a valid ${field.name} value`;
      if (loVal > hiVal) return `range ${lo}-${hi} is inverted`;
      return null;
    }

    // Single value
    const val = this._parseValue(token, field);
    if (val === null) return `"${token}" is not a valid ${field.name} value`;
    return null;
  }

  _parseValue(token, field) {
    // Allow common day-of-month extensions like `L` (last) and `W`
    // (nearest-weekday). We don't fully validate them — just accept.
    if (/^(?:L|LW|\d+L|\d+W|W)$/.test(token)) return 0;
    // `?` is Quartz-style "no specific value"
    if (token === '?') return 0;
    // `#` is Quartz "Nth day of week in month": `3#2`
    if (/^[1-7]#[1-5]$/.test(token)) return 0;

    // Name form?
    if (field.names && /^[A-Za-z]+$/.test(token)) {
      const v = field.names[token.toLowerCase()];
      return v === undefined ? null : v;
    }

    if (!/^\d+$/.test(token)) return null;
    const v = parseInt(token, 10);
    if (v < field.min || v > field.max) return null;
    return v;
  }

  _checkImpossibleDate(dayToken, monthToken) {
    // Only flag when BOTH fields are concrete single values.
    if (!/^\d+$/.test(dayToken)) return null;
    const day = parseInt(dayToken, 10);

    // Month can be numeric or name.
    let month;
    if (/^\d+$/.test(monthToken)) {
      month = parseInt(monthToken, 10);
    } else if (/^[A-Za-z]+$/.test(monthToken)) {
      month = MONTH_NAMES[monthToken.toLowerCase()];
    } else {
      return null;
    }
    if (!month) return null;

    if (month === 2 && day > 29) return `February ${day}`;
    if ([4, 6, 9, 11].includes(month) && day > 30) {
      const names = { 4: 'April', 6: 'June', 9: 'September', 11: 'November' };
      return `${names[month]} ${day}`;
    }
    return null;
  }
}

module.exports = CronExpressionModule;
