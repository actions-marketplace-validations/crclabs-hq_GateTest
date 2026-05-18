/**
 * Tests for action.yml — the composite GitHub Action manifest at the repo
 * root. Verifies the file parses as YAML, declares the inputs/outputs the
 * marketplace listing promises, and that every declared input is actually
 * used (and every declared output is actually written via $GITHUB_OUTPUT).
 *
 * No new dependencies — uses a minimal YAML parser tailored to the subset
 * action.yml uses (top-level keys, two-space indentation, simple scalars
 * and nested maps). The full spec is overkill for this file.
 */

'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');

const ACTION_YML_PATH = path.resolve(__dirname, '..', 'action.yml');
const RAW             = fs.readFileSync(ACTION_YML_PATH, 'utf8');

// ── Minimal YAML parser ─────────────────────────────────────────────────────
// Handles the subset our action.yml uses: indent-based maps, scalar values
// (string / number / boolean), and the run.steps list-of-maps form. Strips
// comments and trims surrounding quotes. NOT a general YAML parser.

function parseMinimalYaml(text) {
  const root = {};
  const stack = [{ indent: -1, node: root, isList: false }];

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    // Drop comment + blank lines.
    if (/^\s*#/.test(rawLine) || /^\s*$/.test(rawLine)) continue;

    // Strip trailing comments that follow a value.
    const noComment = rawLine.replace(/\s+#.*$/, '');
    const indent = noComment.match(/^(\s*)/)[1].length;
    const content = noComment.slice(indent);

    // Pop the stack to the parent of this line.
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1];

    // List entry — `- ` prefix. Each list entry of a map opens a new map.
    if (content.startsWith('- ')) {
      const itemBody = content.slice(2);
      if (!Array.isArray(parent.node)) {
        // Convert parent into an array — this only happens for steps:.
        // The parent stored as a placeholder gets swapped at write time.
        throw new Error(`unexpected list entry at line ${i + 1}: parent is not array`);
      }
      const obj = {};
      parent.node.push(obj);
      // The inline `key: value` after `- ` belongs to the new object.
      const m = itemBody.match(/^([^:]+):\s*(.*)$/);
      if (m) {
        obj[m[1].trim()] = unquote(m[2]);
      }
      stack.push({ indent, node: obj, isList: false });
      continue;
    }

    // `key:` or `key: value`.
    const kvMatch = content.match(/^([^:]+):\s*(.*)$/);
    if (!kvMatch) continue;
    const key = kvMatch[1].trim();
    const valuePart = kvMatch[2];

    if (valuePart === '' || valuePart === undefined) {
      // Open a nested structure. Decide list vs map from the NEXT
      // non-blank/non-comment line.
      const next = peekNextNonBlank(lines, i + 1);
      if (next && /^\s*-\s/.test(next)) {
        const arr = [];
        parent.node[key] = arr;
        stack.push({ indent, node: arr, isList: true });
      } else {
        const obj = {};
        parent.node[key] = obj;
        stack.push({ indent, node: obj, isList: false });
      }
    } else {
      parent.node[key] = unquote(valuePart);
    }
  }
  return root;
}

function peekNextNonBlank(lines, fromIdx) {
  for (let j = fromIdx; j < lines.length; j++) {
    const l = lines[j];
    if (/^\s*#/.test(l) || /^\s*$/.test(l)) continue;
    return l;
  }
  return null;
}

function unquote(v) {
  if (v === undefined || v === null) return v;
  const trimmed = String(v).trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last  = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

// Parse once at module load so each test below stays focused.
const parsed = parseMinimalYaml(RAW);

// ── Tests ───────────────────────────────────────────────────────────────────

test('action.yml exists at repo root', () => {
  assert.ok(fs.existsSync(ACTION_YML_PATH), 'action.yml must live at the repo root (GitHub requirement).');
});

test('action.yml parses as YAML and has the required top-level keys', () => {
  assert.ok(parsed.name,        'top-level "name" is required');
  assert.ok(parsed.description, 'top-level "description" is required');
  assert.ok(parsed.branding,    'top-level "branding" is required');
  assert.ok(parsed.inputs,      'top-level "inputs" is required');
  assert.ok(parsed.outputs,     'top-level "outputs" is required');
  assert.ok(parsed.runs,        'top-level "runs" is required');
});

test('action.yml declares the composite action shape', () => {
  assert.equal(parsed.runs.using, 'composite', 'runs.using must be "composite"');
  assert.ok(Array.isArray(parsed.runs.steps), 'runs.steps must be a list');
  assert.ok(parsed.runs.steps.length >= 3, 'expected at least 3 composite steps (setup + gate + enforce)');
});

test('action.yml branding has the required icon + color', () => {
  assert.equal(parsed.branding.icon, 'shield', 'branding.icon must be "shield"');
  assert.equal(parsed.branding.color, 'purple', 'branding.color must be "purple"');
});

test('action.yml declares every required input with a default', () => {
  const required = ['suite', 'auto-fix', 'node-version', 'working-directory', 'report-format', 'fail-on-warning'];
  for (const name of required) {
    assert.ok(parsed.inputs[name], `input "${name}" must be declared`);
    assert.ok(parsed.inputs[name].description, `input "${name}" must have a description`);
    assert.ok(
      Object.prototype.hasOwnProperty.call(parsed.inputs[name], 'default'),
      `input "${name}" must have a default`
    );
  }
});

test('action.yml input defaults match the documented values', () => {
  assert.equal(parsed.inputs.suite.default,             'quick');
  assert.equal(parsed.inputs['auto-fix'].default,       'false');
  assert.equal(parsed.inputs['node-version'].default,   '22');
  assert.equal(parsed.inputs['working-directory'].default, '.');
  assert.equal(parsed.inputs['report-format'].default,  'console');
  assert.equal(parsed.inputs['fail-on-warning'].default, 'false');
});

test('action.yml declares every required output with a value expression', () => {
  const required = ['gate-status', 'error-count', 'warning-count', 'report-path'];
  for (const name of required) {
    assert.ok(parsed.outputs[name], `output "${name}" must be declared`);
    assert.ok(parsed.outputs[name].description, `output "${name}" must have a description`);
    assert.ok(parsed.outputs[name].value, `output "${name}" must have a value expression`);
    assert.match(
      parsed.outputs[name].value,
      /\$\{\{\s*steps\.[a-z-]+\.outputs\.[a-z-]+\s*\}\}/i,
      `output "${name}" must read from a step output`
    );
  }
});

test('every declared input is referenced at least once in the steps', () => {
  const names = Object.keys(parsed.inputs);
  for (const name of names) {
    // Inputs are referenced in the raw YAML as ${{ inputs.<name> }} or
    // similar (e.g. ${{ inputs.auto-fix == 'true' }}). The minimal parser
    // loses some expression bodies, so we grep the raw text — that is the
    // authoritative source anyway.
    const pattern = new RegExp(`inputs\\.${name.replace(/[-]/g, '[-]')}\\b`);
    assert.match(RAW, pattern, `input "${name}" must be referenced in the steps`);
  }
});

test('every declared output is written via $GITHUB_OUTPUT in some step', () => {
  const names = Object.keys(parsed.outputs);
  for (const name of names) {
    const pattern = new RegExp(`${name.replace(/[-]/g, '[-]')}=[^\\n]+>>\\s*"?\\$GITHUB_OUTPUT`);
    assert.match(RAW, pattern, `output "${name}" must be written to $GITHUB_OUTPUT in a step`);
  }
});

test('every composite step uses shell: bash (or a uses: action)', () => {
  for (const step of parsed.runs.steps) {
    const hasShell = step.shell === 'bash';
    const hasUses  = typeof step.uses === 'string' && step.uses.length > 0;
    assert.ok(
      hasShell || hasUses,
      `step "${step.name || '(unnamed)'}" must declare either shell: bash or uses: <action>`
    );
  }
});

test('action.yml invokes the GateTest CLI', () => {
  assert.match(RAW, /GATETEST_BIN/, 'action.yml must define a GATETEST_BIN env var');
  assert.match(RAW, /--suite\s+["']?\$\{\{\s*inputs\.suite\s*\}\}/, 'action.yml must pass the suite input through to the gatetest CLI');
});

test('action.yml wires the AI auto-repair step behind both auto-fix and ANTHROPIC_API_KEY', () => {
  // Auto-repair step must guard on both the auto-fix input AND the gate
  // being blocked, AND must check for the Anthropic key before spending.
  assert.match(RAW, /inputs\.auto-fix\s*==\s*['"]true['"]/, 'auto-repair must guard on inputs.auto-fix == "true"');
  assert.match(RAW, /steps\.gate\.outputs\.gate-status\s*==\s*['"]blocked['"]/, 'auto-repair must only run when gate-status is "blocked"');
  assert.match(RAW, /ANTHROPIC_API_KEY/, 'auto-repair must reference ANTHROPIC_API_KEY');
});

test('action.yml never soft-fails the gate (Bible Forbidden #24)', () => {
  // The composite action MUST NOT contain `continue-on-error: true` on the
  // gate step itself. Re-running for a clean test surface keeps this honest.
  const gateBlock = RAW.match(/- name: Run GateTest gate[\s\S]+?(?=\n    - name:|\n    - id:|$)/);
  assert.ok(gateBlock, 'expected a "Run GateTest gate" step in the composite action');
  assert.doesNotMatch(
    gateBlock[0],
    /continue-on-error:\s*true/i,
    'the gate step MUST NOT use continue-on-error: true (Bible Forbidden #24)'
  );
});

// ── Mutation + chaos inputs (Nuclear-tier deliverables via the Action) ──────

test('action.yml declares the mutation, chaos, chaos-url inputs with defaults', () => {
  const required = ['mutation', 'chaos', 'chaos-url', 'mutation-blocks-merge', 'chaos-blocks-merge'];
  for (const name of required) {
    assert.ok(parsed.inputs[name], `input "${name}" must be declared`);
    assert.ok(parsed.inputs[name].description, `input "${name}" must have a description`);
    assert.ok(
      Object.prototype.hasOwnProperty.call(parsed.inputs[name], 'default'),
      `input "${name}" must have a default`
    );
  }
});

test('action.yml mutation/chaos inputs default to off so they never cost customers unintentionally', () => {
  assert.equal(parsed.inputs.mutation.default, 'false', 'mutation default must be "false"');
  assert.equal(parsed.inputs.chaos.default, 'false', 'chaos default must be "false"');
  assert.equal(parsed.inputs['chaos-url'].default, '', 'chaos-url default must be empty');
  assert.equal(parsed.inputs['mutation-blocks-merge'].default, 'false');
  assert.equal(parsed.inputs['chaos-blocks-merge'].default, 'false');
});

test('action.yml has a mutation step conditional on inputs.mutation == "true"', () => {
  // Find the mutation step block in the raw text — match by step name then
  // grab everything up to the next step header.
  const step = RAW.match(/- name: Mutation testing[\s\S]+?(?=\n    - name:|$)/);
  assert.ok(step, 'expected a "Mutation testing" step in the composite action');
  assert.match(
    step[0],
    /if:\s*\$\{\{\s*inputs\.mutation\s*==\s*['"]true['"]/,
    'mutation step must be conditional on inputs.mutation == "true"'
  );
  assert.match(step[0], /--module\s+mutation/, 'mutation step must invoke `--module mutation`');
});

test('action.yml has a chaos step conditional on inputs.chaos == "true" AND chaos-url non-empty', () => {
  const step = RAW.match(/- name: Chaos \/ runtime testing[\s\S]+?(?=\n    - name:|$)/);
  assert.ok(step, 'expected a "Chaos / runtime testing" step in the composite action');
  assert.match(
    step[0],
    /if:\s*\$\{\{\s*inputs\.chaos\s*==\s*['"]true['"]/,
    'chaos step must be conditional on inputs.chaos == "true"'
  );
  assert.match(
    step[0],
    /inputs\.chaos-url\s*!=\s*['"]['"]/,
    'chaos step must also gate on inputs.chaos-url not being empty'
  );
  assert.match(step[0], /--module\s+chaos/, 'chaos step must invoke `--module chaos`');
});

test('action.yml chaos step installs the Playwright Chromium binary inline', () => {
  const step = RAW.match(/- name: Chaos \/ runtime testing[\s\S]+?(?=\n    - name:|$)/);
  assert.ok(step, 'expected a "Chaos / runtime testing" step');
  // The Action installs Playwright on demand so customers don't need to
  // pre-install it in their workflow. One-line install keeps the surface tiny.
  assert.match(
    step[0],
    /npx\s+playwright\s+install\s+--with-deps\s+chromium/,
    'chaos step must run `npx playwright install --with-deps chromium`'
  );
});

test('action.yml chaos step exports GATETEST_CHAOS_URL from inputs.chaos-url', () => {
  const step = RAW.match(/- name: Chaos \/ runtime testing[\s\S]+?(?=\n    - name:|$)/);
  assert.ok(step, 'expected a "Chaos / runtime testing" step');
  assert.match(
    step[0],
    /GATETEST_CHAOS_URL:\s*\$\{\{\s*inputs\.chaos-url\s*\}\}/,
    'chaos step must expose chaos-url to the CLI via GATETEST_CHAOS_URL'
  );
});

test('action.yml Enforce gate verdict step is NOT influenced by mutation/chaos exit codes', () => {
  // Mutation and chaos run AFTER the gate step but BEFORE Enforce gate
  // verdict (so they can mark warnings). Critically, the enforcement step
  // only reads steps.gate.outputs.gate-status — never mutation/chaos outputs.
  const enforce = RAW.match(/- name: Enforce gate verdict[\s\S]+?$/);
  assert.ok(enforce, 'expected an "Enforce gate verdict" step');
  // Should not branch on mutation/chaos outputs at all.
  assert.doesNotMatch(enforce[0], /mutation[-_]?(?:blocks-merge|status|exit)/i,
    'Enforce gate verdict must NOT branch on mutation status');
  assert.doesNotMatch(enforce[0], /chaos[-_]?(?:blocks-merge|status|exit)/i,
    'Enforce gate verdict must NOT branch on chaos status');
  // Should read only the gate outputs.
  assert.match(enforce[0], /steps\.gate\.outputs\.gate-status/,
    'Enforce gate verdict must read steps.gate.outputs.gate-status');
});

test('action.yml mutation step honours mutation-blocks-merge=false by default (no merge block)', () => {
  const step = RAW.match(/- name: Mutation testing[\s\S]+?(?=\n    - name:|$)/);
  assert.ok(step);
  // The step body must consult mutation-blocks-merge before propagating
  // a non-zero exit — that's how coaching-vs-gating is encoded.
  assert.match(
    step[0],
    /mutation-blocks-merge/,
    'mutation step must consult inputs.mutation-blocks-merge before exiting non-zero'
  );
});

test('action.yml chaos step honours chaos-blocks-merge=false by default (no merge block)', () => {
  const step = RAW.match(/- name: Chaos \/ runtime testing[\s\S]+?(?=\n    - name:|$)/);
  assert.ok(step);
  assert.match(
    step[0],
    /chaos-blocks-merge/,
    'chaos step must consult inputs.chaos-blocks-merge before exiting non-zero'
  );
});
