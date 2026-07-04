# Bitcoin Multiplayer Savings Vault Demo

This is a signet-focused demo of the product described in `spec.md`: Alice, Bob, and Carol each deposit 1 BTC into a shared vault. Solo withdrawals are incentive-based and policy-enforced by a Sigbash co-signer, while cooperative exits use only the participants' personal keys.

The checked-in demo runs in `SIGBASH_MODE=local` by default. Local mode does not broadcast Bitcoin transactions and does not ask Sigbash to sign; it builds the vault tree, signet Taproot addresses, policies, PSBT-like transaction objects, and verifies the same policy constraints locally so the full workflow is runnable without credentials. The Sigbash integration point is isolated in `src/sigbash.js`.

## Requirements

- Node.js 20 or newer
- Signet credentials only if you switch to live Sigbash mode

## Run

```bash
npm test
```

Useful individual demos:

```bash
npm run setup
npm run cooperative
npm run solo
npm run recovery
npm run signed-local-run
npm run signed-local-run -- --txid <round1_txid> --vout <n> --value-sats 300000000
npm run funding-manifest
npm run watch-manifest
npm run rpc-import-watchonly
npm run vault-output -- --round bob,carol
npm run funding-psbt -- --inputs-json '[{"participantId":"alice","txid":"<txid>","vout":0,"valueSats":100002000,"scriptPubKeyHex":"<hex>","changeAddress":"<tb1...>"},{"participantId":"bob","txid":"<txid>","vout":0,"valueSats":100002000,"scriptPubKeyHex":"<hex>","changeAddress":"<tb1...>"},{"participantId":"carol","txid":"<txid>","vout":0,"valueSats":100002000,"scriptPubKeyHex":"<hex>","changeAddress":"<tb1...>"}]' --fee-sats 3000
npm run solo-psbt -- --round alice,bob,carol --leaver alice --txid <txid> --vout 0 --value-sats 300000000
npm run sign-solo-psbt -- --round alice,bob,carol --leaver alice --psbt-base64 <base64>
npm run cooperative-psbt -- --round alice,bob,carol --txid <txid> --vout 0 --value-sats 300000000
npm run sign-cooperative-psbt -- --round alice,bob,carol --psbt-base64 <base64>
npm run recovery-psbt -- --round alice,bob,carol --vanished carol --txid <txid> --vout 0 --value-sats 300000000
npm run sign-recovery-psbt -- --round alice,bob,carol --vanished carol --psbt-base64 <base64>
npm run final-sweep-psbt -- --participant carol --txid <txid> --vout 1 --value-sats 102497000
npm run sign-final-sweep-psbt -- --participant carol --psbt-base64 <base64>
npm run policy-check-psbt -- --participant alice --psbt-base64 <base64>
npm run inspect-psbt -- --psbt-base64 <base64>
npm run psbt-acceptance
npm run rpc-gettxout -- --txid <txid> --vout 0
npm run verify-vault-utxo -- --txid <txid> --vout 0 --round alice,bob,carol
npm run cooperative-readiness -- --txid <txid> --vout 0 --round alice,bob,carol
npm run recovery-readiness -- --txid <txid> --vout 0 --round alice,bob,carol --vanished carol
npm run live-readiness
npm run live-acceptance-evidence
npm run rpc-walletprocesspsbt -- --psbt-base64 <base64>
npm run rpc-combinepsbt -- --psbts <base64_a>,<base64_b>
npm run rpc-finalizepsbt -- --psbt-base64 <base64>
npm run rpc-testmempoolaccept -- --hex <signed_tx_hex>
npm run rpc-submit -- --psbt-base64 <signed_psbt>
npm run rpc-submit -- --hex <signed_tx_hex>
npm run rpc-broadcast -- --hex <signed_tx_hex>
npm run rpc-tx-status -- --txid <txid>
npm run rpc-find-output -- --txid <txid> --round bob,carol
npm run live-solo-withdrawal -- --round alice,bob,carol --leaver alice --txid <txid> --vout 0
npm run live-solo-tamper-check -- --round alice,bob,carol --leaver alice --txid <txid> --vout 0
npm run live-run-audit -- --funding-txid <txid> --first-txid <txid> --second-txid <txid> --final-txid <txid> --first-leaver alice --second-leaver bob --min-confirmations 1
npm run live-solo-audit -- --txid <solo_txid> --vault-txid <vault_txid> --vault-vout 0 --round alice,bob,carol --leaver alice --value-sats 300000000 --min-confirmations 1
npm run live-cooperative-audit -- --txid <txid> --vault-txid <txid> --vault-vout 0 --round alice,bob,carol --min-confirmations 1
npm run live-recovery-audit -- --txid <txid> --vault-txid <txid> --vault-vout 0 --round alice,bob,carol --vanished carol --value-sats 300000000 --min-confirmations 1
npm run live-final-sweep-audit -- --txid <txid> --payout-txid <txid> --payout-vout 0 --participant carol --value-sats 102497000 --min-confirmations 1
npm run audit
npm run sdk-policy-check
npm run demo
```

## What The Demo Shows

- `setup` prints deterministic demo participants, registered payout addresses, Sigbash leaf keys, and the precomputed round vault tree.
- `cooperative` spends the current vault through the Sigbash-free key-path model. The key-path manifest contains only personal keys.
- `solo` has Alice take the first 0.95 BTC payout and re-vaults the leftover to the `{Bob,Carol}` vault. Wrong amount, wrong address, and extra-output PSBTs are rejected before signing.
- `full-run` runs setup, three deposits, first withdrawal, second withdrawal, and final sweep. The round-1 double-spend attempt fails because the coin has already been spent.
- `recovery` simulates Carol vanishing, waits past `RECOVERY_DELAY_BLOCKS`, and lets Alice and Bob sign via the timelocked recovery leaf.
- `signed-local-run` builds, policy-checks, signs, finalizes, and extracts raw transactions for Alice's first withdrawal, Bob's second withdrawal, and Carol's final sweep using deterministic local keys. Without args it uses a placeholder funding txid for local extraction; pass `--txid`, `--vout`, and `--value-sats 300000000` to assemble the chain from a real funded round-one vault outpoint.
- `funding-manifest` prints the signet vault addresses, scriptPubKeys, tapscript leaves, and transaction output templates needed to build real funding and withdrawal PSBTs.
- `watch-manifest` prints `addr()` descriptors for the round-one and round-two vault addresses. `rpc-import-watchonly` resolves descriptor checksums through Bitcoin Core and imports those watch-only descriptors into the wallet selected by `BITCOIN_RPC_URL`; this helps discover funded vault outputs without exposing spend keys.
- `vault-output` prints the expected address, scriptPubKey, and amount for a selected round vault without requiring Bitcoin Core.
- `funding-psbt` builds an unsigned funding PSBT from one input per participant and creates exactly one 3 BTC round-one vault output, plus optional change outputs.
- `solo-psbt` builds an unsigned script-path PSBT for a given vault UTXO, selected round, and leaver.
- `sign-solo-psbt` runs local policy preflight, signs, validates, finalizes, and extracts the solo withdrawal transaction with the deterministic local Sigbash leaf key model. In live mode, use `sigbash-sign-psbt` so Sigbash enforces the policy with the real server share.
- `sigbash-sign-psbt` calls live Sigbash `verifyPSBT()` and `signPSBT()`, then prints normalized `txHex` and `signedPsbtBase64` fields when the SDK returns them. Use `txHex` directly with `rpc-submit`; use `signedPsbtBase64` for multi-party PSBT finalization when no final transaction hex is returned.
- `cooperative-psbt` builds an unsigned key-path PSBT refunding all current participants 1 BTC each. If you need a miner fee while preserving exact refunds, pay it with an additional funding input in your wallet flow.
- `sign-cooperative-psbt` signs, validates, finalizes, and extracts a cooperative key-path transaction with a deterministic local aggregate signature over the participants' personal keys. Sigbash is not involved.
- `recovery-psbt` builds an unsigned timelocked recovery PSBT with transaction version 2, `nSequence = RECOVERY_DELAY_BLOCKS`, and the recovery tapscript leaf. Recovery leaves require an `N-1` threshold of the current participants' personal keys after the delay.
- `sign-recovery-psbt` signs, validates, finalizes, and extracts the timelocked recovery transaction with the deterministic local personal keys for the remaining participants. It uses the recovery tapscript leaf and does not contact Sigbash.
- `final-sweep-psbt` builds the last participant's unsigned key-path sweep from their final payout UTXO. Sigbash is not involved.
- `sign-final-sweep-psbt` signs, validates, finalizes, and extracts the final participant sweep transaction with the deterministic local payout key. It is a real single-key Taproot signature path and does not contact Sigbash.
- `policy-check-psbt` runs a local preflight of a real PSBT's outputs and tapscript leaf against the selected participant's Sigbash policy model.
- `inspect-psbt` decodes a base64 PSBT and prints its inputs, outputs, Taproot leaf metadata, and witness UTXO data.
- `psbt-acceptance` builds and inspects representative solo, cooperative, and recovery PSBTs and checks their structural requirements.
- `rpc-gettxout`, `rpc-decode-tx`, `rpc-testmempoolaccept`, `rpc-submit`, `rpc-broadcast`, `rpc-tx-status`, and `rpc-find-output` use Bitcoin Core signet RPC so you can inspect chain data, preflight a signed transaction, broadcast it, verify confirmations, and locate the exact output index for the next PSBT. `rpc-submit` finalizes a complete PSBT when needed, runs `testmempoolaccept`, and only broadcasts if mempool policy accepts it.
- `live-solo-withdrawal` fetches a live vault outpoint, verifies it matches the selected round, builds the solo withdrawal PSBT, runs local policy preflight, and in `SIGBASH_MODE=live` calls Sigbash `verifyPSBT()` and `signPSBT()`.
- `live-solo-tamper-check` fetches a live vault outpoint, builds the valid solo PSBT plus wrong-amount, wrong-address, and extra-output variants, then calls live Sigbash `verifyPSBT()` to prove the valid PSBT is accepted and each tampered variant is rejected without consuming a signing nullifier.
- `live-run-audit` checks a broadcast funding/withdrawal sequence against the spec: three funding inputs of at least 1 BTC, the round-one vault output, first withdrawal spending that output, round-two re-vault, second withdrawal spending the round-two output, second payout, last participant remainder, optional final sweep key-path witness, and transaction confirmations. When Bitcoin Core does not include input `prevout` data, it falls back to fetching the previous transactions to verify funding input values.
- `live-solo-audit` checks one broadcast solo withdrawal: it must spend the selected vault outpoint, have exactly two outputs, pay and re-vault the expected amounts, satisfy the leftover floor, and pass the local Sigbash policy model.
- `live-cooperative-audit` checks a broadcast cooperative exit: it must spend the selected vault outpoint with a Taproot key-path witness and refund all current participants exactly 1 BTC each with the Sigbash-free key path model.
- `live-recovery-audit` checks a broadcast recovery transaction: it must spend the selected vault outpoint with BIP68 enabled, the CSV sequence, the recovery signer threshold model, and the configured recovery outputs.
- `live-final-sweep-audit` checks a broadcast final sweep: it must spend the selected payout outpoint with a Taproot key-path witness and send the remainder to the last participant without Sigbash.
- `verify-vault-utxo` fetches a live outpoint with `gettxout` and checks that the scriptPubKey, address, and amount exactly match the derived vault for the selected round. Round-one expects 3 BTC; round-two expects the first-withdrawal leftover after the configured fee.
- `cooperative-readiness` checks that a live vault UTXO matches the selected round and that the cooperative key path requires only current participants' personal keys.
- `recovery-readiness` checks that a live vault UTXO matches the selected round, has enough confirmations for `older(RECOVERY_DELAY_BLOCKS)`, and that the remaining participants satisfy the recovery threshold.
- `live-readiness` checks Sigbash environment values, the installed SDK policy builder, Bitcoin Core signet RPC connectivity, and optionally a funded round-one UTXO with `--txid` and `--vout`.
- `live-acceptance-evidence` prints the command checklist that maps each `spec.md` acceptance item to the live audit/readiness command that proves it. Pass known txids/outpoints to see which evidence items are ready to run and which arguments are still missing.
- `rpc-walletprocesspsbt`, `rpc-combinepsbt`, and `rpc-finalizepsbt` hand unsigned or partially signed PSBTs to Bitcoin Core wallets for signing, merging, and final extraction.
- `audit` checks the static spec invariants: 3 participants, 1 + 3 vault tree, signet Taproot vault addresses, one Sigbash policy per participant, two-output solo branches, leaf-key requirements, recovery leaves, and no Sigbash key-path keys.
- `sdk-policy-check` passes each participant's OR-composed Sigbash policy through the installed `@sigbash/sdk` policy builder.

## Live Sigbash Mode

Set these values in `.env` or your shell:

```bash
SIGBASH_MODE=live
SIGBASH_SERVER_URL=https://www.sigbash.com
SIGBASH_API_KEY=...
SIGBASH_USER_KEY=...
SIGBASH_SECRET_KEY=...
SIGBASH_WASM_URL=https://www.sigbash.com/sigbash.wasm
```

Install dependencies:

```bash
npm install
```

Live mode uses `@sigbash/sdk` calls for `loadWasm()`, `SigbashClient`, `conditionConfigToPoetPolicy()`, `verifyPSBT()`, and `signPSBT()` when available. The local model now composes one OR policy per participant's Sigbash key, with one branch for each possible round where that participant may leave.

To provision Sigbash keys for the live demo:

```bash
SIGBASH_MODE=live npm run sigbash-live-setup
```

That command creates one updateable Sigbash key per participant using the deterministic browser-share keys from this demo, collects the returned aggregate pubkeys, rebuilds the vault tree with those aggregate pubkeys as tapscript leaf keys, and updates each Sigbash key to the final OR policy. Do not fund anything until the final policy updates succeed. The helper `p2trAddress` values printed by Sigbash are included only for auditability and must not be funded.

This uses Sigbash updateable policies to solve the setup circularity: vault addresses need the Sigbash aggregate leaf keys, while the final policies need to pin those vault addresses. Sigbash documents a signing cooldown after policy updates, so expect to wait before exercising a just-updated live key.

After live setup, export the printed values into your shell before running manifest or PSBT commands:

```bash
SIGBASH_KEY_ID_ALICE=...
SIGBASH_KEY_ID_BOB=...
SIGBASH_KEY_ID_CAROL=...
SIGBASH_LEAF_ALICE=...
SIGBASH_LEAF_BOB=...
SIGBASH_LEAF_CAROL=...
```

Build a solo withdrawal PSBT from the confirmed vault UTXO:

```bash
npm run funding-psbt -- --inputs-json '[{"participantId":"alice","txid":"<alice_txid>","vout":0,"valueSats":100002000,"scriptPubKeyHex":"<alice_script>","changeAddress":"<alice_change>"},{"participantId":"bob","txid":"<bob_txid>","vout":0,"valueSats":100002000,"scriptPubKeyHex":"<bob_script>","changeAddress":"<bob_change>"},{"participantId":"carol","txid":"<carol_txid>","vout":0,"valueSats":100002000,"scriptPubKeyHex":"<carol_script>","changeAddress":"<carol_change>"}]' --fee-sats 3000
```

Sign/finalize that funding PSBT with the participants' wallets, broadcast it, then use its single vault output as `<round1_txid>:<n>`.

```bash
npm run rpc-find-output -- --txid <round1_txid> --round alice,bob,carol
```

Verify the confirmed output before asking Sigbash to sign any withdrawal:

```bash
npm run verify-vault-utxo -- --txid <round1_txid> --vout <n> --round alice,bob,carol
npm run cooperative-readiness -- --txid <round1_txid> --vout <n> --round alice,bob,carol
SIGBASH_MODE=live npm run live-readiness -- --txid <round1_txid> --vout <n>
```

If a participant disappears, wait at least `RECOVERY_DELAY_BLOCKS` confirmations on the vault UTXO before building the recovery PSBT:

```bash
npm run recovery-readiness -- --txid <vault_txid> --vout <n> --round alice,bob,carol --vanished carol
npm run recovery-psbt -- --round alice,bob,carol --vanished carol --txid <vault_txid> --vout <n> --value-sats 300000000
npm run sign-recovery-psbt -- --round alice,bob,carol --vanished carol --psbt-base64 <base64_from_recovery_psbt>
```

```bash
npm run solo-psbt -- --round alice,bob,carol --leaver alice --txid <round1_txid> --vout <n> --value-sats 300000000
npm run policy-check-psbt -- --participant alice --psbt-base64 <solo_psbt>
npm run sign-solo-psbt -- --round alice,bob,carol --leaver alice --psbt-base64 <solo_psbt>
```

Then dry-run and ask Sigbash to sign Alice's PSBT:

```bash
SIGBASH_MODE=live npm run sigbash-sign-psbt -- --participant alice --psbt-base64 <base64>
SIGBASH_MODE=live npm run live-solo-withdrawal -- --round alice,bob,carol --leaver alice --txid <round1_txid> --vout <n>
SIGBASH_MODE=live npm run live-solo-tamper-check -- --round alice,bob,carol --leaver alice --txid <round1_txid> --vout <n>
```

These commands call `verifyPSBT()` before `signPSBT()` so policy failures surface before a real signing attempt. `live-solo-tamper-check` uses `verifyPSBT()` only; it checks the valid PSBT and the tampered variants without asking Sigbash to sign.

If Sigbash returns `txHex`, dry-run and broadcast it directly:

```bash
npm run rpc-testmempoolaccept -- --hex <txHex_from_sigbash_output>
npm run rpc-submit -- --hex <txHex_from_sigbash_output>
```

If Sigbash only returns `signedPsbtBase64`, merge it with any participant-signed PSBT fragments, then finalize it through Bitcoin Core:

```bash
npm run rpc-combinepsbt -- --psbts <sigbash_signed_psbt>,<participant_signed_psbt>
npm run rpc-finalizepsbt -- --psbt-base64 <combined_psbt>
```

After the second withdrawal confirms to the last participant's payout address, build the final sweep PSBT:

```bash
npm run final-sweep-psbt -- --participant carol --txid <second_withdrawal_txid> --vout <n> --value-sats <remaining_sats>
npm run sign-final-sweep-psbt -- --participant carol --psbt-base64 <base64_from_final_sweep_psbt>
npm run rpc-walletprocesspsbt -- --psbt-base64 <final_sweep_psbt>
npm run rpc-finalizepsbt -- --psbt-base64 <wallet_signed_psbt>
```

After all required signatures are attached and the transaction is finalized by your wallet/PSBT tooling, or after `sign-final-sweep-psbt` extracts the final sweep transaction, broadcast with:

```bash
npm run rpc-testmempoolaccept -- --hex <signed_tx_hex>
npm run rpc-submit -- --hex <signed_tx_hex>
npm run rpc-submit -- --psbt-base64 <complete_signed_psbt>
npm run rpc-broadcast -- --hex <signed_tx_hex>
npm run rpc-tx-status -- --txid <broadcast_txid>
npm run rpc-find-output -- --txid <broadcast_txid> --round bob,carol
```

Once the funding transaction and two withdrawal transactions are broadcast, audit the live sequence:

```bash
npm run live-run-audit -- --funding-txid <round1_txid> --first-txid <first_withdrawal_txid> --second-txid <second_withdrawal_txid> --final-txid <final_sweep_txid> --first-leaver alice --second-leaver bob --min-confirmations 1
```

To see the full acceptance evidence checklist for `spec.md` section 8:

```bash
npm run live-acceptance-evidence -- --funding-txid <round1_txid> --first-txid <first_withdrawal_txid> --second-txid <second_withdrawal_txid> --final-txid <final_sweep_txid> --cooperative-txid <cooperative_exit_txid> --cooperative-vault-txid <vault_txid> --cooperative-vault-vout <n> --solo-vault-txid <round1_txid> --solo-vault-vout <n> --solo-txid <first_withdrawal_txid> --recovery-vault-txid <vault_txid> --recovery-vault-vout <n> --recovery-txid <recovery_txid> --recovery-value-sats 300000000 --min-confirmations 1
npm run live-acceptance-evidence -- --strict --funding-txid <round1_txid> --first-txid <first_withdrawal_txid> --second-txid <second_withdrawal_txid> --final-txid <final_sweep_txid> --cooperative-txid <cooperative_exit_txid> --cooperative-vault-txid <vault_txid> --cooperative-vault-vout <n> --solo-vault-txid <round1_txid> --solo-vault-vout <n> --solo-txid <first_withdrawal_txid> --recovery-vault-txid <vault_txid> --recovery-vault-vout <n> --recovery-txid <recovery_txid> --recovery-value-sats 300000000 --min-confirmations 1
```

To audit one solo withdrawal immediately after broadcast:

```bash
npm run live-solo-audit -- --txid <solo_txid> --vault-txid <vault_txid> --vault-vout <n> --round alice,bob,carol --leaver alice --value-sats 300000000 --min-confirmations 1
```

For a cooperative exit, audit the broadcast transaction against the vault outpoint:

```bash
npm run live-cooperative-audit -- --txid <cooperative_exit_txid> --vault-txid <vault_txid> --vault-vout <n> --round alice,bob,carol --min-confirmations 1
```

For recovery, audit the broadcast transaction against the delayed vault outpoint:

```bash
npm run live-recovery-audit -- --txid <recovery_txid> --vault-txid <vault_txid> --vault-vout <n> --round alice,bob,carol --vanished carol --value-sats 300000000 --min-confirmations 1
```

For the final sweep, audit the broadcast transaction against the last participant's payout outpoint:

```bash
npm run live-final-sweep-audit -- --txid <final_sweep_txid> --payout-txid <second_withdrawal_txid> --payout-vout <n> --participant carol --value-sats <remaining_sats> --min-confirmations 1
```

Bitcoin Core defaults assume signet RPC at `http://127.0.0.1:38332`; override with `BITCOIN_RPC_URL`, `BITCOIN_RPC_USER`, and `BITCOIN_RPC_PASSWORD`.
Live audit commands require at least one confirmation by default. Use `--min-confirmations 0` only when intentionally checking mempool visibility before final acceptance evidence.
`live-acceptance-evidence --strict` exits nonzero until every required live txid/outpoint argument is present.

Important: never fund the helper `p2trAddress` returned by `createKey()`. Fund the vault address derived from the full descriptor/tree printed by this demo.

## Design Notes

- Cooperative exit uses a coefficient-weighted, BIP-327-style key aggregation over the current participants' personal x-only pubkeys. Sigbash pubkeys are kept out of the key-path and are present only in tapscript leaves.
- Each participant has one Sigbash policy in the demo model. That policy is an OR across the three valid branch policies for that participant.
- Solo withdrawals spend the whole current vault UTXO and create exactly two outputs: payout at index 0 and the next vault at index 1. Fees come out of the leftover.
- The signet funding transaction should create one 3 BTC output to the round-one vault. If Alice, Bob, and Carol each contribute separately, combine those inputs into that single output before starting the withdrawal game; the ordering mechanism depends on a single spent coin.
- Ordering does not require a Sigbash counter. The spent vault UTXO is the ordering primitive; a second transaction for the same round fails as a double-spend.
- Recovery is a separate timelocked tapscript leaf with `older(RECOVERY_DELAY_BLOCKS)` plus an `N-1` threshold over the current participants' personal keys. It is still independent of Sigbash, but it is not spendable by arbitrary third parties after the delay.

## Assumption

This repository uses deterministic local signers for demo-mode extraction of solo, recovery, final-sweep, and cooperative transactions. The cooperative signer follows the repo's coefficient-weighted aggregate and Taproot tweak model, but it is still a local demo signer, not an interactive production MuSig2 nonce-exchange implementation. Live solo withdrawals should use Sigbash, and a production cooperative wallet should replace the deterministic local signer with a hardened MuSig2 signing flow.
