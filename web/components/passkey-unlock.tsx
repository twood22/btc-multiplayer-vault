'use client';

import { useState } from 'react';
import { decryptParticipantSecretEnvelope, type KeyEnvelope } from '../lib/client/key-envelope';
import { deriveParticipantIdentity } from '../lib/client/participant-identity';
import { assertPasskeyWithPrf } from '../lib/client/webauthn';

export function PasskeyUnlock() {
  const [status, setStatus] = useState('Locked');
  const [verified, setVerified] = useState(false);

  async function unlock() {
    setStatus('Waiting for your passkey…');
    setVerified(false);
    try {
      const options = await postJson('/api/passkeys/unlock/options', {});
      const assertion = await assertPasskeyWithPrf(options.options);
      const finished = await postJson('/api/passkeys/unlock/finish', {
        challengeId: options.challengeId,
        response: assertion.response,
      });
      const secret = await decryptParticipantSecretEnvelope(
        finished.envelope as KeyEnvelope,
        assertion.prfOutput,
      );
      assertion.prfOutput.fill(0);
      const identity = await deriveParticipantIdentity(secret, options.participantId);
      if (
        identity.personalPublicKeyHex !== options.expectedIdentity.personalPublicKeyHex ||
        identity.payoutXonlyPublicKeyHex !== options.expectedIdentity.payoutXonlyPublicKeyHex
      ) {
        throw new Error('decrypted key does not reproduce the participant identity stored during setup');
      }
      setVerified(true);
      setStatus('Participant key unlocked and identity verified');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Unlock failed');
    }
  }

  return (
    <section className={verified ? 'unlock-card verified' : 'unlock-card'}>
      <div>
        <p className="eyebrow">Local custody check</p>
        <h2>{status}</h2>
        <p>The plaintext key exists only long enough to reproduce and verify your public identity.</p>
      </div>
      <button onClick={unlock} type="button">Verify my key</button>
    </section>
  );
}

async function postJson(path: string, body: unknown): Promise<Record<string, any>> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'same-origin',
  });
  const result = (await response.json()) as { error?: string } & Record<string, any>;
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
  return result;
}
