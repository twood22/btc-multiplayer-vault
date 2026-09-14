# V3 release and operations

Status: engineering acceptance is in progress. No V3 deployment or mainnet
activation has occurred. This runbook complements, rather than rewrites, the
historical V2 operator/evidence record.

## Release identity

Freeze the complete source inventory only after implementation, operations and
acceptance changes are finished. Build identities must explicitly name
`presigned-graph-v3`, the intended network and the exact source digest. The
dual-version offline utility must match the recorded byte hash and support V3.
Never relabel historical V2 images, receipts, signed epochs or recovery kits.

Run the fixed applicable local matrix, both actual OCI image profiles, and the
complete default-Signet lifecycle against that frozen source. Intermediate
Core, database and browser results are debugging evidence, not a final release.
The mainnet-format browser test must leave mainnet spending disabled; its
isolated chain-label bridge is not real mainnet or real Signet evidence.

Preserve the full successful child transcripts, exact OCI archives and
manifests, browser/offline results, real default-Signet observations and native
restoration evidence. Use the strict assembly and archive validators. Reject
missing owner cash-out coverage, partial/focused saved-file runs, mismatched
protocols, stale source digests and hand-authored substitutes for real receipts.

## Deployment boundary

The autonomous goal permits a verified deployment package to be handed off as
**not deployed** where no existing environment has explicit deployment
authorization. Do not create public listeners, a new provider account, paid
resources, DNS records or mainnet transactions to bypass that boundary.

The package must pin the immutable image identity, exact protocol/network,
offline utility and evidence. Use rootless containers, a read-only filesystem,
dropped capabilities, no privilege escalation and a loopback listener behind
an independently authorized HTTPS endpoint. Do not weaken host security to
make a container test pass. Keep external secrets outside source, images,
instructions, logs and evidence archives.

This development host currently has no usable rootless container runtime.
Container acceptance must use a verified existing authorized runner; the local
standalone-browser build does not replace it. No runner or deployment result
is claimed merely because a workflow exists.

### Reviewed deployment commands

`scripts/presigned-deployment.mts` defaults to read-only package verification.
Its owner-only plan binds the exact image/archive and release receipt, network,
external environment-file hash, database identity, migration bytes, loopback
port and retained compatible previous image. Store the plan, secret inputs and
append-only operation journal outside the repository. The secret-input
directory and journal directory must be separate and owned privately.

Use `--seal-body ABSOLUTE_BODY_PATH --out ABSOLUTE_NEW_PLAN_PATH` to seal a new
plan body; sealing neither validates the actual artifacts nor installs anything.
Use `--plan ABSOLUTE_PLAN_PATH` to verify the real artifacts without contacting
the database or container runtime.

Actual `--action install`, `--action rollback` and `--action monitor` also
require all three explicit arguments:

- `--approved-plan-digest` with that exact sealed plan's digest;
- `--execution EXECUTE_REVIEWED_PRIVATE_DEPLOYMENT`;
- `--quiescence ALL_OTHER_APP_AND_WATCHER_PROCESSES_QUIESCED`.

These acknowledgments describe prerequisites, not shortcuts. Verify the actual
target and stop other authorized app/watcher processes before asserting
quiescence. The tool uses only existing local rootless Podman, never pulls an
image, never binds a public listener, and never falls back to privileged mode.
`monitor` is a restartable foreground supervisor; `--once` performs one bounded
watcher/health iteration. Supervise it only in an explicitly authorized host.

After an interruption, preserve the journal and retained containers and resume
the same reviewed operation. Do not erase history to retry. A completed rollback
requires a new reviewed release ID before another installation attempt.

The separate `scripts/presigned-deployment-image-acceptance.mts` runs only with
`--execute-disposable-loopback`, `--image-evidence`, `--acceptance-receipt` and
`--scratch-root`. It is a post-assembly check of the exact final Signet image and
receipt against disposable native databases and a network-disabled Core node.
Its two release IDs intentionally use the same compatible immutable image: it
tests actual retained-container rollback, not a different binary or a database
downgrade. Its proof is valid only after verified service shutdown, and does not
claim real Signet execution or production deployment. No such proof exists yet.

## Database and rollback

Migrate through the exact reviewed migration set, including 022 (V3 fixed
recovery) and 023 (owned-payout withdrawal intents). Before an operational
upgrade, preserve a native database backup and verify restoration using the
actual producer/receipt path, including encrypted passkey envelopes and all
retained signing/broadcast state. A restore receipt must refer to the intended
database and current evidence, not a synthetic database fixture.

Rollback may restore only an explicitly compatible image supporting every
retained vault protocol and the same reviewed database schema. Never drop V3
tables, delete old epochs, reset signing intent, migrate a funded V2 vault to
V3, or treat restored database state as revoking a released Bitcoin signature.
The deployment/rollback journal must retain the exact previous image and write
intent before stopping, migrating or launching services.

## Watcher and monitoring

Run the private watcher under its database lease. Monitor its freshness and
failures, RPC chain identity/tip, database availability, confirmation/reorg
status, deferred broadcast intents, fee packages and owner withdrawals.
Saved-only owner withdrawals must never enter automatic retries. Only explicit
send intent allows a watcher to submit their exact signed bytes.

Use `/api/health/live` for process liveness and `/api/health/ready` for readiness;
a healthy HTTP endpoint does not establish release approval or current Bitcoin
confirmation. Treat cached status as last observed, not live chain authority.
Operational logs must not contain invitation tokens, recovery material, RPC
cookies, database credentials or raw secrets.

## Mainnet activation remains separate

V3 requires its own explicit protocol-specific authorization plus the exact
release and restoration evidence. An existing V2 authorization must not enable
V3. No automatic install, rollback, healthy check, CI pass or implementation goal
grants authority to move mainnet funds.

Before user-visible publication, inspect repository artifacts and provider
branding/contact fields for personal identity exposure. Use only the approved
business contacts when required. Keep private legal and account-recovery
identities private; do not change those records as a branding shortcut.

Give participants `V3-USER-GUIDE.md`, the exact utility and their private
invitation through an authorized channel. Do not send invitations or contact
friends without explicit communication authority. Physical-device checks and
a purchased human audit remain unperformed launch limitations, not falsely
completed engineering tests.
