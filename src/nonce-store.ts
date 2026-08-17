import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import type { Hex } from './types.js';

export interface StoredSecnonce {
  version: 1;
  participantId: string;
  round: string;
  message: Hex;
  pubnonce: Hex;
  secnonce: Hex;
}

export type SecnonceExpectation = Omit<StoredSecnonce, 'version' | 'secnonce'>;

/** Create a new owner-only nonce file. Existing paths are never overwritten. */
export function saveSecnonce(path: string, record: StoredSecnonce): void {
  assertRecord(record);
  let fd: number | undefined;
  try {
    fd = openSync(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollowFlag(),
      0o600,
    );
    writeFileSync(fd, `${JSON.stringify(record)}\n`, { encoding: 'utf8' });
    fsyncSync(fd);
  } catch (error) {
    throw new Error(`could not create the single-use secnonce file at ${path}: ${messageOf(error)}`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Read, bind, and destroy a nonce before signing. A signing failure therefore
 * burns the nonce instead of leaving it available for an unsafe retry.
 */
export function loadAndBurnSecnonce(path: string, expected: SecnonceExpectation): StoredSecnonce {
  let fd: number | undefined;
  try {
    const pathStat = lstatSync(path);
    if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
      throw new Error('secnonce path must be a regular file, not a link or special file');
    }
    if ((pathStat.mode & 0o077) !== 0) {
      throw new Error('secnonce file permissions expose it to group or other users; require mode 0600 or stricter');
    }
    fd = openSync(path, constants.O_RDONLY | noFollowFlag());
    const openedStat = fstatSync(fd);
    if (openedStat.dev !== pathStat.dev || openedStat.ino !== pathStat.ino) {
      throw new Error('secnonce file changed while it was being opened');
    }
    const parsed = JSON.parse(readFileSync(fd, 'utf8')) as unknown;
    const record = assertRecord(parsed);
    if (record.participantId !== expected.participantId) {
      throw new Error('secnonce file belongs to a different participant');
    }
    if (record.round !== expected.round) {
      throw new Error('secnonce file belongs to a different vault round');
    }
    if (record.message !== expected.message) {
      throw new Error('secnonce file belongs to a different signing message');
    }
    if (record.pubnonce !== expected.pubnonce) {
      throw new Error('secnonce file does not match this participant\'s published nonce');
    }
    const finalPathStat = lstatSync(path);
    if (
      finalPathStat.isSymbolicLink() ||
      finalPathStat.dev !== openedStat.dev ||
      finalPathStat.ino !== openedStat.ino
    ) {
      throw new Error('secnonce file changed before it could be destroyed');
    }
    closeSync(fd);
    fd = undefined;
    unlinkSync(path);
    return record;
  } catch (error) {
    throw new Error(`could not consume the single-use secnonce file at ${path}: ${messageOf(error)}`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function assertRecord(candidate: unknown): StoredSecnonce {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new Error('secnonce file is not a JSON object');
  }
  const record = candidate as Partial<StoredSecnonce>;
  if (record.version !== 1) throw new Error('unsupported secnonce file version');
  if (typeof record.participantId !== 'string' || !/^[a-z0-9_-]+$/.test(record.participantId)) {
    throw new Error('secnonce file has an invalid participant id');
  }
  if (typeof record.round !== 'string' || !/^[a-z0-9_-]+$/.test(record.round)) {
    throw new Error('secnonce file has an invalid vault round');
  }
  if (typeof record.message !== 'string' || !/^[0-9a-f]{64}$/.test(record.message)) {
    throw new Error('secnonce file has an invalid signing message');
  }
  if (typeof record.pubnonce !== 'string' || !/^[0-9a-f]{132}$/.test(record.pubnonce)) {
    throw new Error('secnonce file has an invalid public nonce');
  }
  if (typeof record.secnonce !== 'string' || !/^[0-9a-f]{194}$/.test(record.secnonce)) {
    throw new Error('secnonce file has invalid secret nonce material');
  }
  return record as StoredSecnonce;
}

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
