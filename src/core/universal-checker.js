/**
 * Universal Checker — pattern-based cross-language issue detector.
 *
 * Powers GateTest's non-JS language modules (Python, Go, Rust, Java,
 * Ruby, PHP, C#, Kotlin, Swift). Zero-dependency, regex-based, fast.
 *
 * Philosophy: catch REAL issues (security holes, bugs, swallowed errors,
 * force unwraps, hardcoded secrets), not style preferences. GateTest is
 * not a linter — deep per-language lint is a separate (optional) native-
 * tool integration for later.
 *
 * Patterns are intentionally conservative. A false positive here damages
 * trust more than a missed issue. Memory-driven agentic exploration is
 * the layer that catches the subtle ones.
 *
 * TODO(gluecron): once Gluecron exposes language metadata, prefer that
 * signal over file extension sniffing.
 */

const fs = require('fs');
const path = require('path');

/**
 * Skip these files & directories entirely.
 */
const DEFAULT_EXCLUDES = [
  'node_modules', '.git', 'dist', 'build', 'coverage', '.gatetest',
  '.next', '__pycache__', '.venv', 'venv', 'target', 'vendor', '.gradle',
  '.dart_tool', 'Pods', '.mypy_cache', '.pytest_cache',
];

/**
 * Patterns are applied per line. Comments that look like examples are
 * stripped before matching to minimise false positives.
 */
const LANGUAGE_SPECS = {
  python: {
    name: 'python',
    displayName: 'Python',
    extensions: ['.py'],
    testFilePattern: /(^|\/)(test_|.*_test)\.py$|(^|\/)tests?\//i,
    patterns: [
      { name: 'eval', pattern: /\beval\s*\(/, severity: 'error',
        message: 'eval() — arbitrary code execution risk',
        suggestion: 'Use ast.literal_eval for literals, or refactor to avoid eval entirely.' },
      { name: 'exec', pattern: /\bexec\s*\(/, severity: 'error',
        message: 'exec() — arbitrary code execution risk',
        suggestion: 'Refactor to call the target function directly. Exec is rarely needed.' },
      { name: 'bare-except', pattern: /^\s*except\s*:/, severity: 'warning',
        message: 'bare except swallows all exceptions including SystemExit and KeyboardInterrupt',
        suggestion: 'Catch a specific exception class, e.g. `except ValueError:`' },
      { name: 'mutable-default', pattern: /def\s+\w+\s*\([^)]*=\s*(\[\]|\{\})/, severity: 'warning',
        message: 'Mutable default argument — shared across calls, common bug source',
        suggestion: 'Use `None` as the default and construct the mutable inside the function.' },
      { name: 'sql-concat', pattern: /(execute|query|cursor\.execute)\s*\(\s*["'].*(\+|%|\.format|f["'])/, severity: 'error',
        message: 'Likely SQL string concatenation — SQL injection risk',
        suggestion: 'Use parameterised queries: cursor.execute(sql, params).' },
      { name: 'pickle-load', pattern: /\bpickle\.loads?\s*\(/, severity: 'warning',
        message: 'pickle.load on untrusted input = RCE',
        suggestion: 'Use json, or validate the pickle source cryptographically.' },
    ],
  },

  go: {
    name: 'go',
    displayName: 'Go',
    extensions: ['.go'],
    testFilePattern: /_test\.go$/,
    patterns: [
      { name: 'ignored-error', pattern: /^\s*_\s*,\s*_\s*:?=\s/, severity: 'warning',
        message: 'Both return values discarded — likely ignored error',
        suggestion: 'Check the error return, even if only to log it.' },
      { name: 'fmt-println-lib', pattern: /^\s*fmt\.Println\s*\(/, severity: 'info',
        message: 'fmt.Println in source — consider structured logging',
        suggestion: 'Use log package or a structured logger for anything beyond main().' },
      { name: 'panic-in-lib', pattern: /^\s*panic\s*\(/, severity: 'warning',
        message: 'panic() call — library code should return errors, not panic',
        suggestion: 'Return an error value. Reserve panic for truly unrecoverable conditions.' },
      { name: 'goroutine-wait-missing', pattern: /^\s*go\s+func\s*\(/, severity: 'info',
        message: 'Goroutine launched — verify its lifetime is bounded (context, WaitGroup, or channel)',
        suggestion: 'Ensure the goroutine cannot outlive its caller uncontrollably.' },
    ],
  },

  rust: {
    name: 'rust',
    displayName: 'Rust',
    extensions: ['.rs'],
    testFilePattern: /(^|\/)tests\/|#\[test\]|#\[cfg\(test\)\]/,
    patterns: [
      { name: 'unwrap', pattern: /\.unwrap\s*\(\s*\)/, severity: 'warning',
        message: '.unwrap() panics on error — production code should handle Result explicitly',
        suggestion: 'Use ? for propagation, .expect("context") for clarity, or a proper match.' },
      { name: 'panic-macro', pattern: /\bpanic!\s*\(/, severity: 'warning',
        message: 'panic!() in source — crashes the process',
        suggestion: 'Return a Result<T, E> with a meaningful error.' },
      { name: 'todo-macro', pattern: /\btodo!\s*\(\s*\)/, severity: 'error',
        message: 'todo!() placeholder left in code — will panic at runtime',
        suggestion: 'Replace with real implementation before merging.' },
      { name: 'unimplemented', pattern: /\bunimplemented!\s*\(\s*\)/, severity: 'error',
        message: 'unimplemented!() left in code — runtime panic',
        suggestion: 'Implement, or return an explicit error.' },
      { name: 'unsafe-block', pattern: /\bunsafe\s*\{/, severity: 'info',
        message: 'unsafe block — verify invariants are documented',
        suggestion: 'Add // SAFETY: comment describing why this block is sound.' },
    ],
  },

  java: {
    name: 'java',
    displayName: 'Java',
    extensions: ['.java'],
    testFilePattern: /(^|\/)(test|Test)\/|Test\.java$|Tests\.java$/,
    patterns: [
      { name: 'sysout', pattern: /^\s*System\.out\.print(ln)?\s*\(/, severity: 'info',
        message: 'System.out in source — use a logger',
        suggestion: 'Replace with SLF4J / java.util.logging.' },
      { name: 'catch-exception', pattern: /catch\s*\(\s*Exception\s+\w+\s*\)/, severity: 'warning',
        message: 'catch (Exception e) swallows too broadly — catches RuntimeExceptions unintentionally',
        suggestion: 'Catch specific exception classes. If truly needed, comment why Exception is correct.' },
      { name: 'empty-catch', pattern: /catch\s*\([^)]+\)\s*\{\s*\}/, severity: 'error',
        message: 'Empty catch block silently swallows errors',
        suggestion: 'At minimum log the exception. Re-throw if the caller should know.' },
      { name: 'printstacktrace', pattern: /\.printStackTrace\s*\(\s*\)/, severity: 'warning',
        message: 'e.printStackTrace() writes to stderr without context',
        suggestion: 'Use a logger: log.error("context", e).' },
    ],
  },

  ruby: {
    name: 'ruby',
    displayName: 'Ruby',
    extensions: ['.rb'],
    testFilePattern: /(^|\/)(spec|test)\/|_(spec|test)\.rb$/,
    patterns: [
      { name: 'eval', pattern: /\beval\s*\(?\s*['"]/, severity: 'error',
        message: 'eval() of string literal — arbitrary code execution risk',
        suggestion: 'Refactor to call the target method directly.' },
      { name: 'system-interp', pattern: /(system|`|exec)\s*\(?\s*["'][^"']*#\{/, severity: 'error',
        message: 'Shell command with string interpolation — command injection risk',
        suggestion: 'Use the array form: system("cmd", arg1, arg2) to avoid shell parsing.' },
      { name: 'rescue-all', pattern: /^\s*rescue\s*(=>|\n|$)/, severity: 'warning',
        message: 'rescue without a class catches StandardError silently',
        suggestion: 'Rescue a specific exception, e.g. `rescue ArgumentError => e`.' },
      { name: 'puts-in-lib', pattern: /^\s*puts\s+/, severity: 'info',
        message: 'puts in source — consider Rails.logger / a proper logger',
        suggestion: 'Replace with Rails.logger.info or equivalent.' },
    ],
  },

  php: {
    name: 'php',
    displayName: 'PHP',
    extensions: ['.php'],
    testFilePattern: /Test\.php$|(^|\/)tests?\//i,
    patterns: [
      { name: 'eval', pattern: /\beval\s*\(/, severity: 'error',
        message: 'eval() in PHP — arbitrary code execution',
        suggestion: 'Refactor. eval is almost never the right answer.' },
      { name: 'mysql-legacy', pattern: /\bmysql_(query|connect|fetch_)/, severity: 'error',
        message: 'mysql_* functions removed in PHP 7',
        suggestion: 'Migrate to mysqli or PDO with prepared statements.' },
      { name: 'unescaped-super', pattern: /(echo|print)\s+\$(_GET|_POST|_REQUEST|_COOKIE)\[/, severity: 'error',
        message: 'Unescaped superglobal output — XSS risk',
        suggestion: 'htmlspecialchars($var, ENT_QUOTES, "UTF-8") before echoing.' },
      { name: 'var-dump', pattern: /^\s*(var_dump|print_r)\s*\(/, severity: 'warning',
        message: 'var_dump / print_r left in code',
        suggestion: 'Remove before shipping, or use a proper logger.' },
    ],
  },

  csharp: {
    name: 'csharp',
    displayName: 'C#',
    extensions: ['.cs'],
    testFilePattern: /Test(s)?\.cs$|(^|\/)(test|tests)\//i,
    patterns: [
      { name: 'console-writeline', pattern: /^\s*Console\.WriteLine\s*\(/, severity: 'info',
        message: 'Console.WriteLine in library code — use a logger',
        suggestion: 'Use ILogger / Serilog / NLog for structured logs.' },
      { name: 'catch-all', pattern: /catch\s*(\(\s*Exception[^)]*\))?\s*\{\s*\}/, severity: 'error',
        message: 'Empty catch — silently swallows errors',
        suggestion: 'Log, re-throw, or handle explicitly. Never swallow.' },
      { name: 'catch-exception', pattern: /catch\s*\(\s*Exception\s+\w+\s*\)/, severity: 'warning',
        message: 'catch (Exception) — too broad',
        suggestion: 'Catch specific exception types.' },
    ],
  },

  kotlin: {
    name: 'kotlin',
    displayName: 'Kotlin',
    extensions: ['.kt', '.kts'],
    testFilePattern: /Test\.kts?$|(^|\/)test\//i,
    patterns: [
      { name: 'not-null-assert', pattern: /!!(?![!=])/, severity: 'warning',
        message: '!! (not-null assertion) throws NullPointerException — defeats Kotlin null safety',
        suggestion: 'Use ?.let { }, ?: (Elvis), or handle null explicitly.' },
      { name: 'println-in-lib', pattern: /^\s*println\s*\(/, severity: 'info',
        message: 'println in source — use a logger',
        suggestion: 'Use SLF4J or a Kotlin logging library.' },
      { name: 'todo-call', pattern: /\bTODO\s*\([^)]*\)/, severity: 'error',
        message: 'TODO() placeholder left in code — throws NotImplementedError at runtime',
        suggestion: 'Replace with real implementation before merge.' },
    ],
  },

  swift: {
    name: 'swift',
    displayName: 'Swift',
    extensions: ['.swift'],
    testFilePattern: /Tests?\.swift$|(^|\/)Tests?\//,
    patterns: [
      { name: 'fatal-error', pattern: /\bfatalError\s*\(/, severity: 'warning',
        message: 'fatalError crashes the app — use only for truly unrecoverable states',
        suggestion: 'Return an optional, throw, or degrade gracefully.' },
      { name: 'force-try', pattern: /\btry!\s/, severity: 'warning',
        message: 'try! crashes on error — handle with do/catch or try?',
        suggestion: 'Use do { try ... } catch { ... } or try? for optional handling.' },
      { name: 'force-unwrap', pattern: /!\s*(\.|\)|$|,)/, severity: 'info',
        message: 'Force-unwrap — verify the value cannot be nil',
        suggestion: 'Use if-let, guard-let, or the nil-coalescing operator.' },
      { name: 'print-in-lib', pattern: /^\s*print\s*\(/, severity: 'info',
        message: 'print() in source — consider os_log or a logger',
        suggestion: 'Use Logger (Apple Unified Logging) for production code.' },
    ],
  },
};

/**
 * Run universal pattern checks for a given language against a project.
 * Adds checks to the `result` object; returns a small stat block.
 */
function runLanguageChecks(lang, projectRoot, result, options = {}) {
  const spec = LANGUAGE_SPECS[lang];
  if (!spec) {
    result.addCheck(`${lang}:unknown-language`, false, {
      severity: 'warning',
      message: `Unknown language key: ${lang}`,
    });
    return { filesScanned: 0, issuesFound: 0 };
  }

  let files = collectLanguageFiles(projectRoot, spec.extensions);

  // Incremental scan support: if the runner passed a `_incrementalFiles`
  // Set on the config, narrow the file list to only the files that
  // changed since the base ref. The Set holds absolute paths; the walker
  // returns absolute paths too, so set membership is direct.
  const incremental = options && options.incrementalFiles;
  if (incremental && typeof incremental.has === 'function' && incremental.size > 0) {
    files = files.filter((abs) => incremental.has(path.resolve(abs)));
  }

  if (files.length === 0) {
    result.addCheck(`${lang}:no-files`, true, {
      severity: 'info',
      message: incremental
        ? `No ${spec.displayName} files changed since base ref`
        : `No ${spec.displayName} files found in project`,
    });
    return { filesScanned: 0, issuesFound: 0 };
  }

  let issuesFound = 0;
  let filesScanned = 0;

  for (const file of files) {
    // Normalize backslashes to forward-slash so the testFilePattern regexes
    // (which use `/` literally) match identically on Windows.
    const isTest = spec.testFilePattern && spec.testFilePattern.test(file.split(path.sep).join('/'));
    let content;
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    filesScanned += 1;

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      // Skip obvious comments and string-only lines where heuristics often
      // fire false positives. This is intentional: we prefer missing a
      // genuine issue to burning trust on a bad warning.
      if (isLikelyCommentOrFixture(line, spec)) continue;

      for (const p of spec.patterns) {
        // For test files, downgrade info/warning patterns to info to reduce noise.
        let severity = p.severity;
        if (isTest && severity !== 'error') severity = 'info';
        if (!p.pattern.test(line)) continue;

        const relPath = path.relative(projectRoot, file);
        const passed = severity === 'info';
        result.addCheck(`${lang}:${p.name}:${relPath}:${i + 1}`, passed, {
          severity,
          file: relPath,
          line: i + 1,
          message: `[${spec.displayName}] ${p.message}`,
          suggestion: p.suggestion,
        });
        if (!passed) issuesFound += 1;
      }
    }
  }

  result.addCheck(`${lang}:summary`, true, {
    severity: 'info',
    message: `${spec.displayName}: scanned ${filesScanned} file(s), ${issuesFound} issue(s) found`,
  });

  return { filesScanned, issuesFound };
}

function collectLanguageFiles(projectRoot, extensions) {
  const files = [];
  const extSet = new Set(extensions.map((e) => e.toLowerCase()));

  const walk = (dir, depth = 0) => {
    if (depth > 10) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (DEFAULT_EXCLUDES.includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile() && extSet.has(path.extname(entry.name).toLowerCase())) {
        files.push(full);
      }
    }
  };

  walk(projectRoot);
  return files;
}

function isLikelyCommentOrFixture(line, spec) {
  const t = line.trim();
  if (!t) return true;
  // Common comment leaders across the supported languages.
  if (t.startsWith('//') || t.startsWith('#') || t.startsWith('*')) return true;
  // Python docstring lines (rough heuristic).
  if (spec.name === 'python' && (t.startsWith('"""') || t.startsWith("'''"))) return true;
  return false;
}

module.exports = {
  LANGUAGE_SPECS,
  runLanguageChecks,
  collectLanguageFiles,
};
