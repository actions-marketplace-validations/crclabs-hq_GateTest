/**
 * Phase 5.2.3 — confidence-aware reporting.
 *
 * Pure function. Takes the raw module results from a scan plus the
 * confidence scores from 5.2.2 and emits the customer-facing module
 * results with severity adjusted per-finding:
 *
 *   trust       (score ≥ 0.85) → no change
 *   downgrade   (score ≥ 0.65) → error → warning, warning → info
 *   double-down (score ≥ 0.45) → error → info, warning → info
 *   suppress    (score < 0.45) → drop the finding entirely
 *
 * The transform is per-finding, NOT per-module. A single module can
 * have a high-confidence pattern (surfaces normally) and a low-
 * confidence pattern (suppressed) at the same time.
 *
 * NOTHING IS LOST: every original finding goes into the report's
 * `suppressed` / `downgraded` arrays so the operator dashboard
 * (5.2.4) can show "you're hiding 12 findings from this customer
 * because they were noisy" — full audit trail.
 *
 * Callers:
 *   - /api/scan/run wraps its result with this before returning to
 *     the customer (so the FindingsPanel sees adjusted severities).
 *   - /api/scan/nuclear similarly adjusts before formatting the
 *     diagnosis report.
 *   - The CLI does NOT apply this — local-only scans are honest
 *     about everything (no per-customer confidence context).
 */

/**
 * Severity transition table per action.
 */
const SEVERITY_TRANSFORM = {
  trust:       { error: 'error',   warning: 'warning', info: 'info'  },
  downgrade:   { error: 'warning', warning: 'info',    info: 'info'  },
  'double-down': { error: 'info',  warning: 'info',    info: 'info'  },
  // suppress is handled separately — finding is dropped
};

/**
 * Classify a single raw finding string into its severity bucket so
 * we can apply the transform. Mirrors the heuristic in ai-handoff.js
 * / FindingsPanel.tsx — but standalone so this module has no UI deps.
 */
const ERROR_HINTS = /\b(error|fail|vulnerab|exploit|injection|unsafe|critical|leak|exposed|disabled|bypass|impossible|catastrophic|unbounded|never|race|toctou|secret|credential|password|api[_\- ]?key|token|hardcoded)\b/i;
const WARNING_HINTS = /\b(warning|warn|should|consider|prefer|outdated|stale|deprecat|missing|unused|aging)\b/i;
const INFO_HINTS = /\b(summary|ok|note|scanned|info|library-ok)\b/i;

function classifySeverity(raw) {
  if (typeof raw !== 'string') return 'warning';
  if (/^(error|err|critical|high)\b[:]/i.test(raw)) return 'error';
  if (/^(warning|warn|medium)\b[:]/i.test(raw)) return 'warning';
  if (/^(info|note|low|summary)\b[:]/i.test(raw)) return 'info';
  const lower = raw.toLowerCase();
  if (ERROR_HINTS.test(lower)) return 'error';
  if (WARNING_HINTS.test(lower)) return 'warning';
  if (INFO_HINTS.test(lower)) return 'info';
  return 'warning';
}

/**
 * Re-prefix a finding string with its new severity so downstream
 * consumers (FindingsPanel, ai-handoff) classify it correctly.
 * Idempotent — strips any existing severity prefix first.
 */
function reprefixSeverity(raw, newSeverity) {
  if (typeof raw !== 'string') return raw;
  const stripped = raw.replace(/^(?:\[[^\]]+\]\s*|(?:error|warn(?:ing)?|info|note|summary)\s*:\s*)/i, '');
  // Don't add prefix when it would duplicate the natural severity (e.g.
  // newSeverity = 'error' and the raw text already starts with critical).
  // Always prefix downgraded results so the change is visible.
  return `${newSeverity}: ${stripped}`;
}

/**
 * Apply confidence-aware adjustment to a single module's result.
 * Returns the adjusted module result + bookkeeping arrays.
 *
 * @param {object} module - { name, status, details: string[], ... }
 * @param {Function} resolveAction - (module, patternHash?) → 'trust' |
 *                                   'downgrade' | 'double-down' |
 *                                   'suppress'.
 *                                   For 5.2.3 we don't have a patternHash
 *                                   per finding without re-running the
 *                                   extractor, so callers typically pass
 *                                   a module-level resolver.
 * @returns {{
 *   module: object,         // adjusted module result
 *   suppressed: string[],   // findings that were dropped
 *   downgraded: Array<{ raw, from, to }>,
 * }}
 */
function applyConfidenceToModule(module, resolveAction) {
  if (!module || typeof module !== 'object') {
    return { module, suppressed: [], downgraded: [] };
  }
  const details = Array.isArray(module.details) ? module.details : [];
  if (details.length === 0 || typeof resolveAction !== 'function') {
    return { module, suppressed: [], downgraded: [] };
  }

  const action = resolveAction(module.name, null) || 'trust';
  if (action === 'trust') {
    // Fast path — nothing to do.
    return { module, suppressed: [], downgraded: [] };
  }

  const adjustedDetails = [];
  const suppressed = [];
  const downgraded = [];

  for (const raw of details) {
    if (action === 'suppress') {
      suppressed.push(raw);
      continue;
    }
    const transform = SEVERITY_TRANSFORM[action];
    if (!transform) {
      adjustedDetails.push(raw);
      continue;
    }
    const fromSev = classifySeverity(raw);
    const toSev = transform[fromSev] || fromSev;
    if (fromSev !== toSev) {
      downgraded.push({ raw, from: fromSev, to: toSev });
      adjustedDetails.push(reprefixSeverity(raw, toSev));
    } else {
      adjustedDetails.push(raw);
    }
  }

  // If we suppressed everything, the module visually goes from "failed"
  // to a softer state. We don't touch status here — the caller decides
  // whether to recompute it (re-run that's cheap) or leave it (honest
  // about the original outcome).
  return {
    module: {
      ...module,
      details: adjustedDetails,
      issues: adjustedDetails.length, // recompute to match new array
    },
    suppressed,
    downgraded,
  };
}

/**
 * Apply confidence-aware adjustment to a whole scan result.
 *
 * @param {object} scanResult - { modules: Module[], totalIssues: number, ... }
 * @param {Function} resolveAction - per-module action resolver
 * @returns {{
 *   scanResult: object,        // adjusted shape, same outer schema
 *   adjustments: {
 *     suppressedCount: number,
 *     downgradedCount: number,
 *     perModule: Array<{ module, suppressed, downgraded }>,
 *   }
 * }}
 */
function applyConfidenceToScan(scanResult, resolveAction) {
  if (!scanResult || !Array.isArray(scanResult.modules)) {
    return {
      scanResult,
      adjustments: { suppressedCount: 0, downgradedCount: 0, perModule: [] },
    };
  }
  const adjustedModules = [];
  const perModule = [];
  let suppressedCount = 0;
  let downgradedCount = 0;
  for (const m of scanResult.modules) {
    const out = applyConfidenceToModule(m, resolveAction);
    adjustedModules.push(out.module);
    if (out.suppressed.length > 0 || out.downgraded.length > 0) {
      perModule.push({
        module: m.name,
        suppressed: out.suppressed,
        downgraded: out.downgraded,
      });
    }
    suppressedCount += out.suppressed.length;
    downgradedCount += out.downgraded.length;
  }
  const totalIssues = adjustedModules.reduce((s, m) => s + (m.issues || 0), 0);
  return {
    scanResult: {
      ...scanResult,
      modules: adjustedModules,
      totalIssues,
    },
    adjustments: { suppressedCount, downgradedCount, perModule },
  };
}

/**
 * Helper to build a `resolveAction` closure backed by getConfidenceScore.
 * Caches each (module, patternHash) lookup for the duration of one scan
 * so a 100-finding module doesn't fire 100 SQL queries.
 */
function buildResolveAction(opts) {
  const { sql, getConfidenceScore, defaultAction = 'trust' } = opts;
  if (typeof sql !== 'function') return () => defaultAction;
  if (typeof getConfidenceScore !== 'function') return () => defaultAction;
  const cache = new Map();
  return async (module, patternHash) => {
    const key = `${module}::${patternHash || ''}`;
    if (cache.has(key)) return cache.get(key);
    try {
      const result = await getConfidenceScore({ sql, module, patternHash });
      const action = result?.action || defaultAction;
      cache.set(key, action);
      return action;
    } catch {
      cache.set(key, defaultAction);
      return defaultAction;
    }
  };
}

module.exports = {
  SEVERITY_TRANSFORM,
  classifySeverity,
  reprefixSeverity,
  applyConfidenceToModule,
  applyConfidenceToScan,
  buildResolveAction,
};
