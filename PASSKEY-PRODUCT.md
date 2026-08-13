# Passkey product status

This is the user-facing layer for the existing Bitcoin multiplayer vault. It
does not replace the round-based game, the Sigbash solo-withdrawal path, the
participant-only MuSig2 path, or the timelocked recovery path.

## What exists now

- Private, single-use invitations for the three fixed participant seats.
- Passkey registration and sign-in with server-side WebAuthn verification,
  required user verification, short-lived strict-same-site sessions, and exact
  RP ID/origin checks.
- Browser-generated participant secrets. The plaintext secret and the passkey
  PRF output never cross the network.
- AES-256-GCM envelopes whose keys come from HKDF over the passkey PRF output.
  Each envelope is authenticated to the user, credential, vault, participant,
  purpose, and version.
- Postgres storage of only ciphertext, IV, salt, authenticated context, public
  keys, passkey public credentials, challenges, and hashed session/invite
  tokens.
- A fresh passkey assertion is required to retrieve and decrypt an envelope.
  The browser re-derives the participant's Bitcoin public identity and compares
  it to setup-time public material before reporting the key usable.
- An explicit dashboard sign-out deletes the exact hashed server session,
  expires its hardened cookie, and removes only vault-scoped ephemeral signing
  state from the browser tab. The endpoint rejects cross-origin requests and is
  safe to repeat after the session is already gone.
- Strict CSP with request nonces. The only external connection origin is the
  configured HTTPS/WSS Sigbash service; its Go runtime is fetched through a
  same-origin route and checked against an operator-pinned SHA-384 digest, and
  the WASM is independently pinned before execution.
- A recovery-passkey ceremony that first unlocks with an existing credential,
  registers a distinct credential, and encrypts the exact same participant
  secret under a credential-specific PRF salt and authenticated envelope. Either
  completed passkey can subsequently sign in and unlock the same identity.
- An immutable roster ceremony that refuses offline Sigbash fixtures, rebuilds
  and audits the complete mainnet vault from nine service-created public key
  registrations, commits the economics, policies, Taproot trees, and funding
  output to one canonical SHA-256 digest, and binds each participant's fresh
  passkey assertion to that digest. The round-one address and script are absent
  from responses until all three distinct seats confirm.
- Browser-generated, SDK-compatible Sigbash credential triplets. A separate
  HKDF/AES-GCM key derived from the participant secret protects one shared,
  append-only Sigbash custody history, so either recovery passkey can restore
  the credential triplet and every per-key recovery kit. The database never
  receives their plaintext.
- A fresh passkey assertion issues a bounded 15-minute write lease before that
  shared custody history can be appended. Key creation is resumable: the next
  round/index is encrypted before contacting Sigbash, and the recovery kit is
  exported and encrypted before public registration is published.
- Browser provisioning follows the original dependency graph: each participant
  creates two pair-round keys first; round-one key creation is unavailable
  until all six pair keys exist and the exact pair vault destination can be
  pinned into the immutable round-one policy.
- A passkey-authorized live-readiness ceremony issues a random, unfunded
  outpoint for each of the nine registered participant/round keys. The browser
  independently rebuilds the allowed PSBT and three hostile variants, requires
  Sigbash to reject the hostile set, and requests one real mainnet signature.
  The server accepts a proof only after independently verifying the finalized
  policy-leaf witness and exact transaction against the confirmed roster. Only
  nine distinct successful proofs can move the vault from `roster_confirmed`
  to `ready`.
- Authenticated runtime coordination persists the exact current coin, each
  participant's direct mainnet observation, deterministic proposal digest, and
  public protocol contributions. Browser signing is implemented for Sigbash
  solo exits, two-round distributed MuSig2 cooperative exits, CSV recovery
  shares, and the final owner's sweep. Every signer rebuilds the transaction
  locally; the server re-authorizes and consensus-verifies the result; no path
  broadcasts automatically.
- After all nine proofs, each participant can register exactly one confirmed
  P2WPKH or P2TR wallet coin and change destination. The browser observes it
  through an independent mainnet source, the server resolves it independently,
  and the participant's passkey approves the exact evidence and fee. Three
  distinct approvals deterministically produce one unsigned funding PSBT that
  every browser rebuilds before any external wallet signature exists.
- Each friend returns an external-wallet PSBT containing only their own P2WPKH
  or P2TR input signature. Browser and server verify the exact unsigned
  transaction, prevout, sighash, public-key binding, and signature; the server
  retains only normalized signature material. Three signatures finalize the
  pristine PSBT, and three fresh passkey approvals bind its exact witness bytes.
- Before operator submission, any stale input, fee, or signature can be
  invalidated only by three passkeys approving the same exact ceremony-state
  fingerprint and reason. The reset archives an immutable audit event of public
  digests, then clears all old approvals and signatures atomically.
- A separate passkey broadcast ceremony binds the credential assertion to the
  exact finalized proposal digest and transaction ID. Only the solo/final
  payout owner, or a cooperative/recovery signer whose verified contribution
  is already stored, may approve it. The server submits only the stored
  consensus-verified bytes and records interrupted/failed attempts without
  silently changing the transaction.
- Initial funding has no HTTP broadcast endpoint. A private operator command
  requires the exact finalization fingerprint, authenticated owner-only
  live-Sigbash-proof and fresh release artifacts, their independently reviewed
  fingerprints, an explicit mainnet confirmation phrase, and Bitcoin Core
  `testmempoolaccept`; it submits only the unanimously approved bytes bound by
  both artifacts. A private scheduler activates that exact transaction and advances
  later protocol state only after the required confirmations.
- Database-atomic fixed-window rate limits cover unauthenticated credential
  ceremonies and authenticated unlock, Sigbash provisioning/readiness,
  proposal/signature, observation, and broadcast boundaries. Subjects are
  stored only as action-scoped SHA-256 digests; attacker-chosen invite values
  cannot create unbounded counter rows.
- Confirmed broadcast transactions can atomically spend the old coordinator
  coin, derive the exact surviving pair or final-owner coin after a solo exit,
  or close the vault after a terminal cooperative, recovery, or final sweep.
- The private watcher holds one crash-released PostgreSQL advisory lease across
  reconciliation, retry, submission, and confirmation processing. Overlapping
  scheduler invocations cannot both act and report an explicit no-op.
- Every confirmed funding and runtime transition retains its exact mainnet
  block hash and remains under watcher reconciliation. An orphaned anchor
  atomically orphans its successor and restores the prior coin; a deeply
  re-included exact transaction is reanchored. Unsigned descendants and old
  observations are invalidated, already-broadcast exact descendants remain
  tracked, and backend unavailability never triggers rollback.
- The isolated `web:test:core-reorg` release drill drives that same
  reconciliation and PostgreSQL boundary through real Bitcoin Core block
  invalidation, replacement-block re-inclusion, backend outage, and rollback.
  It adds no regtest product mode and satisfies no live-mainnet gate.
- Initial activation accepts only a confirmed transaction with three unique
  P2WPKH or P2TR inputs, each covering one committed participant deposit, and
  exactly one committed round-one output. It also bounds change/output count
  and fees before changing the vault from `ready` to `active`.

Recovery enrollment is a ten-minute, one-time server capability. Its creation
challenge is bound to the existing credential; registration is bound to the
user and enrollment and excludes every existing credential; wrapping is bound
to the exact newly registered credential. An
interrupted enrollment never marks the new passkey recovery-ready; expired
pending credentials are removed when the participant begins a fresh recovery
authorization. The server validates that the submitted public identity matches
the existing participant byte-for-byte, but—as with any browser-held secret—it
cannot prove that arbitrary client-supplied ciphertext contains that secret.
The honest client performs an AES-GCM round trip and identity check before
upload. A malicious modified client can only make its own new recovery envelope
unusable; it cannot replace the original envelope or participant identity.

The browser key derivation is cross-checked against `src/vault.ts` in
`npm run web:test`; this is the same participant identity used by the vault
core, not a second wallet model.

## Local engineering run

Requires the exact Node version in `.node-version` and Postgres. These commands
create infrastructure and test data only; they do not contact Sigbash or
Bitcoin and do not fund anything.

```bash
cp .env.example .env.local
# Set DATABASE_URL, WEBAUTHN_RP_ID, WEBAUTHN_ORIGIN, and APP_ORIGIN.
npm run web:migrate
npm run web:create-invite -- --vault-name 'Friends vault' --participant alice
npm run web:dev
```

Create one invitation per participant. To add an invitation to an existing
vault, pass `--vault-id` instead of `--vault-name`. Invitation links are bearer
secrets; send each one only to its intended friend and let it expire quickly.

## Verification

```bash
npm run web:typecheck
npm run web:test
npm run web:test:db # requires a disposable or dedicated empty PostgreSQL database
npm run web:test:browser # requires the migrated database, running web app, and Playwright Chromium
npm run web:test:browser:production # builds and exercises the optimized standalone bundle in isolation
npm run web:build
npm run web:release-status # read-only; exits nonzero until every automated gate passes
npm test
npm audit
```

The production container exposes `/api/health/live` and
`/api/health/ready`. Readiness proves only that the web process can reach the
database and sees the exact reviewed migration set. Its response always says
`fundingAuthorized: false`; only `web:release-status` evaluates the product
gates, and even that report never authorizes funding.

`web:test` currently proves encryption/decryption, wrong-passkey rejection,
authenticated-identity tamper rejection, two-credential rewrapping of the same
participant identity, passkey-shared Sigbash custody, SDK-exact credential
hashes, corrupt-revision rollback, recovery-kit/key binding, PRF-output
stripping, exact public key and BYO Sigbash-share compatibility,
offline-roster rejection, xpub/leaf binding, deterministic roster digests,
proposal replay resistance, exact confirmed-state advancement, fresh recovery
observations, no funding address or output-script disclosure before unanimity,
database-enforced one-time broadcast approvals, passkey-bound registration of
one independently observed and server-verified wallet coin per participant,
deterministic three-input funding PSBT reproduction, external P2WPKH/P2TR
signature normalization, exact finalization, unanimous restart binding, and
adversarial rejection of malformed or single-funder activation transactions.
The complete migrations through 012 have also been applied and re-applied
idempotently on an isolated PostgreSQL 16 instance. The database acceptance
test proves one-winner concurrent approval creation and submission claims,
required passkey-consumed state, globally unique funding outpoints, one
immutable funding approval and signature per seat, finalization/submission
state consistency, unanimous restart audit preservation, auditable retry after
failure, proposal-digest foreign-key binding, and atomic concurrent rate-limit
counting/reset without raw subjects. It also proves one-winner watcher leasing
and release after failure, an exact PostgreSQL schema-and-row restore copy,
paired confirmation anchors,
atomic funding and transition rollback, exact prior-coin restoration,
observation invalidation, broadcast-descendant preservation, and immutable
public-fingerprint reorganization events. The separate Bitcoin Core 31.1 drill
also proves the exact database boundary against real block invalidation,
replacement re-inclusion, and a controlled transport failure;
that is not a substitute for the selected production database and a complete
real-authenticator/backend run.

The Playwright suite runs the HTTP and PostgreSQL paths in Chromium. It covers
the inert pre-hydration surface, independent primary and recovery PRF passkeys,
and three-browser runtime ceremonies with six encrypted passkey envelopes. The
cooperative ceremony survives a reload between nonce and partial rounds,
persists only public contributions, and independently verifies the final
consensus transaction. The recovery ceremony makes two survivors independently
observe a mature coin, bind it with their passkeys, and produce separate public
shares while excluding the vanished participant. The final-sweep ceremony lets
only the payout owner observe, propose, and sign the exact one-output spend.
None broadcasts. `web:test:browser:production` creates a fresh PostgreSQL 16
cluster, builds the optimized standalone application, copies the exact static
assets used by the container, starts that bundle with production settings, and
runs the entire suite against it. This catches missing production JavaScript or
static assets that development-server acceptance cannot expose. Synthetic
public Sigbash registrations, current coins, and mainnet-shaped chain responses
are explicit test prerequisites; no Sigbash runtime or Bitcoin backend is
contacted, and virtual authenticators do not satisfy the live-service,
physical-passkey, container-image, deployment, or funding gates.

`web:release-status` is the post-deployment funding audit and prints only
non-secret gate summaries plus a non-authorizing `statusDigest`. It verifies the
declared Node runtime, HTTPS WebAuthn/RP binding, independent chain source,
explicit tiny-mainnet amount cap, funding fee, and recovery delay, current
upstream Sigbash runtime hashes, a non-local TLS PostgreSQL endpoint, an
authenticated fresh receipt proving an isolated restore exactly matched its
schema, migrations, and rows, the exact
three-member/two-passkey/nine-key/three-confirmation/nine-proof database state,
the protected live-Sigbash proof receipt and its reviewed digest, a fresh
protected exact-restore receipt, absence of a pre-funding coin, and a mainnet
Bitcoin backend. After unanimous final
transaction approval, an explicit manual-gate acknowledgement can write a
fresh owner-only release artifact. That canonical artifact binds the exact
vault, finalization digest and txid, live-proof digest, and passing checks; the
private broadcast command authenticates it and rejects tampering, unsafe paths,
mismatched bindings, future timestamps, or reports older than 30 minutes. It
still records `fundingAllowed: false`, because funding remains a later separate
human decision. The earlier
deployment gate creates that receipt through the explicit
`live-predeployment-proof` command described in `DEPLOYMENT.md`.

## Sequenced hard gates

Before deployment, `live-predeployment-proof` must return a real Sigbash
mainnet signature that the local consensus authorizer accepts. The preceding
`live-predeployment-setup` creates exactly two pair-round proof keys and does
not pre-create or stand in for the nine participant-owned product keys. Its
owner-only checkpoint and generated proof environment make the irreversible
provider setup resumable without copying credentials through the terminal;
the entire proof directory is excluded from the container build context.
After that single external capability is proven and the service is privately
deployed, the following gates remain mandatory before funding:

1. Complete the second-passkey ceremony for every participant and validate it
   with real browsers/authenticators. A synced copy of the same credential is
   convenient but does not satisfy the distinct-credential gate.
2. Run the implemented browser Sigbash key-creation/resume flow against three
   mainnet-enabled participant organizations, replacing offline leaf fixtures
   with nine service-created public registrations. The app locally creates and
   passkey-encrypts each participant's credential triplet, but Sigbash—not this
   service—must enable mainnet for each participant's displayed non-secret
   `apikeyHash`. There are three independent hashes by design; this avoids one
   friend becoming the Sigbash administrator for everybody else.
3. Execute all nine implemented browser readiness proofs against mainnet-enabled
   Sigbash organizations. A successful allowed signature is independently
   verifiable by the server; hostile rejection remains browser-observed because
   the current Sigbash API does not provide a signed negative attestation.
   Mainnet access is external and is not currently proven.
4. Validate the now-mainnet-only address, PSBT, policy, RPC, and explorer paths
   against a production-version Bitcoin Core node, including deliberately tiny
   amounts, dust/relay policy, fees, and the chosen recovery delay. The offline
   conversion is complete; real-node acceptance is not.
5. Run the database transaction flow against the chosen production Postgres
   service, then exercise all three confirmations and all nine readiness proofs
   with real authenticators. The migrations pass PostgreSQL 16 locally, but no
   real Sigbash registrations are present and the database-backed ceremony has
   not yet been run end to end.
6. Expand the seeded database and virtual-authenticator browser acceptance
   beyond the now-covered unanimous roster, cooperative MuSig2, distributed
   recovery, and owner-only final sweep to the funding-wallet and live-Sigbash
   solo surfaces without presenting local fixtures as external evidence; retain
   rate-limit, secret-free audit, backup/restore, and operational drills.
7. Exercise the implemented passkey-approved broadcast and private chain
   watcher against the selected production Bitcoin backend. Verify rejection,
   duplicate submission, interrupted submission, mempool, confirmation, and
   reorganization operations before funding.
8. Confirm the service remains behind private access control, run the full
   security checklist on the deployed HTTPS origin, and only then consider
   deliberately tiny mainnet funding.

After the nine live Sigbash proofs move the vault to `ready`, the web product
opens a real three-wallet funding ceremony. Each friend supplies one confirmed
mainnet wallet outpoint and a change address. The browser resolves that coin
from an independent mainnet source, the server separately resolves the same
unspent output, and a passkey approves the exact outpoint, value, script, total
fee, evidence source, and change destination. Only three distinct immutable
approvals can produce the canonical unsigned PSBT, which every browser rebuilds
from the confirmed roster and all three approvals. Bitcoin private keys remain
in the friends' external wallets. Each wallet signs only its own input; three
independently verified signatures finalize the pristine PSBT; and all three
friends passkey-approve its exact witness bytes. No browser action broadcasts.
The private operator release and confirmation watcher remain closed until the
external gates are genuinely met.

Do not deploy until the explicit `live-predeployment-proof` command returns a
real, locally authorized Sigbash mainnet signature. After private deployment,
do not fund until every remaining gate passes. Initial broadcast exists only as
a private Bitcoin-Core operator command guarded by the exact finalization and
review fingerprints; later user-approved broadcasts remain unavailable until
an active vault coin exists. No local, dry-run, or visual readiness result
overrides either rule.
