'use client';

import { decryptParticipantSecretEnvelope, type KeyEnvelope } from './key-envelope';
import { deriveParticipantIdentity } from './participant-identity';
import {
  recoverLatestSigbashCustodyBundle,
  type SigbashCustodyBundle,
  type SigbashCustodyEnvelope,
} from './sigbash-custody';
import { assertPasskeyWithPrf } from './webauthn';
import { unlockPublishedVault, type UnlockedPublishedVault } from './vault-signing';
import type { PublishedRosterArtifact } from '../../../src/roster-ceremony.js';

export async function withUnlockedVaultCustody<T>(input: {
  credentialId: string;
  action: (context: {
    unlocked: UnlockedPublishedVault;
    participantSecret: string;
    custody: SigbashCustodyBundle;
  }) => Promise<T>;
}): Promise<T> {
  let prfOutput: Uint8Array | undefined;
  let participantSecret = '';
  let custody: SigbashCustodyBundle | undefined;
  try {
    const authorization = await postJson('/api/sigbash/custody/authorize/options', {
      credentialId: input.credentialId,
    });
    const assertion = await assertPasskeyWithPrf(authorization.options as Record<string, unknown>);
    prfOutput = assertion.prfOutput;
    const authorized = await postJson('/api/sigbash/custody/authorize/finish', {
      challengeId: authorization.challengeId,
      response: assertion.response,
    });
    participantSecret = await decryptParticipantSecretEnvelope(
      authorized.participantEnvelope as KeyEnvelope,
      prfOutput,
    );
    prfOutput.fill(0);
    prfOutput = undefined;
    const participantId = String(authorization.participantId);
    const identity = await deriveParticipantIdentity(participantSecret, participantId);
    const expected = authorization.expectedIdentity as Record<string, unknown>;
    if (
      identity.personalPublicKeyHex !== expected.personalPublicKeyHex ||
      identity.payoutXonlyPublicKeyHex !== expected.payoutXonlyPublicKeyHex
    ) {
      throw new Error('passkey decrypted an identity that does not match this vault seat');
    }
    const recovered = await recoverLatestSigbashCustodyBundle(
      authorized.custodyEnvelopes as SigbashCustodyEnvelope[],
      participantSecret,
    );
    if (!recovered) throw new Error('no authenticated Sigbash custody bundle is available');
    custody = recovered.bundle;
    if (custody.participantId !== participantId) {
      throw new Error('encrypted Sigbash custody belongs to a different participant');
    }
    const published = await postJson('/api/vault/artifact', {});
    const unlocked = unlockPublishedVault({
      artifact: published.artifact as PublishedRosterArtifact,
      expectedDigest: String(published.digest),
      participantSecret,
    });
    return await input.action({ unlocked, participantSecret, custody });
  } finally {
    prfOutput?.fill(0);
    participantSecret = '';
    if (custody) scrubCustody(custody);
  }
}

function scrubCustody(custody: SigbashCustodyBundle): void {
  for (const key of Object.keys(custody.credentials) as Array<keyof typeof custody.credentials>) {
    custody.credentials[key] = '';
  }
  for (const item of custody.keys) {
    item.recoveryKit.recoveryKEK = '';
    item.recoveryKit.cekCiphertext = '';
    item.recoveryKit.cekNonce = '';
    if (item.recoveryKit.apiKey) item.recoveryKit.apiKey = '';
    if (item.recoveryKit.userKey) item.recoveryKit.userKey = '';
    if (item.recoveryKit.popSeed) item.recoveryKit.popSeed = '';
  }
}

async function postJson(path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'same-origin',
  });
  const result = await response.json() as { error?: string } & Record<string, unknown>;
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
  return result;
}
