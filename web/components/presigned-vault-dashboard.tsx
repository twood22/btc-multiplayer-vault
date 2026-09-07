import { FinishKeySetup } from './finish-key-setup';
import { PasskeyRecoverySetup } from './passkey-recovery-setup';
import { PresignedCeremony } from './presigned-ceremony';
import { SignOutButton } from './sign-out-button';
import type { MemberStatus, ParticipantSummary } from '../lib/server/webauthn-store';
import type { PresignedCeremonyStatus } from '../lib/server/presigned-store';
import { presignedBrowserChainConfig } from '../lib/server/presigned-browser-config';
import { chainConfirmationsRequired } from '../lib/server/config';
import { PresignedRuntime } from './presigned-runtime';
import { PresignedFees } from './presigned-fees';
import { PresignedReadiness } from './presigned-readiness';

export function PresignedVaultDashboard({ member, status, identity }: {
  member: MemberStatus; status: PresignedCeremonyStatus; identity: ParticipantSummary | null;
}) {
  return <main className="shell dashboard-shell">
    <header className="brand-row"><div className="brand-mark" aria-hidden="true">₿</div>
      <div className="brand-copy"><strong>{member.vaultName}</strong><span>Bitcoin Multiplayer Vault · Presigned v2</span></div>
      <SignOutButton /></header>
    <section className="dashboard-heading"><p className="eyebrow">{member.participantId} · {member.displayName}</p>
      <h1>Your keys. A complete exit plan.</h1>
      <p className="lede">Verify the exact three-person game, keep a service-independent recovery kit, and retain the signature that initiates your own exit.</p>
    </section>
    {!member.setupComplete && <FinishKeySetup />}
    <PresignedReadiness vaultId={status.vaultId} />
    {member.setupComplete && !member.recoveryComplete && <PasskeyRecoverySetup passkeys={member.passkeys} />}
    {member.setupComplete && member.recoveryComplete && identity && <PresignedCeremony initialStatus={status}
      passkeys={member.passkeys} chainConfig={presignedBrowserChainConfig()} expectedIdentity={{ id: status.participantId,
        personalPublicKeyHex: identity.personalPublicKeyHex, payoutXonlyPublicKeyHex: identity.payoutXonlyPublicKeyHex }} />}
    {member.setupComplete && member.recoveryComplete && identity && <PresignedRuntime vaultId={status.vaultId}
      ownIdentity={{ id: status.participantId, personalPublicKeyHex: identity.personalPublicKeyHex,
        payoutXonlyPublicKeyHex: identity.payoutXonlyPublicKeyHex }} passkeys={member.passkeys}
      chainConfig={presignedBrowserChainConfig()} requiredConfirmations={chainConfirmationsRequired()} />}
    {member.setupComplete && member.recoveryComplete && identity && <PresignedFees vaultId={status.vaultId}
      ownIdentity={{ id: status.participantId, personalPublicKeyHex: identity.personalPublicKeyHex,
        payoutXonlyPublicKeyHex: identity.payoutXonlyPublicKeyHex }} passkeys={member.passkeys}
      chainConfig={presignedBrowserChainConfig()} requiredConfirmations={chainConfirmationsRequired()} />}
  </main>;
}
