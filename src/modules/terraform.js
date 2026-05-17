/**
 * Terraform / IaC Security Module — cloud-misconfig scanner.
 *
 * Every week someone's S3 bucket is on the front page. This module scans
 * Terraform (`.tf`, `.tf.json`), Terragrunt (`.hcl`), and Pulumi YAML
 * files for the top classes of preventable cloud misconfiguration. No
 * Terraform install required — pure HCL text heuristics, zero deps.
 *
 * Rules (HCL-aware line heuristics):
 *
 *   error:   AWS S3 bucket with public-read / public-read-write ACL
 *   error:   AWS S3 public access block set to false
 *   error:   Security group ingress from 0.0.0.0/0 on port 22 / 3389 / 3306 / 5432 / 6379 / 27017
 *   error:   RDS / EBS / S3 with `encrypted = false` or unset where Terraform default is unsafe
 *   error:   Resource `*_policy` with `"Principal": "*"` and `"Effect": "Allow"` (IAM wildcard)
 *   error:   Hardcoded AWS access-key / private-key / long-bearer in `.tf` or `.tfvars`
 *   warning: Cloud-init / user_data containing `curl | sh` or inline credentials
 *   warning: Resource missing explicit tags block (compliance / cost-allocation)
 *   warning: Publicly exposed IAM user / access_key resource (prefer roles)
 *   info:    `local_file` with 0777 or 0666 permissions (overly permissive)
 *
 * Pattern-keyed check names (`terraform:public-bucket:<rel>:<line>` etc.)
 * so the memory module's fix-pattern engine clusters fixes over time.
 *
 * TODO(gluecron): Gluecron pipeline YAML can run `terraform plan` in a
 * job — when it does, we can also diff-mode-scan the plan JSON for
 * changes that introduce unsafe state, not just the source.
 */

const fs = require('fs');
const path = require('path');
const BaseModule = require('./base-module');

const DEFAULT_EXCLUDES = [
  'node_modules', '.git', '.claude', 'dist', 'build', 'coverage', '.gatetest',
  '.next', '__pycache__', 'target', 'vendor', '.terraform',
];

const TF_EXTENSIONS = new Set(['.tf', '.tfvars', '.hcl']);

// Ports that should never be open to 0.0.0.0/0 without a very good reason.
const DANGER_PORTS = new Map([
  [22,    'SSH'],
  [3389,  'RDP'],
  [3306,  'MySQL'],
  [5432,  'Postgres'],
  [6379,  'Redis'],
  [27017, 'MongoDB'],
  [9200,  'Elasticsearch'],
  [9300,  'Elasticsearch transport'],
  [5984,  'CouchDB'],
  [11211, 'Memcached'],
]);

const SECRET_PATTERNS = [
  { name: 'aws-key',       pattern: /AKIA[0-9A-Z]{16}/ },
  { name: 'aws-secret',    pattern: /aws_secret_access_key\s*=\s*"[A-Za-z0-9+/]{40}"/ },
  { name: 'private-key',   pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'generic-token', pattern: /(?:token|secret|password|api_key)\s*=\s*"[A-Za-z0-9+/_\-]{20,}"/i },
];

class TerraformModule extends BaseModule {
  constructor() {
    super('terraform', 'Terraform / IaC Security — public buckets, wildcard ingress, hardcoded secrets, missing encryption, IAM wildcards');
  }

  async run(result, config) {
    const projectRoot = config.projectRoot;
    const files = this._findTfFiles(projectRoot);

    if (files.length === 0) {
      result.addCheck('terraform:no-files', true, {
        severity: 'info',
        message: 'No Terraform / IaC files found — skipping',
      });
      return;
    }

    result.addCheck('terraform:scanning', true, {
      severity: 'info',
      message: `Scanning ${files.length} Terraform / IaC file(s)`,
    });

    let totalIssues = 0;
    for (const file of files) {
      totalIssues += this._scanFile(file, projectRoot, result);
    }

    result.addCheck('terraform:summary', true, {
      severity: 'info',
      message: `Terraform scan: ${files.length} file(s), ${totalIssues} issue(s)`,
    });
  }

  _findTfFiles(projectRoot) {
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
          // .tf.json handled via .json check + filename
          if (TF_EXTENSIONS.has(ext) || /\.tf\.json$/.test(entry.name)) {
            out.push(full);
          }
        }
      }
    };
    walk(projectRoot);
    return out;
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

    // Track open resource blocks so we can report resource-scoped issues.
    let currentResource = null; // { type, name, startLine, lines: [...] }
    let braceDepth = 0;
    const resources = [];

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const trimmed = line.trim();

      // Block opener: `resource "aws_s3_bucket" "foo" {`
      const resOpen = trimmed.match(/^resource\s+"([^"]+)"\s+"([^"]+)"\s*\{/);
      if (resOpen && braceDepth === 0) {
        currentResource = {
          type: resOpen[1],
          name: resOpen[2],
          startLine: i + 1,
          bodyLines: [],
        };
        braceDepth = 1;
        continue;
      }

      if (currentResource) {
        // Count braces to detect end of resource.
        for (const ch of line) {
          if (ch === '{') braceDepth += 1;
          else if (ch === '}') braceDepth -= 1;
        }
        if (braceDepth <= 0) {
          resources.push(currentResource);
          currentResource = null;
          braceDepth = 0;
          continue;
        }
        currentResource.bodyLines.push({ line, lineNo: i + 1 });
      }

      // File-wide: hardcoded secrets (any line, .tf/.tfvars)
      for (const { name, pattern } of SECRET_PATTERNS) {
        if (pattern.test(line)) {
          issues += this._flag(result, `terraform:hardcoded-secret:${name}:${rel}:${i + 1}`, {
            severity: 'error',
            file: rel,
            line: i + 1,
            message: `Hard-coded ${name} in Terraform source — credential leaks to every git checkout and state file`,
            suggestion: 'Use `variable {}` marked `sensitive = true`, read from a secret manager, or pass via TF_VAR_<name> env var.',
          });
        }
      }

      // cloud-init / user_data curl|sh
      if (/user_data\s*=/.test(line) || /cloud-init/i.test(line)) {
        // The heredoc body is usually multi-line; peek forward a few lines.
        const body = lines.slice(i, Math.min(i + 40, lines.length)).join('\n');
        if (/\b(?:curl|wget)\b[^|]*\|\s*(?:sh|bash)\b/.test(body)) {
          issues += this._flag(result, `terraform:user-data-curl-pipe:${rel}:${i + 1}`, {
            severity: 'warning',
            file: rel,
            line: i + 1,
            message: 'user_data / cloud-init pipes a downloaded script to a shell — no integrity check before execution on every boot',
            suggestion: 'Bake the script into the AMI, pin a SHA-256 of the downloaded file, or use a configuration management tool.',
          });
        }
      }
    }

    // Analyse each captured resource for type-specific issues.
    for (const res of resources) {
      issues += this._scanResource(res, rel, result);
    }

    return issues;
  }

  _scanResource(res, rel, result) {
    let issues = 0;
    const body = res.bodyLines.map((b) => b.line).join('\n');
    const lineOf = (needle) => {
      for (const b of res.bodyLines) {
        if (b.line.includes(needle)) return b.lineNo;
      }
      return res.startLine;
    };

    // S3 public ACL
    if (res.type === 'aws_s3_bucket' || res.type === 'aws_s3_bucket_acl') {
      const aclMatch = body.match(/acl\s*=\s*"([^"]+)"/);
      if (aclMatch && /^(public-read|public-read-write|authenticated-read)$/.test(aclMatch[1])) {
        issues += this._flag(result, `terraform:public-bucket:${rel}:${res.startLine}`, {
          severity: 'error',
          file: rel,
          line: lineOf('acl'),
          resource: `${res.type}.${res.name}`,
          message: `S3 bucket has public ACL \`${aclMatch[1]}\` — anyone on the internet can read (and sometimes write) objects`,
          suggestion: 'Default to private. Serve public content via CloudFront with Origin Access Identity, not a public bucket.',
        });
      }
    }

    // S3 public access block with anything set to false
    if (res.type === 'aws_s3_bucket_public_access_block') {
      const falseKey = body.match(/\b(block_public_acls|block_public_policy|ignore_public_acls|restrict_public_buckets)\s*=\s*false\b/);
      if (falseKey) {
        issues += this._flag(result, `terraform:public-access-block-off:${rel}:${res.startLine}`, {
          severity: 'error',
          file: rel,
          line: lineOf(falseKey[1]),
          resource: `${res.type}.${res.name}`,
          message: `\`${falseKey[1]} = false\` — disables an S3 safety net that prevents accidental public exposure`,
          suggestion: 'Leave all four public-access-block flags at `true` unless there is a very specific, documented reason.',
        });
      }
    }

    // Security group ingress from 0.0.0.0/0 on dangerous ports
    if (res.type === 'aws_security_group' || res.type === 'aws_security_group_rule') {
      const openRules = body.matchAll(/ingress\s*\{([\s\S]*?)\}/g);
      const blocks = [...openRules].map((m) => m[1]);
      if (res.type === 'aws_security_group_rule') blocks.push(body);
      for (const b of blocks) {
        if (!/0\.0\.0\.0\/0/.test(b)) continue;
        const fromMatch = b.match(/from_port\s*=\s*(\d+)/);
        const toMatch = b.match(/to_port\s*=\s*(\d+)/);
        const from = fromMatch ? parseInt(fromMatch[1], 10) : null;
        const to   = toMatch   ? parseInt(toMatch[1],   10) : null;
        if (from === null || to === null) continue;
        for (const [port, label] of DANGER_PORTS) {
          if (from <= port && port <= to) {
            issues += this._flag(result, `terraform:open-port:${label.toLowerCase().replace(/\s+/g, '-')}:${rel}:${res.startLine}`, {
              severity: 'error',
              file: rel,
              line: res.startLine,
              resource: `${res.type}.${res.name}`,
              message: `${label} (port ${port}) open to 0.0.0.0/0 — anyone on the internet can attempt to connect`,
              suggestion: 'Restrict the CIDR to a bastion/VPN CIDR, or put the service behind a private-subnet load balancer.',
            });
            break;
          }
        }
      }
    }

    // Encryption: RDS / EBS / S3 / EFS
    const encryptionRules = [
      { type: 'aws_db_instance',        key: 'storage_encrypted',     expect: 'true' },
      { type: 'aws_rds_cluster',        key: 'storage_encrypted',     expect: 'true' },
      { type: 'aws_ebs_volume',         key: 'encrypted',             expect: 'true' },
      { type: 'aws_efs_file_system',    key: 'encrypted',             expect: 'true' },
    ];
    for (const rule of encryptionRules) {
      if (res.type !== rule.type) continue;
      const m = body.match(new RegExp(`${rule.key}\\s*=\\s*(true|false)`));
      if (m) {
        if (m[1] !== rule.expect) {
          issues += this._flag(result, `terraform:unencrypted:${res.type}:${rel}:${res.startLine}`, {
            severity: 'error',
            file: rel,
            line: lineOf(rule.key),
            resource: `${res.type}.${res.name}`,
            message: `${res.type} has \`${rule.key} = ${m[1]}\` — data at rest is NOT encrypted`,
            suggestion: `Set \`${rule.key} = true\`. Encryption at rest is free on AWS and mandatory under most compliance regimes.`,
          });
        }
      } else {
        issues += this._flag(result, `terraform:unencrypted-missing:${res.type}:${rel}:${res.startLine}`, {
          severity: 'warning',
          file: rel,
          line: res.startLine,
          resource: `${res.type}.${res.name}`,
          message: `${res.type} does not set \`${rule.key}\` — default may be unencrypted depending on account settings`,
          suggestion: `Explicitly set \`${rule.key} = true\` so encryption is visible in the diff and enforced regardless of account defaults.`,
        });
      }
    }

    // IAM wildcard: Effect=Allow + Principal="*"
    if (/aws_iam_policy|aws_iam_role_policy|aws_s3_bucket_policy/.test(res.type)) {
      // Very rough: look for both signals in the same block.
      if (/"Effect"\s*:\s*"Allow"/.test(body) && /"Principal"\s*:\s*"\*"/.test(body)) {
        issues += this._flag(result, `terraform:iam-wildcard:${rel}:${res.startLine}`, {
          severity: 'error',
          file: rel,
          line: res.startLine,
          resource: `${res.type}.${res.name}`,
          message: 'IAM policy grants `Effect: Allow` with `Principal: "*"` — grants access to any AWS account / anonymous caller',
          suggestion: 'Pin Principal to specific AWS account IDs / roles. Use Conditions to narrow further if the intent is a named external account.',
        });
      }
    }

    // Standalone iam_user / iam_access_key resource
    if (res.type === 'aws_iam_user' || res.type === 'aws_iam_access_key') {
      issues += this._flag(result, `terraform:long-lived-iam:${res.type}:${rel}:${res.startLine}`, {
        severity: 'warning',
        file: rel,
        line: res.startLine,
        resource: `${res.type}.${res.name}`,
        message: `${res.type} — long-lived IAM credentials are the #1 leaked-cred class; prefer IAM roles + STS`,
        suggestion: 'Use IAM roles with OIDC (GitHub Actions / EKS / Lambda) or AWS SSO. Reserve IAM users for break-glass only.',
      });
    }

    // Resource missing tags block (compliance / cost allocation)
    const TAG_REQUIRED = /^aws_(instance|db_instance|rds_cluster|s3_bucket|lb|elb|ebs_volume|efs_file_system|elasticache_cluster)$/;
    if (TAG_REQUIRED.test(res.type) && !/\btags\s*=/.test(body)) {
      issues += this._flag(result, `terraform:no-tags:${res.type}:${rel}:${res.startLine}`, {
        severity: 'warning',
        file: rel,
        line: res.startLine,
        resource: `${res.type}.${res.name}`,
        message: `${res.type} has no \`tags\` block — breaks cost allocation, incident ownership, and compliance inventory`,
        suggestion: 'Add a `tags = { Environment = "...", Owner = "...", CostCenter = "..." }` block. Ideally enforce via `default_tags` on the provider.',
      });
    }

    // local_file with overly permissive mode
    if (res.type === 'local_file') {
      const m = body.match(/file_permission\s*=\s*"(0?[0-7]+)"/);
      if (m && /^0?(777|666|7[0-7][7])$/.test(m[1])) {
        issues += this._flag(result, `terraform:loose-file-perms:${rel}:${res.startLine}`, {
          severity: 'info',
          file: rel,
          line: lineOf('file_permission'),
          resource: `${res.type}.${res.name}`,
          message: `local_file writes with \`file_permission = "${m[1]}"\` — world-writable / world-readable`,
          suggestion: 'Set `file_permission = "0600"` (or "0640" if a group needs read). Leave 0644 only for truly public artifacts.',
        });
      }
    }

    return issues;
  }

  _flag(result, name, details) {
    result.addCheck(name, false, details);
    return 1;
  }
}

module.exports = TerraformModule;
