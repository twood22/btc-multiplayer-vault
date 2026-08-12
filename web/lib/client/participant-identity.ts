import { secp256k1 } from '@noble/curves/secp256k1.js';

export interface ParticipantIdentity {
  personalPublicKeyHex: string;
  payoutXonlyPublicKeyHex: string;
}

export async function deriveParticipantIdentity(
  participantSecret: string,
  participantId: string,
): Promise<ParticipantIdentity> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(participantSecret)) {
    throw new Error('participant secret has an invalid shape');
  }
  if (!/^(alice|bob|carol)$/.test(participantId)) {
    throw new Error('unknown participant id');
  }
  const personal = await deterministicPrivateKey(participantSecret, `${participantId}:personal`);
  const payout = await deterministicPrivateKey(participantSecret, `${participantId}:payout`);
  const personalPublicKey = secp256k1.getPublicKey(personal, true);
  const payoutPublicKey = secp256k1.getPublicKey(payout, true);
  personal.fill(0);
  payout.fill(0);
  return {
    personalPublicKeyHex: hex(personalPublicKey),
    payoutXonlyPublicKeyHex: hex(payoutPublicKey.slice(1)),
  };
}

async function deterministicPrivateKey(seed: string, label: string): Promise<Uint8Array> {
  for (let counter = 0; counter < 2 ** 16; counter += 1) {
    const material = new TextEncoder().encode(`${seed}:${label}:${counter}`);
    const candidate = new Uint8Array(await crypto.subtle.digest('SHA-256', material));
    material.fill(0);
    if (secp256k1.utils.isValidSecretKey(candidate)) return candidate;
    candidate.fill(0);
  }
  throw new Error('could not derive a valid participant key');
}

function hex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
