import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scanAccounts, scanHosts, scanIps } from '../../scripts/public-gate/rules-address.mjs';
import { scanArchives, scanEnvTemplates, scanHostingFiles } from '../../scripts/public-gate/rules-files.mjs';
import { createPrivateMatcher, scanPrivate } from '../../scripts/public-gate/rules-private.mjs';

const LABEL = ['quartz', 'lantern'].join('-');
const UNLISTED_HOST = ['node1', 'harbor', 'dev'].join('.');
const UNLISTED_EMAIL = `someone@${UNLISTED_HOST}`;
const PUBLIC_ADDRESS = ['8', '8', '8', '8'].join('.');
const BLOB_ID = 'b'.repeat(40);
const ZIP_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const IDENTITY_FIELDS = ['position', 'path', 'pathBytes', 'oid'];
const CONFIG = { textExtensions: ['.md', '.txt'], allowedHosts: [], scopedAllowances: [], publicIdentities: [], ipDispositions: [] };
const LIMITS = { maxReportEntries: 1000 };

/** An object reader's entry for `file` holding `content`, with every field the reader sets. */
const entryFor = (file, content, position) => ({
  position, pathBytes: Buffer.from(file), path: file, mode: '100644', kind: 'blob', oid: BLOB_ID, size: Buffer.byteLength(content), problem: undefined, bytes: Buffer.from(content),
});

const entriesFor = (files) => Object.entries(files).map(([file, content], index) => entryFor(file, content, index + 1));

const privateMatcher = createPrivateMatcher([LABEL], () => {});

/** Each rule with files that give it findings of every kind it reports. */
const RULE_CASES = [
  { name: 'R-PRIVATE', scan: scanPrivate, files: { [`${LABEL}.txt`]: `holds ${LABEL}\n` }, kinds: ['content', 'path'] },
  { name: 'R-HOST', scan: scanHosts, files: { [`${UNLISTED_HOST}/notes.md`]: `see https://${UNLISTED_HOST}/x\n` }, kinds: ['content', 'path'] },
  { name: 'R-ACCOUNT', scan: scanAccounts, files: { [`${UNLISTED_EMAIL}.md`]: `write to ${UNLISTED_EMAIL}\n` }, kinds: ['content', 'path'] },
  { name: 'R-IP', scan: scanIps, files: { [`${PUBLIC_ADDRESS}.md`]: `at http://${PUBLIC_ADDRESS}/\n` }, kinds: ['content', 'path'] },
  { name: 'R-ENV unreadable template', scan: scanEnvTemplates, files: { '.env.example': 'A=1\0\n' }, kinds: ['content'] },
  { name: 'R-ENV refused assignment', scan: scanEnvTemplates, files: { '.env.example': 'API_TOKEN = REPLACE_ME\n' }, kinds: ['content'] },
  { name: 'R-HOSTING', scan: scanHostingFiles, files: { 'deploy/app.yaml': 'name: app\n' }, kinds: ['path'] },
  { name: 'R-ARCHIVE', scan: scanArchives, files: { 'vendor/notes.txt': ZIP_SIGNATURE }, kinds: ['content', 'path'] },
];

for (const { name, scan, files, kinds } of RULE_CASES) {
  test(`${name} findings name their entry by identity only: no blob bytes, every identity field kept`, () => {
    const entries = entriesFor(files);
    const findings = scan({ entries, matcher: privateMatcher, config: CONFIG, limits: LIMITS });
    assert.deepEqual([...new Set(findings.map((finding) => finding.kind))].sort(), kinds);
    for (const finding of findings) {
      const source = entries.find((entry) => entry.position === finding.entry.position);
      assert.equal('bytes' in finding, false);
      assert.equal('bytes' in finding.entry, false);
      assert.deepEqual(Object.keys(finding.entry).sort(), [...IDENTITY_FIELDS].sort());
      for (const field of IDENTITY_FIELDS) assert.deepEqual(finding.entry[field], source[field], field);
    }
  });
}
