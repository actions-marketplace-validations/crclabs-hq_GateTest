'use strict';

/**
 * Compliance framework mappings — GateTest module → OWASP / SOC2 / CIS.
 *
 * This is the single source of truth for compliance-framework attribution.
 * The CISO report generator (website/app/lib/ciso-report-generator.js) reads
 * from here when building board-ready output, and tests under
 * tests/compliance-mappings.test.js assert coverage + shape.
 *
 * The mappings are deliberately hardcoded (no Claude, no hallucination):
 * - OWASP Top 10 2021 — A01..A10 categories, the universally-cited web
 *   security risk taxonomy.
 * - SOC2 Trust Service Criteria — CC6.x (security), CC7.x (system
 *   operations), CC8.x (change management), A1.x (availability), PI1.x
 *   (processing integrity), P4.x / P8.x (privacy).
 * - CIS Controls v8 — control numbers 1..18 with the most-applicable
 *   safeguard ID (e.g. "3.10" for "Encrypt sensitive data in transit").
 *
 * Honesty rule: if a module genuinely doesn't fit any OWASP Top 10
 * category (e.g. `prSize` is a workflow-hygiene check, not a vuln), we
 * use a generic mapping like ["A04:2021"] (Insecure Design) rather than
 * inventing a precise match.
 *
 * Fallback: getComplianceMapping(unknownModule) returns the FALLBACK_MAPPING
 * — never null/undefined. This guarantees every finding lands SOMEWHERE in
 * the framework tables in the CISO report.
 *
 * @typedef {Object} ComplianceMapping
 * @property {string[]} owasp - OWASP Top 10 2021 category IDs (e.g. "A02:2021")
 * @property {string[]} soc2  - SOC2 TSC codes (e.g. "CC6.1")
 * @property {string[]} cis   - CIS Controls v8 IDs (e.g. "3" or "3.10")
 */

// ─── Framework reference tables ────────────────────────────────────────────────

/**
 * OWASP Top 10 2021 categories — used by tests + the CISO report header.
 */
const OWASP_TOP10 = {
  'A01:2021': 'Broken Access Control',
  'A02:2021': 'Cryptographic Failures',
  'A03:2021': 'Injection',
  'A04:2021': 'Insecure Design',
  'A05:2021': 'Security Misconfiguration',
  'A06:2021': 'Vulnerable and Outdated Components',
  'A07:2021': 'Identification and Authentication Failures',
  'A08:2021': 'Software and Data Integrity Failures',
  'A09:2021': 'Security Logging and Monitoring Failures',
  'A10:2021': 'Server-Side Request Forgery (SSRF)',
};

/**
 * SOC2 Trust Service Criteria — relevant codes for the kinds of findings
 * GateTest produces. Not exhaustive; covers Security (CC6.x), System
 * Operations (CC7.x), Change Management (CC8.x), Communication (CC2.x),
 * Risk Assessment (CC3.x, CC9.x), Availability (A1.x), Processing
 * Integrity (PI1.x), Privacy (P4.x, P8.x).
 */
const SOC2_CRITERIA = {
  'CC2.2': 'Internal Communications — communicate information to enable entity objectives',
  'CC3.1': 'Risk Assessment — identify and assess risks to achieving objectives',
  'CC6.1': 'Logical and Physical Access Controls — restrict logical access to software',
  'CC6.6': 'Network and Logical Access — restrict access with security boundaries',
  'CC6.7': 'Transmission and Disclosure — data in transit protected',
  'CC6.8': 'Prevent Unauthorized Access — prevent logical access by unauthorized entities',
  'CC7.1': 'System Operations — detect and monitor for configuration changes',
  'CC7.2': 'Threat Intelligence — monitor for new vulnerabilities',
  'CC8.1': 'Change Management — authorise, design, develop, and implement changes',
  'CC9.1': 'Risk Mitigation — identify and assess risks from business disruption',
  'A1.1':  'Availability — maintain and monitor performance capacity',
  'PI1.1': 'Processing Integrity — processing is complete, valid, accurate, timely',
  'P4.1':  'Privacy — collect personal information consistent with objectives',
  'P8.1':  'Privacy — remediate privacy incidents and complaints',
};

/**
 * CIS Controls v8 — the 18 controls. We store the top-level number and
 * additionally surface specific safeguard IDs (e.g. "3.10") where a module
 * maps cleanly to a single safeguard.
 */
const CIS_CONTROLS = {
  '1':  'Inventory and Control of Enterprise Assets',
  '2':  'Inventory and Control of Software Assets',
  '3':  'Data Protection',
  '4':  'Secure Configuration of Enterprise Assets and Software',
  '5':  'Account Management',
  '6':  'Access Control Management',
  '7':  'Continuous Vulnerability Management',
  '8':  'Audit Log Management',
  '9':  'Email and Web Browser Protections',
  '10': 'Malware Defenses',
  '11': 'Data Recovery',
  '12': 'Network Infrastructure Management',
  '13': 'Network Monitoring and Defense',
  '14': 'Security Awareness and Skills Training',
  '15': 'Service Provider Management',
  '16': 'Application Software Security',
  '17': 'Incident Response Management',
  '18': 'Penetration Testing',
};

// ─── Per-module compliance mapping table ───────────────────────────────────────

/**
 * Module → { owasp[], soc2[], cis[] }. Every entry is hand-curated.
 * When adding a new GateTest module, add a row here and a test asserting
 * coverage in tests/compliance-mappings.test.js.
 */
const MODULE_COMPLIANCE = {
  // ── Security / cryptography / transport ──────────────────────────────────
  secrets: {
    owasp: ['A02:2021', 'A07:2021'],
    soc2:  ['CC6.1', 'CC6.8'],
    cis:   ['3', '5'],
  },
  secretRotation: {
    owasp: ['A02:2021', 'A07:2021'],
    soc2:  ['CC6.1', 'CC6.8'],
    cis:   ['3', '5'],
  },
  tlsSecurity: {
    owasp: ['A02:2021', 'A05:2021'],
    soc2:  ['CC6.7', 'CC6.6'],
    cis:   ['3', '4'],
  },
  cookieSecurity: {
    owasp: ['A02:2021', 'A05:2021', 'A07:2021'],
    soc2:  ['CC6.7', 'CC6.1'],
    cis:   ['3', '4', '6'],
  },
  ssrf: {
    owasp: ['A10:2021'],
    soc2:  ['CC6.8'],
    cis:   ['13', '16'],
  },
  hardcodedUrl: {
    owasp: ['A01:2021', 'A05:2021'],
    soc2:  ['CC6.6'],
    cis:   ['4', '12'],
  },
  webHeaders: {
    owasp: ['A05:2021'],
    soc2:  ['CC6.6'],
    cis:   ['4', '16'],
  },
  security: {
    owasp: ['A03:2021', 'A05:2021', 'A02:2021'],
    soc2:  ['CC6.1', 'CC6.8'],
    cis:   ['3', '4', '16'],
  },

  // ── Logging / monitoring / privacy ───────────────────────────────────────
  logPii: {
    owasp: ['A09:2021'],
    soc2:  ['CC2.2', 'P4.1', 'P8.1'],
    cis:   ['3', '8'],
  },
  errorSwallow: {
    owasp: ['A09:2021'],
    soc2:  ['CC7.1'],
    cis:   ['8'],
  },

  // ── Concurrency / data integrity ─────────────────────────────────────────
  raceCondition: {
    owasp: ['A04:2021'],
    soc2:  ['PI1.1', 'A1.1'],
    cis:   ['16'],
  },
  moneyFloat: {
    owasp: ['A04:2021'],
    soc2:  ['PI1.1'],
    cis:   ['16'],
  },
  dataIntegrity: {
    owasp: ['A04:2021', 'A08:2021'],
    soc2:  ['PI1.1'],
    cis:   ['16'],
  },

  // ── Reliability / resource hygiene ───────────────────────────────────────
  resourceLeak: {
    owasp: ['A04:2021'],
    soc2:  ['A1.1'],
    cis:   ['16'],
  },
  nPlusOne: {
    owasp: ['A04:2021'],
    soc2:  ['A1.1'],
    cis:   ['16'],
  },
  retryHygiene: {
    owasp: ['A04:2021'],
    soc2:  ['A1.1', 'CC9.1'],
    cis:   ['16'],
  },
  asyncIteration: {
    owasp: ['A04:2021'],
    soc2:  ['PI1.1'],
    cis:   ['16'],
  },
  redos: {
    owasp: ['A06:2021'],
    soc2:  ['A1.1'],
    cis:   ['16'],
  },

  // ── Supply chain / dependencies ──────────────────────────────────────────
  dependencies: {
    owasp: ['A06:2021'],
    soc2:  ['CC7.2', 'CC8.1'],
    cis:   ['2', '7'],
  },

  // ── Infrastructure / IaC / CI ────────────────────────────────────────────
  dockerfile: {
    owasp: ['A05:2021', 'A06:2021'],
    soc2:  ['CC7.1', 'CC8.1'],
    cis:   ['2', '4'],
  },
  kubernetes: {
    owasp: ['A05:2021'],
    soc2:  ['CC7.1', 'CC6.6'],
    cis:   ['4', '12'],
  },
  terraform: {
    owasp: ['A05:2021'],
    soc2:  ['CC7.1', 'CC8.1'],
    cis:   ['4'],
  },
  ciSecurity: {
    owasp: ['A05:2021', 'A08:2021'],
    soc2:  ['CC8.1', 'CC6.8'],
    cis:   ['4', '16'],
  },
  shell: {
    owasp: ['A03:2021', 'A05:2021'],
    soc2:  ['CC6.8', 'CC8.1'],
    cis:   ['4', '16'],
  },
  sqlMigrations: {
    owasp: ['A03:2021', 'A04:2021'],
    soc2:  ['CC7.1', 'A1.1'],
    cis:   ['4', '11'],
  },
  envVars: {
    owasp: ['A05:2021'],
    soc2:  ['CC6.1'],
    cis:   ['3', '4'],
  },

  // ── AI / LLM safety ──────────────────────────────────────────────────────
  promptSafety: {
    owasp: ['A05:2021', 'A08:2021'],
    soc2:  ['CC7.2', 'CC3.1'],
    cis:   ['16'],
  },

  // ── Specs / contract drift ───────────────────────────────────────────────
  openapiDrift: {
    owasp: ['A05:2021'],
    soc2:  ['CC8.1', 'PI1.1'],
    cis:   ['16'],
  },

  // ── Code hygiene / quality / typing ──────────────────────────────────────
  deadCode: {
    owasp: ['A04:2021'],
    soc2:  ['CC8.1'],
    cis:   ['16'],
  },
  typescriptStrictness: {
    owasp: ['A04:2021'],
    soc2:  ['CC8.1'],
    cis:   ['16'],
  },
  lint: {
    owasp: ['A04:2021'],
    soc2:  ['CC8.1'],
    cis:   ['16'],
  },
  codeQuality: {
    owasp: ['A04:2021'],
    soc2:  ['CC8.1'],
    cis:   ['16'],
  },
  flakyTests: {
    owasp: ['A04:2021'],
    soc2:  ['CC8.1', 'PI1.1'],
    cis:   ['16'],
  },
  importCycle: {
    owasp: ['A04:2021'],
    soc2:  ['CC8.1'],
    cis:   ['16'],
  },
  datetimeBug: {
    owasp: ['A04:2021'],
    soc2:  ['PI1.1'],
    cis:   ['16'],
  },
  cronExpression: {
    owasp: ['A04:2021'],
    soc2:  ['A1.1', 'CC7.1'],
    cis:   ['16'],
  },
  featureFlag: {
    owasp: ['A05:2021'],
    soc2:  ['CC8.1'],
    cis:   ['4', '16'],
  },
  fakeFixDetector: {
    owasp: ['A04:2021'],
    soc2:  ['CC8.1'],
    cis:   ['16'],
  },

  // ── Cross-file / taint / SSRF cousins ────────────────────────────────────
  crossFileTaint: {
    owasp: ['A03:2021'],
    soc2:  ['CC6.8'],
    cis:   ['16'],
  },

  // ── Unicode / supply-chain text-attacks ──────────────────────────────────
  homoglyph: {
    owasp: ['A08:2021'],
    soc2:  ['CC6.8', 'CC8.1'],
    cis:   ['16'],
  },

  // ── Workflow hygiene ─────────────────────────────────────────────────────
  prSize: {
    owasp: ['A04:2021'],
    soc2:  ['CC8.1'],
    cis:   ['16'],
  },
  prQuality: {
    owasp: ['A04:2021'],
    soc2:  ['CC8.1'],
    cis:   ['16'],
  },

  // ── UX / surface quality ─────────────────────────────────────────────────
  accessibility: {
    // Accessibility doesn't fit OWASP cleanly — generic A04 (Insecure
    // Design) acknowledges the workflow-hygiene shape without inventing
    // a precise vuln match.
    owasp: ['A04:2021'],
    soc2:  ['CC8.1'],
    cis:   ['16'],
  },
  performance: {
    owasp: ['A04:2021'],
    soc2:  ['A1.1'],
    cis:   ['16'],
  },
  seo: {
    owasp: ['A04:2021'],
    soc2:  ['CC8.1'],
    cis:   ['16'],
  },
  links: {
    owasp: ['A04:2021'],
    soc2:  ['CC8.1'],
    cis:   ['16'],
  },
};

/**
 * Fallback mapping for unknown modules. Deliberately generic so unmapped
 * findings still appear in the framework tables ("see appendix" shape).
 */
const FALLBACK_MAPPING = Object.freeze({
  owasp: ['A04:2021'],   // Insecure Design — the catch-all "broad systemic" bucket
  soc2:  ['CC8.1'],      // Change Management — every finding implies a change request
  cis:   ['16'],         // Application Software Security — the umbrella for code-level findings
});

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns the compliance mapping for a given module name. Falls back to
 * a generic mapping for unknown modules — never returns null/undefined.
 *
 * Accepts the bare module name (e.g. "secrets") OR a finding-style label
 * like "secrets:hardcoded-key" — the prefix before ":" is treated as the
 * module name.
 *
 * @param {string} moduleName
 * @returns {ComplianceMapping}
 */
function getComplianceMapping(moduleName) {
  if (typeof moduleName !== 'string' || moduleName.length === 0) {
    return { ...FALLBACK_MAPPING };
  }
  const base = moduleName.split(':')[0];
  const hit = MODULE_COMPLIANCE[base];
  if (hit) {
    // Return a defensive copy so callers can't mutate the canonical table.
    return {
      owasp: [...hit.owasp],
      soc2:  [...hit.soc2],
      cis:   [...hit.cis],
    };
  }
  return { ...FALLBACK_MAPPING };
}

/**
 * Returns the list of module names that have explicit mappings. Useful
 * for tests + coverage audits.
 *
 * @returns {string[]}
 */
function listMappedModules() {
  return Object.keys(MODULE_COMPLIANCE);
}

/**
 * Returns true if the module has an explicit (non-fallback) mapping.
 *
 * @param {string} moduleName
 * @returns {boolean}
 */
function hasExplicitMapping(moduleName) {
  if (typeof moduleName !== 'string') return false;
  const base = moduleName.split(':')[0];
  return Object.prototype.hasOwnProperty.call(MODULE_COMPLIANCE, base);
}

module.exports = {
  getComplianceMapping,
  hasExplicitMapping,
  listMappedModules,
  // Reference tables — exported so the CISO report renderer can show
  // titles next to each control code.
  OWASP_TOP10,
  SOC2_CRITERIA,
  CIS_CONTROLS,
  // Constants for tests / audits.
  FALLBACK_MAPPING,
  MODULE_COMPLIANCE,
};
