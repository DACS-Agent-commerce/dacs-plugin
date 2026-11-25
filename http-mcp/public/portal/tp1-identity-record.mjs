// The browser's copy of the SDK's approved TP-1 identity record
// (TP1_APPROVED_IDENTITY_RECORD in @kynesyslabs/dacs/wire), with the SHA-256 of
// its canonical JSON (JCS) bytes. Browser code reads the network, chain
// identity and pin version here and never takes them from a server answer.
//
// The page loads this file on its own under `script-src 'self'`, so it imports
// nothing. The values are copied from the SDK by hand: at startup the server
// compares this copy's canonical bytes and digest with the SDK's record and its
// approved digests (src/tp1-record-copy.mjs), and refuses to start with
// tp1_record_copy_drift on any difference. A new SDK record needs a new copy
// here in the same change.
export const TP1_IDENTITY_RECORD = Object.freeze({
  format: 'dacs-testnet-identity-record/v1',
  recordId: 'dacs-demos-testnet-identity/2026-10-21',
  network: 'demos-testnet',
  chainIdentity: 'd59b54c2f70305e03d3a7e4d469f38295ffe4e4a62cb59b9f887057d0e5ca4bc',
  pinVersion: 'dacs-demos-testnet-identity/2026-10-21',
  provenance: Object.freeze({
    approvedBy: 'the owner',
    approvedAt: '2026-10-20',
    source: 'Approved Demos testnet identity record (2026-10-20)',
    sourceKind: 'confirmed-block-one-predecessor',
    documentation: 'Demos testnet nodes refuse a numeric block 0 (`getBlockByNumber` with `blockNumber: 0` returns RPC result 400). The chain identity is block 1\'s `content.previousHash`, the genesis hash a string `blockNumber: "0"` returns, checked against the approved record `dacs-demos-testnet-identity/2026-10-21`.',
  }),
});

/** Lowercase hex SHA-256 of the canonical JSON bytes of TP1_IDENTITY_RECORD. */
export const TP1_IDENTITY_RECORD_DIGEST = '4118a9181f5d6e475c446d44eebeb9fde703eba3fe4fde37ddfee40369f48066';
