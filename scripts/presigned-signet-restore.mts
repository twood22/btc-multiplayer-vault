/** Explicit isolated test-host recovery. Never signs or sends a real parent.
 * Restored bytes retain the ORIGINAL source/host/wallet identity and exact path.
 * The complete backup and independent rollback anchor must both survive.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { acquireLifecycleProcessLock } from './lib/presigned-lifecycle-lock.js';
import { DurableLifecycleJournal, privateJournalDirectory, readPrivateJournalBytes, restoreDurableLifecycleJournal,
  syncPrivateJournalDirectory, writePrivateJournalBytes } from './lib/presigned-durable-journal.js';
import { installNewRestoredDirectory, restoreLifecyclePrimary } from './lib/presigned-primary-restore.js';
import { assertNoOwnedProcessUsesDatadir, checkStoppedPublicSignetCache, copyStoppedPublicSignetCache } from './lib/presigned-signet-cache.js';
import { createNativeWalletRestoreProof, verifyNativeWalletRestoreProof } from './lib/presigned-wallet-restore-proof.js';
import { verifyRestoredLiveLifecycleCustody, type LiveLifecycleCore } from './lib/presigned-live-lifecycle.js';
import { beginHostRestorationAttempt, completeHostRestorationAttempt, hasHostRestorationCompletion, latestHostRestorationAttempt,
  pinPrimaryHostRestorationAttempt, restorationAttemptWalletBinding, verifyHostRestorationCompletion } from './lib/presigned-host-restoration-gate.js';
import { acquirePersistentSignetOperationLocks, assertPersistentSignetIdentity, DEFAULT_SIGNET_GENESIS,
  launchPersistentSignetDaemon, persistentSignetPid, persistentSignetRpc, readPersistentSignetControl,
  readPersistentSignetRecoveryControl, receivingWalletRecoveryBinding, startPersistentSignetHost,
  stopPersistentSignetHost, verifyReceivingWalletRecovery, type PersistentSignetControl } from './lib/presigned-signet-host-state.js';

process.umask(0o077);
const [operation, filename, cacheArgument] = process.argv.slice(2);
const preparesHost = operation === 'host' || operation === 'host-stage';
assert(filename && ['journal', 'host', 'host-stage', 'host-resume'].includes(operation ?? '') &&
  process.argv.length === (preparesHost ? 5 : 4) &&
  (!preparesHost || cacheArgument?.startsWith('--stopped-chain-cache=/')),
  'usage: tsx scripts/presigned-signet-restore.mts journal PRIMARY_CONTROL | host|host-stage BACKUP_HOST_CONTROL --stopped-chain-cache=/absolute/stopped/cache/signet | host-resume BACKUP_HOST_CONTROL');
const control = operation === 'journal' ? readPersistentSignetControl(filename) : readPersistentSignetRecoveryControl(filename);
verifyReceivingWalletRecovery(control);
const binding = { chain: 'default-Signet' as const, sourceDigest: control.sourceDigest, actualGenesisHash: DEFAULT_SIGNET_GENESIS };
const runDirectory = `${control.directory}/lifecycle-v2`;
function offlineCustodyCore(journal: DurableLifecycleJournal): LiveLifecycleCore {
  const denied = async (): Promise<never> => { throw new Error('restoration custody audit cannot call a transaction or wallet RPC'); };
  return { ...binding, rpc: denied, walletRpc: denied, observeCoin: denied, durableJournal: journal,
    restorationParent: control.restorationParent, nativeWalletBackup: { binary: control.binaryPath,
      binarySha256: control.binarySha256, parentDirectory: control.nativeWalletBackupParent } };
}

if (operation === 'journal') {
  const lock = acquirePersistentSignetOperationLocks(control);
  try {
    const restored = await restoreLifecyclePrimary(runDirectory, control.journalBackupDirectory, control.journalAnchorDirectory,
      control.restorationParent, binding, async journal => { await verifyRestoredLiveLifecycleCustody(offlineCustodyCore(journal), journal.directory); });
    const custody = await verifyRestoredLiveLifecycleCustody(offlineCustodyCore(restored.journal), runDirectory);
    console.log(JSON.stringify({ stage: 'exact-isolated-lifecycle-journal-restored', control: `${control.directory}/control.json`,
      checkpointDigest: restored.checkpointDigest, retainedOriginal: restored.retainedOriginal,
      completeParticipantKitsRestored: custody.completeParticipantKitsRestored,
      nativeWalletRestoredSignatures: custody.nativeWalletProof?.actualRestoredNativeSignatures ?? 0,
      nativeInitializationStillRequired: custody.nativeWalletProof === null, publicTransactionsSent: 0, fundingAuthorized: false }));
  } finally { lock.release(); }
} else {
  // Shared with every start/sign/advance operation, including old retained
  // primaries. A missing host never means its writer is assumed dead.
  const backupLock = acquireLifecycleProcessLock(control.backupRoot, control.sourceDigest);
  let hostLock: ReturnType<typeof acquireLifecycleProcessLock> | null = null;
  let ready = false;
  let touchedRestorationHost = false;
  try {
    if (preparesHost) {
      assert(!existsSync(control.directory), 'host path still exists; retain/inspect it explicitly before whole-host restoration');
      assertNoOwnedProcessUsesDatadir(`${control.directory}/core`);
      const source = cacheArgument!.slice('--stopped-chain-cache='.length); checkStoppedPublicSignetCache(source);
      const staging = mkdtempSync(`${dirname(control.directory)}/presigned-v2-signet-restore.`);
      syncPrivateJournalDirectory(dirname(staging));
      for (const path of [`${staging}/core`, `${staging}/core/signet`, `${staging}/wallets`, `${staging}/restores`]) mkdirSync(path, { mode: 0o700 });
      syncPrivateJournalDirectory(staging); syncPrivateJournalDirectory(`${staging}/core`);
      writePrivateJournalBytes(`${staging}/empty.conf`, Buffer.alloc(0));
      await copyStoppedPublicSignetCache(source, `${staging}/core/signet`);
      let checkpointDigest: string | null = null;
      let native = { directory: control.receivingWalletRecovery.directory, binding: receivingWalletRecoveryBinding(control) };
      if (existsSync(`${control.journalBackupDirectory}/identity.json`)) {
        mkdirSync(`${staging}/lifecycle-v2`, { mode: 0o700 });
        const journal = restoreDurableLifecycleJournal(runDirectory, control.journalBackupDirectory,
          control.journalAnchorDirectory, `${staging}/lifecycle-v2`, binding);
        const custody = await verifyRestoredLiveLifecycleCustody(offlineCustodyCore(journal), journal.directory);
        if (custody.nativeWalletProof) {
          assert.equal(custody.nativeWalletProof.binding.chain, 'signet');
          native = { directory: custody.nativeWalletProof.directory, binding: { ...custody.nativeWalletProof.binding, chain: 'signet' } };
        }
        checkpointDigest = journal.assertCurrent().snapshot!.checkpointDigest;
      } else assert(readdirSync(control.journalBackupDirectory).length === 0 && readdirSync(control.journalAnchorDirectory).length === 0,
        'missing journal identity is damaged custody, not an unfunded host; retain both independent stores');
      const intent = beginHostRestorationAttempt(control, checkpointDigest, native);
      pinPrimaryHostRestorationAttempt(control, intent, staging);
      writePrivateJournalBytes(`${staging}/control.json`, readPrivateJournalBytes(`${control.backupRoot}/host-control.json`));
      assertNoOwnedProcessUsesDatadir(`${control.directory}/core`);
      installNewRestoredDirectory(staging, control.directory);
    }
    readPersistentSignetControl(`${control.directory}/control.json`, true, true, true);
    hostLock = acquireLifecycleProcessLock(control.directory, control.sourceDigest);
    const intent = latestHostRestorationAttempt(control, true); assert(intent, 'no independently retained restoration attempt exists');
    pinPrimaryHostRestorationAttempt(control, intent);
    assert(!existsSync(`${control.directory}/host-restoration-completion.json`),
      'host restoration already acknowledged; use ordinary start/status/lifecycle commands or inspect damaged acknowledgement');
    let native = { directory: control.receivingWalletRecovery.directory, binding: receivingWalletRecoveryBinding(control) };
    let participantKitsRestored = 0;
    if (existsSync(`${runDirectory}/.checkpoint-fences`)) {
      const journal = new DurableLifecycleJournal(runDirectory, control.journalBackupDirectory, control.journalAnchorDirectory, binding);
      assert.equal(journal.assertCurrent().snapshot?.checkpointDigest, intent.checkpointDigest, 'restoration changed its exact acknowledged checkpoint');
      const custody = await verifyRestoredLiveLifecycleCustody(offlineCustodyCore(journal), runDirectory);
      if (custody.nativeWalletProof) {
        assert.equal(custody.nativeWalletProof.binding.chain, 'signet');
        native = { directory: custody.nativeWalletProof.directory, binding: { ...custody.nativeWalletProof.binding, chain: 'signet' } };
      }
      participantKitsRestored = custody.completeParticipantKitsRestored;
    } else assert(intent.checkpointDigest === null, 'missing restored lifecycle journal');
    const originalProof = verifyNativeWalletRestoreProof(native.directory, native.binding);
    assert(native.directory === intent.nativeRecovery.directory && JSON.stringify(native.binding) === JSON.stringify(intent.nativeRecovery.binding) &&
      originalProof.proofSha256 === intent.nativeRecovery.proofSha256, 'restored journal changed the exact attempt-bound native backup');
    if (!persistentSignetPid(control)) {
      touchedRestorationHost = true;
      await launchPersistentSignetDaemon(control, existsSync(`${control.directory}/wallets/${control.walletName}/wallet.dat`));
    }
    const rpc = persistentSignetRpc(control);
    const network = await rpc('getnetworkinfo');
    assert(network.networkactive === false && network.connections === 0, 'whole-host restoration must remain offline until its custody proof completes');
    const wallets = await rpc('listwallets');
    assert(wallets.length === 0 || (wallets.length === 1 && wallets[0] === control.walletName), 'restoration loaded an unexpected wallet');
    // Only now adopt a pre-existing process: exact identity, intended incomplete
    // restore, network disabled, zero peers, and no unrelated loaded wallet.
    touchedRestorationHost = true;
    if (wallets.length === 0) {
      await assertPersistentSignetIdentity(control, false, true);
      await rpc('restorewallet', [control.walletName, `${native.directory}/wallet.dat`, false]);
    } else assert.deepEqual(wallets, [control.walletName], 'restoration loaded an unexpected wallet');
    await assertPersistentSignetIdentity(control, false);
    for (const target of native.binding.targets) {
      const address = await rpc('getaddressinfo', [target.address], true);
      assert(address.ismine === true && address.solvable === true && address.scriptPubKey === target.scriptPubKeyHex,
        'restored operational test wallet lost an exact reserved native key');
    }
    // Independently restore/sign again from the newly recovered host wallet.
    // This uses only impossible-parent signatures and never imports participants.
    if (operation === 'host-stage') {
      // Explicit non-spending staged recovery: preserve the new attempt, stop
      // offline, and deliberately DO NOT acknowledge normal-operation readiness.
      await stopPersistentSignetHost(control); touchedRestorationHost = false;
      console.log(JSON.stringify({ stage: 'restored-isolated-host-awaiting-native-custody-acknowledgement',
        control: `${control.directory}/control.json`, attemptId: intent.attemptId, attemptSequence: intent.sequence,
        networkActive: false, coreStopped: true, fundingAuthorized: false, publicTransactionsSent: 0 }));
    } else {
    const completion = hasHostRestorationCompletion(control, intent)
      ? verifyHostRestorationCompletion(control, intent, true, true)
      : completeHostRestorationAttempt(control, intent, await createNativeWalletRestoreProof({ ...restorationAttemptWalletBinding(intent),
        binary: control.binaryPath, parentDirectory: control.nativeWalletBackupParent,
        sourceWalletRpc: (method, params) => { assert(method === 'backupwallet'); return rpc(method, params, true); } }), participantKitsRestored);
    const proof = completion.nativeProof;
    assert.equal(completion.participantKitsRestored, participantKitsRestored, 'completed restoration disagrees with actual full restored custody');
    await startPersistentSignetHost(control); ready = true;
    console.log(JSON.stringify({ stage: 'exact-isolated-Signet-host-restored', control: `${control.directory}/control.json`,
      sourceDigest: control.sourceDigest, checkpointDigest: intent.checkpointDigest,
      actualRestoredNativeSignatures: proof.actualRestoredNativeSignatures, completeParticipantKitsRestored: participantKitsRestored,
      publicTransactionsSent: 0, mainnetSpendingAuthorized: false, sameOriginalReceivingAddress: true }));
    }
  } finally {
    let cleanupFailed = false;
    if (!ready && touchedRestorationHost) {
      try { await stopPersistentSignetHost(control); } catch { cleanupFailed = true; }
    }
    hostLock?.release(); backupLock.release();
    assert(!cleanupFailed, 'restoration did not complete and the same isolated process shutdown remains unverified; inspect its exact control');
  }
}
