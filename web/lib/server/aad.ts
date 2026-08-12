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

export function sigbashCustodyAad(identity: EnvelopeIdentity & { revision: number }): Buffer {
  if (!Number.isSafeInteger(identity.revision) || identity.revision < 1 || identity.revision > 32) {
    throw new Error('Sigbash custody revision is invalid');
  }
  return Buffer.from(
    JSON.stringify({
      // Deliberately omit credentialId: both registered recovery passkeys
      // decrypt the same participant secret and therefore the same shared
      // Sigbash history. user/vault/participant/revision remain immutable.
      purpose: 'btc-multiplayer-vault-sigbash-custody',
      version: 1,
      revision: identity.revision,
      userId: identity.userId,
      vaultId: identity.vaultId,
      participantId: identity.participantId,
    }),
    'utf8',
  );
}
