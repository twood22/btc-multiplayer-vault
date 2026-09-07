import { fromBase64url, toBase64url } from './base64url';

export interface KeyEnvelope {
  version: 1;
  iv: string;
  ciphertext: string;
  aad: string;
}

const INFO = new TextEncoder().encode('btc-multiplayer-vault/passkey-envelope/v1');

export async function createParticipantSecretEnvelope(
  prfOutput: Uint8Array,
  aadBase64url: string,
): Promise<{ envelope: KeyEnvelope; participantSecret: string }> {
  const secretBytes = crypto.getRandomValues(new Uint8Array(32));
  try {
    const participantSecret = toBase64url(secretBytes);
    const envelope = await encryptParticipantSecretEnvelope(
      participantSecret,
      prfOutput,
      aadBase64url,
    );
    return { participantSecret, envelope };
  } finally { secretBytes.fill(0); }
}

export async function encryptParticipantSecretEnvelope(
  participantSecret: string,
  prfOutput: Uint8Array,
  aadBase64url: string,
): Promise<KeyEnvelope> {
  if (prfOutput.length !== 32) throw new Error('passkey PRF output must be exactly 32 bytes');
  if (!/^[A-Za-z0-9_-]{43}$/.test(participantSecret)) {
    throw new Error('participant secret has an invalid shape');
  }
  const aad = fromBase64url(aadBase64url);
  const plaintext = new TextEncoder().encode(participantSecret).buffer;
  let roundTrip: Uint8Array | undefined;
  try {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(prfOutput, aad);
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: asArrayBuffer(iv), additionalData: asArrayBuffer(aad), tagLength: 128 },
        key,
        plaintext,
      ),
    );
    roundTrip = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: asArrayBuffer(iv), additionalData: asArrayBuffer(aad), tagLength: 128 },
        key,
        asArrayBuffer(ciphertext),
      ),
    );
    if (!constantTimeEqual(roundTrip, new Uint8Array(plaintext))) throw new Error('encrypted key envelope failed its local round-trip check');
    return {
      version: 1,
      iv: toBase64url(iv),
      ciphertext: toBase64url(ciphertext),
      aad: aadBase64url,
    };
  } finally {
    new Uint8Array(plaintext).fill(0);
    roundTrip?.fill(0);
  }
}

export async function decryptParticipantSecretEnvelope(
  envelope: KeyEnvelope,
  prfOutput: Uint8Array,
): Promise<string> {
  if (envelope.version !== 1) throw new Error('unsupported key envelope version');
  const aad = fromBase64url(envelope.aad);
  const key = await deriveKey(prfOutput, aad);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: asArrayBuffer(fromBase64url(envelope.iv)),
      additionalData: asArrayBuffer(aad),
      tagLength: 128,
    },
    key,
    asArrayBuffer(fromBase64url(envelope.ciphertext)),
  );
  try {
    const secret = new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
    if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new Error('decrypted participant secret has an invalid shape');
    return secret;
  } finally {
    // Best-effort cleanup of owned mutable buffers, not a guarantee about
    // browser internals, CryptoKey storage or non-zeroizable JavaScript strings.
    new Uint8Array(plaintext).fill(0);
  }
}

async function deriveKey(prfOutput: Uint8Array, aad: Uint8Array): Promise<CryptoKey> {
  const rawPrf = asArrayBuffer(prfOutput);
  let keyMaterial: CryptoKey;
  try { keyMaterial = await crypto.subtle.importKey('raw', rawPrf, 'HKDF', false, ['deriveKey']); }
  finally { new Uint8Array(rawPrf).fill(0); }
  const salt = await crypto.subtle.digest('SHA-256', asArrayBuffer(aad));
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: INFO },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
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
