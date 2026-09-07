import { verifyAuthenticationResponse, type AuthenticationResponseJSON } from '@simplewebauthn/server';
import { z } from 'zod';
import { webConfig } from '@/web/lib/server/config';
import { completePresignedRuntimeAction, getPresignedRuntimeActionChallenge } from '@/web/lib/server/presigned-runtime-store';
import { presignedRuntimeActionDependencies } from '@/web/lib/server/presigned-core';
import { readPresignedJson } from '@/web/lib/server/presigned-http';
import { assertSameOrigin, jsonError } from '@/web/lib/server/http';
import { requireSessionUser } from '@/web/lib/server/session';
import { asWebAuthnCredential } from '@/web/lib/server/webauthn-store';
export const runtime = 'nodejs';
const Input = z.object({ challengeId: z.string().uuid(), actionDigest: z.string().regex(/^[0-9a-f]{64}$/u), response: z.unknown() }).strict();
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const input = Input.parse(await readPresignedJson(request));
    const challenge = await getPresignedRuntimeActionChallenge({ userId: await requireSessionUser(), challengeId: input.challengeId });
    if (input.actionDigest !== challenge.actionDigest) throw new Error('browser approved another runtime action');
    const response = input.response as AuthenticationResponseJSON;
    if (!response || response.id !== challenge.credential.id) throw new Error('runtime assertion used another credential');
    const config = webConfig();
    const result = await verifyAuthenticationResponse({ response, expectedChallenge: challenge.challenge,
      expectedOrigin: config.origin, expectedRPID: config.rpID, credential: asWebAuthnCredential(challenge.credential), requireUserVerification: true });
    if (!result.verified) throw new Error('runtime passkey approval failed');
    return Response.json(await completePresignedRuntimeAction(challenge, result.authenticationInfo.newCounter,
      presignedRuntimeActionDependencies()), { headers: { 'cache-control': 'no-store' } });
  } catch (error) { return jsonError(error); }
}
