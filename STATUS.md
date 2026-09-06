# Current project status

Last updated: 2026-09-05
Reviewed baseline: `71b1bd227a5f3f3d35fb8449776747d5d88d28c7`; current work is on
`codex/signet-readiness-hardening`, including liveness and Signet release fixes.
Implementation `3edb17c` is pushed in
[PR 2](https://github.com/twood22/btc-multiplayer-vault/pull/2), not merged or deployed.
Both exact-container profiles passed in
[run 34000624901](https://github.com/twood22/btc-multiplayer-vault/actions/runs/34000624901).

This is the current operational status and roadmap for the Bitcoin multiplayer
vault described in [`spec.md`](./spec.md). The production target remains
mainnet, while the next implementation and integration milestone is the default
global Bitcoin Signet described in
[`SIGNET-VALIDATION-PLAN.md`](./SIGNET-VALIDATION-PLAN.md). Historical
findings remain in [`REVIEW.md`](./REVIEW.md), and detailed product and
deployment gates remain in [`PASSKEY-PRODUCT.md`](./PASSKEY-PRODUCT.md) and
[`DEPLOYMENT.md`](./DEPLOYMENT.md).

The current Signet operator sequence is
[SIGNET-OPERATOR-RUNBOOK.md](./SIGNET-OPERATOR-RUNBOOK.md). Physical passkey checks
are deferred by the user to the first friends vault, not a separate test session.
They remain real onboarding/recovery checks before that vault is funded.

## Verdict

**The typed standard-Signet profile, offline/PostgreSQL/build/browser gates, and
a real three-wallet funding plus cooperative-spend checkpoint now pass. Hosted
Sigbash signing and the complete user-facing lifecycle remain blocked or
unproven; mainnet is still unauthorized.**

The repository implements the intended round-based game: Sigbash-enforced solo
withdrawals, participant-only BIP-327 MuSig2 cooperative exits, distributed
passkey-protected participant custody, timelocked recovery, final sweep, and
three-wallet funding preparation. Remaining limitations include Sigbash-registration
provenance, fee adaptation, final-sweep destination semantics, and external
operational proof. Sigbash declined mainnet SDK enablement for the current
experimental project but permits SDK testing on Signet. A real standard-Signet
vault was funded and cooperatively spent, but no hosted Sigbash signature or
complete user-facing run has been obtained, and no real mainnet transaction has
been authorized. See the
[`current code review and fixes`](./CODE-REVIEW-2026-09-05.md) and the
[`previous review`](./CODE-REVIEW-2026-08-17.md) for evidence and remaining risks.

## 2026-09-05 implementation checkpoint

The user reaffirmed a friendly holding vault and authorized code improvements.
The haircut/bonus economics, nine Sigbash policies, passkey custody, and specified
recovery trust model are unchanged. No operational database, live signer, wallet,
deployment, GitHub branch, or funds were modified for this checkpoint.

- Fixed concurrent readiness completion leaving nine valid receipts but no
  `ready` state. Exact receipt retries and migration 014 repair that old state.
- Removed the one-proposal-per-coin veto. Each participant can propose its own
  solo exit alongside shared cooperative/recovery proposals; the browser lets
  participants select which exact transaction to review/sign. Bitcoin
  confirmation, not proposal creation, still determines the winning spend.
- Protected approved/in-flight broadcasts from expiry. The watcher resumes
  interrupted approved or submitting intents, reports individual failures, and
  continues to observe competing transactions. Unavailable send/lookup responses
  preserve retryable intent; it retries only current inputs.
- Kept initial funding restart-locked after an uncertain send or resumed attempt.
  A fresh preflight rejection can still be released, but only by its owning
  attempt. Funding retry tokens now preserve PostgreSQL microsecond precision;
  the regression covers overlapping operators and exact-transaction recovery.
- Made full 32-revision custody history read/unlockable, with new writes disabled.
  Registration reserves space for both pending and completed recovery snapshots.
- Added real PostgreSQL regression tests and extended the three-browser MuSig2
  test with an independent solo proposal and shared-proposal selection. The
  production/container acceptance harness now also runs the database suite.
- Corrected evidence labels: `SigbashClient.verifyPSBT` calls SDK WASM locally
  (with possible metadata requests). It is not an independent hosted signing
  service acceptance. No new hosted signature was attempted or obtained here.
- Audited the remaining funding/passkey/HTTP/deployment boundaries and recorded
  coverage and limitations in the review. The complete Signet operator release
  ceremony remains pending; the private funding CLI still has mainnet-specific
  release contracts, and store tests do not establish that product milestone.

Migration `014_runtime_liveness` must run with the matching application release.
These changes are local and are not evidence of a pushed or deployed release.

## Independent testing follow-up

At the user's request, three independent agents tested transaction-state races,
custody boundaries, and the optimized browser path. All final runs passed,
including a new simultaneous expired-funding-claim probe, genuine 32-revision
encrypted-history recovery, and browser consent reset/expired selection. The
primary agent also reran core/web/network checks and the isolated Bitcoin Core
31.1 reorganization drill. No new application defect was demonstrated; no
production code or shared tests were changed during this testing follow-up.
See [the test report](./TEST-REPORT-2026-09-05.md) for exact coverage, corrected
probe assumptions, evidence, and the remaining live-provider/device limitations.

## Live Signet follow-up — 2026-09-05

The user subsequently authorized real Signet signing and broadcasts. Three
hosted signing attempts obtained no signature: the saved first-round PSBT with
stock encoding failed proof parsing, and both the wrapped first-round PSBT and
a fresh second-round PSBT reproduced `server_error: Signing service error`.
The valid transaction and all three negative-verification cases behaved as
expected before each signing attempt. No transaction was broadcast, no new key
was created, and no existing Signet coins or mainnet material were used.

This investigation also demonstrated an SDK 0.8.0 key-response correlation
defect: `listKeys()` issues concurrent KMC requests whose shared response event
can return one key's material for another key. Direct retrieval on a fresh
client with checkpoint binding avoids that defect in the reproducer, but the
application's browser/CLI provisioning still needs hardening. This is distinct
from the signing-service exception, which still occurs with the correct key.
See [the live report](./SIGNET-LIVE-TEST-2026-09-05.md) for current traces,
the offline SDK reproducer, chain checks, and the unfulfilled lifecycle gates.

## Signet readiness hardening follow-up — 2026-09-05

The user authorized completing the preparation and review work, with physical
passkeys deferred as described above. This supersedes the earlier implementation
checkpoint's pending provisioning/release code items, not its evidence limits.

- Browser and CLI now use the pinned SDK guard: sequential list hydration,
  fresh native clients for key-material/recovery requests, actual decrypted
  xpub/policy/share checks, late-response isolation, and round-specific signing
  initialization. No global SDK prototype patch or replacement signer.
- Live read-only checks retrieved the nine existing Signet keys under all three
  organizations and verified every checkpoint, deterministic participant share,
  and current-envelope recovery round trip, including slots 1 and 2. No new key,
  signature, or broadcast was created by these checks. Recovery without the
  server's current wrapping remains untested.
- Real runtime testing exposed a previously broken raw-vs-compiled policy
  comparison: the compiler adds inline address-list IDs. The application now
  preserves exact conditions/destinations, rejects preset/external/colliding
  IDs, and compares browser/CLI results to the pinned local compiler. This is
  consistency validation, not hosted-key provenance or a policy-root attestation.
- Fresh, unfunded Signet pair setup created two keys under new protected test
  organizations and preserved both recovery kits. It required two explicit
  same-checkpoint retries after the SDK's aggregation step reported a policy-root
  mismatch. A credential-free pinned-WASM probe independently produced two roots
  from 64 identical inputs despite identical compiled policy JSON. This is an
  intermittent upstream compilation defect, not a clean provisioning pass;
  its relationship to the hosted signing exception is still unknown.
- Signet has independent version-2 live-proof receipts, version-3 release
  artifacts, reviewed-digest variables/paths, and an explicit Signet broadcast
  acknowledgement. Both artifacts commit network and genesis; cross-network
  and legacy artifacts fail closed. The nine real readiness signatures, three
  final funding approvals, private Core, real-device, and mainnet enablement
  gates remain intact.
- Production builds now record their network. Startup rejects a missing,
  mixed, or wrong-network runtime before listening. The exact-container CI
  workflow passed on both profiles for implementation `3edb17c`, including
  PostgreSQL 16.15, six browser scenarios per image, and the operator probe.
- The actual guarded predeployment-signing CLI was then exercised with the
  fresh unfunded pair. At `2026-09-06T00:11:37.852Z` (September 5 local time), it
  reached policy acceptance, server nonce exchange and wrapped blind signing,
  then reproduced `server_error: Signing service error`. No receipt was written.
- Claude Fable performed bounded read-only SDK/release/compiler reviews. The
  compiler behavior and fixes were independently checked; details and final
  verification are in [SIGNET-READINESS-2026-09-05.md](./SIGNET-READINESS-2026-09-05.md).

Still blocked: the hosted signing exception, real predeployment signature,
private HTTPS deployment/registry-digest/restore evidence, and the complete
friends' user-facing lifecycle. No funding release report has been fabricated
or issued. `signetValidated`, `mainnetValidated`, and
`mainnetFundingAuthorized` remain false.

## Proven on this baseline

- The offline TypeScript, policy, PSBT, Taproot, MuSig2, recovery, consensus,
  custody, and product-conformance suite passes under Node 22.23.2.
- Web typechecking and isolated browser tests pass under Node 22.23.2.
- Both mainnet and default-global-Signet network acceptance pass. The Signet
  offline/web suite, fresh PostgreSQL 16 migration/database suite, optimized
  production build, and all six optimized three-browser scenarios pass.
- Nine fresh **10,000-sat-per-participant** Signet-only hosted Sigbash keys were
  created under three independent credential organizations, with protected
  recovery journals. An earlier nine-key 1-BTC policy set is retained only as
  non-fundable historical setup evidence. SDK local WASM
  `verifyPSBT` accepted the exact allowed transaction and rejected wrong-value,
  wrong-destination, and extra-output variants.
- Against the real confirmed vault outpoint
  `46fa0c249d7ccef642ef8b7d248c5fada161a571443e0b4721e03d7b7a518220:0`,
  SDK local WASM `verifyPSBT` accepted Alice's exact 9,500-sat first exit with 20,200
  sats re-vaulted and explicitly rejected wrong-amount, wrong-address, and
  extra-output PSBTs. The signing nullifier was reported available.
- Funding rejects non-canonical 65-byte Taproot signatures with an explicit zero
  sighash byte; all proposal types require fresh observations; recovery delay is
  bounded to the CSV-encodable range 1 through 65,535.
- At the 2026-08-31 checkpoint, Bitcoin Core 31.1 was fully synchronized against default global Signet in an
  isolated datadir with `txindex=1`. A faucet paid 82,132 sats in
  `c80ae308b476f73d6844aa75e713d33b9cb20428eca2d73c9917a58b5bcd8833`;
  `3bd606154ba8c7d6651861ff72f9a862f4b63fa13c1feba91d7e7bbcf193bc2c`
  split it into confirmed 20,000-sat Alice, Bob, and Carol wallet outputs.
- The exact three-wallet funding builder consumed one independently signed
  Taproot input from each Core wallet and confirmed transaction
  `46fa0c249d7ccef642ef8b7d248c5fada161a571443e0b4721e03d7b7a518220`,
  with one 30,000-sat round-one vault output, three 9,000-sat change outputs,
  and a 3,000-sat fee.
- The confirmed vault output was spent through its participant-only MuSig2
  key path by
  `ef01cb2027ca35b64e7d5390ffb7cd0b3b35e950658cfcc42684e35a57cad9f4`.
  The live audit verified the selected outpoint, Taproot key-path witness, no
  Sigbash keys in the cooperative path, three exact 9,900-sat refunds, and one
  confirmation. This isolated CLI signing checkpoint proves the consensus
  path, not three-device/passkey custody.
- `npm audit --audit-level=low` reports zero known vulnerabilities.
- The manual `Exact container acceptance` GitHub Actions run passed for the
  merged baseline: [run 32064526120](https://github.com/twood22/btc-multiplayer-vault/actions/runs/32064526120).
  It ran six isolated browser scenarios and the packaged, non-mutating operator
  probe against local image ID
  `sha256:d275c0d95ee4ec34564f36718fc1d1b4e433a91717b8f32a8a6e04db09a084b1`.
- That CI evidence is a tested local image ID, **not** a published registry
  manifest digest, deployed artifact, live-service test, funding approval, or
  mainnet authorization.

The pinned checkout/setup actions currently use Node 20 action runtimes that
GitHub forces onto Node 24. The application and acceptance suite still use the
repository's exact Node 22.23.2 runtime. Updating those actions is a maintenance
item, not evidence that the application ran under the wrong Node version.

## Explicitly unproven

- A complete real hosted-Sigbash signing flow on standard Signet. The
  2026-09-05 first- and second-round retests passed local verification but
  reproduced `server_error: Signing service error` with the transport wrapper.
  The separate upstream SDK multi-key response-correlation defect is now guarded
  in application provisioning; live retrieval/recovery passed for nine existing
  keys. Fresh provisioning also exposed intermittent compiler-root variation.
- Nine live readiness signatures, three physical-passkey identities, and the
  complete user-facing on-chain state machine.
- Sigbash mainnet enablement and one real, locally authorized mainnet signature.
- The nine participant-and-round readiness proofs using three independently
  owned Sigbash organizations and physical passkeys.
- Production HTTPS/RP configuration, encrypted database operations and restore,
  user-facing private Bitcoin Core operation, physical external-wallet signing,
  and real browser/device recovery drills.
- A published and independently reviewed registry manifest digest.
- Any deployment, mainnet funding/broadcast, or user-facing passkey-approved
  Signet funding/broadcast. The confirmed CLI checkpoint is operational evidence,
  not deployment authorization.

## Remaining risk and design work

- **Sigbash key provenance:** the coordinator checks browser-submitted key and
  policy data for internal consistency but has no Sigbash-signed or independently
  queried attestation that the provider issued that key with that policy. The
  existing positive readiness proof can be satisfied by possession of the
  registered leaf key and therefore does not close this gap.
  For the explicitly friendly test scope, this is a documented participant-trust
  assumption; it must not be presented as protection against dishonest peers.
- **Long-lived fee handling:** immutable low fixed fees and non-RBF sequences
  need a participant-approved fee-bump design or an explicit, tested alternative.
- **Final sweep semantics:** choose a separately approved destination or remove
  the current self-send and fee burn.

The protected live-proof receipt is local operator evidence, not a
provider-signed Sigbash attestation. Browser hostile-PSBT rejections are
browser-observed evidence; the server independently proves only the allowed
transaction and signature it can verify itself.

## Design decision requiring explicit funding-time review

The recovery leaf is an uncovenanted CSV-delayed `N-1` participant spend. After
the configured delay, `N-1` participants can send the entire current UTXO to
arbitrary outputs. In a two-participant round, that means one participant can
take the remaining pot after the delay. This is the specified liveness escape
hatch, not a Sigbash-enforced game withdrawal, and Bitcoin Script does not
constrain its outputs. It must be accepted as part of the trust model and given
a deliberately reviewed mainnet delay before any funds are approved.

## Questions for Sigbash

1. May the three participant-owned organizations each create their three
   immutable round-scoped keys on the default global Bitcoin Signet under the
   free SDK testing policy?
2. Can Sigbash provide a server-verifiable attestation binding organization,
   key ID/index, BIP-328 xpub, policy root, and the canonical compiled policy?
   If `policyRoot` is deterministic, how should an independent verifier
   recompute it? The pinned compiler now has a credential-free same-input root
   variation reproducer in `scripts/sigbash-policy-compiler-probe.mts`.
3. Does the current Signet service support the SDK contract used here,
   including immutable `REQKEY`, output destination/value constraints,
   input/output counts, recovery-kit export, and the expected rate limits?
4. Please confirm that descriptor `tr(SIGBASH_XPUB/0/*)` identifies the
   child-`0/0` policy leaf key while the SDK's identification key remains its
   distinct internal aggregate root. The code fails closed if that contract
   differs; it does not substitute another leaf-key candidate.
5. Is every signing route for the identification root/aggregate key subject to
   the same canonical policy, even though it is a separate bare Taproot leaf?
6. What service-side evidence can Sigbash provide for policy rejection,
   nullifier consumption, key/network identity, and signed-response fields?
7. What Signet rate, key-count, nullifier, and retention limits should the
   nine-key three-person validation respect?

## Roadmap and hard gates

These are sequential gates, not a deployment schedule:

1. **Network boundary — implemented:** retain the isolated default-global-Signet profile
   in [`SIGNET-VALIDATION-PLAN.md`](./SIGNET-VALIDATION-PLAN.md) without changing
   the round game or weakening the existing mainnet gates.
2. **In-repository safety pass — partial:** recovery bounds, stale-observation
   and funding-signature fixes were already present; readiness, proposal,
   broadcast, and custody liveness fixes are now regression-tested locally.
   Provider provenance, fee adaptation, and final-sweep semantics remain open;
   preserve the friendly-vault trust model when planning further changes.
3. **Signet infrastructure and coins:** run isolated default-Signet Core,
   Postgres, HTTPS/passkey, and independent observation boundaries; obtain a
   small faucet coin and split it into three participant-controlled wallet UTXOs.
4. **Real hosted-Sigbash proof:** create fresh Signet credentials and keys,
   resolve the historical signing failure, prove allowed signing and hostile
   rejection, and verify provider provenance as far as the service permits.
5. **Complete Signet product run:** execute all nine readiness proofs, funding,
   solo orderings, cooperative exits, recovery thresholds, final-owner flow,
   confirmation, restart, outage, fee, and reorganization drills using the real
   service and chain rather than fixtures.
6. **Independent Signet release review:** require no open critical/high funding
   issue and produce an explicitly non-mainnet report.
7. **Later commercial/mainnet decision:** only a separate decision may begin a
   new mainnet-scoped deployment and tiny-funding review. Every mainnet gate and
   explicit authorization remains required.

The faucet and CLI/Core funding/cooperative checkpoint are already complete.
The user-facing Signet funding gate still requires all nine real Sigbash
readiness signatures; the CLI checkpoint does not satisfy it. Mainnet remains
**unfunded** unless a later commercial and funding decision explicitly changes
that state.
