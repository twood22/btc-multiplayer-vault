/** Unfunded default-Signet host recovery drill. This is not lifecycle acceptance.
 * Creates only fresh isolated test keys, never requests coins, never submits a
 * valid transaction, and retains all replaced trees and negative-test bytes.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { presignedSourceDigest } from './presigned-build-identity.mjs';
import { assertHostRestorationReady, latestHostRestorationAttempt } from './lib/presigned-host-restoration-gate.js';
import { readPrivateJournalBytes, syncPrivateJournalDirectory, writePrivateJournalBytes } from './lib/presigned-durable-journal.js';
import { installNewRestoredDirectory } from './lib/presigned-primary-restore.js';
import { acquirePersistentSignetOperationLocks, assertPersistentSignetIdentity, persistentSignetPid, persistentSignetRpc,
  readPersistentSignetControl, stopPersistentSignetHost, verifyReceivingWalletRecovery, type PersistentSignetControl } from './lib/presigned-signet-host-state.js';

process.umask(0o077);
assert(process.argv.length === 3 && process.argv[2]?.startsWith('--stopped-chain-cache=/'),
  'usage: tsx scripts/presigned-signet-host-verification.mts --stopped-chain-cache=/absolute/stopped/cache/signet');
const cache = process.argv[2]!;
const sourceDigest = presignedSourceDigest();
let control: PersistentSignetControl | undefined;
let negativeBoundaries = 0; let sameWalletRestarts = 0; let wholeHostRestorations = 0;
async function command(script: string, args: string[], expectedFailure?: RegExp) {
  const expectSuccess = expectedFailure === undefined;
  assert.equal(presignedSourceDigest(), sourceDigest, 'host drill source changed; stop and retain this exact unfunded fixture');
  const child = spawn(process.execPath, ['--import', 'tsx', `scripts/${script}.mts`, ...args],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, VAULT_NETWORK: 'signet', NEXT_PUBLIC_VAULT_NETWORK: 'signet' } });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', value => { stdout += value.toString(); });
  // Keep private error details out of the diagnostic transcript.
  child.stderr.on('data', value => { stderr += value.toString(); });
  const status = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
    child.once('error', () => reject(new Error('unfunded recovery drill command could not start')));
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
  });
  assert(stdout.length <= 1_000_000 && stderr.length <= 1_000_000 && status.signal === null,
    'host drill command exceeded a bound or did not exit cleanly');
  assert.equal(status.code === 0, expectSuccess, `${script} ${args[0] ?? ''} returned an unexpected result; private stderr omitted`);
  if (!expectSuccess) {
    assert(expectedFailure!.test(stderr), 'negative host command failed for the wrong reason; private stderr omitted');
    negativeBoundaries++; return null;
  }
  const records = stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const result = records.at(-1); assert(result && typeof result === 'object'); return result;
}
async function assertUnfunded(current: PersistentSignetControl) {
  await assertPersistentSignetIdentity(current, false);
  const rpc = persistentSignetRpc(current);
  const wallet = await rpc('getwalletinfo', [], true); const balances = await rpc('getbalances', [], true);
  assert(wallet.txcount === 0 && wallet.scanning === false && balances.mine.trusted === 0 &&
    balances.mine.untrusted_pending === 0 && balances.mine.immature === 0, 'recovery drill must never alter a funded or previously used wallet');
  assert.equal(current.sourceDigest, sourceDigest); verifyReceivingWalletRecovery(current);
}
async function stoppedAndRetained(current: PersistentSignetControl, suffix: string) {
  await assertUnfunded(current);
  await command('presigned-signet-control', ['stop', `${current.directory}/control.json`]);
  assert.equal(persistentSignetPid(current), null);
  const lock = acquirePersistentSignetOperationLocks(current);
  try {
    assert.equal(persistentSignetPid(current), null, 'host restarted before recovery-drill retention acquired its locks');
    installNewRestoredDirectory(current.directory, `${current.directory}.${suffix}`);
  }
  finally { lock.release(); }
}
function temporarilyRetain(files: string[], parent: string, operation: (retained: string[]) => void) {
  const directory = mkdtempSync(`${parent}/host-gate-negative.`); syncPrivateJournalDirectory(parent);
  const retained: string[] = [];
  try {
    for (const [index, filename] of files.entries()) {
      const target = `${directory}/original-${index}.json`; assert(!existsSync(target)); renameSync(filename, target);
      syncPrivateJournalDirectory(dirname(filename)); syncPrivateJournalDirectory(directory); retained.push(target);
    }
    operation(retained);
  } finally {
    for (const [index, target] of retained.entries()) {
      const original = files[index]!;
      if (existsSync(original)) {
        const rejected = `${directory}/rejected-${index}.json`; assert(!existsSync(rejected)); renameSync(original, rejected);
      }
      renameSync(target, original); syncPrivateJournalDirectory(dirname(original)); syncPrivateJournalDirectory(directory);
    }
  }
}
try {
  const fresh = await command('presigned-signet-host', [cache]);
  assert(fresh?.initialWalletTestSats === 0 && fresh.nativeReceivingWalletRestorationVerified === true);
  control = readPersistentSignetControl(fresh.control); const current = control;
  const receivingAddress = current.address;
  const controlPath = `${current.directory}/control.json`; const recoveryControl = `${current.backupRoot}/host-control.json`;
  console.log(JSON.stringify({ stage: 'unfunded-persistent-host-created', sourceDigest, control: controlPath }));
  await assertUnfunded(current);
  await command('presigned-signet-control', ['stop', controlPath]);
  assert.equal(persistentSignetPid(current), null);
  await command('presigned-signet-control', ['start', controlPath]);
  await assertUnfunded(current); sameWalletRestarts++;
  let firstIntent: Buffer | undefined; let firstCompletion: Buffer | undefined;
  for (let sequence = 1; sequence <= 2; sequence++) {
    await stoppedAndRetained(current, `retained-unfunded-drill-${sequence}`);
    const staged = await command('presigned-signet-restore', ['host-stage', recoveryControl, cache]);
    assert(staged?.coreStopped === true && staged.fundingAuthorized === false && staged.publicTransactionsSent === 0 && staged.attemptSequence === sequence);
    assert.equal(persistentSignetPid(current), null);
    await command('presigned-signet-control', ['start', controlPath], /whole-host restoration is incomplete/u);
    await command('presigned-signet-lifecycle', ['fund', controlPath], /whole-host restoration is incomplete/u);
    assert.equal(persistentSignetPid(current), null, 'pending recovery bypass started Core');
    if (sequence === 2) {
      assert(firstCompletion && firstIntent);
      const attemptName = readdirSync(current.backupRoot).filter(name => name.startsWith('host-restore-attempt-')).sort().at(-1)!;
      const completionName = attemptName.replace('host-restore-attempt-', 'host-restore-complete-');
      const stale = [`${current.backupRoot}/${completionName}`, `${current.anchorRoot}/${completionName}`,
        `${current.directory}/host-restoration-completion.json`];
      const injectionLock = acquirePersistentSignetOperationLocks(current);
      const injected: string[] = [];
      try {
        assert.equal(persistentSignetPid(current), null);
        for (const filename of stale) { writePrivateJournalBytes(filename, firstCompletion); injected.push(filename); }
        assert.throws(() => assertHostRestorationReady(current), /belongs to another attempt/u); negativeBoundaries++;
        await command('presigned-signet-control', ['start', controlPath], /belongs to another attempt/u);
      } finally {
        try {
          for (const [index, filename] of injected.entries()) {
            assert(readPrivateJournalBytes(filename).equals(firstCompletion), 'negative fixture changed while locked; retain for inspection');
            renameSync(filename, `${current.restorationParent}/rejected-earlier-completion-${index}.json`);
            syncPrivateJournalDirectory(dirname(filename)); syncPrivateJournalDirectory(current.restorationParent);
          }
        } finally { injectionLock.release(); }
      }
    }
    const recovered = await command('presigned-signet-restore', ['host-resume', recoveryControl]);
    assert(recovered?.publicTransactionsSent === 0 && recovered.actualRestoredNativeSignatures === 1 && recovered.sameOriginalReceivingAddress === true);
    await assertUnfunded(current);
    assert.equal(readPersistentSignetControl(controlPath).address, receivingAddress);
    const attempt = latestHostRestorationAttempt(current); assert.equal(attempt?.sequence, sequence);
    const completed = assertHostRestorationReady(current); assert.equal(completed?.sequence, sequence);
    if (sequence === 1) {
      firstIntent = readPrivateJournalBytes(`${current.directory}/host-restoration-intent.json`);
      firstCompletion = readPrivateJournalBytes(`${current.directory}/host-restoration-completion.json`);
    }
    wholeHostRestorations++;
    const pid = persistentSignetPid(current);
    await command('presigned-signet-restore', ['host-resume', recoveryControl], /host restoration already acknowledged/u);
    assert.equal(persistentSignetPid(current), pid, 'completed online host was adopted or stopped by refused host-resume');
    await assertUnfunded(current);
    console.log(JSON.stringify({ stage: 'unfunded-whole-host-restored', sequence, attemptBoundNativeSignatures: completed!.nativeProof.actualRestoredNativeSignatures,
      normalStartRefusedUntilComplete: true, sourceAndReceivingAddressUnchanged: true }));
  }
  await command('presigned-signet-control', ['stop', controlPath]);
  const lock = acquirePersistentSignetOperationLocks(current);
  try {
    const names = readdirSync(current.backupRoot).filter(name => name.startsWith('host-restore-attempt-')).sort(); assert.equal(names.length, 2);
    const primaries = [`${current.directory}/host-restoration-intent.json`, `${current.directory}/host-restoration-completion.json`];
    temporarilyRetain([`${current.backupRoot}/${names[1]}`, `${current.anchorRoot}/${names[1]}`, ...primaries], current.restorationParent, () => {
      writePrivateJournalBytes(primaries[0]!, firstIntent!); writePrivateJournalBytes(primaries[1]!, firstCompletion!);
      assert.throws(() => assertHostRestorationReady(current), /no matching attempt/u); negativeBoundaries++;
    });
    temporarilyRetain([...names.flatMap(name => [`${current.backupRoot}/${name}`, `${current.anchorRoot}/${name}`]), ...primaries], current.restorationParent, () => {
      assert.throws(() => assertHostRestorationReady(current), /no matching attempt/u); negativeBoundaries++;
    });
    assert.equal(assertHostRestorationReady(current)?.sequence, 2);
  } finally { lock.release(); }
  await command('presigned-signet-control', ['start', controlPath]);
  await assertUnfunded(current); sameWalletRestarts++;
  assert.equal(presignedSourceDigest(), sourceDigest);
  const result = { passed: true, scope: 'actual-unfunded-persistent-default-Signet-host-restoration', sourceDigest,
    sameWalletRestarts, wholeHostRestorations, negativeBoundaries, actualAttemptBoundNativeSignatures: 2,
    receivingAddressUnchanged: true, walletTransactions: 0, walletTestSats: 0, publicTransactionsSent: 0,
    fullLifecycleAcceptanceCompleted: false, wholeDiskLossProtectionClaimed: false,
    originalAndNegativeFixtureBytesRetained: true, control: controlPath };
  writePrivateJournalBytes(`${current.backupRoot}/unfunded-host-verification.json`, Buffer.from(`${JSON.stringify(result, null, 2)}\n`));
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (control && existsSync(control.directory)) {
    const lock = acquirePersistentSignetOperationLocks(control);
    try { await stopPersistentSignetHost(control); }
    finally { lock.release(); }
  }
}
