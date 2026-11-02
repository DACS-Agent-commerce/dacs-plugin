// The nine switches converted to src/switches/ files behave exactly as
// the inline loadConfig of the v1 baseline did: contract entry, result or exact error
// for each value, held messages, and the order in which their errors win and
// where that block sits among the other checks. The fixture was written once
// from the v1 baseline by scripts/config-equivalence-migration.mjs --write-fixture,
// which also holds the one-off full-matrix comparison (migration evidence),
// and is never edited by hand. The one intended change since then, the
// Start intent switch's contract note for DACS_PORTAL_AUTO_ADVANCE, is asserted on its own below.
//
// Only these switches are pinned: a change elsewhere in loadConfig never
// touches the fixture, and a new switch never edits this test. A deliberate
// change to one of the nine updates the fixture in the same change. No git needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/config.mjs';
import { switchSlice } from '../scripts/config-equivalence-migration.mjs';
import { contractView } from './helpers/env-contract-view.mjs';

const { generatedFrom, by, ...fixture } = JSON.parse(readFileSync(new URL('./fixtures/switch-slice-v1-baseline.json', import.meta.url), 'utf8'));

test('the nine converted switches keep the v1 baseline\'s values, defaults, deploy values, held messages, errors and order', () => {
  assert.equal(Object.keys(fixture.switches).length, 9);
  const keys = Object.fromEntries(Object.entries(fixture.switches).map(([name, s]) => [name, s.configKey]));
  const slice = switchSlice(loadConfig, contractView().variables, keys);
  // The Start intent switch added this note after the v1 baseline; nothing else may differ.
  const autoAdvanceNote = 'on is refused by loadConfig (and createApp) together with DACS_INTENT_APPROVAL=on';
  assert.equal(fixture.switches.DACS_PORTAL_AUTO_ADVANCE.contract.note, undefined, 'the fixture is the v1 baseline\'s, as --write-fixture writes it');
  assert.equal(slice.switches.DACS_PORTAL_AUTO_ADVANCE.contract.note, autoAdvanceNote);
  const expected = structuredClone(fixture);
  expected.switches.DACS_PORTAL_AUTO_ADVANCE.contract.note = autoAdvanceNote;
  assert.deepEqual(slice, expected);
});
