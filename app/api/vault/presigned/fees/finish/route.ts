import { verifyAuthenticationResponse, type AuthenticationResponseJSON } from '@simplewebauthn/server';
import { z } from 'zod';
import { completePresignedFeeChallenge, getPresignedFeeChallenge } from '@/web/lib/server/presigned-fee-store';
import { webConfig } from '@/web/lib/server/config';
import { readPresignedJson } from '@/web/lib/server/presigned-http';
import { assertSameOrigin, jsonError } from '@/web/lib/server/http';
import { requireSessionUser } from '@/web/lib/server/session';
import { asWebAuthnCredential } from '@/web/lib/server/webauthn-store';
export const runtime = 'nodejs';
const Input = z.object({ challengeId: z.string().uuid(), packageDigest: z.string().regex(/^[0-9a-f]{64}$/u), response: z.unknown() }).strict();
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const input = Input.parse(await readPresignedJson(request));
    const challenge = await getPresignedFeeChallenge(await requireSessionUser(), input.challengeId);
    const response = input.response as AuthenticationResponseJSON;
    if (input.packageDigest !== challenge.packageDigest || !response || response.id !== challenge.credential.id)
      throw new Error('fee approval changed its exact package or passkey');
    const config = webConfig();
    const result = await verifyAuthenticationResponse({ response, expectedChallenge: challenge.challenge,
      expectedOrigin: config.origin, expectedRPID: config.rpID, credential: asWebAuthnCredential(challenge.credential), requireUserVerification: true });
    if (!result.verified) throw new Error('fee passkey approval failed');
    return Response.json(await completePresignedFeeChallenge(challenge, result.authenticationInfo.newCounter), { headers: { 'cache-control': 'no-store' } });
  } catch (error) { return jsonError(error); }
}
