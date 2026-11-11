# Safety showcase: refusal and recovery

These examples make the plugin's protections reproducible without paying anyone.
Run from `http-mcp/` with Node `^22.22.2 || ^24.15.0 || >=26` and the installed dependencies:

```sh
node scripts/showcase-safety.mjs all
node --test --test-concurrency=1 test/showcase-safety.test.mjs
```

Both commands run on Linux and macOS. On Linux the temporary journal directory
is bound through `/proc/self/fd`; other platforms use path checks only (see
Limits below). The second transcript line says which one was used.

The driver prints a short transcript for each scenario and exits unsuccessfully
if an assertion fails. Every scenario asserts its exact broadcast count. Hashes
vary between runs because test signing keys are generated in memory.

All chain and transport responses are fake callbacks. The loopback URL is an
inert label: there are no network sockets or external requests, and the driver
never uses a wallet account with funds. Restart scenarios use a local parent-child IPC channel
to report the exact kill boundary; on Linux this channel uses a local socket.
The driver writes public transaction records and
counters only to temporary SQLite files, including their WAL/SHM files, then
removes them. No keys, seed phrases, tokens or custody are saved. Restart cases
kill only the child process created for that scenario.

`TMPDIR` (or the platform temp directory when unset) must be a real directory.
Every path component, including its ancestors, must be owned by the current
user or root. Symlinked components are refused. Group- or world-writable
components require the sticky bit, as in a protected system `/tmp`. A private
mode-0700 `TMPDIR` alone cannot make an unsafe ancestor acceptable. For a
workspace-local run, choose a mode-0700 directory beneath safe ancestors and
export its absolute path as `TMPDIR` before running the commands above.

Each allocated journal directory is private to the current user. The fixture
records its device and inode. Before every SQLite open (including the child's
initial open and the parent's restart), it rechecks the ancestor policy, opens
the directory with `O_NOFOLLOW|O_DIRECTORY` (a symlink, FIFO or file swapped in
is refused at once), and checks that descriptor's identity, ownership and
permissions. A changed or unsafe directory is refused before SQLite opens
anything. Where `/proc/self/fd` names the opened directory (Linux), SQLite then
opens the journal file through `/proc/self/fd/<descriptor>/`, which narrows the
window for redirecting that open but does not close it (see Limits). Elsewhere,
including macOS, SQLite opens the path itself. In both cases the path is checked
again after the open returns, and the journal is closed and refused if the path
no longer names the checked directory. The parent's restart also requires the
journal ID reported by the killed child.

Cleanup first checks that the path still names the allocated directory; if it
does not, cleanup is refused and nothing is removed. It then removes the files
(through the directory descriptor on Linux, by path elsewhere) and, after a
second check, removes the empty directory with `rmdir`, which cannot delete a
non-empty replacement. These checks require `process.getuid()`. Setting
`DACS_SHOWCASE_DIRECTORY_BINDING=path` makes Linux use the path-only variant too,
so both can be tested on one host.

Limits: the current user and root remain trusted; either can edit the journal
itself. Within that, a same-user swap of the journal directory's path is still
possible in these windows:

- **Final `rmdir`.** POSIX has no remove-by-descriptor call for a directory. An
  *empty* directory swapped in after cleanup's second check (which includes the
  full ancestor walk) is removed, cleanup reports success, and the original,
  already empty, is left behind under its new name. A non-empty replacement
  fails with `ENOTEMPTY`.
- **SQLite's own opens by name.** Even on Linux, SQLite turns the descriptor
  path into a text path inside its open call and opens the main journal file by
  that name. It opens `-wal` and `-shm` by the same name at its first statements
  after the open, and on close it checkpoints and then deletes them by name. A
  swap in those windows can make the journal open, write, read (including a
  planted WAL) or delete files in a replacement directory. The check after the open refuses a swap that is still in place when
  the open returns; a swap reverted before that, or one during close, is not
  detected.
- **Without `/proc/self/fd` (macOS and other non-Linux platforms).** The race the
  descriptor closes stays open: a swap between the directory check and SQLite's
  open makes SQLite open the journal in the replacement (refused afterwards only
  if the swap is still in place), and a swap between cleanup's first check and
  its file removals deletes the replacement's contents, recursively, including
  through a symlink swapped in for the directory (cleanup then refuses before
  `rmdir`).

Nothing is enabled in the server, MCP tools or portal. Existing configuration
and defaults stay unchanged; this checkout-only driver runs on explicit command
invocation. The normal package does not include `scripts/` and `test/`.

| Protection | Reproduce | Exact broadcast attempts |
| --- | --- | --- |
| Changed recipient refused | `node scripts/showcase-safety.mjs recipient` | 0 |
| Unavailable evidence stays unknown | `node scripts/showcase-safety.mjs unavailable` | 0 |
| Lost payment acknowledgement | `node scripts/showcase-safety.mjs lost-payment` | 1 |
| Restart inside broadcast callback | `node scripts/showcase-safety.mjs restart` | 1 before / 1 after |
| Restart before transport handoff | `node scripts/showcase-safety.mjs restart-before-broadcast` | 0 before / 0 after |
| Delayed or missing output | `node scripts/showcase-safety.mjs delivery` | 1 |

## Changed recipient: stop before signing

The buyer reviews a payment to recipient `0xbb…bb`. The seller's subsequent
payment request substitutes `0xee…ee`. The real `createExactBuyerApproval()`
compares that request with the original expectation and refuses it before the
wallet authorization callback. Signing and broadcast callbacks are never reached.
The transcript ends with `Signatures: 0; broadcasts: 0.`

This demonstrates the operator buyer approval seam. It does not automate the
ChatGPT or browser review screens or change a published Listing on a chain.

## Unavailable evidence: keep the answer unknown

A fake chain read throws. The real `createDemosChainReader()` and pinned SDK
observer return `status: unavailable`. The showcase labels this **unknown** and
retains that raw result; the label is local transcript vocabulary. It is neither
proof of success nor proof of failure. No payment is attempted.

## Lost response: recover the original payment

The real native transport retains the signed payment before its single broadcast
callback. The fake chain records the payment, then loses the acknowledgement.
The issued journal entry remains `broadcast-started`.

An attempt to obtain another signing lease is refused with `outcome_unknown`.
Recovery calls the existing readback path for the retained hash. It verifies
the original transaction and block membership, and a repeated recovery reads
again. Both readbacks refer to the same original hash. The count remains **one**.

The callbacks stand in for one node. Inclusion here establishes neither live
payment nor independently authenticated consensus finality.

## Restart: retain the hash, never resend

The parent waits for a child to reach a known boundary, sends `SIGKILL`, waits
for the child to exit, and reopens the same SQLite journal. No graceful close or
manually planted issued record substitutes for the crash.

`restart` kills inside the fake broadcast callback, after the journal retained
the intent and the callback recorded the one attempt, before its acknowledgement
returns. Recovery finds the same hash and signed bytes. The count stays **one**.

`restart-before-broadcast` kills immediately after intent retention, before the
transport callback. The count is **zero**, and readback remains `pending` for the
same hash. An ordinary not-found answer does not authorize another send.
A kill before any broadcast cannot truthfully have a count of one, so both
boundaries are shown separately.

The durable journal keeps the dead holder's lock. Readback first refuses with
`journal-busy`. Only after observing the child's exit does the fixture explicitly
release that exact abandoned lock using the existing API. Issued records remain
intact; releasing the lock grants no permission to resend.

## Missing output: payment does not complete the purchase

After one fake payment, a seller pointer claims the output is ready. Independent
delivery callbacks then return delayed, absent and thrown-read results.
The real `readDemDeliveryReady()` returns `indeterminate` with no report for each.
The production `protocolView()` is separately checked with a legacy retained
report at `payment-evidenced`: it hides those stale bytes, shows service
`not-delivered`, and shows completed copies `not-exchanged`.

These are reader and presentation seam checks, not a complete purchase reducer
integration. Missing output establishes neither completion nor a refund. This
slice adds no deadline enforcement or refund state; those belong to the delivery
workstream. The broadcast count remains **one** throughout all three reads.

## Code exercised and limits

The fixtures call existing buyer approval, chain reader, native transport,
durable journal, delivery reader and status projection code. Recovery follows
the existing no-resend paths. Inspection also covered the seller
[`artifact-anchor`](../src/devnet-demo/artifact-anchor.mjs) (in a source checkout only) recovery paths; these
scenarios do not publish seller CREATEs or change that machinery.

These deterministic fault demonstrations do not establish browser behavior,
ChatGPT host rendering, current chain availability or live recovery acceptance.
See [DEVNET-FIXED-PRICE-DEMO.md](DEVNET-FIXED-PRICE-DEMO.md) for the wider purchase scope.

Mutant checks use `test/helpers/showcase-safety-mutants.mjs` to remove guards from
module source in memory; source files remain untouched. This optional verification
hook requires Node 22.15 or later and a source checkout (the `test/` folder is not
in the package). Run one mutant from `http-mcp/` with
`DACS_SHOWCASE_MUTANT=<name> node --import ./test/helpers/showcase-safety-mutants.mjs --test --test-concurrency=1 test/showcase-safety.test.mjs`;
the names are listed in the helper, and each must fail at least one test.
