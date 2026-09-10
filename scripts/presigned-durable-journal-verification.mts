/** Disposable synthetic filesystem fixtures only; never a wallet or live proof. */
import assert from 'node:assert/strict';
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { BITCOIN_NETWORK_NAME } from '../src/network.js';
import { spawn } from 'node:child_process';
import { acquireLifecycleProcessLock } from './lib/presigned-lifecycle-lock.js';
import { installNewRestoredDirectory, restoreLifecyclePrimary } from './lib/presigned-primary-restore.js';
import { createDurableLifecycleJournal, DurableLifecycleJournal, privateJournalDirectory,
  restoreDurableLifecycleJournal, writePrivateJournalBytes } from './lib/presigned-durable-journal.js';

process.umask(0o077);
const expected = { sourceDigest: 'a1'.repeat(32), chain: 'isolated-regtest' as const, actualGenesisHash: 'b2'.repeat(32) };
let negatives = 0; let checkpoints = 0; let restored = 0;
let kernelLockChecks = 0;
let actualPrimaryCutovers = 0;
let metadataLossRestorations = 0; let interruptedCheckpointRepairs = 0; let atomicCutoverPreflightChecks = 0;
const checks: string[] = [];
function denied(action: () => unknown, pattern?: RegExp) {
  if (pattern) assert.throws(action, pattern); else assert.throws(action);
  negatives++;
}
function fixture() {
  const root = mkdtempSync('/tmp/btc-presigned-durable-fixture.');
  const primary = `${root}/primary`; const backup = `${root}/backup`; const anchor = `${root}/anchor`;
  for (const directory of [primary, backup, anchor]) mkdirSync(directory, { mode: 0o700 });
  const journal = createDurableLifecycleJournal(primary, backup, anchor, expected);
  return { root, primary, backup, anchor, journal };
}
function write(directory: string, name: string, value: unknown) {
  writePrivateJournalBytes(`${directory}/${name}`, Buffer.from(`${JSON.stringify(value)}\n`));
}
function destination(root: string) {
  return mkdtempSync(`${root}/restore.`);
}

{
  const { root, primary, backup, anchor, journal } = fixture();
  mkdirSync(`${primary}/cases`, { mode: 0o700 }); mkdirSync(`${primary}/keys`, { mode: 0o700 });
  write(primary, 'run.json', { synthetic: true, sourceDigest: expected.sourceDigest, cases: 19 });
  write(primary, 'keys/synthetic-wrapping.json', { synthetic: 'NOT-KEY-MATERIAL' });
  const first = journal.checkpoint('initialized-synthetic-run'); checkpoints++;
  assert(first.files.includes('run.json') && first.files.includes('keys/synthetic-wrapping.json'));
  const firstCopy = journal.restore(destination(root)); restored++;
  assert.equal(firstCopy.assertCurrent().snapshot?.checkpointDigest, first.checkpointDigest);
  write(primary, 'cases/submit-intent.json', { synthetic: true, exactTxid: 'c3'.repeat(32) });
  assert.equal(journal.assertCurrent().snapshot?.checkpointDigest, first.checkpointDigest);
  const second = journal.checkpoint('before-synthetic-submit'); checkpoints++;
  assert(second.files.includes('cases/submit-intent.json') && second.sequence === first.sequence + 1);
  const copy = journal.restore(destination(root)); restored++;
  assert(readFileSync(`${copy.directory}/cases/submit-intent.json`).equals(readFileSync(`${primary}/cases/submit-intent.json`)));
  assert.equal(copy.assertCurrent().snapshot?.checkpointDigest, second.checkpointDigest);
  denied(() => journal.restore(primary)); denied(() => journal.restore(backup)); denied(() => journal.restore(anchor));
  mkdirSync(`${backup}/nested`, { mode: 0o700 }); denied(() => journal.restore(`${backup}/nested`), /disjoint/u);
  assert.deepEqual(readdirSync(`${backup}/nested`), []);
  denied(() => new DurableLifecycleJournal(primary, backup, anchor, { ...expected, sourceDigest: '00'.repeat(32) }));
  checks.push('exact complete bytes, required-intent membership, independent restore, source binding and disjoint roots');
}

{
  const { root, primary, backup, anchor, journal } = fixture();
  write(primary, 'run.json', { synthetic: true }); journal.checkpoint('before-first-signature'); checkpoints++;
  write(primary, 'irreversible-intent.json', { synthetic: true, exactTxid: 'd4'.repeat(32) });
  const latest = journal.checkpoint('before-second-signature'); checkpoints++;
  const lastFile = readdirSync(`${backup}/snapshots`).sort().at(-1)!;
  renameSync(`${backup}/snapshots/${lastFile}`, `${root}/retained-newest-checkpoint.json`);
  denied(() => journal.assertCurrent(), /stale or missing/u);
  denied(() => journal.checkpoint('must-not-sign'), /stale or missing/u);
  // Simulate the ENTIRE primary tree disappearing, while retaining the fixture
  // safely elsewhere. The independent anchor must still refuse an old backup.
  renameSync(primary, `${root}/retained-original-primary`);
  const refused = destination(root);
  denied(() => restoreDurableLifecycleJournal(primary, backup, anchor, refused, expected), /stale or missing/u);
  assert.deepEqual(readdirSync(refused), []);
  renameSync(`${root}/retained-newest-checkpoint.json`, `${backup}/snapshots/${lastFile}`);
  const recovered = restoreDurableLifecycleJournal(primary, backup, anchor, destination(root), expected); restored++;
  assert.equal(recovered.assertCurrent().snapshot?.checkpointDigest, latest.checkpointDigest);
  assert.deepEqual(JSON.parse(readFileSync(`${recovered.directory}/irreversible-intent.json`, 'utf8')),
    { synthetic: true, exactTxid: 'd4'.repeat(32) });
  const emptyAnchor = `${root}/empty-anchor`; mkdirSync(emptyAnchor, { mode: 0o700 });
  denied(() => restoreDurableLifecycleJournal(primary, backup, emptyAnchor, destination(root), expected));
  checks.push('stale backup refuses before signatures even after total primary loss; exact newest journal restores with independent anchor');
}

{
  const { root, primary, backup, anchor, journal } = fixture();
  write(primary, 'run.json', { synthetic: true }); journal.checkpoint('before-synthetic-signature'); checkpoints++;
  const retained = `${root}/retained-run.json`;
  renameSync(`${primary}/run.json`, retained);
  denied(() => journal.assertCurrent(), /missing or changed/u);
  denied(() => journal.checkpoint('must-not-sign'), /missing or changed/u);
  write(primary, 'run.json', { synthetic: 'mutated' });
  denied(() => journal.assertCurrent(), /missing or changed/u);
  renameSync(`${primary}/run.json`, `${root}/retained-mutated-run.json`); renameSync(retained, `${primary}/run.json`);
  const object = readdirSync(`${backup}/objects`)[0]!;
  const objectPath = `${backup}/objects/${object}`;
  renameSync(objectPath, `${root}/retained-checkpoint-object`);
  denied(() => journal.assertCurrent()); denied(() => journal.restore(destination(root)));
  renameSync(`${root}/retained-checkpoint-object`, objectPath);
  chmodSync(objectPath, 0o644); denied(() => journal.assertCurrent()); chmodSync(objectPath, 0o600);
  const copied = journal.restore(destination(root)); restored++;
  assert.equal(copied.assertCurrent().snapshot?.sequence, 1);
  denied(() => createDurableLifecycleJournal(primary, backup, anchor, expected), /never create/u);
  checks.push('missing or mutated committed custody, missing independent bytes, unsafe permissions and reinitialization all refuse');
}

{
  const { root, primary, backup, anchor, journal } = fixture();
  write(primary, 'run.json', { synthetic: true }); journal.checkpoint('before-interruption'); checkpoints++;
  // A publish interrupted after creating the final hardlink is deliberately
  // not accepted as a general hardlink exception. Preserve it and restore the
  // last committed checkpoint into a new tree; no uncheckpointed send occurred.
  write(primary, 'uncheckpointed-intent.json', { synthetic: true });
  linkSync(`${primary}/uncheckpointed-intent.json`, `${primary}/same-bytes.partial`);
  denied(() => journal.checkpoint('must-not-sign'), /without hardlinks/u);
  const restoredBeforeIntent = journal.restore(destination(root)); restored++;
  assert(!readdirSync(restoredBeforeIntent.directory).includes('uncheckpointed-intent.json'));
  assert(readFileSync(`${primary}/uncheckpointed-intent.json`).equals(readFileSync(`${primary}/same-bytes.partial`)));
  const other = fixture();
  write(other.primary, 'run.json', { synthetic: true }); other.journal.checkpoint('before-partial'); checkpoints++;
  writeFileSync(`${other.primary}/.partial-11111111-1111-1111-1111-111111111111`, '{incomplete', { mode: 0o600, flag: 'wx' });
  denied(() => other.journal.assertCurrent(), /unsafe relative path/u);
  other.journal.restore(destination(other.root)); restored++;
  const linked = fixture();
  symlinkSync(`${primary}/run.json`, `${linked.primary}/linked.json`);
  denied(() => linked.journal.checkpoint('must-not-follow'), /symlinks/u);
  const nestedRoot = `${root}/new-primary`; mkdirSync(nestedRoot, { mode: 0o700 });
  const nestedBackup = `${nestedRoot}/nested`; mkdirSync(nestedBackup, { mode: 0o700 });
  const cleanAnchor = `${root}/new-anchor`; mkdirSync(cleanAnchor, { mode: 0o700 });
  denied(() => createDurableLifecycleJournal(nestedRoot, nestedBackup, cleanAnchor, expected), /disjoint/u);
  assert.deepEqual(readdirSync(nestedBackup), []); assert.deepEqual(readdirSync(cleanAnchor), []);
  denied(() => privateJournalDirectory(root, true), /temporary storage/u);
  denied(() => new DurableLifecycleJournal(primary, backup, anchor, { ...expected, chain: 'default-Signet' }), /temporary storage/u);
  checks.push('crash-created partial/hardlink states refuse signing and retain originals; clean latest-checkpoint restoration works; temporary funded state rejects');
}

{
  const { root, primary, backup, anchor, journal } = fixture();
  write(primary, 'run.json', { synthetic: true, original: true }); const checkpoint = journal.checkpoint('before-primary-loss'); checkpoints++;
  const restoreRoot = `${root}/restorations`; mkdirSync(restoreRoot, { mode: 0o700 });
  renameSync(`${primary}/run.json`, `${root}/retained-original-run.json`);
  write(primary, 'run.json', { synthetic: true, damaged: true });
  const restoredPrimary = await restoreLifecyclePrimary(primary, backup, anchor, restoreRoot, expected);
  assert.equal(restoredPrimary.checkpointDigest, checkpoint.checkpointDigest); assert(restoredPrimary.retainedOriginal);
  assert.deepEqual(JSON.parse(readFileSync(`${primary}/run.json`, 'utf8')), { synthetic: true, original: true });
  assert.deepEqual(JSON.parse(readFileSync(`${restoredPrimary.retainedOriginal}/run.json`, 'utf8')), { synthetic: true, damaged: true });
  actualPrimaryCutovers++; restored++;
  renameSync(primary, `${root}/retained-whole-primary`);
  const missingPrimary = await restoreLifecyclePrimary(primary, backup, anchor, restoreRoot, expected);
  assert.equal(missingPrimary.retainedOriginal, null); assert.equal(missingPrimary.checkpointDigest, checkpoint.checkpointDigest);
  actualPrimaryCutovers++; restored++;
  const before = readFileSync(`${primary}/run.json`);
  await assert.rejects(() => restoreLifecyclePrimary(primary, backup, anchor, restoreRoot, expected,
    () => { throw new Error('synthetic pre-cutover refusal'); }), /pre-cutover refusal/u); negatives++;
  assert(readFileSync(`${primary}/run.json`).equals(before));
  const occupied = `${root}/occupied`; mkdirSync(occupied, { mode: 0o700 }); write(occupied, 'user-owned.json', { preserved: true });
  const staged = destination(root); write(staged, 'staged.json', { synthetic: true });
  denied(() => installNewRestoredDirectory(staged, occupied), /occupied/u);
  assert.deepEqual(JSON.parse(readFileSync(`${occupied}/user-owned.json`, 'utf8')), { preserved: true });
  assert(readFileSync(`${staged}/staged.json`));
  checks.push('operator restoration cuts over both missing and damaged whole primaries, retains original damage, and refuses overwrite or failed preflight');
}

{
  for (const damage of ['missing-identity', 'corrupt-identity', 'missing-fences']) {
    const { root, primary, backup, anchor, journal } = fixture();
    write(primary, 'run.json', { synthetic: true, retained: damage });
    const checkpoint = journal.checkpoint('before-primary-metadata-loss'); checkpoints++;
    const identity = `${primary}/.checkpoint-fences/identity.json`;
    if (damage === 'missing-fences') renameSync(`${primary}/.checkpoint-fences`, `${root}/retained-primary-fences`);
    else {
      renameSync(identity, `${root}/retained-primary-identity.json`);
      if (damage === 'corrupt-identity') writePrivateJournalBytes(identity, Buffer.from('{damaged'));
    }
    denied(() => new DurableLifecycleJournal(primary, backup, anchor, expected).assertCurrent());
    const recovered = restoreDurableLifecycleJournal(primary, backup, anchor, destination(root), expected);
    assert.equal(recovered.assertCurrent().snapshot?.checkpointDigest, checkpoint.checkpointDigest);
    assert(readFileSync(`${recovered.directory}/run.json`).equals(readFileSync(`${primary}/run.json`)));
    metadataLossRestorations++; restored++;
    if (damage === 'corrupt-identity') {
      const foreign = fixture();
      renameSync(identity, `${root}/retained-damaged-primary-identity.json`);
      writePrivateJournalBytes(identity, readFileSync(`${foreign.primary}/.checkpoint-fences/identity.json`));
      denied(() => restoreDurableLifecycleJournal(primary, backup, anchor, destination(root), expected), /not paired/u);
      renameSync(identity, `${root}/retained-foreign-primary-identity.json`);
      writePrivateJournalBytes(identity, Buffer.from('{damaged'));
      write(primary, `.checkpoint-fences/000000002-${'ff'.repeat(32)}.json`, { sequence: 2, checkpointDigest: 'ff'.repeat(32) });
      denied(() => restoreDurableLifecycleJournal(primary, backup, anchor, destination(root), expected), /stale or missing/u);
    }
  }
  checks.push('missing/corrupt primary identity and missing fences restore exact anchored custody; valid foreign identity or any newer surviving fence refuses');
}

{
  for (const cut of ['after-snapshot', 'after-primary-fence', 'lost-older-anchor']) {
    const { root, primary, backup, anchor, journal } = fixture();
    write(primary, 'run.json', { synthetic: true }); journal.checkpoint('first-acknowledged-checkpoint'); checkpoints++;
    write(primary, 'newest-intent.json', { synthetic: true, exact: true });
    const latest = journal.checkpoint('latest-complete-checkpoint'); checkpoints++;
    const names = readdirSync(`${backup}/snapshots`).sort();
    const removed = cut === 'lost-older-anchor' ? names[0]! : names.at(-1)!;
    renameSync(`${anchor}/${removed}`, `${root}/retained-anchor.json`);
    if (cut === 'after-snapshot') renameSync(`${primary}/.checkpoint-fences/${removed}`, `${root}/retained-primary-fence.json`);
    denied(() => journal.assertCurrent(), /not independently acknowledged/u);
    denied(() => journal.checkpoint('must-not-sign'), /not independently acknowledged/u);
    const repaired = restoreDurableLifecycleJournal(primary, backup, anchor, destination(root), expected);
    assert.equal(repaired.assertCurrent().snapshot?.checkpointDigest, latest.checkpointDigest);
    assert(readFileSync(`${anchor}/${removed}`).equals(readFileSync(`${root}/retained-anchor.json`)));
    interruptedCheckpointRepairs++; restored++;
  }
  const { root, primary, backup, anchor, journal } = fixture();
  write(primary, 'run.json', { synthetic: true }); journal.checkpoint('only-checkpoint'); checkpoints++;
  const name = readdirSync(`${backup}/snapshots`)[0]!; renameSync(`${anchor}/${name}`, `${root}/retained-only-anchor.json`);
  denied(() => journal.assertCurrent(), /not independently acknowledged/u);
  denied(() => restoreDurableLifecycleJournal(primary, backup, anchor, destination(root), expected), /independently retained/u);
  checks.push('both interrupted publication cuts and partial anchor loss refuse signing; explicit complete verification repairs exact acknowledgements; identity-only anchor never signs');
}

{
  const { root, primary, backup, anchor, journal } = fixture();
  write(primary, 'run.json', { synthetic: true, originalPathPreserved: true }); journal.checkpoint('before-cross-device-preflight'); checkpoints++;
  const otherDevice = mkdtempSync('/dev/shm/btc-presigned-cutover-fixture.');
  assert.notEqual(lstatSync(otherDevice).dev, lstatSync(primary).dev, 'cross-device fixture must actually cross filesystems');
  const before = readFileSync(`${primary}/run.json`);
  await assert.rejects(() => restoreLifecyclePrimary(primary, backup, anchor, otherDevice, expected), /same-filesystem/u); negatives++;
  assert(readFileSync(`${primary}/run.json`).equals(before));
  assert(!readdirSync(root).some(name => name.startsWith('primary.retained-')));
  atomicCutoverPreflightChecks++;
  checks.push('actual cross-device restoration preflight refuses before moving the original primary out of its exact path');
}

{
  const root = mkdtempSync('/tmp/btc-presigned-kernel-lock-fixture.');
  const first = acquireLifecycleProcessLock(root, expected.sourceDigest); kernelLockChecks++;
  denied(() => acquireLifecycleProcessLock(root, expected.sourceDigest), /another lifecycle writer/u);
  first.release(); first.release();
  const afterRelease = acquireLifecycleProcessLock(root, expected.sourceDigest); afterRelease.release(); kernelLockChecks++;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    `import { acquireLifecycleProcessLock } from ${JSON.stringify(new URL('./lib/presigned-lifecycle-lock.ts', import.meta.url).href)};
     const lock = acquireLifecycleProcessLock(${JSON.stringify(root)}, ${JSON.stringify(expected.sourceDigest)});
     process.send('locked'); setInterval(() => {}, 1000);`], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('disposable lock child did not acquire its kernel lock')), 10_000);
      child.once('message', value => { clearTimeout(timeout); value === 'locked' ? resolve() : reject(new Error('unexpected lock child result')); });
      child.once('error', () => { clearTimeout(timeout); reject(new Error('lock fixture child failed')); });
      child.once('exit', () => { clearTimeout(timeout); reject(new Error('lock fixture child exited before readiness')); });
    });
    denied(() => acquireLifecycleProcessLock(root, expected.sourceDigest), /another lifecycle writer/u); kernelLockChecks++;
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    child.kill('SIGKILL'); await exited;
    // No stale PID-file unlink is performed: kernel death releases the inode.
    const afterCrash = acquireLifecycleProcessLock(root, expected.sourceDigest); afterCrash.release(); kernelLockChecks++;
    chmodSync(`${root}/active.lock`, 0o644); denied(() => acquireLifecycleProcessLock(root, expected.sourceDigest)); chmodSync(`${root}/active.lock`, 0o600);
    linkSync(`${root}/active.lock`, `${root}/retained-hardlink`); denied(() => acquireLifecycleProcessLock(root, expected.sourceDigest));
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
  checks.push('kernel single writer refuses concurrent descriptors/processes and releases after a real process crash without deleting PID files');
}

console.log(JSON.stringify({ passed: true, scope: 'private-journal-filesystem-fixtures', configuredNetwork: BITCOIN_NETWORK_NAME,
  syntheticFixtures: true, networkCalls: 0, walletCalls: 0, publicBroadcasts: 0, completeCheckpoints: checkpoints,
  actualCompleteRestorations: restored, rejectedBoundaries: negatives, kernelLockChecks, actualPrimaryCutovers, independentRollbackAnchorRequired: true,
  metadataLossRestorations, interruptedCheckpointRepairs, atomicCutoverPreflightChecks,
  realParticipantCustodyVerified: false, realSignetVerified: false, checks }, null, 2));
