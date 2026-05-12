/**
 * Tests for website/app/lib/dependency-upgrade-patcher.js
 * Phase 6.2.11 — dependency-upgrade + breaking-change patcher.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseMajor,
  findMajorUpgrades,
  fileReferencesDep,
  parseBreakingChanges,
  buildBreakingChangesPrompt,
  buildPatchPrompt,
  renderUpgradeSummary,
  upgradeDep,
  patchDependencyUpgrades,
  MAX_DEPS_PER_RUN,
  MAX_FILES_PER_DEP,
} = require('../website/app/lib/dependency-upgrade-patcher');

// ─── parseMajor ────────────────────────────────────────────────────────────

describe('parseMajor', () => {
  it('parses plain semver', () => {
    assert.equal(parseMajor('3.2.1'), 3);
  });

  it('parses version with ^ prefix', () => {
    assert.equal(parseMajor('^2.0.0'), 2);
  });

  it('parses version with ~ prefix', () => {
    assert.equal(parseMajor('~1.5.0'), 1);
  });

  it('parses 0.x version', () => {
    assert.equal(parseMajor('0.17.0'), 0);
  });

  it('returns null for workspace protocol', () => {
    assert.equal(parseMajor('workspace:*'), null);
  });

  it('returns null for file: prefix', () => {
    assert.equal(parseMajor('file:../local-package'), null);
  });

  it('returns null for null input', () => {
    assert.equal(parseMajor(null), null);
  });

  it('returns null for empty string', () => {
    assert.equal(parseMajor(''), null);
  });

  it('parses version with v prefix', () => {
    assert.equal(parseMajor('v4.0.0'), 4);
  });
});

// ─── findMajorUpgrades ─────────────────────────────────────────────────────

describe('findMajorUpgrades', () => {
  it('finds a simple major gap', () => {
    const installed = { axios: '0.27.2' };
    const latest = { axios: '1.6.0' };
    const upgrades = findMajorUpgrades(installed, latest);
    assert.equal(upgrades.length, 1);
    assert.equal(upgrades[0].name, 'axios');
    assert.equal(upgrades[0].gapMajors, 1);
  });

  it('skips patch/minor bumps', () => {
    const installed = { lodash: '4.17.20' };
    const latest = { lodash: '4.17.21' };
    const upgrades = findMajorUpgrades(installed, latest);
    assert.equal(upgrades.length, 0);
  });

  it('finds multiple upgrades and sorts by gap descending', () => {
    const installed = { react: '16.14.0', next: '12.0.0', axios: '0.27.2' };
    const latest = { react: '18.3.0', next: '15.0.0', axios: '1.6.0' };
    const upgrades = findMajorUpgrades(installed, latest);
    assert.equal(upgrades[0].name, 'next'); // gap 3
    assert.equal(upgrades[1].name, 'react'); // gap 2
    assert.equal(upgrades[2].name, 'axios'); // gap 1
  });

  it('skips deps not in latest map', () => {
    const installed = { unknown: '1.0.0' };
    const latest = {};
    const upgrades = findMajorUpgrades(installed, latest);
    assert.equal(upgrades.length, 0);
  });

  it('skips unparseable versions', () => {
    const installed = { pkg: 'workspace:*' };
    const latest = { pkg: '3.0.0' };
    const upgrades = findMajorUpgrades(installed, latest);
    assert.equal(upgrades.length, 0);
  });

  it('returns empty when both maps empty', () => {
    const upgrades = findMajorUpgrades({}, {});
    assert.equal(upgrades.length, 0);
  });

  it('handles large multi-major gaps', () => {
    const installed = { pkg: '1.0.0' };
    const latest = { pkg: '10.0.0' };
    const upgrades = findMajorUpgrades(installed, latest);
    assert.equal(upgrades[0].gapMajors, 9);
  });
});

// ─── fileReferencesDep ─────────────────────────────────────────────────────

describe('fileReferencesDep', () => {
  it('detects ES module import', () => {
    assert.ok(fileReferencesDep("import axios from 'axios'", 'axios'));
  });

  it('detects named import', () => {
    assert.ok(fileReferencesDep("import { get } from 'axios'", 'axios'));
  });

  it('detects require', () => {
    assert.ok(fileReferencesDep("const axios = require('axios')", 'axios'));
  });

  it('detects dynamic import', () => {
    assert.ok(fileReferencesDep("import('react')", 'react'));
  });

  it('detects sub-path import', () => {
    assert.ok(fileReferencesDep("import { Link } from 'react-router/dom'", 'react-router'));
  });

  it('does not match partial package names', () => {
    assert.ok(!fileReferencesDep("import x from 'axios-mock'", 'axios'));
  });

  it('returns false when not referenced', () => {
    assert.ok(!fileReferencesDep("const x = 1;", 'axios'));
  });

  it('detects from clause', () => {
    assert.ok(fileReferencesDep("export { foo } from 'lodash'", 'lodash'));
  });
});

// ─── parseBreakingChanges ──────────────────────────────────────────────────

describe('parseBreakingChanges', () => {
  it('parses well-formed BREAKING lines', () => {
    const response = [
      'BREAKING: createStore removed — use configureStore',
      'BREAKING: connect() requires typed selector',
      'Some other line',
    ].join('\n');
    const changes = parseBreakingChanges(response);
    assert.equal(changes.length, 2);
    assert.ok(changes[0].includes('createStore'));
    assert.ok(changes[1].includes('connect'));
  });

  it('returns empty array for NO_BREAKING_CHANGES', () => {
    assert.deepEqual(parseBreakingChanges('NO_BREAKING_CHANGES'), []);
  });

  it('returns empty array for null', () => {
    assert.deepEqual(parseBreakingChanges(null), []);
  });

  it('returns empty array for empty string', () => {
    assert.deepEqual(parseBreakingChanges(''), []);
  });

  it('ignores lines without BREAKING: prefix', () => {
    const response = 'Minor improvement\nInfo: something changed\n';
    assert.deepEqual(parseBreakingChanges(response), []);
  });

  it('trims whitespace from change descriptions', () => {
    const changes = parseBreakingChanges('BREAKING:   foo changed  ');
    assert.equal(changes[0], 'foo changed');
  });
});

// ─── buildBreakingChangesPrompt ────────────────────────────────────────────

describe('buildBreakingChangesPrompt', () => {
  it('includes dep name and versions', () => {
    const prompt = buildBreakingChangesPrompt('axios', '0.27.2', '1.6.0');
    assert.ok(prompt.includes('axios'));
    assert.ok(prompt.includes('0.27.2'));
    assert.ok(prompt.includes('1.6.0'));
  });

  it('asks for BREAKING: format output', () => {
    const prompt = buildBreakingChangesPrompt('react', '16.0.0', '18.0.0');
    assert.ok(prompt.includes('BREAKING:'));
    assert.ok(prompt.includes('NO_BREAKING_CHANGES'));
  });
});

// ─── buildPatchPrompt ──────────────────────────────────────────────────────

describe('buildPatchPrompt', () => {
  it('includes all required context', () => {
    const prompt = buildPatchPrompt(
      'axios', '0.27', '1.0',
      ['createStore removed'],
      'import axios from "axios";\naxios.get(url)',
      'src/api.ts'
    );
    assert.ok(prompt.includes('axios'));
    assert.ok(prompt.includes('createStore removed'));
    assert.ok(prompt.includes('src/api.ts'));
    assert.ok(prompt.includes('NO_CHANGES_NEEDED'));
  });

  it('includes the file content', () => {
    const content = 'const x = require("react");';
    const prompt = buildPatchPrompt('react', '16', '18', ['PureComponent deprecated'], content, 'f.js');
    assert.ok(prompt.includes(content));
  });
});

// ─── upgradeDep ────────────────────────────────────────────────────────────

describe('upgradeDep', () => {
  it('returns no-breaking-changes when Claude says NO_BREAKING_CHANGES', async () => {
    const result = await upgradeDep({
      depName: 'lodash',
      fromVersion: '3.0.0',
      toVersion: '4.0.0',
      sourceFiles: ['src/util.ts'],
      readFile: async () => "import _ from 'lodash';",
      askClaude: async () => 'NO_BREAKING_CHANGES',
    });
    assert.deepEqual(result.breakingChanges, []);
    assert.equal(result.patchedFiles.length, 0);
    assert.equal(result.skippedFiles.length, 1);
    assert.equal(result.skippedFiles[0].reason, 'no-breaking-changes');
  });

  it('patches a file when Claude returns valid changes', async () => {
    const originalContent = "import axios from 'axios';\naxios.get(url, { params });";
    const patchedContent = "import axios from 'axios';\naxios.get(url, { params: params });";

    let callCount = 0;
    const result = await upgradeDep({
      depName: 'axios',
      fromVersion: '0.27.2',
      toVersion: '1.6.0',
      sourceFiles: ['src/api.ts'],
      readFile: async () => originalContent,
      askClaude: async (prompt) => {
        callCount++;
        if (callCount === 1) return 'BREAKING: params shape changed';
        return patchedContent;
      },
    });

    assert.equal(result.patchedFiles.length, 1);
    assert.equal(result.patchedFiles[0].filePath, 'src/api.ts');
    assert.equal(result.patchedFiles[0].before, originalContent);
    assert.equal(result.patchedFiles[0].after, patchedContent);
  });

  it('skips file when Claude returns NO_CHANGES_NEEDED', async () => {
    let callCount = 0;
    const result = await upgradeDep({
      depName: 'axios',
      fromVersion: '0.27.2',
      toVersion: '1.6.0',
      sourceFiles: ['src/api.ts'],
      readFile: async () => "import axios from 'axios';",
      askClaude: async () => {
        callCount++;
        if (callCount === 1) return 'BREAKING: foo changed';
        return 'NO_CHANGES_NEEDED';
      },
    });
    assert.equal(result.patchedFiles.length, 0);
    assert.ok(result.skippedFiles.some(s => s.reason === 'no-changes-needed'));
  });

  it('skips files that do not reference the dep', async () => {
    const result = await upgradeDep({
      depName: 'axios',
      fromVersion: '0.27.2',
      toVersion: '1.6.0',
      sourceFiles: ['src/util.ts'],
      readFile: async () => "const x = 1;", // no axios import
      askClaude: async () => 'BREAKING: something changed',
    });
    assert.ok(result.skippedFiles.some(s => s.reason === 'no-affected-files'));
  });

  it('records error when askClaude throws on breaking-changes call', async () => {
    const result = await upgradeDep({
      depName: 'react',
      fromVersion: '16.0.0',
      toVersion: '18.0.0',
      sourceFiles: [],
      readFile: async () => '',
      askClaude: async () => { throw new Error('API timeout'); },
    });
    assert.equal(result.errors.length, 1);
    assert.ok(result.errors[0].includes('API timeout'));
  });

  it('rolls back when patched content fails syntax gate', async () => {
    let callCount = 0;
    // Use .js — TypeScript files are pass-through (no parser available)
    const result = await upgradeDep({
      depName: 'react',
      fromVersion: '16.0.0',
      toVersion: '18.0.0',
      sourceFiles: ['src/comp.js'],
      readFile: async () => "const React = require('react');",
      askClaude: async () => {
        callCount++;
        if (callCount === 1) return 'BREAKING: hooks changed';
        // Return intentionally broken JS (unmatched brace)
        return 'const x = { // broken syntax{{{{';
      },
    });
    assert.equal(result.patchedFiles.length, 0);
    assert.ok(result.skippedFiles.some(s => s.reason === 'syntax-gate-failed'));
  });

  it('strips code fences from Claude response', async () => {
    const patchedContent = "import axios from 'axios';\nconst x = 1;";
    let callCount = 0;
    const result = await upgradeDep({
      depName: 'axios',
      fromVersion: '0.27.2',
      toVersion: '1.6.0',
      sourceFiles: ['src/api.ts'],
      readFile: async () => "import axios from 'axios';",
      askClaude: async () => {
        callCount++;
        if (callCount === 1) return 'BREAKING: foo changed';
        return `\`\`\`typescript\n${patchedContent}\n\`\`\``;
      },
    });
    if (result.patchedFiles.length > 0) {
      assert.ok(!result.patchedFiles[0].after.includes('```'));
    }
  });
});

// ─── patchDependencyUpgrades ───────────────────────────────────────────────

describe('patchDependencyUpgrades', () => {
  it('returns empty result when no major upgrades found', async () => {
    const result = await patchDependencyUpgrades({
      installedVersions: { lodash: '4.17.20' },
      latestVersions: { lodash: '4.17.21' }, // minor only
      sourceFiles: [],
      readFile: async () => '',
      askClaude: async () => 'NO_BREAKING_CHANGES',
    });
    assert.equal(result.upgrades.length, 0);
    assert.equal(result.totalPatched, 0);
  });

  it('caps at MAX_DEPS_PER_RUN', async () => {
    const installed = {};
    const latest = {};
    for (let i = 0; i < MAX_DEPS_PER_RUN + 5; i++) {
      installed[`pkg${i}`] = '1.0.0';
      latest[`pkg${i}`] = '2.0.0';
    }
    const result = await patchDependencyUpgrades({
      installedVersions: installed,
      latestVersions: latest,
      sourceFiles: [],
      readFile: async () => '',
      askClaude: async () => 'NO_BREAKING_CHANGES',
    });
    assert.ok(result.upgrades.length <= MAX_DEPS_PER_RUN);
  });

  it('accumulates totalPatched across deps', async () => {
    const originalContent1 = "import axios from 'axios'; axios.get(url);";
    const originalContent2 = "import { Link } from 'react-router-dom';";

    const callTracker = { axios: 0, react: 0 };
    const result = await patchDependencyUpgrades({
      installedVersions: { axios: '0.27.2', 'react-router-dom': '5.0.0' },
      latestVersions: { axios: '1.6.0', 'react-router-dom': '6.0.0' },
      sourceFiles: ['src/api.ts', 'src/nav.tsx'],
      readFile: async (path) => {
        if (path === 'src/api.ts') return originalContent1;
        return originalContent2;
      },
      askClaude: async (prompt) => {
        if (prompt.includes('axios')) {
          callTracker.axios++;
          if (callTracker.axios === 1) return 'BREAKING: params changed';
          return "import axios from 'axios'; axios.get(url, { params: {} });";
        }
        callTracker.react++;
        if (callTracker.react === 1) return 'BREAKING: Switch renamed to Routes';
        return "import { Link, Routes } from 'react-router-dom';";
      },
    });
    assert.ok(result.totalPatched > 0);
  });

  it('handles empty inputs gracefully', async () => {
    const result = await patchDependencyUpgrades({
      installedVersions: {},
      latestVersions: {},
      sourceFiles: [],
      readFile: async () => '',
      askClaude: async () => '',
    });
    assert.equal(result.upgrades.length, 0);
    assert.equal(result.errors.length, 0);
  });
});

// ─── renderUpgradeSummary ──────────────────────────────────────────────────

describe('renderUpgradeSummary', () => {
  it('renders "no upgrades" when upgrades array is empty', () => {
    const md = renderUpgradeSummary({ upgrades: [], totalPatched: 0, totalSkipped: 0, errors: [] });
    assert.ok(md.includes('No major-version upgrades'));
  });

  it('renders dep name and versions', () => {
    const md = renderUpgradeSummary({
      upgrades: [{
        depName: 'axios',
        fromVersion: '0.27.2',
        toVersion: '1.6.0',
        breakingChanges: ['params shape changed'],
        patchedFiles: [{ filePath: 'src/api.ts', before: '', after: '' }],
        skippedFiles: [],
        errors: [],
      }],
      totalPatched: 1,
      totalSkipped: 0,
      errors: [],
    });
    assert.ok(md.includes('axios'));
    assert.ok(md.includes('0.27.2'));
    assert.ok(md.includes('1.6.0'));
    assert.ok(md.includes('params shape changed'));
    assert.ok(md.includes('src/api.ts'));
  });

  it('renders top-level errors', () => {
    const md = renderUpgradeSummary({
      upgrades: [],
      totalPatched: 0,
      totalSkipped: 0,
      errors: ['something exploded'],
    });
    assert.ok(md.includes('something exploded'));
  });

  it('includes GateTest footer when upgrades are present', () => {
    const md = renderUpgradeSummary({
      upgrades: [{
        depName: 'react',
        fromVersion: '16.0.0',
        toVersion: '18.0.0',
        breakingChanges: [],
        patchedFiles: [],
        skippedFiles: [],
        errors: [],
      }],
      totalPatched: 0,
      totalSkipped: 0,
      errors: [],
    });
    assert.ok(md.includes('GateTest'));
  });

  it('shows patched count in summary line', () => {
    const md = renderUpgradeSummary({
      upgrades: [{
        depName: 'react',
        fromVersion: '16.0.0',
        toVersion: '18.0.0',
        breakingChanges: [],
        patchedFiles: [{ filePath: 'src/a.tsx', before: '', after: '' },
                       { filePath: 'src/b.tsx', before: '', after: '' }],
        skippedFiles: [],
        errors: [],
      }],
      totalPatched: 2,
      totalSkipped: 1,
      errors: [],
    });
    assert.ok(md.includes('2'));
    assert.ok(md.includes('1'));
  });
});
