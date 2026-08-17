'use client';

import { useState } from 'react';
import { assertPasskey } from '../lib/client/webauthn';

export function PasskeySignIn() {
  const [status, setStatus] = useState('');

  async function signIn() {
    setStatus('Waiting for your passkey…');
    try {
      const options = await postJson('/api/passkeys/login/options', {});
      const response = await assertPasskey(options.options);
      await postJson('/api/passkeys/login/finish', {
        challengeId: options.challengeId,
        response,
      });
      window.location.assign('/vault');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Sign-in failed');
    }
  }

  return (
    <div className="sign-in-box">
      <button onClick={signIn} type="button">Sign in with a passkey</button>
      {status && <span role="status">{status}</span>}
    </div>
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
