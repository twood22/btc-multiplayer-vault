import {
  verifyAuthenticationResponse,
  type AuthenticationResponseJSON,
} from '@simplewebauthn/server';
import { z } from 'zod';
import { webConfig } from '@/web/lib/server/config';
import { assertSameOrigin, jsonError } from '@/web/lib/server/http';
import {
  completeRosterConfirmation,
  getRosterConfirmationChallenge,
} from '@/web/lib/server/roster-store';
import { requireSessionUser } from '@/web/lib/server/session';
import { asWebAuthnCredential } from '@/web/lib/server/webauthn-store';

export const runtime = 'nodejs';

const Input = z.object({
  challengeId: z.string().uuid(),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  response: z.unknown(),
});

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const input = Input.parse(await request.json());
    const userId = await requireSessionUser();
    const challenge = await getRosterConfirmationChallenge({ challengeId: input.challengeId, userId });
    if (input.digest !== challenge.digest) throw new Error('browser confirmed a different roster digest');
    const response = input.response as AuthenticationResponseJSON;
    if (response.id !== challenge.credential.id) {
      throw new Error('assertion used a different passkey than the roster challenge');
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
    if (!verification.verified) throw new Error('passkey roster confirmation could not be verified');
    const completed = await completeRosterConfirmation(
      challenge,
      verification.authenticationInfo.newCounter,
    );
    return Response.json({ ok: true, unanimous: completed.unanimous });
  } catch (error) {
    return jsonError(error);
  }
}
