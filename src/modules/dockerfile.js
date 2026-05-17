/**
 * Dockerfile Module — container security + hygiene scanner.
 *
 * Finds every Dockerfile in the repo and flags the classic mistakes:
 *   - running as root (missing USER directive)
 *   - using :latest tags (non-reproducible builds)
 *   - curl | sh pipelines (supply-chain risk)
 *   - ADD for remote URLs where COPY + explicit download would be safer
 *   - secrets baked into layers
 *   - apt without --no-install-recommends
 *   - apt without cache cleanup (layer bloat)
 *   - pip install without --no-cache-dir
 *   - multiple RUN apt-get update chains (stale cache bug)
 *
 * Zero dependencies, zero network. Pattern + heuristic only.
 *
 * TODO(gluecron): when Gluecron ships a container-build bridge API we can
 * also lint the built image layers themselves; for now Dockerfile-only.
 */

const fs = require('fs');
const path = require('path');
const BaseModule = require('./base-module');

const DEFAULT_EXCLUDES = [
  'node_modules', '.git', '.claude', 'dist', 'build', 'coverage', '.gatetest',
  '.next', '__pycache__', 'target', 'vendor',
];

const DOCKERFILE_PATTERN = /^(Dockerfile(\..+)?|.*\.[Dd]ockerfile)$/;

// Secret-looking env/arg values — same style as the secrets module but
// scoped to Dockerfile idioms.
const SECRET_PATTERNS = [
  { name: 'aws-key', pattern: /AKIA[0-9A-Z]{16}/, message: 'AWS access key literal in Dockerfile' },
  { name: 'generic-token', pattern: /(?:TOKEN|SECRET|PASSWORD|API_KEY)\s*=\s*["']?[A-Za-z0-9+/_\-]{16,}["']?/i,
    message: 'Hard-coded credential-shaped value in Dockerfile' },
  { name: 'private-key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    message: 'Private key literal embedded in Dockerfile' },
];

class DockerfileModule extends BaseModule {
  constructor() {
    super('dockerfile', 'Dockerfile Security — root user, :latest tags, curl|sh, apt hygiene, secrets-in-layers, cache bloat');
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;
    const dockerfiles = this._findDockerfiles(projectRoot);

    if (dockerfiles.length === 0) {
      result.addCheck('dockerfile:no-files', true, {
        severity: 'info',
        message: 'No Dockerfiles found — skipping',
      });
      return;
    }

    result.addCheck('dockerfile:scanning', true, {
      severity: 'info',
      message: `Scanning ${dockerfiles.length} Dockerfile(s)`,
    });

    let totalIssues = 0;
    for (const file of dockerfiles) {
      totalIssues += this._checkDockerfile(file, projectRoot, result);
    }

    result.addCheck('dockerfile:summary', true, {
      severity: 'info',
      message: `Dockerfile scan: ${dockerfiles.length} file(s), ${totalIssues} issue(s)`,
    });
  }

  _findDockerfiles(projectRoot) {
    const out = [];
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
        if (entry.isDirectory()) {
          walk(full, depth + 1);
        } else if (entry.isFile() && DOCKERFILE_PATTERN.test(entry.name)) {
          out.push(full);
        }
      }
    };
    walk(projectRoot);
    return out;
  }

  _checkDockerfile(file, projectRoot, result) {
    let content;
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch {
      return 0;
    }

    const rel = path.relative(projectRoot, file);
    const rawLines = content.split('\n');
    let issues = 0;

    // Normalise: merge line continuations so RUN chains scan as one logical line.
    const logicalLines = this._joinContinuations(rawLines);

    let sawUser = false;
    let hasFrom = false;
    const aptUpdates = [];
    const stageAliases = new Set();

    for (const { line, startLine } of logicalLines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const upperHead = trimmed.split(/\s+/)[0].toUpperCase();

      if (upperHead === 'FROM') {
        hasFrom = true;
        issues += this._checkFrom(trimmed, rel, startLine, stageAliases, result);
      } else if (upperHead === 'USER') {
        const userArg = trimmed.replace(/^USER\s+/i, '').trim();
        // USER 0 / root is not a real USER step
        if (userArg && userArg !== '0' && userArg.toLowerCase() !== 'root') {
          sawUser = true;
        } else if (userArg === '0' || userArg.toLowerCase() === 'root') {
          result.addCheck(`dockerfile:root-user:${rel}:${startLine}`, false, {
            severity: 'warning',
            file: rel,
            line: startLine,
            message: `Dockerfile explicitly switches to root (USER ${userArg}) — use an unprivileged user`,
            suggestion: 'RUN groupadd -r app && useradd -r -g app app; USER app',
          });
          issues += 1;
        }
      } else if (upperHead === 'RUN') {
        issues += this._checkRun(trimmed, rel, startLine, aptUpdates, result);
      } else if (upperHead === 'ADD') {
        issues += this._checkAdd(trimmed, rel, startLine, result);
      } else if (upperHead === 'ENV' || upperHead === 'ARG') {
        issues += this._checkEnvArgSecrets(trimmed, rel, startLine, result);
      }
    }

    if (hasFrom && !sawUser) {
      result.addCheck(`dockerfile:no-user:${rel}`, false, {
        severity: 'warning',
        file: rel,
        message: `${rel} never switches to a non-root user — container runs as root`,
        suggestion: 'Add `RUN useradd -r app && USER app` (or equivalent) before CMD/ENTRYPOINT.',
      });
      issues += 1;
    }

    if (aptUpdates.length > 1) {
      result.addCheck(`dockerfile:apt-split:${rel}`, false, {
        severity: 'warning',
        file: rel,
        line: aptUpdates[0],
        message: `Multiple separate RUN apt-get update calls — stale-cache bug risk; chain update + install in ONE layer`,
        suggestion: 'RUN apt-get update && apt-get install -y --no-install-recommends <pkgs> && rm -rf /var/lib/apt/lists/*',
      });
      issues += 1;
    }

    return issues;
  }

  _checkFrom(line, rel, startLine, stageAliases, result) {
    // FROM image[:tag|@digest] [AS stage]
    const match = line.match(/^FROM\s+(?:--platform=[^\s]+\s+)?([^\s]+)(?:\s+AS\s+(\w+))?/i);
    if (!match) return 0;
    const image = match[1];
    const alias = match[2];
    if (alias) stageAliases.add(alias);

    // If `image` is just a reference to a previously-defined stage, skip.
    if (stageAliases.has(image)) return 0;

    // Skip digest-pinned images — they're always reproducible.
    if (image.includes('@sha256:')) return 0;

    let issues = 0;
    if (image.includes(':latest') || !image.includes(':')) {
      result.addCheck(`dockerfile:latest-tag:${rel}:${startLine}`, false, {
        severity: 'warning',
        file: rel,
        line: startLine,
        message: `FROM ${image} uses :latest or no tag — non-reproducible builds`,
        suggestion: 'Pin to a specific tag or, better, a digest: FROM image@sha256:...',
      });
      issues += 1;
    }
    return issues;
  }

  _checkRun(line, rel, startLine, aptUpdates, result) {
    let issues = 0;

    // curl | sh / wget | sh / download-pipe-shell
    if (/\b(curl|wget)\b[^|]*\|\s*(ba)?sh\b/i.test(line)) {
      result.addCheck(`dockerfile:curl-pipe-sh:${rel}:${startLine}`, false, {
        severity: 'error',
        file: rel,
        line: startLine,
        message: `RUN pipes curl/wget directly into sh — arbitrary remote code execution at build time`,
        suggestion: 'Download to a file, verify a checksum or signature, then execute.',
      });
      issues += 1;
    }

    // sudo inside a RUN is almost always wrong
    if (/\bsudo\b/.test(line)) {
      result.addCheck(`dockerfile:sudo:${rel}:${startLine}`, false, {
        severity: 'warning',
        file: rel,
        line: startLine,
        message: 'sudo inside Dockerfile RUN — build user is already root; sudo shouldn\'t be needed',
        suggestion: 'Remove sudo. If you need a non-root user, add USER directive instead.',
      });
      issues += 1;
    }

    // apt-get update without --no-install-recommends
    if (/\bapt-get\s+install\b/.test(line) && !/--no-install-recommends/.test(line)) {
      result.addCheck(`dockerfile:apt-recommends:${rel}:${startLine}`, false, {
        severity: 'warning',
        file: rel,
        line: startLine,
        message: 'apt-get install without --no-install-recommends — bloats image with unwanted packages',
        suggestion: 'Add --no-install-recommends and install only what you need.',
      });
      issues += 1;
    }

    // apt-get install without cleanup => layer bloat
    if (/\bapt-get\s+install\b/.test(line) && !/rm\s+-rf\s+\/var\/lib\/apt\/lists/.test(line)) {
      result.addCheck(`dockerfile:apt-no-cleanup:${rel}:${startLine}`, false, {
        severity: 'info',
        file: rel,
        line: startLine,
        message: 'apt-get install without `rm -rf /var/lib/apt/lists/*` — persistent cache bloats image',
        suggestion: 'Append `&& rm -rf /var/lib/apt/lists/*` to the RUN.',
      });
      issues += 1;
    }

    // apt-get update tracking (look at raw line index for the first token)
    if (/\bapt-get\s+update\b/.test(line)) {
      aptUpdates.push(startLine);
    }

    // pip install without --no-cache-dir
    if (/\bpip(3)?\s+install\b/.test(line) && !/--no-cache-dir/.test(line)) {
      result.addCheck(`dockerfile:pip-cache:${rel}:${startLine}`, false, {
        severity: 'info',
        file: rel,
        line: startLine,
        message: 'pip install without --no-cache-dir — caches in image layer and bloats size',
        suggestion: 'Add --no-cache-dir to every pip install inside Dockerfiles.',
      });
      issues += 1;
    }

    // npm install without production flag + cache clean
    if (/\bnpm\s+install\b/.test(line) && !/--production|--omit=dev|--only=prod/.test(line) && !/\bnpm\s+ci\b/.test(line)) {
      result.addCheck(`dockerfile:npm-dev-in-image:${rel}:${startLine}`, false, {
        severity: 'info',
        file: rel,
        line: startLine,
        message: 'npm install includes devDependencies in the final image',
        suggestion: 'Use `npm ci --omit=dev` (or a multi-stage build) for production images.',
      });
      issues += 1;
    }

    // chmod 777 or chmod -R 777 — insecure permissions
    if (/\bchmod\s+(-R\s+)?(0?777|a\+rwx)\b/.test(line)) {
      result.addCheck(`dockerfile:chmod-777:${rel}:${startLine}`, false, {
        severity: 'warning',
        file: rel,
        line: startLine,
        message: 'chmod 777 / a+rwx grants world-writable permissions — almost always wrong',
        suggestion: 'Use the minimum permissions actually required; typically 0755 or 0644.',
      });
      issues += 1;
    }

    // Detect secrets accidentally written into image via RUN
    for (const s of SECRET_PATTERNS) {
      if (s.pattern.test(line)) {
        result.addCheck(`dockerfile:secret-in-run:${s.name}:${rel}:${startLine}`, false, {
          severity: 'error',
          file: rel,
          line: startLine,
          message: `${s.message} — this secret is baked into the layer forever`,
          suggestion: 'Use BuildKit secret mounts (RUN --mount=type=secret) or a runtime env var.',
        });
        issues += 1;
      }
    }

    return issues;
  }

  _checkAdd(line, rel, startLine, result) {
    // ADD with a URL = silent HTTP fetch at build time
    if (/\bADD\s+https?:\/\//i.test(line)) {
      result.addCheck(`dockerfile:add-url:${rel}:${startLine}`, false, {
        severity: 'warning',
        file: rel,
        line: startLine,
        message: 'ADD with a URL — no checksum verification, silent over-the-network install',
        suggestion: 'Use RUN with curl/wget + explicit checksum verification, or COPY from a prepared artifact.',
      });
      return 1;
    }
    return 0;
  }

  _checkEnvArgSecrets(line, rel, startLine, result) {
    let issues = 0;
    for (const s of SECRET_PATTERNS) {
      if (s.pattern.test(line)) {
        result.addCheck(`dockerfile:secret-in-env:${s.name}:${rel}:${startLine}`, false, {
          severity: 'error',
          file: rel,
          line: startLine,
          message: `${s.message} — ENV/ARG bakes the value into every image built from this Dockerfile`,
          suggestion: 'Never hardcode secrets. Use BuildKit `--mount=type=secret` at build time, or runtime env vars.',
        });
        issues += 1;
      }
    }
    return issues;
  }

  /**
   * Merge Dockerfile backslash-continuation lines into single logical lines,
   * preserving the 1-based start line so diagnostics point to the right place.
   */
  _joinContinuations(rawLines) {
    const out = [];
    let buf = '';
    let bufStart = 0;
    for (let i = 0; i < rawLines.length; i += 1) {
      const raw = rawLines[i];
      const trimEnd = raw.replace(/\s+$/, '');
      if (buf === '') bufStart = i + 1;
      if (trimEnd.endsWith('\\')) {
        buf += trimEnd.slice(0, -1) + ' ';
      } else {
        buf += trimEnd;
        if (buf.trim()) out.push({ line: buf, startLine: bufStart });
        buf = '';
      }
    }
    if (buf.trim()) out.push({ line: buf, startLine: bufStart });
    return out;
  }
}

module.exports = DockerfileModule;
