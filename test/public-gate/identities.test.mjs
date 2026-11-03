import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../../scripts/public-gate/gate.mjs';
import { createHistory, historyArgs, runHistory, writeList } from '../lib/gate-fixtures.mjs';

const PLANTED = ['quartz', 'lantern'].join('-');
const ALLOWED = 'Project <project@example.invalid>';
const [PUBLICATION_IDENTITY] = loadConfig().publicIdentities;
const [PUBLICATION_NAME, PUBLICATION_EMAIL] = PUBLICATION_IDENTITY.slice(0, -1).split(' <');
const OTHER_IDENTITY = 'Other Person <other@example.invalid>';
const UNLISTED_EMAIL = ['person', ['corp-mail', 'io'].join('.')].join('@');
const outputOf = (run) => `${run.stdout}${run.stderr}`;
const withIdentity = (history, extra = []) => runHistory(historyArgs(history, writeList([PLANTED]), ['--allowed-identity', ALLOWED, ...extra]));
const located = (run, history) => JSON.parse(run.stdout).findings.map((finding) => [finding.rule, finding.kind, history.commits.indexOf(finding.commit), finding.location.split(':')[1], finding.line]);

test('a private-list value only in the author field, or only in the committer field, of an earlier commit with a clean descendant fails, and the finding names commit and field but never the value; an identity email or trailer identity that is not an exact publicIdentities entry fails; an exact approved identity passes', () => {
  const history = createHistory([
    {},
    { author: { name: PLANTED, email: 'a@example.invalid' } },
    { committer: { name: PLANTED, email: 'c@example.invalid' } },
    {},
  ]);
  const privateRun = runHistory(historyArgs(history, writeList([PLANTED])));
  assert.equal(privateRun.status, 1, privateRun.stderr);
  assert.deepEqual(located(privateRun, history), [['R-PRIVATE', 'author', 1, 'author', undefined], ['R-PRIVATE', 'committer', 2, 'committer', undefined]]);
  assert.ok(!outputOf(privateRun).includes(PLANTED));

  const trailers = createHistory([
    {},
    { message: `subject\n\nbody\nCo-authored-by: ${OTHER_IDENTITY}\nSigned-off-by: ${PUBLICATION_NAME} <${UNLISTED_EMAIL}>` },
    { message: `subject\n\nSigned-off-by: ${PUBLICATION_IDENTITY}\nCo-authored-by: ${ALLOWED}` },
    { author: { name: PUBLICATION_NAME, email: 'other@example.invalid' } },
    { committer: { name: 'Someone', email: PUBLICATION_EMAIL } },
  ]);
  const refused = withIdentity(trailers);
  assert.equal(refused.status, 1, refused.stderr);
  assert.deepEqual(located(refused, trailers), [
    ['R-ACCOUNT', 'message', 1, 'message', 5], ['R-IDENTITY', 'author', 3, 'author', undefined], ['R-IDENTITY', 'committer', 4, 'committer', undefined],
    ['R-IDENTITY', 'message', 1, 'message', 4], ['R-IDENTITY', 'message', 1, 'message', 5],
  ]);
  for (const value of [OTHER_IDENTITY, UNLISTED_EMAIL, 'other@example.invalid']) assert.ok(!outputOf(refused).includes(value), value);

  const approved = createHistory([
    { author: { name: PUBLICATION_NAME, email: PUBLICATION_EMAIL }, committer: { name: PUBLICATION_NAME, email: PUBLICATION_EMAIL } },
    { message: `subject\n\nSigned-off-by: ${PUBLICATION_IDENTITY}\nCo-authored-by: ${ALLOWED}\nsigned-off-by: ${PUBLICATION_IDENTITY}` },
  ]);
  const passing = withIdentity(approved);
  assert.equal(passing.status, 0, passing.stderr);
  assert.deepEqual(JSON.parse(passing.stdout).rules.find((rule) => rule.id === 'R-IDENTITY'), { id: 'R-IDENTITY', status: 'passed' });
});
