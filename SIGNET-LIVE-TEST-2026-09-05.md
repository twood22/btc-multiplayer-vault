# Live Signet signing investigation — 2026-09-05

This records the signing investigation before the subsequent
[provisioning/release hardening](./SIGNET-READINESS-2026-09-05.md). The application
now has a guarded SDK boundary and all nine existing Signet keys passed
read-only recovery checks. Those fixes do not establish hosted-signing success;
the failures documented here remain the latest actual signing evidence.

## Result

**The historical hosted signing failure still reproduces. No hosted signature
was obtained and no transaction was broadcast.** The user authorized live
default-global-Signet signing and broadcasts, but not mainnet activity.

These were actual Sigbash SDK/WASM/server calls, separate from the earlier
[independent local tests](./TEST-REPORT-2026-09-05.md). They do not establish a
complete browser/passkey or on-chain solo lifecycle. The game, policies, fees,
existing keys, and product implementation were not changed for this test.

| Case | Local SDK/WASM verification | Hosted signing |
| --- | --- | --- |
| Saved Alice first exit, stock SDK transport | Valid accepted; wrong amount, wrong address, extra output rejected; nullifier available | `Invalid proof bundle format: non-hexadecimal number found in fromhex() arg at position 0` |
| Same first exit, existing hex-proof wrapper | Same four checks pass; nullifier available | `server_error: Signing service error` |
| Fresh Bob second exit from Bob/Carol pair, existing wrapper | Same four checks pass; nullifier available | Same `Signing service error` |

The first-round PSBT was rebuilt byte-for-byte using the current builder,
protected original Signet seed/public key overrides, and saved economics. Its
policy also matches the current builder. The input was 30,000 sats, Alice's
payout 9,500, the continuing vault 20,200, and the fee 300.

That historical input is **already spent**, so the saved PSBT is only an error
reproducer, never a broadcast candidate. The second-round case used a fresh,
deliberately unfunded placeholder outpoint and Bob's independently registered
pair-round key. It pays Bob 10,250 sats and Carol 9,350 from a nominal 20,200-sat
input, including the existing 600-sat second-round fee. This is the real
second-round policy and builder, not a substitute product or funding receipt.

## What the evidence narrows down

- With the correct key material, policy verification works for both tested
  round shapes. The requests proceed through server nonces, `compute_server_ub`,
  local proof-witness preparation, and `blind_signing_request`.
- The stock SDK proof encoding still disagrees with the server. Removing our
  `withSigbashHexProofTransport` compatibility wrapper does not fix signing.
- With that wrapper, the same generic server exception occurs for the saved
  first-round case and a fresh second-round case. It is not limited to Alice's
  old outpoint or her first-round policy. This does **not** identify the exact
  invalid proof component or establish that all Sigbash policy types fail.
- The audit's database, browser, and custody fixes did not resolve this failure.
  Local policy satisfaction and proof generation are not evidence that the
  server accepted the zero-knowledge proof.

Provider-side exception logging is still necessary. Useful correlation windows
are 20:50:27–20:50:38 UTC (stock encoding), 20:51:15–20:51:28 UTC (wrapped first
exit), and 20:52:41–20:52:55 UTC (wrapped second exit), all on 2026-09-05.

## Additional SDK defect: concurrent key-response confusion

The initial diagnostic called `listKeys()` before `getKey()` on the same client.
This produced a wrong-policy rejection before reaching signing. Explicitly
requesting key index 2 then returned index 1 and Alice's **Alice/Carol pair**
xpub/policy root instead of her three-person-round key. The checkpoint binding
checks rejected it before any signature attempt.

SDK 0.8.0 `listKeys()` invokes multiple `getKey()` calls with `Promise.all()`.
Its `SigbashSocket.request()` attaches each pending request to the same
`get_encrypted_kmc_response` event without correlating responses. One reply can
resolve all those requests; remaining replies can satisfy a later request.
The current public [client source](https://raw.githubusercontent.com/arbedout/sigbash-sdk/main/src/SigbashClient.ts)
and [socket source](https://raw.githubusercontent.com/arbedout/sigbash-sdk/main/src/socket.ts)
contain this behavior too.

The [offline characterization](./scripts/sigbash-key-correlation-probe.mts)
uses the installed SDK's actual request method with a local event emitter:

- Requests `[0, 1, 2]` all resolve with response `[0, 0, 0]`.
- A subsequent index-2 request accepts a delayed index-1 response.
- The sequential, clean-transport control returns `[0, 1, 2]` correctly.

This is a demonstrated upstream SDK defect, **not a deployed fix**. The live
signing reproducer avoids it by using a fresh client, direct checkpointed key
retrieval, and network/index/xpub/policy-root binding. Application provisioning
still calls `listKeys()` in both the browser and CLI and needs separate
hardening and recovery-kit/resume regression coverage. Merely avoiding this
call in the diagnostic does not fix provisioning. Do not infer fund safety
from the characterization script exiting successfully: it confirms the bug.

## Runtime and chain identity

- Node 22.23.2; `@sigbash/sdk` 0.8.0; source baseline
  `71b1bd227a5f3f3d35fb8449776747d5d88d28c7` plus local audit changes.
- Hosted manifest: `sigbash_20260803_060359.wasm`, git version `d67733f0`.
- Downloaded WASM: 13,307,049 bytes, SHA-384
  `a57fa4c7172fb06dce6133832778247fb22c586d1e2ee70282ff8efa1f0e5b58a81b02dbd1d6b69e474254bc35c6945d`.
  It matches the prior failing run's integrity pin; the pin was not relaxed.
- Core 31.1 synchronized to default-global-Signet with a synchronized `txindex`.
  At 20:55:57 UTC, Core and independent mempool.space Signet observation agreed
  on height 320844 and block
  `00000005b4519cf4fb3b850e3f19dc89d61a0a958780d8f282e99dafda2f7fe4`.
  Both confirmed that the historical vault output was already spent by the
  previously documented cooperative exit.

## Evidence and reproduction

Owner-only, ignored evidence is retained under
`live-run/signet/live-diagnostic-20260905.G9QJXZ/`:

- `native-direct-summary.json` and its sanitized progress trace;
- `hex-direct-summary.json` and its sanitized progress trace;
- `hex-pair-summary.json`, sanitized trace, and `hex-pair-public-fixture.json`;
- `chain-check.json`;
- failed initial key-selection diagnostics, retained rather than hidden.

The historical policy/PSBT and stack trace remain under
`live-run/signet/evidence/2026-08-31-sigbash-signing-failure/`.
These private evidence files and credentials are not included in a clone.
Share only individually reviewed policy/PSBT and sanitized trace files, never
the protected credential files, recovery journals, decrypted KMC, or raw logs.

Offline characterization, without network or secrets:

```bash
node --import tsx scripts/sigbash-key-correlation-probe.mts
```

The [live diagnostic](./scripts/signet-live-diagnostic.mts) requires the existing
protected Signet-only files, both network variables explicitly set to `signet`,
and a fresh owner-only `live-run/signet/live-diagnostic-*` evidence directory.
Its arguments are transport (`native` or `hex`), evidence directory, unique run
label, and fixture (`saved` or `pair`). It never broadcasts, refuses mismatched
key material, and writes results without dumping SDK/KMC/proof logs.

Both new scripts passed strict standalone TypeScript checking. No new keys,
faucet claims, wallet transactions, operational database updates, GitHub writes,
deployment, mainnet actions, or physical-passkey tests occurred. The temporary
Signet node was stopped after the checks, restoring its initially stopped state.

`signetValidated: false`; `mainnetValidated: false`;
`mainnetFundingAuthorized: false`.
