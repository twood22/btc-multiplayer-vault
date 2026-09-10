import { LEGACY_PROTOCOL, PRESIGNED_PROTOCOL } from '../../../src/presigned/types.js';
import { createParticipantSecretEnvelope, type KeyEnvelope } from './key-envelope.js';
import { deriveParticipantIdentity, type ParticipantIdentity } from './participant-identity.js';

/** Shared by first enrollment and interrupted-enrollment recovery. Only public
 * identity and ciphertext leave this operation; it consumes the owned PRF. */
export async function createParticipantSetupMaterial(
  prfOutput: Uint8Array,
  aadBase64url: string,
  participantId: string,
): Promise<{ envelope: KeyEnvelope; identity: ParticipantIdentity }> {
  let protectedKey: Awaited<ReturnType<typeof createParticipantSecretEnvelope>> | undefined;
  try {
    protectedKey = await createParticipantSecretEnvelope(prfOutput, aadBase64url);
    const identity = await deriveParticipantIdentity(protectedKey.participantSecret, participantId);
    return { envelope: protectedKey.envelope, identity };
  } finally {
    prfOutput.fill(0);
    // Best effort only: JS strings and browser internals cannot be zeroized.
    // Protocol security never depends on deleting these references.
    if (protectedKey) protectedKey.participantSecret = '';
  }
}

/** The discriminator comes from authenticated durable vault membership, not an
 * invitation URL, inferred default, or caller-selected funding authorization. */
export function participantSetupReadiness(protocol: unknown, addressLabel: string): string {
  if (protocol === PRESIGNED_PROTOCOL) {
    return 'Funding remains disabled until all three friends restore their complete vault kit with both distinct passkeys and their saved offline recovery kit, independently verify the same graph and exact payouts, and the presigned ' + addressLabel + ' release checks pass.';
  }
  if (protocol === LEGACY_PROTOCOL) {
    return 'Funding remains disabled until a second passkey or offline recovery kit is added, all three friends verify the same vault address, and live Sigbash ' + addressLabel + ' signing passes.';
  }
  throw new Error('an explicitly supported vault protocol is required for setup guidance');
}
