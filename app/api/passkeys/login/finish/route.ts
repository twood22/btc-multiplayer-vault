import {
  verifyAuthenticationResponse,
  type AuthenticationResponseJSON,
} from '@simplewebauthn/server';
import { z } from 'zod';
import { webConfig } from '@/web/lib/server/config';
import { assertSameOrigin, jsonError } from '@/web/lib/server/http';
import { consumeRateLimit } from '@/web/lib/server/rate-limit';
import { createSession } from '@/web/lib/server/session';
import {
  asWebAuthnCredential,
  completeLogin,
  getLoginChallenge,
} from '@/web/lib/server/webauthn-store';

export const runtime = 'nodejs';

const Input = z.object({ challengeId: z.string().uuid(), response: z.unknown() });

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const input = Input.parse(await request.json());
    const response = input.response as AuthenticationResponseJSON;
    const challenge = await getLoginChallenge(input.challengeId, response.id);
    await consumeRateLimit({
      action: 'passkey_login',
      subject: challenge.credential.id,
      limit: 10,
      windowSeconds: 600,
    });
    const config = webConfig();
    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: config.origin,
      expectedRPID: config.rpID,
      credential: asWebAuthnCredential(challenge.credential),
      requireUserVerification: true,
    });
    if (!verification.verified) throw new Error('passkey sign-in could not be verified');
    await completeLogin(challenge, verification.authenticationInfo.newCounter);
    await createSession(challenge.credential.userId);
    return Response.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
