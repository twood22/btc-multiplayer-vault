# Signet readiness hardening — 2026-09-05

This follows the [audit](./CODE-REVIEW-2026-09-05.md),
[independent tests](./TEST-REPORT-2026-09-05.md), and
[hosted signing investigation](./SIGNET-LIVE-TEST-2026-09-05.md).
Baseline: `71b1bd227a5f3f3d35fb8449776747d5d88d28c7`.
Implementation branch: `codex/signet-readiness-hardening`.
Review: [PR 2](https://github.com/twood22/btc-multiplayer-vault/pull/2).
Tested implementation: `3edb17c9c578eeee02b4ae1d9b68b88571b5e245`;
subsequent documentation-only updates record these results.

## Verdict

The real product's provisioning guard, policy-compiler compatibility checks,
network-specific private release commands, immutable build-network binding,
and regression coverage are implemented. No economics, custody, Sigbash solo
path, cooperative signing, or recovery trust model was replaced.

**Not ready to fund a user-facing vault.** The latest hosted signing tests still
failed, and fresh provisioning exposed an intermittent compiler-root defect.
There is no real predeployment proof, nine-signature readiness ceremony, private
deployment, or complete friends' lifecycle. No funding release was issued.
Physical passkeys are deliberately deferred to onboarding for the first friends
vault, not an additional testing chore now; their real checks remain required
before that vault is funded. All release-validation flags remain false.

## Implemented and independently reviewed

- SDK 0.8.0 transport guard: authenticated enumeration with sequential hydration
  on fresh native clients, one key-material request per transport, cleanup under
  a shared SDK lock, exact decrypted xpub/policy/share binding, isolated recovery
  round trips, and fresh round-specific signing initialization. Failed retrievals
  cannot leave a socket available to misidentify a later key. The SDK remains the
  actual signer; this is not a replacement implementation.
- Provisioning: fail closed on ambiguous key matches, outages, mismatched slots,
  mutability/history, recovery mismatches, and changed policies. Handle the
  provider's specific pre-registration response only for an explicitly fresh
  organization. Retain exact-slot reconciliation and recovery-before-checkpoint;
  remove the old create/advance/retry loop that could hide uncertain outcomes.
- Compiler compatibility: raw policies legitimately acquire inline address-list
  IDs. Preserve exact conditions and destinations; reject preselected, external,
  malformed, colliding, or partially populated IDs. Browser/CLI also recompile
  with the hash-pinned local WASM and require exact compiled JSON. A public
  comparison seed is never used to validate a root, provision, or sign.
- Signet-specific live-proof v2 and funding-release v3 artifacts bind the network
  and genesis, reviewed fingerprints, exact final funding transaction, and
  deployed image. Separate Signet variables/paths and broadcast acknowledgement
  prevent cross-network approval. Legacy artifact versions are rejected.
- Both networks retain all nine real readiness signatures, three final funding
  approvals, private Core, restore, image, and manual release gates. Mainnet
  entitlement remains mandatory and unavailable for this experimental project.
- Next.js network selection is now recorded during the build. Container,
  standalone, operator probe, and `web:start` reject a mismatched runtime profile
  before starting. The manual container workflow tests both networks separately.
- The preceding audit's readiness race, competing proposals, broadcast retry
  ownership/liveness, and full custody-history fixes are included. Migration
  `014_runtime_liveness` must ship with the matching application.

Claude Fable performed three bounded read-only reviews through the
`delegate-to-claude` skill: native SDK correlation, the implementation/release
boundary, and real pinned-WASM compiler semantics. Its findings influenced the
fresh-client architecture and strict list-ID validation. The primary agent
independently inspected and tested the resulting code; review output was not
accepted as proof of hosted signing or deployed security.

## Verification in this follow-up

| Check | Result and limits |
| --- | --- |
| Core/type/policy/PSBT/consensus acceptance | Passed on Signet and mainnet with Node 22.23.2 and isolated local credentials |
| Web/guard/compiler/release/operator/build-network tests | Passed on both profiles; includes malicious substitutions, delayed responses, exact-slot resume, and cross-network rejection |
| PostgreSQL 16.14 migration and database acceptance | Passed on fresh disposable databases for both profiles, including readiness concurrency, competing proposals, uncertain submission, and recovery |
| Optimized production browser acceptance | Six scenarios passed on each profile; final Signet rerun includes the compiler fix. Virtual authenticators and explicit synthetic provider/chain prerequisites, not physical or live-signing evidence |
| Network acceptance | Both profiles passed; mainnet was an isolated synthetic test, never a live account or broadcast |
| Dependency audit | `npm audit --omit=dev --json`: zero reported vulnerabilities at the check, not a security attestation |
| Existing live Signet keys | All three organizations enumerated correctly; all nine checkpoint, participant-share, exact-compiled-policy, and recovery checks passed, including slots 1 and 2 |
| Local WASM using the real existing KMC | Accepted the saved valid PSBT and rejected three hostile variants; no hosted signature attempted in these checks |
| Fresh live Signet provisioning | Two unfunded pair keys and two protected recovery kits completed after two explicit same-checkpoint retries; intermittent root mismatch is unresolved |
| Actual guarded predeployment-signing CLI | Fresh unfunded pair reached policy acceptance, server nonce exchange, the hex wrapper, and the blind signing request; reproduced `server_error: Signing service error`, created no proof receipt |
| Exact Docker image | Both Signet and mainnet jobs passed in [run 34000624901](https://github.com/twood22/btc-multiplayer-vault/actions/runs/34000624901), including six browser cases per image, PostgreSQL 16.15 database acceptance, and the packaged operator probe. No image was published or deployed |

The live key/recovery verification completed at `2026-09-05T23:46:57.537Z`.
Fresh pair provisioning completed at `2026-09-05T23:59:55.649Z`. Credentials,
checkpoints, recovery kits, and allowlisted summaries remain owner-only under
ignored `live-run/signet/`; no secret material belongs in the repo or CI.
An additional actual guarded CLI signing attempt completed at
`2026-09-06T00:11:37.852Z` (September 5 local time). It used the fresh pair,
reviewed 10,000-sat economics, and the deliberately unfunded proof outpoint.
It reached the hosted signing request and reproduced the signing-service error;
no version-2 proof receipt was written. This follow-up created two unfunded keys,
attempted one hosted signature without obtaining one, used no coins, and made
no broadcast, operational migration, or deployment.

## Additional provider finding: identical input can yield different roots

The fresh native SDK creation path failed twice with:

```text
Key aggregation failed: policy_root mismatch: re-compilation produced
[32-byte value] but caller supplied [32-byte value] — ensure the same seed_hex
is used for both SigbashWASM_CompilePOETPolicy and SigbashWASM_AggregateAndBuildKMC
```

An explicit retry using the same protected credentials, immutable policy,
checkpoint, and key slot eventually completed. No slot was silently advanced
and no root check was bypassed.

The independent reproducer uses only public fixture addresses and a public
constant seed, loads the actual pinned WASM, and calls its compiler 64 times
with **identical serialized input** before any other fixture. It instantiates
no SDK client and uses no credentials or application guard:

```bash
VAULT_NETWORK=signet NEXT_PUBLIC_VAULT_NETWORK=signet \
  npx tsx scripts/sigbash-policy-compiler-probe.mts
```

Observed: all 64 `compiled_policy_json` strings were identical, but there were
two roots: `e869a88104ba3c0160d6c1a46ecc5550946cd67b9eb56ba51653a83a729fcb37`
(60 calls) and `67b5a598a51995817467bb5a501d9fff575cef2704cde2c95f1404836fbe49c5`
(4 calls). Counts are intermittent, not fixed expectations for a future run.
The script reports what it observes rather than requiring a flaky count.

SDK: `0.8.0`. Runtime SHA-384:
`a57fa4c7172fb06dce6133832778247fb22c586d1e2ee70282ff8efa1f0e5b58a81b02dbd1d6b69e474254bc35c6945d`.

This demonstrates upstream same-input root variation independently of the
adapter. It is a plausible explanation for the aggregation mismatch, but the
precise compiler cause and any connection to the signing-service exception
still need Sigbash's investigation. Do not claim a proof-system bypass or an
explanation of the hosted failure from these observations alone.

The same fixture also confirms that this compiler preserves foreign preset
list IDs and accepts duplicate list IDs for distinct address sets. Application
guards reject both. Actual signing with such a colliding policy was not tested.

## Remaining gates and next action

1. Sigbash resolves the hosted proof/signing failure and investigates compiler
   root determinism. Keep the independent reproducer and reviewed policy/PSBT
   evidence available; do not weaken policy verification to get a signature.
2. Obtain the real unfunded predeployment signature using the guarded Signet
   path. Then select the private HTTPS/access boundary, independently review the
   exact image, verify PostgreSQL TLS/restore and Core, and deploy only with
   explicit authorization.
3. During the friends' first vault, complete actual two-passkey setup/recovery,
   immutable roster, all nine real readiness signatures, and exact three-wallet
   funding approvals. Follow [the operator runbook](./SIGNET-OPERATOR-RUNBOOK.md).
4. With separate reviewed release/broadcast approval, test all six solo exit
   orderings, cooperative closure, both CSV recovery thresholds, final-owner
   access, interruption, and reorganization across the actual user-facing flow.

Limits retained: public SDK metadata is not a provider-signed immutable-policy
attestation; server registration does not independently prove KMC provenance;
recovery testing exercised current server wrapping, not loss of that wrapping;
real authenticator portability is unproven; fee adaptation and final-sweep
destination semantics remain the separately documented product issues. The
friendly-participant trust assumption does not turn those limits into stronger
security guarantees.
