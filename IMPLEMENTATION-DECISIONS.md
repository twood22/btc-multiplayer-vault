# V3 implementation decisions

Authority: active user goal, 2026-09-13. Decisions here document execution of
that goal; they do not authorize mainnet transfers, new spending commitments,
public service exposure, or changes to existing custody.

## D01 — Version-dispatched implementation, immutable legacy state

Extend the existing presigned modules to explicitly dispatch V2 and V3 rather
than fork an entire web application. Keep V2 default fixtures, serialization,
digest domains, derivation and recovery behavior byte-compatible. New production
invitations explicitly select V3. Unknown versions and mixed-version objects
reject. Historical signed/funded vaults and kits are never relabeled or migrated.

Rationale: retain the tested operational paths while making the changed spending
authority a new, independently committed protocol. Compatibility tests are
required; old release evidence does not prove V3 acceptance.

## D02 — Separate setup refund approvals and runtime triggers

Keep twelve solo preauthorizations and add a separate collection of nine V3
recovery authorizations. Every kit contains both complete collections and four
fixed recovery templates. Distinct round-scoped authorization/trigger key roles
prevent setup signatures from becoming trigger signatures. Recovery pays the
same committed individual payout-key scripts as ordinary withdrawals.

The initial trigger quorum is two of three; a pair uses one of two. The quorum
can force equal settlement after the coin-specific delay, but cannot redirect
another current member's fixed refund. A completed normal solo game alone has
the largest-last payout guarantee. No key-deletion assumption is introduced.

## D03 — Agent-executable release and evidence boundaries

Use local isolated Core and database/browser checks, then actual default-Signet
and exact-source/image release acceptance. Coordinate CPU-heavy builds to avoid
replacing generated files while another test reads them. Independent agent review
is AI review, not a professional audit. Physical-device/friend participation and
external human review are documented launch limitations, not prerequisites for
the user's autonomous engineering goal. Mainnet funding is not authorized.

Deploy only into an existing explicitly authorized environment. Otherwise
produce and verify the complete production deployment/rollback package and say
it is not deployed. Do not infer a hosting authorization from access credentials.

## D04 — Work ownership and progress

Protocol core, runtime/fee integration, and server/database integration are
bounded delegated tasks. The primary agent owns ceremony/backup/client/offline
integration, acceptance/release assembly, independent verification and the final
requirement-by-requirement audit. Use V3-ACCEPTANCE-CHECKLIST.md as the single
concise completion checklist. Preserve pre-existing worktree changes throughout.

## D05 — Preserve the enrolled base identity; separate new signing roles

V3 retains the existing participant-secret personal/payout derivation used by
passkey enrollment, which happens before vault round-key publication. V3 solo,
recovery-authorization and recovery-trigger keys are explicitly domain-separated
by V3, vault and round. Cooperative signing remains bound to the actual tweaked
tree/transaction and session. No legacy derivation or enrolled identity changes.

Rationale: keep the base custody identity stable while changing every new
protocol-specific role and output commitment. This avoids an unnecessary change
to shared V1/V2 enrollment without weakening the new two-layer recovery rule.

## D06 — New protocol needs new mainnet authorization

Do not interpret a historical `PRESIGNED_V2_MAINNET_AUTHORIZATION` flag as consent
to use V3. V3 requires its own explicit `PRESIGNED_V3_MAINNET_AUTHORIZATION` plus
exact V3 release evidence. Signet network configuration can remain shared where
it explicitly identifies the test chain; this does not confer mainnet authority.
## D07 — Release identity and dual-version offline utility

The source-inventory hash keeps its historical namespace: it identifies exact source bytes, not permission to use a protocol. New builds default to an explicit V3 build identity; an explicit V2 build remains available for legacy release verification. Acceptance and release receipts must match the graph's protocol as well as the exact source and artifact digests. A new offline utility manifest explicitly lists V2 and V3 support. V3 clients refuse older V2-only utility manifests, while existing V2 kits remain usable without migration.

## D08 — Cash out owned payouts without changing the vault rules

Review found that the existing payout and final-sweep outputs all remain at the
participant's internally derived payout-key address. Owning a recoverable key is
not a complete user-facing withdrawal workflow. Add a separate browser/offline
cash-out operation for an already individually owned payout/refund coin, to a
Bitcoin address explicitly entered and reviewed by that owner at withdrawal.
This operation must never spend a multi-party vault coin or alter a committed
solo/recovery parent. All input ownership, network, output amount/address and
fees must be independently checked; only the owner's payout key can sign it.
Additional cash-out fees are shown separately from the committed game payouts.

This completes the ordinary meaning of withdrawing usable funds without
introducing mutable recovery destinations or a quorum-spending bypass. It does
not authorize the agent to submit a mainnet transaction during implementation.

## D09 — Use the already authorized public test runner, not weaker host isolation

The local host has no container engine and a rootless user-namespace probe is
refused. Do not alter kernel security, use privileged containers or present a
standalone build as OCI acceptance. The user explicitly authorized pushing
project code to the existing public repository and public no-cost tests on
2026-09-07, following the 2026-09-03 privacy/history-scan condition. Current
read-only inspection confirms the repository is public and has existing
acceptance/evidence workflows. Use that established route after scanning the
new publication surface for secrets and private identity information.

Only standard free public runners and the previously authorized test-artifact
route are in scope: no paid runners, new subscriptions, deployment, public app
listener, registry publication or private custody upload. Preserve actual full
test artifacts through the reviewed evidence packer, not entire temporary
directories. Source changes require fresh source-bound runner results.

## D10 — Remove repeated verification work without relaxing acceptance

Measured V3 ceremony checks rebuilt the same graph 33 times when checking nine
backup receipts. A funding export invoked five such checks, before counting
chain requests, passkey prompts or local owner recovery. The receipt batch now
validates the complete public kit once and checks every proof through a private
shared implementation. The single-receipt API still fully validates its input.
There is no cross-action cache, trusted-input flag or omitted owner/trigger check.
Both protocols and both address formats pass 84 hostile batch controls.

The sequential lifecycle verifier separately caches only already completed,
fully verified public transaction graphs. Every use rereads and hashes the
complete protected public-file manifest and binds the exact run, source and
protocol. Returned objects are independently cloned. Keys, unfinished cases,
current checkpoints, chain observations, confirmations and unspentness are
never cached. Independent AI review found no spending-authority bypass; the
actual complete runner must still pass. Neither optimization turns an earlier
failed browser or lifecycle run into successful evidence.

## D11 — Recover disk capacity only from verified duplicate public chain data

The development disk is nearly full because historical Signet restore drills
retain multiple full public chain caches. A bounded tool may retain one exact
copy of independently hash-matched block/undo files and reclaim only their
duplicate copies in a stopped, unfunded restore drill. The initial profile is
fixed to 290 exact files; two unique tail files are explicitly excluded.

Before any reclaim, preserve a protected per-file hash/metadata manifest and
tested no-overwrite restoration recipe, hold both real Core directory locks,
and independently review the exact manifest digest. Keep all wallets, custody,
original backups, historical evidence, chainstate, indexes and unique bytes.
The keeper must remain retained and unchanged. Restored bytes, permissions and
modification times can match; original inode numbers and change times cannot.
The affected cache must be restored before that old drill node can be used.
Preparation alone does not authorize or claim completed deletion. Do not
expand the exact cleanup profile or alter active/funded custody to gain space.

## D12 — Supervise long local acceptance without changing host protections

Multiple unrelated verification children ended with SIGTERM, including runs of
different ages; no signal source or universal timeout has been established.
Retain the failed runs. Use uniquely named transient user services for bounded
isolated acceptance and read-only cache preparation, with explicit runtime and
working directory, private logs, no restart and no persistent enablement.
Require their actual terminal exit and complete evidence, not merely a running
unit's default success field. This is not a public deployment or a change to
host security policy.

Browser test hardware must represent the user's selected key in a focused,
hydrated page. Wait for the existing real hydration guard, foreground the
participant page, and disable the unselected virtual authenticator before
enabling the chosen one. Record only role/count diagnostics; do not inject
keys, suppress real authentication, extend sessions or relax money checks.
These harness corrections require an observed full passing run.

## D13 — Retain the complete hosted matrix through a separate reviewed route

The standard hosted LOCAL job validates and round-trips its whole 75-command
archive but does not preserve it after runner shutdown. Add a tooling-only,
explicitly selected manual LOCAL operation on the existing authorized free
runner and existing test-only draft. It executes the unchanged immutable
candidate, then permits only the exact 165 successful evidence files through a
bounded archive boundary, source-grounded output schemas and the unchanged
candidate validator. No raw failure logs, custody files, secrets or arbitrary
temporary directories may be uploaded. This is not a replacement test matrix.

Keep the old image-producing tooling/run identities separate. New LOCAL assets
use distinct names, never overwrite existing assets and never publish the
draft. Publication credentials enter only the final upload step, after review;
the candidate and content reviewer run without those credentials. Actual
downloaded originals must then be independently rehashed, strictly restored and
validated locally. Tooling tests and a successful job status alone do not prove
the resulting archive or authorize funds, deployment or a software release.

## D14 — Evaluate a private copy-on-write public cache without reusing custody

A fresh ordinary copy of the retained public Signet cache exceeds remaining
disk capacity. Evaluate a private, user-space copy-on-write view of only its
`blocks`, `chainstate` and `indexes` directories. Keep original bytes unchanged
and hold the original Core directory's actual exclusive lock for the entire
mounted lifetime. All new wallets, backups, controls, cookies, journals and
locks must remain new ordinary private directories outside that view. This
does not expand D11's deletion scope, adopt an old V2 wallet or change the
candidate, host security policy or release validators.

The pinned official fuse-overlayfs 1.18 executable is private, not installed
system-wide. A tiny synthetic fixture passed twelve filesystem operations,
thirteen competing-lock refusals, persisted copy-on-write remount, forced
filesystem-process death refusal, unchanged original-file inventory and normal
unmount. The first probe's filesystem-type assertion failed; its separate
evidence is retained. The corrected probe records the actual binary-derived
filesystem type. Neither probe touched the existing cache or custody or proves
that Bitcoin Core will work on the new view.

Before any real use, require independent review and extended synthetic tests,
including actual isolated Core database persistence, exact mount/process and
lock-loss refusal, parent-death cleanup and original metadata/xattr preservation.
Operational activation remains explicitly unset. Controlled shutdown must stop
the owned Core process, unmount its private views, then release the keeper lock.
Abrupt lock-owner death releases a kernel lock immediately; do not claim that
ordering is guaranteed for such a fault. Refuse continued operation and clean
up owned processes. Monitor actual new allocation and remaining free capacity;
copy-on-write is not a guarantee against disk exhaustion.

Any eventual mounted host depends on both the retained original cache and its
private changed-file directories. It is not an independent cache copy, proof of
the stock host launcher or proof of the stock whole-host restoration drill.
The normal fresh native wallet, independent backup restoration, default-Signet
identity and full source-bound lifecycle gates remain mandatory.

The corrected fixture suite subsequently passed independently twice, including
actual isolated Core chainstate/transaction-index persistence and fault cleanup.
Keep real activation hard-disabled until durable SAME-host control and physical
upper/lower bindings support a reviewed restart; passing synthetic tests alone
does not justify funding a host that cannot safely resume. Kernel mount IDs can
be recycled, so checking an ID alone is insufficient; retain the original live
owned-process identity as part of the mount binding.

The separate durable fixture revision also passed root's unchanged rerun:
two same-host/native-wallet restarts, five actual backup-restoration proofs,
44 refusal controls, monitored control/history mutation and controller-loss
cleanup. Its descriptor and clean checkpoints bind three physical private
stores; interrupted starts refuse restart rather than silently repairing
history. The corrected cleanup check binds the full mount tuple as well as the
live owned process, not a recyclable numeric ID alone. These are isolated
regtest fixtures, not a default-Signet adapter or whole-host loss proof.

For the eventual real cache, require a separately reviewed full-content
fingerprint at admission and clean shutdown. Active guards must use a reviewed
bounded metadata/identity check, not rehash tens of gigabytes before every
operation. The read-only double-inventory audit passed over 28.77 GB and took
600.244 seconds. It held the original POSIX lock but neither mounted nor copied
the cache or read custody. Schedule subsequent CPU-heavy qualification separately
from browser timing investigations on this two-core development host; earlier
overlap is a confound to diagnose, not grounds to widen test deadlines.
The actual Signet adapter remains separately gated and under implementation.

## D15 — One bounded authorization for the complete test-network lifecycle

The autonomous goal authorizes the complete fixed V3 test lifecycle, not a new
routine approval before every transaction. The private experimental runner will
bind one reviewed source/control/host identity, original test-capital outpoint
and capital ceiling, then use the unchanged initializer, funding and advance
engines under continuously held per-call host/backup locks. It may not introduce
new capital, replace an existing run, bypass a durable transaction intent, or
relax the fixed acceptance plan. Between observations it keeps the guarded
Core/cache session alive and releases only the operation locks.

Chosen operational bounds: seven days, at most 4,096 engine calls, a 30-second
chain-tip observation interval and a five-minute retry interval when the tip is
unchanged. These are supervisor limits, not changes to transaction fees, recovery
delays or product deadlines. Unchanged network state is normal. A separately
bound cursor must verify the same immutable run and complete checkpoint ancestry;
rollback, foreign changes or ambiguous signing stop writes without reinitializing.
Only actual unchanged engine completion and verification may close the run.
The ordinary final assembler must still execute its own verification. These
choices are being implemented privately; no real activation or successful
default-Signet execution is claimed by this decision.

## D16 — Separate failed supervision from independently verified clean custody

The first actual unfunded bootstrap reached its clean native checkpoint, but
its private parent and controller deadlocked over who closes the input pipe.
Root independently verified the stopped Core, absent mounts, native receiving
backup and three matching clean records before using the parent's normal stop
handler. The parent then exited 1; the unchanged controller exited 0. Preserve
that failed attempt and never issue a replacement success receipt for it.

For this newly created, unfunded test host only, a separate read-only verification
may establish eligibility for a later reviewed same-host resume. It must bind
the original failure and actual child terminal, recheck exact source/binaries,
all control/descriptor/clean-ledger copies, physical wallet/upper identities,
native backup proof, zero actors/mounts and a fresh full lower-cache inventory
under the keeper lock. Interrupted, missing, ambiguous or changed state refuses;
the verification itself authorizes neither resume nor funding.

The new private controller must close its own input only after the awaited
guardian has returned successfully from explicit controlled stop and all native
cleanup/lock release. Qualify that transport change, then require a separately
pinned, successful unfunded resume/synchronization/shutdown before any lifecycle
funding approval. Keep the original data roots and all failed evidence. This
does not adopt legacy funded vaults, waive a failed release test, change product
source, or replace actual default-Signet acceptance with a cleanup report.

Apply those same checks to any later failed supervisor of this same still-
unfunded host: retain each actual failure, native terminal and prior clean
ancestry. A synchronized observation is historical, not a claim that a stopped
node is currently synchronized. An exact parent-owned compiler service must be
cleaned up or separately reported; never hide it with a generic process-name
exception or claim zero actors before they have actually terminated.

## D17 — Bounded public test-coin acquisition, not vault custody changes

Use only the existing independently restored Signet receiving wallet for new
test-coin receipts. A public PoW faucet may be considered as a no-purchase
alternative, using its published public claim scalar, not participant keys.
Keep native chain/receiver validation, pure transaction construction, bounded
computation, relay and actual confirmation as separate checks. No fabricated
wallet RPC results, challenge bypass, rate-limit evasion or automatic resubmission
is permitted. Public UTXOs are competitive opportunities, not received funds.

The reviewed constructor supports one confirmed, non-coinbase10000-sat current
faucet output, one fixed native P2TR recipient and the exact185-sat fee. This fee
belongs to test-coin acquisition only and changes no vault economics. Any worker
approval binds the entire fresh job, exact source/binary identities, at most
1800seconds including cleanup, one attempt and no relay authority. A separately
reviewed relay must revalidate the unspent input and exact resulting transaction;
transport acknowledgement never substitutes for native confirmed balance.

Qualification is complete, but no real job, worker approval, mining or relay
has been performed as of2026-09-16 18:00 UTC. The native wallet remains40555
confirmed sats against the89000-sat seed target. Do not reduce the required
19-case Signet acceptance or unlock mainnet readiness to fit that shortfall.

2026-09-16 18:21 UTC bounded extension: the separately retained public
constructor now qualifies difficulties16–33; only its two range bounds changed.
All18 official construction comparisons and six suites passed. Difficulty32–33
uses the exact184-sat fee/9816-sat output; the vault economics are unchanged.
The isolated four-thread OpenSSL work helper passed72 target checks, eight
independent Node hash checks,14 malformed/range refusals and six runner suites
with47 refusals, synthetic success, timeout and interruption cleanup. Its root
review is not an independent agent or professional audit. Agent delegation is
currently unavailable because the thread limit was reached.

A fresh native default-Signet/receiver/restoration/input check at18:21:13
approved one real difficulty32 job, SHA
`c3504ea6c08182d309658443956367adaca831ca17dceea901da1c754049ff9a`.
It started18:21:27 in transient unit `btc-public-pow-fast-yqzt8GhQ`, with
1800seconds total work/cleanup approval,31-minute outer limit, four threads,
nice10 and no relay authority. The exclusive job, intent and results are private
in `live-run/powcoins-fast-qualified.yqzt8GhQ`. No persistent service, new wallet,
public listener or purchase was created. One nonce-space search may fail even
with enough runtime. Treat competing spends, timeouts and exhausted work as
failures, not permission to retry or credit funds. Fresh native observation at
18:23:00 still showed40555 confirmed/0pending; work is not received capital.

18:47 UTC outcome: work completed actual0 in773.047seconds; independent work,
signature, opcode-model and native transaction/input/receiver checks passed.
The initial relay failed before any transaction write. Handshake-only probes
identified an empty experimental `sendtemplate` announcement; the narrowly
revised relay tolerates it once before verack without requesting templates.
All58 synthetic controls and an actual no-inventory handshake passed. Only
after confirming no prior send and fresh native checks did root authorize a
separate one-write operational relay. It exited0 with transport acknowledgement.
Native reconciliation then proved a different transaction spent the public
input in block322373. Our claim received zero sats; the wallet is unchanged.
This claim is permanently closed for further relay. Preserve all original
failed/successful tool evidence; no work receipt or pong becomes funding proof.
The qualified tooling may support a separately bound fresh public output, not
a replay of this closed acquisition or a change to the89000-sat seed plan.

18:53 UTC fresh-output decision: a separate native-verified public output
supports one new difficulty32 job in `powcoins-next-work.xbbve3Ai`, SHA
`a2759cd5816e50c219870661893db97eb7a31571b0301a4d1985c9b2e187d23b`.
Only the worker's capsule/dependency paths changed; the constructor, executable
and library stay pinned. Six runner suites/47 refusals and cleanup checks passed
again. The closed previous input is explicitly prohibited. The new attempt uses
the same1800-second maximum, four threads, nice10, exact184-sat fee and no relay
authority. The already qualified corrected relay is staged inactive, so a valid
result can be checked and submitted without repeating protocol development.
Native18:58:47 still shows40555 confirmed/0pending and the new input unspent.
The previous confirmed competitor also used difficulty32, with a37-sat fee;
this does not establish an admission/rejection cause or justify changing the
current approved transaction. Acquisition remains uncertain, not funding proof.

19:19 UTC confirmed outcome: the separate job completed actual worker0 in
1259.718seconds. Independent work/signature/script/native checks passed; the
corrected relay submitted the exact claim once at19:14:18 and exited0. Native
Core and wallet then confirmed its exact9816-sat output, unspent in block322377,
with receiving ownership and recovery intact. Actual confirmed capital is now
50371 sats, zero pending; a separate native check found three spendable outputs.
This is received test capital, not a transport inference. The prior losing
claim remains closed and unchanged. No claim may be relayed again.

Continue through fresh, separately bound public outputs using the proven
constructor, worker and relay. A third prepared capsule limits its chosen work
to difficulty32 or easier, inside the qualified16–33 range, to avoid the lower
chance of a result within one nonce space at33. This changes acquisition
strategy only, not vault economics, capital requirements or verification.
At19:25 the next native-observed candidate was difficulty35 at tip322379 and
would first enter the chosen range at322382 if still unspent. No job/approval
exists before fresh eligibility. Additional confirmed receipts remain necessary;
transfer fee/change and full seed sufficiency will be validated natively before
any V3 seed transfer.

At19:46 native tip322383 showed the waiting322335 output already spent before
any third job was selected. Waiting exclusively for difficulty32 therefore
missed that candidate; this does not establish the competing transaction's
strategy or our hypothetical success. Allow the already-qualified upper
difficulty33 again to enter the next candidate one block earlier. Exact reverse
comparison proved that only the selector threshold/height and approval's chosen
upper bound changed; constructor, grinder, runner and retained controls did not.
This accepts a lower bounded-search success probability in exchange for earlier
access to competitive inputs. The1800-second limit, exclusive intent, fresh
native bindings, fee policy and separate relay authorization remain unchanged.

## D18 — Cover both native seed-source keys before transfer activation

The current isolated test wallet holds a completed historical P2WPKH return and
P2TR faucet receipts. Its original receiver-only proof does not by itself prove
restoration of the return key. Create a separate private native backup and actual
network-disabled restore covering both exact scripts, without changing the old
control, custody records, participant keys or lifecycle. The only signatures in
this preparation spend synthetic impossible parents and cannot transfer funds.

Actual execution on2026-09-16 at19:42 UTC passed with both native signatures and
clean restore shutdown. Root separately reverified signatures, current ownership,
the original receiving proof, the unspent return and zero matching live restore
processes. Result SHA`8f044148686a418356efb5b54b4b3df03f5a3926c0cb1e602c70e7f128ad1623`;
root review SHA`fe7680da0b1733eb2b40b88e04ea3b8daf779f886d9a781562079a58694fe055`.
This is root AI review, not professional audit or transfer authorization.

Use the unchanged0.3sat/vB seed-transport policy and exact actual-input sizing
when capital is ready. A size-only projection for one P2WPKH plus six P2TR inputs
is512 maximum vbytes/154 sats fee. With four hypothetical additional9,815-sat
receipts, the89,000-sat seed leaves477 sats change, above the330-sat minimum.
Do not count future receipts, use the projection as a signed intent or skip any
source/image/custody/fee/paired-node gate. All seed-transfer pins remain unset.

## D19 — Compute public faucet work early; never project native maturity

The third work attempt lost its input to a confirmed competing spend while
computation was still running. Root reconciled the native block, stopped only
the exact worker through its normal handler and verified actual exit1, reaped
child and zero remaining actors. No relay or funds receipt occurred. The
competitor used sequence46; neither its hardware nor how early it computed is
established. An installed OpenCL query found zero platforms; no host changes.

Prepare one fixed difficulty33 public-faucet calculation12–32 blocks before
its selected relay height. Keep the unchanged qualified constructor, grinder,
one-attempt worker,184-sat acquisition fee and1800-second bound. The numerical
height passed to the PURE constructor is explicitly labeled a projection, not
a native chain observation. Save the actual observed height and block hash in
a separate native-verified record and bind both records to the exact job. No
synthetic block hash is created or accepted as actual evidence.

The separate native gate must later prove BOTH original funding/observation
anchors still active, actual input still unspent, at least47 real confirmations,
current receiver ownership/recovery, exact work/signature/transaction and fee.
Before that age it returns `readyForRelay:false` and writes no relay proof.
The exact relay preparation additionally requires actual native maturity=true;
projected heights, pure checks and a solved header can never authorize relay.
Competitive loss remains possible; this decision does not promise receipt.

Pure scheduling passed85 checks/34 refusals; separate approval/construction
checks passed91 checks/73 refusals and matched the Node policy. The original
constructor still rejects treating the earlier actual height as mature. All
six unchanged worker suites/47 refusals passed. These are not native maturity
or vault acceptance proofs. Source61d3 and every release requirement remain
unchanged. Root review is AI engineering work, not professional audit.

Actual first early attempt: native20:21:57 observed height322390, verified an
unspent public input funded322363 and projected relay eligibility322409. Job
`18b3639c59b409b63a3d229a82f59d6f59f5a5b7695f2ec72dda7de1950460de`
timed out after1792.056889 seconds without a solution. The direct child was
terminated/reaped, no KILL or relay occurred, and root verified zero actors.
Native20:49 still showed unspent input at322396/34 confirmations, readiness=false
and wallet50371confirmed/0pending. No future receipt is counted.

The fifth attempt was selected at actual tip322396, funded322362, projected
eligibility322408. Its fixed difficulty33/CSV47/184-sat fee remains unchanged.
It prefers earliest eligibility within the existing12–32-block lead window;
four already-used inputs are excluded. Selection is not a reservation.

## D20 — Retain native worker terminal state independently of chat monitoring

The fourth command monitor ended143 while the worker was still active. The
worker later recorded its bounded timeout and reaped child; the native journal
recorded main exit120. A second readonly monitor failed when the transient unit
was collected. Neither monitor exit is the worker result; no success is inferred.
The exact journal invocation established the failed terminal status.

For subsequent public-computation workers, use a unique transient native service
with journal output, RemainAfterExit=yes, no restarts, the same1800-second worker
and1860-second outer bound. Read exact invocation, actual process status and
persisted work record before stopping the retained unit; independently verify
zero actors. An actual harmless true-process control verified retained exited
state, native status0, explicit cleanup and zero actors. This is supervision,
not a change to the constructor, work target, relay policy or release checks.

## D21 — Keep the complete test run independent of chat-owned stdin

Prepare a private, initially disabled file-command supervisor around the existing
qualified native guardian and lifecycle engine. The same recovered node and
mounts must remain alive through exact seed transfer, native confirmation,
complete follow, both final assemblers and clean stop. No new network listener.
Use only hash-chained status/follow/verify/stop commands, at most128, immutable
intent/returned records, a bounded lifetime and cooperative follow interruption.
The root issuer verifies live process/start time and pinned runtime/code, stages
complete bytes outside the polled directory, and publishes once under an exclusive
issuer lock. Interrupted issuance remains explicit, never automatically replayed.

Six underlying modules remain byte-identical to the successful qualified resume.
The new transport passed15 synthetic API cases/28refusals and five real local
publisher-process cases, including stop, conflicts, tampering and deadline paths.
Actual native full-run integration is NOT yet executed. Every real activation
gate is false; final manifest/admission/lifecycle pins remain unset. API return
and supervisor clean close never replace actual source-bound acceptance receipts.
No app source, vault economics, custody rule or release gate changes.

## D22 — Bind funded startup to fresh native custody and an exact seed intent

Keep the new full-run supervisor dormant until its separate admission check
verifies the frozen source and retained local/image evidence, stopped sequence3
custody, all historical failures, full lower content, restored keys and actual
confirmed seed inputs. Bind that proof to the exact unsigned seed transaction,
fee/change and lifecycle approval; refuse proofs aged120seconds or more. Startup
must pin the seed-wrapper code and recheck the same intent before host activation.
Admission does not sign, broadcast or initialize a lifecycle. The existing seed
wrapper must still perform its fresh paired-node and exact-transaction checks.

The admission policy passes117 synthetic checks/115 refusals; the complete entry
and native adapters typecheck. Actual disabled entry checks refuse before any
operational artifact. This does not establish funded native integration: actual
capital, final immutable pins and a fresh successful native admission are still
required. Root review is AI engineering review, not an independent human audit.

Keep one concise active acceptance checklist. Move the accumulated dated history
to V3-ACCEPTANCE-EVIDENCE-LOG.md without dropping or rewriting old failures or
results. Rootaaba2e reconstructed the exact original checklist bytes after the
split; the archived ledger is byte-identical. Dated observations are not current
proof and acquisition/supervisor checks cannot close product release gates.

## D23 — Reduce the scheduling buffer, not the work or relay requirement

For a newly prepared public-faucet attempt, permit computation6–32 blocks before
the unchanged47-confirmation relay height, instead of requiring12–32. Prefer the
oldest eligible unspent input. Existing selected jobs and all their policies,
proofs and native gates remain immutable; this is a separately pinned variant.

Rationale: two solved claims are still waiting for maturity, while the latest
native scan found no already-mature easier output. A smaller computation buffer
may reduce post-solution waiting when an earlier eligible input exists. Tradeoff:
block timing varies, so the public input may mature or be claimed by someone else
before the bounded computation finishes. No success, duration or receipt is
guaranteed. This does not fix mining timeouts or increase the probability of a
solution; it changes only which not-yet-mature input may be selected next.

Keep difficulty33, actual47confirmations, exact public10000/fee184/output9816,
unchanged constructor/grinder,1800-second one-attempt limit and no retries.
Projected context remains separate from actual native observations. Active
original anchors, fresh unspent input, receiver recovery, exact work/signature/
transaction/fee review and separate fresh relay approval remain mandatory.
No vault economics, application source, funding target or acceptance gate changes.

The sole pure-policy code delta is the scheduling minimum. Actual181 checks/
40refusals preserve old-range overlap, construction and maturity predicates;
the disabled next package passes six runner suites/47refusals and99 Python/Node
approval checks/79refusals. At qualification, new scheduling had not yet run on
a real input. After ninth's actual successful terminal and zero actors, a fresh
native selection at2026-09-16T22:46:11.529Z observed tip322403 and selected a
distinct unspent input funded322366, projecting relay322412 with9-block lead.
The tenth bounded computation started once; actual maturity and relay remained
false. This is actual scheduling/startup, not completed work or a funds receipt.
Root review is AI engineering review, not an independent professional audit.

Later observations,2026-09-16 23:47 UTC: tenth computation did finish successfully
with actual service/child0 and exact work review, but it still has no receipt.
The older-policy fifth/sixth solved claims subsequently lost their inputs to
confirmed competing transactions (blocks322408/322406), receiving zero. Those
losses are not evidence that the new scheduling variant caused the outcome.
Fresh native input checks prevented relay; all solved proofs remain historical.
Eleventh is the sole active replacement and twelfth is tested but disabled.
No change to work difficulty, fee, native maturity or release scope follows.

## D24 — Separate short chain observations from the durable worker

Two read-only long-lived exec observers terminated with143 before their requested
bounds (71396 and46071); their causes are not established. The separately
supervised native miners and Core node remained live. Going forward, use timed
waits followed by short native checks, while continuing to inspect the original
worker's native invocation and terminal record. Do not restart work or Core on
an observer failure, and do not infer a chain failure from an observer's exit.

This changes observation scheduling only, not a wallet, service, listener,
cryptographic requirement or release gate. A threshold observation is not relay
authority. The existing exact native gate must freshly prove maturity, unspent
input, original anchors, work and recovery; root review and the separate one-shot
relay still follow. The tenth claim's actual gate passed at322412/47conf and its
one relay received transport acknowledgement, but native confirmation remains
unproven. No claim is made that short observations explain or fix the143 exits.

## D25 — Qualify a separate public-work accelerator without changing active jobs

Use a separately built and tested four-lane SSE2 SHA256d implementation only for
new public test-funding work. Existing selected jobs, old utility and their
evidence remain unchanged. The new worker differs only in its private root and
the pinned utility path/hash/size. Its constructor, four-thread limit, finite
32-bit nonce space, first76header bytes, difficulty33, actual47confirmations,
184-sat fee/9816-sat output,1800-second budget, cleanup and relay rules stay fixed.
Every winning header is rechecked through OpenSSL before output and through the
existing independent builder/Node/native gates afterward. No participant key,
wallet API or network capability exists in the accelerator.

Rationale: bounded computations have repeatedly timed out before a valid result.
The isolated candidate matched1024 OpenSSL messages and72target boundaries,
passed16 independently checked Node solutions/16CLI refusals/17partition checks,
and passed ASan/UBSan plus real four-thread synthetic execution. A separate
rebuild produced identical bytes. Fixed-work benchmarks measured approximately2x
and1.609x process-CPU improvement; these do not guarantee real work completion,
wall-clock speedup or a received claim. The original scalar package is retained
as a disabled fallback for a separately reviewed fresh job, never a retry of an
existing input. Never run both variants concurrently.

The new disabled package passes the same six worker suites/47refusals and
105future controls/85refusals. Fresh actual native selection, complete pin review
and review-flag-only activation remain required after the prior real worker's
terminal and independently verified zero actors. This is root AI engineering
qualification, not independent agent review or professional cryptographic audit.
No application source, vault economics, funding target or release gate changes.

First operational use2026-09-17 02:04UTC: after fifteenth's actual timeout and
zero-actor verification, fresh native selection observed322426 and bound a new
input funded322386 to projected relay322432. Sixteenth SIMD started once under
the unchanged native supervision bounds. This proves startup, not completed
work or receipt. The old scalar sixteenth package is retired as-is because its
exclusion list predates this new input; a future rollback needs a newly prepared
capsule that excludes every already-attempted input. Seventeenth SIMD is prepared
and disabled with both sixteen-input exclusion lists and fresh passing controls.

2026-09-17 02:21UTC compiler-only experiment: adding-funroll-loops to the same
source passed1024hash differentials/72boundaries and two synthetic claims, but
six alternating benchmark runs measured0.848x throughput against the already
qualified vector implementation. It is not adopted. Original active/prepared
worker utility bytes and all policies remain unchanged; no general compiler
performance claim follows from this one machine/build comparison.

## D26 — Keep hosted verification within existing no-new-spending authority

2026-09-19: an account-wide Actions usage alert prompted a scoped cost review.
Private account usage totals are not part of the public project record.
Read-only checks found this repository public, its recent jobs
on standard ubuntu-24.04 runners, and no queued or running workflows. Current
[GitHub billing documentation](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
states standard hosted runners in public repositories are free; larger runners
remain chargeable. Existing credentials could not read the account billing
summary, so account-wide usage and attribution remain unverified.

Use local checks during implementation. Before any later hosted release check,
recheck repository visibility and the actual runner class. Do not expand token
permissions, raise budgets, enable paid runners, change repository visibility,
or create spending commitments. No new hosted run or billing mutation was made
for this review. The warning does not authorize account-wide changes.

## D27 — Validate the real offline producer and commit only reviewed fee state

2026-09-19 independent AI review reproduced two defects in the previously
accepted source: the observation CLI always emitted V2 headers, making its
normal output unusable by V3 recovery; and an imported fee draft was retained
before local graph/owner/sponsor-change checks, so a rejected draft could still
reach payout signing. This was not demonstrated quorum theft: fixed vault
payouts stayed committed and the sponsor's separate signature was still needed.

Add an explicit validated observation protocol option; retain the V2 default
for legacy callers and document explicit V3 usage. Never weaken the importer
or infer a vault protocol from its Bitcoin network. Test the actual CLI against
a bounded synthetic loopback RPC, alongside both-protocol consumer tests.

Publish fee state only after successful reconstruction and local-context
validation. Bind it to a full-draft review digest, revalidate every signing,
wallet-import, export and finalization boundary, and recheck after asynchronous
decryption before retaining a signature. Invalid imports/rebuilds and fee edits
clear prior approval/signatures; checkbox changes clear retained signatures.
Exercise rejected imports after both empty and fully signed state in the actual
saved HTML. These synthetic/browser checks do not replace native-chain tests.

Make both new regression suites mandatory: the V3 local plan expands from 75
to 77 commands. Preserve the old source61d3 evidence as historical; do not use it
to certify the changed source or activate its old pinned seed/full-run package.
New exact-source local, image, Signet and deployment evidence is still required.

## D28 — Match offline recovery to the observed current graph coin

The second review found the manual chain-check checkbox insufficient for design
lines218–223: recovery offered every historical shared source and displayed only
the minimum delay. Implement the missing behavior rather than waive it in docs.
Use the existing exact-protocol public Core observation format, with no network
access or new peer/kit format in the saved HTML. Intersect all four shared graph
sources with the report before checking membership; require exactly one exact
outpoint/value/script match. Reject ambiguous or contradictory source facts.

Show observed tip/time, active-block claim, confirmation height/depth, required
delay, remaining blocks and earliest next-block eligibility. Require maturity
before releasing a new recovery contribution or finalization. A pending spend
remains a visible conflict, not proof that the active-chain coin was spent.
Each signer must import an independently checked report; peer files cannot
authorize chain state. Reports are assertions, not freshness or inclusion proofs.
Recheck independently before broadcast; the actual chain still decides conflicts.

Bind review to the graph/report digest and a monotonic local revision. Report
replacement/failure, source changes and approval toggles invalidate pending
signatures immediately, including during asynchronous decryption. Keep all
previously exported signatures irrevocable and all V2/V3 transaction bytes intact.
Apply equivalent post-await review checks to ordinary offline spend actions.

Extend the actual native-browser recovery cases to prove missing-report and
immature refusal, observed-only selection, wrong-source peer rejection and
mid-signing source replacement. Keep early CSV consensus rejection in the
separate native Core suite; do not generate early UI signatures to satisfy an
obsolete test. One pure selector command expands the fixed V3 matrix to78.

The same review adds monotonic fee approval revision checks for rapid checkbox
off/on and stages funding-wallet role merges atomically. A failed mixed-role
import must not retain an earlier item from that rejected batch. Regression
coverage includes distinct cryptographically valid sponsor witnesses; this
approval/state-integrity fix does not change the fixed payout economics.

## D29 — Launch hosted release operations explicitly, once

Remove push-triggered jobs from the separate test-evidence tooling workflow.
Preserve its three explicit manual operations, exact public repository/branch
guards, standard free runner class, immutable action pins, credential isolation
and non-cancelling concurrency. This avoids an image pair being started by a
tooling/pin push and then duplicated by manual dispatch. It does not waive any
test or permit charged resources. The frozen application source is unchanged.

The tooling-only diff passes35 public-evidence and16 deployment-evidence tests;
root independently reran both complete suites and reviewed the diff.
At2026-09-19 22:03UTC it is local only: no push, dispatch or billing mutation.
Candidate/source/tag/deployment pins remain unchanged until genuine new evidence.
Publish a new candidate on a branch that does not also trigger redundant ordinary
acceptance, then run each required retained image profile once after D26 checks.

## D30 — Reclaim only four reconstructible duplicate scan archives

New-source native acceptance needs disk headroom without altering custody or
the D11 public-chain keeper/profile. Independently compare the four scan-working
OCI archive copies in the two historical public-CI directories with their
retained originals and recorded inventory hashes. Reclaim only those exact four
copies (1,035,149,788 bytes), never originals, restored trees, receipts, reviews,
logs, wallets, backups, chainstate, indexes or unique evidence.

The separate private helper fixes all four source/target paths and byte hashes,
requires exact-module approval, regular single-link owner-only files and stable
metadata, and writes exclusive intent before any removal. A real258,780,493-byte
restore rehearsal proves COPYFILE_EXCL refusal, exact bytes/hash, mode and
nanosecond mtime before removing its own temporary copy. Root's streamed audit
matched all eight files; independent bounded AI review found no blocking issue
for single-operator use. These are not professional-audit claims.

Keep the originals protected so every duplicate can be recreated without a
network request. Old helpers that require the scan paths must first restore
them. Inodes and ctimes cannot be restored; xattrs must be absent or separately
preserved. No concurrent archive writer/restore is allowed. Partial reclaim is
not retried automatically: inspect the exclusive intent and restore only missing
indices. A partial restore must be inspected, never overwritten. Preparation
and rehearsal are not evidence that operational copies have been removed.

Actual2026-09-19T22:05:00.963Z: the reviewed one-shot helper completed with exit0,
removing exactly four duplicates and reverifying all four originals. The private
intent/completion records and restore helper remain in
`live-run/v3-duplicate-archives.fthHj5QW`. All four duplicate xattr sets were
verified empty before removal. Free space increased from about2.9 to3.8GiB.
This is recoverable duplicate retention, not deletion of unique evidence or a
change to D11's chain/custody boundaries. Never rerun the reclaim action.
