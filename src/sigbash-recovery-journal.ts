import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import type {
  PoetPolicy,
  SigbashKeyListItem,
  SigbashRecoveryKit,
} from './sigbash.js';
import { fsyncDirectory } from './operator-environment.js';
import { BITCOIN_NETWORK_NAME } from './network.js';
import type { BitcoinNetworkName } from './types.js';

const JOURNAL_VERSION = 'btc-multiplayer-vault-sigbash-recovery-v1' as const;
const HEX_32_BYTES = /^[0-9a-f]{64}$/u;
const HEX_NONEMPTY_BYTES = /^(?:[0-9a-f]{2})+$/u;
const HEX_12_BYTES = /^[0-9a-f]{24}$/u;
const ROUND_MEMBERS = new Map<string, ReadonlySet<string>>([
  ['alicebob', new Set(['alice', 'bob'])],
  ['alicecarol', new Set(['alice', 'carol'])],
  ['bobcarol', new Set(['bob', 'carol'])],
  ['alicebobcarol', new Set(['alice', 'bob', 'carol'])],
]);

export interface SigbashRecoveryRecord {
  version: typeof JOURNAL_VERSION;
  participantId: string;
  round: string;
  keyId: string;
  keyIndex: number;
  network: BitcoinNetworkName;
  recoveryKit: SigbashRecoveryKit;
}

export function readSigbashRecoveryJournal(rawPath: string): SigbashRecoveryRecord[] {
  const journalPath = resolve(rawPath);
  if (!existsSync(journalPath)) return [];
  assertProtectedPath(journalPath);
  const records = readFileSync(journalPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map(parseSigbashRecoveryRecord);
  assertUniqueRecords(records);
  return records;
}

export function appendSigbashRecoveryRecord(
  rawPath: string,
  input: Omit<SigbashRecoveryRecord, 'version' | 'network'> & { network: string },
): { path: string; reused: boolean } {
  const journalPath = resolve(rawPath);
  const parent = dirname(journalPath);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  assertProtectedParent(parent);

  const record = validateSigbashRecoveryRecord({
    ...input,
    version: JOURNAL_VERSION,
  });
  const existing = readSigbashRecoveryJournal(journalPath);
  const identity = recordIdentity(record);
  const prior = existing.find((candidate) => recordIdentity(candidate) === identity);
  if (prior) {
    if (canonicalJson(prior) !== canonicalJson(record)) {
      throw new Error(`Sigbash recovery journal already contains conflicting entry for ${identity}`);
    }
    return { path: journalPath, reused: true };
  }
  if (existing.some((candidate) =>
    candidate.participantId === record.participantId && candidate.keyId === record.keyId,
  )) {
    throw new Error(
      `Sigbash recovery journal keyId ${record.keyId} is already bound to another round for ${record.participantId}`,
    );
  }

  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      journalPath,
      fsConstants.O_APPEND |
        fsConstants.O_CREAT |
        fsConstants.O_WRONLY |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, `${JSON.stringify(record)}\n`, { encoding: 'utf8' });
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  assertProtectedPath(journalPath);
  fsyncDirectory(parent);
  return { path: journalPath, reused: false };
}

export function findMatchingSigbashKey(
  listed: SigbashKeyListItem[],
  requestedPolicy: PoetPolicy,
  network: string,
): (SigbashKeyListItem & { keyIndex: number }) | null {
  const requested = canonicalJson(requestedPolicy);
  const matches = listed.filter((candidate) =>
    candidate.network === network && canonicalJson(candidate.poetJSON) === requested,
  );
  if (matches.length > 1) {
    throw new Error('multiple Sigbash keys match the requested immutable policy; refusing ambiguous resume');
  }
  const match = matches[0];
  if (!match) return null;
  const keyIndex = Number(match.keyId);
  if (!Number.isSafeInteger(keyIndex) || keyIndex < 0 || keyIndex > 63 || String(keyIndex) !== match.keyId) {
    throw new Error(`matching Sigbash keyId ${match.keyId} is not a valid SDK key index`);
  }
  if (!match.bip328Xpub || !match.policyRoot) {
    throw new Error(`matching Sigbash keyId ${match.keyId} is missing its public key summary`);
  }
  return { ...match, keyIndex };
}

export function findRecoveryRecord(
  records: SigbashRecoveryRecord[],
  participantId: string,
  round: string,
): SigbashRecoveryRecord | null {
  return records.find((record) =>
    record.participantId === participantId && record.round === round,
  ) ?? null;
}

function parseSigbashRecoveryRecord(line: string): SigbashRecoveryRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error('Sigbash recovery journal contains malformed JSON');
  }
  return validateSigbashRecoveryRecord(parsed);
}

function validateSigbashRecoveryRecord(input: unknown): SigbashRecoveryRecord {
  if (!isRecord(input)) throw new Error('Sigbash recovery journal entry must be an object');
  assertExactKeys(input, [
    'version', 'participantId', 'round', 'keyId', 'keyIndex', 'network', 'recoveryKit',
  ], 'Sigbash recovery journal entry');
  if (input.version !== JOURNAL_VERSION) throw new Error('unsupported Sigbash recovery journal version');
  if (typeof input.participantId !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/u.test(input.participantId)) {
    throw new Error('invalid Sigbash recovery journal participantId');
  }
  if (typeof input.round !== 'string' || !ROUND_MEMBERS.has(input.round)) {
    throw new Error('invalid Sigbash recovery journal round; expected a canonical product round id');
  }
  if (!ROUND_MEMBERS.get(input.round)!.has(input.participantId)) {
    throw new Error('Sigbash recovery journal participant is not a member of its round');
  }
  if (typeof input.keyId !== 'string' || !/^\d{1,2}$/u.test(input.keyId)) {
    throw new Error('invalid Sigbash recovery journal keyId');
  }
  if (typeof input.keyIndex !== 'number' || !Number.isSafeInteger(input.keyIndex) ||
      input.keyIndex < 0 || input.keyIndex > 63 ||
      String(input.keyIndex) !== input.keyId) {
    throw new Error('Sigbash recovery journal keyId and keyIndex do not match');
  }
  if (input.network !== BITCOIN_NETWORK_NAME) {
    throw new Error(`Sigbash recovery journal is not ${BITCOIN_NETWORK_NAME}`);
  }
  const kit = validateRecoveryKit(input.recoveryKit, input.keyId, BITCOIN_NETWORK_NAME);
  return {
    version: JOURNAL_VERSION,
    participantId: input.participantId,
    round: input.round,
    keyId: input.keyId,
    keyIndex: input.keyIndex,
    network: BITCOIN_NETWORK_NAME,
    recoveryKit: kit,
  };
}

function validateRecoveryKit(input: unknown, keyId: string, network: string): SigbashRecoveryKit {
  if (!isRecord(input)) throw new Error('Sigbash recovery kit must be an object');
  assertAllowedKeys(input, [
    'version', 'keyId', 'recoveryKEK', 'cekCiphertext', 'cekNonce', 'network', 'createdAt',
    'apiKey', 'userKey', 'popSeed',
  ], 'Sigbash recovery kit');
  for (const field of ['version', 'keyId', 'recoveryKEK', 'cekCiphertext', 'cekNonce', 'network', 'createdAt']) {
    if (!(field in input)) throw new Error(`Sigbash recovery kit is missing ${field}`);
  }
  if (input.version !== 'sdk-recovery-v1') throw new Error('unsupported Sigbash recovery kit version');
  if (input.keyId !== keyId) throw new Error('Sigbash recovery kit keyId does not match its journal entry');
  if (input.network !== network) throw new Error('Sigbash recovery kit network does not match its journal entry');
  if (typeof input.recoveryKEK !== 'string' || !HEX_32_BYTES.test(input.recoveryKEK)) {
    throw new Error('Sigbash recovery kit has invalid recoveryKEK');
  }
  if (typeof input.cekCiphertext !== 'string' || !HEX_NONEMPTY_BYTES.test(input.cekCiphertext)) {
    throw new Error('Sigbash recovery kit has invalid cekCiphertext');
  }
  if (typeof input.cekNonce !== 'string' || !HEX_12_BYTES.test(input.cekNonce)) {
    throw new Error('Sigbash recovery kit has invalid cekNonce');
  }
  if (typeof input.createdAt !== 'number' || !Number.isSafeInteger(input.createdAt) || input.createdAt <= 0) {
    throw new Error('Sigbash recovery kit has invalid createdAt');
  }
  for (const field of ['apiKey', 'userKey', 'popSeed'] as const) {
    if (input[field] !== undefined &&
        (typeof input[field] !== 'string' || !HEX_32_BYTES.test(input[field]))) {
      throw new Error(`Sigbash recovery kit has invalid ${field}`);
    }
  }
  return input as unknown as SigbashRecoveryKit;
}

function assertUniqueRecords(records: SigbashRecoveryRecord[]): void {
  const identities = new Set<string>();
  const participantKeyIds = new Set<string>();
  for (const record of records) {
    const identity = recordIdentity(record);
    if (identities.has(identity)) throw new Error(`duplicate Sigbash recovery journal entry for ${identity}`);
    const participantKeyId = `${record.participantId}:${record.keyId}`;
    if (participantKeyIds.has(participantKeyId)) {
      throw new Error(`duplicate Sigbash recovery journal keyId ${record.keyId} for ${record.participantId}`);
    }
    identities.add(identity);
    participantKeyIds.add(participantKeyId);
  }
}

function assertProtectedParent(parent: string): void {
  const stat = lstatSync(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Sigbash recovery journal parent must be a real directory, not a link');
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error('Sigbash recovery journal parent must not be accessible by group or other users');
  }
}

function assertProtectedPath(path: string): void {
  assertProtectedParent(dirname(path));
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Sigbash recovery journal must be a regular file, not a link');
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error('Sigbash recovery journal must not be accessible by group or other users');
  }
}

function recordIdentity(record: Pick<SigbashRecoveryRecord, 'participantId' | 'round'>): string {
  return `${record.participantId}:${record.round}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('cannot canonically encode undefined Sigbash policy value');
  return encoded;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, expected: string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.join(',') !== wanted.join(',')) throw new Error(`${label} has unexpected or missing fields`);
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length > 0) throw new Error(`${label} has unexpected fields: ${extra.join(',')}`);
}
