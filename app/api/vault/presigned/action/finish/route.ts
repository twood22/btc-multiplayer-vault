import { verifyAuthenticationResponse, type AuthenticationResponseJSON } from '@simplewebauthn/server';
import { z } from 'zod';
import { webConfig } from '@/web/lib/server/config';
import { completePresignedAction, getPresignedActionChallenge } from '@/web/lib/server/presigned-store';
import { assertPresignedFundingInputsCurrent, presignedActionDependencies } from '@/web/lib/server/presigned-core';
import { readPresignedJson } from '@/web/lib/server/presigned-http';
import { assertSameOrigin, jsonError } from '@/web/lib/server/http';
import { requireSessionUser } from '@/web/lib/server/session';
import { asWebAuthnCredential } from '@/web/lib/server/webauthn-store';
import { assertPresignedFundingSignatureRelease } from '@/web/lib/server/presigned-release-store';

export const runtime = 'nodejs';
const Input = z.object({ challengeId: z.string().uuid(), actionDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  response: z.unknown() }).strict();
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const input = Input.parse(await readPresignedJson(request));
    const userId = await requireSessionUser();
    const challenge = await getPresignedActionChallenge({ userId, challengeId: input.challengeId });
    assertPresignedFundingSignatureRelease(challenge.action.kind);
    if (input.actionDigest !== challenge.actionDigest) throw new Error('browser approved another ceremony action');
    const response = input.response as AuthenticationResponseJSON;
    if (!response || response.id !== challenge.credential.id) throw new Error('action assertion used another credential');
    const config = webConfig();
    const result = await verifyAuthenticationResponse({ response, expectedChallenge: challenge.challenge,
      expectedOrigin: config.origin, expectedRPID: config.rpID, credential: asWebAuthnCredential(challenge.credential),
      requireUserVerification: true });
    if (!result.verified) throw new Error('ceremony passkey approval failed');
    await assertPresignedFundingInputsCurrent(userId, challenge.action);
    return Response.json(await completePresignedAction(challenge, result.authenticationInfo.newCounter,
      presignedActionDependencies), { headers: { 'cache-control': 'no-store' } });
  } catch (error) { return jsonError(error); }
}
