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
