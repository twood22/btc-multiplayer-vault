'use client';

import { useState } from 'react';
import {
  decryptParticipantSecretEnvelope,
  encryptParticipantSecretEnvelope,
  type KeyEnvelope,
} from '../lib/client/key-envelope';
import { deriveParticipantIdentity } from '../lib/client/participant-identity';
import { assertPasskeyWithPrf, createPasskey } from '../lib/client/webauthn';

interface PasskeyChoice {
  id: string;
  name: string;
}

export function PasskeyRecoverySetup({ passkeys }: { passkeys: PasskeyChoice[] }) {
  const [credentialId, setCredentialId] = useState(passkeys[0]?.id || '');
  const [credentialName, setCredentialName] = useState('Backup passkey');
  const [status, setStatus] = useState('Not configured');
  const [working, setWorking] = useState(false);

  async function addRecoveryPasskey() {
    setWorking(true);
    let sourcePrf: Uint8Array | undefined;
    let recoveryPrf: Uint8Array | undefined;
    let participantSecret = '';
    try {
      if (!credentialId) throw new Error('Choose an existing passkey first');
      setStatus('Unlocking with your existing passkey…');
      const authorization = await postJson('/api/passkeys/recovery/authorize/options', { credentialId });
      const sourceAssertion = await assertPasskeyWithPrf(authorization.options);
      sourcePrf = sourceAssertion.prfOutput;
      const authorized = await postJson('/api/passkeys/recovery/authorize/finish', {
        challengeId: authorization.challengeId,
        response: sourceAssertion.response,
      });
      participantSecret = await decryptParticipantSecretEnvelope(
        authorized.envelope as KeyEnvelope,
        sourcePrf,
      );
      sourcePrf.fill(0);
      sourcePrf = undefined;
      const identity = await deriveParticipantIdentity(participantSecret, authorization.participantId);
      if (
        identity.personalPublicKeyHex !== authorization.expectedIdentity.personalPublicKeyHex
        || identity.payoutXonlyPublicKeyHex !== authorization.expectedIdentity.payoutXonlyPublicKeyHex
      ) {
        throw new Error('existing passkey decrypted a key that does not match your participant identity');
      }

      setStatus('Creating your distinct recovery passkey…');
      const registration = await postJson('/api/passkeys/recovery/register/options', {
        enrollmentId: authorized.enrollmentId,
      });
      const registrationResponse = await createPasskey(registration.options);
      await postJson('/api/passkeys/recovery/register/verify', {
        challengeId: registration.challengeId,
        enrollmentId: authorized.enrollmentId,
        credentialName,
        response: registrationResponse,
      });

      setStatus('Encrypting the same participant key for the recovery passkey…');
      const wrapping = await postJson('/api/passkeys/recovery/envelope/options', {
        enrollmentId: authorized.enrollmentId,
      });
      const recoveryAssertion = await assertPasskeyWithPrf(wrapping.options);
      recoveryPrf = recoveryAssertion.prfOutput;
      const envelope = await encryptParticipantSecretEnvelope(
        participantSecret,
        recoveryPrf,
        wrapping.aad,
      );
      const recoveryIdentity = await deriveParticipantIdentity(participantSecret, wrapping.participantId);
      if (
        recoveryIdentity.personalPublicKeyHex !== identity.personalPublicKeyHex
        || recoveryIdentity.payoutXonlyPublicKeyHex !== identity.payoutXonlyPublicKeyHex
      ) {
        throw new Error('recovery passkey would protect a different participant identity');
      }
      recoveryPrf.fill(0);
      recoveryPrf = undefined;
      await postJson('/api/passkeys/recovery/envelope/finish', {
        challengeId: wrapping.challengeId,
        enrollmentId: authorized.enrollmentId,
        response: recoveryAssertion.response,
        envelope,
        identity: recoveryIdentity,
      });
      participantSecret = '';
      setStatus('Recovery passkey configured');
      window.location.reload();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Recovery setup failed');
    } finally {
      sourcePrf?.fill(0);
      recoveryPrf?.fill(0);
      participantSecret = '';
      setWorking(false);
    }
  }

  return (
    <section className="recovery-card">
      <div>
        <p className="eyebrow">Device-loss protection</p>
        <h2>Add a recovery passkey</h2>
        <p>
          First unlock with a working passkey, then create a distinct passkey on another device or
          security key. The same Bitcoin identity is encrypted locally for both.
        </p>
      </div>
      <div className="recovery-controls">
        <label>
          Existing passkey
          <select value={credentialId} onChange={(event) => setCredentialId(event.target.value)}>
            {passkeys.map((passkey) => <option key={passkey.id} value={passkey.id}>{passkey.name}</option>)}
          </select>
        </label>
        <label>
          Recovery passkey name
          <input
            value={credentialName}
            maxLength={40}
            onChange={(event) => setCredentialName(event.target.value)}
          />
        </label>
        <button disabled={working || !credentialId || !credentialName.trim()} onClick={addRecoveryPasskey} type="button">
          {working ? 'Working…' : 'Add recovery passkey'}
        </button>
        <p className="form-message" role="status">{status}</p>
      </div>
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
