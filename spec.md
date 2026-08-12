# Build Spec — Bitcoin Multiplayer Savings Vault (Demo)

> **Historical input, not the current release specification.** The user later
> explicitly required the real product to be mainnet-only. Preserve the
> round-based withdrawal game and trust boundaries below, but the signet-only
> directions are superseded. Current release gates live in
> `PASSKEY-PRODUCT.md`; no deployment or funding is allowed until live Sigbash
> mainnet signing is proven.

**Audience:** an autonomous coding agent (Claude Code / OpenAI Codex).
**Goal:** build a working **demo** of a multi-party Bitcoin savings vault with incentive-based withdrawals, using the Sigbash SDK as the policy-enforcing co-signer.
**Scope:** this is a vibe-coded demo. Keep it simple. Don't build abstraction layers, plugin systems, or upgrade paths. Make it work end-to-end on **signet** for **3 participants** and stop there. You pick the language, libraries, and structure.

---

## 1. What we're building

3 participants (Alice, Bob, Carol) each deposit **1 BTC** into a shared vault (3 BTC total). The vault rewards holding:

- **Anyone can withdraw at any time.**
- The **first** to withdraw takes a **haircut** — gets back **0.95 BTC**.
- The **second** to withdraw gets a small **bonus** — e.g. **1.025 BTC**.
- The **last** person left sweeps whatever remains — e.g. **1.025 BTC** (their deposit plus the leftover haircut).
- (Example schedule; 0.95 + 1.025 + 1.025 = 3.0. Make the numbers a config constant.)
- **Cooperative exit:** if all current participants sign together, each gets their full deposit back **with Sigbash completely uninvolved.**

---

## 2. The one rule that matters

There are two ways money leaves the vault, and they have different trust levels. Keep them separate:

1. **Cooperative exit = trust-minimized.** This is an **N-of-N MuSig2 key-path spend by the participants' own personal keys only. The Sigbash key must NOT be in the key-path.** If Sigbash is offline or hostile, the participants must still be able to all-sign and get their coins out. This is the property that makes the demo legitimate — protect it.

2. **Solo withdrawal (the haircut/bonus game) = Sigbash-enforced.** The amounts and destinations are guaranteed only because Sigbash refuses to co-sign a transaction that breaks the rules. That's fine for a demo. Just don't let it contaminate rule (1).

---

## 3. How the keys work (important — don't skip)

A **Sigbash key is a 2-of-2**: half is generated in the participant's browser (the "client share"), half lives on Sigbash's server. A signature from that key requires **both** halves, and the server half only signs if the policy is satisfied. So:

- Each participant holds: **(a)** a plain personal key (for the cooperative exit) and **(b)** the browser half of **their own** Sigbash key (for their solo withdrawal).
- Sigbash holds: the **server half** of each participant's Sigbash key. Nothing else.

Every participant gets their **own** Sigbash key. There is **no shared key** and **no counter**. Withdrawal ordering is enforced structurally (see §5), not by Sigbash-side state.

---

## 4. SDK and references

**Sigbash SDK**
- Repo: https://github.com/arbedout/sigbash-sdk
- Docs (read these): https://github.com/arbedout/sigbash-sdk/tree/main/docs
  - `getting-started.md` — setup, `loadWasm()`, how the client/server signing split works
  - `creating-keys.md` — `createKey()`, policy construction, **multisig descriptors** (`tr(...)`, `sortedmulti_a` / `multi_a`)
  - `policy-reference.md` and `policy-overview.md` — the condition vocabulary (you'll mainly use `OUTPUT_VALUE`, `OUTPUT_DEST_IS_IN_SETS`, `REQKEY`, and output-count)
  - `signing.md`, `verifying.md` — `signPSBT()`, and `verifyPSBT()` (checks policy **without** signing — good for pre-flight)
  - `error-handling.md`, `authentication.md`, `server.md` as needed
- Examples in the repo: `examples/basic-usage.js`, `examples/browser-example.html`
- Package: `@sigbash/sdk` (TypeScript, WASM-backed; call `loadWasm()` once).

**Access:** signet is the default and free; mainnet is gated to an alpha cohort. **Stay on signet.** You may need Sigbash signet credentials provisioned out-of-band — take network + credentials from injected config/env, never hardcode.

**Bitcoin references**
- MuSig2 (cooperative key-path): BIP-327
- Schnorr / Taproot: BIP-340 / BIP-341
- Taproot descriptors: BIP-386
- https://www.sigbash.com for background

Use any mature Bitcoin library you like for PSBT building, descriptors, MuSig2, and broadcast. The SDK only handles the Sigbash half of the co-signature; you build the rest of each transaction.

---

## 5. How it works, step by step

**Setup.** Each participant generates their personal key + their own Sigbash key, and registers a withdrawal address. Because each round's vault must point its leftover funds at the *next* round's vault, **precompute the whole small tree of vault addresses up front** (for 3 people it's tiny — see below). Build the round-1 vault output (§6).

**Deposit.** Each participant funds the round-1 vault address with 1 BTC. (Note: do **not** fund the helper `p2trAddress` that `createKey()` returns — that's a single-key artifact, not the multi-party vault address. The vault address is the one you derive from the full descriptor.) Vault is active once it holds 3 BTC.

**Solo withdrawal + re-vault (the core loop).** When a participant leaves, their transaction spends the **entire current vault UTXO** and creates exactly two outputs:
- **output 0:** the departing participant's payout (this round's amount) to their registered address;
- **output 1:** the **leftover**, sent to the **next round's vault** (the same vault minus the person who just left).

The departing participant signs with their Sigbash key (their browser half + Sigbash's server half, which only signs if outputs match the policy). Fees come out of the leftover so the payout amount stays exact. On signet fees are trivial.

Because each round's vault is a **single UTXO that gets fully spent on the first withdrawal**, only one person can ever take a given round's amount — the moment someone withdraws, that pot is gone and a fresh, smaller pot exists for the rest. That's the entire ordering mechanism. If two people try to withdraw at once, both transactions spend the same coin and Bitcoin confirms only one; the other is a dead double-spend. (You don't need a sequencer for a demo.)

**Last person.** When one participant remains, they sweep the final UTXO via the cooperative/key-path (now just their single signature) and receive the remainder. No Sigbash needed.

**Cooperative exit (any time).** All current participants co-sign one transaction refunding each their full deposit to their registered addresses, via the MuSig2 key-path. Sigbash is not involved. Must work with Sigbash offline.

**The address tree for 3 people** (precompute at setup):
- Round 1 vault: `{A, B, C}`, 3 BTC.
- Round 2 vault depends on who left: `{B,C}`, `{A,C}`, or `{A,B}` (3 possibilities), ~2.05 BTC.
- Round 3 is just the last person's payout address (no vault).
So you precompute 1 + 3 round-vault addresses and the registered payout addresses. Each round-1 defect policy pins output 1 to the correct round-2 vault for the remaining pair.

---

## 6. The vault output (per round)

One Taproot output per round:

- **Key-path = `MuSig2(personal keys of the current participants)`.** Cooperative exit. **No Sigbash.**
- **One Tapscript leaf per current participant = that participant's solo-withdrawal path**, satisfied by **that participant's own Sigbash key** (which is itself the 2-of-2 of their browser half + Sigbash's server half). The Sigbash key's server half won't sign unless the transaction matches that participant's withdrawal policy (§7).
- **Required safety-net leaf:** a timelocked recovery path (`older(T)`) so that if a participant disappears and the cooperative N-of-N can't complete, the rest can still recover after a delay. This is mandatory — without it, one missing participant freezes everyone's funds forever, since the cooperative exit needs all N. Keep the policy itself simple (one timelock condition), and make `T` a config constant (a short value like a few blocks is fine on signet so the demo can actually exercise it).

**Verified SDK facts that make this work** (confirmed against the SDK source — don't re-derive):
- A Sigbash key can live **inside a tapscript leaf** (not just the key-path): `REQKEY` supports `key_type: 'TAP_LEAF_XONLY_PUBKEY'`, and the docs show combining a Sigbash key with co-signers via `tr(<internal_key>, sortedmulti_a(...))` / `multi_a`.
- You can pin a **specific output's amount and address** using a selector `{ type: 'INDEX', index: N }` on `OUTPUT_VALUE` (with `operator: 'EQ'`) and on `OUTPUT_DEST_IS_IN_SETS`.

---

## 7. The Sigbash policy for one solo withdrawal

Each participant's Sigbash key gets a policy (POET) that locks down their withdrawal transaction. For Alice in round 1:

- `OUTPUT_VALUE` — output 0 **equals** 0.95 BTC. `{ selector: {type:'INDEX', index:0}, operator:'EQ', value: 95_000_000 }`
- `OUTPUT_DEST_IS_IN_SETS` — output 0 goes to **Alice's registered address**. `{ selector: {type:'INDEX', index:0}, addresses:[ALICE_ADDR], network:'signet' }`
- `OUTPUT_DEST_IS_IN_SETS` — output 1 goes to the **round-2 vault for {B,C}**. `{ selector: {type:'INDEX', index:1}, addresses:[ROUND2_BC_VAULT], network:'signet' }`
- Constrain the **leftover** with `OUTPUT_VALUE` on index 1 — use a floor (`operator:'GTE'`) so the tx fee can come out of it, e.g. ≥ 2.04 BTC. (EQ would leave no room for fees.)
- Pin the **output count to 2** so no extra outputs can be added.

Build these with `conditionConfigToPoetPolicy({ logic:'AND', conditions:[...] })`. Each round/participant has its own analogous policy with that round's amount, that participant's address, and the correct next-round vault. (Combine `verifyPSBT()` before `signPSBT()` so you can show a clean "this would/wouldn't be allowed" check.)

---

## 8. What the demo must show (acceptance)

Demonstrate all of these on signet, with a README explaining how to run each:

1. **Cooperative exit works with Sigbash turned off** — all participants sign the key-path, each gets 1 BTC back.
2. **A solo withdrawal pays exactly the right amount to exactly the registered address**, with the leftover going to exactly the next-round vault — and a tampered PSBT (wrong amount, wrong address, extra output) is **rejected** by Sigbash.
3. **Only one person can take a given round's amount** — after the first withdrawal, the round-1 pot is gone and the second withdrawer gets the round-2 amount.
4. **Full run-through:** setup → 3 deposits → first withdrawal (0.95) → second withdrawal (1.025) → last person sweeps the remainder.
5. **No Sigbash key in the cooperative key-path** — verify the key-path aggregate contains only participants' personal keys.
6. **Timelocked recovery works** — simulate a participant vanishing (cooperative N-of-N can't complete), wait past `T`, and show the remaining participants recover their funds via the recovery leaf.

---

## 9. Keep it simple

- 3 participants, signet, hardcode-ish is fine. Put the amount schedule and addresses in a small config; don't build a generic N-party engine.
- No Option B / covenants / on-chain state machines / upgrade abstractions. Not needed.
- No fancy fee logic — leftover absorbs the fee; signet fees are negligible.
- Never put keys or credentials in code or logs; read them from config/env.
- Where the docs are silent, pick whatever keeps the **cooperative exit independent of Sigbash**, and note the assumption in the README.
