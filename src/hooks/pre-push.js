#!/usr/bin/env node

/**
 * GateTest Pre-Push Hook
 * Runs the full test suite before allowing a push to remote.
 * Nothing hits the remote unless every check passes.
 */

const path = require('path');

const projectRoot = path.resolve(__dirname, '../../');

async function prePush() {
  console.log('[GateTest] Running pre-push gate checks...\n');

  try {
    const { GateTest } = require('../index');
    const gatetest = new GateTest(projectRoot);
    gatetest.init();

    // Validate CLAUDE.md first
    const validation = gatetest.validateClaudeMd();
    if (!validation.valid) {
      console.error('[GateTest] CLAUDE.md validation failed:');
      for (const issue of validation.issues) {
        console.error(`  - ${issue}`);
      }
      console.error('\nFix CLAUDE.md issues before pushing.\n');
      process.exit(1);
    }

    // Run full test suite
    const summary = await gatetest.runSuite('full');

    if (summary.gateStatus === 'BLOCKED') {
      console.error('\n[GateTest] GATE BLOCKED — Push denied.');
      console.error('Fix all failing checks before pushing.\n');
      process.exit(1);
    }

    console.log('\n[GateTest] All gates passed. Push allowed.\n');
    process.exit(0);
  } catch (err) {
    console.error(`[GateTest] Gate check error: ${err.message}`);
    console.error('Push blocked due to gate check failure.\n');
    process.exit(1);
  }
}

prePush().catch(err => {
  console.error(`[GateTest] Hook error: ${err.message}`);
  process.exit(1);
});
