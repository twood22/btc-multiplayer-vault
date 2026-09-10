/** Explicit whole-primary cutover. Never overwrite or delete existing custody.
 * The caller MUST hold the common independent-backup operation lock throughout.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync } from 'node:fs';
import { dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DurableLifecycleJournal, privateJournalDirectory, restoreDurableLifecycleJournal,
  syncPrivateJournalDirectory } from './presigned-durable-journal.js';

export function installNewRestoredDirectory(staging: string, destination: string) {
  privateJournalDirectory(staging, false); privateJournalDirectory(dirname(destination), false);
  assert(lstatSync(staging).dev === lstatSync(dirname(destination)).dev && !destination.startsWith(`${staging}/`),
    'restoration requires an atomic same-filesystem sibling cutover');
  assert(!existsSync(destination), 'restoration destination is occupied; nothing was overwritten');
  execFileSync('/usr/bin/mv', ['--no-copy', '--no-clobber', '--no-target-directory', '--', staging, destination], { stdio: 'ignore' });
  assert(!existsSync(staging) && existsSync(destination), 'restoration cutover refused an occupied destination; inspect retained staging');
  syncPrivateJournalDirectory(dirname(destination));
  if (dirname(staging) !== dirname(destination)) syncPrivateJournalDirectory(dirname(staging));
}
export async function restoreLifecyclePrimary(directory: string, backupDirectory: string, anchorDirectory: string,
  restorationParent: string, expected: ConstructorParameters<typeof DurableLifecycleJournal>[3],
  verifyRestored?: (restored: DurableLifecycleJournal) => void | Promise<void>) {
  privateJournalDirectory(restorationParent, expected.chain === 'default-Signet');
  const destination = mkdtempSync(`${restorationParent}/journal-cutover.`);
  const restored = restoreDurableLifecycleJournal(directory, backupDirectory, anchorDirectory, destination, expected);
  await verifyRestored?.(restored);
  privateJournalDirectory(dirname(directory), expected.chain === 'default-Signet');
  assert(lstatSync(destination).dev === lstatSync(dirname(directory)).dev && !directory.startsWith(`${destination}/`),
    'restoration requires an atomic same-filesystem sibling cutover before retaining any original');
  let retainedOriginal: string | null = null;
  if (existsSync(directory)) {
    privateJournalDirectory(directory, expected.chain === 'default-Signet');
    retainedOriginal = `${directory}.retained-${randomUUID()}`;
    installNewRestoredDirectory(directory, retainedOriginal);
  }
  installNewRestoredDirectory(destination, directory);
  const journal = new DurableLifecycleJournal(directory, backupDirectory, anchorDirectory, expected);
  const checkpoint = journal.assertCurrent().snapshot; assert(checkpoint);
  return { journal, checkpointDigest: checkpoint.checkpointDigest, retainedOriginal };
}
