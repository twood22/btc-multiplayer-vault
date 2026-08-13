import {
  verifyAuthenticationResponse,
  type AuthenticationResponseJSON,
} from '@simplewebauthn/server';
import { z } from 'zod';
import { webConfig } from '@/web/lib/server/config';
import {
  completeFundingSignatureChallenge,
  getFundingSignatureChallenge,
} from '@/web/lib/server/funding-signature-store';
import { assertSameOrigin, jsonError } from '@/web/lib/server/http';
import { requireSessionUser } from '@/web/lib/server/session';
import { asWebAuthnCredential } from '@/web/lib/server/webauthn-store';

export const runtime = 'nodejs';

const Input = z.object({
  challengeId: z.string().uuid(),
  contributionDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  response: z.unknown(),
}).strict();

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const input = Input.parse(await request.json());
    const userId = await requireSessionUser();
    const challenge = await getFundingSignatureChallenge({
      userId,
      challengeId: input.challengeId,
    });
    if (input.contributionDigest !== challenge.contributionDigest) {
      throw new Error('browser approved a different normalized wallet signature');
    }
    const response = input.response as AuthenticationResponseJSON;
    if (response.id !== challenge.credential.id) {
      throw new Error('assertion used a different passkey than the funding signature challenge');
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
    if (!verification.verified) throw new Error('passkey funding signature approval could not be verified');
    return Response.json(await completeFundingSignatureChallenge(
      challenge,
      verification.authenticationInfo.newCounter,
    ));
  } catch (error) {
    return jsonError(error);
  }
}
