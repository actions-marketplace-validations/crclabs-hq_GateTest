/**
 * Mutation Testing Module - Verifies tests actually catch bugs.
 *
 * Applies real code mutations (operator swaps, boundary changes, return value flips)
 * and verifies that at least one test fails for each mutation. If all tests still pass
 * after a mutation, the test suite has a gap.
 *
 * This is the most aggressive testing technique available — it tests the tests themselves.
 */

const BaseModule = require('./base-module');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// Mutation operators extracted to a testable engine module so they can
// be unit-tested independently of the test-runner orchestration.
const { MUTATIONS, shouldSkipLine } = require('../core/mutation-engine');

class MutationModule extends BaseModule {
  constructor() {
    super('mutation', 'Mutation Testing — Tests the Tests');
    // Opt out of incremental: mutation testing needs to mutate source
    // and re-run the FULL test suite per mutation. Restricting to the
    // changed file's source mutations is fine, but most projects need
    // the full corpus to get a meaningful score, and CI already runs
    // mutation nightly (not on every PR) so the speedup isn't needed.
    this._respectsIncremental = false;
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;
    const mutationConfig = config.getModuleConfig ? config.getModuleConfig('mutation') : {};
    const threshold = (mutationConfig && mutationConfig.threshold) || 80;
    const maxMutants = (mutationConfig && mutationConfig.maxMutants) || 50;

    // Detect test command
    const testCmd = this._detectTestCommand(projectRoot);
    if (!testCmd) {
      result.addCheck('mutation:detect', true, {
        message: 'No test framework detected — skipping mutation testing',
        severity: 'info',
      });
      return;
    }

    // Find source files (non-test files)
    const sourceFiles = this._findSourceFiles(projectRoot);
    if (sourceFiles.length === 0) {
      result.addCheck('mutation:sources', true, {
        message: 'No source files found for mutation testing',
        severity: 'info',
      });
      return;
    }

    // Verify tests pass before mutating
    const baseline = this._exec(testCmd, { cwd: projectRoot, timeout: 120000 });
    if (baseline.exitCode !== 0) {
      result.addCheck('mutation:baseline', false, {
        message: 'Tests must pass before mutation testing can run',
        severity: 'error',
        suggestion: 'Fix failing tests first, then re-run mutation testing',
      });
      return;
    }

    result.addCheck('mutation:baseline', true, {
      message: `Baseline tests pass. Generating mutants from ${sourceFiles.length} source files...`,
      severity: 'info',
    });

    // Generate and test mutants
    let killed = 0;
    let survived = 0;
    let totalMutants = 0;
    const survivors = [];

    for (const file of sourceFiles) {
      if (totalMutants >= maxMutants) break;

      const relPath = path.relative(projectRoot, file);
      const original = fs.readFileSync(file, 'utf-8');
      const lines = original.split('\n');

      for (const mutation of MUTATIONS) {
        if (totalMutants >= maxMutants) break;

        // Find lines where this mutation can apply
        for (let i = 0; i < lines.length; i++) {
          if (totalMutants >= maxMutants) break;

          const line = lines[i];
          // Skip comments, imports, requires — delegated to mutation-engine
          // helper so the rule lives in one place (tested in isolation).
          if (shouldSkipLine(line)) continue;

          mutation.pattern.lastIndex = 0;
          if (!mutation.pattern.test(line)) continue;

          // Apply mutation
          mutation.pattern.lastIndex = 0;
          const mutatedLine = line.replace(mutation.pattern, mutation.replace);
          if (mutatedLine === line) continue;

          const mutated = [...lines];
          mutated[i] = mutatedLine;
          const mutatedSource = mutated.join('\n');

          totalMutants++;

          // Write mutant, run tests, restore original
          try {
            fs.writeFileSync(file, mutatedSource);
            const testResult = this._exec(testCmd, { cwd: projectRoot, timeout: 30000 });

            if (testResult.exitCode !== 0) {
              killed++;
            } else {
              survived++;
              survivors.push({
                file: relPath,
                line: i + 1,
                mutation: mutation.name,
                description: mutation.desc,
                original: line.trim(),
                mutated: mutatedLine.trim(),
              });
            }
          } finally {
            // Always restore original
            fs.writeFileSync(file, original);
          }

          // Only test first match per mutation per file to keep runtime reasonable
          break;
        }
      }
    }

    if (totalMutants === 0) {
      result.addCheck('mutation:none', true, {
        message: 'No applicable mutations found in source files',
        severity: 'info',
      });
      return;
    }

    const score = Math.round((killed / totalMutants) * 100);

    result.addCheck('mutation:score', score >= threshold, {
      message: `Mutation score: ${score}% (${killed}/${totalMutants} killed, ${survived} survived)`,
      expected: `>= ${threshold}%`,
      actual: `${score}%`,
      severity: score >= threshold ? 'info' : 'error',
      suggestion: score < threshold
        ? 'Add tests that detect the surviving mutations listed below'
        : undefined,
    });

    // Report survivors as individual warnings
    for (const s of survivors.slice(0, 20)) {
      result.addCheck(`mutation:survivor:${s.file}:${s.line}:${s.mutation}`, false, {
        file: s.file,
        line: s.line,
        severity: 'warning',
        message: `${s.description} at line ${s.line} — tests did not catch this`,
        suggestion: `Add a test that would fail when "${s.original}" becomes "${s.mutated}"`,
      });
    }

    if (survivors.length > 20) {
      result.addCheck('mutation:survivors-truncated', true, {
        severity: 'info',
        message: `${survivors.length - 20} more surviving mutants not shown. Run with --verbose for full list.`,
      });
    }

    // Write mutation report
    this._writeReport(projectRoot, { score, killed, survived, totalMutants, threshold, survivors });
  }

  _detectTestCommand(projectRoot) {
    const pkgPath = path.join(projectRoot, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        if (pkg.scripts?.test && !pkg.scripts.test.includes('no test specified')) {
          return 'npm test 2>&1';
        }
      } catch { /* ignore */ }
    }

    const testDirs = ['tests', 'test', '__tests__'];
    for (const dir of testDirs) {
      if (fs.existsSync(path.join(projectRoot, dir))) {
        return 'node --test 2>&1';
      }
    }

    return null;
  }

  _findSourceFiles(projectRoot) {
    const sourceFiles = this._collectFiles(projectRoot, ['.js', '.ts'], [
      'node_modules', '.git', '.claude', 'dist', 'build', 'coverage', '.gatetest',
      '.next', 'website', 'test', 'tests', '__tests__', 'spec',
    ]);

    // Exclude test files and config files
    return sourceFiles.filter(f => {
      const base = path.basename(f);
      return !base.includes('.test.') && !base.includes('.spec.') &&
             !base.includes('.config.') && base !== 'jest.config.js' &&
             !base.startsWith('.');
    });
  }

  _writeReport(projectRoot, data) {
    const reportDir = path.join(projectRoot, '.gatetest', 'reports');
    if (!fs.existsSync(reportDir)) {
      fs.mkdirSync(reportDir, { recursive: true });
    }

    const report = {
      type: 'mutation-testing',
      timestamp: new Date().toISOString(),
      score: data.score,
      threshold: data.threshold,
      mutants: {
        total: data.totalMutants,
        killed: data.killed,
        survived: data.survived,
      },
      survivors: data.survivors,
    };

    fs.writeFileSync(
      path.join(reportDir, 'mutation-report.json'),
      JSON.stringify(report, null, 2)
    );
  }
}

module.exports = MutationModule;
