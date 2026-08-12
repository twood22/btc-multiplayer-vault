'use client';

import { useState } from 'react';
import { createParticipantSecretEnvelope } from '../lib/client/key-envelope';
import { deriveParticipantIdentity } from '../lib/client/participant-identity';
import { assertPasskeyWithPrf } from '../lib/client/webauthn';

export function FinishKeySetup() {
  const [status, setStatus] = useState('');

  async function finish() {
    setStatus('Waiting for your passkey…');
    try {
      const wrapping = await postJson('/api/passkeys/envelope/options', {});
      const assertion = await assertPasskeyWithPrf(wrapping.options);
      const protectedKey = await createParticipantSecretEnvelope(assertion.prfOutput, wrapping.aad);
      const identity = await deriveParticipantIdentity(protectedKey.participantSecret, wrapping.participantId);
      assertion.prfOutput.fill(0);
      await postJson('/api/passkeys/envelope/finish', {
        challengeId: wrapping.challengeId,
        response: assertion.response,
        envelope: protectedKey.envelope,
        identity,
      });
      window.location.reload();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Key protection failed');
    }
  }

  return (
    <section className="setup-card incomplete-setup">
      <p className="eyebrow">Setup incomplete</p>
      <h2>Protect your Bitcoin key</h2>
      <p className="muted">
        Your passkey is registered, but the encrypted participant key was not finished. No vault can
        be funded until this succeeds.
      </p>
      <button onClick={finish} type="button">Finish key protection</button>
      {status && <p className="form-message" role="status">{status}</p>}
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
