import { verifyRegistrationResponse, type RegistrationResponseJSON } from '@simplewebauthn/server';
import { z } from 'zod';
import { webConfig } from '@/web/lib/server/config';
import { assertSameOrigin, jsonError } from '@/web/lib/server/http';
import { requireSessionUser } from '@/web/lib/server/session';
import {
  completeRecoveryRegistration,
  getRecoveryRegistrationChallenge,
} from '@/web/lib/server/webauthn-store';

export const runtime = 'nodejs';

const Input = z.object({
  challengeId: z.string().uuid(),
  enrollmentId: z.string().uuid(),
  credentialName: z.string().trim().min(1).max(40),
  response: z.unknown(),
});

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const input = Input.parse(await request.json());
    const userId = await requireSessionUser();
    const clientExtensions = (input.response as {
      clientExtensionResults?: { prf?: { enabled?: boolean } };
    }).clientExtensionResults;
    if (clientExtensions?.prf?.enabled !== true) {
      throw new Error('The new passkey does not support the PRF protection required for recovery');
    }
    const challenge = await getRecoveryRegistrationChallenge({
      challengeId: input.challengeId,
      enrollmentId: input.enrollmentId,
      userId,
    });
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
      throw new Error('recovery passkey registration could not be verified');
    }
    const info = verification.registrationInfo;
    await completeRecoveryRegistration({
      challenge,
      credential: info.credential,
      credentialName: input.credentialName,
      transports: (input.response as RegistrationResponseJSON).response.transports
        || info.credential.transports || [],
      deviceType: info.credentialDeviceType,
      backedUp: info.credentialBackedUp,
    });
    return Response.json({ ok: true, credentialId: info.credential.id });
  } catch (error) {
    return jsonError(error);
  }
}
