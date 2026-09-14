'use client';
import { useState } from 'react';
import { PRESIGNED_PROTOCOL, type PresignedProtocol } from '../../src/presigned/types';
import { assert, presignedVersion } from '../../src/presigned/validation';

export function PresignedReadiness({ vaultId, protocol = PRESIGNED_PROTOCOL }: { vaultId: string; protocol?: PresignedProtocol }) {
  const [checks, setChecks] = useState<Array<{ id: string; passed: boolean; detail: string }> | null>(null);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState('Readiness is separate from signing authority. This check never signs or broadcasts.');
  async function refresh() {
    setWorking(true);
    try {
      const response = await fetch('/api/vault/presigned/readiness', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(90_000) });
      const status = await response.json();
      assert(response.ok && status.version === presignedVersion(protocol) && status.protocol === protocol && status.vaultId === vaultId &&
        status.fundingAuthorized === false && Array.isArray(status.checks), 'Readiness unavailable or changed protocol');
      setChecks(status.checks); setMessage(status.note);
    } catch { setMessage('Readiness could not be verified. Funding gates remain enforced; retain your existing recovery material.'); }
    finally { setWorking(false); }
  }
  return <section className="setup-card" aria-label="Presigned release readiness">
    <h2>Funding readiness and remaining checks</h2>
    <p>Production requires the exact tested software, real default-Signet evidence, verified backups and a separately reviewed release. Physical-device passkey checks remain deferred to friends’ onboarding.</p>
    <button type="button" disabled={working} onClick={() => void refresh()}>Check read-only funding readiness</button>
    <p role="status">{message}</p>
    {checks && <ul>{checks.map(check => <li key={check.id}>{check.passed ? 'Verified now' : 'Outstanding'}: {check.detail}</li>)}</ul>}
  </section>;
}
