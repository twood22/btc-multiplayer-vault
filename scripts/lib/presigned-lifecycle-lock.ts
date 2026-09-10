/** Kernel-owned single-writer lock. No stale PID deletion or lock-file races.
 * flock inherits the parent's open file description; closing that descriptor
 * releases the lock, including on process death or reboot. The inode remains.
 */
import assert from 'node:assert/strict';
import { constants, closeSync, fstatSync, fsyncSync, ftruncateSync, openSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { privateJournalDirectory } from './presigned-durable-journal.js';

export function acquireLifecycleProcessLock(directory: string, sourceDigest: string) {
  privateJournalDirectory(directory, false);
  assert(/^[0-9a-f]{64}$/u.test(sourceDigest));
  const fd = openSync(`${directory}/active.lock`, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  let held = false;
  try {
    const stat = fstatSync(fd);
    assert(stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0 && stat.size <= 4096,
      'single-writer lock must be a private owned regular file');
    const result = spawnSync('/usr/bin/flock', ['--nonblock', '3'], { stdio: ['ignore', 'ignore', 'ignore', fd] });
    assert(result.status === 0, 'another lifecycle writer holds the kernel lock, or flock is unavailable');
    held = true;
    ftruncateSync(fd, 0);
    writeFileSync(fd, `${JSON.stringify({ version: 2, kind: 'kernel-flock-diagnostic-only', pid: process.pid,
      sourceDigest, acquiredAt: new Date().toISOString() })}\n`);
    fsyncSync(fd);
  } catch (error) { closeSync(fd); throw error; }
  return { release() { if (held) { closeSync(fd); held = false; } } };
}
