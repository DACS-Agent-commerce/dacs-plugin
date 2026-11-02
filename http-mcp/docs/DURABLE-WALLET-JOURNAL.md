# Durable shared wallet journal (standalone, opt-in)

`src/wallet/durable-journal.mjs` is an explicit `node:sqlite` journal that
implements the existing consumer interface: async `get(key)`, `put(key, value)`,
`entries()` and `withWalletLock(key, work)`. Nothing in application
configuration constructs it, and no public mode is wired. Default/live payment
holds and the empty `PINNED_CHAIN_IDENTITIES` stay unchanged.

```js
import { openDurableWalletJournal } from './src/wallet/durable-journal.mjs';
const journal = openDurableWalletJournal({ path: '/caller/owned/dir/wallet-journal.sqlite', mode: 'create' }); // later: mode: 'open'
```

## What it stores

Public material only: signed transaction intents, approvals, receipts and
broker/bridge stages. It holds no key, mnemonic, password, seed or vault.
Values must be exact JSON (plain objects, dense arrays, finite numbers other than
`-0`, strings, booleans, null). It keeps key order, because the wallet compares
`JSON.stringify` readback. `undefined`, BigInt, Date, NaN, cycles and other
non-JSON values are refused before anything is written.

## Semantics

| Case | Behaviour |
| --- | --- |
| `mode: 'create'` on an existing path | `journal-exists` |
| `mode: 'open'` on an absent path | `journal-absent`. A missing journal is never silently recreated, which would forget issued lanes. |
| `expectedJournalId` differs | `journal-integrity` |
| Row value changed, row moved to another key, row deleted, totals/identity changed | `journal-integrity` on read, write and lock acquisition. A removed fence is not read as absent. |
| File not a database / fails `quick_check` | `journal-integrity` |
| Record, key or total capacity exceeded | `journal-capacity`; nothing is written |
| Lane held by another holder (any process) | Bounded wait (`lockTimeoutMs`, default 2000, max 60000), then `journal-busy`; no work started |
| Holder process died or stalled | Its lock row stays. It **never** ages out or times out; other holders get `journal-busy`. |
| `put(key)` while another holder owns `key` | `journal-fenced` |
| Holder whose lock row was removed tries to `put` | `journal-fenced` |
| Same-key reentry in one async context | `journal-reentrant` at once (the existing in-memory journals would deadlock) |
| Distinct nested keys (e.g. `plugin/agreement/<id>` → `sr2/wallet/<lane>`, broker record → lane) | Supported. Cross-order deadlocks end as bounded `journal-busy`. |
| Work settles (resolve or throw) | Lock row deleted by its own token only. A failed release leaves the lane held and is reported. |

Records are never deleted, and there is no delete API. A `broadcast-started` or
`sr2-readback-pending` lane record therefore keeps fencing the unchanged
wallet (`outcome_unknown`, no prompt, no broadcast) after reopening, restoring
a session or removing a lock.

### Abandoned locks (explicit operator action)

`inspectLocks()` lists `{ key, instance, pid, fence, acquiredAt }`. When the
operator has independently established that the holder process is gone,
`releaseAbandonedLock({ key, instance, fence })` removes exactly that lock row.
It refuses the calling instance's own locks and changes no records
(`recordsChanged: 0`). It removes only mutual exclusion and never grants resend
permission: the retained lane stage still fences. If a "dead" holder was only
stalled, its later `put` is refused as `journal-fenced`. The seller state's job
locks have the same kind of procedure, described next.

## Seller-state job locks (`seller-state.sqlite`)

The durable seller state (`src/dacs/seller-durable-state.mjs`; on the operator,
`<stateDirectory>/seller-state/seller-state.sqlite`) is a separate store. While
`withJob()` runs one seller step for a job, it holds that job's row in
`seller_locks`. As with the journal, a lock row is never timed out or reclaimed
by age.

Each row's `owner` is
`<pid>:<process>:<acquired ms>:<acquisition>:<namespace>`:

- `<process>` is a random value made once per JavaScript realm. Every copy of
  the module and every store in that realm share it.
- `<acquisition>` is random per acquisition. It is the lock's generation: the
  fence below compares it.
- `<namespace>` is `<PID namespace>.<boot id>.<start time>`:
  - on Linux: the inode of `/proc/self/ns/pid`,
    `/proc/sys/kernel/random/boot_id`, and the process's start time in clock
    ticks (`/proc/self/stat`);
  - without `/proc` (macOS, the BSDs, which have one PID space per kernel):
    `0`, `bt<sec>` from `sysctl -n kern.boottime` (whole seconds), and the process's
    start second from `ps -o lstart=`;
  - left out where the host gives neither. Seller state then writes one
    `seller-state: this host gives no boot and process start identity …` line
    when it opens.

**Liveness comes from a lease, not from the PID.** The first time a process
opens a state directory, it creates a new `holders/<process>.sqlite` there
(mode 0600 whatever the umask) and takes an exclusive SQLite lock on it
(`BEGIN EXCLUSIVE`, which takes a POSIX lock). It holds that lock until the
process exits, and the kernel releases it however the process ends, SIGKILL
included. A row is live while its holder's lease is held.

A free lease proves an exit only on the kernel that kept the lock. So a row is
reclaimed only when it names this boot (the same boot id). A PID names a process
only in its own PID namespace on its own boot. So a row's PID is consulted only
when the row names this process's namespace and boot, and then only to keep the
row busy, while that PID still runs a process with the recorded start time
(`/proc/<pid>/stat` on Linux; elsewhere `ps`, for a PID that `kill(pid, 0)`
finds). `kill(pid, 0)` alone decides nothing. A reused PID can't keep a dead holder's row
busy, and a PID that is missing here can't make a live holder's row look dead.
A reused PID is, for example, a restarted container's PID 1, or the same low
PID under `init: true`. A missing PID can belong to a holder in another
container.

Rows written before this format are `<pid>:<uuid>`. They name no lease and no
namespace, and nothing here can prove their holder gone, so they are never
reclaimed.

| Existing row | `inspectLocks()` `reason` | `withJob()` |
| --- | --- | --- |
| Names a process on this boot whose lease can be taken, and whose PID here does not still run it | `exited` | Reclaimed in the same transaction. Logs `seller-state: reclaimed the lock on job <job> left by a process that has exited` |
| Names this process (another store, another copy of the module, or a re-entry) | `this-process` | `seller_state_busy` |
| Names a process whose lease is held, in this or another container, from any boot id | `live` | `seller_state_busy` |
| Names a process in this PID namespace on this boot whose PID still runs it (same start time), whatever its lease shows | `live` | `seller_state_busy` |
| Names a process on another boot (or another kernel), whose lease is not held | `other-boot` | `seller_state_busy`, and a notice (below). Fails closed: nothing proves the holder gone |
| Names a process but no boot (its writer had no identity), or this process has none | `no-identity` | `seller_state_busy`, and a notice |
| Names a process on this boot whose lease cannot be checked: the file is missing, is not a private regular file owned by this user, is unreadable, or any error | `lease-unproven` | `seller_state_busy`, and a notice |
| Names no process (the earlier format, `<pid>:<uuid>`), whatever its PID | `legacy-format` | `seller_state_busy`, and a notice, until the explicit release below |
| Any other owner value, or an owner whose PID differs from the `pid` column | `unrecognised` | `seller_state_busy`, and a notice |

**A held job is never silent.** When `withJob()` answers `seller_state_busy`
on a row that nothing proves alive (every reason above except `this-process`
and `live`), it writes
`seller-state: job <job> stays busy: its lock row (<reason>) names no holder this process can prove exited; see inspectLocks() and releaseAbandonedLock()`
to stderr. It writes it once per row (job and owner) per process every 10
minutes, however many requests meet it. An ordinary busy answer, against a
live holder, writes nothing. This line is the signal to follow "A row nothing
can prove abandoned" below.

Seller state refuses to open off the main thread
(`seller_state_main_thread_required`). A worker thread would be another realm in
the same process.

**The state directory must be on a local filesystem, used by one kernel.**
Containers on one host that share the directory through a bind mount or a local
volume see each other's leases, because POSIX locks are kept by the host kernel
across PID namespaces. Rows from another kernel (a VM or sandbox kernel sharing
the directory, or the host before a reboot) carry another boot id and stay busy.
Network filesystems (NFS, SMB) and anything else that doesn't honour POSIX locks
are out of scope.

**Automatic reclaim needs a boot and start identity:** Linux `/proc`, or
elsewhere `sysctl kern.boottime` and `ps`. Without either, seller state warns
once when it opens, and every row left by a killed process waits for the
operator's release below. Without `/proc`:

- the start time has whole-second resolution. A PID reused within the same
  second as its earlier process keeps that row busy (fails closed);
- macOS can move `kern.boottime` when the wall clock is stepped. Only whole
  seconds are used, but rows taken before a step of a second or more then read
  `other-boot` and wait for the release, where the lease check still refuses a
  live holder;
- this path ran here only on Linux, with `/proc` hidden and `kern.boottime`
  answered from `/proc/stat` (see Evidence). It has not been run on a real Mac
  or BSD.

A process never opens a lease file that already exists. Reaching the same
directory by a second path (a second mount, say) would mean opening its own
lease file again, and closing that descriptor would drop its POSIX lock. That
open fails `seller_state_lease_unavailable` instead.

`holders/` gains one empty file per process that opens the directory. Each
opening prunes it. Under the database's write lock, so that no row can name a
file meanwhile, it removes every `<uuid>.sqlite` lease file that meets all of
these:

- no row names its process;
- it is a private regular file;
- it was last modified at least a minute before the opening process started, so
  it is none of that process's own and none still being created (a process
  takes its lease in one synchronous step after creating the file);
- its lock can be taken now.

The file is removed while the pruner holds that lock. A process stalled between
creating its lease file and locking it (stopped for over a minute, say) then
fails to open with `seller_state_lease_unavailable`, rather than holding a lease
no one else can see. After locking, it checks that the file at its path is the
one it created. The creating descriptor stays open for the life of the process,
so the inode can't be reused meanwhile, and since that descriptor is never
closed, it never drops the lock. Pruning is skipped while the database is busy.
Lease files that rows still name stay, so prune by hand only if you must. Don't
remove a lease file while a row names its process: that row would then stay
busy, and on this boot could no longer be released, because its lease can't be
checked. Back up `holders/` together with `seller-state.sqlite`.

**Upgrading from the earlier version.** That version reads rows of this format
by PID alone. It reclaims a row whose PID it can't see, including a live holder
of this version in another PID namespace (another container). So stop every
process of the earlier version, in every container that opens the directory,
before starting this version. Don't run the two versions side by side. If one
still does, the holder of this version that lost its row is fenced, as below.

### Fencing every job-scoped write and effect

Each job-scoped write checks two things inside its own write transaction:

- it runs inside the store's acquisition of that job (an `AsyncLocalStorage`
  scope set by `withJob()`);
- the job's row still carries that acquisition's owner (its generation).

Otherwise it fails `seller_state_fenced`. These writes are checked:

- `saveSession`;
- `signOnce`: its intent, so before the signer is called, and its completion
  record;
- `anchor`: its intent, again just before `anchors.write` with nothing awaited
  in between, and its completion record;
- `reconcileAnchor` and `readAnchor` inside an acquisition: before the read and
  in the record update;
- `bindSettlement`;
- `reserveSignatureCommitment` and `releaseSignatureCommitment`.

A call from outside any acquisition is fenced the same way, and so is a
straggler from one that has ended, even while its store holds the job again. The
only exception is readback outside any acquisition (`reconcileJob`,
`reconcileAnchor` and `readAnchor`, as the lock-free `reconcile` seam uses
them). As before, it only records an authenticated readback of a retained anchor
intent.

Seller effects that leave through another journal are checked with
`assertHeld(jobId)`, the same fence as a call, with nothing awaited between the
check and the effect:

- the native commitment and delivery-evidence CREATEs pass it to the native
  publisher as `authorize`. The publisher calls it under its address lock,
  before it stores its CREATE intent, so a refused holder stores no intent and
  sends nothing;
- the native Deliverable submission and the native payment-evidence anchoring
  call it just before they start.

When the check before the native Deliverable submission fails, it throws
before anything is sent. It deliberately does not answer the SDK `rejected`,
for this reason:

- the SDK's durable delivery WAL records any definite answer as the delivery's
  outcome, and would replay it to the next holder, ending the job;
- a throw is indeterminate, and the WAL keeps it at its intent;
- the stale holder's own session write is fenced too, so it retains no
  `delivery-submission-ambiguous` hold;
- the next request reads back authoritative absence and submits once.

A completion that fails its fence records nothing. The effect's retained intent
then leaves its outcome to the next holder's readback, as after a crash. The
fence doesn't cover the SDK's own stores (the agreement session store, receipt
permits, fulfilment records), nor the wallet and artifact journals once an
effect has passed its check. Each of those keeps its own permit, lane or
generation fence and its own retained intent.

With this code, neither the reclaim nor the release removes a live holder's
row. One window remains, and only if something else removes the row while its
holder is in a step: a raw `DELETE` (see below), a hand edit, or the earlier
version's code reclaiming across PID namespaces. The effect already past its
last check can then complete once:

- a signature between its intent and the signer call;
- an anchor write after its last check;
- a native CREATE or delivery after its check.

Its holder records no completion, and is fenced at its next check. The retained
intent makes the next holder read the effect back instead of repeating it.

### Abandoned seller-state locks (explicit operator action)

`inspectLocks()` lists `{ job, owner, pid, process, acquiredAt, boot,
pidNamespace, holderExited, reason, thisProcess, thisInstance }`:

- `reason` is why the row is or isn't reclaimable: `exited`, `this-process`,
  `live`, `other-boot`, `no-identity`, `lease-unproven`, `legacy-format` or
  `unrecognised`, as in the table above.
- `holderExited` is `true` when the row's holder is shown to have exited
  (`reason: 'exited'`). It is `false` when the holder is alive or nothing proves
  it gone, and `null` for rows that name no process.
- `boot` is `'this'` or `'other'` (the row's boot id against this process's).
  It is `null` when either side has no identity, and for rows that name no
  process.
- `pidNamespace` is `'this'` or `'other'` for a row of this boot (another PID
  namespace is another container on this host). It is `null` for a row of
  another boot, so a row from before a reboot no longer looks like a live
  holder in another container.
- `process` and `acquiredAt` are `null` for rows that name no process.
- `acquiredAt` is the holder's wall-clock time, shown for information only;
  nothing depends on it.

`releaseAbandonedLock({ job, owner })` removes exactly that row and returns
`{ released: true, recordsChanged: 0 }`. The owner value is unique to one
acquisition, so it is also the fence.

| `reason` | Release |
| --- | --- |
| `exited` | Released: its holder has exited |
| `this-process`, `live` | Refused, `seller_state_lock_live`. The kernel's lease and, in this PID namespace, the start time decide this, so the refusal holds for a separate script, another container and another PID namespace alike. A held lease counts whatever boot the row names |
| `lease-unproven` | Refused, `seller_state_lock_unproven`: a holder on this boot whose lease file is gone may still run. Use the offline procedure below |
| `other-boot`, `no-identity`, `legacy-format`, `unrecognised` | Released on the operator's word, because nothing here can check the holder. Use the procedure below first |

Anything that does not name an exact row is refused
(`seller_state_lock_mismatch`, `seller_state_lock_invalid`).

Like the journal's, these are library calls on an opened store, with no CLI or
route. Opening, inspecting and releasing sign nothing, so a signer stub that
refuses to sign is enough:

```js
import { createSellerDurableState } from './src/dacs/seller-durable-state.mjs';
const signer = { claim, sign: () => { throw new Error('inspection signs nothing'); } };
const state = await createSellerDurableState({ dir: '<stateDirectory>/seller-state', signer, listingPin });
state.inspectLocks(); // then, for one abandoned row:
state.releaseAbandonedLock({ job, owner });
state.close();
```

Opening the store needs the seller's claim and Listing pin, because it checks
the retained context against them. Run it as the user that owns the directory,
since the store checks the directory's owner, and on a host that mounts the
same local directory.

**When a row is abandoned.** A row is abandoned once the process that took it
has exited. A row naming a process on this boot is then reclaimed by the next
`withJob()` for that job, so it needs no release. The release is for:

- a row from before a reboot (`other-boot`), or from a process with no identity
  (`no-identity`);
- a row in the earlier format (`legacy-format`), after every process of the
  earlier version has stopped;
- tidying a row whose `holderExited` is `true` without running its job.

**Checking that no process still holds it.**

- A row naming a process: `holderExited: true` means its holder has exited.
  `false` means it is alive or nothing proves it gone: don't release it while
  any process may still use the directory.
- A row in the earlier format was written by the earlier version, and it is
  abandoned once no process of that version still opens this state directory.
  Count every such process, not only the plugin: a tool you started on the
  directory (for example `devnet-demo-purchase.mjs`) or a `docker compose run`
  one-off also counts.
- A `ps -o pid=,lstart=,args= -p <pid>` check only means something inside the
  holder's PID namespace. `docker exec` into the same container works; a
  `docker compose run` one-off has its own namespace, and its PIDs mean nothing
  elsewhere.
- If you can't establish this, first stop every process that opens this state
  directory. With none running, no row has a live holder.

**A row nothing can prove abandoned (the redrive).** A seller killed inside a
step (for example when the stop grace runs out during an approval wait) and then
rebooted leaves its job busy for good: the row names the old boot. Its seller
requests answer the retryable `seller_state_busy`, and the seller writes the
notice line above. To redrive the job:

1. Run `inspectLocks()` as above and find the row for the job named in the
   notice. Its `reason` says what to do.
2. `other-boot`: every process of an earlier boot of this host is gone. Make
   sure no other host or VM kernel opens this directory; that is unsupported
   anyway. Then `releaseAbandonedLock({ job, owner })`. Sellers can keep
   running. If the row's lease is held after all, the call refuses
   `seller_state_lock_live`.
3. `no-identity` or `legacy-format`: the holder may be a live process that
   nothing here can check, such as an earlier-version process in another
   container. Stop every process of that kind first (see the checks above),
   then `releaseAbandonedLock({ job, owner })`.
4. `lease-unproven`: a row of this boot whose lease file is missing or damaged,
   for example after a restore without `holders/`. The library refuses it,
   because its holder may still run. Stop every process that opens the
   directory, in every container. Then run
   `DELETE FROM seller_locks WHERE job=? AND owner=?` for that exact row, with
   the `sqlite3` CLI or `node:sqlite`. Like the release, this changes no
   records.
5. Retry the job (the buyer's retry, or the job's `resume`). It resumes from its
   retained session as below.

**What the restarted job does next.** A release, like the automatic reclaim,
changes only `seller_locks`: retained sessions, effects and settlements are
untouched. The next `withJob()` for the job starts from the retained session.
The intent journal is the authority on what was started:

- An effect whose intent is retained is never repeated:
  - a signing intent with no retained signature answers
    `seller_signature_reconciliation_required`;
  - a retained anchor intent is only read back, and held until it reads back
    present;
  - a seller transport request whose answer was lost, including a retried
    bundle request, is answered only through `reconcileTransport`;
  - the wallet and artifact journals' lane records keep fencing.
- An effect with no retained intent was never attempted. The job's `resume`
  attempts it once, as it does after any restart. This change doesn't alter
  that.

So nothing is signed, sent or broadcast a second time because a lock was
reclaimed or released. A live old holder can no longer race the new one.

**Rolling back.** The earlier version ignores `holders/` and reads rows of this
format by PID alone: a live PID is busy, and a gone PID is reclaimed. A row left
by a killed process whose PID is reused therefore stays busy under the earlier
version, as in the original problem, and that version has no release call. The
fallback is the offline `DELETE` above. Stop every process first, because the
earlier version would also reclaim a live holder's row whose PID it can't see.

Evidence:

- `test/seller-durable-state-locks.test.mjs`, with the TEST child
  `test/helpers/seller-durable-state-lock-holder.mjs`. It covers:
  - a live child process, busy for this process and for a second module copy,
    then reclaimed after SIGKILL;
  - exited, uncheckable, other-boot and namespace-less holders, each with its
    `reason`, its release answer, and the busy notice, once per row and
    interval;
  - a live holder recorded under another boot id, refused as live;
  - the PID check within this namespace (same and later start time);
  - a host without `/proc`, modelled on Linux by TEST children that preload
    `test/helpers/seller-state-no-procfs.mjs`: `/proc` is hidden and
    `kern.boottime` is answered from `/proc/stat`. It covers live, reused-PID
    and SIGKILLed holders, and a host with no identity at all;
  - pruning `holders/`, including a lease file removed before its process
    locked it (`test/helpers/seller-state-lease-race.mjs`);
  - a live holder running main's code whose PID is not visible here, as from a
    sibling PID namespace;
  - the worker-thread refusal, an owner-write-masking umask and a second path
    to the lease;
  - each fenced write with no signer or anchor call;
  - a holder that loses its row while its signer runs, after its anchor write,
    or just before the write;
  - the seller agent's check before a native CREATE;
  - the v1 baseline's store (`test/fixtures/seller-durable-state.v1-baseline.mjs`)
    writing the earlier format.
- `test/seller-native-delivery-lock-fence.test.mjs`: a holder whose row is
  removed just before the native Deliverable submission submits and retains
  nothing, and the next request delivers once.
- `test/dacs-seller-recovery.test.mjs` crash windows. A real seller process
  exits before the commitment, payment-evidence or bundle signature, or before
  the commitment, payment-evidence or seller-copy anchor. Resuming after a
  removed intent makes each effect once in total. Resuming with the intent kept
  holds, with no new effect.

All of this is SIMULATED offline: it shows the lock and recovery rules, not a
live container restart or reboot. The sibling PID namespace is modelled by a PID
that names no process here, not by a second namespace. The host without `/proc`
is modelled on Linux, not run on macOS.

## Consumer compatibility inspected

- `public/portal/embedded-wallet/sdk-provider.mjs` anchor lane: lock(lane) → get →
  put `broadcast-started` → exact readback → broadcast → put
  `broadcast-accepted`, all inside the same lane lock.
- `src/dacs/demos-sr2-wallet-bridge.mjs`: wallet journal is prefixed
  `sr2/wallet/`. Adapter locks map to the same lane key, but they are acquired
  before and after `wallet.request`, never nested with the same key.
- `src/portal/offline-agreement-broker.mjs`: record-key locks around
  claim/complete/request and lane-key locks around `journal/put`. Writes happen
  inside the lock that owns the key.
- `src/dacs/protocol-purchases.mjs`: `plugin/agreement/<id>` lock wrapping
  bridge work that takes lane locks (distinct nested keys).

None of these consumer entry points re-enters the same key; same-key callers
come from different async contexts and serialize. Unsupported: same-key
reentrancy within one async context, and writing a key from outside a lock while
another context holds that key (the in-memory journals permit the latter; this
journal refuses it). It has no automatic process recovery. No public profile is
wired.

## Operator storage assumptions and limits

- SQLite WAL with `synchronous = FULL` on a local filesystem that honours
  `fsync`. Network filesystems (NFS/SMB) and storage that lies about flushes are
  unsupported, because WAL locking and durability depend on them.
- All processes must open the same path on the same host. Backups must copy
  the database together with its `-wal`/`-shm` files while no holder runs,
  otherwise a restore may roll back an issued lane.
- Process-kill tests (SIGKILL after a committed record) show crash-after-record
  behaviour only. **Power loss, kernel crash and hardware durability are not
  established by these tests.**
- Integrity digests detect accidental or out-of-band edits to rows and totals.
  They are not authenticated against an attacker who can recompute them, and
  this is not a security verdict.
- Rolling the whole file back to an older copy (with a matching journal id) is
  not detected.

## Evidence

`test/durable-wallet-journal.test.mjs` with
`test/helpers/durable-wallet-journal-child.mjs` (independent Node child
processes over IPC, bounded SIGKILL cleanup) and
`test/helpers/durable-wallet-journal-sr2-fixture.mjs` (loopback native-readback
fixture copied from the SR-2 wallet test). Wallet cases use the unchanged
packaged wallet session. Bridge cases run the unchanged
`createDemosSr2WalletBridge` anchor → wallet → relay → native readback flow
against the test-owned loopback SDK-wire fixture.

`test/helpers/durable-wallet-journal-broker.mjs` and
`test/helpers/durable-wallet-journal-browser.mjs` pass this journal as the
existing harness's opt-in `browserAgreement.journal`. The tests then drive the
actual flow:

- OAuth MCP `prepare_purchase` and `verify_deal`.
- The portal agreement routes. The sign route runs protocol-purchases'
  `plugin/agreement/<id>` lock around the bridge lane lock and the broker
  record lock.
- The broker challenge, session, claim, `journal/get`, `journal/put` and
  complete routes.

Cases covered:

- An accepting CREATE.
- Explicit denial.
- An unknown applied outcome, checked through a reopened journal.
- Concurrent same-key `verify_deal` calls, which serialize.
- Another process holding `plugin/agreement/<id>`. The sign route gets a
  bounded `journal-busy` and no fence is created. After release it proceeds.
- One real-Chrome trusted-click accepting flow, using the existing Playwright
  fixture launch and the `DACS_TEST_CHROME` executable. A synthetic click does
  not approve.

All of this is SIMULATED offline evidence, with no live chain, finality,
Listing or Vet.
