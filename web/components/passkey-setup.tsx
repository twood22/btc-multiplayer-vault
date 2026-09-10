'use client';

import { FormEvent, useState } from 'react';
import { createParticipantSetupMaterial, participantSetupReadiness } from '../lib/client/participant-setup';
import { assertPasskeyWithPrf, createPasskey } from '../lib/client/webauthn';
import { BITCOIN_NETWORK_CONFIG } from '../../src/network.js';

type Stage = 'ready' | 'registering' | 'wrapping' | 'complete' | 'error';

export function PasskeySetup({ inviteToken }: { inviteToken: string }) {
  const [displayName, setDisplayName] = useState('');
  const [stage, setStage] = useState<Stage>('ready');
  const [message, setMessage] = useState('');
  const [fundingReadiness, setFundingReadiness] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    setStage('registering');
    setMessage('Creating your passkey…');
    try {
      const registration = await postJson('/api/passkeys/register/options', {
        inviteToken,
        displayName,
      });
      const response = await createPasskey(registration.options);
      await postJson('/api/passkeys/register/verify', {
        inviteToken,
        challengeId: registration.challengeId,
        response,
      });

      setStage('wrapping');
      setMessage('Protecting your Bitcoin key with your passkey…');
      const wrapping = await postJson('/api/passkeys/envelope/options', {});
      const readiness = participantSetupReadiness(wrapping.protocol, BITCOIN_NETWORK_CONFIG.addressLabel);
      const assertion = await assertPasskeyWithPrf(wrapping.options);
      const { envelope, identity } = await createParticipantSetupMaterial(assertion.prfOutput, wrapping.aad, wrapping.participantId);
      await postJson('/api/passkeys/envelope/finish', {
        challengeId: wrapping.challengeId,
        response: assertion.response,
        envelope,
        identity,
      });
      setFundingReadiness(readiness);
      setStage('complete');
      setMessage('Your encrypted participant key is ready.');
    } catch (error) {
      setStage('error');
      setMessage(error instanceof Error ? error.message : 'Passkey setup failed');
    }
  }

  if (stage === 'complete') {
    return (
      <section className="setup-card success" aria-live="polite">
        <p className="eyebrow">Passkey protected</p>
        <h2>Your seat is secured</h2>
        <p>{message}</p>
        <div className="safety-note" data-testid="setup-funding-requirements">{fundingReadiness}</div>
      </section>
    );
  }

  return (
    <form className="setup-card" onSubmit={submit}>
      <p className="eyebrow">Private invitation</p>
      <h2>Claim your vault seat</h2>
      <p className="muted">
        Your device creates the Bitcoin key. The service stores only an encrypted copy that this
        passkey can unlock.
      </p>
      <label>
        Your name
        <input
          autoComplete="name"
          maxLength={80}
          minLength={1}
          onChange={(event) => setDisplayName(event.target.value)}
          required
          value={displayName}
        />
      </label>
      <button disabled={stage === 'registering' || stage === 'wrapping'} type="submit">
        {stage === 'ready' || stage === 'error' ? 'Create my passkey' : 'Working…'}
      </button>
      {message && (
        <p className={stage === 'error' ? 'form-message error' : 'form-message'} role="status">
          {message}
        </p>
      )}
      <p className="fine-print">
        Requires a current browser and a passkey provider that supports encrypted PRF output. No
        password, seed, or raw private key is sent to the server.
      </p>
    </form>
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
