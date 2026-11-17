// Checks the MCP Registry entry (server.json) for the stdio server.
//
// fixtures/server.schema.2025-12-11.json is a copy of
//   repo:   modelcontextprotocol/registry
//   path:   internal/validators/schemas/2025-12-11.json
//   commit: 115f85225c9fac5281d8a2dc8551cf49b004d2f9
// which is the schema version the registry names as current
// (pkg/model/constants.go, CurrentSchemaVersion).
//
// The copy differs from the registry file in one way: the annotation-only
// keywords `$id`, `$schema`, `example` and `examples` are removed wherever they
// appear as schema keywords, and nothing else is changed. They do not affect
// validation, and they carry URLs that the public-repo host check would flag.
// A property that is itself named `$schema` (under a `properties` map) is a
// field definition, not a keyword, and stays: server.json uses that field.
// To rebuild the fixture, take the registry file at the commit above, delete
// those keywords, and keep the file's formatting and escapes as they are.
//
// No JSON Schema library is declared in this repo, so `validate` below
// implements the keywords that schema uses. It also refuses keys the schema
// does not list, which catches misspelled fields.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoFile = (path) => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const readJson = (path) => JSON.parse(readFileSync(repoFile(path), 'utf8'));

const schema = JSON.parse(readFileSync(new URL('./fixtures/server.schema.2025-12-11.json', import.meta.url), 'utf8'));
const server = readJson('server.json');
const stdioPackage = readJson('stdio-mcp/package.json');
const configSource = readFileSync(repoFile('stdio-mcp/src/config.ts'), 'utf8');

const SERVER_NAME = 'io.github.DACS-Agent-commerce/demos-mcp';

function resolveRef(node) {
  if (!node.$ref) return node;
  assert.ok(node.$ref.startsWith('#/definitions/'), `unsupported $ref ${node.$ref}`);
  return schema.definitions[node.$ref.slice('#/definitions/'.length)];
}

function knownKeys(node) {
  const resolved = resolveRef(node);
  const keys = new Set(Object.keys(resolved.properties ?? {}));
  for (const part of resolved.allOf ?? []) for (const key of knownKeys(part)) keys.add(key);
  return keys;
}

function typeOf(value) {
  if (Array.isArray(value)) return 'array';
  return value === null ? 'null' : typeof value;
}

/** Returns a list of problems; an empty list means `value` satisfies `node`. */
function validate(node, value, path = 'server.json', { lenient = false } = {}) {
  const resolved = resolveRef(node);
  const problems = [];
  if (resolved.type && typeOf(value) !== resolved.type) return [`${path}: expected ${resolved.type}`];
  if (resolved.enum && !resolved.enum.includes(value)) problems.push(`${path}: not one of ${resolved.enum.join(', ')}`);
  if (resolved.not?.const !== undefined && value === resolved.not.const) problems.push(`${path}: must not be ${value}`);
  if (typeof value === 'string') {
    if (resolved.minLength !== undefined && value.length < resolved.minLength) problems.push(`${path}: shorter than ${resolved.minLength}`);
    if (resolved.maxLength !== undefined && value.length > resolved.maxLength) problems.push(`${path}: longer than ${resolved.maxLength}`);
    if (resolved.pattern && !new RegExp(resolved.pattern).test(value)) problems.push(`${path}: does not match ${resolved.pattern}`);
  }
  for (const part of resolved.allOf ?? []) problems.push(...validate(part, value, path, { lenient: true }));
  if (resolved.anyOf) {
    const branches = resolved.anyOf.map((part) => validate(part, value, path));
    if (!branches.some((branch) => branch.length === 0)) problems.push(...branches.flat());
  }
  if (Array.isArray(value) && resolved.items) {
    value.forEach((item, index) => problems.push(...validate(resolved.items, item, `${path}[${index}]`)));
  }
  if (typeOf(value) === 'object') {
    for (const key of resolved.required ?? []) if (!(key in value)) problems.push(`${path}: missing ${key}`);
    for (const [key, child] of Object.entries(resolved.properties ?? {})) {
      if (key in value) problems.push(...validate(child, value[key], `${path}.${key}`));
    }
    if (!lenient && !resolved.anyOf && resolved.additionalProperties === undefined) {
      const allowed = knownKeys(resolved);
      for (const key of Object.keys(value)) if (!allowed.has(key)) problems.push(`${path}: unknown key ${key}`);
    }
  }
  return problems;
}

const REMOVED_ANNOTATION_KEYWORDS = ['$id', '$schema', 'example', 'examples'];

/** Lists the paths of removed annotation keywords; keys of `properties` and `definitions` maps are names, not keywords. */
function findAnnotationKeywords(node, path = '#', isNameMap = false) {
  if (node === null || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap((item, index) => findAnnotationKeywords(item, `${path}[${index}]`));
  return Object.entries(node).flatMap(([key, child]) => {
    const found = !isNameMap && REMOVED_ANNOTATION_KEYWORDS.includes(key) ? [`${path}/${key}`] : [];
    const childIsNameMap = !isNameMap && (key === 'properties' || key === 'definitions');
    return [...found, ...findAnnotationKeywords(child, `${path}/${key}`, childIsNameMap)];
  });
}

test('the schema fixture has none of the removed annotation keywords', () => {
  assert.deepEqual(findAnnotationKeywords(schema), []);
});

test('annotation keyword check finds a keyword but not a property of that name', () => {
  const sample = { $id: 'x', properties: { $schema: { example: 1, type: 'string' }, example: { type: 'string' } } };
  assert.deepEqual(findAnnotationKeywords(sample), ['#/$id', '#/properties/$schema/example']);
});

test('validator refuses a misspelled key and a missing required field', () => {
  const broken = { ...server, descripton: 'typo' };
  delete broken.version;
  const problems = validate(schema, broken);
  assert.ok(problems.some((p) => p.includes('unknown key descripton')), problems.join('\n'));
  assert.ok(problems.some((p) => p.includes('missing version')), problems.join('\n'));
});

test('server.json is valid against the registry schema', () => {
  assert.deepEqual(validate(schema, server), []);
});

test('server name is in the GitHub namespace of the public org', () => {
  assert.equal(server.name, SERVER_NAME);
});

test('package.json mcpName equals the server name', () => {
  assert.equal(stdioPackage.mcpName, server.name);
});

test('server and package versions equal the stdio package version', () => {
  assert.equal(server.version, stdioPackage.version);
  assert.deepEqual(server.packages.map((entry) => entry.version), [stdioPackage.version]);
});

test('the npm package entry names the stdio package over stdio', () => {
  assert.equal(server.packages.length, 1);
  const [entry] = server.packages;
  assert.equal(entry.registryType, 'npm');
  assert.equal(entry.registryBaseUrl, 'https://registry.npmjs.org');
  assert.equal(entry.identifier, stdioPackage.name);
  assert.deepEqual(entry.transport, { type: 'stdio' });
});

test('repository is the public repo and stdio-mcp folder', () => {
  assert.deepEqual(server.repository, {
    url: 'https://github.com/DACS-Agent-commerce/dacs-plugin',
    source: 'github',
    subfolder: 'stdio-mcp',
  });
});

test('every listed environment variable is read by config.ts', () => {
  const listed = server.packages[0].environmentVariables;
  assert.ok(listed.length > 0);
  for (const { name } of listed) {
    assert.match(configSource, new RegExp(`(?:'${name}'|\\be\\.${name}\\b)`), `${name} is not read in config.ts`);
  }
});

test('secret-bearing variables are marked secret', () => {
  const secretNames = ['DEMOS_KEYSTORE_PASSPHRASE', 'DEMOS_MNEMONIC_FILE'];
  const listed = Object.fromEntries(server.packages[0].environmentVariables.map((entry) => [entry.name, entry]));
  for (const name of secretNames) assert.equal(listed[name]?.isSecret, true, `${name} must be listed and secret`);
  for (const entry of Object.values(listed)) {
    if (/KEY|MNEMONIC|PASSPHRASE|SECRET|TOKEN/.test(entry.name)) {
      assert.equal(entry.isSecret, true, `${entry.name} looks secret-bearing`);
    }
  }
});

test('description is one testnet sentence without value claims', () => {
  assert.match(server.description, /^[^.!?]+\.$/, 'one sentence ending in a full stop');
  assert.match(server.description, /testnet/i);
  assert.doesNotMatch(server.description, /mainnet|production|final(ity|ised|ized)?|guarantee/i);
});
