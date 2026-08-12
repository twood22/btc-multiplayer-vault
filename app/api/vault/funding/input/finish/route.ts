import {
  verifyAuthenticationResponse,
  type AuthenticationResponseJSON,
} from '@simplewebauthn/server';
import { z } from 'zod';
import { webConfig } from '@/web/lib/server/config';
import {
  completeFundingInputChallenge,
  getFundingInputChallenge,
} from '@/web/lib/server/funding-ceremony-store';
import { assertSameOrigin, jsonError } from '@/web/lib/server/http';
import { requireSessionUser } from '@/web/lib/server/session';
import { asWebAuthnCredential } from '@/web/lib/server/webauthn-store';

export const runtime = 'nodejs';

const Input = z.object({
  challengeId: z.string().uuid(),
  commitmentDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  response: z.unknown(),
}).strict();

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const input = Input.parse(await request.json());
    const userId = await requireSessionUser();
    const challenge = await getFundingInputChallenge({
      userId,
      challengeId: input.challengeId,
    });
    if (input.commitmentDigest !== challenge.commitmentDigest) {
      throw new Error('browser approved a different funding input commitment');
    }
    const response = input.response as AuthenticationResponseJSON;
    if (response.id !== challenge.credential.id) {
      throw new Error('assertion used a different passkey than the funding input challenge');
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
    if (!verification.verified) throw new Error('passkey funding input approval could not be verified');
    return Response.json(await completeFundingInputChallenge(
      challenge,
      verification.authenticationInfo.newCounter,
    ));
  } catch (error) {
    return jsonError(error);
  }
}
