import { generateAuthenticationOptions } from '@simplewebauthn/server';
import { webConfig } from '@/web/lib/server/config';
import { toBase64url } from '@/web/lib/server/encoding';
import { assertSameOrigin, jsonError } from '@/web/lib/server/http';
import { requireSessionUser } from '@/web/lib/server/session';
import { createUnlockChallenge, getParticipantSummary } from '@/web/lib/server/webauthn-store';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const userId = await requireSessionUser();
    const baseOptions = await generateAuthenticationOptions({
      rpID: webConfig().rpID,
      userVerification: 'required',
      timeout: 120_000,
    });
    const challenge = await createUnlockChallenge({ userId, challenge: baseOptions.challenge });
    const participant = await getParticipantSummary(userId);
    const credentialId = challenge.credential.id;
    return Response.json({
      challengeId: challenge.id,
      participantId: challenge.credential.participantId,
      expectedIdentity: {
        personalPublicKeyHex: participant.personalPublicKeyHex,
        payoutXonlyPublicKeyHex: participant.payoutXonlyPublicKeyHex,
      },
      options: {
        ...baseOptions,
        allowCredentials: [
          { id: credentialId, type: 'public-key', transports: challenge.credential.transports },
        ],
        extensions: {
          ...(baseOptions.extensions || {}),
          prf: {
            evalByCredential: {
              [credentialId]: { first: toBase64url(challenge.prfSalt) },
            },
          },
        },
      },
    });
  } catch (error) {
    return jsonError(error, error instanceof Error && error.message.includes('authentication') ? 401 : 400);
  }
}
