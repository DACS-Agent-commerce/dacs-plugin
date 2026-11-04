# Provenance

Every file in this repository's first commit, except this manifest, came from an
earlier private plugin repository at the same path (two fixture files carry a
new name, noted in their rows), or was added for this repository. Files marked `added` that are not in the first commit (the root package, `scripts/`, `test/`,
`docs/PUBLIC-GATE.md` and `public-gate.config.json`) were added by later changes. Each row gives the file's current blob and whether the file is
byte-for-byte unchanged from that repository (`verbatim`), was edited before
import (with the reason), or was added. A file changed in this repository after
the first commit keeps its row, with the blob of its current content and
the change (`changed here`) added to the reason.

## Not carried

Files from the earlier repository that are not in this one:

- The built-in network client and its copies of SDK purchase, journal, readback and
  funding code (`http-mcp/src/dacs/`, `vendor/` and five related modules). These
  are planned to come from the published SDK instead.
- The development demo, the deploy tooling and three agreement brokers.
- Scripts, tests, docs and fixtures that serve only those files.
- Internal review and process records, and the CI workflows (added later).
- Files deleted from a kept folder before import: two operator records and one CI
  requirements note, which were internal process records.
- Two tests deleted from a kept test file (`http-mcp/test/v2-publication-removal.test.mjs`):
  they read deploy scripts that are not carried, so they could not pass here.

## Adapted sources

Two small pieces are adapted from other sources.

- The **Community DACS Directory** is a public repository, MIT licensed (per GitHub's API). It is the source of the wallet provider contract, the directory API, storage-program naming and address derivation, and the registration message. The modules below re-implement these formats in this repository's own code. They cite the Community files and functions they follow; the files show no copied code and the Community source was not compared line by line, so no Community copyright notice is carried here. The modules that name that repository are:
  - code: `http-mcp/src/wallet/demos-signature.mjs` (address and signature encodings, from its wallet contract), `http-mcp/public/portal/portal.js` (provider discovery and request shapes follow the same contract), `http-mcp/bin/offline-fixtures/chain.mjs` (storage address derivation), `http-mcp/bin/offline-fixtures/directory.mjs` (registration message; a simulated directory) and `http-mcp/bin/offline-fixtures/seller.mjs` (directory summary shape);
  - tests and fixtures: `http-mcp/test/fixtures/directory-server.mjs`, `http-mcp/test/helpers/harness.mjs`, `http-mcp/test/helpers/overnight-core-fixtures.mjs`, `http-mcp/test/browser/portal.browser.test.mjs`, `http-mcp/test/unit.test.mjs` (test names), and the tests that import `communityProgramName` (`unit.test.mjs`, `dacs-demos-sr2-wallet.test.mjs`, `overnight-core-seller.test.mjs`);
  - docs and configuration: `http-mcp/README.md` (its "Provenance" section), `http-mcp/docs/CHATGPT-DEVELOPER-MODE.md`, `DEPLOYMENT-CHECKLIST.md`, `OFFLINE-TESTER.md`, `OVERNIGHT-CORE.md`, `OVERNIGHT-UI.md` and `TESTER-DASHBOARD.md` (all under `http-mcp/docs/`), and `http-mcp/.env.example` (the directory origin setting).
- The `validateListingArtifact` wiring is adapted from an earlier demo, which was our own code.

Files: 750 (verbatim 504, edited 216, changed here 6, added 24).

| Path | Blob | Disposition |
| --- | --- | --- |
| `.gitleaksignore` | `5f6b32b9b0f7f675ea49a6dae958c1f8b0016d90` | added: exact secret-scanner exceptions for a generated bundle and a byte-identical public conformance vector, each with its reason |
| `LICENSE` | `a2ad961723d947d17fbc0281d345ae276fd94496` | added: MIT license, same text and holder as the DACS-Standard repository |
| `README.md` | `857e78943e5bf734cb2542f4ae8691c0e55259a9` | edited: rewritten as this repository's overview; a "state of this repository" section; the shared-package sentence made true on every branch |
| `docs/PUBLIC-GATE.md` | `1678668758708b1f5030c78c329067d61202ba85` | added: documentation of the public-content gate |
| `http-mcp/.dockerignore` | `aae035eb68f5747b0bda683606503b97ca99afdf` | edited: public wording: internal process and layout references removed or reworded |
| `http-mcp/.env.example` | `61149650b005fca4655a1ba4d338e3b2a5f52f7d` | verbatim |
| `http-mcp/.gitignore` | `1a8d076aff4a0fae67103239e52b41dd82b25daf` | verbatim |
| `http-mcp/Dockerfile` | `3022187f12cadd3b40980a8911840d832ffe5299` | verbatim |
| `http-mcp/README.md` | `e8b5bbccd7f61b9608866aa761672f4680185ebf` | edited: public wording: internal review, process, PR and private-path references removed or reworded; a "state of this repository" section; install directory corrected; no private commit id or planned tag; Community source license and re-implementation stated |
| `http-mcp/bin/dacs-chatgpt-offline-test.mjs` | `a7d035520a1632b822cb03c05fd589f19a9052ea` | verbatim |
| `http-mcp/bin/dacs-chatgpt-plugin.mjs` | `7352d9ac1f5c9aa79a7591a4f52a6bb27b2744e1` | verbatim |
| `http-mcp/bin/dacs-ops-health.mjs` | `ac5dd38a6989bea4dbb4e9edfb9e3b91ba0a2035` | verbatim |
| `http-mcp/bin/offline-fixtures/chain.mjs` | `bc48907fd3c33c3b3556b8ba53ddffb14316fc2f` | verbatim |
| `http-mcp/bin/offline-fixtures/directory.mjs` | `b29f7594f5b3808893884c5b3eb525c574165e67` | verbatim |
| `http-mcp/bin/offline-fixtures/http.mjs` | `4105797c95ee2080de97ddb6c9f2b2f5e3673d89` | verbatim |
| `http-mcp/bin/offline-fixtures/operator.mjs` | `1863e290ba30f7c231120244737db6aba803a361` | edited: public wording: internal process and layout references reworded
| `http-mcp/bin/offline-fixtures/proofs.mjs` | `eed1ca23727d94474229893c034e7ff88ed6d702` | verbatim |
| `http-mcp/bin/offline-fixtures/seller.mjs` | `50e2452fedba2dbda69d33477c269cc42daf0b7b` | verbatim |
| `http-mcp/bin/offline-fixtures/tester-dashboard.mjs` | `0dda341cf7b5a89346bf6c5b26ffd230f35e1afd` | verbatim |
| `http-mcp/bin/offline-fixtures/tester-ui/dashboard.css` | `f07b2d52b2203a7f1c1bd51355ed07c88260e96d` | verbatim |
| `http-mcp/bin/offline-fixtures/tester-ui/dashboard.js` | `1b518aa2253517a41e0b152c334c6606dbcc762e` | verbatim |
| `http-mcp/bin/offline-fixtures/tester-ui/index.html` | `1affc91c0383a8891ffaa9aa8d87569901e06f5a` | verbatim |
| `http-mcp/docs/CHATGPT-DEVELOPER-MODE.md` | `d59ae0969c74048f55fc4a5fdcfce145a9495dc6` | edited: public wording: internal review, process, PR and private-path references removed or reworded; further public wording |
| `http-mcp/docs/CI.md` | `a34189e873aea77f25fd929f4634dc8eb02343c8` | edited: public wording: internal review, process, PR and private-path references removed or reworded; further public wording; a "state of this repository" note; baseline and discovery-count text corrected to this tree; a private commit id removed |
| `http-mcp/docs/CONNECT-OTHER-CLIENTS.md` | `b9baac786e7c40bb2453aabd2088ea63a3f8ef9a` | verbatim |
| `http-mcp/docs/CURRENT-TESTER-PACKAGE.md` | `eb83facc209e15cbac39d5b6a33dfc2799a9c525` | edited: public wording: internal review, process, PR and private-path references removed or reworded; the tarball and original-artifact lookup described as the test now does it |
| `http-mcp/docs/DEPLOYMENT-CHECKLIST.md` | `1dc60328b6f1b6d12616b9ff9cb25fb25c0639f7` | edited: public wording: internal review, process, PR and private-path references removed or reworded |
| `http-mcp/docs/DEVNET-CHATGPT-OPERATOR.md` | `2d86e855cb1eee82646a88359090dfacc9b85ba4` | verbatim |
| `http-mcp/docs/DEVNET-FIXED-PRICE-DEMO.md` | `cfc6f52348dcf403adec5a25d01f357239953c64` | edited: host replaced by a reserved .invalid host; link to a document that is not carried removed |
| `http-mcp/docs/DEVNET-NATIVE-BLOCK-ZERO-FALLBACK.md` | `367fdde3412f58192d959642171b4acbfbde4555` | verbatim |
| `http-mcp/docs/DEVNET-NATIVE-TRANSPORT.md` | `d37482a384affb4d1a18914ce9dd05e089da2ffc` | edited: public wording: internal review, process, PR and private-path references removed or reworded; further public wording |
| `http-mcp/docs/DEVNET-NODE2-BLOCK-ONE-LAYOUT.md` | `16409a552f48f71cd0fe474128e6d8423489358e` | verbatim |
| `http-mcp/docs/DEVNET-NODE2-FALLBACK.md` | `5ecd381cfb596aa109b6a4da286ff8499025b820` | edited: public wording: internal review, process, PR and private-path references removed or reworded |
| `http-mcp/docs/DEVNET-NODE2-SR2-BINDING.md` | `14be5edb59a22104b9a03269b7bd78f004aed1ef` | verbatim |
| `http-mcp/docs/DEVNET-OPERATOR-CLI-ISSUED-RECOVERY.md` | `7d314b142320194edeeca8378bc0138ef1bef1b5` | edited: internal process wording removed (no review-gate or candidate references) |
| `http-mcp/docs/DEVNET-OPERATOR-CLI.md` | `98426b5001a38dc04d6a6814c0939beb3b33fa8d` | verbatim |
| `http-mcp/docs/DEVNET-OPERATOR-PAYMENT-RECOVERY.md` | `4dc6ed1b4732550f1df0cd1c98fe13c64dcfda30` | verbatim |
| `http-mcp/docs/DEVNET-OPERATOR-RECOVERY.md` | `720a802556ca9bae6858b2f21d35a0d34bdccd45` | verbatim |
| `http-mcp/docs/DEVNET-OPERATOR-SEQUENTIAL.md` | `3e9a84e829333d12e1e2e749c84f96fca3d80f5d` | verbatim |
| `http-mcp/docs/DEVNET-RECIPIENT-BALANCE.md` | `f36e480bf8de10b940207b03c2ef7a3308ef00fd` | verbatim |
| `http-mcp/docs/DURABLE-WALLET-JOURNAL.md` | `4a48ffad0a2593dc55d3322adf517924cd12ad88` | edited: fixture path renamed |
| `http-mcp/docs/EMBEDDED-WALLET-FLOW-COVERAGE.md` | `27798c78872f503dba182cbad06176634e764381` | edited: public wording: internal review, process, PR and private-path references removed or reworded; directory name in a column header corrected; digests of internal run logs and a source manifest removed |
| `http-mcp/docs/EMBEDDED-WALLET-INTEGRATION.md` | `d5894a9ff7498d9e86e98500bdd5f6fb1220bfb5` | edited: public wording: internal review, process, PR and private-path references removed or reworded |
| `http-mcp/docs/EMBEDDED-WALLET-PACKAGING.md` | `f69d900b7b3dc87df226124e625b49a3b2dae073` | edited: exclusion wording follows the renamed label
| `http-mcp/docs/EMBEDDED-WALLET-SDK.md` | `06d78b664e6d9b0c42bc9b88719effb327b4a47f` | edited: public wording: internal review, process, PR and private-path references removed or reworded; further public wording; build and test commands written as plain npm and node commands |
| `http-mcp/docs/EMBEDDED-WALLET-TESTER.md` | `257fea10444ec1c8306dc23a074a52b857dbb987` | edited: public wording: internal review, process, PR and private-path references removed or reworded; security review status given in the exact public sentence; directory name in a command corrected; public wording: internal process and layout references reworded |
| `http-mcp/docs/EMBEDDED-WALLET-UI.md` | `ef559cc6f95a207be660285391a0451d2b1ec348` | edited: public wording: internal review, process, PR and private-path references removed or reworded; public wording: internal process and layout references reworded |
| `http-mcp/docs/FEE-APPROVAL-RECOVERY-CONTRACT.md` | `66133790dbd106b2453a777e554540e437b928de` | edited: public wording: internal review, process, PR and private-path references removed or reworded |
| `http-mcp/docs/IDENTITY-RECOVERY.md` | `070df4a46056f9238aa380364ba92a3253a88393` | verbatim |
| `http-mcp/docs/NATIVE-AGREEMENT-PAYMENT.md` | `930cb1c065d7f2bbbb9e21f074d3931232c9674b` | edited: public wording: internal review, process, PR and private-path references removed or reworded; further public wording |
| `http-mcp/docs/NATIVE-SELLER-TIMEOUT-RECOVERY.md` | `b3fe87d7a5e00095d0ace50df5e94e13971fd43b` | verbatim |
| `http-mcp/docs/NODE2-NATIVE-TRANSFER-READBACK-COMPATIBILITY.md` | `846fb8223f6d92cc3c1d905fdd4fa7686c4a06c7` | edited: public wording: internal review, process, PR and private-path references removed or reworded |
| `http-mcp/docs/NODE2-STORAGE-PROVENANCE-COMPATIBILITY.md` | `b79d1bf05c4c776301daf8bac2c0eef97a0cf741` | verbatim |
| `http-mcp/docs/OFFLINE-BROWSER-AGREEMENT.md` | `9fb5e7d651b8b22997952ab8a705c7c5e2adab29` | edited: public wording: internal review, process, PR and private-path references removed or reworded |
| `http-mcp/docs/OFFLINE-TESTER.md` | `2a4cc59889c663d6bcb3b3f109bff17775954f2f` | edited: public wording: internal review, process, PR and private-path references removed or reworded; public wording: internal process and layout references reworded |
| `http-mcp/docs/OPS-HEALTH.md` | `97551595402c9aa04d0cb4a02771cbac05b31d09` | edited: public wording: internal review, process, PR and private-path references removed or reworded; a private commit id removed |
| `http-mcp/docs/OVERNIGHT-CORE.md` | `42cc2c63e09a139373593cea786f42ccd2c523e4` | edited: public wording: internal review, process, PR and private-path references removed or reworded |
| `http-mcp/docs/OVERNIGHT-FUNCTIONAL-TESTS.md` | `7d116a6efc859d82fb212eb47b7687c5c9de25b9` | edited: test-run result logs removed; public wording |
| `http-mcp/docs/OVERNIGHT-PACKAGING.md` | `bdacedbcb12741f55de173c81671d6898685a635` | edited: directory name in a column header corrected; exclusion wording follows the renamed label |
| `http-mcp/docs/OVERNIGHT-UI.md` | `f93b4a1ea1dec840feae013dbda1f6127ba37ebe` | edited: public wording: internal review, process, PR and private-path references removed or reworded |
| `http-mcp/docs/PUBLIC-SR2-PROJECTION.md` | `9b44e06734ab928d41c7ac517e5ac161f4701cca` | edited: public wording: internal review, process, PR and private-path references removed or reworded |
| `http-mcp/docs/PURCHASE-READBACK-CACHE.md` | `77db1bf32cf47ae94d3cf7a12998bf0acf205270` | edited: public wording: internal review, process, PR and private-path references removed or reworded |
| `http-mcp/docs/PURCHASE-RECEIPT.md` | `4c40f35844d1e1601a2be2b1844a839990811103` | edited: public wording: internal review, process, PR and private-path references removed or reworded |
| `http-mcp/docs/PURCHASED-REPORT-VIEW.md` | `b630c492303611c1da04fdc95966b17719927fed` | edited: public wording: internal review, process, PR and private-path references removed or reworded; then changed here: the four seller fields that reach the model raw are named as a known gap; then changed again: those four fields are described as labelled seller text and the known-gap note is removed; no behaviour change |
| `http-mcp/docs/SELLER-POLICY-AND-DELIVERY-EVIDENCE.md` | `c2d72575e79f76d500cc356919c2d69cca894b2c` | verbatim |
| `http-mcp/docs/SELLER-SESSION-DELEGATION.md` | `8fd3ab45639a1072833b4759b5111ecfeb5ca912` | edited: reference to a document that is not carried removed; decision dates removed |
| `http-mcp/docs/SELLER-SR2-AGREEMENT-INTEGRATION.md` | `c2bcd14e05a0cb6886639bd18f2260faf68b85fc` | edited: public wording: internal review, process, PR and private-path references removed or reworded |
| `http-mcp/docs/SELLER-UNCERTAIN-PAYMENT-RECOVERY.md` | `1d43f7697860d6023b8dc26cf9146d4bd720665f` | edited: public wording: internal review, process, PR and private-path references removed or reworded |
| `http-mcp/docs/SERVICE-PUBLIC-TEXT-REPORT.md` | `386b1e8778be522ecc55786e6ef377fe6c6c6233` | edited: public wording: internal review, process, PR and private-path references removed or reworded |
| `http-mcp/docs/SERVICE-REQUEST-BINDING.md` | `75024bc4c5d4c53fa4ad859e7e8eee148d7c90c7` | edited: links into a local spec checkout replaced by citations and one link to the public DACS-Standard repository; public wording |
| `http-mcp/docs/SHOWCASE-LEDGER.md` | `389bcb6ea79648030446c3343206786ecd06cdb4` | verbatim |
| `http-mcp/docs/SHOWCASE-QUICKSTART.md` | `20906a34824e65989896b9d9b4752f1413465adf` | edited: public wording: internal review, process, PR and private-path references removed or reworded |
| `http-mcp/docs/SHOWCASE-SAFETY.md` | `8752f96214435ce8ac480314c0e9954abe26fe91` | edited: link to a document that is not carried removed |
| `http-mcp/docs/SR2-BINDING-OMISSION-CONSUMER.md` | `94f8c8607740e0a52a948358e96a2cfca1c8898b` | verbatim |
| `http-mcp/docs/SR2-PAIRED-ABSENT-PROVENANCE.md` | `0590240d97237215551c6b264945919ac5501f78` | verbatim |
| `http-mcp/docs/START-INTENT.md` | `06a9696c413716341d31912f8fd294a761d7d142` | verbatim |
| `http-mcp/docs/STORAGE-PROGRAM-BINDING-OMISSION-READBACK.md` | `e7d9c358e0f892e3b47eaeb857b9eeb355f3a125` | edited: public wording: internal review, process, PR and private-path references removed or reworded; further public wording |
| `http-mcp/docs/SWITCHES.md` | `547a9b89ae7a9be377375535144157fa9451e7a0` | edited: "this PR" wording replaced by a description; further public wording |
| `http-mcp/docs/TESTER-DASHBOARD.md` | `1beab6f78d92fbe01b4312cf3da21aac9396ae10` | edited: public wording: internal review, process, PR and private-path references removed or reworded |
| `http-mcp/docs/TESTER-QUICKSTART.md` | `ad5e77e9fc666f8dd383503beab9e9690c9667d3` | edited: public wording: internal review, process, PR and private-path references removed or reworded; security review status given in the exact public sentence; directory name in a command corrected |
| `http-mcp/docs/TESTING.md` | `669bf85470717c6cc0d01c14561eb32f6d5ed348` | edited: a "state of this repository" note; install directory corrected |
| `http-mcp/docs/WALLET-EXTENSION-PROBE.md` | `fe3e9432d64faa61b3c64f617163e8c65f50350b` | edited: public wording: internal process and layout references removed or reworded; further public wording |
| `http-mcp/docs/WALLET-WRITE-BATCH.md` | `0853b7ee0a6a46510f99bedcae97ddf03fc7c65a` | edited: public wording: internal review, process, PR and private-path references removed or reworded |
| `http-mcp/docs/commit-on-signature.md` | `723174576d87f2895fccbc37b9a722896737f3c8` | edited: issue-number reference replaced by a description (its test changes in step) |
| `http-mcp/docs/delivery-deadline-watch.md` | `18c9f8a42e457fa61b47f0ce203e1b4bbc60f79c` | edited: public wording: internal review, process, PR and private-path references removed or reworded |
| `http-mcp/docs/devnet-agreement-transport.md` | `2f230216fa3a2ec5e03bb36016bddf2deb0cf309` | edited: public wording: internal review, process, PR and private-path references removed or reworded |
| `http-mcp/docs/native-payment-evidence-consumer.md` | `3b121a3e61cb94325703c24f7956b31a443b4ee9` | edited: public wording: internal review, process, PR and private-path references removed or reworded |
| `http-mcp/docs/portal-auto-advance.md` | `ccf48e2d4e8955c3d6745b09f9560d85c517be1a` | edited: public wording: internal review, process, PR and private-path references removed or reworded |
| `http-mcp/mcp.json` | `565630e183d3559e9c0f7da0a81c054cc064ada0` | verbatim |
| `http-mcp/package-lock.json` | `d3d01a5c71a21d988596b93279c7fa5c7894536e` | edited: root package license set to MIT, matching package.json |
| `http-mcp/package.json` | `582841fe3c364d9ed67df91c897c6486e82c62af` | edited: license set to MIT; repository points to this repository and directory |
| `http-mcp/plugin.json` | `9820cd34c0027251b6d4499c84c1ca29cb9f60cd` | edited: license set to MIT; repository points to this repository |
| `http-mcp/public/portal-intent/gate.mjs` | `ed8fb412466972e69d6c84233b94ba8c81eb8e96` | verbatim |
| `http-mcp/public/portal-intent/intent.mjs` | `4fec4e1eb4d5443e4c9434cbb45127e31d82b2a1` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/public/portal-intent/signature-journal.mjs` | `94824f52830dc08ae6c45a1bf9ce3c97e1b30693` | verbatim |
| `http-mcp/public/portal-intent/start-flow.mjs` | `43659bef419d93452029a7d330950d2a7b8d78bf` | verbatim |
| `http-mcp/public/portal-intent/start.mjs` | `00d3f80cc232e9f3855801036e45fa0e82e47461` | verbatim |
| `http-mcp/public/portal/embedded-wallet-bridge.mjs` | `6e80eb7812c0a87912b8ece019f9161ca01e3b9b` | verbatim |
| `http-mcp/public/portal/embedded-wallet/approval.mjs` | `5a5ea17d477fbc03868584a1793661f0d971d7fe` | verbatim |
| `http-mcp/public/portal/embedded-wallet/demos-runtime.mjs` | `0912c463693180f6f5fd73f83dea2bf0ed104acc` | verbatim |
| `http-mcp/public/portal/embedded-wallet/dom.mjs` | `8b30f91cbb86fccb7c0d33593167858ea52d9ca1` | verbatim |
| `http-mcp/public/portal/embedded-wallet/embedded-wallet.css` | `477f2657448917ae6eb2635dbbbd7ac082da9a62` | verbatim |
| `http-mcp/public/portal/embedded-wallet/index.html` | `fa3e6b7d8e81c18872bb6f7d756afb74b44afb6b` | verbatim |
| `http-mcp/public/portal/embedded-wallet/main.mjs` | `81a817131e730bf02509924d89cb69f0d5b41a90` | edited: public wording: internal process and layout references reworded
| `http-mcp/public/portal/embedded-wallet/runtime-chunks/chunk-3UJPRL3I.mjs` | `eeb18d411c0c6e39c0b57dcceea364d8b2d59d54` | verbatim |
| `http-mcp/public/portal/embedded-wallet/runtime-chunks/chunk-6EJ2AFTE.mjs` | `225eaa9087f3bbe020fca8133cdf8314cb2730ac` | verbatim |
| `http-mcp/public/portal/embedded-wallet/runtime-chunks/chunk-7OGVXGZV.mjs` | `c420e04e0b82c351d8726241668da69301690713` | verbatim |
| `http-mcp/public/portal/embedded-wallet/runtime-chunks/chunk-GEQKB2PE.mjs` | `06316849c15b6b2d1c9558ac3af92ae173910b57` | verbatim |
| `http-mcp/public/portal/embedded-wallet/runtime-chunks/chunk-SSXDWXVZ.mjs` | `7fb8da27c8041d4688f640b1c8f8d8c2461ff6b0` | verbatim |
| `http-mcp/public/portal/embedded-wallet/runtime-chunks/chunk-YUIZVLEY.mjs` | `57fce607ea6f158bc82913323dda5f99bc9a2f7a` | verbatim |
| `http-mcp/public/portal/embedded-wallet/runtime-chunks/entry-AVSAFOKW.mjs` | `7e2c5cfab5d666a98c5cef4f39cd14a60fcae7ba` | verbatim |
| `http-mcp/public/portal/embedded-wallet/runtime-manifest.json` | `ccd667c3d4869f62728d44a8e1e0810ba82e2adc` | verbatim |
| `http-mcp/public/portal/embedded-wallet/sdk-provider.mjs` | `6e82c6a7056ffb44431ae2a1c643e0ca5ca4ef76` | edited: held-gate id renamed to external-security-review; comments: internal references removed; held-write message states only that the external security review is on hold; further public wording |
| `http-mcp/public/portal/embedded-wallet/stores.mjs` | `5ac4343b09dd01d1e4608e21878208d832c81b81` | verbatim |
| `http-mcp/public/portal/embedded-wallet/ui.mjs` | `f393a15669bcc9aed9bef0c0e4be067a523edf4f` | edited: held-write message states only that the external security review is on hold |
| `http-mcp/public/portal/embedded-wallet/vault.mjs` | `a719e24f38605351df2c29d451e3ea90185f2d59` | verbatim |
| `http-mcp/public/portal/index.html` | `12e87e4d5c4400f57ceb02756abce1af1679373a` | verbatim |
| `http-mcp/public/portal/portal.css` | `a6385360ad0131096bf0ac4e5846e4bacfee8052` | verbatim |
| `http-mcp/public/portal/portal.js` | `5dba627b180b3ae1acd76cb52b4227dbc5d01d3d` | edited: held-write message states only that the external security review is on hold; further public wording |
| `http-mcp/public/portal/purchased-report.mjs` | `f64f78d96fc3b850a702a5a2d71100484dbfdea5` | verbatim |
| `http-mcp/public/portal/seller-identity.mjs` | `c21ce4ca4105ffa94b032c05be2d28bf9e284e09` | verbatim |
| `http-mcp/public/portal/seller-name.mjs` | `bcddb5789d7d1f8c5e572001d3e4edd2b9729eb4` | verbatim |
| `http-mcp/public/portal/seller-session-delegation.mjs` | `717d8986a2043f57409379655e1602dd916af484` | verbatim |
| `http-mcp/public/portal/seller-session-limits.mjs` | `6ca54be7de1d2eeb0fa4a16c2a3a48be0cda2a99` | verbatim |
| `http-mcp/public/portal/showcase-progress.mjs` | `8ec8b3b146d97aa3cbf4e8d67ac01c3d08373cd3` | verbatim |
| `http-mcp/public/showcase/beyond-fixed-price.html` | `0f396493cf22619a1cba0c21feeba7265a429ac3` | verbatim |
| `http-mcp/public/showcase/index.html` | `da11e5801b49933499dae07af4e4096353f7e78a` | verbatim |
| `http-mcp/public/showcase/showcase.css` | `8f391d8b325775714c714beb6742a139c158b313` | verbatim |
| `http-mcp/public/showcase/walkthrough.html` | `2b2c1f637cd6163162207a63283ed94b1b417393` | verbatim |
| `http-mcp/public/wallet-extension-probe/adapter.mjs` | `714a2cb0bf804c1dff4e352e838c36628aae8c47` | edited: one comment shortened; no behaviour change |
| `http-mcp/public/wallet-extension-probe/checks.mjs` | `cf50476169bd7a4744ecabd4e45c4e8a865b3341` | verbatim |
| `http-mcp/public/wallet-extension-probe/index.html` | `77cc4b33be152c8c513d238ee5154b55e86fc869` | verbatim |
| `http-mcp/public/wallet-extension-probe/main.mjs` | `ad1f6ac3905a9af9ab6a9f052aa690a4702845d7` | edited: public wording: internal process and layout references removed or reworded |
| `http-mcp/public/wallet-extension-probe/vectors.mjs` | `e9a607c506282c00f875145a9c82ef2484df4dd6` | edited: public wording: internal process and layout references removed or reworded |
| `http-mcp/scripts/buyer-chain-readback-identity.mjs` | `331c62500f0b72cf7a1e62e66f7f60b190b0eef0` | verbatim |
| `http-mcp/scripts/check-embedded-wallet-container.mjs` | `bb0098784d3560e8d757af654310640649dfab8f` | verbatim |
| `http-mcp/scripts/check-embedded-wallet-package.mjs` | `203061ec96ab5eecc629de08f20cfd4202722cf3` | edited: three names removed from the package-exclusion pattern; no other behaviour change; one exclusion label renamed |
| `http-mcp/scripts/check-off-unchanged.mjs` | `7d6e9538a8d279bb89540012dca559c8b95e5cef` | verbatim |
| `http-mcp/scripts/check-offline-tester-package.mjs` | `3286bb7527a78bc1e0396a40fd4b1b253d446ca6` | verbatim |
| `http-mcp/scripts/check-package.mjs` | `3855423aeada873c836d59928cbfe409a608240f` | verbatim |
| `http-mcp/scripts/check-tester-dashboard-package.mjs` | `2a64982fdbcbabd7eaa9d393978b465c34ec2797` | verbatim |
| `http-mcp/scripts/config-equivalence-migration.mjs` | `5886e736b864ef09d692c71497fe9789a751b5f1` | edited: comments and test names: internal review and process references removed; no behaviour change; the default baseline is the ref name `v1-baseline` instead of a commit id; fixture path renamed |
| `http-mcp/scripts/devnet-demo-compose.mjs` | `1de7461cf7578ee046ca225df1db7b4b05915baa` | verbatim |
| `http-mcp/scripts/devnet-demo-operator-bootstrap.mjs` | `1605193c9d38c9da37f603cd747cca68d08d892d` | verbatim |
| `http-mcp/scripts/devnet-demo-purchase.mjs` | `1de7461cf7578ee046ca225df1db7b4b05915baa` | verbatim |
| `http-mcp/scripts/devnet-demo-recipient-balance.mjs` | `cc1e1a084825d58445a75dcd9f0091498e93c191` | verbatim |
| `http-mcp/scripts/embedded-wallet-runtime.mjs` | `25e637588a070dc1e9caf7e804411117d6417f73` | verbatim |
| `http-mcp/scripts/off-surface.mjs` | `88dccbcffd650274de5a7bd6f5fb0f3074d4bd85` | verbatim |
| `http-mcp/scripts/ops-health.mjs` | `8bd774ce4e82f81d37de878841bbd7bec1b9ffe9` | verbatim |
| `http-mcp/scripts/package-paths.mjs` | `758c6de54d32252c191be075de823f671c212ce6` | edited: three names removed from the package-exclusion pattern; no other behaviour change |
| `http-mcp/scripts/purchase-timeline.mjs` | `dd333af21595f789b53b3b846424e3189be3d3b3` | verbatim |
| `http-mcp/scripts/run-test-files.mjs` | `77ead1c19658db2b71b6569a8c658a2739fc195f` | verbatim |
| `http-mcp/scripts/showcase-safety.mjs` | `d7fcfc5419bba3965ee7eb06239f4c44b34f569b` | verbatim |
| `http-mcp/scripts/test-file-reporter.mjs` | `0313484a880f85d0f8372b1483046a4107663c44` | verbatim |
| `http-mcp/skills/dacs-testnet-commerce/SKILL.md` | `01ac69fbfe8ef78933d6bc4c9e2a5de25380bd34` | verbatim |
| `http-mcp/src/accounts.mjs` | `1fe364f862d20cbccc734ef00a870a27a3d315e3` | verbatim |
| `http-mcp/src/app.mjs` | `8c76d8b38765c781f6d4c8cbb0afe7bc3157e5d5` | verbatim |
| `http-mcp/src/auth/authorization-server.mjs` | `d523bd85cbbc5d53551fa2f74b44c44a5289448a` | verbatim |
| `http-mcp/src/auth/oidc-adapter.mjs` | `2e4baffaebf016fecca53daef03d2bd80786d5a0` | verbatim |
| `http-mcp/src/auth/scopes.mjs` | `8bf5d84ec5ad6dfb614459c2f32bfd811925c832` | verbatim |
| `http-mcp/src/auth/token-verifier.mjs` | `33b4d6cccb687406164e93cef293b29568c82722` | verbatim |
| `http-mcp/src/config.mjs` | `db28a547e04082b630901958d65d43c857b3f0f1` | verbatim |
| `http-mcp/src/identities.mjs` | `85e56d4d3d254e6e31914e1816bbdeee2c792c71` | verbatim |
| `http-mcp/src/identity-signals/github-http.mjs` | `97584ef0bd8f167eb0de7a21370062f4c06d4eaa` | verbatim |
| `http-mcp/src/identity-signals/github.mjs` | `76f72bc59f19dfc17f5f293154484ff23d006ce7` | changed here after a verbatim import: the gist binding check uses the shared signature helper, so small-order and non-canonical public keys are refused |
| `http-mcp/src/legacy-publications.mjs` | `0b51b6dc3c695abb05b84053db9356a3f0657ed8` | verbatim |
| `http-mcp/src/mcp/purchase-model-view.mjs` | `cb159b23adbdd5431df529419f9dcdc5eb6b4324` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/src/mcp/seller-content.mjs` | `8ca040a8aed392502ea4d4fa57bcc74bdb11f1a7` | edited: comments and test names: internal review and process references removed; then changed here: the four seller fields that reached the model raw (`protocol.commitment.note`, `protocol.claim.message`, the keys and note of `protocol.paymentEvidence`) are put inside the seller-data envelope; behaviour change |
| `http-mcp/src/mcp/server.mjs` | `27905e5d195380e9a78508a3efb446759ee20e40` | edited: public wording: internal process and layout references reworded
| `http-mcp/src/mcp/showcase-model.mjs` | `b83fba85bff48699e7535f552d7553f5662dbce6` | verbatim |
| `http-mcp/src/mcp/showcase-progress.mjs` | `bd3afa827dc0b3d6cde40d910d54d37d9a26011a` | verbatim |
| `http-mcp/src/mcp/showcase-start.mjs` | `5f9f4f6f12f500f31d3e83626cd22aed7f344992` | verbatim |
| `http-mcp/src/mcp/ui.mjs` | `09bb1873381c742b3a0d5bbec9e7ea17288807bf` | verbatim |
| `http-mcp/src/operations.mjs` | `04016e7459b47fa4e3070d823c908d51ab17f8ec` | verbatim |
| `http-mcp/src/ops/health.mjs` | `f74ef672b71f0036dc9242fe322edff788026429` | verbatim |
| `http-mcp/src/ops/purchase-timeline.mjs` | `0762ca4d2bf7892f1e63a6725cdb695a9cb5e11c` | verbatim |
| `http-mcp/src/portal/auto-advance-assets.mjs` | `c3865316bb72ef15b5144add5cc1639ee7db269e` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/src/portal/intent-hooks.mjs` | `32ff5094e0fefc710c722169cb5230141e3b6acf` | verbatim |
| `http-mcp/src/portal/purchase-auto-advance.mjs` | `30549b5bef0d6092fd7276abfd653b999c8b9c3f` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/src/portal/purchase-poll.mjs` | `b7802bdd40bd1b23b6f66ad98868fbde77fdeef8` | verbatim |
| `http-mcp/src/portal/purchase-receipt.mjs` | `578ebf3530ab83d348b81c58f3a663967cc89ea3` | verbatim |
| `http-mcp/src/portal/routes.mjs` | `491e2d5e442108413c238d0e6cb4a2153574ebd9` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/src/portal/start-intent.mjs` | `b7b64329439ae584731ddad5a3467d10972819b5` | verbatim |
| `http-mcp/src/portal/wallet-extension-probe.mjs` | `1bcf76033d28699fa3e205a0452c7b1e6fa77f71` | verbatim |
| `http-mcp/src/portal/wallet-rpc.mjs` | `4925eabfa7aaf0325548403860dd606a8f2dfee6` | edited: held-gate id renamed to external-security-review; comments: internal references removed; held-write message states only that the external security review is on hold |
| `http-mcp/src/seller-identities.mjs` | `35040dac138ad5953c1711ab8927f0a1c16bcf70` | verbatim |
| `http-mcp/src/store/database.mjs` | `3e0795a5e682b986e9a84fb003075ba09d1415b9` | verbatim |
| `http-mcp/src/switch-files.mjs` | `42eb9b315d1674da3e00da5300f637e8b15fd9c8` | verbatim |
| `http-mcp/src/switches/DACS_ALLOW_LOOPBACK_REDIRECTS.switch` | `a58d7fcbac098f2375e5f7a2eee30e78acfa9339` | verbatim |
| `http-mcp/src/switches/DACS_BUYER_CHAIN_READBACK.switch` | `1aa8f6dff1549cbd8853fdab49c91619603b080a` | verbatim |
| `http-mcp/src/switches/DACS_DELIVERY_DEADLINE_WATCH.switch` | `2668e2c4a7bfb3197d9fe9e7f3075f3993f32204` | verbatim |
| `http-mcp/src/switches/DACS_PORTAL_AUTO_ADVANCE.switch` | `bdecb4a4f4ff69e6c4e4974a8678e48517971027` | verbatim |
| `http-mcp/src/switches/DACS_READBACK_CACHE.switch` | `1f23711477b8fed9a9c53dd1ebe44d652fd28788` | verbatim |
| `http-mcp/src/switches/DACS_SELLER_WRITE_BATCHES.switch` | `12961a9c4fb9817c6125e37cb9fee0e4bf64fb20` | verbatim |
| `http-mcp/src/switches/DACS_SHOWCASE_LEDGER.switch` | `996339803a20d4256efc0d4916345392598f5e17` | verbatim |
| `http-mcp/src/switches/DACS_SHOWCASE_PUBLICATION_VIEW.switch` | `7d49370f6156a7fe2e991f84bfb36428427d41a7` | verbatim |
| `http-mcp/src/switches/DACS_SHOWCASE_RECEIPT.switch` | `b7ca1c85b2739bb7dcdb849f0155b715403bf6a7` | verbatim |
| `http-mcp/src/switches/DACS_SHOWCASE_WALKTHROUGH.switch` | `713657ae2ea3812550328bdd869cd6e59e984a06` | verbatim |
| `http-mcp/src/switches/DACS_WALLET_EXTENSION_PROBE.switch` | `7939ba2f68ddd4d871c1a0285bbaf220b125f1a1` | verbatim |
| `http-mcp/src/util/http.mjs` | `f11f346a0dd56c0d1d8094340375ee80124fab0b` | verbatim |
| `http-mcp/src/util/ids.mjs` | `6cb275e260df92ea17a4dd7c2417206a7ed7cc2a` | verbatim |
| `http-mcp/src/util/immutable-readbacks.mjs` | `8497f6a237a1c72ad3330cdebf529275700be15b` | verbatim |
| `http-mcp/src/util/log.mjs` | `ce83fab194f07d185fcd93f30b05af59c357636d` | verbatim |
| `http-mcp/src/util/purchase-step-log.mjs` | `014e098bb1ecbc46afb18666de5cc3ab521db7c2` | verbatim |
| `http-mcp/src/util/rate-limit.mjs` | `d113add7109a56e78bc191994649826ab5820b5f` | verbatim |
| `http-mcp/src/util/text.mjs` | `1d922fed1da018ce9a4296d97bb50323e5eb67f6` | verbatim |
| `http-mcp/src/wallet/challenges.mjs` | `f13872ca91c08dc5cc75023dfa720b84ad21ac75` | verbatim |
| `http-mcp/src/wallet/demos-signature.mjs` | `d0e7be2dfe0aa845e1086ba1ee1f03e4d94c3fd6` | changed here after a verbatim import: refuses small-order and non-canonical public keys before verifying; a missing or null argument returns false |
| `http-mcp/src/wallet/write-batch.mjs` | `e810076db644040fda924b3e140506891b5e5bd6` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/test/README.md` | `1c563f44954939b8052877aad255ebfcbd9e00f9` | verbatim |
| `http-mcp/test/agreement-context-durable-vet.test.mjs` | `41b048e43808782c712a751f02e5fc664bf209f2` | edited: comments and test names: internal review and process references removed; no behaviour change; a commit id in a comment replaced by neutral wording |
| `http-mcp/test/agreement-context-integration.browser.test.mjs` | `b755f2ded2b0a851575686eeb15f5cc53568f6a2` | verbatim |
| `http-mcp/test/agreement-context-integration.test.mjs` | `be14cacf3f77d24f755197b936c407653444b1d4` | verbatim |
| `http-mcp/test/agreement-context-interactions.browser.test.mjs` | `be0482dd6eaf69531158e3fab7971f291a083bc6` | verbatim |
| `http-mcp/test/agreement-context-interactions.test.mjs` | `a30ace73a6994fce0955d88be332429becff2cc8` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/test/agreement-context-legacy-ops-health.test.mjs` | `c09c074f5935cf30036ba0280cdd0bb3930c04b2` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/test/agreement-context-replay-resend.test.mjs` | `f5aa856ae7a56f46b411e5d22affe87dbfd842ac` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/test/agreement-context-signature-race.test.mjs` | `5bcb3c987390f0eea52acce0868e5e6df6672006` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/test/agreement-context-single-vet.test.mjs` | `6c4d938a7d053e77232fdda3f89423c996118bb7` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/test/agreement-context-write-effect.test.mjs` | `992c39d39d7cc016d005014fe2d7674e4b5bd713` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/test/agreement-context-writeahead-cancellation.test.mjs` | `9d83eff1d4507f9ef77e9bb2d9c4343597b3c951` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/test/agreement-plan-route-single-vet.test.mjs` | `d4bcbcf23691dda70ea1fa68ac4b3fce9f536ff7` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/test/agreement-plan-single-flight.test.mjs` | `c50c9f25d5244f0491021ac7185ab18a4f3446c8` | verbatim |
| `http-mcp/test/agreement-plan-speed-composition.test.mjs` | `06c9173712fe71394ae4c9827389d1e785c4387c` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/test/browser/closure-acceptance-identity-recovery.browser.test.mjs` | `d7c0bb5ddf8d3fbdc866bc22ca6eb7079a20b41d` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/test/browser/closure-dashboard-recovery.browser.test.mjs` | `dc2eb9d969a75c32fb04a1204de49efd4cd0766c` | verbatim |
| `http-mcp/test/browser/closure-identity-recovery.browser.test.mjs` | `af58197791cb1bfa3b5af8f6afaab428e42171b3` | verbatim |
| `http-mcp/test/browser/dacs-offline-browser-broker.browser.test.mjs` | `a8119846f294e54f3ae376f3c7c67834d3b39c4c` | verbatim |
| `http-mcp/test/browser/dacs-storage-anchor-wallet.browser.test.mjs` | `fce110d3f6e66d93d2e95f51e93d1224727dabd9` | verbatim |
| `http-mcp/test/browser/embedded-wallet-flow.browser.test.mjs` | `52b88116147fdfceabb0b08fa48f0c726adf67ad` | edited: public wording: internal process and layout references reworded
| `http-mcp/test/browser/embedded-wallet-portal.browser.test.mjs` | `8047088e45b23024cae58ec335aa84040587bd5a` | verbatim |
| `http-mcp/test/browser/embedded-wallet.browser.test.mjs` | `3287c3d6c72c30fb9cad812916f7ae4bc75a3133` | verbatim |
| `http-mcp/test/browser/offline-tester.browser.test.mjs` | `2308f8015d40dcb5f046cb16751fe3116b6c88b6` | verbatim |
| `http-mcp/test/browser/overnight-acceptance-widget-click.browser.test.mjs` | `c6d23a25e13331035daa3dd2ec13069a04910cc3` | verbatim |
| `http-mcp/test/browser/overnight-acceptance.browser.test.mjs` | `0b4904a1c1326327243e882c14f7e8e42c3e3556` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/test/browser/overnight-core-identity.browser.test.mjs` | `8c11273fdb88310dfdb406ad5dbe55f1fbf91580` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/test/browser/overnight-ui-recovery.browser.test.mjs` | `d8e280118d6b64cce9210a191f2ef1cd91e9143c` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/test/browser/overnight-ui-start-over.browser.test.mjs` | `1067b19210ff42d45b90181cda8c8b4794e2d9c2` | verbatim |
| `http-mcp/test/browser/overnight-ui.browser.test.mjs` | `90c29f3d746c97e2cc3893e7a2150a852bf5e3bf` | verbatim |
| `http-mcp/test/browser/portal.browser.test.mjs` | `c12664085c3f4f51c7cfe477cef2e8f65a923041` | edited: comments and test names: internal review and process references removed; no behaviour change; further public wording; public wording: internal process and layout references reworded |
| `http-mcp/test/browser/tester-dashboard.browser.test.mjs` | `96a257ac62a6de302d1a5357f5f28873870f766e` | verbatim |
| `http-mcp/test/buyer-chain-readback-commit-on-signature.test.mjs` | `43e02d6dfbc485effd7039dac21aaf99b13e7818` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/test/buyer-chain-readback-final-hold.test.mjs` | `8d22ce863ae8dec8a191335180b13d7dffd0b937` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/test/buyer-chain-readback-in-flight.test.mjs` | `6e0a3dc336002d136c6c88819d9ce27e29db67c3` | verbatim |
| `http-mcp/test/buyer-chain-readback-off-identity.test.mjs` | `69890caef64fa90e5c4edee69d617247f4363fe3` | verbatim |
| `http-mcp/test/buyer-chain-readback-proof.test.mjs` | `32cf677d0226729edbf7ffc2612d950e163c3f0c` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/test/buyer-chain-readback-source-native.test.mjs` | `4d690c0a6fe187d669f393bb29f1cdb6a676a8d6` | verbatim |
| `http-mcp/test/buyer-chain-readback-unit.test.mjs` | `0c4ddc268b5c6039de83eb23889a1f009dcc63da` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/test/buyer-chain-readback.test.mjs` | `0677222a5a49106ddee164a1e17f88a5fb9a9672` | verbatim |
| `http-mcp/test/check-off-unchanged.test.mjs` | `a6a49d092cc50502ac507e4858485d9fffbfbf3d` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/test/ci-environment.test.mjs` | `348bbadf35efbf70c085c4cfa7737fafdf8cb831` | verbatim |
| `http-mcp/test/claude-cli-recovery-coverage-operator-buyer.test.mjs` | `18d20e504062acdbe48f93d926f952bc140a5706` | verbatim |
| `http-mcp/test/claude-delivery-recovery-coverage.test.mjs` | `109b56e382f4c266bf0c4515c040f76cba6a3d6e` | edited: comments: references to internal records not carried removed |
| `http-mcp/test/claude-native-delivery-closure.test.mjs` | `bb2e9e2249c6cddac993868294e149939811afa4` | edited: comments: references to internal records not carried removed |
| `http-mcp/test/claude-native-delivery-coverage.test.mjs` | `663ae47336b218cbce1a19bfa2fe6186bba11a4e` | edited: comments: references to internal records not carried removed |
| `http-mcp/test/claude-native-payment-coverage.test.mjs` | `5e16292b07c1b577336460c984395fd1dc5d8351` | verbatim |
| `http-mcp/test/closed-access-bootstrap-lane-proofs.test.mjs` | `e7dc778630e7a24369c2eac77aab32b20dd8b0cb` | verbatim |
| `http-mcp/test/closed-access-boundaries.test.mjs` | `6b195a0b96924aba3c8990b955b0eb758dceb5f0` | verbatim |
| `http-mcp/test/closed-access-driver-resend.test.mjs` | `d8166e315897d9b09b813432e81b45ae4be1ce4e` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/test/closed-access-guard-unit.test.mjs` | `529d33024d5204e4a54eb580167041d46ebf627f` | verbatim |
| `http-mcp/test/closed-access-paid-recovery.test.mjs` | `cb2272f32d6850564b40a5320d6da9ce2ff4e3bc` | verbatim |
| `http-mcp/test/closed-access-readback.test.mjs` | `e381b9323a0f5c1be848ed866a915cbc5a5998fa` | verbatim |
| `http-mcp/test/closed-access-receipt-verify.test.mjs` | `0daa9821c03691fcb69f1757b02ddb7600e17088` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/test/closed-access-relay-unit.test.mjs` | `71693385ceafb393d3c073aa0a36eebce94edfb5` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/test/closed-access-retained-resend.test.mjs` | `174df8110c6cfefc77c29ddfe786a3ee5b440c9c` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/test/closed-access-rpc-auth.test.mjs` | `515e118d16bef9d4396c400035ec9641d1e98b48` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/test/closed-access-seller-relay.test.mjs` | `0f51ce28cbf2d66c8f045e66142a46d6a953be72` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/test/closure-acceptance-dashboard-purchases.test.mjs` | `231e48edd0f806dd8e00c8f0a151a8f16e10953e` | verbatim |
| `http-mcp/test/closure-acceptance-identity.test.mjs` | `98d1199e16d082231375385ba111ade5ded2d22d` | edited: public wording: internal process and layout references reworded
| `http-mcp/test/closure-dashboard-recovery.test.mjs` | `30afb58c563673b9535de139cc01fca2cbbe684b` | verbatim |
| `http-mcp/test/closure-dashboard-witness.test.mjs` | `dabcaa7c5a1a47a910252bf1fad2470df5fe0f49` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/test/closure-identity-recovery.test.mjs` | `d6a63139981da26fcac23139708bac87c76f8f29` | verbatim |
| `http-mcp/test/closure-identity-sdk.test.mjs` | `f2eef79f40df45d9d7397ffb247dbd4ea0278658` | verbatim |
| `http-mcp/test/closure-identity-witness.test.mjs` | `cda627ffbcd931b325378ae231a567c781e0edd1` | verbatim |
| `http-mcp/test/commit-on-signature-devnet.test.mjs` | `975528bf18349e5f799def0e537fc2495f89b866` | verbatim |
| `http-mcp/test/commit-on-signature-native.test.mjs` | `c4406cd01d6c92a78abde8b2cb0cdf3adfeb9e51` | verbatim |
| `http-mcp/test/commit-on-signature-operator.test.mjs` | `55e328555bae2c27ccf93c0542f144911b77f3af` | verbatim |
| `http-mcp/test/commit-on-signature-payment.test.mjs` | `7a2023a3832956987c6e278483b7df97595f80a4` | verbatim |
| `http-mcp/test/commit-on-signature-seller-drain.test.mjs` | `c95fe68a2da96fe1c03069525df1af02ab3bb45b` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/test/commit-on-signature-shutdown-doc.test.mjs` | `de0ef0c6fe954278853b28280d5f2ff51a946e4e` | edited: asserts the reworded doc sentence (issue-number reference removed) |
| `http-mcp/test/commit-on-signature.test.mjs` | `fe583adc88a4d0a262a75d13894d45a56c1cd0d0` | verbatim |
| `http-mcp/test/commitment-finality-payment.test.mjs` | `eaf5911ee2655432e30499e788542c745cb5950c` | verbatim |
| `http-mcp/test/completion-readiness.test.mjs` | `07c417f88737633e0990982c353dab574e20cdd4` | edited: comments and test names: internal review and process references removed; no behaviour change; then changed here: the 14 small-order keys are expected to be refused by the shared helper; tests added that an ordinary signature passes and a wrong message fails; each per-key evaluator test first finds a message on which a plain Ed25519 verify accepts the constant signature |
| `http-mcp/test/config-equivalence.test.mjs` | `8e073519b3958a4857c9e02fff7ce58bc8d5e02b` | edited: comments and test names: internal review and process references removed; no behaviour change; fixture path renamed; a commit id replaced by neutral wording |
| `http-mcp/test/current-delivery-readback.test.mjs` | `eddce99f0f8c73346942a6abc49549827c749e57` | verbatim |
| `http-mcp/test/current-package-smoke.test.mjs` | `f06fa870f66ceb7a2063fda59fe5fd74b510a378` | edited: a default path to an unpublished file removed (an environment variable or a skip instead); comments reworded
| `http-mcp/test/dacs-current-broker-interactions.test.mjs` | `f175af958e919e9967d74244ede7c00631e678b7` | edited: comments: references to internal records not carried removed |
| `http-mcp/test/dacs-demos-sr2-wallet.test.mjs` | `8f890c81674a954ed191c04b0f2acb671aaf6534` | verbatim |
| `http-mcp/test/dacs-demos-sr2.test.mjs` | `6632ce0f4641d66840b112d169317846aed66e2e` | edited: testnet RPC example replaced by a reserved .invalid host |
| `http-mcp/test/dacs-loopback-fixture.test.mjs` | `d47c5a17f6967ad61f38198ca5a0adfc93b2c7fe` | verbatim |
| `http-mcp/test/dacs-offline-agreement-runtime.test.mjs` | `0a305eec72b615209d0d57ae0fda7b1b25643376` | verbatim |
| `http-mcp/test/dacs-offline-browser-broker-coverage.test.mjs` | `f5af04210c5711b44df5142b8da5dabf8a784af7` | verbatim |
| `http-mcp/test/dacs-offline-browser-broker.test.mjs` | `d155af03d8b3ccc59d4ec5597879d48ea9c62d38` | verbatim |
| `http-mcp/test/dacs-plugin-purchase.test.mjs` | `152af444bebee938ddf5cdc70113e5727e4e82a3` | edited here: the test that read `paymentEvidence` fields raw from the model copy now decodes the seller-data envelope and asserts the same values |
| `http-mcp/test/dacs-storage-anchor-wallet.test.mjs` | `e1337bbde6b2eb9113638a83aaa14e1a9f984e44` | verbatim |
| `http-mcp/test/delivery-deadline-watch.test.mjs` | `1218c3923cad3db36b2a93cc73421828d1d48caa` | verbatim |
| `http-mcp/test/demos-signature-encoding.test.mjs` | `3bc532f591f543d245c7df4def6dd0a01e584e94` | changed here after a verbatim import: a test that a missing or null argument to the signature check returns false |
| `http-mcp/test/denied-agreement-recovery.browser.test.mjs` | `4e802d0430ff0cd1ef9738c38024460537c76dcd` | verbatim |
| `http-mcp/test/denied-agreement-recovery.test.mjs` | `2af3357dc0509b9872f977385a2c754993d112a4` | edited: comments: references to internal records not carried removed |
| `http-mcp/test/devnet-agreement-transport.browser.test.mjs` | `4004fe7e0cafb02ce9fc44ba219ce67aa74417fd` | verbatim |
| `http-mcp/test/devnet-agreement-transport.test.mjs` | `d19fb5e178922c2a2ae77f3db4a34b69e7b9bd43` | verbatim |
| `http-mcp/test/devnet-buyer-access-prefixed.test.mjs` | `1579e1fbc067220cad207d57557d39d505f48105` | verbatim |
| `http-mcp/test/devnet-demo-anchor-recovery.test.mjs` | `a99e514f1d168ea1b315a9496bb1ce5f68ec918c` | verbatim |
| `http-mcp/test/devnet-live-composition-app.test.mjs` | `fa21c5fb1c20a5a4a7e5a8776f6579b5cde8c5ca` | verbatim |
| `http-mcp/test/devnet-live-composition-artifacts.test.mjs` | `ef4c78fcbf8b1de074ef6303d8c948b52b570ff9` | verbatim |
| `http-mcp/test/devnet-live-composition-builder.test.mjs` | `ebd2e70614ac7548502173b3cac7a725b8b2f7a4` | verbatim |
| `http-mcp/test/devnet-native-inclusion-wait.test.mjs` | `995330a8abcec5e760a251eb4aac5b408f3f070c` | verbatim |
| `http-mcp/test/devnet-native-sweep-regressions.test.mjs` | `84872f6f249d1e093e59d58eeb6dc861a83fbdfd` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/test/devnet-native-transport.browser.test.mjs` | `2dae8bda731c7008cb33e8a24384541baf11a8c3` | verbatim |
| `http-mcp/test/devnet-native-transport.test.mjs` | `6fbc6752ea280a561acc7243301867426227fe88` | verbatim |
| `http-mcp/test/devnet-operator-approval-deadline.test.mjs` | `633290ff57ca8c8c82a470d9440b3bf3a7435355` | verbatim |
| `http-mcp/test/devnet-operator-approval-tty-stop.test.mjs` | `34fa4bc78bbd0435307654b637d1ca8ec0197ed1` | verbatim |
| `http-mcp/test/devnet-operator-buyer-shutdown.test.mjs` | `c58de83ec7b75cd6a1713c8ab34d6d40b08ee6a5` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/test/devnet-operator-cli-seller-observer-status-prefixed.test.mjs` | `22743f48f1458d9dd01ae511db759b752b3a8f62` | verbatim |
| `http-mcp/test/devnet-operator-cli-seller-observer-unit-prefixed.test.mjs` | `8391e2c76e29135bf7d2a41cc1d4b9684b9e74aa` | verbatim |
| `http-mcp/test/devnet-operator-construction-cleanup.test.mjs` | `0fa804bd74e7c82630d236bab3e936bdaf26ebac` | verbatim |
| `http-mcp/test/devnet-operator-external-origin.test.mjs` | `4702695fc0df7960952bd44178244c42e4f077a6` | verbatim |
| `http-mcp/test/devnet-operator-payment-recovery-prefixed.test.mjs` | `52cbc1ff80b34b418df9cae335436bd130ddb2b4` | verbatim |
| `http-mcp/test/devnet-operator-plan-shutdown-owned.test.mjs` | `0701bfa1c340b965b9ff386b6df363d8b7105ac4` | verbatim |
| `http-mcp/test/devnet-operator-plan-shutdown.test.mjs` | `c6c7236f3b737b2e72b4537f2302ecf2e5e4b3b0` | verbatim |
| `http-mcp/test/devnet-operator-prefixed-startup.test.mjs` | `2e719c32422b8bafad9db62b6ec86cf88ff59f66` | verbatim |
| `http-mcp/test/devnet-operator-purchase-prefixed.test.mjs` | `9fb0a8b7811e80bb2fc95dfe03bb870d500900ac` | edited: fixture key literal passed through idem() so it is not credential-shaped |
| `http-mcp/test/devnet-operator-recovery-prefixed.test.mjs` | `75b2c5c2b6b88f1d9b2872188d0a3bd7d5e318ad` | verbatim |
| `http-mcp/test/devnet-operator-seller-disposition-prefixed.test.mjs` | `00bdc12f901bee41a51af459be1dd3ad8a60bc5f` | edited: fixture key literal passed through idem() so it is not credential-shaped |
| `http-mcp/test/devnet-operator-seller-tls.test.mjs` | `8049e08555212420812ae7862334b8356d50dfa9` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/test/devnet-operator-sequential-prefixed.test.mjs` | `4e270efcd1c119deee58172caf83ad40903b2083` | verbatim |
| `http-mcp/test/devnet-purchase.browser.test.mjs` | `db9b13b78b8933f04637d8cffcb62ab54a8460a0` | edited: expected testnet RPC replaced by a reserved .invalid host |
| `http-mcp/test/devnet-purchase.test.mjs` | `a2aa667196ad86fa1554a0396a7e9ab056050049` | edited: expected testnet RPC replaced by a reserved .invalid host; header comment: reference to an internal record not carried removed |
| `http-mcp/test/devnet-storage-write-recovery.test.mjs` | `f122a6ac3311e3b0fed22a228a932c04960abecf` | verbatim |
| `http-mcp/test/durability.test.mjs` | `ab817bf97eb80c3f87dd767309a8ce87ca96ec86` | verbatim |
| `http-mcp/test/durable-wallet-journal.test.mjs` | `8b3228f152227f6f8042c595422805c21e41282e` | verbatim |
| `http-mcp/test/embedded-wallet-bundle.test.mjs` | `ffe0327da843dd2f0e5725e7d72f0ffaaef9d437` | edited: public wording: internal process and layout references reworded
| `http-mcp/test/embedded-wallet-contract.test.mjs` | `31d105b6b8efb545f175b1f8588879a15be20e87` | verbatim |
| `http-mcp/test/embedded-wallet-flow.test.mjs` | `cdd8f085a37939b2759c6eff241c44c7290ae393` | edited: public wording: internal process and layout references reworded
| `http-mcp/test/embedded-wallet-package.test.mjs` | `9f954bc1a0047f83a897196c24efef02a5968a70` | edited: address replaced by a documentation address; one exclusion label renamed |
| `http-mcp/test/embedded-wallet-runtime.test.mjs` | `4ae38db33640d289f281bf5e7d6073f7e490e680` | verbatim |
| `http-mcp/test/embedded-wallet-sdk.test.mjs` | `5fc7e51be6d5dbdba3e13a9b0132028ed9975e93` | edited: public wording: internal process and layout references reworded
| `http-mcp/test/embedded-wallet-transaction.test.mjs` | `1ca5036d92e6e90ac207f5b9e8ae4af8537da762` | verbatim |
| `http-mcp/test/env-contract-defaults.test.mjs` | `fdfd7c4fd1c737d776ff29a0c3b8cd2ab65860a6` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/test/external-issuer.test.mjs` | `cae8d21ff3718b82dab42b8869d1a832c5b6789e` | verbatim |
| `http-mcp/test/fee-approval-recovery-offline.test.mjs` | `015f4a680b9902c5f1eaccc00285a7f4802af1fe` | verbatim |
| `http-mcp/test/fixtures/authorization-server.pre-dcr-logout.mjs` | `2821bf43b14367810b3b5b651fdac6e57a0778ef` | verbatim |
| `http-mcp/test/fixtures/buyer-chain-readback-off-identity.json` | `fbc123d498fad9232f5a54d55ec212fea5578a42` | edited: the recordedFrom text no longer names a commit id |
| `http-mcp/test/fixtures/chain-server.mjs` | `f88b51cf492bbbfb10cb1ba907fe89f3ba461f58` | verbatim |
| `http-mcp/test/fixtures/ci-runner/collide.mjs` | `05362593e7ebbac91718c570a7f79a46d073ce83` | verbatim |
| `http-mcp/test/fixtures/ci-runner/crash.mjs` | `f11fc9d9f5a3d63cfb89c61e5df634d6f81536df` | verbatim |
| `http-mcp/test/fixtures/ci-runner/disposition.mjs` | `51b6ee2168b70ce1c365498356b6d9a252cf08ac` | verbatim |
| `http-mcp/test/fixtures/ci-runner/empty-reason.mjs` | `43b248a07fa66e426b03af1def360ce131fb8003` | verbatim |
| `http-mcp/test/fixtures/ci-runner/exit-code.mjs` | `5462c94cec8382deb578552ffd81062fcb148837` | verbatim |
| `http-mcp/test/fixtures/ci-runner/fail.mjs` | `854dcca796c504936f4b22074bf9ffec2865519a` | verbatim |
| `http-mcp/test/fixtures/ci-runner/late.mjs` | `0f8603273fb2bfdf910558a08265b6483a819fdb` | verbatim |
| `http-mcp/test/fixtures/ci-runner/linger.mjs` | `79cf78bf94f0dc31aed12f97bb288904ab08b2c4` | verbatim |
| `http-mcp/test/fixtures/ci-runner/mixed.mjs` | `0c8220d8c749cc2a54c0b5a72cc6f04efdb48e09` | verbatim |
| `http-mcp/test/fixtures/ci-runner/nested.mjs` | `5cfffa5c249eaed22547e1f5826f885295db99cc` | verbatim |
| `http-mcp/test/fixtures/ci-runner/pass.mjs` | `a8895d927279724d690c1ebab8b7e66bc9df1331` | verbatim |
| `http-mcp/test/fixtures/ci-runner/root-hook.mjs` | `867b4a7fe66d94533fd1ff1925c71c8da6743ce8` | verbatim |
| `http-mcp/test/fixtures/ci-runner/suites.mjs` | `3fcb091784747d63fb19bfea268f12cd50d4263e` | verbatim |
| `http-mcp/test/fixtures/ci-runner/timeout.mjs` | `45f83662db1d9117c7263e87d71b4d9550c48b65` | verbatim |
| `http-mcp/test/fixtures/ci-runner/tmpdir.mjs` | `4faa420df587153dc65a3d6dee5ea1612971c4b3` | verbatim |
| `http-mcp/test/fixtures/directory-server.mjs` | `fcab6b36b2b2dc8e0b17f75638149924984bfdc0` | verbatim |
| `http-mcp/test/fixtures/listings.mjs` | `7b61fcf06227c2a81bf9ac04b9a673ba686fe63d` | verbatim |
| `http-mcp/test/fixtures/mcp-seller-content-baseline.json` | `ace21bdaa957a3576b2762f3d37d89901a6f2fca` | verbatim |
| `http-mcp/test/fixtures/mcp-seller-content.mjs` | `7b92ff4758f9779f12152f40076039d90c3f6961` | verbatim |
| `http-mcp/test/fixtures/node-test-child/big-output.mjs` | `0742fe1dcc85343ace79857b983b1d051dfc0b2a` | verbatim |
| `http-mcp/test/fixtures/node-test-child/big-stderr.mjs` | `5aa11cb55f59bbd4720c41c5b38f52af9e4ef10c` | verbatim |
| `http-mcp/test/fixtures/node-test-child/detached-holder.mjs` | `afda10c2840a148ccab62b53385161bac1813138` | verbatim |
| `http-mcp/test/fixtures/node-test-child/exit-midway.mjs` | `452e8d6a2ca750124d8cfacfcdb06083851e16bb` | verbatim |
| `http-mcp/test/fixtures/node-test-child/exitcode.mjs` | `7b14f51503942cbe1b0aee4b0c29b71d931cdac0` | verbatim |
| `http-mcp/test/fixtures/node-test-child/fail-exit-3.mjs` | `0da0cb7d67e84deac5375e0ef9bcf8f8b8cac0f4` | verbatim |
| `http-mcp/test/fixtures/node-test-child/fail.mjs` | `e46159a4392bf3302879a1ac37daf6105f4e92bc` | verbatim |
| `http-mcp/test/fixtures/node-test-child/guard-driver.mjs` | `01747aa35dd978f7c8a275f5ad1b29c0c8e21960` | verbatim |
| `http-mcp/test/fixtures/node-test-child/hang-deadline.mjs` | `c69e0eb64a5882b99eb9b8eb0a5d2997a816f255` | verbatim |
| `http-mcp/test/fixtures/node-test-child/hang.mjs` | `12e716565f977b520901a8c03b81cda596ec4a93` | verbatim |
| `http-mcp/test/fixtures/node-test-child/late-error.mjs` | `a71956083189de58a3c0c3c2cb619b45ee096ddb` | verbatim |
| `http-mcp/test/fixtures/node-test-child/load-failure.mjs` | `3ecaea5c629854a35baa64f7478ea3861bab03d6` | verbatim |
| `http-mcp/test/fixtures/node-test-child/nested.mjs` | `9c764b28a5cd9826cf327e12ed44d4b2d4b05e38` | verbatim |
| `http-mcp/test/fixtures/node-test-child/no-tests-spoof.mjs` | `444faaae9c941d9bf341cd4679f363e8a839ea74` | verbatim |
| `http-mcp/test/fixtures/node-test-child/pass.mjs` | `af24d6b44bd03eb17274d9c946197166619b3270` | verbatim |
| `http-mcp/test/fixtures/node-test-child/pending.mjs` | `8c43b46b456d0d1612961064d6c0ff073081913b` | verbatim |
| `http-mcp/test/fixtures/node-test-child/root-after-fail.mjs` | `35c3cd9af1d85b6d90ac16ab3839463e669fb082` | verbatim |
| `http-mcp/test/fixtures/node-test-child/same-group.mjs` | `2042a418ac6356fc8e8f3a2fe36d8051bcdb267f` | verbatim |
| `http-mcp/test/fixtures/node-test-child/sigkill-after.mjs` | `ed6b04f45513fc52b7ed9c07bd54968c28398cb1` | verbatim |
| `http-mcp/test/fixtures/node-test-child/skip-fail.mjs` | `239b69c405f6eafa9d90702d7d0a2db4eb0e2b8d` | verbatim |
| `http-mcp/test/fixtures/node-test-child/skip-todo.mjs` | `810d7daa1f1d6bd4989a054ae8fd3f82902e23ba` | verbatim |
| `http-mcp/test/fixtures/node-test-child/stdout-spoof.mjs` | `05798acb0849ceafc894b23b4006eb8b65a1266f` | verbatim |
| `http-mcp/test/fixtures/node-test-child/suite-hook-fail.mjs` | `41ef60820fdf62be5dd1abb9b1e51675132c928c` | verbatim |
| `http-mcp/test/fixtures/node-test-child/tla.mjs` | `0c330d8c9c40de82d9c3fd331252dca9a87642ff` | verbatim |
| `http-mcp/test/fixtures/seller-durable-state.v1-baseline.mjs` | `04be06f552a0c5dd0b970ae72dd230e125bc7cb7` | edited: renamed, content unchanged (the earlier name carried a short commit id of the earlier repository, not repeated here) |
| `http-mcp/test/fixtures/store-worker.mjs` | `e90aa666bfa665a9843201234bea11fc1b1b611e` | verbatim |
| `http-mcp/test/fixtures/switch-slice-v1-baseline.json` | `3eb868b9e977351944690c0223339a592b8c561e` | edited: renamed (the earlier name carried a short commit id of the earlier repository, not repeated here); the generatedFrom text names `v1-baseline` instead of the id |
| `http-mcp/test/fixtures/test-issuer.mjs` | `c0b9c4e7af299b1d6264d21188adc9ec8dadb82b` | verbatim |
| `http-mcp/test/fixtures/wallet.mjs` | `4ee7eacda377c731fd70105eaa3bf862421e01c3` | verbatim |
| `http-mcp/test/flow-helper-clock.test.mjs` | `1a6ddc9fd2ca89fb3ced83fe987fe2afebfca1f2` | verbatim |
| `http-mcp/test/funding-help.test.mjs` | `2374347a8f295e11bd6b7213cf7f558f70e6ff82` | edited: faucet host replaced by a reserved .invalid host; credential-shaped URL built at test time; comments: internal references removed; the docs-guard assertion made generic |
| `http-mcp/test/github-signals-deadlines.test.mjs` | `4df52814e779fc6bdde7dc9f29b11056fc2708cf` | verbatim |
| `http-mcp/test/github-signals-display-only.test.mjs` | `a4c55130d319aa5b242b26aa6b8e330110d2e895` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/test/github-signals-integration.test.mjs` | `b7933eedbbd6eae454557171ff9dcd63204bb671` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/test/github-signals-showcase-combined.test.mjs` | `26cbc7790b6d94ced421d58fce7f39914afbba14` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/test/github-signals.test.mjs` | `04e036d8de34318cbe86cbb65efe1c1362f11477` | edited: comments and test names: internal review and process references removed; no behaviour change; then changed here: a test added that a small-order seller key gets no binding |
| `http-mcp/test/harness-lifecycle.test.mjs` | `8575c2781259b0f9a677f5ea653f17a3127d4db3` | verbatim |
| `http-mcp/test/helpers/agreement-context-integration.mjs` | `7d735e1afa8412981619011f1caf9c0b5d146ef1` | edited: default seller reference path replaced by a neutral absolute path |
| `http-mcp/test/helpers/agreement-context-interactions.mjs` | `394daf0a79c06daca32a652af4518a580b3eead1` | verbatim |
| `http-mcp/test/helpers/answer-writer-worker.mjs` | `0dfaa97df64033fb3e15553fae6649b3c626a90d` | verbatim |
| `http-mcp/test/helpers/approval-tty-child.mjs` | `2767f5aa68ab0f4a5ba83f76fd26b7e533d0a455` | verbatim |
| `http-mcp/test/helpers/approval-tty-driver.py` | `037ac5d75bf042d732650c36df26e103b7ce5544` | verbatim |
| `http-mcp/test/helpers/approval-tty-hang-child.mjs` | `438ded648fd59e3e61a7061f7ee0ce7cf7eb9fa7` | verbatim |
| `http-mcp/test/helpers/buyer-chain-readback-flow.mjs` | `f2895f71dc8e79dc7359522fe48af6a59e7921d6` | verbatim |
| `http-mcp/test/helpers/buyer-chain-readback-identity.mjs` | `318991bcfc372a7dde19bd2eadd128b7352b5432` | verbatim |
| `http-mcp/test/helpers/check-public-text-report-mutants.mjs` | `7b157d8061ace378f65eed76779802befc929104` | verbatim |
| `http-mcp/test/helpers/claude-commit-retry-coverage-world.mjs` | `ce0def61b6c72ba097c9fc9b2adeaa9223fb201e` | verbatim |
| `http-mcp/test/helpers/claude-native-delivery-coverage-reader.mjs` | `1c72fcb289c3e50dc7309e449ed192c0d0032490` | verbatim |
| `http-mcp/test/helpers/claude-native-payment-coverage-flow.mjs` | `5c9ff5ad7ee45c4df33f99b7c49590381cbe169a` | verbatim |
| `http-mcp/test/helpers/claude-native-readback-current-fixture.mjs` | `b1a107cce0657e1e3b69fac8ff627f0e13568372` | verbatim |
| `http-mcp/test/helpers/claude-node2-current-coverage-fixture.mjs` | `fbc9910d7d43851f90cdebbe75287bcb38a59b9a` | verbatim |
| `http-mcp/test/helpers/closure-acceptance-identity.mjs` | `187079f45a73e2dd56cde0f5b5131ae663d168e6` | edited: public wording: internal process and layout references reworded
| `http-mcp/test/helpers/current-broker-interactions-browser.mjs` | `3a5849ab3719e6081a0d7894caa919810b3df873` | verbatim |
| `http-mcp/test/helpers/current-broker-interactions-interop.mjs` | `25701e9664131f904fea68b0ffccb1321d61241c` | edited: default seller reference path replaced by a neutral absolute path; header comment: internal reference paths and manifest name removed |
| `http-mcp/test/helpers/current-broker-interactions.mjs` | `2926448f6d3377e2de395be177a6bd71aa9ba92e` | verbatim |
| `http-mcp/test/helpers/dacs-storage-anchor-wallet-fixture.mjs` | `b8260a0db1f6976ddef25a7092116284d79757fe` | verbatim |
| `http-mcp/test/helpers/devnet-agreement-transport-flow.mjs` | `a49879d76bdd034101f29e777aa2f18859967e2e` | verbatim |
| `http-mcp/test/helpers/devnet-agreement-transport-harness.mjs` | `914e4bc7544d69a2c3db3a539a3591a6409edc8a` | verbatim |
| `http-mcp/test/helpers/devnet-agreement-transport-repeat.mjs` | `ccae92ecda1e6b7b506f5d930e4acab475cc90f7` | verbatim |
| `http-mcp/test/helpers/devnet-agreement-transport-seller.mjs` | `c024181ec4c4e94c802062e05b81cd00442f8aac` | verbatim |
| `http-mcp/test/helpers/devnet-live-composition-app.mjs` | `db32979be2e270d608c0eb679a8fa8f1d82ccd4b` | verbatim |
| `http-mcp/test/helpers/devnet-live-composition-transport.mjs` | `f87e1f99ccb920e7bdd333d014544c0761116939` | verbatim |
| `http-mcp/test/helpers/devnet-native-transport-harness.mjs` | `e04c9355a4379a28833669eb67156482a8a70688` | verbatim |
| `http-mcp/test/helpers/devnet-operator-cli-issued-crash-child.mjs` | `3f5eb4c98b5de52ec517ef999bf7d223b786fd43` | verbatim |
| `http-mcp/test/helpers/devnet-operator-cli-issued-pty.exp` | `efd02a4e7ffd088629b0a52d4e8e16ec057d5027` | verbatim |
| `http-mcp/test/helpers/devnet-operator-cli-issued-recovery-node2.mjs` | `1474471395b096d277413fc6f2126113fb6b51e7` | verbatim |
| `http-mcp/test/helpers/devnet-operator-cli-node2.mjs` | `31d135012a19496630970d6fd69dcfd55f340ca4` | verbatim |
| `http-mcp/test/helpers/devnet-operator-cli-preload.mjs` | `bc6a78bd0656861b71eeaa1b845ed25949864c3f` | verbatim |
| `http-mcp/test/helpers/devnet-operator-cli-process-marker-preload.mjs` | `ef8b634268c32cc3b26e5655a2423787758fadfe` | verbatim |
| `http-mcp/test/helpers/devnet-operator-cli-seller-observer-preload.mjs` | `ce8ecbf0e26f882243c5abb50ca6ff1f3312a44c` | verbatim |
| `http-mcp/test/helpers/devnet-operator-cli-seller-observer-unit-child.mjs` | `b750d1c8f6e2cf9bcef089b5605de4e797ed8dc5` | verbatim |
| `http-mcp/test/helpers/devnet-operator-node2.mjs` | `d5638e3a3553bb0c029c1114570704d9b52636d8` | verbatim |
| `http-mcp/test/helpers/devnet-operator-payment-recovery-node2.mjs` | `16c59dd113dda075e25e7a11f94fd75349f9cb4f` | verbatim |
| `http-mcp/test/helpers/devnet-operator-purchase-node2.mjs` | `7d429a917eaa6f89f641a8e5f9d22c09277dfa93` | verbatim |
| `http-mcp/test/helpers/devnet-operator-recovery-node2.mjs` | `b65d14c59c17c4ced4cbd0e95b12a2891a2b3359` | verbatim |
| `http-mcp/test/helpers/devnet-operator-seller-disposition-node2.mjs` | `256e232b7e85e1b2cb45eab16a849111e1ee946e` | verbatim |
| `http-mcp/test/helpers/devnet-operator-seller-disposition-resume-child.mjs` | `c0be9339cb3282341cd671b5dd107aa327f015b5` | verbatim |
| `http-mcp/test/helpers/devnet-operator-seller-precondition.mjs` | `13c141964ad0b99c2978a11f76f140da3feb37da` | verbatim |
| `http-mcp/test/helpers/devnet-operator-sequential-node2.mjs` | `3cb86961d2aeef100160bbf222175ae6c0b552b4` | verbatim |
| `http-mcp/test/helpers/devnet-purchase-harness.mjs` | `38d878b20b2292eee08c5df2bdbbbdad1aaeab68` | verbatim |
| `http-mcp/test/helpers/devnet-stop-loader.mjs` | `462b0b4ec8145fa2312de0d903aa890ce0154a35` | verbatim |
| `http-mcp/test/helpers/devnet-stop-operator.mjs` | `be74f1ce97d67d59d26113df00dab37e5a9e6447` | verbatim |
| `http-mcp/test/helpers/durable-wallet-journal-broker.mjs` | `e4c756c43fd64a7d0d654e1ad2372fd0da4ab046` | verbatim |
| `http-mcp/test/helpers/durable-wallet-journal-browser.mjs` | `6aaf563599fcc9d34f30baf9afeb0dc6caa5b813` | verbatim |
| `http-mcp/test/helpers/durable-wallet-journal-child.mjs` | `e40dec6bf6740d4b0bb55e84e38d5428b7d26937` | verbatim |
| `http-mcp/test/helpers/durable-wallet-journal-sr2-fixture.mjs` | `c35e7affc754a58a39a4dfc983733fed171cbb21` | verbatim |
| `http-mcp/test/helpers/embedded-wallet-fixtures.mjs` | `bdc32d246028de91fc58e0e7b32c5b328d62a439` | edited: comment: internal process wording removed |
| `http-mcp/test/helpers/embedded-wallet-flow-fixtures.mjs` | `98a594c503b110443599cbc6230fa36a197239e1` | edited: public wording: internal process and layout references reworded
| `http-mcp/test/helpers/embedded-wallet-transaction-chain.mjs` | `03995668969f37380fb077291d8e1db64af2a72a` | verbatim |
| `http-mcp/test/helpers/env-contract-view.mjs` | `c275aeb31278349c33e9aa4bd8c562644351dca7` | verbatim |
| `http-mcp/test/helpers/finalized-payment.mjs` | `ee482c1b5f09d69c1b63eb8257210e199916ba8d` | verbatim |
| `http-mcp/test/helpers/flows.mjs` | `2d4339090cf98d55c1231f23c22129e3a7db6e49` | verbatim |
| `http-mcp/test/helpers/harness.mjs` | `91c8b39a12d3065895533ecc1f158180ccb71ba2` | verbatim |
| `http-mcp/test/helpers/listener-guard.mjs` | `7915bac5268baf9bfafa259cbe710f1731caf917` | verbatim |
| `http-mcp/test/helpers/loopback-test-ca.mjs` | `bfe8faf4eea14100728ce274f186af84be20450d` | verbatim |
| `http-mcp/test/helpers/loopback-test-tls.mjs` | `669b8675efb0be64181ba3fa8137d3e9f0983ea9` | verbatim |
| `http-mcp/test/helpers/model-report.mjs` | `c35eaff303d99b48f9bb6b1b0d31a7f91843028b` | verbatim |
| `http-mcp/test/helpers/mutate-dcr.mjs` | `6e457d7ffdd927067fd7b02be39c22d0694a723a` | verbatim |
| `http-mcp/test/helpers/native-agreement-payment-flow.mjs` | `413b4be520cc9629ada46929c9ee019e91518cbf` | verbatim |
| `http-mcp/test/helpers/native-agreement-payment-harness.mjs` | `a2ee2468f0dbae5c68043a50a73b404691b36ba5` | verbatim |
| `http-mcp/test/helpers/native-dem-delivery-provider.mjs` | `a900bb837a031e97a9fc34f80705bba17f52f3fb` | verbatim |
| `http-mcp/test/helpers/native-payment-evidence-flow.mjs` | `130099289985e6c5183736f18c8c589906cd50e2` | verbatim |
| `http-mcp/test/helpers/native-payment-evidence-harness.mjs` | `192ed2a44f6cd37f7b5a38ddeb6eb50a835a354c` | verbatim |
| `http-mcp/test/helpers/native-seller-timeout-flow.mjs` | `f21c3866ab90ab39d6b627914b968f329b1aa03e` | verbatim |
| `http-mcp/test/helpers/native-settlement-consumer-seller.mjs` | `68ce796bf67c3e6b703086e4b7da4efce6be6159` | verbatim |
| `http-mcp/test/helpers/node-test-child.mjs` | `350b2db07a8c1b57dfb3d4fe3531e7810c5385fd` | verbatim |
| `http-mcp/test/helpers/node2-reviewed-build.mjs` | `232ef50e896907a3e7bedb440e99b56510a99856` | verbatim |
| `http-mcp/test/helpers/oauth.mjs` | `a25931a5284890254d0e84479708e1dbd1377d1c` | verbatim |
| `http-mcp/test/helpers/offline-agreement-fixture.mjs` | `e9cd3822df6511d2b077366a694ef4157de9ff29` | verbatim |
| `http-mcp/test/helpers/overnight-acceptance-browser.mjs` | `26f197459811f2e91291bc60de99335976b6e7ba` | verbatim |
| `http-mcp/test/helpers/overnight-acceptance-dashboard.mjs` | `e8dff9fe7ac714adaf882c18f249418157ddbcd6` | verbatim |
| `http-mcp/test/helpers/overnight-acceptance-flows.mjs` | `0398518f4eba9bd1fb331bf7961a59378a25cecd` | verbatim |
| `http-mcp/test/helpers/overnight-core-fixtures.mjs` | `e3b8c9269b466b7854f17875beb5afbfd6f0403e` | verbatim |
| `http-mcp/test/helpers/overnight-ui-actors.mjs` | `fb490a14851bc378fa11ba2548e36d94480a9217` | verbatim |
| `http-mcp/test/helpers/overnight-ui-browser.mjs` | `ea22e972f014b51adac4b358692952e397ca4a73` | verbatim |
| `http-mcp/test/helpers/party-vet-fixture.mjs` | `7734d2e4d975a99a9bd05b9d5c9cb1202e060409` | verbatim |
| `http-mcp/test/helpers/portal-auto-dom.mjs` | `f7711a43162e316b145aa9de78850fab53462484` | verbatim |
| `http-mcp/test/helpers/portal-auto-harness.mjs` | `75301fa5bacb1b288b1772e61d7e4bc132604e1e` | verbatim |
| `http-mcp/test/helpers/public-sr2-projection-flow.mjs` | `808721834f1b1bc10178322f7f9c1ec2ef51cba8` | verbatim |
| `http-mcp/test/helpers/publication-base-surface.mjs` | `b6e9d85e3cc610fb14eaadeadc2152dfc9afb00f` | verbatim |
| `http-mcp/test/helpers/purchased-report-dom.mjs` | `4d3ed905bcb93e2c82e33a669c1008de7aa99c73` | verbatim |
| `http-mcp/test/helpers/retained-answer-fixture.mjs` | `ac95f05b892947a1e4f7f514eefdc800f9a70d3f` | verbatim |
| `http-mcp/test/helpers/seller-durable-state-lock-holder.mjs` | `f1343e1d62330b0b1647859b5648e71d2ab46756` | verbatim |
| `http-mcp/test/helpers/seller-sr2-agreement-harness.mjs` | `7beb23f213ee9f7d7386cba44c8911f91770d63d` | verbatim |
| `http-mcp/test/helpers/seller-state-lease-race.mjs` | `c194125b670458faed9375d2da7d197dce9b57d1` | verbatim |
| `http-mcp/test/helpers/seller-state-no-procfs.mjs` | `f1fcb6b70c6b28fdce13d2b89b1a58b785e17570` | verbatim |
| `http-mcp/test/helpers/seller-write-batch-mutants.mjs` | `54b6f281f1f55ec6a5c8c224868ba53bcdbcc66a` | verbatim |
| `http-mcp/test/helpers/settlement-crash-child.mjs` | `3bbbd00e046c2010c87202ac425075136b140c26` | verbatim |
| `http-mcp/test/helpers/settlement-crash-world.mjs` | `e5600f8cab64c2a2ac3369029a880817fba0076d` | verbatim |
| `http-mcp/test/helpers/showcase-ledger-mutants.mjs` | `bc2a01ba643ff537b13adba50bae9ba0cad55a0c` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/test/helpers/showcase-safety-child.mjs` | `46fe2703f179af3a3c5120b545f4980cb5cde88c` | verbatim |
| `http-mcp/test/helpers/showcase-safety-fixture.mjs` | `48f356b2bd9b5c95474c400717cebd86344d1203` | verbatim |
| `http-mcp/test/helpers/showcase-safety-mutants.mjs` | `8062a315dfe8b84cbd1fa2b0bf66c4c387f610c9` | verbatim |
| `http-mcp/test/helpers/showcase-safety-restart.mjs` | `003e00faeb3af4ccaabd9d277c20d547401b812d` | verbatim |
| `http-mcp/test/helpers/showcase-safety-status.mjs` | `4360c3b81a9e5ab355af952ce2e8d7641f564a74` | verbatim |
| `http-mcp/test/helpers/shutdown-clock.mjs` | `89ba803c1185baf801572b7bc86efbb0d3cb439f` | verbatim |
| `http-mcp/test/helpers/source-demo-delivery-context.mjs` | `af55ec94a37734d03db8c1d6d9c1330dc49d3065` | verbatim |
| `http-mcp/test/helpers/source-demo-flow.mjs` | `407e9d3ccb1db981727e9c22a2c0b9ca96443421` | verbatim |
| `http-mcp/test/helpers/source-demo-seller.mjs` | `fe1c4055b77e3a13b3cf24492a645f08fb2b190b` | verbatim |
| `http-mcp/test/helpers/start-intent.mjs` | `f0228e036f7f82a8087caf1c5883419ee18c8491` | verbatim |
| `http-mcp/test/helpers/switch-registry-mutants.mjs` | `6a812a8326b6542d4a6d19ed1032d26cc14f00a8` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/test/helpers/synthetic-finality-app.mjs` | `0dd73119b63792e797f8f4eab9641f9e54fdc382` | verbatim |
| `http-mcp/test/helpers/synthetic-finality-policy.mjs` | `e475cf904ae2c8a5e8048c697d5517bd6d0ff84a` | verbatim |
| `http-mcp/test/helpers/tester-dashboard-driver.mjs` | `1432f450f36df8ac65a8c76e859d8e45a02a034d` | verbatim |
| `http-mcp/test/helpers/wallet-extension-probe-dom.mjs` | `82ed93b9e4d001302b7fc8ea6e57b5ee5c04467c` | verbatim |
| `http-mcp/test/helpers/wallet-extension-probe-mutants.mjs` | `ffcee7725c69f2d43702ef690bb8e73a6aa2b171` | edited: comments and test names: internal review and process references removed; no behaviour change; further public wording; test-name filters of two mutants updated |
| `http-mcp/test/helpers/wallet-extension-probe-sdk.mjs` | `7845ed9e5ec7ef0d68886924899f8e7780055c4d` | verbatim |
| `http-mcp/test/helpers/wallet-write-batch-child.mjs` | `764309a83279905a9684713aab2102e70c992c1c` | verbatim |
| `http-mcp/test/helpers/wallet-write-batch-mutants.mjs` | `3dd271d9ef51d69c02c0d14cae1a250459eff6df` | verbatim |
| `http-mcp/test/identities.test.mjs` | `142ef667e3faa7824ef4dba93d0523d0a881ce7a` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/test/identity-actions.test.mjs` | `0b1edc65471375ca30eaf6dd2b47add79a42e743` | verbatim |
| `http-mcp/test/immutable-readbacks.test.mjs` | `f8dd18c87541eacb81c19031caa1e43d19c14723` | verbatim |
| `http-mcp/test/known-failures.json` | `ec52d3c76c62b519aaa01b1a9c22b8cbfaeb5602` | edited: the reason text says the entry does not apply in this repository |
| `http-mcp/test/legacy-publication-cancel.test.mjs` | `3e10c754c17c7a9178e49c4bdb65f3bfc5c07778` | verbatim |
| `http-mcp/test/listing-http-unavailable.test.mjs` | `f43c769cf92b4767fbeaa5b312a4fb48ad3ca739` | verbatim |
| `http-mcp/test/loopback-test-tls.test.mjs` | `aa3c5624eb24b6db6232aaf669c371ce0463629b` | verbatim |
| `http-mcp/test/mcp-error-envelope.test.mjs` | `5c05dc39d3a52cfeb3721ea9d923edbe1e3700a9` | verbatim |
| `http-mcp/test/mcp-listing-envelope.test.mjs` | `dfb869b039f8f38cc19878961d4d7bf7a3c50b90` | verbatim |
| `http-mcp/test/mcp-repository-envelope.test.mjs` | `827ddc965c7d9fcf38c6e9f633acdd1fba415890` | verbatim |
| `http-mcp/test/mcp-resource-contract.test.mjs` | `6e158defa7603712be2179420f33cf4187e74d28` | verbatim |
| `http-mcp/test/mcp-seller-content-integration.test.mjs` | `a7ba94dd88479dd3faaed0b65f930e71c3bab17b` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/test/mcp-seller-content.test.mjs` | `326dcc0e7defbe3bd2374b22f8a45a296386453c` | edited: comments and test names: internal review and process references removed; no behaviour change; a commit id in a comment replaced by neutral wording; then changed here: a comment about how the baseline was recorded reworded; then changed again: a test covering each of the four seller-text fields through the three purchase tools |
| `http-mcp/test/mcp-seller-data-decoder.test.mjs` | `ad7b00d033a4db455b329a4efe947338d7184d22` | verbatim |
| `http-mcp/test/mcp-seller-diagnostics-errors.test.mjs` | `aea3f247abfaa56f8c80ca53ae78efb097d5e22d` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/test/mcp-seller-diagnostics-settlement.test.mjs` | `c392cf635a6c0f41698e0b5b3d6293e8ea66045c` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/test/mcp-seller-diagnostics.test.mjs` | `2a019bf5a8a74364965ee6f96982f3baffc463d2` | edited: fixture key literals passed through idem() so they are not credential-shaped; comments: internal references removed; test name: PR reference removed |
| `http-mcp/test/mcp-transport.test.mjs` | `427a7f0d4f6a2d8df9505ed9c06e369cb8025c51` | verbatim |
| `http-mcp/test/mutant-helper-verdicts.test.mjs` | `9fbe80cfb4d43ab26baeb31f066f4b561b67fadb` | verbatim |
| `http-mcp/test/mutate-dcr.test.mjs` | `2eab79588fb09ec2f73afbac582299abbb9fb610` | verbatim |
| `http-mcp/test/native-agreement-payment.browser.test.mjs` | `ebd6348c283d2a2adce343034bcbf84be077cf10` | verbatim |
| `http-mcp/test/native-agreement-payment.test.mjs` | `6ca9fda96702a116649d2772b8e3e4c227de4fdd` | verbatim |
| `http-mcp/test/native-agreement-readback-cache.test.mjs` | `9f91e05d2616a00806b409d0e5d45bf51d428417` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/test/native-payment-cancel-equivalent.test.mjs` | `7af83976c35f827c137a9e80c1cbb722adda6e05` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/test/native-payment-cancel-failed-lane.test.mjs` | `8873705a1cc4c121a961131e4fe3e560ad40a277` | verbatim |
| `http-mcp/test/native-payment-cancel-out-of-order.test.mjs` | `3c13d5f7ed51f4ba2bf1ec94bb624c9330dc70dd` | verbatim |
| `http-mcp/test/native-payment-cancel-refused.test.mjs` | `8db37e978f0810751910e61bc41f21dedbaee736` | verbatim |
| `http-mcp/test/native-payment-cancel-send.test.mjs` | `c6fcbf02f0cfcb79a6e1622f37498e6b839e4064` | verbatim |
| `http-mcp/test/native-payment-evidence.test.mjs` | `8b621484673ce423199ee32ae9810dc030e6912f` | verbatim |
| `http-mcp/test/native-seller-timeout-reproduction.test.mjs` | `ddd996882c71e7f7a1ca57de178eec4f2bd00ef8` | verbatim |
| `http-mcp/test/native-settlement-consumer.test.mjs` | `7dc4758f418dadf71d5ec87eb32485d71c78b8a8` | verbatim |
| `http-mcp/test/node-test-child.test.mjs` | `056e6d958dc6c6896cf37cd60cd793cfa363830e` | verbatim |
| `http-mcp/test/node2-native-transfer-readback-prefixed.test.mjs` | `5d930f8db254f4173fa92ee8fd6e4149e1bfdc94` | verbatim |
| `http-mcp/test/oauth-auth-diagnostic.test.mjs` | `7b431bb8e8fea8253974cac9391a7ea3acbf1bc0` | verbatim |
| `http-mcp/test/oauth-cimd-timeout.test.mjs` | `10e2385ed4d6b1402c71c42c3cbd67ebeb82d0ae` | verbatim |
| `http-mcp/test/oauth-logout.test.mjs` | `622bb4b816d1fdbf16a0c13967f377548dd19718` | verbatim |
| `http-mcp/test/oauth-loopback.test.mjs` | `db62907d2903efca139fa213f42f0d75cbe0505c` | edited: address replaced by a documentation address; credential-shaped URL built at test time |
| `http-mcp/test/oauth-refresh.test.mjs` | `a815b40e5b0f6fe546fa5fd2b283888955f8da45` | verbatim |
| `http-mcp/test/oauth.test.mjs` | `315bc3cc1cfa9cad0bcdcf2d97280dae2e9e7b8e` | edited: public wording: internal process and layout references reworded
| `http-mcp/test/offline-tester-package.test.mjs` | `072f82eac4b92739fd7a9cf513f36c9e27ee97d6` | edited: comment: internal log references removed; example checkout path made neutral |
| `http-mcp/test/offline-tester.test.mjs` | `4a6b2a9db2fba243f8bcd135d47b8574163fd051` | edited: public wording: internal process and layout references reworded
| `http-mcp/test/operator-session-lifecycle.test.mjs` | `5127a0005d6bdd79cd664f62a66b95123e8a0c68` | verbatim |
| `http-mcp/test/ops-health-lost-attempt.test.mjs` | `095bdd17b880f52f7ed9bf5d8511a164ac97d964` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/test/ops-health-native-evidence-race.test.mjs` | `c0e70e28b6de051c31d9d069f39c8944057b26c1` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/test/ops-health-native-transfer-records.test.mjs` | `f80f4f91a57948813add06c6379af4142f2bd7ed` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/test/ops-health.test.mjs` | `8f328ef1b79ebca4eb6913454d015ec14107488e` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/test/overnight-acceptance-core.test.mjs` | `be9fab0bf534bdffb8f7cf8125e4ae971e7e5b43` | edited: public wording: internal process and layout references reworded
| `http-mcp/test/overnight-acceptance-ui.test.mjs` | `2099f64506281dbf705a3c8c0519c57f5fa719ae` | verbatim |
| `http-mcp/test/overnight-acceptance.test.mjs` | `8dcbd9c2235ba91efe49e0097fa411edaac6acbc` | verbatim |
| `http-mcp/test/overnight-core-seller.test.mjs` | `e761db72a2b790235351c3d4986a5ca1db3c3167` | edited: held-gate id renamed to external-security-review; comments: internal references removed; expects the reworded held-write reason |
| `http-mcp/test/overnight-package.test.mjs` | `1afdaf8310a61acbbf27575a7ce2a5610eba3aaa` | verbatim |
| `http-mcp/test/overnight-ui.test.mjs` | `ee29f12c9ed915c4a6822ce67af93a507cbe9660` | edited: public wording: internal process and layout references reworded
| `http-mcp/test/package-paths.test.mjs` | `7072517013e0e5643653f37c49625551f018fa9a` | edited: sample list shortened with the exclusion pattern |
| `http-mcp/test/package-version-contract.test.mjs` | `16968b8067bb637dede7158e9bb6781914d28dc3` | verbatim |
| `http-mcp/test/portal-auto-advance-hooks.test.mjs` | `eb12d446006f356849bbc27cc77e82a69cd25635` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/test/portal-auto-advance.test.mjs` | `520379f68034599fc0278d2f5314d4211c106d05` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/test/portal-auto-assets.test.mjs` | `be7b12ce7f3d76c44e5bf6bf5481c71963c8db95` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/test/portal-auto-create-reload.test.mjs` | `717d660fa15e289ac7344463557b3a3d6f9db867` | verbatim |
| `http-mcp/test/portal-delivery-evidence-label.test.mjs` | `03d5e968aeded0dd3727fc7a4f636218c6fd5e99` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/test/portal-seller-session-delegation.test.mjs` | `c6fac8465fa420880661236808c00e7b8239fd4d` | verbatim |
| `http-mcp/test/portal-source-binding.test.mjs` | `2f4c26c02659182573d30fe6b0b494b55a8052c7` | verbatim |
| `http-mcp/test/portal-states.test.mjs` | `5adf022620bac8cb22b0051269045feffaa36116` | verbatim |
| `http-mcp/test/protocol-revision-races.test.mjs` | `12f7071276863c0e962f6da65e9b070cce776bfb` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/test/public-sr2-projection.browser.test.mjs` | `35d69e1df452cb36e9c2594cc8a867dc8c229fd2` | verbatim |
| `http-mcp/test/public-sr2-projection.test.mjs` | `7a9d2bc74e19595d45f5ec8a9f108a8fdb7fbe8a` | verbatim |
| `http-mcp/test/public-text-report.test.mjs` | `a03f02046f9b41a10e535be53cdce2ab637c0b70` | verbatim |
| `http-mcp/test/purchase-abuse-limits.test.mjs` | `f9d0b429fe4322b896a5641dcab066bcbaa32a7e` | verbatim |
| `http-mcp/test/purchase-model-view.test.mjs` | `ced0b7e90cfc1ff98e869e18a01a7a616dfc4d6d` | edited: comments and test names: internal review and process references removed; then changed here: the test that read `paymentEvidence` fields raw from the model copy now decodes the seller-data envelope and asserts the same values |
| `http-mcp/test/purchase-poll.test.mjs` | `821f5e69e883f39f05419d3cc26cf35ab3f81eb8` | verbatim |
| `http-mcp/test/purchase-readback-cache.test.mjs` | `e5630402e08a42858f3a8aea3d8c7c54b2d8295e` | verbatim |
| `http-mcp/test/purchase-receipt.test.mjs` | `e1cfe4977b26a51002382ec092b0afe17005dee1` | edited: address replaced by a documentation address |
| `http-mcp/test/purchase-reviewed-body.test.mjs` | `1c33ec5827b1e30c06872d861e7942e4ed439427` | verbatim |
| `http-mcp/test/purchase-step-log.test.mjs` | `f14929daa5c829820d159db44b8db75cafcc94c5` | verbatim |
| `http-mcp/test/purchase.test.mjs` | `10bdf672d8758b2f52b6a122746e56bb93ec1c4c` | edited: comments and test names: internal review and process references removed; no behaviour change; then changed here: two assertion messages and a comment reworded to describe only the network guard; the checks are unchanged |
| `http-mcp/test/purchased-report.test.mjs` | `1e84b71942bbce5b3a0791ba73bfe1c0129ef43e` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/test/run-test-files.test.mjs` | `88cbcf0071f6b98aeca2b1b555d22ed8f83d5a00` | verbatim |
| `http-mcp/test/seller-http-failure-cause.test.mjs` | `0fc5307e17bed8255862ac379fa1e7355982480e` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/test/seller-identities-integration.test.mjs` | `32f9623cf450814a63ef5365303a563026783904` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/test/seller-identities.test.mjs` | `0c1284928dc41ab837d31d6edf29c583a84e6952` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/test/seller-native-delivery-lock-fence.test.mjs` | `3c074074e5ab114c84db297b4e47062373d21c04` | verbatim |
| `http-mcp/test/seller-payment-recovery-repair-prefixed.test.mjs` | `82530e0672b577dfe3fbd082aa27e8a526a16a41` | verbatim |
| `http-mcp/test/seller-policy-delivery-evidence.test.mjs` | `80af6437abec94e51a02bbcf0bde9c1b9f258d14` | edited: fixture key literals passed through idem() so they are not credential-shaped; comments: internal references removed |
| `http-mcp/test/seller-session-concurrent-recheck.test.mjs` | `3c58e0661bc3b3e6934b0f281be1b30710c5ad28` | verbatim |
| `http-mcp/test/seller-session-delayed-evidence.test.mjs` | `02a114b46424570692661c7967962787cac9c9c5` | verbatim |
| `http-mcp/test/seller-session-final-readback.test.mjs` | `e95b02a728095e1941562f4bcba93e0b2c02ba77` | verbatim |
| `http-mcp/test/seller-session-final-recheck.test.mjs` | `23b22e5b3bccb3cc1f5565e9586b9639a0b4defe` | verbatim |
| `http-mcp/test/seller-session-final-time.test.mjs` | `b35e4baa3bc2ed5542fa4edb386e7b1d594e5942` | verbatim |
| `http-mcp/test/seller-session-key-secrecy.test.mjs` | `4f4b164d357836a120556cac51f7d60ec14978cf` | verbatim |
| `http-mcp/test/seller-session-late-recheck.test.mjs` | `3dfa891c79f423ac31b2eb3537b91f32b573258f` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/test/seller-session-legacy-operator.test.mjs` | `069298a3d39ee6e3f1a64504a52eda14bbf5d3f4` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/test/seller-session-open-access.test.mjs` | `7502bf1a33d3e0ded0c9628ee30798a39766bf8e` | verbatim |
| `http-mcp/test/seller-sr2-agreement.browser.test.mjs` | `70fab5089c5586a687a3f92d4bd6a226d7cead3e` | verbatim |
| `http-mcp/test/seller-sr2-agreement.test.mjs` | `c08ee672a374af1f78d65c74bb8523da9d79b1a2` | verbatim |
| `http-mcp/test/seller-uncertain-payment-recovery-prefixed.test.mjs` | `6e76194153d416bc3a4a530d8636abf833ff8967` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/test/service-request-mutants.test.mjs` | `08c6f43955f441fe46419dcbf13bd7e0e9a81d4e` | verbatim |
| `http-mcp/test/settlement-kind-bridge.test.mjs` | `ed0a5ccf289098e042ad24c0043ce59754744be0` | verbatim |
| `http-mcp/test/settlement-pointer-race.test.mjs` | `65b21f20c9954df5ba39a3ecf1f7065cd8896648` | verbatim |
| `http-mcp/test/settlement-process-death.test.mjs` | `ceb44b94f6d5ef37b87b2237adf22767aead9328` | verbatim |
| `http-mcp/test/showcase-ledger-integration.test.mjs` | `cceca13d703f73d2f4e7af38339519b3c2900370` | edited: fixture key literal passed through idem() so it is not credential-shaped |
| `http-mcp/test/showcase-ledger-native-integration.test.mjs` | `10c77b62599d4988d0e42a836d4464e411642878` | verbatim |
| `http-mcp/test/showcase-live-operator.test.mjs` | `eff8a3cc111c6ee046cdf2210701e819e4b08144` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/test/showcase-progress-render.test.mjs` | `e975bfeaab1b2a5d8281f41fedf9a200a8929941` | verbatim |
| `http-mcp/test/showcase-progress.test.mjs` | `2b3eb9642e42aa21e4e61b6d49898157dbb9cc40` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/test/showcase-receipt-config.test.mjs` | `027c9dce0615af772abc25cab8d62948acf8fff3` | verbatim |
| `http-mcp/test/showcase-report-commit-on-signature.test.mjs` | `4d0eaa2c84b3e24a52d886e3f27e2a36c91192f9` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/test/showcase-report-main-switches.test.mjs` | `0311a0e6e8a00865082a3f4f4ac8aa8797dd8e29` | edited: public origin example replaced by a reserved example host; its origin-preflight test rejects any placeholder origin, and the file fails at load here because the code it tests is not carried |
| `http-mcp/test/showcase-report-seller-identities.test.mjs` | `c07d672d1d69028ea1dbe7fb75f55b02f6092f19` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/test/showcase-report-settlement.test.mjs` | `fdf68c3813090c5c2b8d9f8d1aea7859cfb058b9` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/test/showcase-safety.test.mjs` | `33592ba9db541a08c7da0b6ab3886e11aba9ba44` | verbatim |
| `http-mcp/test/showcase-walkthrough.test.mjs` | `f256ca7de7f9cf0bb8b843d1262e8ec8c53b3cdb` | verbatim |
| `http-mcp/test/source-demo-e2e.test.mjs` | `f434aa15f6507683b7729b508519aa9d1e8c1cd3` | verbatim |
| `http-mcp/test/source-demo-profile.browser.test.mjs` | `75a3ba39567db0f573ba9461ccd0ce60ff32d439` | verbatim |
| `http-mcp/test/start-intent-compose.test.mjs` | `d5d458db5217bb07ca3ab279e5a12f481b51f3db` | verbatim |
| `http-mcp/test/start-intent-create-fence.test.mjs` | `8ee59d47255c73529ba843bbd5451a9006a2276f` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/test/start-intent-devnet.test.mjs` | `8d340e3cbac6066652a35e3eb1e7a1837a0e1cd7` | verbatim |
| `http-mcp/test/start-intent-flow.test.mjs` | `cfd5dbf9f417c0a2339c634c46372e7ecdcfab20` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/test/start-intent-journal.test.mjs` | `37b65b1a41d8158cd5c788142c46d6b895313307` | verbatim |
| `http-mcp/test/start-intent-operator-auth.test.mjs` | `136b1651aad696bf8673dd92183122515fc9e814` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/test/start-intent-peer-write.test.mjs` | `b275c67d75befb4ac3e337af11a4bfce79f2bfdc` | verbatim |
| `http-mcp/test/start-intent-production.test.mjs` | `0d79405dea10af3ff55718eb5c370f2e780471a8` | verbatim |
| `http-mcp/test/start-intent-retry.test.mjs` | `846ce19be4f36bf41900fdb30e064e10e8823aad` | verbatim |
| `http-mcp/test/start-intent-review-assets.test.mjs` | `623b3ce533518885b9a7187b12eb2105bed07fa2` | verbatim |
| `http-mcp/test/start-intent-review-server.test.mjs` | `44c82d74136f3752ebf514ea2ef7f4150d702ce8` | verbatim |
| `http-mcp/test/start-intent-review-wallet.test.mjs` | `cc3f3dccb38a79c1e7ba39b672f969aa95ec1e9d` | verbatim |
| `http-mcp/test/start-intent-switch.test.mjs` | `bfd12a5d743a1b6441f5f9bfd05b894a951e9ca6` | verbatim |
| `http-mcp/test/start-intent-wallet.test.mjs` | `d3f0b6c95036be12c1303de8eb03a209dfd12de5` | verbatim |
| `http-mcp/test/store-transaction.test.mjs` | `a31edd1030546efbe018588780f1ef6ec06e5fcc` | verbatim |
| `http-mcp/test/switch-registry-mutants.test.mjs` | `e274cb82de1c2493586bdebd13f23bdf20b5e8fa` | verbatim |
| `http-mcp/test/switch-registry.test.mjs` | `8d90091a2fd18f6927a6759a81f65f0f32a62a6e` | verbatim |
| `http-mcp/test/tester-dashboard.test.mjs` | `e925abe14db23674ccf48680f79a4d89b9312814` | verbatim |
| `http-mcp/test/tester-quickstart.test.mjs` | `903ca6d4c7435419bde79acae859e9c5a0ea8ac7` | verbatim |
| `http-mcp/test/ui-status.test.mjs` | `82084a766e7d3f668ece00ccf54ffcac005907d5` | edited: comments and test names: internal review and process references removed; then changed here: the list of fields known to reach the model raw is removed and the test expects none |
| `http-mcp/test/unit.test.mjs` | `b00c9262980fcdb5721e1a01a3c7b4524ac83de9` | edited: client address replaced by a documentation address |
| `http-mcp/test/unsupported-node-fee.test.mjs` | `f5559258e76df9cc5852e9d13825dcd552c1a19e` | verbatim |
| `http-mcp/test/v2-health.test.mjs` | `ffe4ce270556664372c03148aafc09bc3b13e767` | verbatim |
| `http-mcp/test/v2-publication-removal.test.mjs` | `0f449b26ea963587bd05a677cdff2730afe463fc` | edited: two tests that read deploy scripts that are not carried deleted; unused imports removed |
| `http-mcp/test/wallet-additional-fee-hold.test.mjs` | `7a4484a8984819b2baf3fed6d11f7593cd8dae08` | verbatim |
| `http-mcp/test/wallet-demo-plan-admission.test.mjs` | `b608db84f142991e7d4347cbe6cece89828b41f2` | verbatim |
| `http-mcp/test/wallet-extension-probe-mutants.test.mjs` | `77a0c826dc69d56ea8df166cc42b9a2cb1c631c8` | verbatim |
| `http-mcp/test/wallet-extension-probe-r4.test.mjs` | `01b9fab7063f11a75474c756302b0f057d384572` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/test/wallet-extension-probe-r5.test.mjs` | `8050f8dc37c05c4cbf61fddeb73123fcc0afba27` | edited: comments and test names: internal review and process references removed; no behaviour change; further public wording; a pinned documentation sentence updated |
| `http-mcp/test/wallet-extension-probe-routes.test.mjs` | `b3521fca674f912d80997d6196f5b60067501861` | edited: comments and test names: internal review and process references removed; no behaviour change; the pinned `portal.js` digest is the published file's |
| `http-mcp/test/wallet-extension-probe.test.mjs` | `4b84b2886471d43cdb5e9f17298722a64488c4ac` | edited: comments and test names: internal review and process references removed; no behaviour change; further public wording; one test renamed and its stub simplified; one test fixture field and one assertion message reworded; two test fixture values changed |
| `http-mcp/test/wallet-write-batch.test.mjs` | `049f93706b042a6d2aa447f7664bd4b600a70134` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `http-mcp/wallet-build/.gitignore` | `c2658d7d1b31848c3b71960543cb0368e56cd4c7` | verbatim |
| `http-mcp/wallet-build/build.mjs` | `ec00e2dc8ec7dc1cf15961a672556b9eeabbaa4e` | verbatim |
| `http-mcp/wallet-build/entry.mjs` | `6eb51d8f6a17ae3321704d9913c42e8ad15abdd8` | verbatim |
| `http-mcp/wallet-build/package-lock.json` | `3eb3a13163a28d7612ec08546d84a8261ef90ca3` | verbatim |
| `http-mcp/wallet-build/package.json` | `6370d54fbf15b44f14e0005bb3471ed93999b52e` | verbatim |
| `http-mcp/wallet-build/shims.mjs` | `b90f32a3c063bf436cd25a96ab7b27d61491c43c` | verbatim |
| `package-lock.json` | `02b053fab55700b6fe75742c85076e26dc230628` | added: lockfile of the root package |
| `package.json` | `eedccf13a875a3ee07878352025deef666941062` | added: root package with the gate scripts and the test command |
| `public-gate.config.json` | `3339fd400041d3c885564000af90dd88168b053c` | added: gate limits, text extensions and binary dispositions |
| `scripts/lib/choice.mjs` | `1eb82eb1d57e29c8601bc7f24f3eb0b8b37a3292` | added: public-content gate source |
| `scripts/public-gate/check-report.mjs` | `d8967e36b2ff00bf63c300eac3520612206cfb64` | added: public-content gate source |
| `scripts/public-gate/classify.mjs` | `afe007bda11127b8e9d1baa181a5bba277545bc2` | added: public-content gate source |
| `scripts/public-gate/gate.mjs` | `da2583a6d49ff586e53b17d4ec021f4773b90ceb` | added: public-content gate source |
| `scripts/public-gate/history.mjs` | `c885f5e9069a2f143be090b442e3acd8619cc981` | added: public-content gate source |
| `scripts/public-gate/objects.mjs` | `167f1ade7dfcc5fc8dd1a53d3e70f41c15a5bfb3` | added: public-content gate source |
| `scripts/public-gate/redact.mjs` | `8a04da888122e00a828f5818cd11ccbab8443c91` | added: public-content gate source |
| `scripts/public-gate/rules-private.mjs` | `b57b5753c6809159554f4c82b205c31b0baafda9` | added: public-content gate source |
| `stdio-mcp/.claude-plugin/marketplace.json` | `d84732871f473d7f9e0bc6a1144bae8b0646af0f` | verbatim |
| `stdio-mcp/.claude-plugin/plugin.json` | `c977a78af1a20e73a71e8fb05ac88dfc15f6b66a` | edited: RPC and opt-in descriptions name no host and do not direct testnet writes to the mainnet opt-in |
| `stdio-mcp/.gitignore` | `db95153686d0c7bbbc1ffe2b84468bf9a5f979af` | verbatim |
| `stdio-mcp/.mcp.json` | `d645db37dc6bab55f3582af16b663e5cf6978fcb` | verbatim |
| `stdio-mcp/LICENSE` | `7d73a34f494ae4d87e549308c2b4559497dc7ffb` | verbatim |
| `stdio-mcp/README.md` | `755aa5c5d4c5eb3b8ddb985d35756c4a1e5ce888` | edited: no link to the network site; no built-in RPC default; testnet writes and faucet requests are refused in this release; no references to documents that are not carried; keystore examples use neutral paths; a "state of this release" note; install directory corrected; flows this release refuses marked |
| `stdio-mcp/SECURITY.md` | `ad8c344d1072dd271788c06664aa635ee1c808cf` | edited: testnet writes and faucet requests are refused in this release; vulnerability reports point to GitHub's private vulnerability reporting; live-run claim marked as made in the source repository; the CI description corrected to this tree |
| `stdio-mcp/adapters/HOSTS.md` | `bb8adfc1574c71436b8ce455afb09a03af360b70` | verbatim |
| `stdio-mcp/adapters/claude/README.md` | `a83699c03384cb7e060e0a4444babad1042e19c2` | verbatim |
| `stdio-mcp/adapters/gemini/GEMINI.md` | `5a65f370f8fa8764ed5a282bc46cb215bfd4f1c8` | verbatim |
| `stdio-mcp/adapters/gemini/gemini-extension.json` | `9d06740232b63410e3baa6a94424a27118829c94` | verbatim |
| `stdio-mcp/alignment/ALIGNMENT_CARD.md` | `fda9c38e1db10ce3e02dc8473ca8de44fc57b22f` | verbatim |
| `stdio-mcp/alignment/index.d.mts` | `82ba8f6db732f3b1e051cdf33a9dd647112559b0` | verbatim |
| `stdio-mcp/alignment/index.mjs` | `42de6adf6c8191b508ba55176c15ece2b5e18e9a` | verbatim |
| `stdio-mcp/commands/demos-attest.md` | `02bdbc279d52aaac7171e83bb508dacfc3e3227b` | verbatim |
| `stdio-mcp/commands/demos-balance.md` | `826440407f8fc34e3838fcc56fd98abd217a70a4` | verbatim |
| `stdio-mcp/commands/demos-buy.md` | `88ae81ae7d279a3ba2c1b4634b4e75648cc09d74` | verbatim |
| `stdio-mcp/commands/demos-onboard.md` | `7c2f187772845f801d0cced18a967a0c52442a2c` | verbatim |
| `stdio-mcp/commands/demos-verify-receipt.md` | `3859eb3b0c8375a3e08cff9d0d733e87b0a3c47e` | verbatim |
| `stdio-mcp/docs/MANDATES.md` | `ddfa22924388adcc07fc785ab870aebc1e3b6631` | verbatim |
| `stdio-mcp/package-lock.json` | `2d064ce7cbe3858df1f04b34157864c444aa6ae9` | verbatim |
| `stdio-mcp/package.json` | `9435223d112f21b034f3ad1a51f580f6a4b0b2f2` | verbatim |
| `stdio-mcp/scripts/launch.mjs` | `98afd69e8345e1b0249d64ae6fb6f218746140d5` | verbatim |
| `stdio-mcp/skills/demos-onboard/SKILL.md` | `913f8094cbb7852c1b9f73acf4a6f27bfc311e6d` | verbatim |
| `stdio-mcp/skills/demos-safe-flow/SKILL.md` | `0f73a1740f64355ed641c0713465207c2279599c` | verbatim |
| `stdio-mcp/src/amount.ts` | `85820ceb4cd07d5908d3f19ea3174cd1dbbe42c5` | verbatim |
| `stdio-mcp/src/approval.ts` | `9a37e218785429f7ca053d9c712545f17981575d` | verbatim |
| `stdio-mcp/src/chain.ts` | `92350147045521dcd898b5879104530ff8c61d03` | edited: comment no longer points to a document that is not carried |
| `stdio-mcp/src/config.ts` | `19daa6098ca649b93edc6c48a0507285ffcf7b49` | edited: no built-in RPC or faucet host (reserved .invalid placeholders); testnet host list empty (testnet writes are refused); refusal message names no opt-in; behaviour change: testnet writes off a known testnet RPC are refused even with the mainnet opt-in |
| `stdio-mcp/src/confirm-text.ts` | `2455d73648c54fb36a56b1f062cada9d21d051db` | verbatim |
| `stdio-mcp/src/confirm.ts` | `7c44f6252cb80892e651b12530f21114436a4e5f` | verbatim |
| `stdio-mcp/src/dacs/agreement.ts` | `8f5c8a477da24ba09e2baac20f02d67b76aaee0e` | verbatim |
| `stdio-mcp/src/dacs/jcs.ts` | `7bf1b3801113ed690d7c3797e8b6ff2054d95db0` | verbatim |
| `stdio-mcp/src/dacs/listing.ts` | `52f6be56eddeeca84a0040845b93684218f7036a` | changed here after a verbatim import: a presentation signature is checked only for a canonical key that is not of small order |
| `stdio-mcp/src/dacs/sig.ts` | `1d07c61362c43c25caeeda5f9db53347ad40576a` | changed here after a verbatim import: adds isUsableKey; domain signatures are checked only for a canonical key that is not of small order |
| `stdio-mcp/src/dacs/verify.ts` | `d8ea0735bba5ebb2de6c11eaa25cb3dc488b4205` | verbatim |
| `stdio-mcp/src/http_transport.ts` | `316faaa22aeb893f8f83bb167f4752ffe895dcfc` | verbatim |
| `stdio-mcp/src/index.ts` | `43f30e8a2061ca84ef3726ef6d99acd71d27530f` | verbatim |
| `stdio-mcp/src/json.ts` | `6e881379ecb79fcd997f7585bea7af2380f3688e` | verbatim |
| `stdio-mcp/src/keyless.ts` | `f0391f4b3c7202dc35e54c6f104c58b1d417ff04` | verbatim |
| `stdio-mcp/src/keystore.ts` | `791b33b25fe8e29e92857b346965533228813d65` | verbatim |
| `stdio-mcp/src/log.ts` | `9164ef9bd5557aaa34ca0983806f12ed019a8728` | verbatim |
| `stdio-mcp/src/mandates.ts` | `7bda4646563dc14091f9e1d3508408ebe766f780` | verbatim |
| `stdio-mcp/src/onboard.ts` | `9a40e08036e4883eebaa4f00e478607437920381` | verbatim |
| `stdio-mcp/src/prepare_core.ts` | `70d5ac863b27c7103f8a230ab3db8cc65d472a57` | verbatim |
| `stdio-mcp/src/receipts.ts` | `3fb97e6ebe93a840a1df422d5ba6917b1c9d3578` | verbatim |
| `stdio-mcp/src/secrets.ts` | `ca0c3736baf1961a77fab94f9db8844749de64f5` | verbatim |
| `stdio-mcp/src/server.ts` | `1e409a5b02c571f83d28bed990f203ab5b5db847` | verbatim |
| `stdio-mcp/src/spend.ts` | `dd1827a0826ac41bcd91562779ffcfeffa696e93` | verbatim |
| `stdio-mcp/test/fixtures/listing-preserve-unknown-v0.1.json` | `6e64f1110858e005b52b2fe8559810bd41514943` | verbatim |
| `stdio-mcp/test/helpers.ts` | `9bd6aeb48172ea1f463bd65da96acdcca4b6bc13` | edited: mock RPC uses a reserved .invalid host and counts as the known testnet as a test double |
| `stdio-mcp/test/integration/testnet-read.test.ts` | `c98ead67551b8f5e1f2233eae41e26cb973f5abd` | edited: RPC comes from DEMOS_RPC_URL; the test skips without it |
| `stdio-mcp/test/live/testnet-write-cycle.ts` | `4a99ee144a5127dc8d1affdcba71c68f0d73a3eb` | edited: RPC comes from DEMOS_RPC_URL; the driver skips without it |
| `stdio-mcp/test/unit/alignment.test.ts` | `f62adb8006b99354890e944d356b2a5cbd98b742` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `stdio-mcp/test/unit/confirmation.test.ts` | `3596e7646f5cc20a7cd08d3c98b43ce3a5d71d0b` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `stdio-mcp/test/unit/dacs.test.ts` | `f715e0f401dae8394945cfcc0aeef516aa46d25f` | edited: comments and test names: internal review and process references removed; no behaviour change; then changed here: a test added for ordinary, wrong-message and small-order keys on a domain signature |
| `stdio-mcp/test/unit/guard.test.ts` | `21da5541cc58f8fce07313f3c4b821d411134a33` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `stdio-mcp/test/unit/keyless-http.test.ts` | `9574b7eaceef3f45a1f00da924317a4532234dbf` | verbatim |
| `stdio-mcp/test/unit/keystore-and-reads.test.ts` | `d8e40a28f796868c2cd55a0b34f4eb8cb60f67d2` | verbatim |
| `stdio-mcp/test/unit/listing.test.ts` | `1776f63ba9bf3b96de13b8303a879d53511c27e9` | changed here after a verbatim import: tests added for ordinary and small-order keys on listing and presentation signatures |
| `stdio-mcp/test/unit/no-key-leak.test.ts` | `7d28d7c24e969954ae11bb97ab45facb77cdeb3c` | edited: comments and test names: internal review and process references removed; no behaviour change |
| `stdio-mcp/test/unit/onboard.test.ts` | `fc20a5f78039bbbc1b4c1f56ebcdcbc0c10d6cbf` | edited: expects the reserved faucet placeholder; the faucet refusal case uses an explicit mainnet setup, since unlisted testnet RPCs no longer take writes |
| `stdio-mcp/test/unit/prism.test.ts` | `ac59a60af9c7a9cbda4c63a29f9488b8b231c667` | edited: comments and test names: internal review and process references removed; no behaviour change; then changed here: a header comment reworded to neutral text; no behaviour change |
| `stdio-mcp/test/unit/spend-and-policy.test.ts` | `9534816425ca70e4e6735189201237ac082c1c20` | edited: testnet RPC example replaced by a reserved .invalid host; adds the sanitized-defaults guard test; adds a regression check that the mainnet opt-in does not open testnet writes |
| `stdio-mcp/test/unit/workflow-pins.test.ts` | `d0b825c89dc87d986e1abf74ad0757837d5bfaf0` | edited: header comment: internal identifiers removed; skip message and comment reworded |
| `stdio-mcp/test/unit/workflow-settings.test.ts` | `d30cca6e6e28275e7044eed3e5fe413e1114a654` | edited: header comment: internal identifiers removed; skip message and comment reworded |
| `stdio-mcp/tsconfig.json` | `3cf94395ce469d74d6c8ba7abcb763df04e51863` | verbatim |
| `test/ci/carry-state.test.mjs` | `ad09f5acfeaac7b1623e4400bc8e984326a0817d` | added: tests of the public-content gate and of the carried-file inventory |
| `test/ci/root-script.test.mjs` | `1113534311581054298466b4a169d518b8afc40b` | added: tests of the public-content gate and of the carried-file inventory |
| `test/lib/choice.test.mjs` | `654dead8e6a23f82bf27272959eb827a1d5db717` | added: tests of the public-content gate and of the carried-file inventory |
| `test/lib/gate-fixtures.mjs` | `53197b06b98db5fe0ab46759853e7bbbdc59d7d8` | added: tests of the public-content gate and of the carried-file inventory |
| `test/public-gate/check-report.test.mjs` | `09549b3b6da1fd548295b44933e1b2b0e59acbac` | added: tests of the public-content gate and of the carried-file inventory |
| `test/public-gate/engine.test.mjs` | `bd5f7814039a0f8462952dc732a7ab46d5567b60` | added: tests of the public-content gate and of the carried-file inventory |
| `test/public-gate/history.test.mjs` | `85e32aeb0a686c9078095ea836ee92895166e0fd` | added: tests of the public-content gate and of the carried-file inventory |
| `test/public-gate/private-list.test.mjs` | `005f16e31528208ba6f9afbec8c0cfe0b8f20b77` | added: tests of the public-content gate and of the carried-file inventory |
| `test/public-gate/private-matcher.test.mjs` | `7cea6ab6e576663cc6566a3c033cfacc55e14620` | added: tests of the public-content gate and of the carried-file inventory |
| `test/public-gate/private.test.mjs` | `a90437a91d66394fd6700f7266b6e790d3045508` | added: tests of the public-content gate and of the carried-file inventory |
| `test/public-gate/redact.test.mjs` | `23a902dbf88f50cd9f617e83864f0a4ac45c0be3` | added: tests of the public-content gate and of the carried-file inventory |
| `test/public-gate/report.test.mjs` | `85aa337784bb9b1747f7b9eb5ccebe60a580c1f9` | added: tests of the public-content gate and of the carried-file inventory |
