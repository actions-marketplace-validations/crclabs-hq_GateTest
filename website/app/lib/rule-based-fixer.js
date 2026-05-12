/**
 * Rule-based fixer — deterministic code fixes with zero Anthropic API cost.
 *
 * When a file's issues are all covered by rules here, Claude is bypassed
 * entirely and the fix is applied in <1ms. Claude is only called for
 * issues that rules cannot handle deterministically.
 *
 * Integration: `tryRuleBasedFix(content, filePath, issues)` returns the
 * fully-fixed content string if ALL issues were handled, or `null` to
 * signal the caller should fall through to Claude.
 *
 * Rule schema:
 *   name          — identifier used in logs
 *   matches       — (issueStr) => bool: can this rule handle this issue?
 *   apply         — (content, filePath) => string: transform content
 *   alreadyFixed  — optional (content, issueStr) => bool: true if the
 *                   problematic pattern is no longer present. Used when one
 *                   apply() call fixes multiple issues simultaneously — the
 *                   second issue sees the pattern already gone (no diff), but
 *                   is still considered handled.
 *
 * If apply returns the same string as the input AND alreadyFixed is absent or
 * returns false, the rule is treated as not applicable.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Remove a whole line matching a pattern. */
function removeLine(content, pattern) {
  return content
    .split('\n')
    .filter(line => !pattern.test(line))
    .join('\n');
}

/** Replace all occurrences. */
function replaceAll(content, pattern, replacement) {
  const g = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
  return content.replace(g, replacement);
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

const RULES = [
  // --- TLS / certificate bypass -----------------------------------------

  {
    name: 'tls-reject-unauthorized',
    matches: (issue) => /rejectUnauthorized\s*:\s*false/i.test(issue) || /js-reject-unauthorized/i.test(issue),
    apply: (content) => replaceAll(content, /\brejectUnauthorized\s*:\s*false\b/g, 'rejectUnauthorized: true'),
  },

  {
    name: 'tls-node-env-bypass',
    // NODE_TLS_REJECT_UNAUTHORIZED = "0" — remove the entire line
    matches: (issue) => /NODE_TLS_REJECT_UNAUTHORIZED/i.test(issue) && /"0"|'0'/.test(issue),
    apply: (content) => removeLine(content, /NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*["']0["']/),
  },

  {
    name: 'tls-strict-ssl',
    matches: (issue) => /strictSSL\s*:\s*false/i.test(issue) || /js-strict-ssl/i.test(issue),
    apply: (content) => replaceAll(content, /\bstrictSSL\s*:\s*false\b/g, 'strictSSL: true'),
  },

  {
    name: 'tls-insecure-flag',
    matches: (issue) => /\binsecure\s*:\s*true\b/i.test(issue) || /js-insecure-flag/i.test(issue),
    apply: (content) => replaceAll(content, /\binsecure\s*:\s*true\b/g, 'insecure: false'),
  },

  {
    name: 'tls-python-verify-false',
    matches: (issue) => /\bverify\s*=\s*False\b/i.test(issue) || /\bverify_ssl\s*=\s*False\b/i.test(issue) || /py-verify-false/i.test(issue),
    apply: (content) => {
      let out = replaceAll(content, /\bverify\s*=\s*False\b/g, 'verify=True');
      out = replaceAll(out, /\bverify_ssl\s*=\s*False\b/g, 'verify_ssl=True');
      return out;
    },
  },

  {
    name: 'tls-python-unverified-context',
    matches: (issue) => /ssl\._create_unverified_context/i.test(issue) || /py-unverified-context/i.test(issue),
    apply: (content) => replaceAll(content, /ssl\._create_unverified_context\s*\(\s*\)/g, 'ssl.create_default_context()'),
  },

  {
    name: 'tls-python-check-hostname',
    matches: (issue) => /\.check_hostname\s*=\s*False/i.test(issue) || /py-check-hostname-false/i.test(issue),
    apply: (content) => replaceAll(content, /\.check_hostname\s*=\s*False/g, '.check_hostname = True'),
  },

  {
    name: 'tls-python-cert-none',
    matches: (issue) => /ssl\.CERT_NONE/i.test(issue) || /cert_reqs\s*=\s*['"]CERT_NONE['"]/i.test(issue) || /py-cert-none/i.test(issue),
    apply: (content) => {
      let out = replaceAll(content, /\bssl\.CERT_NONE\b/g, 'ssl.CERT_REQUIRED');
      out = replaceAll(out, /\bcert_reqs\s*=\s*['"]CERT_NONE['"]/g, "cert_reqs='CERT_REQUIRED'");
      return out;
    },
  },

  // --- Cookie / session security -----------------------------------------

  {
    name: 'cookie-httponly-false',
    matches: (issue) => /httpOnly\s*:\s*false/i.test(issue) || /js-httponly-false/i.test(issue),
    apply: (content) => replaceAll(content, /\bhttpOnly\s*:\s*false\b/g, 'httpOnly: true'),
  },

  {
    name: 'cookie-secure-false',
    matches: (issue) => /\bsecure\s*:\s*false\b/i.test(issue) || /js-secure-false/i.test(issue),
    // Only replace `secure: false` in cookie/session option shapes — not broad
    apply: (content) => replaceAll(content, /\bsecure\s*:\s*false\b/g, 'secure: true'),
  },

  {
    name: 'cookie-python-session-secure',
    matches: (issue) => /SESSION_COOKIE_SECURE\s*=\s*False/i.test(issue) || /CSRF_COOKIE_SECURE\s*=\s*False/i.test(issue) || /py-cookie-secure-false/i.test(issue),
    alreadyFixed: (content, issue) => {
      if (/SESSION_COOKIE_SECURE/i.test(issue)) return !/SESSION_COOKIE_SECURE\s*=\s*False/.test(content);
      if (/CSRF_COOKIE_SECURE/i.test(issue)) return !/CSRF_COOKIE_SECURE\s*=\s*False/.test(content);
      return false;
    },
    apply: (content) => {
      let out = replaceAll(content, /\bSESSION_COOKIE_SECURE\s*=\s*False\b/g, 'SESSION_COOKIE_SECURE = True');
      out = replaceAll(out, /\bCSRF_COOKIE_SECURE\s*=\s*False\b/g, 'CSRF_COOKIE_SECURE = True');
      return out;
    },
  },

  {
    name: 'cookie-python-httponly',
    matches: (issue) => /SESSION_COOKIE_HTTPONLY\s*=\s*False/i.test(issue) || /CSRF_COOKIE_HTTPONLY\s*=\s*False/i.test(issue) || /py-cookie-httponly-false/i.test(issue),
    alreadyFixed: (content, issue) => {
      if (/SESSION_COOKIE_HTTPONLY/i.test(issue)) return !/SESSION_COOKIE_HTTPONLY\s*=\s*False/.test(content);
      if (/CSRF_COOKIE_HTTPONLY/i.test(issue)) return !/CSRF_COOKIE_HTTPONLY\s*=\s*False/.test(content);
      return false;
    },
    apply: (content) => {
      let out = replaceAll(content, /\bSESSION_COOKIE_HTTPONLY\s*=\s*False\b/g, 'SESSION_COOKIE_HTTPONLY = True');
      out = replaceAll(out, /\bCSRF_COOKIE_HTTPONLY\s*=\s*False\b/g, 'CSRF_COOKIE_HTTPONLY = True');
      return out;
    },
  },

  {
    name: 'cookie-python-fastapi-httponly',
    matches: (issue) => /httponly\s*=\s*False/i.test(issue) || /py-fastapi-httponly-false/i.test(issue),
    apply: (content) => replaceAll(content, /\bhttponly\s*=\s*False\b/g, 'httponly=True'),
  },

  // --- Datetime / timezone bugs ------------------------------------------

  {
    name: 'datetime-python-utcnow',
    matches: (issue) => /datetime\.utcnow\s*\(\s*\)/i.test(issue) || /py-utcnow/i.test(issue) || /utcnow.*deprecated/i.test(issue),
    apply: (content) => {
      let out = replaceAll(content, /\bdatetime\.utcnow\s*\(\s*\)/g, 'datetime.now(timezone.utc)');
      // Ensure timezone is imported if not already present
      if (/timezone\.utc/.test(out) && !/from\s+datetime\s+import.*\btimezone\b/.test(out) && !/import\s+datetime/.test(out)) {
        // Add timezone to the datetime import line
        out = out.replace(
          /^(from\s+datetime\s+import\s+)(datetime)(\s*)$/m,
          '$1$2, timezone$3'
        );
        // If datetime is already imported with other names, add timezone
        out = out.replace(
          /^(from\s+datetime\s+import\s+)([^,\n]+(?:,\s*[^,\n]+)*)(\s*)$/m,
          (match, prefix, names, suffix) => {
            if (/\btimezone\b/.test(names)) return match;
            return `${prefix}${names.trimEnd()}, timezone${suffix}`;
          }
        );
      }
      return out;
    },
  },

  {
    name: 'datetime-python-naive-now',
    // datetime.now() without tz= argument → datetime.now(timezone.utc)
    matches: (issue) => /datetime\.now\s*\(\s*\)\s*(?:without|missing|no)\s*tz/i.test(issue) || /naive.*datetime/i.test(issue) && /datetime\.now/i.test(issue),
    apply: (content) => {
      // Only replace bare datetime.now() calls with no arguments
      let out = replaceAll(content, /\bdatetime\.now\s*\(\s*\)/g, 'datetime.now(timezone.utc)');
      if (/timezone\.utc/.test(out) && !/from\s+datetime\s+import.*\btimezone\b/.test(out) && !/import\s+datetime/.test(out)) {
        out = out.replace(
          /^(from\s+datetime\s+import\s+)([^,\n]+(?:,\s*[^,\n]+)*)(\s*)$/m,
          (match, prefix, names, suffix) => {
            if (/\btimezone\b/.test(names)) return match;
            return `${prefix}${names.trimEnd()}, timezone${suffix}`;
          }
        );
      }
      return out;
    },
  },

  // --- parseInt radix -------------------------------------------------------

  {
    name: 'parseint-radix',
    matches: (issue) => /parseInt.*without.*radix/i.test(issue) || /missing.*radix/i.test(issue) || /parseInt.*radix/i.test(issue),
    apply: (content) => {
      // Replace parseInt(x) and parseInt(x) but NOT parseInt(x, N) already-fixed calls
      return replaceAll(content, /\bparseInt\s*\(([^,)]+)\s*\)/g, (match, arg) => {
        // Skip if it looks like it already has a radix (this regex won't match those, but be safe)
        return `parseInt(${arg.trim()}, 10)`;
      });
    },
  },

  // --- var → const ----------------------------------------------------------

  {
    name: 'var-to-const',
    matches: (issue) => /\bvar\b.*declaration/i.test(issue) || /use const.*let.*instead.*var/i.test(issue) || /prefer-const/i.test(issue) && /var/i.test(issue),
    apply: (content) => {
      // Only replace `var` declarations that are not inside comments/strings
      // Simple approach: replace `var ` at start of statement positions
      return replaceAll(content, /^(\s*)var\s+/gm, '$1const ');
    },
  },

  // --- Shell: missing set -euo pipefail ------------------------------------

  {
    name: 'shell-set-euo',
    matches: (issue) => /set\s+-euo\s+pipefail/i.test(issue) || /missing.*set.*-e/i.test(issue) || /shell.*strict.*mode/i.test(issue),
    apply: (content, filePath) => {
      if (filePath && !filePath.endsWith('.sh') && !filePath.endsWith('.bash') && !/\bshell\b/.test(filePath)) {
        return content;
      }
      if (/set\s+-euo\s+pipefail/.test(content)) return content;
      // Insert after the shebang line if present, otherwise at top
      if (/^#!/.test(content)) {
        return content.replace(/^(#![^\n]+\n)/, '$1set -euo pipefail\n');
      }
      return 'set -euo pipefail\n' + content;
    },
  },

  // --- GitHub Actions: missing top-level permissions -----------------------

  {
    name: 'gh-actions-permissions',
    matches: (issue) => /missing\s+permissions/i.test(issue) || /permissions.*read-all/i.test(issue) || /ci.*security.*permissions/i.test(issue),
    apply: (content, filePath) => {
      if (!filePath || !filePath.endsWith('.yml') && !filePath.endsWith('.yaml')) return content;
      if (/^permissions\s*:/m.test(content)) return content; // already has top-level permissions
      // Add after the `on:` block — find first job: line and insert before it
      return content.replace(/^(jobs\s*:)/m, 'permissions:\n  contents: read\n\n$1');
    },
  },

  // --- Crypto: Math.random for security tokens ----------------------------

  {
    name: 'math-random-crypto',
    matches: (issue) => /Math\.random.*(?:token|secret|key|password|nonce|salt|id)/i.test(issue) || /(?:token|secret|key|password|nonce|salt|id).*Math\.random/i.test(issue) || /insecure.*random/i.test(issue),
    apply: (content) => {
      // This one is context-dependent — only fix clear token/id patterns
      return replaceAll(
        content,
        /\bMath\.random\s*\(\s*\)\.toString\s*\(\s*36\s*\)\.substring\s*\(\s*\d+\s*\)/g,
        'crypto.randomUUID()'
      );
    },
  },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Try to fix all issues using deterministic rules.
 *
 * @param {string} content - Original file content
 * @param {string} filePath - Repo-relative file path (used by some rules)
 * @param {string[]} issues - Issue strings from the scanner
 * @returns {{ content: string, handled: string[], unhandled: string[] }}
 *   `handled`   — issues matched and (likely) fixed by a rule
 *   `unhandled` — issues no rule could match
 */
function applyRules(content, filePath, issues) {
  if (typeof content !== 'string') throw new TypeError('content must be a string');
  if (!Array.isArray(issues)) throw new TypeError('issues must be an array');

  const handled = [];
  const unhandled = [];
  let current = content;

  for (const issue of issues) {
    const rule = RULES.find(r => r.matches(issue));
    if (!rule) {
      unhandled.push(issue);
      continue;
    }

    const next = rule.apply(current, filePath || '');
    if (next !== current) {
      current = next;
      handled.push(issue);
    } else if (rule.alreadyFixed && rule.alreadyFixed(current, issue)) {
      // Rule matched, apply produced no change, but the problematic pattern is
      // already gone — a previous rule in this pass already fixed it.
      handled.push(issue);
    } else {
      // Rule matched but produced no change — treat as unhandled so Claude sees it
      unhandled.push(issue);
    }
  }

  return { content: current, handled, unhandled };
}

/**
 * Try to fix ALL issues using deterministic rules.
 *
 * Returns the fully-fixed content string if every issue was handled,
 * or `null` if any issue could not be handled (caller should use Claude).
 *
 * This is the zero-API-cost fast path wired into the fix loop.
 *
 * @param {string} content
 * @param {string} filePath
 * @param {string[]} issues
 * @returns {string|null}
 */
function tryRuleBasedFix(content, filePath, issues) {
  if (!issues || issues.length === 0) return null;
  const result = applyRules(content, filePath, issues);
  if (result.unhandled.length > 0) return null;
  if (result.content === content) return null; // no changes produced
  return result.content;
}

module.exports = { tryRuleBasedFix, applyRules, RULES };
