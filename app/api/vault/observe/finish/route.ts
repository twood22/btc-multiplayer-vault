import {
  verifyAuthenticationResponse,
  type AuthenticationResponseJSON,
} from '@simplewebauthn/server';
import { z } from 'zod';
import { webConfig } from '@/web/lib/server/config';
import { assertSameOrigin, jsonError } from '@/web/lib/server/http';
import { requireSessionUser } from '@/web/lib/server/session';
import {
  completeCoinObservation,
  getCoinObservationChallenge,
} from '@/web/lib/server/vault-runtime-store';
import { asWebAuthnCredential } from '@/web/lib/server/webauthn-store';

export const runtime = 'nodejs';

const Input = z.object({
  challengeId: z.string().uuid(),
  snapshotDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  response: z.unknown(),
}).strict();

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const input = Input.parse(await request.json());
    const userId = await requireSessionUser();
    const challenge = await getCoinObservationChallenge({
      challengeId: input.challengeId,
      userId,
    });
    if (input.snapshotDigest !== challenge.snapshotDigest) {
      throw new Error('browser approved a different coin snapshot');
    }
    const response = input.response as AuthenticationResponseJSON;
    if (response.id !== challenge.credential.id) {
      throw new Error('assertion used a different passkey than the coin observation challenge');
    }
    const config = webConfig();
    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: config.origin,
      expectedRPID: config.rpID,
      credential: asWebAuthnCredential(challenge.credential),
      requireUserVerification: true,
    });
    if (!verification.verified) throw new Error('passkey coin observation could not be verified');
    await completeCoinObservation(challenge, verification.authenticationInfo.newCounter);
    return Response.json({ ok: true, snapshotDigest: challenge.snapshotDigest });
  } catch (error) {
    return jsonError(error);
  }
}
