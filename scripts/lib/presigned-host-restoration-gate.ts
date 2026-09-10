/** Attempt-bound, independently retained whole-host restore acknowledgements.
 * Ordinary start/sign operations cannot repair, ignore or reuse a pending
 * attempt. Explicit restoration may finish exact interrupted replica writes.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { commitmentDigest } from '../../src/presigned/validation.js';
import { parsePrivateJournalJson, privateJournalDirectory, readPrivateJournalBytes, writePrivateJournalBytes } from './presigned-durable-journal.js';
import { verifyNativeWalletRestoreProof } from './presigned-wallet-restore-proof.js';
import type { PersistentSignetControl } from './presigned-signet-host-state.js';

type NativeBinding = Parameters<typeof verifyNativeWalletRestoreProof>[1];
type NativeReceipt = ReturnType<typeof verifyNativeWalletRestoreProof> & { directory: string };
export interface HostRestorationAttempt {
  version: 2; kind: 'exact-isolated-host-restoration'; attemptId: string; sequence: number; attemptDigest: string; createdAt: string;
  hostId: string; sourceDigest: string; originalDirectory: string; backupRoot: string; anchorRoot: string;
  checkpointDigest: string | null; nativeRecovery: NativeReceipt & { binding: NativeBinding };
}
interface Completion {
  version: 2; kind: 'exact-isolated-host-restored'; attemptId: string; sequence: number; attemptDigest: string;
  nativeProof: NativeReceipt; participantKitsRestored: number; publicTransactionsSent: 0;
  walletBroadcastDisabled: true; originalSourceAndReceivingAddressRetained: true; restoredAt: string;
}
const encode = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const attemptName = (attempt: HostRestorationAttempt) => `host-restore-attempt-${String(attempt.sequence).padStart(9, '0')}.${attempt.attemptId}.json`;
const completionName = (attempt: HostRestorationAttempt) => `host-restore-complete-${String(attempt.sequence).padStart(9, '0')}.${attempt.attemptId}.json`;
const digest = (body: Omit<HostRestorationAttempt, 'attemptDigest'>) => commitmentDigest('vault/presigned-graph-v2/exact-host-restoration-attempt', body);
function checkedNativeDirectory(control: PersistentSignetControl, directory: string) {
  assert(dirname(directory) === control.nativeWalletBackupParent && /^wallet-restore-proof\.[A-Za-z0-9]{6}$/u.test(basename(directory)),
    'host restoration native proof escaped its independent private store');
}
function checkAttempt(control: PersistentSignetControl, attempt: HostRestorationAttempt, filename: string) {
  const { attemptDigest, ...body } = attempt;
  assert(attempt.version === 2 && attempt.kind === 'exact-isolated-host-restoration' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(attempt.attemptId) &&
    Number.isSafeInteger(attempt.sequence) && attempt.sequence > 0 && attempt.sequence <= 999_999_999 &&
    Number.isFinite(Date.parse(attempt.createdAt)) && filename === attemptName(attempt) && attemptDigest === digest(body) &&
    attempt.hostId === control.hostId && attempt.sourceDigest === control.sourceDigest && attempt.originalDirectory === control.directory &&
    attempt.backupRoot === control.backupRoot && attempt.anchorRoot === control.anchorRoot &&
    (attempt.checkpointDigest === null || /^[0-9a-f]{64}$/u.test(attempt.checkpointDigest)), 'whole-host restoration attempt binding changed');
  const native = attempt.nativeRecovery; checkedNativeDirectory(control, native.directory);
  assert(native.binding.chain === 'signet' && native.binding.binarySha256 === control.binarySha256, 'restoration original native proof changed networks or binary');
  const proof = verifyNativeWalletRestoreProof(native.directory, native.binding);
  assert(proof.backupSha256 === native.backupSha256 && proof.proofSha256 === native.proofSha256 &&
    proof.actualRestoredNativeSignatures === native.actualRestoredNativeSignatures, 'restoration lost its exact original native backup');
}
/** Exclusive immutable publication. Existing bytes must be exactly identical. */
function publishExact(filename: string, bytes: Buffer) {
  if (existsSync(filename)) assert(readPrivateJournalBytes(filename).equals(bytes), 'restoration replica conflicts; retain and inspect both records');
  else writePrivateJournalBytes(filename, bytes);
}
function listAttempts(root: string) {
  privateJournalDirectory(root, true);
  return readdirSync(root).filter(name => {
    if (!name.startsWith('host-restore-attempt-')) return false;
    assert(/^host-restore-attempt-\d{9}\.[0-9a-f-]{36}\.json$/u.test(name), 'invalid restoration attempt filename');
    return true;
  }).sort();
}
export function latestHostRestorationAttempt(control: PersistentSignetControl, repairInterruptedReplicas = false) {
  const stores = [control.backupRoot, control.anchorRoot];
  const lists = stores.map(listAttempts);
  const names = [...new Set(lists.flat())].sort();
  assert(names.length <= 10_000 && names.every((name, index) => Number(name.slice(21, 30)) === index + 1),
    'whole-host restoration sequence is missing or duplicated');
  for (const root of stores) for (const name of readdirSync(root).filter(name => name.startsWith('host-restore-complete-'))) {
    assert(/^host-restore-complete-\d{9}\.[0-9a-f-]{36}\.json$/u.test(name) &&
      names.includes(name.replace('host-restore-complete-', 'host-restore-attempt-')),
      'surviving host restoration completion has no matching attempt; refuse rollback or fresh-host interpretation');
  }
  let latest: HostRestorationAttempt | null = null;
  for (const name of names) {
    const present = stores.filter(root => existsSync(`${root}/${name}`));
    assert(present.length === 2 || repairInterruptedReplicas, 'an interrupted restoration attempt is not independently acknowledged; use explicit host recovery');
    const bytes = readPrivateJournalBytes(`${present[0]}/${name}`);
    const attempt = parsePrivateJournalJson<HostRestorationAttempt>(bytes); checkAttempt(control, attempt, name);
    for (const root of present) assert(readPrivateJournalBytes(`${root}/${name}`).equals(bytes), 'independent restoration attempt records differ');
    if (repairInterruptedReplicas) for (const root of stores) publishExact(`${root}/${name}`, bytes);
    if (hasHostRestorationCompletion(control, attempt)) verifyHostRestorationCompletion(control, attempt, false, repairInterruptedReplicas);
    latest = attempt;
  }
  return latest;
}
export function restorationAttemptWalletBinding(attempt: HostRestorationAttempt): NativeBinding {
  return { ...attempt.nativeRecovery.binding,
    bindingDigest: commitmentDigest('vault/presigned-graph-v2/restored-host-wallet-for-exact-attempt', { attemptDigest: attempt.attemptDigest }) };
}
/** Caller holds the shared independent-store lock. Reuse only the exact pending
 * attempt after a crash; an older completed attempt cannot satisfy a new one. */
export function beginHostRestorationAttempt(control: PersistentSignetControl, checkpointDigest: string | null,
  native: { directory: string; binding: NativeBinding }) {
  const previous = latestHostRestorationAttempt(control, true);
  if (previous && ![control.backupRoot, control.anchorRoot].some(root => existsSync(`${root}/${completionName(previous)}`))) {
    assert(previous.checkpointDigest === checkpointDigest && previous.nativeRecovery.directory === native.directory &&
      JSON.stringify(previous.nativeRecovery.binding) === JSON.stringify(native.binding), 'pending restoration has different original custody');
    return previous;
  }
  if (previous) verifyHostRestorationCompletion(control, previous, false, true);
  const body: Omit<HostRestorationAttempt, 'attemptDigest'> = { version: 2, kind: 'exact-isolated-host-restoration', attemptId: randomUUID(),
    sequence: (previous?.sequence ?? 0) + 1, createdAt: new Date().toISOString(), hostId: control.hostId,
    sourceDigest: control.sourceDigest, originalDirectory: control.directory, backupRoot: control.backupRoot, anchorRoot: control.anchorRoot,
    checkpointDigest, nativeRecovery: { directory: native.directory, binding: native.binding, ...verifyNativeWalletRestoreProof(native.directory, native.binding) } };
  const attempt = { ...body, attemptDigest: digest(body) }; checkAttempt(control, attempt, attemptName(attempt));
  for (const root of [control.backupRoot, control.anchorRoot]) publishExact(`${root}/${attemptName(attempt)}`, encode(attempt));
  return attempt;
}
export function pinPrimaryHostRestorationAttempt(control: PersistentSignetControl, attempt: HostRestorationAttempt, directory = control.directory) {
  publishExact(`${directory}/host-restoration-intent.json`, encode(attempt));
}
export function hasHostRestorationCompletion(control: PersistentSignetControl, attempt: HostRestorationAttempt) {
  return [control.backupRoot, control.anchorRoot].some(root => existsSync(`${root}/${completionName(attempt)}`));
}
export function verifyHostRestorationCompletion(control: PersistentSignetControl, attempt: HostRestorationAttempt,
  requirePrimary = true, repairInterruptedReplicas = false) {
  const stores = [control.backupRoot, control.anchorRoot]; const name = completionName(attempt);
  const present = stores.filter(root => existsSync(`${root}/${name}`));
  assert(present.length === 2 || (repairInterruptedReplicas && present.length === 1),
    'whole-host restoration is incomplete; explicit host-resume must finish the new native custody proof');
  const bytes = readPrivateJournalBytes(`${present[0]}/${name}`);
  const result = parsePrivateJournalJson<Completion>(bytes);
  checkCompletion(control, attempt, result);
  for (const root of present) assert(readPrivateJournalBytes(`${root}/${name}`).equals(bytes), 'host restoration completion replicas disagree');
  if (repairInterruptedReplicas) for (const root of stores) publishExact(`${root}/${name}`, bytes);
  if (requirePrimary) {
    const primary = `${control.directory}/host-restoration-completion.json`;
    if (repairInterruptedReplicas) publishExact(primary, bytes);
    assert(readPrivateJournalBytes(primary).equals(bytes), 'primary restore acknowledgement is missing or stale');
  }
  return result;
}
function checkCompletion(control: PersistentSignetControl, attempt: HostRestorationAttempt, result: Completion) {
  assert(result.version === 2 && result.kind === 'exact-isolated-host-restored' && result.attemptId === attempt.attemptId &&
    result.sequence === attempt.sequence && result.attemptDigest === attempt.attemptDigest &&
    Number.isSafeInteger(result.participantKitsRestored) && result.participantKitsRestored >= 0 && result.participantKitsRestored <= 57 &&
    result.publicTransactionsSent === 0 && result.walletBroadcastDisabled === true && result.originalSourceAndReceivingAddressRetained === true &&
    Number.isFinite(Date.parse(result.restoredAt)), 'host restoration completion belongs to another attempt or incomplete custody');
  checkedNativeDirectory(control, result.nativeProof.directory);
  assert(result.nativeProof.directory !== attempt.nativeRecovery.directory, 'host recovery requires a new independent native proof');
  const proof = verifyNativeWalletRestoreProof(result.nativeProof.directory, restorationAttemptWalletBinding(attempt));
  assert(proof.backupSha256 === result.nativeProof.backupSha256 && proof.proofSha256 === result.nativeProof.proofSha256 &&
    proof.actualRestoredNativeSignatures === result.nativeProof.actualRestoredNativeSignatures &&
    proof.actualRestoredNativeSignatures === attempt.nativeRecovery.actualRestoredNativeSignatures, 'new host native proof differs from its completion');
}
export function completeHostRestorationAttempt(control: PersistentSignetControl, attempt: HostRestorationAttempt,
  nativeProof: NativeReceipt, participantKitsRestored: number) {
  const latest = latestHostRestorationAttempt(control); assert(latest?.attemptDigest === attempt.attemptDigest);
  const result: Completion = { version: 2, kind: 'exact-isolated-host-restored', attemptId: attempt.attemptId, sequence: attempt.sequence,
    attemptDigest: attempt.attemptDigest, nativeProof, participantKitsRestored, publicTransactionsSent: 0, walletBroadcastDisabled: true,
    originalSourceAndReceivingAddressRetained: true, restoredAt: new Date().toISOString() };
  checkCompletion(control, attempt, result);
  const bytes = encode(result);
  for (const root of [control.backupRoot, control.anchorRoot]) publishExact(`${root}/${completionName(attempt)}`, bytes);
  publishExact(`${control.directory}/host-restoration-completion.json`, bytes);
  return verifyHostRestorationCompletion(control, attempt);
}
export function assertHostRestorationReady(control: PersistentSignetControl) {
  const latest = latestHostRestorationAttempt(control);
  const primary = `${control.directory}/host-restoration-intent.json`;
  if (!latest) {
    assert(!existsSync(primary) && !existsSync(`${control.directory}/host-restoration-completion.json`),
      'primary has unanchored restoration metadata; never treat it as a fresh host');
    return null;
  }
  assert(readPrivateJournalBytes(primary).equals(encode(latest)), 'primary restoration attempt is absent or rolled back behind its independent anchor');
  return verifyHostRestorationCompletion(control, latest);
}
