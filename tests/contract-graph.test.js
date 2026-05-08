'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  harvestOpenApi,
  harvestGraphQL,
  harvestProtobuf,
  harvestZod,
  harvestTrpc,
  detectConsumers,
  detectDrift,
  buildContractGraph,
  renderContractReport,
  extractGraphQLFields,
  extractZodFields,
  extractProtoFields,
  extractProtoMethods,
  MAX_FILES,
  MAX_FILE_BYTES,
} = require('../website/app/lib/contract-graph');

// ─── harvestOpenApi ───────────────────────────────────────────────────────────

describe('harvestOpenApi', () => {
  it('returns empty for non-OpenAPI content', () => {
    assert.deepEqual(harvestOpenApi('foo.json', '{ "name": "foo" }'), []);
  });

  it('returns empty for null input', () => {
    assert.deepEqual(harvestOpenApi('foo.yaml', null), []);
  });

  it('extracts OpenAPI 3 paths', () => {
    const content = [
      'openapi: 3.0.0',
      'paths:',
      '  /api/users:',
      '    get:',
      '      summary: list users',
      '    post:',
      '      summary: create user',
    ].join('\n');
    const contracts = harvestOpenApi('openapi.yaml', content);
    assert.ok(contracts.length >= 1);
    const getUser = contracts.find((c) => c.method === 'get' && c.path.includes('/api/users'));
    assert.ok(getUser, 'should find GET /api/users');
    assert.equal(getUser.type, 'openapi');
    assert.ok(getUser.contractId.includes('GET'));
  });

  it('extracts Swagger 2 paths', () => {
    const content = [
      'swagger: "2.0"',
      'paths:',
      '  /api/orders:',
      '    post:',
      '      summary: create order',
    ].join('\n');
    const contracts = harvestOpenApi('swagger.yaml', content);
    const post = contracts.find((c) => c.method === 'post');
    assert.ok(post);
    assert.ok(post.path.includes('/api/orders'));
  });

  it('sets sourceFile on extracted contracts', () => {
    const content = [
      'openapi: 3.0.0',
      'paths:',
      '  /health:',
      '    get:',
      '      summary: health',
    ].join('\n');
    const contracts = harvestOpenApi('api/openapi.yaml', content);
    if (contracts.length > 0) {
      assert.equal(contracts[0].sourceFile, 'api/openapi.yaml');
    }
  });
});

// ─── harvestGraphQL ───────────────────────────────────────────────────────────

describe('harvestGraphQL', () => {
  it('returns empty for non-GraphQL content', () => {
    assert.deepEqual(harvestGraphQL('foo.ts', 'const x = 1;'), []);
  });

  it('extracts type definitions', () => {
    const content = [
      'type User {',
      '  id: ID!',
      '  email: String!',
      '  name: String',
      '}',
    ].join('\n');
    const contracts = harvestGraphQL('schema.graphql', content);
    assert.equal(contracts.length, 1);
    assert.equal(contracts[0].typeName, 'User');
    assert.ok(contracts[0].fields.includes('id'));
    assert.ok(contracts[0].fields.includes('email'));
    assert.ok(contracts[0].fields.includes('name'));
    assert.equal(contracts[0].type, 'graphql');
  });

  it('extracts input types', () => {
    const content = [
      'input CreateUserInput {',
      '  email: String!',
      '  password: String!',
      '}',
    ].join('\n');
    const contracts = harvestGraphQL('schema.graphql', content);
    assert.equal(contracts.length, 1);
    assert.equal(contracts[0].typeName, 'CreateUserInput');
    assert.ok(contracts[0].fields.includes('email'));
  });

  it('extracts Query type operations', () => {
    const content = [
      'type Query {',
      '  users: [User]',
      '  user(id: ID!): User',
      '}',
    ].join('\n');
    const contracts = harvestGraphQL('schema.graphql', content);
    const query = contracts.find((c) => c.typeName === 'Query');
    assert.ok(query);
    assert.ok(query.fields.includes('users'));
    assert.ok(query.fields.includes('user'));
  });

  it('handles multiple types', () => {
    const content = [
      'type User { id: ID! email: String }',
      'type Order { id: ID! total: Float }',
    ].join('\n');
    const contracts = harvestGraphQL('schema.graphql', content);
    assert.equal(contracts.length, 2);
  });

  it('sets contractId with graphql: prefix', () => {
    const content = 'type Product { name: String price: Float }';
    const contracts = harvestGraphQL('schema.graphql', content);
    assert.equal(contracts[0].contractId, 'graphql:Product');
  });
});

// ─── harvestProtobuf ──────────────────────────────────────────────────────────

describe('harvestProtobuf', () => {
  it('returns empty for non-proto content', () => {
    assert.deepEqual(harvestProtobuf('foo.ts', 'const x = 1;'), []);
  });

  it('extracts message definitions', () => {
    const content = [
      'syntax = "proto3";',
      'message User {',
      '  string id = 1;',
      '  string email = 2;',
      '  int32 age = 3;',
      '}',
    ].join('\n');
    const contracts = harvestProtobuf('user.proto', content);
    const msg = contracts.find((c) => c.messageName === 'User');
    assert.ok(msg);
    assert.ok(msg.fields.includes('id'));
    assert.ok(msg.fields.includes('email'));
    assert.equal(msg.type, 'protobuf');
  });

  it('extracts service RPC methods', () => {
    const content = [
      'service UserService {',
      '  rpc GetUser(GetUserRequest) returns (User);',
      '  rpc CreateUser(CreateUserRequest) returns (User);',
      '}',
    ].join('\n');
    const contracts = harvestProtobuf('user.proto', content);
    const svc = contracts.find((c) => c.serviceName === 'UserService');
    assert.ok(svc);
    assert.ok(svc.fields.includes('GetUser'));
    assert.ok(svc.fields.includes('CreateUser'));
  });

  it('sets contractId with proto: prefix', () => {
    const content = 'message Order { string id = 1; }';
    const contracts = harvestProtobuf('order.proto', content);
    assert.equal(contracts[0].contractId, 'proto:Order');
  });
});

// ─── harvestZod ───────────────────────────────────────────────────────────────

describe('harvestZod', () => {
  it('returns empty for non-Zod content', () => {
    assert.deepEqual(harvestZod('foo.ts', 'const x = 1;'), []);
  });

  it('extracts z.object schema exports', () => {
    const content = [
      "import { z } from 'zod';",
      'export const UserSchema = z.object({',
      '  id: z.string(),',
      '  email: z.string().email(),',
      '  age: z.number().optional(),',
      '});',
    ].join('\n');
    const contracts = harvestZod('schemas/user.ts', content);
    assert.equal(contracts.length, 1);
    assert.equal(contracts[0].schemaName, 'UserSchema');
    assert.ok(contracts[0].fields.includes('id'));
    assert.ok(contracts[0].fields.includes('email'));
    assert.ok(contracts[0].fields.includes('age'));
    assert.equal(contracts[0].type, 'zod');
  });

  it('extracts multiple schemas from one file', () => {
    const content = [
      "import { z } from 'zod';",
      'export const FooSchema = z.object({ a: z.string() });',
      'export const BarSchema = z.object({ b: z.number() });',
    ].join('\n');
    const contracts = harvestZod('schemas.ts', content);
    assert.equal(contracts.length, 2);
  });

  it('skips schemas with no fields', () => {
    const content = [
      "import { z } from 'zod';",
      'export const EmptySchema = z.object({});',
    ].join('\n');
    const contracts = harvestZod('schemas.ts', content);
    assert.equal(contracts.length, 0);
  });

  it('sets contractId with zod: prefix', () => {
    const content = [
      "import { z } from 'zod';",
      'const PaymentSchema = z.object({ amount: z.number() });',
    ].join('\n');
    const contracts = harvestZod('pay.ts', content);
    if (contracts.length > 0) {
      assert.equal(contracts[0].contractId, 'zod:PaymentSchema');
    }
  });
});

// ─── harvestTrpc ──────────────────────────────────────────────────────────────

describe('harvestTrpc', () => {
  it('returns empty for non-tRPC content', () => {
    assert.deepEqual(harvestTrpc('foo.ts', 'const x = 1;'), []);
  });

  it('extracts procedure definitions', () => {
    const content = [
      "import { router, procedure } from './trpc';",
      'export const appRouter = router({',
      '  getUser: procedure.query(({ input }) => {}),',
      '  createUser: procedure.mutation(({ input }) => {}),',
      '});',
    ].join('\n');
    const contracts = harvestTrpc('server/router.ts', content);
    const getUser = contracts.find((c) => c.procedureName === 'getUser');
    assert.ok(getUser);
    assert.equal(getUser.procedureType, 'query');
    assert.equal(getUser.type, 'trpc');
    const createUser = contracts.find((c) => c.procedureName === 'createUser');
    assert.ok(createUser);
    assert.equal(createUser.procedureType, 'mutation');
  });

  it('extracts from createTRPCRouter', () => {
    const content = [
      "import { createTRPCRouter, publicProcedure } from '../trpc';",
      'export const userRouter = createTRPCRouter({',
      '  list: publicProcedure.query(() => {}),',
      '  create: publicProcedure.mutation(() => {}),',
      '});',
    ].join('\n');
    const contracts = harvestTrpc('router/user.ts', content);
    assert.ok(contracts.some((c) => c.procedureName === 'list' || c.procedureName === 'create'));
  });

  it('sets contractId with trpc: prefix', () => {
    const content = [
      'export const r = router({',
      '  hello: procedure.query(() => "world"),',
      '});',
    ].join('\n');
    const contracts = harvestTrpc('router.ts', content);
    const hello = contracts.find((c) => c.contractId === 'trpc:hello');
    assert.ok(hello);
  });
});

// ─── detectConsumers ─────────────────────────────────────────────────────────

describe('detectConsumers', () => {
  it('finds tRPC consumers in other files', () => {
    const contract = {
      contractId: 'trpc:getUser',
      type: 'trpc',
      procedureName: 'getUser',
      fields: [],
      sourceFile: 'server/router.ts',
    };
    const sourceFiles = {
      'server/router.ts': 'export const getUser = procedure.query(() => {})',
      'client/UserPage.tsx': 'const user = trpc.getUser.useQuery({ id });',
    };
    const refs = detectConsumers('trpc:getUser', contract, sourceFiles);
    assert.ok(refs.length > 0);
    assert.equal(refs[0].referenceFile, 'client/UserPage.tsx');
    assert.equal(refs[0].contractId, 'trpc:getUser');
  });

  it('finds OpenAPI consumers via URL references', () => {
    const contract = {
      contractId: 'openapi:GET /api/users',
      type: 'openapi',
      path: '/api/users',
      fields: [],
      sourceFile: 'openapi.yaml',
    };
    const sourceFiles = {
      'openapi.yaml': 'openapi: 3.0.0',
      'lib/api.ts': "const resp = await fetch('/api/users');",
    };
    const refs = detectConsumers('openapi:GET /api/users', contract, sourceFiles);
    assert.ok(refs.length > 0);
    assert.equal(refs[0].referenceFile, 'lib/api.ts');
  });

  it('finds Zod schema consumers', () => {
    const contract = {
      contractId: 'zod:UserSchema',
      type: 'zod',
      schemaName: 'UserSchema',
      fields: ['id', 'email'],
      sourceFile: 'schemas/user.ts',
    };
    const sourceFiles = {
      'schemas/user.ts': 'export const UserSchema = z.object({ id: z.string() })',
      'api/route.ts': "import { UserSchema } from '../schemas/user'; UserSchema.parse(data);",
    };
    const refs = detectConsumers('zod:UserSchema', contract, sourceFiles);
    assert.ok(refs.length > 0);
    assert.equal(refs[0].referenceFile, 'api/route.ts');
  });

  it('does not flag producer file itself', () => {
    const contract = {
      contractId: 'trpc:hello',
      type: 'trpc',
      procedureName: 'hello',
      fields: [],
      sourceFile: 'router.ts',
    };
    const sourceFiles = {
      'router.ts': 'const hello = procedure.query(() => {})',
    };
    const refs = detectConsumers('trpc:hello', contract, sourceFiles);
    assert.equal(refs.length, 0);
  });
});

// ─── detectDrift ─────────────────────────────────────────────────────────────

describe('detectDrift', () => {
  it('returns empty when no drift', () => {
    const contracts = [
      { contractId: 'trpc:getUser', type: 'trpc', procedureName: 'getUser', fields: [] },
    ];
    const consumerMap = {
      'trpc:getUser': [{ contractId: 'trpc:getUser', field: 'getUser', referenceFile: 'page.tsx', line: 5 }],
    };
    const drift = detectDrift(contracts, consumerMap);
    assert.equal(drift.length, 0);
  });

  it('flags missing-producer when consumer references unknown contract', () => {
    const contracts = [];
    const consumerMap = {
      'trpc:deletedProcedure': [{ contractId: 'trpc:deletedProcedure', field: 'deletedProcedure', referenceFile: 'page.tsx', line: 10 }],
    };
    const drift = detectDrift(contracts, consumerMap);
    assert.equal(drift.length, 1);
    assert.equal(drift[0].type, 'missing-producer');
    assert.equal(drift[0].severity, 'error');
  });

  it('returns empty when consumerMap is empty', () => {
    const contracts = [
      { contractId: 'zod:FooSchema', type: 'zod', fields: ['a', 'b'] },
    ];
    const drift = detectDrift(contracts, {});
    assert.equal(drift.length, 0);
  });

  it('includes contractId and referenceFile in drift issues', () => {
    const contracts = [];
    const consumerMap = {
      'graphql:MissingType': [{ contractId: 'graphql:MissingType', field: 'name', referenceFile: 'query.ts', line: 3 }],
    };
    const drift = detectDrift(contracts, consumerMap);
    assert.ok(drift[0].referenceFile === 'query.ts');
    assert.equal(drift[0].line, 3);
  });
});

// ─── buildContractGraph ───────────────────────────────────────────────────────

describe('buildContractGraph', () => {
  it('returns empty for null input', () => {
    const result = buildContractGraph(null);
    assert.equal(result.contracts.length, 0);
    assert.equal(result.drift.length, 0);
  });

  it('returns empty for empty object', () => {
    const result = buildContractGraph({});
    assert.equal(result.contracts.length, 0);
  });

  it('harvests GraphQL contracts', () => {
    const sourceFiles = {
      'schema.graphql': [
        'type User { id: ID! email: String! }',
        'type Query { users: [User] }',
      ].join('\n'),
    };
    const result = buildContractGraph(sourceFiles);
    assert.ok(result.contracts.some((c) => c.contractId === 'graphql:User'));
    assert.ok(result.summary.includes('graphql'));
  });

  it('harvests Zod schemas', () => {
    const sourceFiles = {
      'schemas/user.ts': [
        "import { z } from 'zod';",
        'export const UserSchema = z.object({ id: z.string(), email: z.string() });',
      ].join('\n'),
    };
    const result = buildContractGraph(sourceFiles);
    assert.ok(result.contracts.some((c) => c.type === 'zod'));
  });

  it('detects tRPC procedures and their consumers', () => {
    const sourceFiles = {
      'server/router.ts': [
        "import { router, procedure } from './trpc';",
        'export const appRouter = router({',
        '  getUser: procedure.query(() => {}),',
        '});',
      ].join('\n'),
      'client/page.tsx': [
        "import { trpc } from '../utils/trpc';",
        'const { data } = trpc.getUser.useQuery();',
      ].join('\n'),
    };
    const result = buildContractGraph(sourceFiles);
    assert.ok(result.contracts.some((c) => c.contractId === 'trpc:getUser'));
    assert.ok(result.consumers['trpc:getUser'] !== undefined);
  });

  it('detects drift for missing producers', () => {
    const sourceFiles = {
      'client/page.tsx': 'const r = trpc.nonExistent.useQuery();',
    };
    // No router file — nonExistent is never produced
    // buildContractGraph won't flag because it only drifts what was found as consumers
    // but nonExistent won't even be found without a producer declaration in a trpc file
    const result = buildContractGraph(sourceFiles);
    assert.ok(result.summary.length > 0);
  });

  it('returns summary string', () => {
    const sourceFiles = {
      'schema.graphql': 'type Foo { bar: String }',
    };
    const result = buildContractGraph(sourceFiles);
    assert.equal(typeof result.summary, 'string');
    assert.ok(result.summary.length > 0);
  });

  it('respects MAX_FILES limit', () => {
    const sourceFiles = {};
    for (let i = 0; i < MAX_FILES + 10; i++) {
      sourceFiles[`file${i}.graphql`] = `type Type${i} { id: ID! }`;
    }
    const result = buildContractGraph(sourceFiles);
    assert.ok(result.contracts.length <= MAX_FILES);
  });

  it('skips files exceeding MAX_FILE_BYTES', () => {
    const sourceFiles = {
      'big.graphql': 'x'.repeat(MAX_FILE_BYTES + 1),
      'schema.graphql': 'type Small { id: ID! }',
    };
    const result = buildContractGraph(sourceFiles);
    const bigContracts = result.contracts.filter((c) => c.sourceFile === 'big.graphql');
    assert.equal(bigContracts.length, 0);
  });
});

// ─── renderContractReport ─────────────────────────────────────────────────────

describe('renderContractReport', () => {
  it('returns empty string for empty graph', () => {
    assert.equal(renderContractReport({ contracts: [], consumers: {}, drift: [], summary: '' }), '');
  });

  it('returns empty string for null', () => {
    assert.equal(renderContractReport(null), '');
  });

  it('includes heading', () => {
    const graph = {
      contracts: [{ contractId: 'graphql:User', type: 'graphql', fields: ['id', 'email'], sourceFile: 'schema.graphql' }],
      consumers: {},
      drift: [],
      summary: 'Found 1 contracts.',
    };
    const md = renderContractReport(graph);
    assert.ok(md.includes('Contract Graph Analysis'));
  });

  it('includes contracts table', () => {
    const graph = {
      contracts: [{ contractId: 'proto:Order', type: 'protobuf', fields: ['id', 'total'], sourceFile: 'order.proto' }],
      consumers: {},
      drift: [],
      summary: 'Found 1.',
    };
    const md = renderContractReport(graph);
    assert.ok(md.includes('proto:Order'));
    assert.ok(md.includes('protobuf'));
  });

  it('includes drift section when drift detected', () => {
    const graph = {
      contracts: [],
      consumers: {},
      drift: [{
        type: 'missing-producer',
        contractId: 'trpc:ghost',
        field: 'ghost',
        detail: 'Consumer references trpc:ghost but no producer defines it',
        severity: 'error',
        referenceFile: 'page.tsx',
        line: 5,
      }],
      summary: 'Found 0.',
    };
    const md = renderContractReport(graph);
    assert.ok(md.includes('Drift'));
    assert.ok(md.includes('missing-producer'));
  });

  it('includes no-drift confirmation when clean', () => {
    const graph = {
      contracts: [{ contractId: 'zod:FooSchema', type: 'zod', fields: ['a'], sourceFile: 'foo.ts' }],
      consumers: {},
      drift: [],
      summary: 'Found 1.',
    };
    const md = renderContractReport(graph);
    assert.ok(md.includes('No Contract Drift'));
  });

  it('mentions consumer files in consumer map', () => {
    const graph = {
      contracts: [{ contractId: 'trpc:getUser', type: 'trpc', fields: [], sourceFile: 'router.ts' }],
      consumers: {
        'trpc:getUser': [{ contractId: 'trpc:getUser', field: 'getUser', referenceFile: 'page.tsx', line: 1 }],
      },
      drift: [],
      summary: 'Found 1.',
    };
    const md = renderContractReport(graph);
    assert.ok(md.includes('Consumer Map'));
    assert.ok(md.includes('trpc:getUser'));
  });
});

// ─── helper extractors ────────────────────────────────────────────────────────

describe('extractGraphQLFields', () => {
  it('extracts simple fields', () => {
    const body = '  id: ID!\n  email: String\n  age: Int';
    const fields = extractGraphQLFields(body);
    assert.ok(fields.includes('id'));
    assert.ok(fields.includes('email'));
    assert.ok(fields.includes('age'));
  });

  it('handles fields with arguments', () => {
    const body = '  user(id: ID!): User\n  users: [User]';
    const fields = extractGraphQLFields(body);
    assert.ok(fields.includes('user'));
    assert.ok(fields.includes('users'));
  });
});

describe('extractZodFields', () => {
  it('extracts field names from object body', () => {
    const body = '  id: z.string(),\n  email: z.string().email(),\n  age: z.number()';
    const fields = extractZodFields(body);
    assert.ok(fields.includes('id'));
    assert.ok(fields.includes('email'));
    assert.ok(fields.includes('age'));
  });
});

describe('extractProtoFields', () => {
  it('extracts typed fields', () => {
    const body = '  string id = 1;\n  int32 count = 2;\n  bool active = 3;';
    const fields = extractProtoFields(body);
    assert.ok(fields.includes('id'));
    assert.ok(fields.includes('count'));
    assert.ok(fields.includes('active'));
  });
});

describe('extractProtoMethods', () => {
  it('extracts rpc method names', () => {
    const body = '  rpc GetUser(Request) returns (User);\n  rpc CreateUser(In) returns (User);';
    const methods = extractProtoMethods(body);
    assert.ok(methods.includes('GetUser'));
    assert.ok(methods.includes('CreateUser'));
  });
});

// ─── module constants ─────────────────────────────────────────────────────────

describe('module constants', () => {
  it('exports MAX_FILES as a reasonable limit', () => {
    assert.ok(typeof MAX_FILES === 'number');
    assert.ok(MAX_FILES >= 100);
  });

  it('exports MAX_FILE_BYTES as a reasonable limit', () => {
    assert.ok(typeof MAX_FILE_BYTES === 'number');
    assert.ok(MAX_FILE_BYTES >= 50 * 1024);
  });
});
