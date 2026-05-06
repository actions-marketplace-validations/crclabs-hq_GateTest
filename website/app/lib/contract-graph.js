'use strict';

/**
 * Phase 6.2.4 — Cross-language unified contract graph.
 *
 * Harvests contracts from OpenAPI, GraphQL, Protobuf, Zod, and tRPC sources
 * across a polyglot codebase and detects drift between producers and consumers.
 * Pure functions — no network calls, no Claude dependency.
 *
 * Contract types: 'openapi' | 'graphql' | 'protobuf' | 'zod' | 'trpc'
 *
 * A "contract" is any schema/API boundary between two parts of the system:
 *   - OpenAPI path/operation
 *   - GraphQL type/field
 *   - Protobuf message/service
 *   - Zod schema export
 *   - tRPC procedure
 *
 * Drift = producer defines field X, consumer reads field Y that doesn't exist,
 *         or consumer depends on field Z that was removed from producer.
 */

const MAX_FILES = 200;
const MAX_FILE_BYTES = 150 * 1024;

// ─── Harvesters ───────────────────────────────────────────────────────────────

/**
 * Harvest OpenAPI contracts from YAML/JSON spec files.
 * Returns array of { contractId, type, method, path, fields }
 */
function harvestOpenApi(filePath, content) {
  const contracts = [];
  if (!content || typeof content !== 'string') return contracts;

  const isOpenApi =
    /openapi\s*:\s*['"]?3\./i.test(content) ||
    /swagger\s*:\s*['"]?2\./i.test(content) ||
    /"openapi"\s*:\s*"3\./i.test(content) ||
    /"swagger"\s*:\s*"2\./i.test(content);

  if (!isOpenApi) return contracts;

  // Extract paths block — look for indented path entries
  const pathPattern = /^\s{0,2}(?:'|")?\/([^'"\n:{}]+)(?:'|")?\s*:/gm;
  let pathMatch;
  while ((pathMatch = pathPattern.exec(content)) !== null) {
    const rawPath = '/' + pathMatch[1].trim();
    // Methods under this path
    const methodPattern = /\b(get|post|put|patch|delete|head|options)\s*:/gi;
    // Find the slice after the path declaration
    const slice = content.slice(pathMatch.index, pathMatch.index + 500);
    let methodMatch;
    while ((methodMatch = methodPattern.exec(slice)) !== null) {
      const method = methodMatch[1].toLowerCase();
      const contractId = `openapi:${method.toUpperCase()} ${rawPath}`;
      // Extract response/request field names from schema $ref or properties
      const fields = extractOpenApiFields(slice);
      contracts.push({
        contractId,
        type: 'openapi',
        method,
        path: rawPath,
        fields,
        sourceFile: filePath,
      });
    }
  }

  return contracts;
}

function extractOpenApiFields(slice) {
  const fields = new Set();
  // properties: fieldName:
  const propPattern = /^\s{4,}([a-zA-Z_][a-zA-Z0-9_]*):\s*$/gm;
  let m;
  while ((m = propPattern.exec(slice)) !== null) {
    fields.add(m[1]);
  }
  // $ref: '#/components/schemas/Foo'
  const refPattern = /\$ref['":\s]+[^'"]+\/([A-Z][a-zA-Z0-9]+)/g;
  while ((m = refPattern.exec(slice)) !== null) {
    fields.add(m[1]);
  }
  return [...fields];
}

/**
 * Harvest GraphQL contracts from .graphql/.gql files.
 * Returns array of { contractId, type, typeName, fields }
 */
function harvestGraphQL(filePath, content) {
  const contracts = [];
  if (!content || typeof content !== 'string') return contracts;

  // type Foo { ... } | input Bar { ... } | interface Baz { ... }
  const typePattern = /\b(type|input|interface|extend\s+type)\s+([A-Z][a-zA-Z0-9_]*)\s*(?:implements\s+[^\{]+)?\{([^}]*)\}/g;
  let m;
  while ((m = typePattern.exec(content)) !== null) {
    const typeName = m[2];
    const body = m[3];
    const fields = extractGraphQLFields(body);
    contracts.push({
      contractId: `graphql:${typeName}`,
      type: 'graphql',
      typeName,
      fields,
      sourceFile: filePath,
    });
  }

  // Query / Mutation / Subscription operations
  const opPattern = /\b(type)\s+(Query|Mutation|Subscription)\s*\{([^}]*)\}/g;
  while ((m = opPattern.exec(content)) !== null) {
    const typeName = m[2];
    const body = m[3];
    const opFields = extractGraphQLFields(body);
    // Already captured above via typePattern, avoid duplicates
    const existing = contracts.find((c) => c.contractId === `graphql:${typeName}`);
    if (!existing) {
      contracts.push({
        contractId: `graphql:${typeName}`,
        type: 'graphql',
        typeName,
        fields: opFields,
        sourceFile: filePath,
      });
    }
  }

  return contracts;
}

function extractGraphQLFields(body) {
  const fields = [];
  // fieldName: Type or fieldName(args): Type
  const fieldPattern = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:\([^)]*\))?\s*:/gm;
  let m;
  while ((m = fieldPattern.exec(body)) !== null) {
    fields.push(m[1]);
  }
  return fields;
}

/**
 * Harvest Protobuf contracts from .proto files.
 * Returns array of { contractId, type, messageName/serviceName, fields/methods }
 */
function harvestProtobuf(filePath, content) {
  const contracts = [];
  if (!content || typeof content !== 'string') return contracts;

  // message Foo { ... }
  const msgPattern = /\bmessage\s+([A-Z][a-zA-Z0-9_]*)\s*\{([^}]*)\}/g;
  let m;
  while ((m = msgPattern.exec(content)) !== null) {
    const messageName = m[1];
    const body = m[2];
    const fields = extractProtoFields(body);
    contracts.push({
      contractId: `proto:${messageName}`,
      type: 'protobuf',
      messageName,
      fields,
      sourceFile: filePath,
    });
  }

  // service Foo { rpc Bar(In) returns (Out); }
  const svcPattern = /\bservice\s+([A-Z][a-zA-Z0-9_]*)\s*\{([^}]*)\}/g;
  while ((m = svcPattern.exec(content)) !== null) {
    const serviceName = m[1];
    const body = m[2];
    const methods = extractProtoMethods(body);
    contracts.push({
      contractId: `proto:${serviceName}`,
      type: 'protobuf',
      serviceName,
      fields: methods,
      sourceFile: filePath,
    });
  }

  return contracts;
}

function extractProtoFields(body) {
  const fields = [];
  // type fieldName = N;
  const fieldPattern = /\b(?:string|int32|int64|uint32|uint64|float|double|bool|bytes|[A-Z][a-zA-Z0-9_]*)\s+([a-z_][a-zA-Z0-9_]*)\s*=/g;
  let m;
  while ((m = fieldPattern.exec(body)) !== null) {
    fields.push(m[1]);
  }
  return fields;
}

function extractProtoMethods(body) {
  const methods = [];
  // rpc MethodName(...)
  const rpcPattern = /\brpc\s+([A-Z][a-zA-Z0-9_]*)\s*\(/g;
  let m;
  while ((m = rpcPattern.exec(body)) !== null) {
    methods.push(m[1]);
  }
  return methods;
}

/**
 * Harvest Zod schema exports from JS/TS files.
 * Returns array of { contractId, type, schemaName, fields }
 */
function harvestZod(filePath, content) {
  const contracts = [];
  if (!content || typeof content !== 'string') return contracts;
  if (!content.includes('zod') && !content.includes('z.object') && !content.includes('z.string')) return contracts;

  // export const FooSchema = z.object({ ... })
  // const FooSchema = z.object({ ... })
  const schemaPattern = /(?:export\s+)?const\s+([A-Za-z][A-Za-z0-9_]*Schema|[A-Za-z][A-Za-z0-9_]*)\s*=\s*z\.object\s*\(\s*\{([^}]*)\}/g;
  let m;
  while ((m = schemaPattern.exec(content)) !== null) {
    const schemaName = m[1];
    const body = m[2];
    const fields = extractZodFields(body);
    if (fields.length === 0) continue;
    contracts.push({
      contractId: `zod:${schemaName}`,
      type: 'zod',
      schemaName,
      fields,
      sourceFile: filePath,
    });
  }

  return contracts;
}

function extractZodFields(body) {
  const fields = [];
  // fieldName: z.string()
  const fieldPattern = /^\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*:/gm;
  let m;
  while ((m = fieldPattern.exec(body)) !== null) {
    fields.push(m[1]);
  }
  return fields;
}

/**
 * Harvest tRPC procedure contracts from router definition files.
 * Returns array of { contractId, type, procedureName, procedureType }
 */
function harvestTrpc(filePath, content) {
  const contracts = [];
  if (!content || typeof content !== 'string') return contracts;
  if (
    !content.includes('router') &&
    !content.includes('procedure') &&
    !content.includes('createTRPCRouter') &&
    !content.includes('t.router')
  ) return contracts;

  // Procedure names from router definitions
  // { foo: procedure.query(...), bar: t.procedure.mutation(...) }
  const procPattern = /\b([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(?:t\.)?procedure\.(query|mutation|subscription)/g;
  let m;
  while ((m = procPattern.exec(content)) !== null) {
    const procedureName = m[1];
    const procedureType = m[2];
    contracts.push({
      contractId: `trpc:${procedureName}`,
      type: 'trpc',
      procedureName,
      procedureType,
      fields: [],
      sourceFile: filePath,
    });
  }

  // createTRPCRouter({ foo: ... })
  const routerPattern = /(?:createTRPCRouter|t\.router)\s*\(\s*\{([^}]{0,2000})\}/g;
  while ((m = routerPattern.exec(content)) !== null) {
    const body = m[1];
    const keyPattern = /\b([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g;
    let km;
    while ((km = keyPattern.exec(body)) !== null) {
      const name = km[1];
      if (['query', 'mutation', 'subscription', 'input', 'output'].includes(name)) continue;
      const existing = contracts.find((c) => c.contractId === `trpc:${name}`);
      if (!existing) {
        contracts.push({
          contractId: `trpc:${name}`,
          type: 'trpc',
          procedureName: name,
          procedureType: 'unknown',
          fields: [],
          sourceFile: filePath,
        });
      }
    }
  }

  return contracts;
}

// ─── Consumer detection ───────────────────────────────────────────────────────

/**
 * Find references to contract fields/procedures in source files.
 * Returns array of { contractId, field, referenceFile, line }
 */
function detectConsumers(contractId, contract, sourceFiles) {
  const consumers = [];
  const { type } = contract;

  for (const [filePath, content] of Object.entries(sourceFiles)) {
    if (filePath === contract.sourceFile) continue;
    if (!content || typeof content !== 'string') continue;

    if (type === 'trpc') {
      // trpc.procedureName.useQuery / api.procedureName.useQuery
      const { procedureName } = contract;
      if (!procedureName) continue;
      const pattern = new RegExp(`\\b(?:trpc|api|client)\\.(?:[a-zA-Z0-9_.]*\\.)?${procedureName}\\b`, 'g');
      const lines = content.split('\n');
      lines.forEach((line, idx) => {
        if (pattern.test(line)) {
          consumers.push({ contractId, field: procedureName, referenceFile: filePath, line: idx + 1 });
          pattern.lastIndex = 0;
        }
      });
    } else if (type === 'graphql') {
      // Query / mutation strings referencing typeName
      const { typeName, fields } = contract;
      if (!typeName) continue;
      for (const field of (fields || [])) {
        const lines = content.split('\n');
        lines.forEach((line, idx) => {
          if (new RegExp(`\\b${field}\\b`).test(line)) {
            consumers.push({ contractId, field, referenceFile: filePath, line: idx + 1 });
          }
        });
      }
    } else if (type === 'openapi') {
      // fetch('/api/path') or axios.get('/api/path')
      const { path } = contract;
      if (!path) continue;
      const escapedPath = path.replace(/[{}]/g, '').replace(/[.*+?^$|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`['"\`]${escapedPath}['"\`]`, 'g');
      const lines = content.split('\n');
      lines.forEach((line, idx) => {
        if (pattern.test(line)) {
          consumers.push({ contractId, field: path, referenceFile: filePath, line: idx + 1 });
          pattern.lastIndex = 0;
        }
      });
    } else if (type === 'zod') {
      // import { FooSchema } or FooSchema.parse(
      const { schemaName } = contract;
      if (!schemaName) continue;
      const pattern = new RegExp(`\\b${schemaName}\\b`, 'g');
      const lines = content.split('\n');
      lines.forEach((line, idx) => {
        if (pattern.test(line) && filePath !== contract.sourceFile) {
          consumers.push({ contractId, field: schemaName, referenceFile: filePath, line: idx + 1 });
          pattern.lastIndex = 0;
        }
      });
    }
  }

  return consumers;
}

// ─── Drift detection ──────────────────────────────────────────────────────────

/**
 * Detect drift between contracts in the graph.
 * - A producer removes a field that consumers still reference
 * - A consumer references a procedure/field that no producer exposes
 *
 * @param {Array} contracts — all harvested contracts
 * @param {Record<string, Array>} consumerMap — contractId → consumer refs
 * @returns {Array<{ type, contractId, field, detail, severity, referenceFile, line }>}
 */
function detectDrift(contracts, consumerMap) {
  const driftIssues = [];
  const contractById = new Map(contracts.map((c) => [c.contractId, c]));

  for (const [contractId, consumers] of Object.entries(consumerMap)) {
    const contract = contractById.get(contractId);
    if (!contract) {
      // Contract referenced by consumers but not produced by any file
      for (const ref of consumers) {
        driftIssues.push({
          type: 'missing-producer',
          contractId,
          field: ref.field,
          detail: `Consumer references ${contractId} but no producer defines it`,
          severity: 'error',
          referenceFile: ref.referenceFile,
          line: ref.line,
        });
      }
      continue;
    }

    // For field-aware contract types, check each consumed field exists in producer
    const { fields = [] } = contract;
    if (fields.length === 0) continue;

    const fieldSet = new Set(fields);
    for (const ref of consumers) {
      if (ref.field && !fieldSet.has(ref.field) && ref.field !== contractId.split(':')[1]) {
        driftIssues.push({
          type: 'field-drift',
          contractId,
          field: ref.field,
          detail: `Consumer reads field "${ref.field}" from ${contractId} but producer does not expose it`,
          severity: 'warning',
          referenceFile: ref.referenceFile,
          line: ref.line,
        });
      }
    }
  }

  return driftIssues;
}

// ─── Main ────────────────────────────────────────────────────────────────────

const SPEC_EXTENSIONS = new Set(['.yaml', '.yml', '.json', '.graphql', '.gql', '.proto']);
const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);

function isSpecFile(filePath) {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.graphql') || lower.endsWith('.gql') || lower.endsWith('.proto')) return true;
  if (!lower.endsWith('.yaml') && !lower.endsWith('.yml') && !lower.endsWith('.json')) return false;
  return (
    lower.includes('openapi') ||
    lower.includes('swagger') ||
    lower.includes('api-spec') ||
    lower.includes('api_spec') ||
    lower.includes('schema') ||
    lower.includes('spec')
  );
}

/**
 * Build a unified contract graph from source files.
 *
 * @param {Record<string, string>} sourceFiles — { filePath: content }
 * @returns {{ contracts: Array, consumers: Record<string, Array>, drift: Array, summary: string }}
 */
function buildContractGraph(sourceFiles) {
  if (!sourceFiles || typeof sourceFiles !== 'object') {
    return { contracts: [], consumers: {}, drift: [], summary: 'No source files provided.' };
  }

  const entries = Object.entries(sourceFiles).slice(0, MAX_FILES);
  const contracts = [];

  for (const [filePath, content] of entries) {
    if (!content || typeof content !== 'string') continue;
    if (content.length > MAX_FILE_BYTES) continue;

    const lower = filePath.toLowerCase();

    if (lower.endsWith('.graphql') || lower.endsWith('.gql')) {
      contracts.push(...harvestGraphQL(filePath, content));
    } else if (lower.endsWith('.proto')) {
      contracts.push(...harvestProtobuf(filePath, content));
    } else if (isSpecFile(filePath)) {
      contracts.push(...harvestOpenApi(filePath, content));
    }

    if (SOURCE_EXTENSIONS.has('.' + lower.split('.').pop())) {
      contracts.push(...harvestZod(filePath, content));
      contracts.push(...harvestTrpc(filePath, content));
    }
  }

  // Build consumer map
  const consumers = {};
  const allFiles = Object.fromEntries(entries);

  for (const contract of contracts) {
    const refs = detectConsumers(contract.contractId, contract, allFiles);
    if (refs.length > 0) {
      consumers[contract.contractId] = refs;
    }
  }

  const drift = detectDrift(contracts, consumers);

  const typeCount = contracts.reduce((acc, c) => {
    acc[c.type] = (acc[c.type] || 0) + 1;
    return acc;
  }, {});

  const typeStr = Object.entries(typeCount)
    .map(([t, n]) => `${n} ${t}`)
    .join(', ');

  const summary =
    contracts.length === 0
      ? 'No contracts found in the provided files.'
      : `Found ${contracts.length} contracts (${typeStr}). ` +
        `${drift.length} drift issue(s) detected across ${Object.keys(consumers).length} consumed contract(s).`;

  return { contracts, consumers, drift, summary };
}

/**
 * Render a Markdown report of the contract graph.
 *
 * @param {{ contracts, consumers, drift, summary }} graph
 * @returns {string}
 */
function renderContractReport(graph) {
  if (!graph || (graph.contracts.length === 0 && graph.drift.length === 0)) return '';

  const { contracts, consumers, drift, summary } = graph;
  const lines = [];

  lines.push('## Contract Graph Analysis');
  lines.push('');
  lines.push(summary);
  lines.push('');

  // Contracts by type
  const byType = {};
  for (const c of contracts) {
    (byType[c.type] = byType[c.type] || []).push(c);
  }

  lines.push('### Contracts Discovered');
  lines.push('');
  lines.push('| Type | Contract ID | Fields | Source |');
  lines.push('|------|-------------|--------|--------|');
  for (const c of contracts) {
    const fieldPreview = (c.fields || []).slice(0, 5).join(', ') + (c.fields && c.fields.length > 5 ? ' …' : '');
    const srcShort = c.sourceFile ? c.sourceFile.replace(/^.*[/\\]/, '') : '?';
    lines.push(`| ${c.type} | \`${c.contractId}\` | ${fieldPreview || '—'} | ${srcShort} |`);
  }
  lines.push('');

  if (drift.length > 0) {
    lines.push('### ⚠️ Contract Drift Detected');
    lines.push('');
    for (const d of drift) {
      const severity = d.severity === 'error' ? '🔴' : '🟡';
      lines.push(`${severity} **${d.type}** — ${d.detail}`);
      if (d.referenceFile) {
        lines.push(`  → \`${d.referenceFile}\`:${d.line || '?'}`);
      }
      lines.push('');
    }
  } else {
    lines.push('### ✅ No Contract Drift Detected');
    lines.push('');
    lines.push('All consumers reference fields that producers expose.');
    lines.push('');
  }

  if (Object.keys(consumers).length > 0) {
    lines.push('### Consumer Map');
    lines.push('');
    for (const [cId, refs] of Object.entries(consumers)) {
      lines.push(`- **${cId}** consumed in ${[...new Set(refs.map((r) => r.referenceFile))].length} file(s)`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

module.exports = {
  buildContractGraph,
  renderContractReport,
  harvestOpenApi,
  harvestGraphQL,
  harvestProtobuf,
  harvestZod,
  harvestTrpc,
  detectConsumers,
  detectDrift,
  extractGraphQLFields,
  extractZodFields,
  extractProtoFields,
  extractProtoMethods,
  MAX_FILES,
  MAX_FILE_BYTES,
};
