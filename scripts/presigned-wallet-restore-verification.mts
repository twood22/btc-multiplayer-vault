/** Actual isolated Core native-wallet restoration; no public chain or real keys. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, mkdtempSync, readFileSync, readdirSync, renameSync } from 'node:fs';
import { setTimeout as pause } from 'node:timers/promises';
import { withPresignedRegtest } from './lib/presigned-regtest.js';
import { createNativeWalletRestoreProof, verifyNativeWalletRestoreProof, type RestoredWalletTarget } from './lib/presigned-wallet-restore-proof.js';
import { commitmentDigest } from '../src/presigned/validation.js';
import { presignedSourceDigest } from './presigned-build-identity.mjs';
import { writePrivateJournalBytes } from './lib/presigned-durable-journal.js';
import { withStoppedCoreDataDirectoryLock } from './lib/presigned-signet-cache.js';

process.umask(0o077);
await withPresignedRegtest(async host => {
  const root = mkdtempSync('/tmp/btc-presigned-native-restore-check.');
  const binary = process.env.BITCOIN_CORE_BIN ?? '/home/codex/.cache/btc-multiplayer-vault/bitcoin-core-31.1/bin/bitcoind';
  const binarySha256 = createHash('sha256').update(readFileSync(binary)).digest('hex');
  let coreDataDirectoryLockChecks = 0;
  await assert.rejects(() => withStoppedCoreDataDirectoryLock(`${host.directory}/core/regtest`, async () => {
    assert.fail('actual live Core directory lock was bypassed');
  }), /cache is live/u); coreDataDirectoryLockChecks++;
  const lockFixture = mkdtempSync('/tmp/btc-presigned-core-posix-lock.');
  writePrivateJournalBytes(`${lockFixture}/.lock`, Buffer.alloc(0));
  await withStoppedCoreDataDirectoryLock(lockFixture, async assertHeld => {
    await assert.rejects(() => withStoppedCoreDataDirectoryLock(lockFixture, async () => {
      assert.fail('second POSIX writer entered while the original helper owned the lock');
    }), /cache is live/u);
    assertHeld(); coreDataDirectoryLockChecks++;
  });
  await withStoppedCoreDataDirectoryLock(lockFixture, async assertHeld => { assertHeld(); coreDataDirectoryLockChecks++; });
  await assert.rejects(() => withStoppedCoreDataDirectoryLock(lockFixture, async assertHeld => {
    const candidates = readdirSync('/proc').filter(name => /^[1-9][0-9]*$/u.test(name)).filter(name => {
      try {
        if (lstatSync(`/proc/${name}`).uid !== process.getuid?.()) return false;
        const args = readFileSync(`/proc/${name}/cmdline`).toString().split('\0').filter(Boolean);
        return args[0] === '/usr/bin/python3' && args.at(-1) === `${lockFixture}/.lock`;
      } catch (error) { if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return false; throw error; }
    });
    assert.equal(candidates.length, 1, 'must resolve only the exact owned disposable lock helper');
    process.kill(Number(candidates[0]), 'SIGKILL');
    await pause(100);
    assertHeld();
  }), /lock owner exited|complete verified copy/u); coreDataDirectoryLockChecks++;
  const targets: RestoredWalletTarget[] = [];
  // Receiving address plus the actual lifecycle's 82 reserved wallet scripts.
  for (let index = 0; index < 83; index++) {
    const address = await host.walletRpc('getnewaddress', ['isolated-native-restore-check', index % 2 ? 'bech32' : 'bech32m']);
    const info = await host.walletRpc('getaddressinfo', [address]);
    assert(info.ismine && info.solvable);
    targets.push({ address, scriptPubKeyHex: info.scriptPubKey });
  }
  const sourceDigest = presignedSourceDigest();
  const bindingDigest = commitmentDigest('vault/presigned-graph-v2/native-wallet-recovery-test', { sourceDigest, targets });
  const before = await host.walletRpc('getbalances'); let sourceCalls = 0;
  const result = await createNativeWalletRestoreProof({ parentDirectory: root, chain: 'regtest', binary, binarySha256, bindingDigest, targets,
    sourceWalletRpc: async (method, params) => {
      assert.equal(method, 'backupwallet', 'restore proof attempted a source-wallet transaction or key export');
      sourceCalls++; return host.walletRpc(method, params);
    } });
  assert.equal(sourceCalls, 1);
  assert.deepEqual(await host.walletRpc('getbalances'), before);
  assert.equal(result.actualRestoredNativeSignatures, 83);
  const expected = { chain: 'regtest' as const, bindingDigest, binarySha256, targets };
  assert.deepEqual(verifyNativeWalletRestoreProof(result.directory, expected), {
    actualRestoredNativeSignatures: 83, backupSha256: result.backupSha256, proofSha256: result.proofSha256 });
  let negatives = 0;
  for (const mutation of [{ bindingDigest: '00'.repeat(32) }, { binarySha256: '00'.repeat(32) }, { targets: targets.slice(1) },
    { targets: [...targets].reverse() }, { chain: 'signet' as const }]) {
    assert.throws(() => verifyNativeWalletRestoreProof(result.directory, { ...expected, ...mutation })); negatives++;
  }
  const backup = `${result.directory}/wallet.dat`; const retained = `${root}/retained-native-wallet.dat`;
  renameSync(backup, retained);
  try { assert.throws(() => verifyNativeWalletRestoreProof(result.directory, expected)); negatives++; }
  finally { renameSync(retained, backup); }
  const proofPath = `${result.directory}/restore-proof.json`;
  const originalProof = readFileSync(proofPath);
  const originalBackup = readFileSync(backup);
  const mutateReceipt = (mutation: Record<string, unknown>, newExpected = expected, newBackup?: Buffer) => {
    const proof = JSON.parse(originalProof.toString());
    const savedProof = `${root}/retained-proof-${negatives}.json`;
    const savedBackup = `${root}/retained-backup-${negatives}.dat`;
    renameSync(proofPath, savedProof);
    if (newBackup) {
      renameSync(backup, savedBackup); writePrivateJournalBytes(backup, newBackup);
      proof.backupSha256 = createHash('sha256').update(newBackup).digest('hex');
    }
    writePrivateJournalBytes(proofPath, Buffer.from(JSON.stringify({ ...proof, ...mutation })));
    try { assert.throws(() => verifyNativeWalletRestoreProof(result.directory, newExpected)); negatives++; }
    finally {
      renameSync(proofPath, `${root}/rejected-proof-${negatives}.json`); renameSync(savedProof, proofPath);
      if (newBackup) { renameSync(backup, `${root}/rejected-backup-${negatives}.dat`); renameSync(savedBackup, backup); }
    }
  };
  // Mutate BOTH the editable receipt and the caller's expected identity. The
  // old signatures themselves must refuse rebinding to any other run/backup.
  mutateReceipt({ bindingDigest: '11'.repeat(32) }, { ...expected, bindingDigest: '11'.repeat(32) });
  mutateReceipt({ binarySha256: '22'.repeat(32) }, { ...expected, binarySha256: '22'.repeat(32) });
  mutateReceipt({ challengeHex: '33'.repeat(32) });
  mutateReceipt({ checkedAt: '2001-01-01T00:00:00.000Z' });
  const changedBackup = Buffer.from(originalBackup); changedBackup[changedBackup.length - 1]! ^= 1;
  mutateReceipt({}, expected, changedBackup);
  for (const mutation of [{ stopRpcAccepted: false }, { restoreExitCode: 1 }, { restoreExitSignal: 'SIGKILL' }, { restoreNodeStopped: false }])
    mutateReceipt(mutation);
  assert(readFileSync(backup).equals(originalBackup) && readFileSync(proofPath).equals(originalProof));
  verifyNativeWalletRestoreProof(result.directory, expected);
  host.record('native-wallet-restoration', { sourceDigest, actualRestoredNativeSignatures: 83, rejectedBindings: negatives,
    proofSha256: result.proofSha256, originalBackupUnchanged: true, sourceWalletCalls: sourceCalls, coreDataDirectoryLockChecks });
  console.log(JSON.stringify({ passed: true, scope: 'actual-isolated-native-wallet-restoration', coreVersion: host.coreVersion,
    sourceDigest, actualRestoredNativeSignatures: 83, rejectedBindings: negatives, sourceWalletCalls: sourceCalls,
    sourceBalancesUnchanged: true, originalBackupUnchanged: true, networkingDisabled: true, publicNetworkBroadcasts: 0,
    participantKeysImported: false, signatureContextBindingVerified: true, cleanRestoreShutdownVerified: true,
    coreDataDirectoryLockChecks,
    realDefaultSignetVerified: false, restorationProof: result.directory }, null, 2));
});
