# Admitted Node2 recipient balance readback

This opt-in command reads one public Demos testnet address through the existing reviewed Node2 admission and binding guard. It creates no wallet, loads no custody record, signs nothing, requests no faucet funds and sends no transaction.

```text
node scripts/devnet-demo-recipient-balance.mjs \
  --admission=/absolute/private/run/node2-admission.json \
  --address=0x<64-lowercase-hex>
```

The command accepts only an exact 66-character lowercase public address. The operator must supply the fresh buyer or seller address printed by the separately scoped custody bootstrap; this read-only command cannot prove address provenance or freshness and never inspects private custody.

The server checkout deliberately does not install the optional DemosSDK Node peer; its pinned executable SDK is a browser-only bundle. This entry point therefore preserves the exact public `@kynesyslabs/demosdk` 4.0.16 `getAddressInfo(address)` method and `nodeCall('getAddressInfo', {address})` contract in a narrow server facade rather than importing the browser bundle or opening an unbound SDK connection. The `nodeCall` is routed through the admitted transport. Before the address RPC, the transport freshly checks the exact endpoint, network, transport owner and reviewed chain identity under one connection fence. For the reviewed Node2 predecessor layout it also rechecks the admitted block-one predecessor and exact block-two hash. A missing, altered or unavailable admission/binding holds the read.

Successful stdout contains only:

- `status: "observed"`, the requested public address, exact `balanceOs` and derived `balanceDem` strings, plus the fixed SDK contract identity and its admitted-nodeCall execution mode;
- the admitted public network, endpoint, chain identity, transport authority and pin version;
- the admission hash, observation time and an explicit single-node TEST scope.

Other account fields returned by the node are discarded. A missing, numeric JSON value, negative, fractional or otherwise non-canonical balance is indeterminate and fails closed; only a non-negative decimal string is accepted. The balance is a single-node observation, not consensus finality, a faucet receipt, proof of spendability or approval for any debit.

Run this only after the exact admission has been reviewed. Compare the public address and balance with the separately selected purchase/fee plan. Every later Agreement CREATE, native payment and seller CREATE still requires its normal exact interactive approval; this command supplies no approval authority.
