'use client';

import { useState } from 'react';
import type { RosterReview } from '@/src/roster-ceremony';
import { assertPasskey } from '../lib/client/webauthn';
import { BITCOIN_NETWORK_CONFIG } from '../../src/network.js';

interface PasskeyChoice {
  id: string;
  name: string;
}

export function RosterConfirmation({
  available,
  missing,
  review,
  participantConfirmed,
  passkeys,
}: {
  available: boolean;
  missing: string[];
  review: RosterReview | null;
  participantConfirmed: boolean;
  passkeys: PasskeyChoice[];
}) {
  const [credentialId, setCredentialId] = useState(passkeys[0]?.id || '');
  const [status, setStatus] = useState('');
  const [working, setWorking] = useState(false);

  async function confirm() {
    if (!review) return;
    setWorking(true);
    setStatus('Waiting for your passkey…');
    try {
      if (!credentialId) throw new Error('No completed passkey is available');
      const options = await postJson('/api/roster/confirm/options', { credentialId });
      if (options.digest !== review.digest) {
        throw new Error('The roster changed before confirmation. Reload and review it again.');
      }
      const assertion = await assertPasskey(options.options);
      await postJson('/api/roster/confirm/finish', {
        challengeId: options.challengeId,
        digest: review.digest,
        response: assertion,
      });
      window.location.reload();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Roster confirmation failed');
      setWorking(false);
    }
  }

  if (!available || !review) {
    return (
      <section className="roster-card blocked-roster">
        <p className="eyebrow">Three-person roster</p>
        <h2>Waiting for real setup material</h2>
        <p>No funding address exists in the interface until every prerequisite below is real.</p>
        <ul>{missing.map((item) => <li key={item}>{item}</li>)}</ul>
      </section>
    );
  }

  return (
    <section className={review.unanimous ? 'roster-card confirmed-roster' : 'roster-card'}>
      <div className="roster-title-row">
        <div>
          <p className="eyebrow">Immutable {BITCOIN_NETWORK_CONFIG.addressLabel} roster</p>
          <h2>{review.unanimous ? 'All three friends confirmed' : 'Review the same vault together'}</h2>
        </div>
        <span>{review.confirmations.length} / 3 confirmed</span>
      </div>
      <p className="digest-line"><strong>Roster fingerprint</strong><code>{review.digest}</code></p>
      <div className="economics-review">
        <span><strong>{review.economics.depositSatsPerParticipant.toLocaleString()}</strong> sats each</span>
        <span><strong>{review.economics.firstWithdrawalSats.toLocaleString()}</strong> sats first out</span>
        <span><strong>{review.economics.secondWithdrawalSats.toLocaleString()}</strong> sats second out</span>
        <span><strong>{review.economics.recoveryDelayBlocks}</strong> block recovery delay</span>
      </div>
      <div className="roster-people">
        {review.participants.map((participant) => (
          <article key={participant.id}>
            <span>{review.confirmations.includes(participant.id) ? 'Confirmed' : 'Waiting'}</span>
            <h3>{participant.label}</h3>
            <p><strong>Payout</strong><code>{participant.payoutAddress}</code></p>
            <p><strong>Personal key</strong><code>{participant.personalPublicKeyHex}</code></p>
            <p>{participant.sigbashRounds.length} immutable Sigbash policies</p>
            {participant.sigbashRounds.map((round) => (
              <p key={round.round}><strong>{round.round}</strong><code>{round.registrationCommitment}</code></p>
            ))}
          </article>
        ))}
      </div>
      <div className="vault-review-list">
        {review.vaults.map((vault) => (
          <div key={vault.round}>
            <span>{vault.participantIds.join(' + ')}</span>
            <code>{vault.address || `Hidden until unanimity · ${review.fundingAddressCommitment}`}</code>
            <code>{vault.vaultCommitment}</code>
          </div>
        ))}
      </div>
      <details className="policy-commitments">
        <summary>Verify all nine policy commitments</summary>
        {review.policies.map((policy) => (
          <p key={policy.id}><strong>{policy.id}</strong><code>{policy.policyCommitment}</code></p>
        ))}
      </details>
      {review.fundingAddress ? (
        <div className="funding-reveal">
          <strong>Round-one {BITCOIN_NETWORK_CONFIG.addressLabel} address</strong>
          <code>{review.fundingAddress}</code>
          <p>Roster agreement is complete. Funding is still disabled until live Sigbash signing and the remaining {BITCOIN_NETWORK_CONFIG.addressLabel} release checks pass.</p>
        </div>
      ) : participantConfirmed ? (
        <p className="safety-note">Your passkey confirmation is recorded. The funding address stays hidden until both other friends confirm this exact fingerprint.</p>
      ) : (
        <div className="roster-confirm-controls">
          {passkeys.length > 1 && (
            <label>
              Passkey
              <select value={credentialId} onChange={(event) => setCredentialId(event.target.value)}>
                {passkeys.map((passkey) => <option key={passkey.id} value={passkey.id}>{passkey.name}</option>)}
              </select>
            </label>
          )}
          <button type="button" disabled={working || !credentialId} onClick={confirm}>
            Confirm this exact roster
          </button>
          {status && <p className="form-message" role="status">{status}</p>}
        </div>
      )}
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
