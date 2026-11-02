/**
 * Every `uses:` in .github/workflows/stdio-mcp.yml is pinned to a full 40-hex
 * commit SHA, so a moved tag or branch cannot change what CI runs. The check fails
 * closed: any non-comment line that mentions `uses` in any letter case must be a plain
 * `uses: owner/repo@<sha>`, and quoted keys and backslash escapes in double quotes,
 * which could spell `uses` another way, are refused outright. The file must be printable
 * ASCII, since JavaScript and YAML read a BOM, a no-break space or NEL differently.
 *
 * A SHA of the right shape could still be an old release or a commit from a fork, so each
 * pin must also be one listed in RELEASES, with that release in its comment.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const WORKFLOW = path.join(import.meta.dirname, '../../../.github/workflows/stdio-mcp.yml');
/** Without the CI workflow in the checkout there is nothing to check. CI always has it. */
const skip = !fs.existsSync(WORKFLOW) && !process.env.GITHUB_ACTIONS ? 'without the CI workflow' : false;
const PINNED = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[0-9a-f]{40}$/;

/**
 * The commit each action runs and the release tag it is. Before changing one, check that the
 * tag in that action's own repo points at the new SHA.
 */
const RELEASES: Record<string, string> = {
  'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1': 'v7.0.1',
  'actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1': 'v7.1.0',
};

/** True if the text is only printable ASCII and LF or CRLF line ends. */
const plainAscii = (text: string): boolean => !/[^\x20-\x7e\n]/.test(text.replace(/\r\n/g, '\n'));

/** Counts the `uses:` lines and returns each one not pinned to a 40-hex SHA. */
function unpinnedUses(yaml: string): { count: number; problems: string[] } {
  const problems: string[] = [];
  let count = 0;
  yaml.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/(^|\s)#.*$/, '');
    if (/["'][^"']*["']\s*:/.test(line) || /"[^"]*\\/.test(line)) {
      problems.push(`line ${i + 1}: ${raw.trim()}`);
      return;
    }
    if (!/\buses\b/i.test(line)) return;
    count++;
    const m = /^\s*(?:-\s+)?uses:\s*(['"]?)([^'"\s]+)\1\s*$/.exec(line);
    if (!m || !PINNED.test(m[2]!)) problems.push(`line ${i + 1}: ${raw.trim()}`);
  });
  return { count, problems };
}

/** The `uses:` lines that are not a pin in RELEASES followed by its release as the comment. */
function unlistedPins(yaml: string): string[] {
  const listed = new Set(Object.entries(RELEASES).map(([pin, release]) => `uses: ${pin} # ${release}`));
  return yaml.split(/\r?\n/)
    .filter((l) => /\buses\b/i.test(l.replace(/(^|\s)#.*$/, '')))
    .map((l) => l.trim().replace(/^-\s+/, ''))
    .filter((l) => !listed.has(l));
}

test('workflow: every uses: in stdio-mcp.yml is pinned to a 40-hex commit SHA', { skip }, () => {
  const text = fs.readFileSync(WORKFLOW, 'utf8');
  assert.ok(plainAscii(text), `a character other than printable ASCII, LF or CRLF in ${WORKFLOW}`);
  const { count, problems } = unpinnedUses(text);
  assert.ok(count > 0, `no uses: found in ${WORKFLOW}`);
  assert.deepEqual(problems, [], `not pinned to a full commit SHA:\n${problems.join('\n')}`);
});

test('workflow: each pin in stdio-mcp.yml is the commit of the release in its comment, as listed here', { skip }, () => {
  const text = fs.readFileSync(WORKFLOW, 'utf8');
  assert.deepEqual(unlistedPins(text), []);
  for (const [pin, release] of Object.entries(RELEASES)) assert.ok(text.includes(`uses: ${pin} # ${release}`), `${pin} # ${release} is listed but not used`);
});

test('workflow: the release check accepts a listed pin and refuses another SHA, repo or release', () => {
  const [pin, release] = Object.entries(RELEASES)[0]!;
  const [repo] = pin.split('@');
  assert.deepEqual(unlistedPins(`      - uses: ${pin} # ${release}`), []);
  for (const bad of [
    `      - uses: ${repo}@8ade135a41bc03ea155e62e844d188df1ea18608 # ${release}`, // an older real commit
    `      - uses: ${repo}@0123456789abcdef0123456789abcdef01234567 # ${release}`,
    `      - uses: someone/${pin.split('/')[1]} # ${release}`, // the same SHA from another repo
    `      - uses: ${pin} # v0.0.1`,
    `      - uses: ${pin}`,
  ]) assert.deepEqual(unlistedPins(bad).length, 1, bad);
});

test('workflow: the pin check accepts SHAs and refuses tags, branches and unrecognised forms; the character check refuses a BOM, a no-break space, NEL and a tab', () => {
  const sha = '11d5960a326750d5838078e36cf38b85af677262';
  for (const ok of [
    `      - uses: actions/checkout@${sha} # v4`,
    `      - uses: 'actions/checkout@${sha}'`,
    `        uses: github/codeql-action/init@${sha}`,
    `      # uses: actions/checkout@v4 (a comment)`,
  ]) assert.deepEqual(unpinnedUses(ok).problems, [], ok);
  for (const bad of [
    '      - uses: actions/checkout@v4',
    '      - uses: actions/checkout@main',
    `      - uses: actions/checkout@${sha.slice(0, 7)}`,
    `      - uses: actions/checkout@${sha.toUpperCase()}`,
    `      - uses: actions/checkout@${sha}0`,
    '      - uses: "actions/checkout@v4"',
    '      - uses: actions/checkout',
    '      - uses: ./local-action',
    '      - uses: docker://alpine:3',
    '      - { uses: actions/checkout@v4 }',
    '      - Uses: actions/checkout@v4',
    '      - "uses": actions/checkout@v4',
    '      - "u\\x73es": actions/checkout@v4',
    '      - { "u\\x73es": actions/checkout@v4 }',
    '        name: &k "u\\x73es"', // an anchor whose alias can be the key; only the backslash gives it away
    '      - ? uses', // a complex key, with the value on the next line
  ]) assert.equal(unpinnedUses(bad).problems.length, 1, bad);
  assert.ok(plainAscii('name: x\r\non: push # a comment\n'));
  for (const bad of [
    '\ufeffenv:', // a BOM, which JavaScript's trimStart() takes for indentation
    '      - run: npm test\u00a0#|| true', // a no-break space, which JavaScript's \s takes for a space
    '      - run: npm test # x\u0085      continue-on-error: true', // NEL, a line break in YAML 1.1
    '\t  if: false', // a tab, which YAML refuses as indentation and trimStart() counts as one
  ]) assert.equal(plainAscii(`name: x\n${bad}\n`), false, JSON.stringify(bad));
});
