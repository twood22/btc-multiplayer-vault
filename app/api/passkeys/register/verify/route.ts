import { verifyRegistrationResponse, type RegistrationResponseJSON } from '@simplewebauthn/server';
import { z } from 'zod';
import { webConfig } from '@/web/lib/server/config';
import {
  completeRegistration,
  getRegistrationChallenge,
} from '@/web/lib/server/webauthn-store';
import { createSession } from '@/web/lib/server/session';
import { assertSameOrigin, jsonError } from '@/web/lib/server/http';

export const runtime = 'nodejs';

const Input = z.object({
  inviteToken: z.string().min(32).max(256),
  challengeId: z.string().uuid(),
  response: z.unknown(),
});

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const input = Input.parse(await request.json());
    const clientExtensions = (input.response as {
      clientExtensionResults?: { prf?: { enabled?: boolean } };
    }).clientExtensionResults;
    if (clientExtensions?.prf?.enabled !== true) {
      throw new Error(
        'This passkey cannot protect the Bitcoin key because WebAuthn PRF is unavailable. Try a current platform passkey or compatible security key.',
      );
    }
    const challenge = await getRegistrationChallenge(input.challengeId, input.inviteToken);
    const config = webConfig();
    const verification = await verifyRegistrationResponse({
      response: input.response as RegistrationResponseJSON,
      expectedChallenge: challenge.challenge,
      expectedOrigin: config.origin,
      expectedRPID: config.rpID,
      requireUserPresence: true,
      requireUserVerification: true,
    });
    if (!verification.verified || !verification.registrationInfo) {
      throw new Error('passkey registration could not be verified');
    }
    const info = verification.registrationInfo;
    await completeRegistration({
      challenge,
      credential: info.credential,
      transports: (input.response as RegistrationResponseJSON).response.transports ||
        info.credential.transports || [],
      deviceType: info.credentialDeviceType,
      backedUp: info.credentialBackedUp,
    });
    await createSession(challenge.userId);
    return Response.json({
      ok: true,
      participantId: challenge.participantId,
      vaultId: challenge.vaultId,
      credentialId: info.credential.id,
    });
  } catch (error) {
    return jsonError(error);
  }
}
