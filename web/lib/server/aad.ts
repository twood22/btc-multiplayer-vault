import 'server-only';

export interface EnvelopeIdentity {
  userId: string;
  credentialId: string;
  vaultId: string;
  participantId: string;
}

export function envelopeAad(identity: EnvelopeIdentity): Buffer {
  return Buffer.from(
    JSON.stringify({
      purpose: 'btc-multiplayer-vault-participant-secret',
      version: 1,
      userId: identity.userId,
      credentialId: identity.credentialId,
      vaultId: identity.vaultId,
      participantId: identity.participantId,
    }),
    'utf8',
  );
}
