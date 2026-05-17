/**
 * Prompt / LLM Safety Module — AI-app-specific security scanner.
 *
 * Every AI app gets the same classes of mistake, and nobody in the
 * traditional QA space (Sonar, Snyk, Lighthouse, kube-score) even
 * knows they exist. This is a GateTest lead we can lap everybody on.
 *
 * Rules (line-heuristic, JS/TS/Python):
 *
 *   error:   NEXT_PUBLIC_*_API_KEY / NEXT_PUBLIC_*_SECRET / VITE_*_API_KEY
 *            — these are bundled to the browser. The value ends up in
 *            every user's devtools.
 *   error:   openai.chat.completions.create({...}) with no `max_tokens`
 *            — unbounded output = cost DoS vector via long prompts.
 *   error:   anthropic.messages.create({...}) with no `max_tokens`
 *            — same class. Anthropic requires it anyway; missing here
 *            is a bug.
 *   warning: Prompt template interpolating a user-input-shaped variable
 *            with no delimiter — prompt injection surface.
 *            Matches both f-strings (Python) and template literals
 *            (JS/TS) whose left-hand side looks like a prompt.
 *   warning: Model references that are deprecated / known-unsafe
 *            (text-davinci-*, gpt-3.5-turbo-0301, claude-v1, claude-2.0,
 *             claude-instant, palm-*).
 *   info:    LLM call with `temperature >= 1.5` — hallucination risk.
 *
 * Pattern-keyed names (`prompt-safety:public-api-key:<rel>:<line>` etc.)
 * feed the memory module's fix-pattern engine.
 *
 * TODO(gluecron): when Gluecron ships AI-pipeline YAML, mirror these
 * rules to whatever prompt-config schema it lands on.
 */

const fs = require('fs');
const path = require('path');
const BaseModule = require('./base-module');

const DEFAULT_EXCLUDES = [
  'node_modules', '.git', '.claude', 'dist', 'build', 'coverage', '.gatetest',
  '.next', '__pycache__', 'target', 'vendor',
];

// Paths that define detection patterns — scanning them would produce FPs
// because the pattern strings match the very rules they implement.
const MODULE_SOURCE_RE = /(?:^|\/)src[\\/]modules[\\/]/;

const SCAN_EXTS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py']);

// Client-bundled env prefixes. NEXT_PUBLIC_* (Next.js), VITE_* (Vite),
// REACT_APP_* (CRA), EXPO_PUBLIC_* (Expo), PUBLIC_* (SvelteKit).
const PUBLIC_ENV_PREFIX = /\b(NEXT_PUBLIC_|VITE_|REACT_APP_|EXPO_PUBLIC_|PUBLIC_)/;
const KEYISH_SUFFIX = /(?:API_KEY|APIKEY|SECRET|TOKEN|PRIVATE_KEY)\b/;

// Hints that a variable is carrying user-supplied input. Treat these as
// untrusted when interpolated into a prompt-shaped string.
const USER_INPUT_HINTS = [
  'user_input', 'userInput', 'user_message', 'userMessage',
  'user_query', 'userQuery', 'question', 'userQuestion',
  'message', 'prompt',
  'req.body', 'request.body', 'req.query', 'request.query',
  'req.params', 'request.params',
];

// Prompt-shaped left-hand side: the literal before the interpolation
// looks like instructions / a prompt scaffold.
const PROMPT_SHAPE = /(?:^|[:,\s])(?:you are|summari[sz]e|translate|rewrite|answer|analy[sz]e|classify|extract|generate|write a|act as|please|respond with|respond as)/i;

const DEPRECATED_MODELS = [
  'text-davinci-001', 'text-davinci-002', 'text-davinci-003',
  'code-davinci-002',
  'gpt-3.5-turbo-0301', 'gpt-3.5-turbo-0613',
  'claude-v1', 'claude-v1.2', 'claude-v1.3',
  'claude-instant-v1', 'claude-instant-1', 'claude-instant-1.1',
  'claude-2', 'claude-2.0', 'claude-2.1',
  'palm-2', 'text-bison-001',
];

class PromptSafetyModule extends BaseModule {
  constructor() {
    super('promptSafety', 'Prompt / LLM Safety — browser-exposed API keys, unbounded max_tokens, prompt-injection surfaces, deprecated models');
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;
    const files = this._findFiles(projectRoot);

    if (files.length === 0) {
      result.addCheck('prompt-safety:no-files', true, {
        severity: 'info',
        message: 'No JS/TS/Python source files found — skipping',
      });
      return;
    }

    // Only scan files that actually reference an AI SDK or a public
    // env var — no point line-scanning the whole codebase.
    const relevant = files.filter((f) => this._looksAiAdjacent(f));
    if (relevant.length === 0) {
      result.addCheck('prompt-safety:no-ai-code', true, {
        severity: 'info',
        message: `No AI SDK or public-env usage detected in ${files.length} file(s) — skipping`,
      });
      return;
    }

    result.addCheck('prompt-safety:scanning', true, {
      severity: 'info',
      message: `Scanning ${relevant.length} AI-adjacent file(s)`,
    });

    let totalIssues = 0;
    for (const file of relevant) {
      totalIssues += this._scanFile(file, projectRoot, result);
    }

    result.addCheck('prompt-safety:summary', true, {
      severity: 'info',
      message: `Prompt/LLM safety scan: ${relevant.length} file(s), ${totalIssues} issue(s)`,
    });
  }

  _findFiles(projectRoot) {
    const out = [];
    const walk = (dir, depth = 0) => {
      if (depth > 12) return;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (DEFAULT_EXCLUDES.includes(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full, depth + 1);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (SCAN_EXTS.has(ext)) out.push(full);
        }
      }
    };
    walk(projectRoot);
    return out;
  }

  _looksAiAdjacent(file) {
    try {
      const content = fs.readFileSync(file, 'utf-8');
      return (
        /\b(openai|anthropic|Anthropic|OpenAI)\b/.test(content) ||
        /from\s+openai\s+import|from\s+anthropic\s+import/.test(content) ||
        /@anthropic-ai\/sdk|@anthropic\/sdk|openai\/openai/.test(content) ||
        PUBLIC_ENV_PREFIX.test(content)
      );
    } catch {
      return false;
    }
  }

  _scanFile(file, projectRoot, result) {
    let content;
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch {
      return 0;
    }

    const rel = path.relative(projectRoot, file);

    // Skip detection-pattern source files — scanning the module that
    // defines the patterns produces false positives on the patterns themselves.
    if (MODULE_SOURCE_RE.test(rel.replace(/\\/g, '/'))) return 0;

    const relUnix = rel.replace(/\\/g, '/');
    const isTest = /(?:^|\/)(?:tests?|__tests__|spec|fixtures?|e2e)(?:\/|$)|\.(?:test|spec)\.[a-z]+$/i.test(relUnix);

    const lines = content.split('\n');
    let issues = 0;

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed) continue;

      // 1. Browser-exposed API key / secret
      const pubMatch = line.match(/([A-Z][A-Z0-9_]*)/g);
      if (pubMatch) {
        for (const tok of pubMatch) {
          if (PUBLIC_ENV_PREFIX.test(tok) && KEYISH_SUFFIX.test(tok)) {
            issues += this._flag(result, `prompt-safety:public-api-key:${rel}:${i + 1}`, {
              severity: isTest ? 'warning' : 'error',
              file: rel,
              line: i + 1,
              match: tok,
              message: `\`${tok}\` — client-bundled env vars are shipped to every user's browser; the API key is effectively public`,
              suggestion: 'Move the key to a server-only env var (no public prefix) and call the LLM from a server route / edge function.',
            });
            break;
          }
        }
      }

      // 2. Deprecated / unsafe model strings
      for (const m of DEPRECATED_MODELS) {
        const re = new RegExp(`["\'\`]${m.replace(/\./g, '\\.')}["\'\`]`);
        if (re.test(line)) {
          issues += this._flag(result, `prompt-safety:deprecated-model:${m}:${rel}:${i + 1}`, {
            severity: 'warning',
            file: rel,
            line: i + 1,
            model: m,
            message: `Model \`${m}\` is deprecated / EOL — calls may fail or return degraded output`,
            suggestion: 'Upgrade to a current model (e.g. `claude-sonnet-4-6`, `claude-opus-4-6`, or the latest GPT-4-class model).',
          });
          break;
        }
      }

      // 3. Extreme temperature
      const tempMatch = line.match(/\btemperature\s*[:=]\s*([0-9.]+)/);
      if (tempMatch) {
        const val = parseFloat(tempMatch[1]);
        if (!Number.isNaN(val) && val >= 1.5) {
          issues += this._flag(result, `prompt-safety:high-temperature:${rel}:${i + 1}`, {
            severity: 'info',
            file: rel,
            line: i + 1,
            value: val,
            message: `temperature=${val} — at this range output is effectively random; hallucination and off-topic responses spike`,
            suggestion: 'Use 0.0-0.3 for deterministic tasks (extraction, classification), 0.5-0.9 for creative. >= 1.5 is rarely wanted.',
          });
        }
      }
    }

    // 4. LLM call without max_tokens — scan object-literal calls
    issues += this._scanLlmCalls(content, lines, rel, result, isTest);

    // 5. Prompt injection: string templates combining a prompt-shaped
    // literal with a user-input-hinted variable, with no delimiter
    // between the literal and the var.
    issues += this._scanPromptInjection(lines, rel, result);

    return issues;
  }

  _scanLlmCalls(content, lines, rel, result, isTest = false) {
    let issues = 0;
    // Match both JS/TS and Python call-expressions. The object/kwarg
    // body is captured greedily; we then check for `max_tokens`.
    // (?:[\s\S]*?\}) catches the closing brace for JS object literals;
    // for Python we also accept `)`.
    const patterns = [
      { re: /(?:openai|OpenAI)[\s\S]{0,80}?chat\.completions\.create\s*\(\s*\{([\s\S]*?)\}\s*\)/g,
        kind: 'openai' },
      { re: /(?:anthropic|Anthropic)[\s\S]{0,80}?messages\.create\s*\(\s*\{([\s\S]*?)\}\s*\)/g,
        kind: 'anthropic' },
      { re: /(?:openai|OpenAI)[\s\S]{0,80}?chat\.completions\.create\s*\(([\s\S]*?)\)/g,
        kind: 'openai-py' },
      { re: /(?:anthropic|Anthropic)[\s\S]{0,80}?messages\.create\s*\(([\s\S]*?)\)/g,
        kind: 'anthropic-py' },
    ];
    for (const { re, kind } of patterns) {
      let m;
      while ((m = re.exec(content)) !== null) {
        const body = m[1];
        if (/max_tokens\s*[:=]/.test(body)) continue;
        const idx = m.index;
        const lineNo = content.slice(0, idx).split('\n').length;
        issues += this._flag(result, `prompt-safety:no-max-tokens:${kind}:${rel}:${lineNo}`, {
          severity: isTest ? 'warning' : 'error',
          file: rel,
          line: lineNo,
          api: kind,
          message: `${kind} call has no \`max_tokens\` — an attacker crafting a long prompt can run up your bill indefinitely`,
          suggestion: 'Always set `max_tokens` to the smallest value that fits your use case. This also caps worst-case latency.',
        });
      }
    }
    return issues;
  }

  _scanPromptInjection(lines, rel, result) {
    let issues = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      // JS/TS template literal: `...${var}...`
      const tplMatches = [...line.matchAll(/`([^`]*?)\$\{\s*([^}]+?)\s*\}([^`]*)`/g)];
      for (const m of tplMatches) {
        const before = m[1];
        const varName = m[2];
        if (PROMPT_SHAPE.test(before) && this._looksUserControlled(varName)) {
          issues += this._flag(result, `prompt-safety:prompt-injection:${rel}:${i + 1}`, {
            severity: 'warning',
            file: rel,
            line: i + 1,
            variable: varName,
            message: `Prompt template interpolates \`${varName}\` (user-controlled) with no delimiter — prompt-injection surface`,
            suggestion: 'Wrap untrusted input in a clearly-delimited block like <user_input>...</user_input>, and tell the model to treat it as data, not instructions.',
          });
        }
      }
      // Python f-string: f"...{var}..."
      const pyMatches = [...line.matchAll(/f["']([^"'\n]*?)\{([^}]+?)\}([^"'\n]*)["']/g)];
      for (const m of pyMatches) {
        const before = m[1];
        const varName = m[2];
        if (PROMPT_SHAPE.test(before) && this._looksUserControlled(varName)) {
          issues += this._flag(result, `prompt-safety:prompt-injection:${rel}:${i + 1}`, {
            severity: 'warning',
            file: rel,
            line: i + 1,
            variable: varName,
            message: `f-string prompt interpolates \`${varName}\` (user-controlled) with no delimiter — prompt-injection surface`,
            suggestion: 'Wrap untrusted input in a clearly-delimited block like <user_input>...</user_input>, and tell the model to treat it as data, not instructions.',
          });
        }
      }
    }
    return issues;
  }

  _looksUserControlled(varName) {
    const v = varName.replace(/\s+/g, '');
    return USER_INPUT_HINTS.some((h) => v === h || v.endsWith('.' + h) || v.includes(h));
  }

  _flag(result, name, details) {
    result.addCheck(name, false, details);
    return 1;
  }
}

module.exports = PromptSafetyModule;
