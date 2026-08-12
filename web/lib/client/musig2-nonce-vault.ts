'use client';

import { fromBase64url, toBase64url } from './base64url';

interface NonceBinding {
  proposalId: string;
  proposalDigest: string;
  participantId: string;
  round: string;
  message: string;
  pubnonce: string;
}

interface EncryptedNonce extends NonceBinding {
  version: 1;
  salt: string;
  iv: string;
  ciphertext: string;
}

const INFO = new TextEncoder().encode('btc-multiplayer-vault/musig2-secnonce/v1');

export async function storeCooperativeSecnonce(
  binding: NonceBinding,
  secnonce: string,
  participantSecret: string,
): Promise<void> {
  assertBinding(binding);
  if (!/^[0-9a-f]{194}$/u.test(secnonce)) throw new Error('secret nonce has an invalid shape');
  const storageKey = keyFor(binding.proposalId, binding.participantId);
  if (sessionStorage.getItem(storageKey)) {
    throw new Error('a secret nonce already exists for this participant and proposal');
  }
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = new TextEncoder().encode(JSON.stringify(binding));
  const plaintext = Uint8Array.from(secnonce.match(/../gu)!.map((byte) => Number.parseInt(byte, 16)));
  try {
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 },
      await nonceKey(participantSecret, salt),
      plaintext,
    ));
    const envelope: EncryptedNonce = {
      version: 1,
      ...binding,
      salt: toBase64url(salt),
      iv: toBase64url(iv),
      ciphertext: toBase64url(ciphertext),
    };
    sessionStorage.setItem(storageKey, JSON.stringify(envelope));
  } finally {
    plaintext.fill(0);
  }
}

/** Remove before decrypting so every signing attempt burns the nonce, even on failure. */
export async function consumeCooperativeSecnonce(
  expected: NonceBinding,
  participantSecret: string,
): Promise<Uint8Array> {
  assertBinding(expected);
  const storageKey = keyFor(expected.proposalId, expected.participantId);
  const raw = sessionStorage.getItem(storageKey);
  if (!raw) throw new Error('single-use secret nonce is absent; reject this proposal and start again');
  sessionStorage.removeItem(storageKey);
  const envelope = JSON.parse(raw) as Partial<EncryptedNonce>;
  if (envelope.version !== 1 || JSON.stringify(bindingOf(envelope)) !== JSON.stringify(expected)) {
    throw new Error('stored secret nonce belongs to a different proposal, signer, round, or message');
  }
  const salt = fromBase64url(String(envelope.salt));
  const iv = fromBase64url(String(envelope.iv));
  const ciphertext = fromBase64url(String(envelope.ciphertext));
  const plaintext = new Uint8Array(await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: new TextEncoder().encode(JSON.stringify(expected)),
      tagLength: 128,
    },
    await nonceKey(participantSecret, salt),
    ciphertext,
  ));
  if (plaintext.length !== 97) {
    plaintext.fill(0);
    throw new Error('decrypted secret nonce has an invalid length');
  }
  return plaintext;
}

export function hasCooperativeSecnonce(proposalId: string, participantId: string): boolean {
  if (typeof sessionStorage === 'undefined') return false;
  return Boolean(sessionStorage.getItem(keyFor(proposalId, participantId)));
}

export function storedCooperativePubnonce(proposalId: string, participantId: string): string | null {
  if (typeof sessionStorage === 'undefined') return null;
  const raw = sessionStorage.getItem(keyFor(proposalId, participantId));
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<EncryptedNonce>;
    return typeof value.pubnonce === 'string' && /^[0-9a-f]{132}$/u.test(value.pubnonce)
      ? value.pubnonce
      : null;
  } catch {
    return null;
  }
}

function bindingOf(value: Partial<EncryptedNonce>): NonceBinding {
  return {
    proposalId: String(value.proposalId || ''),
    proposalDigest: String(value.proposalDigest || ''),
    participantId: String(value.participantId || ''),
    round: String(value.round || ''),
    message: String(value.message || ''),
    pubnonce: String(value.pubnonce || ''),
  };
}

function assertBinding(value: NonceBinding): void {
  if (!/^[0-9a-f-]{36}$/iu.test(value.proposalId)) throw new Error('nonce proposal id is invalid');
  if (!/^[0-9a-f]{64}$/u.test(value.proposalDigest)) throw new Error('nonce proposal digest is invalid');
  if (!/^(alice|bob|carol)$/u.test(value.participantId)) throw new Error('nonce participant is invalid');
  if (!/^(alicebobcarol|alicebob|alicecarol|bobcarol)$/u.test(value.round)) throw new Error('nonce round is invalid');
  if (!/^[0-9a-f]{64}$/u.test(value.message)) throw new Error('nonce message is invalid');
  if (!/^[0-9a-f]{132}$/u.test(value.pubnonce)) throw new Error('public nonce is invalid');
}

async function nonceKey(participantSecret: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(participantSecret),
    'HKDF',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: asArrayBuffer(salt),
      info: asArrayBuffer(INFO),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function asArrayBuffer(value: Uint8Array): ArrayBuffer {
  return Uint8Array.from(value).buffer;
}

function keyFor(proposalId: string, participantId: string): string {
  return `btc-vault:musig2:${proposalId}:${participantId}`;
}
