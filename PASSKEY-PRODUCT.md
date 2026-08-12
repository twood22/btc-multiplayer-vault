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
- A separate passkey broadcast ceremony binds the credential assertion to the
  exact finalized proposal digest and transaction ID. Only the solo/final
  payout owner, or a cooperative/recovery signer whose verified contribution
  is already stored, may approve it. The server submits only the stored
  consensus-verified bytes and records interrupted/failed attempts without
  silently changing the transaction.
- A private scheduler entry point resumes only previously passkey-approved
  submissions and advances protocol state only when the configured mainnet
  backend returns the exact stored bytes with a confirmed block height.
- Database-atomic fixed-window rate limits cover unauthenticated credential
  ceremonies and authenticated unlock, Sigbash provisioning/readiness,
  proposal/signature, observation, and broadcast boundaries. Subjects are
  stored only as action-scoped SHA-256 digests; attacker-chosen invite values
  cannot create unbounded counter rows.
- Confirmed broadcast transactions can atomically spend the old coordinator
  coin, derive the exact surviving pair or final-owner coin after a solo exit,
  or close the vault after a terminal cooperative, recovery, or final sweep.

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

Requires Node 22 and Postgres. These commands create infrastructure and test
data only; they do not contact Sigbash or Bitcoin and do not fund anything.

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
npm run web:build
npm test
npm audit
```

`web:test` currently proves encryption/decryption, wrong-passkey rejection,
authenticated-identity tamper rejection, two-credential rewrapping of the same
participant identity, passkey-shared Sigbash custody, SDK-exact credential
hashes, corrupt-revision rollback, recovery-kit/key binding, PRF-output
stripping, exact public key and BYO Sigbash-share compatibility,
offline-roster rejection, xpub/leaf binding, deterministic roster digests,
proposal replay resistance, exact confirmed-state advancement, fresh recovery
observations, no funding address or output-script disclosure before unanimity,
and database-enforced one-time broadcast approvals. The complete migrations
through 008 have also been applied and re-applied idempotently on an isolated
PostgreSQL 16 instance. The database acceptance test proves one-winner
concurrent approval creation and submission claims, required passkey-consumed
state, auditable retry after failure, proposal-digest foreign-key binding, and
atomic concurrent rate-limit counting/reset without raw subject storage;
that is not a substitute for the selected production database and a complete
real-authenticator/backend run.

## Hard gates before deployment or funding

1. Complete the second-passkey ceremony for every participant and validate it
   with real browsers/authenticators. A synced copy of the same credential is
   convenient but does not satisfy the distinct-credential gate.
2. Run the implemented browser Sigbash key-creation/resume flow against three
   mainnet-enabled participant organizations, replacing offline leaf fixtures
   with nine service-created public registrations.
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
6. Expand the seeded database integration test from broadcast approval to the
   full roster/signing lifecycle; add automated WebAuthn browser tests with
   virtual authenticators and PRF support,
   rate limiting, audit events that never contain secrets, backup/restore
   drills, and operational monitoring.
7. Exercise the implemented passkey-approved broadcast and private chain
   watcher against the selected production Bitcoin backend. Verify rejection,
   duplicate submission, interrupted submission, mempool, confirmation, and
   reorganization operations before funding.
8. Deploy behind private access control, run the full security checklist on the
   deployed HTTPS origin, and only then allow deliberately tiny mainnet funding.

Until every gate passes, do not deploy or fund the product. The broadcast
server path remains unreachable without an active vault coin, which itself can
only be recorded after all nine live Sigbash readiness proofs. No local success
or visual readiness overrides that rule.
