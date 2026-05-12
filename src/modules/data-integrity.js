/**
 * Data Integrity Module - Deep validation of data handling, migrations, models,
 * PII compliance, backup procedures, and data validation patterns.
 */

const BaseModule = require('./base-module');
const fs = require('fs');
const path = require('path');

class DataIntegrityModule extends BaseModule {
  constructor() {
    super('dataIntegrity', 'Data Integrity Validation');
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;

    this._checkMigrations(projectRoot, result);
    this._checkModels(projectRoot, result);
    this._checkPiiHandling(projectRoot, result);
    this._checkDataValidation(projectRoot, result);
    this._checkSqlInjection(projectRoot, result);
    this._checkIdempotency(projectRoot, result);
    this._checkBackupConfig(projectRoot, result);
  }

  _checkMigrations(projectRoot, result) {
    const migrationDirs = ['migrations', 'db/migrations', 'database/migrations', 'prisma/migrations'];
    let migrationDir = null;

    for (const dir of migrationDirs) {
      const fullPath = path.join(projectRoot, dir);
      if (fs.existsSync(fullPath)) {
        migrationDir = fullPath;
        break;
      }
    }

    if (!migrationDir) {
      result.addCheck('data:migrations', true, {
        message: 'No migration directory found — skipping',
        severity: 'info',
      });
      return;
    }

    const files = fs.readdirSync(migrationDir).filter(f => !f.startsWith('.'));
    result.addCheck('data:migrations-exist', true, {
      message: `${files.length} migration(s) found in ${path.relative(projectRoot, migrationDir)}`,
      severity: 'info',
    });

    // Check migration naming convention (should be sequential/timestamped)
    const hasTimestamps = files.some(f => /^\d{4}|^\d{13,}/.test(f));
    const hasSequential = files.some(f => /^\d{3,4}_/.test(f));

    if (files.length > 1 && !hasTimestamps && !hasSequential) {
      result.addCheck('data:migration-naming', false, {
        severity: 'warning',
        message: 'Migration files lack sequential or timestamp naming',
        suggestion: 'Use timestamp or sequential naming: 001_create_users.sql, 002_add_email.sql',
      });
    }

    // Check for destructive operations without safeguards
    for (const file of files) {
      const filePath = path.join(migrationDir, file);
      if (!fs.statSync(filePath).isFile()) continue;

      try {
        const content = fs.readFileSync(filePath, 'utf-8').toLowerCase();

        if (content.includes('drop table') && !content.includes('if exists')) {
          result.addCheck(`data:migration-drop:${file}`, false, {
            file: path.relative(projectRoot, filePath),
            severity: 'error',
            message: 'DROP TABLE without IF EXISTS — dangerous in production',
            suggestion: 'Use DROP TABLE IF EXISTS for safety',
          });
        }

        if (content.includes('truncate')) {
          result.addCheck(`data:migration-truncate:${file}`, false, {
            file: path.relative(projectRoot, filePath),
            severity: 'error',
            message: 'TRUNCATE in migration — will destroy data in production',
            suggestion: 'Avoid TRUNCATE in migrations; use conditional deletes instead',
          });
        }

        // Check for NOT NULL without DEFAULT on ALTER TABLE
        if (content.includes('alter table') && content.includes('not null') && !content.includes('default')) {
          result.addCheck(`data:migration-notnull:${file}`, false, {
            file: path.relative(projectRoot, filePath),
            severity: 'warning',
            message: 'Adding NOT NULL column without DEFAULT — will fail on existing rows',
            suggestion: 'Add DEFAULT value or make the migration multi-step',
          });
        }
      } catch { /* skip unreadable files */ }
    }
  }

  _checkModels(projectRoot, result) {
    // Prisma
    const prismaSchema = path.join(projectRoot, 'prisma/schema.prisma');
    if (fs.existsSync(prismaSchema)) {
      const { exitCode } = this._exec('npx prisma validate 2>&1', { cwd: projectRoot });
      if (exitCode === 0) {
        result.addCheck('data:prisma-schema', true, { message: 'Prisma schema valid' });
      } else {
        result.addCheck('data:prisma-schema', false, {
          message: 'Prisma schema validation failed',
          suggestion: 'Run "npx prisma validate" to see errors',
        });
      }

      // Check for missing @unique / @@unique constraints
      const schema = fs.readFileSync(prismaSchema, 'utf-8');
      if (schema.includes('email') && !schema.includes('@unique')) {
        result.addCheck('data:prisma-unique', false, {
          file: 'prisma/schema.prisma',
          severity: 'warning',
          message: 'Email field found without @unique constraint',
          suggestion: 'Add @unique to email fields to prevent duplicates',
        });
      }

      return;
    }

    // Mongoose
    const jsFiles = this._collectFiles(projectRoot, ['.js', '.ts']);
    let hasMongoose = false;
    for (const file of jsFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      if (content.includes('mongoose.Schema') || content.includes('new Schema(')) {
        hasMongoose = true;
        const relPath = path.relative(projectRoot, file);

        // Check for missing validation
        if (!content.includes('required:') && !content.includes('validate:')) {
          result.addCheck(`data:mongoose-validation:${relPath}`, false, {
            file: relPath,
            severity: 'warning',
            message: 'Mongoose schema without field validation',
            suggestion: 'Add required/validate constraints to schema fields',
          });
        }
      }
    }

    if (!hasMongoose) {
      result.addCheck('data:models', true, {
        message: 'No ORM schema detected — skipping',
        severity: 'info',
      });
    }
  }

  _checkPiiHandling(projectRoot, result) {
    const jsFiles = this._collectFiles(projectRoot, ['.js', '.ts', '.jsx', '.tsx']);

    const piiPatterns = [
      { regex: /console\.(log|info|debug)\s*\(.*(?:email|password|ssn|credit.?card|phone)/gi, type: 'PII in logs' },
      { regex: /JSON\.stringify\s*\(.*(?:password|secret|token)/gi, type: 'Sensitive data serialized' },
      { regex: /localStorage\.setItem\s*\(.*(?:token|password|secret)/gi, type: 'Sensitive data in localStorage' },
      { regex: /document\.cookie\s*=.*(?:token|password|auth)/gi, type: 'Sensitive data in cookies' },
    ];

    let piiCount = 0;
    for (const file of jsFiles) {
      const relPath = path.relative(projectRoot, file).split(path.sep).join('/');
      if (relPath.includes('test') || relPath.includes('.test.')) continue;
      // Skip detector source files — modules whose JOB is to detect
      // these patterns contain them as JSDoc and string examples.
      if (/(?:^|\/)src\/modules\/(?:log-pii|data-integrity|cross-file-taint|cookie-security|tls-security)\.js$/.test(relPath)) {
        continue;
      }

      const rawContent = fs.readFileSync(file, 'utf-8');
      // Strip comments (JSDoc + line comments) — preserves strings so
      // real PII-in-strings cases still detect.
      const content = this._stripCommentsOnly(rawContent);

      // Honour `// pii-ok` / `# pii-ok` / `// data-ok` line-level
      // suppression — for legitimate cases like a login form
      // serialising the password into a fetch body to the auth endpoint.
      const rawLines = rawContent.split('\n');
      const suppressedLines = new Set();
      for (let i = 0; i < rawLines.length; i++) {
        if (/(?:\/\/|#)\s*(?:pii-ok|data-ok)\b/.test(rawLines[i])) {
          suppressedLines.add(i);
          if (i + 1 < rawLines.length) suppressedLines.add(i + 1);
        }
      }

      for (const { regex, type } of piiPatterns) {
        regex.lastIndex = 0;
        const lines = content.split('\n');
        let hit = false;
        for (let i = 0; i < lines.length; i++) {
          regex.lastIndex = 0;
          if (regex.test(lines[i]) && !suppressedLines.has(i)) {
            hit = true;
            break;
          }
        }
        if (hit) {
          piiCount++;
          if (piiCount <= 5) {
            result.addCheck(`data:pii:${type}:${relPath}`, false, {
              file: relPath,
              severity: 'error',
              message: `Potential ${type} detected`,
              suggestion: 'Ensure PII is never logged, serialized unsafely, or stored in localStorage. Mark intentional uses with `// pii-ok`.',
            });
          }
        }
      }
    }

    if (piiCount > 5) {
      result.addCheck('data:pii-count', false, {
        severity: 'error',
        message: `${piiCount} PII handling issues found (showing first 5)`,
      });
    } else if (piiCount === 0) {
      result.addCheck('data:pii', true, { severity: 'info', message: 'No PII handling issues detected' });
    }
  }

  // Newline-preserving comment stripper that LEAVES strings intact —
  // identical contract to security.js#_stripCommentsOnly so both
  // modules treat strings the same way (real bugs in strings → flagged,
  // doc-comments → ignored).
  _stripCommentsOnly(source) {
    const lines = source.split('\n');
    const out = [];
    let inBlockComment = false;
    let inString = null;
    for (const raw of lines) {
      let line = '';
      let i = 0;
      while (i < raw.length) {
        if (inBlockComment) {
          if (raw[i] === '*' && raw[i + 1] === '/') {
            inBlockComment = false;
            i += 2;
          } else {
            i += 1;
          }
          continue;
        }
        if (inString) {
          line += raw[i];
          if (raw[i] === '\\' && i + 1 < raw.length) {
            line += raw[i + 1];
            i += 2;
            continue;
          }
          if (raw[i] === inString) inString = null;
          i += 1;
          continue;
        }
        if (raw[i] === '/' && raw[i + 1] === '*') {
          inBlockComment = true;
          i += 2;
          continue;
        }
        if (raw[i] === '/' && raw[i + 1] === '/') break;
        if (raw[i] === '"' || raw[i] === "'" || raw[i] === '`') {
          inString = raw[i];
          line += raw[i];
          i += 1;
          continue;
        }
        line += raw[i];
        i += 1;
      }
      out.push(line);
    }
    return out.join('\n');
  }

  _checkDataValidation(projectRoot, result) {
    const jsFiles = this._collectFiles(projectRoot, ['.js', '.ts', '.jsx', '.tsx']);

    for (const file of jsFiles) {
      const relPath = path.relative(projectRoot, file);
      if (relPath.includes('test') || relPath.includes('node_modules')) continue;

      const content = fs.readFileSync(file, 'utf-8');

      // Check for raw body parsing without validation
      if (content.includes('req.body') && !content.includes('validate') &&
          !content.includes('schema') && !content.includes('zod') &&
          !content.includes('joi') && !content.includes('yup')) {

        // Only flag handler files, not utility files
        if (content.includes('app.post') || content.includes('router.post') ||
            content.includes('export async function POST')) {
          result.addCheck(`data:no-validation:${relPath}`, false, {
            file: relPath,
            severity: 'warning',
            message: 'Request body used without input validation',
            suggestion: 'Add input validation using Zod, Joi, or similar',
          });
        }
      }
    }
  }

  _checkSqlInjection(projectRoot, result) {
    const jsFiles = this._collectFiles(projectRoot, ['.js', '.ts']);

    // Two SQL-context patterns. The second alternative `+ var +` was
    // previously included as a generic concat detector, but it matched
    // every JSDoc with `text + var + text` shape and blew out FPs. We
    // require SQL context (a query/execute/raw call OR a SQL-keyword
    // string) for both rules now.
    const sqlInterpolation = /(?:query|execute|raw|prepare|sql|exec)\s*\(\s*[`'"](?:SELECT|INSERT|UPDATE|DELETE|REPLACE|MERGE|CALL)\b[^)]*\$\{/gi;
    const sqlConcat = /(?:query|execute|raw|prepare|sql|exec)\s*\(\s*['"]\s*(?:SELECT|INSERT|UPDATE|DELETE|REPLACE|MERGE|CALL)\b[^)]*['"]\s*\+\s*\w+/gi;

    for (const file of jsFiles) {
      const relPath = path.relative(projectRoot, file).split(path.sep).join('/');
      if (relPath.includes('test')) continue;
      // Skip detector source files — modules whose JOB is to detect
      // these patterns contain the literal regexes + JSDoc examples.
      if (/(?:^|\/)src\/(?:modules\/(?:data-integrity|cross-file-taint|ssrf|sql-migrations|race-condition|log-pii|hardcoded-url|cron-expression|feature-flag|import-cycle|money-float|pr-size|ci-security|cookie-security|tls-security|redos)|core\/(?:claude-md-generator|gitignore))\.js$/.test(relPath)) {
        continue;
      }

      const rawContent = fs.readFileSync(file, 'utf-8');
      const content = this._stripCommentsOnly(rawContent);

      // Honour `// data-ok` / `# data-ok` line-level suppression.
      const rawLines = rawContent.split('\n');
      const suppressedLines = new Set();
      for (let i = 0; i < rawLines.length; i++) {
        if (/(?:\/\/|#)\s*data-ok\b/.test(rawLines[i])) {
          suppressedLines.add(i);
          if (i + 1 < rawLines.length) suppressedLines.add(i + 1);
        }
      }

      const lines = content.split('\n');
      let hit = false;
      for (let i = 0; i < lines.length; i++) {
        if (suppressedLines.has(i)) continue;
        sqlInterpolation.lastIndex = 0;
        sqlConcat.lastIndex = 0;
        if (sqlInterpolation.test(lines[i]) || sqlConcat.test(lines[i])) {
          hit = true;
          break;
        }
      }
      if (hit) {
        result.addCheck(`data:sql-injection:${relPath}`, false, {
          file: relPath,
          severity: 'error',
          message: 'Possible SQL injection — string concatenation/interpolation in query',
          suggestion: 'Use parameterized queries or prepared statements. Mark intentional dynamic SQL with `// data-ok`.',
        });
      }
    }
  }

  _checkIdempotency(projectRoot, result) {
    const migrationDirs = ['migrations', 'db/migrations', 'database/migrations', 'prisma/migrations'];
    let migrationDir = null;

    for (const dir of migrationDirs) {
      const fullPath = path.join(projectRoot, dir);
      if (fs.existsSync(fullPath)) {
        migrationDir = fullPath;
        break;
      }
    }

    if (!migrationDir) return;

    const files = fs.readdirSync(migrationDir).filter(f => !f.startsWith('.'));
    for (const file of files) {
      const filePath = path.join(migrationDir, file);
      if (!fs.statSync(filePath).isFile()) continue;

      try {
        const content = fs.readFileSync(filePath, 'utf-8').toLowerCase();

        // Check CREATE TABLE without IF NOT EXISTS
        if (content.includes('create table') && !content.includes('if not exists')) {
          result.addCheck(`data:idempotent:${file}`, false, {
            file: path.relative(projectRoot, filePath),
            severity: 'warning',
            message: 'CREATE TABLE without IF NOT EXISTS — not idempotent',
            suggestion: 'Use CREATE TABLE IF NOT EXISTS for idempotent migrations',
          });
        }
      } catch { /* skip */ }
    }
  }

  _checkBackupConfig(projectRoot, result) {
    // Check for backup/restore scripts
    const backupIndicators = [
      'backup.sh', 'restore.sh', 'scripts/backup.js', 'scripts/restore.js',
      'docker-compose.yml', // Often includes backup volumes
    ];

    const hasDbOps = this._collectFiles(projectRoot, ['.js', '.ts']).some(f => {
      try {
        const content = fs.readFileSync(f, 'utf-8');
        return content.includes('prisma') || content.includes('mongoose') ||
               content.includes('sequelize') || content.includes('knex');
      } catch { return false; }
    });

    if (hasDbOps) {
      const hasBackup = backupIndicators.some(f => fs.existsSync(path.join(projectRoot, f)));
      if (!hasBackup) {
        result.addCheck('data:backup', false, {
          severity: 'info',
          message: 'Database operations detected but no backup/restore scripts',
          suggestion: 'Add backup and restore scripts for disaster recovery',
        });
      }
    }
  }
}

module.exports = DataIntegrityModule;
