// Synthetic clean report for offline positive controls, NOT a deployed or
// independently authenticated build. The historical deployment reports dirty
// and must be held. Written literally, not from DEVNET_NODE2_REVIEWED_BUILD, so
// a changed record is detected. commitMessage is null here: the transport
// compares name, version, commit, dirty and builtAt only after the fixture
// transport owner supplies separate independent TEST deployment authority.
export const NODE2_REVIEWED_NODE_VERSION = Object.freeze({
  name: 'demos-node-software',
  version: '0.9.8',
  commit: '61b8e75aa8db5e408c49e1c3a89db4d673f45578',
  commitShort: '61b8e75',
  commitMessage: null,
  branch: 'stabilisation',
  dirty: false,
  builtAt: '2026-10-14T16:45:24Z',
});
// null: a node that reports no nodeVersion at all.
export const node2NetworkInfo = (nodeVersion = NODE2_REVIEWED_NODE_VERSION) => ({
  result: 200,
  response: { forks: { osDenomination: { activationHeight: 0, activated: true, currentHeight: 10 } }, ...(nodeVersion === null ? {} : { nodeVersion: structuredClone(nodeVersion) }) },
  require_reply: false,
  extra: '',
});
