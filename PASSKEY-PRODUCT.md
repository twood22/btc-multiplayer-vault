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
authenticated-identity tamper rejection, PRF-output stripping, and exact public
key compatibility with the existing vault core.

## Hard gates before deployment or funding

1. Add a second passkey or offline encrypted recovery kit for every participant.
   A synced passkey is convenient but is not an adequate sole recovery plan.
2. Integrate live Sigbash key creation into each participant's passkey session,
   replacing offline leaf fixtures with service-created public leaf material.
3. Prove an actual live Sigbash mainnet solo signature and hostile-PSBT rejection
   against the exact SDK/server contract. Mainnet access is external and is not
   currently proven.
4. Convert all Bitcoin network configuration, address parsing, policy network
   fields, RPC/explorer calls, fee assumptions, and acceptance checks from
   signet to mainnet. A UI label is not a network conversion.
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
