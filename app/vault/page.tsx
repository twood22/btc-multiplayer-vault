import { connection } from 'next/server';
import { redirect } from 'next/navigation';
import { PasskeyUnlock } from '@/web/components/passkey-unlock';
import { PasskeyRecoverySetup } from '@/web/components/passkey-recovery-setup';
import { RosterConfirmation } from '@/web/components/roster-confirmation';
import { SigbashCustodySetup } from '@/web/components/sigbash-custody-setup';
import { FinishKeySetup } from '@/web/components/finish-key-setup';
import { getRosterCeremonyStatus } from '@/web/lib/server/roster-store';
import { requireSessionUser } from '@/web/lib/server/session';
import { getMemberStatus } from '@/web/lib/server/webauthn-store';

export default async function VaultPage() {
  await connection();
  let participant;
  let roster;
  try {
    const userId = await requireSessionUser();
    participant = await getMemberStatus(userId);
    roster = await getRosterCeremonyStatus(userId);
  } catch {
    redirect('/');
  }
  return (
    <main className="shell dashboard-shell">
      <header className="brand-row">
        <div className="brand-mark" aria-hidden="true">₿</div>
        <div>
          <strong>{participant.vaultName}</strong>
          <span>Bitcoin Multiplayer Vault</span>
        </div>
      </header>
      <section className="dashboard-heading">
        <p className="eyebrow">{participant.participantId} · {participant.displayName}</p>
        <h1>Your side of the vault is set up.</h1>
        <p className="lede">
          Funding is intentionally unavailable while live Sigbash mainnet signing, recovery setup,
          and three-person roster verification remain incomplete.
        </p>
      </section>
      {participant.setupComplete ? (
        <PasskeyUnlock
          passkeys={participant.passkeys}
          confirmedRoster={Boolean(roster.review?.unanimous)}
        />
      ) : <FinishKeySetup />}
      {participant.setupComplete && !participant.recoveryComplete && (
        <PasskeyRecoverySetup passkeys={participant.passkeys} />
      )}
      {participant.setupComplete && participant.recoveryComplete && (
        <SigbashCustodySetup
          passkeys={participant.passkeys}
          started={participant.sigbashCustodyStarted}
          keyCount={participant.sigbashKeyCount}
        />
      )}
      {participant.setupComplete && participant.recoveryComplete && (
        <RosterConfirmation
          available={roster.available}
          missing={roster.missing}
          review={roster.review}
          participantConfirmed={roster.participantConfirmed}
          passkeys={participant.passkeys}
        />
      )}
      <section className="gate-list">
        <article className={participant.setupComplete ? 'done' : ''}><span>{participant.setupComplete ? 'Done' : 'Required'}</span><h2>Personal key protected</h2><p>Encrypted with your passkey PRF; plaintext is never stored.</p></article>
        <article className={participant.recoveryComplete ? 'done' : ''}><span>{participant.recoveryComplete ? 'Done' : 'Required'}</span><h2>Recovery credential</h2><p>A distinct second passkey protects the same participant identity.</p></article>
        <article className={roster.review?.unanimous ? 'done' : ''}><span>{roster.review?.unanimous ? 'Done' : 'Required'}</span><h2>Three-person roster</h2><p>All friends confirm one immutable digest built from real participant and Sigbash keys.</p></article>
        <article className={participant.sigbashKeyCount === 3 ? 'done' : ''}><span>{participant.sigbashKeyCount === 3 ? 'Done' : 'Required'}</span><h2>Live Sigbash mainnet</h2><p>Create three immutable personal round keys, then prove a real policy-limited solo signature before funding.</p></article>
      </section>
    </main>
  );
}
