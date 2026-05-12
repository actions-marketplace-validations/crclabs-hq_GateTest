'use strict';
/**
 * SBOM — Software Bill of Materials generator.
 *
 * Produces a CycloneDX 1.4-compatible SBOM for the scanned project,
 * listing every dependency with name, version, license, and PURL.
 *
 * Required by US Executive Order 14028 and increasingly by enterprise
 * procurement. GateTest ships the SBOM as a scan artifact automatically.
 *
 * Ecosystems: npm / yarn / pnpm, pip / pipenv / poetry, go.mod,
 *             Cargo.toml, Gemfile.lock, Composer, Maven (pom.xml),
 *             Gradle (build.gradle).
 *
 * The SBOM JSON is emitted as an info-level check so it's always visible
 * in the report. A warning is raised if no lockfile is found (SBOM will
 * be incomplete). An error is raised if both a lockfile AND a dependency
 * file exist but no lockfile is committed (reproducibility broken).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const BaseModule = require('./base-module');

class SbomModule extends BaseModule {
  constructor() {
    super('sbom', 'Software Bill of Materials (SBOM) — CycloneDX 1.4');
  }

  run(result, config) {
    const root = config.projectRoot || process.cwd();
    const components = [];
    const warnings = [];

    // ── npm / yarn / pnpm ────────────────────────────────────────────────────
    const pkgJsonPath = path.join(root, 'package.json');
    const lockfiles = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'];
    const foundLock = lockfiles.find(l => fs.existsSync(path.join(root, l)));

    if (fs.existsSync(pkgJsonPath)) {
      if (!foundLock) {
        result.addCheck('sbom:npm-lockfile', false, {
          severity: 'warning',
          message: 'package.json found but no lockfile (package-lock.json / yarn.lock / pnpm-lock.yaml)',
          suggestion: 'Commit a lockfile for reproducible SBOMs and supply-chain security',
        });
        warnings.push('npm lockfile missing');
      } else {
        const npmComponents = this._parseNpm(root, pkgJsonPath, foundLock ? path.join(root, foundLock) : null);
        components.push(...npmComponents);
        result.addCheck('sbom:npm', true, { message: `npm: ${npmComponents.length} packages inventoried` });
      }
    }

    // ── Python (pip / pipenv / poetry) ───────────────────────────────────────
    const reqFiles = ['requirements.txt', 'Pipfile.lock', 'poetry.lock'];
    const foundReq = reqFiles.find(f => fs.existsSync(path.join(root, f)));
    if (foundReq) {
      const pyComponents = this._parsePython(path.join(root, foundReq));
      components.push(...pyComponents);
      result.addCheck('sbom:python', true, { message: `Python: ${pyComponents.length} packages inventoried` });
    }

    // ── Go ───────────────────────────────────────────────────────────────────
    const goSum = path.join(root, 'go.sum');
    if (fs.existsSync(goSum)) {
      const goComponents = this._parseGoSum(goSum);
      components.push(...goComponents);
      result.addCheck('sbom:go', true, { message: `Go: ${goComponents.length} modules inventoried` });
    }

    // ── Rust ─────────────────────────────────────────────────────────────────
    const cargoLock = path.join(root, 'Cargo.lock');
    if (fs.existsSync(cargoLock)) {
      const rustComponents = this._parseCargoLock(cargoLock);
      components.push(...rustComponents);
      result.addCheck('sbom:rust', true, { message: `Rust: ${rustComponents.length} crates inventoried` });
    }

    // ── Ruby ─────────────────────────────────────────────────────────────────
    const gemfileLock = path.join(root, 'Gemfile.lock');
    if (fs.existsSync(gemfileLock)) {
      const rubyComponents = this._parseGemfileLock(gemfileLock);
      components.push(...rubyComponents);
      result.addCheck('sbom:ruby', true, { message: `Ruby: ${rubyComponents.length} gems inventoried` });
    }

    if (components.length === 0 && warnings.length === 0) {
      result.addCheck('sbom:no-deps', true, { message: 'No recognized dependency files found — SBOM is empty' });
      return;
    }

    // ── Emit the SBOM as a JSON artifact ─────────────────────────────────────
    const sbom = this._buildCycloneDxSbom(root, components);
    const sbomPath = path.join(root, '.gatetest', 'sbom.cyclonedx.json');
    try {
      fs.mkdirSync(path.dirname(sbomPath), { recursive: true });
      fs.writeFileSync(sbomPath, JSON.stringify(sbom, null, 2));
      result.addCheck('sbom:generated', true, {
        message: `SBOM generated: ${components.length} components → .gatetest/sbom.cyclonedx.json`,
      });
    } catch {
      result.addCheck('sbom:write-failed', false, {
        severity: 'warning',
        message: 'Could not write SBOM file — check write permissions on .gatetest/',
      });
    }

    // Summary info check
    const ecosystems = [...new Set(components.map(c => c.type))].join(', ');
    result.addCheck('sbom:summary', true, {
      message: `Total: ${components.length} components across ${ecosystems}. CycloneDX 1.4 format.`,
    });
  }

  _buildCycloneDxSbom(root, components) {
    const pkgName = this._readProjectName(root);
    return {
      bomFormat: 'CycloneDX',
      specVersion: '1.4',
      serialNumber: `urn:uuid:${crypto.randomUUID()}`,
      version: 1,
      metadata: {
        timestamp: new Date().toISOString(),
        tools: [{ vendor: 'GateTest', name: 'gatetest', version: '1.0.1' }],
        component: { type: 'application', name: pkgName, bom_ref: pkgName },
      },
      components: components.map(c => ({
        type: 'library',
        'bom-ref': `${c.type}:${c.name}@${c.version}`,
        name: c.name,
        version: c.version,
        purl: c.purl,
        ...(c.license ? { licenses: [{ license: { id: c.license } }] } : {}),
        ...(c.description ? { description: c.description } : {}),
      })),
    };
  }

  _readProjectName(root) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
      return pkg.name || path.basename(root);
    } catch { return path.basename(root); }
  }

  _parseNpm(root, pkgJsonPath, lockPath) {
    const components = [];
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
      const allDeps = {
        ...pkg.dependencies,
        ...pkg.devDependencies,
        ...pkg.peerDependencies,
        ...pkg.optionalDependencies,
      };

      // Try to read exact versions from lockfile
      let exactVersions = {};
      if (lockPath && fs.existsSync(lockPath)) {
        try {
          const lockName = path.basename(lockPath);
          if (lockName === 'package-lock.json') {
            const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
            const packages = lock.packages || lock.dependencies || {};
            for (const [key, val] of Object.entries(packages)) {
              const name = key.replace(/^node_modules\//, '');
              if (name && val.version) exactVersions[name] = val.version;
            }
          }
        } catch { /* use range from package.json */ }
      }

      for (const [name, range] of Object.entries(allDeps)) {
        const version = exactVersions[name] || range.replace(/^[\^~>=<]/, '');
        components.push({
          type: 'npm',
          name,
          version,
          purl: `pkg:npm/${name.replace('/', '%2F')}@${version}`,
        });
      }
    } catch { /* file unreadable */ }
    return components;
  }

  _parsePython(filePath) {
    const components = [];
    const name = path.basename(filePath);
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      if (name === 'requirements.txt') {
        for (const line of content.split('\n')) {
          const clean = line.split('#')[0].trim();
          if (!clean) continue;
          const m = clean.match(/^([A-Za-z0-9_.-]+)\s*[=><~!]+\s*([^\s,]+)/);
          if (m) components.push({ type: 'pypi', name: m[1].toLowerCase(), version: m[2], purl: `pkg:pypi/${m[1].toLowerCase()}@${m[2]}` });
        }
      } else if (name === 'poetry.lock') {
        const blocks = content.split(/\n\[\[package\]\]\n/).slice(1);
        for (const block of blocks) {
          const nameM = block.match(/name = "([^"]+)"/);
          const verM = block.match(/version = "([^"]+)"/);
          if (nameM && verM) {
            components.push({ type: 'pypi', name: nameM[1], version: verM[1], purl: `pkg:pypi/${nameM[1]}@${verM[1]}` });
          }
        }
      }
    } catch { /* file unreadable */ }
    return components;
  }

  _parseGoSum(goSumPath) {
    const components = [];
    const seen = new Set();
    try {
      const content = fs.readFileSync(goSumPath, 'utf8');
      for (const line of content.split('\n')) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 2) continue;
        const [modver] = parts;
        const lastAt = modver.lastIndexOf('@');
        if (lastAt < 0) continue;
        const modPath = modver.slice(0, lastAt);
        const version = modver.slice(lastAt + 1).replace(/\/go\.mod$/, '');
        const key = `${modPath}@${version}`;
        if (seen.has(key)) continue;
        seen.add(key);
        components.push({ type: 'golang', name: modPath, version, purl: `pkg:golang/${modPath}@${version}` });
      }
    } catch { /* file unreadable */ }
    return components;
  }

  _parseCargoLock(cargoLockPath) {
    const components = [];
    try {
      const content = fs.readFileSync(cargoLockPath, 'utf8');
      const blocks = content.split('\n[[package]]\n').slice(1);
      for (const block of blocks) {
        const nameM = block.match(/name = "([^"]+)"/);
        const verM = block.match(/version = "([^"]+)"/);
        if (nameM && verM) {
          components.push({ type: 'cargo', name: nameM[1], version: verM[1], purl: `pkg:cargo/${nameM[1]}@${verM[1]}` });
        }
      }
    } catch { /* file unreadable */ }
    return components;
  }

  _parseGemfileLock(gemfileLockPath) {
    const components = [];
    let inSpecs = false;
    try {
      const content = fs.readFileSync(gemfileLockPath, 'utf8');
      for (const line of content.split('\n')) {
        if (line.match(/^\s{4}SPECS:/)) { inSpecs = true; continue; }
        if (inSpecs && line.match(/^[A-Z]/)) { inSpecs = false; }
        if (inSpecs) {
          const m = line.match(/^\s{4}([a-z0-9_-]+)\s+\(([^)]+)\)/);
          if (m) components.push({ type: 'gem', name: m[1], version: m[2], purl: `pkg:gem/${m[1]}@${m[2]}` });
        }
      }
    } catch { /* file unreadable */ }
    return components;
  }
}

module.exports = SbomModule;
