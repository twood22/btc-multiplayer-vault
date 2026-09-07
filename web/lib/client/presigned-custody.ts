'use client';

import {
  presignedBackupBinding,
  validatePresignedPublicKit,
  verifyPresignedKitRestoration,
  type PresignedBackupBinding,
  type PresignedRestorationProof,
} from '../../../src/presigned/backup.js';
import { clearPresignedParticipantKeys, derivePresignedParticipantKeys } from '../../../src/presigned/roster.js';
import type { ParticipantId, PresignedParticipant, PresignedParticipantKeys, PresignedPublicKit } from '../../../src/presigned/types.js';
import { assert, exactKeys, identifier, sameCanonical } from '../../../src/presigned/validation.js';
import { fromBase64url, toBase64url } from './base64url';
import { decryptParticipantSecretEnvelope, type KeyEnvelope } from './key-envelope';
import { assertPasskeyWithPrf, stripPrfSecrets } from './webauthn';

type JsonRecord = Record<string, unknown>;

export interface UnlockedPresignedParticipant {
  participantId: ParticipantId;
  participantSecret: string;
  publicIdentity: PresignedParticipant;
  keys: PresignedParticipantKeys;
}

/** Injected only by contract tests; the production defaults use the unchanged passkey endpoints. */
export interface PresignedUnlockDependencies {
  postJson: (path: string, body: unknown) => Promise<JsonRecord>;
  assertWithPrf: (options: JsonRecord) => Promise<{ response: JsonRecord; prfOutput: Uint8Array }>;
}

/** Unlock one identity for one local action. No provider custody or provider runtime is involved. */
export async function withUnlockedPresignedParticipant<T>(input: {
  credentialId: string;
  expectedVaultId: string;
  expectedParticipant: PresignedParticipant;
  action: (context: UnlockedPresignedParticipant) => T | Promise<T>;
}, dependencies: PresignedUnlockDependencies = {
  postJson,
  assertWithPrf: assertPasskeyWithPrf,
}): Promise<T> {
  return unlockPresignedIdentity(input, dependencies, true);
}

/** Initial V2 round-key publication still authenticates the pre-existing personal/payout identity. */
export async function withUnregisteredPresignedParticipant<T>(input: {
  credentialId: string;
  expectedVaultId: string;
  expectedParticipant: Pick<PresignedParticipant, 'id' | 'personalPublicKeyHex' | 'payoutXonlyPublicKeyHex'>;
  action: (context: UnlockedPresignedParticipant) => T | Promise<T>;
}, dependencies: PresignedUnlockDependencies = { postJson, assertWithPrf: assertPasskeyWithPrf }): Promise<T> {
  exactKeys(input.expectedParticipant, ['id', 'personalPublicKeyHex', 'payoutXonlyPublicKeyHex'], 'initial participant identity');
  return unlockPresignedIdentity(input, dependencies, false);
}

async function unlockPresignedIdentity<T>(input: {
  credentialId: string; expectedVaultId: string;
  expectedParticipant: Pick<PresignedParticipant, 'id' | 'personalPublicKeyHex' | 'payoutXonlyPublicKeyHex'>;
  action: (context: UnlockedPresignedParticipant) => T | Promise<T>;
}, dependencies: PresignedUnlockDependencies, requireRoundKeys: boolean): Promise<T> {
  identifier(input.expectedVaultId, 'expected unlock vault');
  assert(typeof input.credentialId === 'string' && /^[A-Za-z0-9_-]{1,2048}$/u.test(input.credentialId), 'invalid unlock credential');
  let prf: Uint8Array | undefined;
  let participantSecret = '';
  let context: UnlockedPresignedParticipant | undefined;
  let derived: ReturnType<typeof derivePresignedParticipantKeys> | undefined;
  try {
    const authorization = await dependencies.postJson('/api/passkeys/unlock/options', {
      credentialId: input.credentialId,
    });
    identifier(String(authorization.challengeId), 'unlock challenge');
    assert(authorization.participantId === input.expectedParticipant.id, 'unlock returned a different participant');
    sameCanonical(authorization.expectedIdentity, {
      personalPublicKeyHex: input.expectedParticipant.personalPublicKeyHex,
      payoutXonlyPublicKeyHex: input.expectedParticipant.payoutXonlyPublicKeyHex,
    }, 'unlock public identity');
    const options = authorization.options as JsonRecord;
    validateCredentialOptions(options, input.credentialId);
    const assertion = await dependencies.assertWithPrf(options);
    prf = assertion.prfOutput;
    assert(prf instanceof Uint8Array && prf.length === 32, 'unlock PRF must contain exactly 32 bytes');
    assert(assertion.response.id === input.credentialId, 'unlock assertion used a different passkey');
    // Defense in depth even if a future assertion helper changes serialization.
    stripPrfSecrets(assertion.response);
    const finished = await dependencies.postJson('/api/passkeys/unlock/finish', {
      challengeId: authorization.challengeId,
      response: assertion.response,
    });
    const envelope = validateParticipantEnvelope(finished.envelope, input);
    participantSecret = await decryptParticipantSecretEnvelope(envelope, prf);
    prf.fill(0);
    prf = undefined;
    derived = derivePresignedParticipantKeys(participantSecret, input.expectedParticipant.id, input.expectedVaultId);
    if (requireRoundKeys) sameCanonical(derived.publicIdentity, input.expectedParticipant, 'passkey-restored v2 identity');
    else sameCanonical({ id: derived.publicIdentity.id,
      personalPublicKeyHex: derived.publicIdentity.personalPublicKeyHex,
      payoutXonlyPublicKeyHex: derived.publicIdentity.payoutXonlyPublicKeyHex }, input.expectedParticipant, 'initial passkey-restored identity');
    context = { participantId: input.expectedParticipant.id, participantSecret,
      publicIdentity: derived.publicIdentity, keys: derived.keys };
    return await input.action(context);
  } finally {
    prf?.fill(0);
    participantSecret = '';
    if (context) context.participantSecret = '';
    if (derived) clearPresignedParticipantKeys(derived.keys);
  }
}

/** Call independently for each credential; a count of two envelopes is not restore verification. */
export async function verifyPresignedPasskeyRestoration(input: {
  credentialId: string;
  expectedBinding: PresignedBackupBinding;
  publicKit: PresignedPublicKit;
}, dependencies?: PresignedUnlockDependencies): Promise<PresignedRestorationProof & { credentialId: string }> {
  const publicKit = validatePresignedPublicKit(input.publicKit);
  sameCanonical(presignedBackupBinding(publicKit, input.expectedBinding.participantId),
    input.expectedBinding, 'passkey recovery binding');
  const participant = publicKit.graph.roster.participants.find(entry =>
    entry.id === input.expectedBinding.participantId);
  assert(participant, 'restore participant is absent from the kit');
  return withUnlockedPresignedParticipant({ credentialId: input.credentialId,
    expectedVaultId: input.expectedBinding.vaultId, expectedParticipant: participant,
    action: unlocked => ({
      ...verifyPresignedKitRestoration({ publicKit,
        participantId: unlocked.participantId, participantSecret: unlocked.participantSecret,
        expectedBinding: input.expectedBinding }),
      credentialId: input.credentialId,
    }),
  }, dependencies);
}

function validateCredentialOptions(options: JsonRecord, credentialId: string): void {
  assert(options && typeof options === 'object' && !Array.isArray(options), 'missing passkey unlock options');
  const allowed = options.allowCredentials as JsonRecord[];
  assert(Array.isArray(allowed) && allowed.length === 1 && allowed[0]?.id === credentialId &&
    allowed[0]?.type === 'public-key', 'unlock challenge is not bound to the exact passkey');
  assert(options.userVerification === 'required', 'unlock challenge does not require user verification');
  const extensions = options.extensions as JsonRecord | undefined;
  const prf = extensions?.prf as JsonRecord | undefined;
  const byCredential = prf?.evalByCredential as JsonRecord | undefined;
  exactKeys(byCredential, [credentialId], 'unlock PRF credential binding');
  const salt = byCredential![credentialId] as JsonRecord;
  exactKeys(salt, ['first'], 'unlock PRF salt');
  strictBase64url(salt.first, 32, 'unlock PRF salt');
}

function validateParticipantEnvelope(value: unknown, expected: {
  credentialId: string; expectedVaultId: string; expectedParticipant: Pick<PresignedParticipant, 'id'>;
}): KeyEnvelope {
  exactKeys(value, ['version', 'iv', 'ciphertext', 'aad'], 'participant envelope');
  const envelope = value as KeyEnvelope;
  assert(envelope.version === 1, 'unsupported participant envelope format');
  strictBase64url(envelope.iv, 12, 'participant envelope IV');
  assert(typeof envelope.ciphertext === 'string' && envelope.ciphertext.length <= 700, 'participant ciphertext is too large');
  const ciphertext = strictBase64url(envelope.ciphertext, undefined, 'participant ciphertext');
  assert(ciphertext.length >= 33 && ciphertext.length <= 512, 'participant ciphertext size is invalid');
  assert(typeof envelope.aad === 'string' && envelope.aad.length <= 1400, 'participant envelope binding is too large');
  const bytes = strictBase64url(envelope.aad, undefined, 'participant envelope binding');
  let aad: JsonRecord;
  try { aad = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as JsonRecord; }
  catch { throw new Error('presigned-v2: invalid participant envelope binding'); }
  exactKeys(aad, ['purpose', 'version', 'userId', 'credentialId', 'vaultId', 'participantId'], 'participant envelope identity');
  identifier(String(aad.userId), 'participant envelope user');
  assert(aad.purpose === 'btc-multiplayer-vault-participant-secret' && aad.version === 1 &&
    aad.credentialId === expected.credentialId && aad.vaultId === expected.expectedVaultId &&
    aad.participantId === expected.expectedParticipant.id, 'participant envelope belongs to another identity');
  return envelope;
}

function strictBase64url(input: unknown, size: number | undefined, label: string): Uint8Array {
  assert(typeof input === 'string' && /^[A-Za-z0-9_-]+$/u.test(input), `invalid ${label}`);
  if (size !== undefined) assert(input.length === Math.ceil(size * 4 / 3), `invalid ${label} size`);
  const bytes = fromBase64url(input);
  assert(toBase64url(bytes) === input && (size === undefined || bytes.length === size), `invalid ${label} encoding`);
  return bytes;
}

async function postJson(path: string, body: unknown): Promise<JsonRecord> {
  const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), credentials: 'same-origin' });
  const result = await response.json() as JsonRecord;
  if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : `Passkey request failed (${response.status})`);
  return result;
}
