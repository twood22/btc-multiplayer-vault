# Independent follow-up testing — 2026-09-05

This is the earlier independent-agent test checkpoint. For subsequent guarded
SDK live-key recovery, compiler, release, and build-profile verification, see
[SIGNET-READINESS-2026-09-05.md](./SIGNET-READINESS-2026-09-05.md).

Target: commit `71b1bd227a5f3f3d35fb8449776747d5d88d28c7` plus the local
changes documented in [the code review](./CODE-REVIEW-2026-09-05.md).
The user requested independent testing after the fixes. Three separate agents
tested transaction state, custody, and browsers; the primary agent reviewed
their probes/results and ran core, web, network, and Bitcoin Core checks.

## Result

This report covers the independent local-testing checkpoint. The later,
separately authorized [live Signet investigation](./SIGNET-LIVE-TEST-2026-09-05.md)
did contact Sigbash, reproduced the hosted signing failure, and demonstrated an
upstream SDK key-response defect. It did not broadcast or validate the full
lifecycle. Those later findings do not change which local tests passed here.

All final test runs passed. No new application defect was demonstrated.
No production code or shared test files were changed during this follow-up.
One-off probes and their logs were preserved privately, and scratch probe files
were removed from the repository. All disposable test services were stopped.
No live Sigbash calls, operational database changes, deployment, GitHub writes,
or real-fund transactions occurred.

| Test area | Executed coverage | Result |
| --- | --- | --- |
| Core and network | `npm test` under Signet and mainnet configuration; both network-acceptance profiles; web acceptance on Signet; final web typecheck | Pass |
| Transaction state | Funding-submission and runtime-liveness database regressions, each repeated twice per profile; independent concurrent expired-claim probe once per profile: 10 executions total | Pass |
| Custody | Existing 8 passkey and 6 custody checks per profile, plus 6 independent database/cryptographic boundary groups per profile | Pass |
| Browser | Fresh database migrations/full database suite, optimized Signet build, all 6 standard scenarios, plus one independent proposal-consent/expiry scenario | Pass |
| Core reorganization | Bitcoin Core 31.1 and PostgreSQL 16.14: stable anchors, orphaned-block lookup outage, re-inclusion/reanchoring, rollback to mempool | Pass |

## Independently added probes

- **Competing funding retries:** held two operator lookups until both had read
  the same expired, microsecond-precision claim. Exactly one acquired ownership
  and sent. An unavailable acknowledgement kept funding restart-locked; lookup
  of the exact transaction recovered it without another send.
- **Custody boundaries:** rejected cross-vault assertions, consumed-challenge
  replay with zero counters, cross-user leases, and substituted AAD identity or
  revision fields. Failed writes did not consume valid capacity. Concurrent
  primary/recovery leases produced only one next revision; 12-write and expiry
  limits held. A recovery PRF decrypted the participant secret and all 32 actual
  encrypted snapshots, while revision 33 remained blocked. Ciphertext/tag/context
  corruption failed; corrupt-newest history recovered revision 31, and entirely
  corrupted history returned no bundle.
- **Browser consent:** completed browser-held three-participant MuSig2 with a
  competing solo proposal. Consent cleared on proposal switches and explicit
  refresh. An expired selection lost its broadcast controls and fell back to
  the participant's solo proposal. The focused run collected no uncaught page
  errors or error-level console messages, Sigbash requests, or broadcast approvals.

## Test corrections, not application fixes

The first additional browser probe incorrectly expected a runtime read to persist
an `expired` status. Source review confirmed reads filter expired proposals;
proposal creation separately marks abandoned rows `stale`. The UI checks already
passed. The corrected test checked elapsed expiry, available actions, and absent
broadcast approval; it passed against a fresh database. Both runs were retained.

Initial custody-probe migration setup required a reserved PostgreSQL connection.
That was isolated probe setup, not a failure of the application's migration runner.

## Reproduction and evidence

Use the pinned Node 22.23.2 runtime. Existing reproducible entrypoints include:

```bash
VAULT_NETWORK=signet NEXT_PUBLIC_VAULT_NETWORK=signet npm test
VAULT_NETWORK=mainnet NEXT_PUBLIC_VAULT_NETWORK=mainnet npm test
VAULT_NETWORK=signet NEXT_PUBLIC_VAULT_NETWORK=signet npm run web:test
npm run network-acceptance:all
VAULT_NETWORK=signet NEXT_PUBLIC_VAULT_NETWORK=signet npm run web:test:browser:production
VAULT_NETWORK=mainnet NEXT_PUBLIC_VAULT_NETWORK=mainnet npm run web:test:core-reorg
npm run web:typecheck
```

The browser and Core harnesses create their own disposable databases. Do not
point database-only acceptance commands at an operational database. The Core
drill uses an isolated regtest node, not the application's public-network RPC.

Owner-only local evidence directories, outside Git:

- `/tmp/btc-vault-independent-tests.OmADzs`: primary-agent test logs.
- `/tmp/btc-vault-agent-transactions.00QWGL`: ten state-test logs and concurrent-claim probe source.
- `/tmp/btc-vault-custody-boundaries.eDStdg`: both custody-probe logs, exact source, and rerun instructions.
- `/tmp/btc-vault-browser-retest.AzhAyM`: browser logs, original failed-probe evidence, corrected result, exact spec, and rerun instructions.

These are local temporary evidence paths, not published artifacts or permanent
CI coverage for the one-off probes.

## Limits

The browser tests use virtual authenticators; some database stores receive
synthetic already-verified assertions. Provider registrations and chain/RPC
prerequisites are explicitly synthetic. Full 32-revision custody decryption was
tested at the cryptographic/database boundary, not through a complete browser UI.

The Core drill uses actual node confirmations and reorgs, but seeds synthetic
vault bookkeeping around a local wallet transaction. It does not prove that Core
accepted a real multiplayer-vault spend or complete user-facing funding ceremony.

Hosted Sigbash signing, physical-device testing, the Signet-specific private
funding release ceremony, and the full live Signet lifecycle remain unproven.
These results do not authorize mainnet use or certify the absence of other bugs.
