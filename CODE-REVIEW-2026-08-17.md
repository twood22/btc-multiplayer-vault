# Current code review — 2026-08-17

Reviewed baseline: `5dde338eba32aea11f5208fbb720007fbd79fe32`

This is a current review of the merged mainnet-only product, not a replacement
for the historical defect record in [`REVIEW.md`](./REVIEW.md). Codex reviewed
the repository and tests, then delegated an independent read-only full-tree
review to Claude Opus 5 at maximum effort. Codex checked the material findings
against the baseline before including them here. No live service, credential,
wallet, deployment, funding, or broadcast action was part of either review.

## Bottom line

**Shareable with Sigbash for integration and security review after the
documentation corrections in this revision. Not ready to deploy or fund.**

The Bitcoin transaction, Taproot, PSBT, BIP-327 MuSig2, distributed custody,
nonce-lifecycle, hostile-signer-artifact, database-concurrency, and isolated
browser/container work is unusually strong. The most important newly surfaced
gap is not in those layers: the coordinator has no independent evidence that a
browser-submitted Sigbash registration was issued by Sigbash and binds the
canonical policy.

## Findings

### Critical — Sigbash registration provenance is self-attested

`app/api/sigbash/provision/register/route.ts` accepts `keyId`, `policyRoot`,
`bip328Xpub`, and both policy objects from the registering participant's
browser. It confirms that the policies match the canonical manifest and that
the two leaf keys derive from the submitted xpub, but neither the server nor
the other participants independently query Sigbash or verify a Sigbash-signed
attestation. `validateLiveRegistration` checks shape and internal consistency,
not provider provenance.

The readiness completion path then proves that the registered policy leaf
produced a valid signature for the allowed transaction. It does not prove that
Sigbash participated. A dishonest participant could submit an xpub whose
private key they control, sign the readiness challenge locally, and later spend
that tapscript leaf outside the application without policy constraints. Roster
confirmation commits the other participants to the substituted key but does
not let them recognize the substitution.

This must fail closed before funding. Preferred resolution: Sigbash supplies a
third-party-verifiable attestation binding the organization, key ID/index,
xpub, policy root, and canonical compiled policy. If no such attestation exists,
the coordinator needs a read-only provider verification path or the product
must explicitly trust every participant to provision honestly. The latter is a
materially weaker security model.

### High — recovery delay is economically powerful but insufficiently bounded

The recovery leaf is deliberately uncovenanted `N-1` after CSV. In a pair round
it becomes `1-of-2`. The configuration accepts any positive safe integer, the
offline default is six blocks, and the release check proves only that an
explicit environment value equals the loaded value. It enforces neither a
production minimum nor the BIP-68 block-delay upper bound of 65,535.

Before funding, choose and enforce a reviewed production range. Values above
65,535 are outside the supported block-based encoding and create inconsistent
application-versus-consensus behavior; very short values defeat the intended
holding game and make the recovery collusion path quickly available.

### High operational risk — spend fees cannot adapt after roster commitment

Solo, cooperative, recovery, and final-sweep builders use fee constants frozen
in the immutable roster. Runtime proposals expose no fee selection, and
non-CSV inputs use the final sequence, so they do not signal BIP-125
replacement. The small-deposit defaults can produce low fee rates. A parent may
sometimes be accelerated by spending a participant-controlled output, but the
product has no explicit fee-bump workflow and a broadcast proposal remains the
live proposal until confirmation or reconciliation.

Before funding, add a participant-approved fee within the already committed
policy band, bind it into the proposal commitment, enforce an operator-reviewed
minimum fee rate, and decide on RBF and/or an explicit CPFP procedure.

### High external blocker — live Sigbash signing is still unproven

The repository accurately records the historical signet
`server_error: Signing service error`. No live mainnet signature or browser
solo/Sigbash end-to-end test exists. This is the main reason to share the code
and an unfunded reproducer with Sigbash; it remains a hard deployment gate.

### Conditional trust-boundary risk — the identification leaf is spendable

Each participant has both a policy child-`0/0` leaf and a bare identification
root leaf because the historical Sigbash integration required different keys
for `REQKEY` and input recognition. Local authorizers reject identification-leaf
artifacts. Bitcoin itself cannot distinguish the role: a valid signature under
the root leaf spends it without output restrictions.

Sigbash must confirm whether every signing route for that root/aggregate key is
subject to the same canonical policy. If not, the dual-leaf construction needs
redesign before funding. This risk is conditional on the provider contract and
on participant/provider cooperation; it is not an independently demonstrated
outsider exploit.

### Medium — stale observations can authorize new non-recovery proposals

The proposal store requires a matching unspent coin observation, but only the
recovery path applies the two-minute freshness check. A days-old observation
can authorize a new solo, cooperative, or final-sweep proposal for the same
stored snapshot. Apply a freshness bound to every spend kind and re-observe at
the final signing/broadcast boundary where appropriate.

### Medium — explicit 65-byte P2TR `SIGHASH_DEFAULT` funding signatures pass

The funding signature verifier accepts either 64 or 65 bytes and permits the
65th byte to be `0x00`. BIP-341 requires default-sighash signatures to omit that
byte. The local Schnorr check succeeds, but the final witness is
consensus-invalid and would reach the late operator/mempool gate only
after the three approval ceremonies. Reject a 65-byte signature whose trailing
byte is zero, and add a regression test.

### Medium — final sweep currently sends back to the same payout address

The final payout coin is already controlled by the last participant's payout
key. The runtime does not supply `destinationAddress`, so the final sweep spends
from that payout address back to itself and burns the committed sweep fee.
Either make an external destination part of the passkey-approved proposal or
rename/remove the economically redundant ceremony.

### Medium/low hardening items

- Login challenge creation uses one unauthenticated deployment-wide budget,
  allowing a caller to lock out all three users for the window. Add a private
  edge/per-client limit beneath a higher global safety ceiling.
- `jsonError` returns unexpected internal exception text to the client. Map
  unhandled errors to stable public codes and keep details server-side.
- Recovery-passkey enrollment does not revoke the user's other short-lived
  sessions.
- The shared CLI Sigbash credential fallback warns instead of failing closed.
- The unauthenticated readiness endpoint exposes migration counts; keep it on
  the private network or reduce its response.

## Findings not reproduced as defects

- The independent review described `recoveryDelayBlocks > 65535` as making the
  leaf unspendable. The actual problem is broader and potentially worse:
  application checks and BIP-68's masked sequence semantics diverge outside the
  supported 16-bit block range. The actionable fix is still an upper bound.
- Fixed fees are a real operational risk, but “stuck until fees fall” is too
  absolute because participant-controlled outputs may permit external CPFP.
- The identification leaf is not a new unconditional theft path by itself. It
  is a provider-contract and collusion assumption that must be answered and
  documented alongside the existing trust in Sigbash policy enforcement.

## Strong areas independently confirmed

- Exact transaction and hostile PSBT rebuilding at the Sigbash boundary.
- BIP-341 sighashes, control blocks, taproot commitments, and the repaired
  `multi_a` recovery witness construction.
- BIP-327 key aggregation/signing behavior and one-use secret nonce handling in
  both filesystem and browser ceremonies.
- Participant-only cooperative signing and browser-derived participant identity.
- Database constraints, row locks, compare-and-swap updates, and watcher lease.
- Strict same-origin JSON mutation routes, hardened production cookies, exact
  WebAuthn RP/origin checks, user verification, and PRF-bound encryption.
- Secret exclusion from the database and image, subject to the explicitly
  excluded live credential files.
- Honest labeling of synthetic browser/service/Core fixtures and external gates.

## Test evidence reviewed

- `npm test` — passed under Node 22.23.2.
- `npm run web:typecheck` — passed under Node 22.23.2.
- `npm run web:test` — passed under Node 22.23.2.
- `npm audit --audit-level=low` — zero known vulnerabilities.
- Exact-container acceptance — passed on merged commit `5dde338` in
  [GitHub Actions run 32064526120](https://github.com/twood22/btc-multiplayer-vault/actions/runs/32064526120).

These checks do not supply Sigbash provenance, a live mainnet signature,
physical-passkey evidence, real-wallet evidence, a deployed registry digest,
or authority to deploy, fund, or broadcast.
