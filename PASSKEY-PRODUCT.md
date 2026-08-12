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
- Strict CSP with request nonces and no third-party scripts or network origins.
- A recovery-passkey ceremony that first unlocks with an existing credential,
  registers a distinct credential, and encrypts the exact same participant
  secret under a credential-specific PRF salt and authenticated envelope. Either
  completed passkey can subsequently sign in and unlock the same identity.

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
npm run web:build
npm test
npm audit
```

`web:test` currently proves encryption/decryption, wrong-passkey rejection,
authenticated-identity tamper rejection, two-credential rewrapping of the same
participant identity, PRF-output stripping, and exact public key compatibility
with the existing vault core.

## Hard gates before deployment or funding

1. Complete the second-passkey ceremony for every participant and validate it
   with real browsers/authenticators. A synced copy of the same credential is
   convenient but does not satisfy the distinct-credential gate.
2. Integrate live Sigbash key creation into each participant's passkey session,
   replacing offline leaf fixtures with service-created public leaf material.
3. Prove an actual live Sigbash mainnet solo signature and hostile-PSBT rejection
   against the exact SDK/server contract. Mainnet access is external and is not
   currently proven.
4. Validate the now-mainnet-only address, PSBT, policy, RPC, and explorer paths
   against a production-version Bitcoin Core node, including deliberately tiny
   amounts, dust/relay policy, fees, and the chosen recovery delay. The offline
   conversion is complete; real-node acceptance is not.
5. Add the three-person roster ceremony: everyone independently confirms the
   same personal keys, payout keys, Sigbash leaves, policies, vault tree, and
   funding address before the address can be copied or funded.
6. Wire browser-unlocked secrets to the already-authorized MuSig2, independent
   recovery-share, and final-sweep operations without exporting secrets to the
   server.
7. Add database integration tests against the production Postgres version,
   automated WebAuthn browser tests with virtual authenticators and PRF support,
   rate limiting, audit events that never contain secrets, backup/restore
   drills, and operational monitoring.
8. Deploy behind private access control, run the full security checklist on the
   deployed HTTPS origin, and only then allow deliberately tiny mainnet funding.

Until every gate passes, the product must keep funding and broadcast controls
absent. No local success or visual readiness overrides that rule.
