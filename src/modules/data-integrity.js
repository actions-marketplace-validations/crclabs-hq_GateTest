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
      const relPath = path.relative(projectRoot, file);
      if (relPath.includes('test') || relPath.includes('.test.')) continue;

      const content = fs.readFileSync(file, 'utf-8');

      for (const { regex, type } of piiPatterns) {
        regex.lastIndex = 0;
        if (regex.test(content)) {
          piiCount++;
          if (piiCount <= 5) {
            result.addCheck(`data:pii:${type}:${relPath}`, false, {
              file: relPath,
              severity: 'error',
              message: `Potential ${type} detected`,
              suggestion: 'Ensure PII is never logged, serialized unsafely, or stored in localStorage',
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

    // Scanner modules and our own non-DB source contain string concatenation
    // patterns that look like SQL but aren't. Restrict the check to files
    // that actually look DB-aware.
    const SCANNER_PATH_RE = /(?:^|\/)(?:src\/modules|website\/app\/lib\/scan-modules|tests|integrations\/infra|lib)\//;

    for (const file of jsFiles) {
      const relPath = path.relative(projectRoot, file);
      const normalisedPath = relPath.replace(/\\/g, '/');
      if (normalisedPath.includes('test')) continue;
      if (SCANNER_PATH_RE.test(normalisedPath)) continue;

      const content = fs.readFileSync(file, 'utf-8');

      // SQL string concatenation INSIDE a query/execute/raw call. The old
      // regex had a runaway `(?:\+\s*\w+\s*\+)` alternation that matched
      // ANY `+ var +` anywhere in the file — flagging template literals
      // and module-summary strings as SQL injections. This narrower form
      // only matches the actual unsafe shape: a query function call with
      // SELECT/INSERT/UPDATE/DELETE followed by an interpolation.
      const sqlConcatPattern = /(?:query|execute|raw)\s*\(\s*[`'"](?:SELECT|INSERT|UPDATE|DELETE)\b[^`'"]*\$\{/gi;
      if (sqlConcatPattern.test(content)) {
        result.addCheck(`data:sql-injection:${relPath}`, false, {
          file: relPath,
          severity: 'error',
          message: 'Possible SQL injection — string interpolation inside a SQL query call',
          suggestion: 'Use parameterized queries or prepared statements',
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
