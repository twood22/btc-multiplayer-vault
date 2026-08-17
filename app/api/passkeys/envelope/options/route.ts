import { randomBytes } from 'node:crypto';
import { generateAuthenticationOptions } from '@simplewebauthn/server';
import { envelopeAad } from '@/web/lib/server/aad';
import { webConfig } from '@/web/lib/server/config';
import { toBase64url } from '@/web/lib/server/encoding';
import { assertSameOrigin, jsonError } from '@/web/lib/server/http';
import { requireSessionUser } from '@/web/lib/server/session';
import { createAssertionChallenge } from '@/web/lib/server/webauthn-store';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const userId = await requireSessionUser();
    const config = webConfig();
    const prfSalt = randomBytes(32);
    const baseOptions = await generateAuthenticationOptions({
      rpID: config.rpID,
      userVerification: 'required',
      timeout: 120_000,
    });
    const challenge = await createAssertionChallenge({
      userId,
      kind: 'envelope',
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
      credentialId,
      participantId: challenge.credential.participantId,
      vaultId: challenge.credential.vaultId,
      aad: toBase64url(aad),
      options: {
        ...baseOptions,
        allowCredentials: [
          { id: credentialId, type: 'public-key', transports: challenge.credential.transports },
        ],
        extensions: {
          ...(baseOptions.extensions || {}),
          prf: {
            evalByCredential: {
              [credentialId]: { first: toBase64url(prfSalt) },
            },
          },
        },
      },
    });
  } catch (error) {
    return jsonError(error, error instanceof Error && error.message.includes('authentication') ? 401 : 400);
  }
}
