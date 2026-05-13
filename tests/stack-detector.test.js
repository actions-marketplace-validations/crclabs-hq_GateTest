// =============================================================================
// STACK-DETECTOR TEST — lib/stack-detector.js
// =============================================================================
// Auto-detects the customer's tech stack (languages, frameworks, databases,
// deploy targets, CI) by reading concrete config files. Output goes into
// Claude prompts to sharpen diagnoses.
//
// All tests use the fileContents shortcut so no temp directories needed.
// =============================================================================

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  detectStack,
  renderStackSummary,
  formatStackHeader,
  detectJsTs,
  detectPython,
  detectGo,
  detectRust,
  detectRuby,
  detectPhp,
  detectJava,
  detectDeploy,
  detectCi,
} = require('../lib/stack-detector');

const ROOT = '/fake/project';
const F = (rel) => `${ROOT}/${rel}`;

// ---------------------------------------------------------------------------
// JS / TS
// ---------------------------------------------------------------------------

describe('detectJsTs', () => {
  it('returns null when no package.json', () => {
    assert.equal(detectJsTs(ROOT, {}), null);
  });

  it('detects Next.js + React + Prisma + TypeScript', () => {
    const pkg = JSON.stringify({
      dependencies: { next: '16.0.0', react: '19.0.0', '@prisma/client': '5.0.0' },
      devDependencies: { typescript: '5.0.0' },
    });
    const result = detectJsTs(ROOT, { [F('package.json')]: pkg });
    assert.equal(result.language, 'TypeScript');
    assert.ok(result.frameworks.find((f) => f.label === 'Next.js'));
    assert.ok(result.frameworks.find((f) => f.label === 'React'));
    assert.ok(result.databases.find((d) => d.label === 'Prisma'));
  });

  it('detects JavaScript (no TypeScript) when no tsconfig and no typescript dep', () => {
    const pkg = JSON.stringify({ dependencies: { express: '4.0.0' } });
    const result = detectJsTs(ROOT, { [F('package.json')]: pkg });
    assert.equal(result.language, 'JavaScript');
  });

  it('detects TypeScript via tsconfig.json even without the typescript dep declared', () => {
    const pkg = JSON.stringify({ dependencies: { next: '16.0.0' } });
    const result = detectJsTs(ROOT, {
      [F('package.json')]: pkg,
      [F('tsconfig.json')]: '{}',
    });
    assert.equal(result.language, 'TypeScript');
  });

  it('detects pnpm via pnpm-lock.yaml', () => {
    const result = detectJsTs(ROOT, {
      [F('package.json')]: '{}',
      [F('pnpm-lock.yaml')]: 'lockfileVersion: 6',
    });
    assert.equal(result.packageManager, 'pnpm');
  });

  it('detects yarn over npm when both lockfiles present', () => {
    const result = detectJsTs(ROOT, {
      [F('package.json')]: '{}',
      [F('yarn.lock')]: '# yarn lockfile v1',
      [F('package-lock.json')]: '{}',
    });
    assert.equal(result.packageManager, 'yarn');
  });

  it('captures multiple frameworks when stack is hybrid', () => {
    const pkg = JSON.stringify({
      dependencies: { next: '16', react: '19', vite: '5', express: '4' },
    });
    const result = detectJsTs(ROOT, { [F('package.json')]: pkg });
    assert.ok(result.frameworks.length >= 4);
  });

  it('survives malformed package.json without throwing', () => {
    const result = detectJsTs(ROOT, { [F('package.json')]: '{not valid json' });
    assert.equal(result, null);
  });

  it('reports Node engines when declared', () => {
    const pkg = JSON.stringify({ dependencies: {}, engines: { node: '>=20' } });
    const result = detectJsTs(ROOT, { [F('package.json')]: pkg });
    assert.match(result.runtime, />=20/);
  });
});

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

describe('detectPython', () => {
  it('returns null when no manifest', () => {
    assert.equal(detectPython(ROOT, {}), null);
  });

  it('detects Django from requirements.txt', () => {
    const result = detectPython(ROOT, { [F('requirements.txt')]: 'Django==5.0\npsycopg2==2.9' });
    assert.equal(result.language, 'Python');
    assert.ok(result.frameworks.find((f) => f.label === 'Django'));
    assert.ok(result.databases.find((d) => d.label === 'psycopg2'));
  });

  it('detects FastAPI from pyproject.toml (case-insensitive)', () => {
    const toml = '[project]\ndependencies = ["FastAPI>=0.100", "sqlalchemy>=2"]';
    const result = detectPython(ROOT, { [F('pyproject.toml')]: toml });
    assert.ok(result.frameworks.find((f) => f.label === 'FastAPI'));
    assert.ok(result.databases.find((d) => d.label === 'SQLAlchemy'));
  });

  it('detects pytest when present', () => {
    const result = detectPython(ROOT, { [F('requirements.txt')]: 'flask\npytest' });
    assert.ok(result.testTools.find((t) => t.label === 'pytest'));
  });

  it('chooses poetry/uv when pyproject.toml is the only manifest', () => {
    const result = detectPython(ROOT, { [F('pyproject.toml')]: '[project]\nname="x"' });
    assert.match(result.packageManager, /pyproject/);
  });
});

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------

describe('detectGo', () => {
  it('returns null when no go.mod', () => {
    assert.equal(detectGo(ROOT, {}), null);
  });

  it('parses module name + go version + Gin framework', () => {
    const gomod = `module github.com/acme/api

go 1.22

require github.com/gin-gonic/gin v1.10.0`;
    const result = detectGo(ROOT, { [F('go.mod')]: gomod });
    assert.equal(result.moduleName, 'github.com/acme/api');
    assert.equal(result.runtime, 'Go 1.22');
    assert.ok(result.frameworks.find((f) => f.label === 'Gin'));
  });
});

// ---------------------------------------------------------------------------
// Rust
// ---------------------------------------------------------------------------

describe('detectRust', () => {
  it('returns null when no Cargo.toml', () => {
    assert.equal(detectRust(ROOT, {}), null);
  });

  it('detects Axum + SQLx', () => {
    const cargo = `[package]
name = "api"
[dependencies]
axum = "0.7"
sqlx = "0.7"`;
    const result = detectRust(ROOT, { [F('Cargo.toml')]: cargo });
    assert.ok(result.frameworks.find((f) => f.label === 'Axum'));
    assert.ok(result.databases.find((d) => d.label === 'SQLx'));
  });
});

// ---------------------------------------------------------------------------
// Ruby
// ---------------------------------------------------------------------------

describe('detectRuby', () => {
  it('detects Rails when in Gemfile single-quoted', () => {
    const gemfile = `source "https://rubygems.org"
gem 'rails', '~> 7.1'`;
    const result = detectRuby(ROOT, { [F('Gemfile')]: gemfile });
    assert.ok(result.frameworks.find((f) => f.label === 'Rails'));
  });

  it('detects RSpec when present', () => {
    const gemfile = `gem "sinatra"\ngem "rspec"`;
    const result = detectRuby(ROOT, { [F('Gemfile')]: gemfile });
    assert.ok(result.testTools.find((t) => t.label === 'RSpec'));
  });
});

// ---------------------------------------------------------------------------
// PHP
// ---------------------------------------------------------------------------

describe('detectPhp', () => {
  it('detects Laravel + PHPUnit from composer.json', () => {
    const composer = JSON.stringify({
      require: { php: '>=8.2', 'laravel/framework': '^11.0' },
      'require-dev': { 'phpunit/phpunit': '^11.0' },
    });
    const result = detectPhp(ROOT, { [F('composer.json')]: composer });
    assert.ok(result.frameworks.find((f) => f.label === 'Laravel'));
    assert.ok(result.testTools.find((t) => t.label === 'PHPUnit'));
    assert.match(result.runtime, />=8\.2/);
  });
});

// ---------------------------------------------------------------------------
// Java / Kotlin
// ---------------------------------------------------------------------------

describe('detectJava', () => {
  it('detects Spring Boot from pom.xml', () => {
    const pom = '<dependency><artifactId>spring-boot-starter</artifactId></dependency>';
    const result = detectJava(ROOT, { [F('pom.xml')]: pom });
    assert.ok(result.frameworks.find((f) => f.label === 'Spring Boot'));
    assert.equal(result.packageManager, 'maven');
  });

  it('flags Kotlin when build.gradle.kts mentions kotlin', () => {
    const gradle = `plugins { id("org.jetbrains.kotlin.jvm") version "1.9" }
dependencies { implementation("io.quarkus:quarkus-core:3.5") }`;
    const result = detectJava(ROOT, { [F('build.gradle.kts')]: gradle });
    assert.match(result.language, /Kotlin/);
    assert.equal(result.packageManager, 'gradle');
    assert.ok(result.frameworks.find((f) => f.label === 'Quarkus'));
  });
});

// ---------------------------------------------------------------------------
// Deploy / CI
// ---------------------------------------------------------------------------

describe('detectDeploy', () => {
  it('flags Vercel + Docker when both files present', () => {
    const hits = detectDeploy(ROOT, {
      [F('vercel.json')]: '{}',
      [F('Dockerfile')]: 'FROM node:20',
    });
    assert.ok(hits.includes('Vercel'));
    assert.ok(hits.includes('Docker'));
  });

  it('returns empty array when nothing matches', () => {
    assert.deepEqual(detectDeploy(ROOT, {}), []);
  });

  it('flags SST when sst.config.ts present', () => {
    const hits = detectDeploy(ROOT, { [F('sst.config.ts')]: 'export default $config({})' });
    assert.ok(hits.includes('SST'));
  });
});

describe('detectCi', () => {
  it('flags GitHub Actions from a named workflow file', () => {
    const hits = detectCi(ROOT, { [F('.github/workflows/ci.yml')]: 'name: CI' });
    assert.ok(hits.includes('GitHub Actions'));
  });

  it('flags CircleCI', () => {
    const hits = detectCi(ROOT, { [F('.circleci/config.yml')]: 'version: 2.1' });
    assert.ok(hits.includes('CircleCI'));
  });

  it('flags Jenkins via Jenkinsfile', () => {
    const hits = detectCi(ROOT, { [F('Jenkinsfile')]: 'pipeline { }' });
    assert.ok(hits.includes('Jenkins'));
  });
});

// ---------------------------------------------------------------------------
// detectStack — full assembly
// ---------------------------------------------------------------------------

describe('detectStack — full assembly', () => {
  it('throws when projectRoot missing', () => {
    assert.throws(() => detectStack({}), /projectRoot/);
  });

  it('returns unknown-stack profile for an empty repo', () => {
    const r = detectStack({ projectRoot: ROOT, fileContents: {} });
    assert.deepEqual(r.languages, []);
    assert.match(r.summary, /unknown/);
  });

  it('assembles a complete profile for a real-shaped Next.js stack', () => {
    const pkg = JSON.stringify({
      dependencies: { next: '16', react: '19', '@prisma/client': '5' },
      devDependencies: { typescript: '5', vitest: '1', '@playwright/test': '1' },
    });
    const r = detectStack({
      projectRoot: ROOT,
      fileContents: {
        [F('package.json')]: pkg,
        [F('tsconfig.json')]: '{}',
        [F('pnpm-lock.yaml')]: 'lockfileVersion: 6',
        [F('vercel.json')]: '{}',
        [F('.github/workflows/ci.yml')]: 'name: CI',
      },
    });
    assert.equal(r.languages.length, 1);
    assert.equal(r.languages[0].language, 'TypeScript');
    assert.ok(r.frameworks.find((f) => f.label === 'Next.js'));
    assert.ok(r.databases.find((d) => d.label === 'Prisma'));
    assert.ok(r.testTools.find((t) => t.label === 'Vitest'));
    assert.ok(r.testTools.find((t) => t.label === 'Playwright'));
    assert.deepEqual(r.deploy, ['Vercel']);
    assert.deepEqual(r.ci, ['GitHub Actions']);
    assert.deepEqual(r.packageManagers, ['pnpm']);
  });

  it('handles polyglot repos (JS + Python both detected)', () => {
    const pkg = JSON.stringify({ dependencies: { express: '4' } });
    const reqs = 'Flask==3.0\npsycopg2-binary==2.9';
    const r = detectStack({
      projectRoot: ROOT,
      fileContents: { [F('package.json')]: pkg, [F('requirements.txt')]: reqs },
    });
    assert.equal(r.languages.length, 2);
    const langNames = r.languages.map((l) => l.language).sort();
    assert.deepEqual(langNames, ['JavaScript', 'Python']);
    assert.ok(r.frameworks.find((f) => f.label === 'Express'));
    assert.ok(r.frameworks.find((f) => f.label === 'Flask'));
  });

  it('deduplicates frameworks that appear in multiple languages with same label', () => {
    // Express is JS-only here, but the dedup check should still pass.
    const pkg = JSON.stringify({ dependencies: { express: '4' }, devDependencies: { express: '4' } });
    const r = detectStack({ projectRoot: ROOT, fileContents: { [F('package.json')]: pkg } });
    const expressHits = r.frameworks.filter((f) => f.label === 'Express');
    assert.equal(expressHits.length, 1);
  });
});

// ---------------------------------------------------------------------------
// renderStackSummary / formatStackHeader
// ---------------------------------------------------------------------------

describe('renderStackSummary', () => {
  it('builds one-line summary in expected shape', () => {
    const summary = renderStackSummary({
      languages: [{ language: 'TypeScript' }],
      frameworks: [{ label: 'Next.js' }, { label: 'React' }],
      databases: [{ label: 'Prisma' }],
      deploy: ['Vercel'],
    });
    assert.equal(summary, 'STACK: TypeScript (Next.js, React) + Prisma on Vercel');
  });

  it('drops empty sections gracefully', () => {
    const summary = renderStackSummary({
      languages: [{ language: 'Python' }],
      frameworks: [],
      databases: [],
      deploy: [],
    });
    assert.equal(summary, 'STACK: Python');
  });

  it('marks unknown when no languages', () => {
    const summary = renderStackSummary({ languages: [], frameworks: [], databases: [], deploy: [] });
    assert.match(summary, /unknown/);
  });
});

describe('formatStackHeader', () => {
  it('builds multi-line header with STACK + TEST TOOLS + CI', () => {
    const stack = {
      summary: 'STACK: TypeScript (Next.js)',
      testTools: [{ label: 'Vitest' }, { label: 'Playwright' }],
      ci: ['GitHub Actions'],
    };
    const header = formatStackHeader(stack);
    assert.match(header, /STACK: TypeScript/);
    assert.match(header, /TEST TOOLS: Vitest, Playwright/);
    assert.match(header, /CI: GitHub Actions/);
    assert.ok(header.endsWith('\n\n'));
  });

  it('returns empty string when no stack', () => {
    assert.equal(formatStackHeader(null), '');
    assert.equal(formatStackHeader({}), '');
  });
});
