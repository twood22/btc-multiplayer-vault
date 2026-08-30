import { fromBase64url, toBase64url } from './base64url';
import {
  BITCOIN_NETWORK_CONFIG,
  BITCOIN_NETWORK_NAME,
} from '../../../src/network';
import type { BitcoinNetworkName } from '../../../src/types';

export interface SigbashCredentials {
  apiKey: string;
  userKey: string;
  userSecretKey: string;
  authHash: string;
  apikeyHash: string;
}

export interface SigbashRecoveryKit {
  version: 'sdk-recovery-v1';
  keyId: string;
  recoveryKEK: string;
  cekCiphertext: string;
  cekNonce: string;
  network: BitcoinNetworkName;
  createdAt: number;
  apiKey?: string;
  userKey?: string;
  popSeed?: string;
}

export interface SigbashCustodyKey {
  round: string;
  keyId: string;
  keyIndex: number;
  policyId: string;
  policyRoot: string;
  bip328Xpub: string;
  poetJSON: unknown;
  recoveryKit: SigbashRecoveryKit;
}

export interface SigbashPendingKey {
  round: string;
  keyIndex: number;
  policyId: string;
}

export interface SigbashCustodyBundle {
  version: 1;
  network: BitcoinNetworkName;
  participantId: 'alice' | 'bob' | 'carol';
  credentials: SigbashCredentials;
  keys: SigbashCustodyKey[];
  pendingKey?: SigbashPendingKey;
}

export interface SigbashCustodyEnvelope {
  version: 1;
  revision: number;
  iv: string;
  ciphertext: string;
  aad: string;
}

const INFO = new TextEncoder().encode('btc-multiplayer-vault/sigbash-custody/v1');
const HEX_32 = /^[0-9a-f]{64}$/u;
const ROUND = /^(alicebobcarol|alicebob|alicecarol|bobcarol)$/u;

/** Browser-safe equivalent of the SDK's Node-only generateCredentials(). */
export async function generateSigbashCredentials(): Promise<SigbashCredentials> {
  const apiKey = randomHex32();
  const userKey = randomHex32();
  const userSecretKey = randomHex32();
  const [authHash, apikeyHash] = await Promise.all([
    doubleSha256(`${apiKey}${userKey}`),
    doubleSha256(`${apiKey}${apiKey}`),
  ]);
  return { apiKey, userKey, userSecretKey, authHash, apikeyHash };
}

export function createEmptySigbashCustodyBundle(
  participantId: SigbashCustodyBundle['participantId'],
  credentials: SigbashCredentials,
): SigbashCustodyBundle {
  return validateSigbashCustodyBundle({
    version: 1,
    network: BITCOIN_NETWORK_NAME,
    participantId,
    credentials,
    keys: [],
  });
}

export async function encryptSigbashCustodyBundle(
  bundle: SigbashCustodyBundle,
  participantSecret: string,
  revision: number,
  aadBase64url: string,
): Promise<SigbashCustodyEnvelope> {
  const validated = validateSigbashCustodyBundle(bundle);
  assertRevision(revision);
  const aad = fromBase64url(aadBase64url);
  const plaintext = new TextEncoder().encode(canonicalJson(validated));
  if (plaintext.length > 64 * 1024) throw new Error('Sigbash custody bundle is too large');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(participantSecret, aad);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: asArrayBuffer(iv), additionalData: asArrayBuffer(aad), tagLength: 128 },
    key,
    asArrayBuffer(plaintext),
  ));
  const roundTrip = new Uint8Array(await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: asArrayBuffer(iv), additionalData: asArrayBuffer(aad), tagLength: 128 },
    key,
    asArrayBuffer(ciphertext),
  ));
  if (!constantTimeEqual(plaintext, roundTrip)) {
    throw new Error('encrypted Sigbash custody bundle failed its local round-trip check');
  }
  plaintext.fill(0);
  roundTrip.fill(0);
  return {
    version: 1,
    revision,
    iv: toBase64url(iv),
    ciphertext: toBase64url(ciphertext),
    aad: aadBase64url,
  };
}

export async function decryptSigbashCustodyEnvelope(
  envelope: SigbashCustodyEnvelope,
  participantSecret: string,
): Promise<SigbashCustodyBundle> {
  if (envelope.version !== 1) throw new Error('unsupported Sigbash custody envelope version');
  assertRevision(envelope.revision);
  const aad = fromBase64url(envelope.aad);
  const key = await deriveKey(participantSecret, aad);
  const plaintext = new Uint8Array(await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: asArrayBuffer(fromBase64url(envelope.iv)),
      additionalData: asArrayBuffer(aad),
      tagLength: 128,
    },
    key,
    asArrayBuffer(fromBase64url(envelope.ciphertext)),
  ));
  try {
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
    return validateSigbashCustodyBundle(parsed);
  } finally {
    plaintext.fill(0);
  }
}

/** Try newest-to-oldest so an interrupted or corrupt append cannot erase a valid backup. */
export async function recoverLatestSigbashCustodyBundle(
  envelopes: SigbashCustodyEnvelope[],
  participantSecret: string,
): Promise<{ bundle: SigbashCustodyBundle; revision: number } | null> {
  const sorted = [...envelopes].sort((left, right) => right.revision - left.revision);
  for (const envelope of sorted) {
    try {
      const bundle = await decryptSigbashCustodyEnvelope(envelope, participantSecret);
      return { bundle, revision: envelope.revision };
    } catch {
      // Append-only history deliberately retains the previous decryptable revision.
    }
  }
  return null;
}

export function validateSigbashCustodyBundle(input: unknown): SigbashCustodyBundle {
  if (!isRecord(input) || input.version !== 1 || input.network !== BITCOIN_NETWORK_NAME) {
    throw new Error('Sigbash custody bundle has an invalid version or network');
  }
  if (!/^(alice|bob|carol)$/u.test(String(input.participantId))) {
    throw new Error('Sigbash custody bundle has an invalid participant');
  }
  const credentials = validateCredentials(input.credentials);
  if (!Array.isArray(input.keys) || input.keys.length > 3) {
    throw new Error('Sigbash custody bundle must contain at most three round keys');
  }
  const keys = input.keys.map(validateCustodyKey);
  for (const key of keys) {
    if (key.policyId !== `${key.round}:${input.participantId}`) {
      throw new Error('Sigbash custody key belongs to a different participant');
    }
    if (key.recoveryKit.apiKey !== undefined && key.recoveryKit.apiKey !== credentials.apiKey) {
      throw new Error('Sigbash recovery kit carries a different API key');
    }
    if (key.recoveryKit.userKey !== undefined && key.recoveryKit.userKey !== credentials.userKey) {
      throw new Error('Sigbash recovery kit carries a different user key');
    }
  }
  if (new Set(keys.map((key) => key.round)).size !== keys.length) {
    throw new Error('Sigbash custody bundle repeats a round');
  }
  if (new Set(keys.map((key) => key.keyId)).size !== keys.length) {
    throw new Error('Sigbash custody bundle repeats a keyId');
  }
  if (new Set(keys.map((key) => key.keyIndex)).size !== keys.length) {
    throw new Error('Sigbash custody bundle repeats a keyIndex');
  }
  const pendingKey = input.pendingKey === undefined ? undefined : validatePendingKey(input.pendingKey);
  if (pendingKey && pendingKey.policyId !== `${pendingKey.round}:${input.participantId}`) {
    throw new Error('Sigbash pending key belongs to a different participant');
  }
  if (pendingKey && keys.some((key) => key.round === pendingKey.round || key.keyIndex === pendingKey.keyIndex)) {
    throw new Error('Sigbash pending key is already present in the custody bundle');
  }
  return {
    version: 1,
    network: BITCOIN_NETWORK_NAME,
    participantId: input.participantId as SigbashCustodyBundle['participantId'],
    credentials,
    keys,
    ...(pendingKey ? { pendingKey } : {}),
  };
}

function validateCredentials(input: unknown): SigbashCredentials {
  if (!isRecord(input)) throw new Error('Sigbash credentials are missing');
  for (const field of ['apiKey', 'userKey', 'userSecretKey', 'authHash', 'apikeyHash'] as const) {
    if (!HEX_32.test(String(input[field]))) throw new Error(`Sigbash credential ${field} is invalid`);
  }
  return {
    apiKey: String(input.apiKey),
    userKey: String(input.userKey),
    userSecretKey: String(input.userSecretKey),
    authHash: String(input.authHash),
    apikeyHash: String(input.apikeyHash),
  };
}

function validateCustodyKey(input: unknown): SigbashCustodyKey {
  if (!isRecord(input)) throw new Error('Sigbash custody key is invalid');
  const round = String(input.round);
  const policyId = String(input.policyId);
  const keyId = String(input.keyId);
  const keyIndex = Number(input.keyIndex);
  if (!ROUND.test(round)) throw new Error('Sigbash custody key round is invalid');
  if (policyId !== `${round}:alice` && policyId !== `${round}:bob` && policyId !== `${round}:carol`) {
    throw new Error('Sigbash custody key policyId is invalid');
  }
  if (!keyId || keyId.length > 256) throw new Error('Sigbash custody keyId is invalid');
  if (!Number.isSafeInteger(keyIndex) || keyIndex < 0 || keyIndex > 63) {
    throw new Error('Sigbash custody keyIndex is invalid');
  }
  if (!HEX_32.test(String(input.policyRoot))) throw new Error('Sigbash policyRoot is invalid');
  const bip328Xpub = String(input.bip328Xpub);
  const strippedXpub = bip328Xpub.replace(/^\[[0-9a-fA-F/h']*\]/u, '');
  if (!strippedXpub.startsWith(BITCOIN_NETWORK_CONFIG.bip32PublicPrefix) ||
      bip328Xpub.length < 100 || bip328Xpub.length > 160) {
    throw new Error('Sigbash xpub is invalid');
  }
  if (!isRecord(input.poetJSON)) throw new Error('Sigbash compiled policy is missing');
  const recoveryKit = validateRecoveryKit(input.recoveryKit, keyId);
  return {
    round,
    keyId,
    keyIndex,
    policyId,
    policyRoot: String(input.policyRoot),
    bip328Xpub,
    poetJSON: structuredClone(input.poetJSON),
    recoveryKit,
  };
}

function validateRecoveryKit(input: unknown, keyId: string): SigbashRecoveryKit {
  if (!isRecord(input) || input.version !== 'sdk-recovery-v1' || input.network !== BITCOIN_NETWORK_NAME) {
    throw new Error('Sigbash recovery kit has an invalid version or network');
  }
  if (input.keyId !== keyId) throw new Error('Sigbash recovery kit belongs to a different key');
  for (const field of ['recoveryKEK', 'cekCiphertext', 'cekNonce'] as const) {
    if (typeof input[field] !== 'string' || !/^[0-9a-f]+$/u.test(input[field]) || input[field].length > 16_384) {
      throw new Error(`Sigbash recovery kit ${field} is invalid`);
    }
  }
  if (!Number.isSafeInteger(input.createdAt) || Number(input.createdAt) <= 0) {
    throw new Error('Sigbash recovery kit timestamp is invalid');
  }
  for (const field of ['apiKey', 'userKey', 'popSeed'] as const) {
    if (input[field] !== undefined && !HEX_32.test(String(input[field]))) {
      throw new Error(`Sigbash recovery kit ${field} is invalid`);
    }
  }
  return {
    version: 'sdk-recovery-v1',
    keyId,
    recoveryKEK: String(input.recoveryKEK),
    cekCiphertext: String(input.cekCiphertext),
    cekNonce: String(input.cekNonce),
    network: BITCOIN_NETWORK_NAME,
    createdAt: Number(input.createdAt),
    ...(input.apiKey === undefined ? {} : { apiKey: String(input.apiKey) }),
    ...(input.userKey === undefined ? {} : { userKey: String(input.userKey) }),
    ...(input.popSeed === undefined ? {} : { popSeed: String(input.popSeed) }),
  };
}

function validatePendingKey(input: unknown): SigbashPendingKey {
  if (!isRecord(input)) throw new Error('Sigbash pending key is invalid');
  const round = String(input.round);
  const policyId = String(input.policyId);
  const keyIndex = Number(input.keyIndex);
  if (!ROUND.test(round) || !policyId.startsWith(`${round}:`)) {
    throw new Error('Sigbash pending key round or policyId is invalid');
  }
  if (!Number.isSafeInteger(keyIndex) || keyIndex < 0 || keyIndex > 63) {
    throw new Error('Sigbash pending keyIndex is invalid');
  }
  return { round, keyIndex, policyId };
}

async function deriveKey(participantSecret: string, aad: Uint8Array): Promise<CryptoKey> {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(participantSecret)) {
    throw new Error('participant secret has an invalid shape');
  }
  const secret = fromBase64url(participantSecret);
  if (secret.length !== 32) throw new Error('participant secret must contain 32 bytes');
  const keyMaterial = await crypto.subtle.importKey('raw', asArrayBuffer(secret), 'HKDF', false, ['deriveKey']);
  const salt = await crypto.subtle.digest('SHA-256', asArrayBuffer(aad));
  secret.fill(0);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: INFO },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function doubleSha256(value: string): Promise<string> {
  const first = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  const second = await crypto.subtle.digest('SHA-256', first);
  return hex(new Uint8Array(second));
}

function randomHex32(): string {
  return hex(crypto.getRandomValues(new Uint8Array(32)));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function assertRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 1 || revision > 32) {
    throw new Error('Sigbash custody revision is invalid');
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function asArrayBuffer(value: Uint8Array): ArrayBuffer {
  return Uint8Array.from(value).buffer;
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}
