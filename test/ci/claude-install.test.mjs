import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PLUGIN_DIR = path.join(REPO_ROOT, 'stdio-mcp');
const DISCOVERY_TOOLS = ['mcp__plugin_demos_demos__demos_dacs_discover', 'mcp__plugin_demos_demos__demos_dacs_listing_check'];

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const rootMarketplace = () => readJson(path.join(REPO_ROOT, '.claude-plugin', 'marketplace.json'));
const pluginManifest = () => readJson(path.join(PLUGIN_DIR, '.claude-plugin', 'plugin.json'));
const mcpConfig = () => readJson(path.join(PLUGIN_DIR, '.mcp.json'));

test('the root marketplace lists the demos plugin from ./stdio-mcp', () => {
  const marketplace = rootMarketplace();
  assert.equal(typeof marketplace.owner?.name, 'string');
  assert.deepEqual(
    marketplace.plugins.map(({ name, source }) => ({ name, source })),
    [{ name: 'demos', source: './stdio-mcp' }],
  );
});

test('the root marketplace keeps the name the stdio marketplace uses', () => {
  const stdioMarketplace = readJson(path.join(PLUGIN_DIR, '.claude-plugin', 'marketplace.json'));
  assert.equal(rootMarketplace().name, stdioMarketplace.name);
});

test('every plugin source in the root marketplace is a directory with a valid plugin.json', () => {
  for (const entry of rootMarketplace().plugins) {
    assert.match(entry.source, /^\.\//, `${entry.name}: source must be a relative path starting with ./`);
    assert.ok(!entry.source.split('/').includes('..'), `${entry.name}: source must stay inside the repository`);
    const manifestFile = path.join(REPO_ROOT, entry.source, '.claude-plugin', 'plugin.json');
    assert.ok(existsSync(manifestFile), `${entry.name}: ${manifestFile} is missing`);
    const manifest = readJson(manifestFile);
    assert.equal(manifest.name, entry.name, 'the marketplace entry and plugin.json name the same plugin');
    assert.match(manifest.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.equal(typeof manifest.version, 'string');
    assert.equal(typeof manifest.description, 'string');
    for (const [key, option] of Object.entries(manifest.userConfig ?? {})) {
      assert.ok(['string', 'boolean', 'file'].includes(option.type), `userConfig.${key} has an unknown type`);
      assert.equal(typeof option.title, 'string', `userConfig.${key} needs a title`);
      assert.equal(typeof option.description, 'string', `userConfig.${key} needs a description`);
    }
  }
});

test('every user_config reference in .mcp.json names a userConfig key', () => {
  const keys = Object.keys(pluginManifest().userConfig);
  const references = [...JSON.stringify(mcpConfig()).matchAll(/\$\{user_config\.([A-Za-z0-9_]+)\}/g)].map((match) => match[1]);
  assert.ok(references.length > 0);
  for (const reference of references) assert.ok(keys.includes(reference), `.mcp.json uses user_config.${reference}, which plugin.json does not define`);
});

test('directory_url is a user setting that defaults to empty and reaches the server as DACS_DIRECTORY_URL', () => {
  assert.equal(pluginManifest().userConfig.directory_url.type, 'string');
  assert.equal(pluginManifest().userConfig.directory_url.default, '');
  assert.equal(mcpConfig().mcpServers.demos.env.DACS_DIRECTORY_URL, '${user_config.directory_url}');
});

test('demos-find allows only the two read-only discovery tools', () => {
  const command = readFileSync(path.join(PLUGIN_DIR, 'commands', 'demos-find.md'), 'utf8');
  const allowed = command.match(/^allowed-tools: (.*)$/m);
  assert.ok(allowed, 'demos-find.md needs an allowed-tools line');
  assert.deepEqual(allowed[1].split(',').map((tool) => tool.trim()), DISCOVERY_TOOLS);
});
