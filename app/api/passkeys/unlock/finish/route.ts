import {
  verifyAuthenticationResponse,
  type AuthenticationResponseJSON,
} from '@simplewebauthn/server';
import { z } from 'zod';
import { webConfig } from '@/web/lib/server/config';
import { toBase64url } from '@/web/lib/server/encoding';
import { assertSameOrigin, jsonError } from '@/web/lib/server/http';
import { requireSessionUser } from '@/web/lib/server/session';
import {
  asWebAuthnCredential,
  completeUnlock,
  getAssertionChallenge,
} from '@/web/lib/server/webauthn-store';

export const runtime = 'nodejs';

const Input = z.object({ challengeId: z.string().uuid(), response: z.unknown() });

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const input = Input.parse(await request.json());
    const userId = await requireSessionUser();
    const response = input.response as AuthenticationResponseJSON & {
      clientExtensionResults?: { prf?: { results?: unknown } };
    };
    if (response.clientExtensionResults?.prf?.results !== undefined) {
      throw new Error('PRF output must be removed in the browser before sending the assertion');
    }
    const challenge = await getAssertionChallenge(input.challengeId, userId, 'unlock');
    if (response.id !== challenge.credential.id) {
      throw new Error('assertion used a different passkey than the unlock challenge');
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
    if (!verification.verified) throw new Error('passkey unlock could not be verified');
    const envelope = await completeUnlock(challenge, verification.authenticationInfo.newCounter);
    return Response.json({
      envelope: {
        version: 1,
        iv: toBase64url(envelope.iv),
        ciphertext: toBase64url(envelope.ciphertext),
        aad: toBase64url(envelope.aad),
      },
    });
  } catch (error) {
    return jsonError(error);
  }
}
