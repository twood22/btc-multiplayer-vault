/** Tests exact resumable orchestration without calling it real Signet proof. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync } from 'node:fs';
import * as bitcoin from 'bitcoinjs-lib';
import { createPresignedCoreBackend, type PresignedCoreRpc } from '../src/presigned/core.js';
import { genesisHash } from '../src/presigned/validation.js';
import { withPresignedRegtest } from './lib/presigned-regtest.js';
import { advanceLiveLifecycle, fundLiveLifecycle, initializeLiveLifecycle, readLifecycleFile,
  saveLifecycleFile, verifyCompletedLiveLifecycle, type LiveLifecycleCore } from './lib/presigned-live-lifecycle.js';
import { validatePresignedFeePackage, type PresignedFeePackage } from '../src/presigned/fee-package.js';
import type { PresignedPublicKit } from '../src/presigned/types.js';
import { presignedSourceDigest } from './presigned-build-identity.mjs';

process.umask(0o077);
await withPresignedRegtest(async host => {
  const directory = mkdtempSync('/tmp/btc-presigned-live-runner.');
  // Format-only mapping is confined to this network-disabled test executable.
  // Live CLI verifies both real genesis and block 1 and offers no bypass flag.
  const rpc: PresignedCoreRpc = async <T,>(method: string, params: unknown[] = []) => {
    try {
      const value = await host.rpc(method, params);
      if (method === 'getblockchaininfo') return { ...value, chain: 'signet' } as T;
      if (method === 'getblockhash' && params[0] === 0) return genesisHash('signet') as T;
      return value as T;
    } catch (error) { throw Object.assign(new Error('isolated test RPC failed'), { code: (error as { rpcCode?: number }).rpcCode }); }
  };
  const backend = createPresignedCoreBackend({ network: 'signet', genesisHash: genesisHash('signet'), rpc });
  const lost = new Set<string>(); const submissions = new Map<string, number>(); let backupGateChecks = 0;
  const interruptedRpc: LiveLifecycleCore['rpc'] = async (method, params = []) => {
    const result = await rpc(method, params);
    if (method === 'submitpackage' || method === 'sendrawtransaction') {
      const hex = method === 'submitpackage' ? (params[0] as string[]).at(-1)! : params[0] as string;
      const txid = bitcoin.Transaction.fromHex(hex).getId(); submissions.set(txid, (submissions.get(txid) ?? 0) + 1);
      let label: string | null = null;
      if (method === 'submitpackage' && existsSync(`${directory}/cases/case-00/fee-funding.json`)) {
        const pair = readLifecycleFile<{ initial: PresignedFeePackage; replacement: PresignedFeePackage }>(directory, 'cases/case-00/fee-funding.json');
        if (validatePresignedFeePackage(pair.initial).completed.txid === txid) label = 'initial-fee-response';
        if (validatePresignedFeePackage(pair.replacement).completed.txid === txid) label = 'replacement-fee-response';
      }
      if (method === 'sendrawtransaction' && existsSync(`${directory}/cases/case-01/funding.json`) &&
        readLifecycleFile<{ txid: string }>(directory, 'cases/case-01/funding.json').txid === txid) label = 'funding-response';
      if (label && !lost.has(label)) { lost.add(label); throw new Error('deliberately lost successful Core response'); }
    }
    return result;
  };
  const walletRpc: LiveLifecycleCore['walletRpc'] = async (method, params = []) => {
    if (method === 'walletprocesspsbt') {
      const tx = bitcoin.Transaction.fromBuffer(bitcoin.Psbt.fromBase64(params[0] as string).data.globalMap.unsignedTx.toBuffer());
      if (tx.version === 3 && tx.ins.length === 3) {
        const item = readdirSync(`${directory}/cases`).find(id => existsSync(`${directory}/cases/${id}/kit.json`) &&
          readLifecycleFile<PresignedPublicKit>(directory, `cases/${id}/kit.json`).graph.fundingTxid === tx.getId()); assert(item);
        const receipts = readLifecycleFile<{ proofs: unknown[]; restoredBeforeWalletSigning: boolean }>(directory, `cases/${item}/backup-receipts.json`);
        assert(receipts.restoredBeforeWalletSigning && receipts.proofs.length === 3);
        assert(existsSync(`${directory}/cases/${item}/wallet-signing-intent.json`));
        for (const id of ['alice', 'bob', 'carol']) assert(existsSync(`${directory}/cases/${item}/${id}.encrypted.json`) &&
          existsSync(`${directory}/keys/${item}-${id}.json`));
        backupGateChecks++;
      }
    }
    return host.walletRpc(method, params);
  };
  const core: LiveLifecycleCore = { rpc: interruptedRpc, walletRpc, observeCoin: point => backend.observeConfirmedCoin(point),
    chain: 'isolated-regtest', actualGenesisHash: await host.rpc('getblockhash', [0]), sourceDigest: presignedSourceDigest() };
  assert.equal((await initializeLiveLifecycle(core, directory)).cases, 19);
  const fanout = await fundLiveLifecycle(core, directory); assert.equal(fanout.fanout, 'submitted');
  assert.equal((await fundLiveLifecycle(core, directory)).fanout, 'pending');
  await host.mine();
  mkdirSync(`${directory}/cases/case-00`, { mode: 0o700 });
  saveLifecycleFile(directory, 'cases/case-00/uncommitted.json', { incompleteBeforeFundingSignatures: true });
  let result: Awaited<ReturnType<typeof advanceLiveLifecycle>>;
  for (let iteration = 0; iteration < 25; iteration++) {
    // Every invocation reloads all durable state: no in-process journal cache.
    try { result = await advanceLiveLifecycle(core, directory); }
    catch (error) {
      assert.equal((error as Error).message, 'deliberately lost successful Core response');
      console.log(JSON.stringify({ stage: 'resumable-runner-lost-response', observedFaults: lost.size })); continue;
    }
    console.log(JSON.stringify({ stage: 'resumable-runner-advance', iteration, complete: result.complete }));
    if (result.complete) break;
    await host.mine();
  }
  assert(result!.complete && 'soloOrderingsConfirmed' in result!);
  assert.equal(result!.soloOrderingsConfirmed, 6); assert.equal(result!.cooperativeRoundsConfirmed, 4); assert.equal(result!.recoverySubsetsConfirmed, 9);
  assert.equal(result!.realDefaultSignetVerified, false);
  assert.equal(result!.feeLifecycleEvidence, true); assert.equal(result!.feeEvidence.length, 5);
  assert.equal(lost.size, 3); assert.equal(backupGateChecks, 19);
  assert.equal(readdirSync(`${directory}/interrupted`).length, 1);
  assert([...submissions.values()].every(count => count === 1), 'a lost reply caused a duplicate send');
  const resumed = await advanceLiveLifecycle(core, directory);
  assert.deepEqual(resumed, result!, 'repeat completed observation changed evidence');
  assert.equal((await host.rpc('getrawmempool')).length, 0);
  const run = readLifecycleFile<{ cases: Array<{ id: string }> }>(directory, 'run.json');
  for (const item of run.cases) {
    const receipt = readLifecycleFile<{ restoredBeforeWalletSigning: boolean; proofs: Array<{ exitProofs: unknown[] }> }>(directory, `cases/${item.id}/backup-receipts.json`);
    assert(receipt.restoredBeforeWalletSigning && receipt.proofs.length === 3 && receipt.proofs.every(proof => proof.exitProofs.length === 3));
  }
  const eventCount = readdirSync(`${directory}/events`).length;
  const submissionCounts = [...submissions.entries()];
  const verification = await verifyCompletedLiveLifecycle(core, directory);
  assert.equal(verification.realDefaultSignetVerified, false); assert.equal(verification.restoredKits, 57);
  assert.equal(verification.hostileRejections, 80); assert.equal(verification.feeFamiliesConfirmed, 5);
  assert.equal(verification.everyPayoutRefundAndSponsorChangeVerified, true);
  assert.equal(readdirSync(`${directory}/events`).length, eventCount, 'read-only verification wrote a journal event');
  assert.deepEqual([...submissions.entries()], submissionCounts, 'read-only verification resubmitted a transaction');
  await assert.rejects(() => verifyCompletedLiveLifecycle({ ...core, sourceDigest: '00'.repeat(32) }, directory));
  renameSync(`${directory}/cases/case-00/alice.encrypted.json`, `${directory}/cases/case-00/alice.encrypted.retained`);
  try { await assert.rejects(() => verifyCompletedLiveLifecycle(core, directory)); }
  finally { renameSync(`${directory}/cases/case-00/alice.encrypted.retained`, `${directory}/cases/case-00/alice.encrypted.json`); }
  const lastBlock = await host.rpc('getbestblockhash');
  await host.rpc('invalidateblock', [lastBlock]);
  try { await assert.rejects(() => verifyCompletedLiveLifecycle(core, directory)); }
  finally { await host.rpc('reconsiderblock', [lastBlock]); }
  assert.equal((await verifyCompletedLiveLifecycle(core, directory)).everyPayoutRefundAndSponsorChangeVerified, true);
  host.record('resumable-lifecycle-runner', { passed: true, evidence: directory, lostRepliesWithoutResending: lost.size,
    preFundingBackupGateChecks: backupGateChecks, interruptedUncommittedCaseRetained: true,
    readOnlyCompletionVerification: verification, readOnlyReorganizationAndMissingBackupRejections: true, ...resumed });
  console.log(JSON.stringify({ passed: true, evidence: directory, realDefaultSignetVerified: false, cases: 19,
    publicNetworkBroadcasts: 0, coreVersion: host.coreVersion, chain: 'isolated-regtest',
    feeFamilies: 5, lostRepliesWithoutResending: 3 }));
}, { maximumMinutes: 30 });
