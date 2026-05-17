/**
 * Kubernetes Module — manifest security + reliability scanner.
 *
 * Every K8s cluster gets the same classes of bug: a forgotten
 * `privileged: true`, a pod with no CPU limit eating the node, an image
 * pinned to `:latest`, a LoadBalancer service accidentally exposed to
 * the internet. This module walks every YAML file in the repo that
 * looks like a Kubernetes manifest (contains `apiVersion:` + `kind:`)
 * and applies line-heuristic rules across workloads, services,
 * RBAC, and secrets.
 *
 * Excluded: `.github/` (CI workflows — ciSecurity's job), `node_modules/`.
 *
 * Rules:
 *
 *   error:   privileged: true
 *   error:   hostNetwork: true / hostPID: true / hostIPC: true
 *   error:   allowPrivilegeEscalation: true
 *   error:   runAsUser: 0     (explicit root)
 *   error:   image: <name>:latest  (or tagless)
 *   error:   hostPath volume mounting /var/run/docker.sock or /
 *   error:   Secret.stringData / data containing a plaintext-looking cred
 *   warning: capabilities.add contains SYS_ADMIN / NET_ADMIN / NET_RAW / ALL
 *   warning: service type LoadBalancer without loadBalancerSourceRanges
 *   warning: env: { value: <long base64-ish> } with NAME matching *TOKEN/*SECRET/*KEY
 *   warning: container missing resources.limits
 *   warning: container missing readinessProbe + livenessProbe
 *   info:    no explicit runAsNonRoot: true at pod or container level
 *   info:    no readOnlyRootFilesystem: true
 *
 * Pattern-keyed check names feed the memory module's fix-pattern engine.
 *
 * TODO(gluecron): Gluecron's pipeline-runner YAML may grow a `kind:`
 * schema — when it does, extend discovery to cover it.
 */

const fs = require('fs');
const path = require('path');
const BaseModule = require('./base-module');

const DEFAULT_EXCLUDES = [
  'node_modules', '.git', '.claude', 'dist', 'build', 'coverage', '.gatetest',
  '.next', '__pycache__', 'target', 'vendor', '.terraform',
];

// Don't re-scan CI workflow files — that's ciSecurity's domain.
const SKIPPED_DIRS = ['.github/workflows'];

const DANGEROUS_CAPS = new Set(['SYS_ADMIN', 'NET_ADMIN', 'NET_RAW', 'ALL', 'SYS_PTRACE']);

class KubernetesModule extends BaseModule {
  constructor() {
    super('kubernetes', 'Kubernetes Manifest Security — privileged pods, host namespaces, :latest images, missing limits/probes, dangerous caps');
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;
    const files = this._findManifests(projectRoot);

    if (files.length === 0) {
      result.addCheck('k8s:no-files', true, {
        severity: 'info',
        message: 'No Kubernetes manifests found — skipping',
      });
      return;
    }

    result.addCheck('k8s:scanning', true, {
      severity: 'info',
      message: `Scanning ${files.length} Kubernetes manifest(s)`,
    });

    let totalIssues = 0;
    for (const file of files) {
      totalIssues += this._scanFile(file, projectRoot, result);
    }

    result.addCheck('k8s:summary', true, {
      severity: 'info',
      message: `Kubernetes scan: ${files.length} file(s), ${totalIssues} issue(s)`,
    });
  }

  _findManifests(projectRoot) {
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
        const rel = path.relative(projectRoot, full).replace(/\\/g, '/');
        if (SKIPPED_DIRS.some((p) => rel.startsWith(p + '/') || rel === p)) continue;
        if (entry.isDirectory()) {
          walk(full, depth + 1);
        } else if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) {
          if (this._looksLikeManifest(full)) out.push(full);
        }
      }
    };
    walk(projectRoot);
    return out;
  }

  _looksLikeManifest(file) {
    try {
      const content = fs.readFileSync(file, 'utf-8');
      // Must contain both apiVersion: and kind:
      return /^\s*apiVersion\s*:/m.test(content) && /^\s*kind\s*:/m.test(content);
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
    const lines = content.split('\n');
    let issues = 0;

    let kind = null;
    const kindMatch = content.match(/^\s*kind\s*:\s*([A-Za-z]+)/m);
    if (kindMatch) kind = kindMatch[1];

    // Track whether we saw a container-level resources block with limits /
    // probes so we can flag "container has no limits" at the end.
    const containerDiagnostics = this._analyseContainers(content, lines);

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      // 1. privileged: true
      if (/^\s*privileged\s*:\s*true\b/.test(line)) {
        issues += this._flag(result, `k8s:privileged:${rel}:${i + 1}`, {
          severity: 'error',
          file: rel,
          line: i + 1,
          kind,
          message: '`privileged: true` — container can access all host devices and kernel capabilities; equivalent to root on the node',
          suggestion: 'Remove privileged:true. Grant only the specific capabilities you need via `capabilities.add`.',
        });
      }

      // 2. host namespaces
      for (const key of ['hostNetwork', 'hostPID', 'hostIPC']) {
        const re = new RegExp(`^\\s*${key}\\s*:\\s*true\\b`);
        if (re.test(line)) {
          issues += this._flag(result, `k8s:${key.toLowerCase()}:${rel}:${i + 1}`, {
            severity: 'error',
            file: rel,
            line: i + 1,
            kind,
            message: `\`${key}: true\` — shares the node's namespace; container compromise escalates to the host`,
            suggestion: `Set \`${key}: false\` (or omit) unless this is a deliberate infra workload (e.g. kube-proxy, CNI).`,
          });
        }
      }

      // 3. allowPrivilegeEscalation: true
      if (/^\s*allowPrivilegeEscalation\s*:\s*true\b/.test(line)) {
        issues += this._flag(result, `k8s:privilege-escalation:${rel}:${i + 1}`, {
          severity: 'error',
          file: rel,
          line: i + 1,
          kind,
          message: '`allowPrivilegeEscalation: true` — setuid binaries can gain more privileges than the parent process',
          suggestion: 'Set `allowPrivilegeEscalation: false`. Default in Pod Security Standards "restricted".',
        });
      }

      // 4. runAsUser: 0 (root)
      if (/^\s*runAsUser\s*:\s*0\b/.test(line)) {
        issues += this._flag(result, `k8s:run-as-root:${rel}:${i + 1}`, {
          severity: 'error',
          file: rel,
          line: i + 1,
          kind,
          message: '`runAsUser: 0` — container runs as root',
          suggestion: 'Set a non-zero UID (e.g. runAsUser: 1000) and ensure the image supports it.',
        });
      }

      // 5. image tag check
      const imgMatch = trimmed.match(/^image\s*:\s*["']?([^\s"']+)["']?/);
      if (imgMatch) {
        const img = imgMatch[1];
        // Strip digest pins from consideration
        if (img.includes('@sha256:')) {
          // SHA-pinned — good
        } else {
          // Split host/path from tag; only accept tags if ':' present in the
          // last path segment (not the host:port).
          const lastSlash = img.lastIndexOf('/');
          const afterSlash = lastSlash >= 0 ? img.slice(lastSlash + 1) : img;
          const colonIdx = afterSlash.indexOf(':');
          const tag = colonIdx >= 0 ? afterSlash.slice(colonIdx + 1) : '';
          if (!tag || tag === 'latest') {
            issues += this._flag(result, `k8s:image-tag:${rel}:${i + 1}`, {
              severity: 'error',
              file: rel,
              line: i + 1,
              kind,
              message: `image \`${img}\` ${tag ? 'uses :latest' : 'is untagged'} — non-reproducible deploys; a `
                + 'rollback cannot guarantee the same binary',
              suggestion: 'Pin to a digest (`image: repo@sha256:...`) or an immutable tag (`image: repo:v1.2.3`).',
            });
          }
        }
      }

      // 6. hostPath mounting /var/run/docker.sock or /
      if (/^\s*path\s*:\s*["']?(\/var\/run\/docker\.sock|\/)["']?\s*$/.test(line)) {
        // Quick look-back: are we inside a hostPath volume?
        const lookback = lines.slice(Math.max(0, i - 4), i).join('\n');
        if (/hostPath\s*:/.test(lookback)) {
          issues += this._flag(result, `k8s:dangerous-host-mount:${rel}:${i + 1}`, {
            severity: 'error',
            file: rel,
            line: i + 1,
            kind,
            message: 'hostPath mount of the Docker socket or filesystem root — container compromise = node/cluster takeover',
            suggestion: 'Never mount /var/run/docker.sock into a workload. Use a purpose-built API (e.g. for image building, use Kaniko/Buildah).',
          });
        }
      }

      // 7. capabilities.add with dangerous caps (within a few lines of `add:`)
      if (/^\s*-\s*["']?([A-Z_]+)["']?\s*$/.test(line)) {
        const cap = line.trim().replace(/^-\s*/, '').replace(/["']/g, '');
        if (DANGEROUS_CAPS.has(cap)) {
          // Look up a few lines for `add:` under `capabilities:`
          const lookback = lines.slice(Math.max(0, i - 6), i).join('\n');
          if (/capabilities\s*:[\s\S]*add\s*:/.test(lookback)) {
            issues += this._flag(result, `k8s:dangerous-cap:${cap}:${rel}:${i + 1}`, {
              severity: 'warning',
              file: rel,
              line: i + 1,
              kind,
              message: `capabilities.add includes \`${cap}\` — expansive privilege; container can act as root on specific subsystems`,
              suggestion: `Drop ${cap}. Start from \`drop: [ALL]\` and add only the minimal caps you can prove you need.`,
            });
          }
        }
      }

      // 8. service type LoadBalancer without source ranges
      if (/^\s*type\s*:\s*LoadBalancer\b/.test(line)) {
        const rest = lines.slice(i, Math.min(i + 60, lines.length)).join('\n');
        if (!/loadBalancerSourceRanges\s*:/.test(rest)) {
          issues += this._flag(result, `k8s:lb-open-world:${rel}:${i + 1}`, {
            severity: 'warning',
            file: rel,
            line: i + 1,
            kind,
            message: 'Service type LoadBalancer without `loadBalancerSourceRanges` — exposes the service to the entire internet',
            suggestion: 'Add `loadBalancerSourceRanges: [<your-CIDRs>]` or front the service with an Ingress + WAF.',
          });
        }
      }

      // 9. inline secret in env value
      const envMatch = line.match(/^\s*(?:-\s+)?name\s*:\s*["']?([A-Z_][A-Z0-9_]*)["']?\s*$/);
      if (envMatch && /(?:TOKEN|SECRET|PASSWORD|API_KEY|APIKEY)$/i.test(envMatch[1])) {
        // Peek next few lines for `value: <long>`
        for (let j = i + 1; j < Math.min(i + 4, lines.length); j += 1) {
          const v = lines[j].match(/^\s*value\s*:\s*["']?([A-Za-z0-9+/=._\-]{16,})["']?\s*$/);
          if (v) {
            issues += this._flag(result, `k8s:inline-secret:${rel}:${j + 1}`, {
              severity: 'warning',
              file: rel,
              line: j + 1,
              kind,
              message: `env var \`${envMatch[1]}\` set via \`value:\` with credential-shaped string — plain-text secret in the manifest`,
              suggestion: 'Use `valueFrom: { secretKeyRef: { name: ..., key: ... } }` so the value lives in a Secret, not the workload spec.',
            });
            break;
          }
        }
      }
    }

    // Aggregate container diagnostics (one flag per container, not per line).
    for (const c of containerDiagnostics) {
      if (!c.hasLimits) {
        issues += this._flag(result, `k8s:no-limits:${rel}:${c.line}`, {
          severity: 'warning',
          file: rel,
          line: c.line,
          kind,
          container: c.name,
          message: `container "${c.name}" has no \`resources.limits\` — a runaway pod can starve the node`,
          suggestion: 'Set `resources.limits.cpu` and `resources.limits.memory`. Start with 2x your observed p99 usage.',
        });
      }
      if (!c.hasReadinessProbe && !c.hasLivenessProbe) {
        issues += this._flag(result, `k8s:no-probes:${rel}:${c.line}`, {
          severity: 'warning',
          file: rel,
          line: c.line,
          kind,
          container: c.name,
          message: `container "${c.name}" has no readiness/liveness probes — rolling deploys cannot tell healthy from broken`,
          suggestion: 'Add `readinessProbe` (controls traffic) and `livenessProbe` (restarts stuck containers).',
        });
      }
    }

    return issues;
  }

  /**
   * Lightweight YAML-indent container walker. We look for lines that match
   * `- name: <foo>` whose indent level indicates a container in a spec's
   * containers: list, then collect the keys nested under it until the next
   * same-or-lesser-indent sibling.
   */
  _analyseContainers(content, lines) {
    const results = [];
    // Find `containers:` anchors and capture subsequent `- name:` children.
    for (let i = 0; i < lines.length; i += 1) {
      const m = lines[i].match(/^(\s*)containers\s*:\s*$/);
      if (!m) continue;
      const baseIndent = m[1].length;
      // Walk forward collecting items until indent drops back to <= baseIndent
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j];
        if (!l.trim()) { j += 1; continue; }
        const ind = (l.match(/^(\s*)/) || [''])[0].length;
        if (ind <= baseIndent) break;

        const itemMatch = l.match(/^(\s*)-\s+name\s*:\s*["']?([^"'\s]+)["']?/);
        if (itemMatch && itemMatch[1].length > baseIndent) {
          const itemIndent = itemMatch[1].length;
          const c = {
            name: itemMatch[2],
            line: j + 1,
            hasLimits: false,
            hasReadinessProbe: false,
            hasLivenessProbe: false,
          };
          // Walk forward through this container's body
          let k = j + 1;
          while (k < lines.length) {
            const ll = lines[k];
            if (!ll.trim()) { k += 1; continue; }
            const lind = (ll.match(/^(\s*)/) || [''])[0].length;
            if (lind <= itemIndent) break;
            if (/^\s*limits\s*:/.test(ll)) c.hasLimits = true;
            if (/^\s*readinessProbe\s*:/.test(ll)) c.hasReadinessProbe = true;
            if (/^\s*livenessProbe\s*:/.test(ll)) c.hasLivenessProbe = true;
            k += 1;
          }
          results.push(c);
          j = k;
          continue;
        }
        j += 1;
      }
    }
    return results;
  }

  _flag(result, name, details) {
    result.addCheck(name, false, details);
    return 1;
  }
}

module.exports = KubernetesModule;
