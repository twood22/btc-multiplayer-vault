import { randomBytes } from 'node:crypto';
import { generateAuthenticationOptions } from '@simplewebauthn/server';
import { z } from 'zod';
import { envelopeAad } from '@/web/lib/server/aad';
import { webConfig } from '@/web/lib/server/config';
import { toBase64url } from '@/web/lib/server/encoding';
import { assertSameOrigin, jsonError } from '@/web/lib/server/http';
import { requireSessionUser } from '@/web/lib/server/session';
import { createRecoveryEnvelopeChallenge } from '@/web/lib/server/webauthn-store';

export const runtime = 'nodejs';

const Input = z.object({ enrollmentId: z.string().uuid() });

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const input = Input.parse(await request.json());
    const userId = await requireSessionUser();
    const baseOptions = await generateAuthenticationOptions({
      rpID: webConfig().rpID,
      userVerification: 'required',
      timeout: 120_000,
    });
    const prfSalt = randomBytes(32);
    const challenge = await createRecoveryEnvelopeChallenge({
      userId,
      enrollmentId: input.enrollmentId,
      challenge: baseOptions.challenge,
      prfSalt,
    });
    const credentialId = challenge.credential.id;
    const aad = envelopeAad({
      userId,
      credentialId,
      vaultId: challenge.credential.vaultId,
      participantId: challenge.credential.participantId,
    });
    return Response.json({
      challengeId: challenge.id,
      participantId: challenge.credential.participantId,
      aad: toBase64url(aad),
      options: {
        ...baseOptions,
        allowCredentials: [
          { id: credentialId, type: 'public-key', transports: challenge.credential.transports },
        ],
        extensions: {
          ...(baseOptions.extensions || {}),
          prf: { evalByCredential: { [credentialId]: { first: toBase64url(prfSalt) } } },
        },
      },
    });
  } catch (error) {
    return jsonError(error);
  }
}
