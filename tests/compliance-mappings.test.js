'use strict';

// ============================================================================
// COMPLIANCE-MAPPINGS TEST — Nuclear-tier CISO report backbone
// ============================================================================
// Covers website/app/lib/compliance-mappings.js — the canonical
// module → { owasp, soc2, cis } table used by the CISO report generator
// to attribute every finding to a compliance framework.
//
// The CISO report (Nuclear $399 tier deliverable) MUST cite OWASP Top
// 10, SOC2 Trust Service Criteria, and CIS Controls v8. This module is
// the single source of truth for that attribution. If a module added to
// the GateTest catalogue lacks a mapping here, the report falls back to
// a generic mapping — but high-signal modules (security, privacy, IaC)
// MUST be explicitly mapped so the report reads as authoritative.
// ============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  getComplianceMapping,
  hasExplicitMapping,
  listMappedModules,
  OWASP_TOP10,
  SOC2_CRITERIA,
  CIS_CONTROLS,
  FALLBACK_MAPPING,
  MODULE_COMPLIANCE,
} = require('../website/app/lib/compliance-mappings');

// ─── Canonical module list the Nuclear tier customer is likely to hit ────
// The brief names these explicitly as the minimum coverage bar.
const CANONICAL_MODULES = [
  'security',
  'ssrf',
  'tlsSecurity',
  'cookieSecurity',
  'secrets',
  'hardcodedUrl',
  'logPii',
  'moneyFloat',
  'errorSwallow',
  'raceCondition',
  'redos',
  'openapiDrift',
  'secretRotation',
  'webHeaders',
  'dependencies',
  'dockerfile',
  'ciSecurity',
  'kubernetes',
  'terraform',
  'sqlMigrations',
  'dataIntegrity',
  'accessibility',
  'performance',
  'prSize',
  'prQuality',
  'fakeFixDetector',
  'typescriptStrictness',
  'envVars',
  'importCycle',
  'homoglyph',
];

// ─── Shape assertions ────────────────────────────────────────────────────────

describe('compliance-mappings — shape', () => {
  it('getComplianceMapping returns { owasp, soc2, cis } arrays for known module', () => {
    const m = getComplianceMapping('secrets');
    assert.ok(Array.isArray(m.owasp));
    assert.ok(Array.isArray(m.soc2));
    assert.ok(Array.isArray(m.cis));
    assert.ok(m.owasp.length > 0);
    assert.ok(m.soc2.length > 0);
    assert.ok(m.cis.length > 0);
  });

  it('every CANONICAL_MODULE returns a non-null mapping', () => {
    for (const mod of CANONICAL_MODULES) {
      const m = getComplianceMapping(mod);
      assert.ok(m, `mapping for ${mod} should not be null`);
      assert.ok(Array.isArray(m.owasp), `${mod}.owasp should be array`);
      assert.ok(Array.isArray(m.soc2), `${mod}.soc2 should be array`);
      assert.ok(Array.isArray(m.cis), `${mod}.cis should be array`);
    }
  });

  it('every CANONICAL_MODULE has at least one OWASP / SOC2 / CIS code', () => {
    for (const mod of CANONICAL_MODULES) {
      const m = getComplianceMapping(mod);
      assert.ok(m.owasp.length >= 1, `${mod} missing OWASP coverage`);
      assert.ok(m.soc2.length >= 1, `${mod} missing SOC2 coverage`);
      assert.ok(m.cis.length >= 1, `${mod} missing CIS coverage`);
    }
  });
});

// ─── Fallback semantics ──────────────────────────────────────────────────────

describe('compliance-mappings — fallback', () => {
  it('unknown module returns the FALLBACK_MAPPING shape (not null/undefined)', () => {
    const m = getComplianceMapping('this-module-does-not-exist');
    assert.ok(m, 'fallback mapping should not be null');
    assert.deepEqual(m.owasp, FALLBACK_MAPPING.owasp);
    assert.deepEqual(m.soc2, FALLBACK_MAPPING.soc2);
    assert.deepEqual(m.cis, FALLBACK_MAPPING.cis);
  });

  it('empty string returns the FALLBACK_MAPPING', () => {
    const m = getComplianceMapping('');
    assert.deepEqual(m.owasp, FALLBACK_MAPPING.owasp);
  });

  it('non-string input returns the FALLBACK_MAPPING (defensive)', () => {
    const m1 = getComplianceMapping(null);
    const m2 = getComplianceMapping(undefined);
    const m3 = getComplianceMapping(42);
    assert.ok(Array.isArray(m1.owasp));
    assert.ok(Array.isArray(m2.owasp));
    assert.ok(Array.isArray(m3.owasp));
  });

  it('hasExplicitMapping distinguishes mapped vs fallback', () => {
    assert.equal(hasExplicitMapping('secrets'), true);
    assert.equal(hasExplicitMapping('unknown-module'), false);
    assert.equal(hasExplicitMapping(''), false);
    assert.equal(hasExplicitMapping(null), false);
  });
});

// ─── Module-name normalisation ───────────────────────────────────────────────

describe('compliance-mappings — module name normalisation', () => {
  it('finding-style label ("secrets:hardcoded-key") resolves to bare module', () => {
    const a = getComplianceMapping('secrets');
    const b = getComplianceMapping('secrets:hardcoded-key');
    assert.deepEqual(a, b);
  });

  it('hasExplicitMapping recognises finding-style labels', () => {
    assert.equal(hasExplicitMapping('tlsSecurity:bypass-found'), true);
  });
});

// ─── Reference table shape ───────────────────────────────────────────────────

describe('compliance-mappings — reference tables', () => {
  it('OWASP_TOP10 covers A01 through A10', () => {
    for (let i = 1; i <= 10; i++) {
      const key = `A${String(i).padStart(2, '0')}:2021`;
      assert.ok(OWASP_TOP10[key], `OWASP_TOP10 missing ${key}`);
    }
  });

  it('SOC2_CRITERIA includes core CC6 security controls', () => {
    assert.ok(SOC2_CRITERIA['CC6.1']);
    assert.ok(SOC2_CRITERIA['CC6.6']);
    assert.ok(SOC2_CRITERIA['CC6.7']);
    assert.ok(SOC2_CRITERIA['CC6.8']);
  });

  it('CIS_CONTROLS covers numbers 1 through 18 with no gaps in the data-protection / security blocks', () => {
    // We deliberately don't require ALL 18 (10 / 14 are operational
    // controls less applicable to a code-scanner). Verify the
    // application-security-relevant ones are present.
    for (const key of ['1', '2', '3', '4', '5', '6', '7', '8', '12', '13', '16', '18']) {
      assert.ok(CIS_CONTROLS[key], `CIS_CONTROLS missing ${key}`);
    }
  });
});

// ─── Mapping integrity ──────────────────────────────────────────────────────

describe('compliance-mappings — mapping integrity', () => {
  it('every OWASP code in the mapping table exists in OWASP_TOP10', () => {
    for (const [mod, m] of Object.entries(MODULE_COMPLIANCE)) {
      for (const code of m.owasp) {
        assert.ok(OWASP_TOP10[code], `${mod} references unknown OWASP code ${code}`);
      }
    }
  });

  it('every SOC2 code in the mapping table exists in SOC2_CRITERIA', () => {
    for (const [mod, m] of Object.entries(MODULE_COMPLIANCE)) {
      for (const code of m.soc2) {
        assert.ok(SOC2_CRITERIA[code], `${mod} references unknown SOC2 code ${code}`);
      }
    }
  });

  it('every CIS code in the mapping table exists in CIS_CONTROLS', () => {
    for (const [mod, m] of Object.entries(MODULE_COMPLIANCE)) {
      for (const code of m.cis) {
        // CIS may include sub-safeguard IDs ("3.10"); strip to top-level.
        const top = String(code).split('.')[0];
        assert.ok(CIS_CONTROLS[top], `${mod} references unknown CIS control ${code}`);
      }
    }
  });

  it('listMappedModules covers every entry in MODULE_COMPLIANCE', () => {
    const listed = listMappedModules();
    const expected = Object.keys(MODULE_COMPLIANCE);
    assert.equal(listed.length, expected.length);
    for (const k of expected) {
      assert.ok(listed.includes(k), `listMappedModules missing ${k}`);
    }
  });
});

// ─── Defensive-copy semantics ────────────────────────────────────────────────

describe('compliance-mappings — defensive copy', () => {
  it('mutating the returned arrays does not affect subsequent calls', () => {
    const a = getComplianceMapping('secrets');
    a.owasp.push('FAKE:9999');
    a.soc2.push('FAKE.X');
    a.cis.push('99');
    const b = getComplianceMapping('secrets');
    assert.ok(!b.owasp.includes('FAKE:9999'));
    assert.ok(!b.soc2.includes('FAKE.X'));
    assert.ok(!b.cis.includes('99'));
  });
});

// ─── High-signal security modules MUST cite the right OWASP family ─────────

describe('compliance-mappings — high-signal correctness', () => {
  it('ssrf maps to OWASP A10 (SSRF category)', () => {
    const m = getComplianceMapping('ssrf');
    assert.ok(m.owasp.includes('A10:2021'), 'ssrf must cite A10');
  });

  it('secrets maps to OWASP A02 (Cryptographic Failures) and A07 (AuthN Failures)', () => {
    const m = getComplianceMapping('secrets');
    assert.ok(m.owasp.includes('A02:2021'));
    assert.ok(m.owasp.includes('A07:2021'));
  });

  it('logPii maps to OWASP A09 (Logging/Monitoring) and SOC2 privacy criteria', () => {
    const m = getComplianceMapping('logPii');
    assert.ok(m.owasp.includes('A09:2021'));
    assert.ok(m.soc2.some((c) => c.startsWith('P')), 'logPii should cite a privacy criterion');
  });

  it('dependencies maps to OWASP A06 (Vulnerable Components) + CIS 2/7 (software inventory + vuln mgmt)', () => {
    const m = getComplianceMapping('dependencies');
    assert.ok(m.owasp.includes('A06:2021'));
    assert.ok(m.cis.includes('2') || m.cis.includes('7'));
  });

  it('moneyFloat maps to SOC2 PI1.1 (Processing Integrity) — money correctness is processing integrity', () => {
    const m = getComplianceMapping('moneyFloat');
    assert.ok(m.soc2.includes('PI1.1'));
  });
});
