#!/usr/bin/env node
// Prepublish gate. Cross-platform replacement for the previous shell-pipe
// version which used `>/dev/null` (works on macOS/Linux, breaks on Windows
// CMD/PowerShell where `/dev/null` doesn't exist as a path).
//
// Two checks:
//   1. All 90 modules load without error (`gatetest --list`).
//   2. The full test suite passes (`node --test tests/*.test.js`).
//
// Module-list output is suppressed (only the exit code matters); test
// output streams to the terminal so failures are visible.

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function step(name, args, opts = {}) {
  const r = spawnSync(process.execPath, args, {
    cwd: root,
    stdio: opts.silent ? 'ignore' : 'inherit',
    shell: false,
  });
  if (r.status !== 0) {
    process.stderr.write(`prepublish-check: ${name} failed (exit ${r.status}).\n`);
    process.exit(r.status ?? 1);
  }
}

step('module load', ['bin/gatetest.js', '--list'], { silent: true });

const testFiles = readdirSync(join(root, 'tests'))
  .filter((f) => f.endsWith('.test.js'))
  .map((f) => join('tests', f));

step('test suite', ['--test', ...testFiles]);
