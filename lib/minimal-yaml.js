/**
 * Minimal indentation-aware YAML parser — extracts ONLY what
 * `gatetest replay` needs from a GitHub Actions workflow file:
 *
 *   { jobs: { <jobId>: { name, steps: [{ name, run, ... }] } } }
 *
 * Not a general YAML parser. By design — no dep allowed (Bible: no new
 * npm deps). Handles:
 *   - `jobs:` block + `<jobId>:` child blocks at indent 2
 *   - `name: ...` (single line, optional quotes)
 *   - `steps:` array (`- name: ...` `run: ...`)
 *   - block-scalar `run: |` with deeper-indented lines
 *
 * Anything fancier (anchors, multi-line plain, flow style, mappings inside
 * arrays) — degrades gracefully. The CLI already has a mapping-table
 * fallback, so a YAML miss is non-fatal.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Try to load `.github/workflows/<file>.yml` from the working tree.
 * Returns the parsed minimal-YAML shape, or null on any failure.
 */
function loadWorkflowYaml(workingDir, workflowPath) {
  if (!workflowPath) return null;
  const candidates = [
    path.join(workingDir, workflowPath),
    path.join(workingDir, '.github', 'workflows', path.basename(workflowPath)),
  ];
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const text = fs.readFileSync(p, 'utf-8');
      const parsed = parseMinimalYaml(text);
      if (parsed) return parsed;
    } catch { /* try next candidate */ }
  }
  return null;
}

function parseMinimalYaml(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const out = { jobs: {} };
  let i = 0;
  while (i < lines.length && !/^jobs:\s*$/.test(lines[i])) i++;
  if (i >= lines.length) return null;
  i++;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '' || line.trimStart().startsWith('#')) { i++; continue; }
    const jobMatch = line.match(/^( {2})([A-Za-z0-9_-]+):\s*$/);
    if (!jobMatch) break;
    const jobId = jobMatch[2];
    const job = { name: jobId, steps: [] };
    out.jobs[jobId] = job;
    i++;
    while (i < lines.length) {
      const sub = lines[i];
      if (sub.trim() === '' || sub.trimStart().startsWith('#')) { i++; continue; }
      if (/^[^\s]/.test(sub)) break;
      if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(sub) && !/^ {4}/.test(lines[i])) break;
      const m = sub.match(/^ {4}name:\s*(.*)$/);
      if (m) { job.name = stripQuotes(m[1].trim()); i++; continue; }
      if (/^ {4}steps:\s*$/.test(sub)) {
        i++;
        i = readStepsArray(lines, i, job.steps);
        continue;
      }
      i++;
    }
  }
  return out;
}

function readStepsArray(lines, start, stepsOut) {
  let i = start;
  let current = null;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '' || line.trimStart().startsWith('#')) { i++; continue; }
    const stepStart = line.match(/^ {6}- ([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (stepStart) {
      if (current) stepsOut.push(current);
      current = {};
      const k = stepStart[1]; const v = stripQuotes(stepStart[2].trim());
      if (v) current[k] = v;
      i++;
      continue;
    }
    const stepKv = line.match(/^ {8}([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (stepKv && current) {
      const k = stepKv[1]; const v = stepKv[2];
      if (k === 'run' && v.trim() === '|') {
        i++;
        const collected = [];
        while (i < lines.length && /^ {10,}/.test(lines[i])) {
          collected.push(lines[i].replace(/^ {10}/, ''));
          i++;
        }
        current.run = collected.join('\n').trim();
        continue;
      }
      current[k] = stripQuotes(v.trim());
      i++;
      continue;
    }
    if (!/^ {6,}/.test(line) && line.trim() !== '') break;
    i++;
  }
  if (current) stepsOut.push(current);
  return i;
}

function stripQuotes(s) {
  if (!s) return s;
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

module.exports = { loadWorkflowYaml, parseMinimalYaml, _readStepsArray: readStepsArray };
