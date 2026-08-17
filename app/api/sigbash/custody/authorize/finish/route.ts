import { verifyAuthenticationResponse, type AuthenticationResponseJSON } from '@simplewebauthn/server';
import { z } from 'zod';
import { webConfig } from '@/web/lib/server/config';
import { toBase64url } from '@/web/lib/server/encoding';
import { assertSameOrigin, jsonError } from '@/web/lib/server/http';
import { requireSessionUser } from '@/web/lib/server/session';
import { completeSigbashCustodyAuthorization } from '@/web/lib/server/sigbash-custody-store';
import { asWebAuthnCredential, getAssertionChallenge } from '@/web/lib/server/webauthn-store';

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
    const challenge = await getAssertionChallenge(input.challengeId, userId, 'sigbash_custody');
    if (response.id !== challenge.credential.id) throw new Error('Sigbash authorization used the wrong passkey');
    const config = webConfig();
    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: config.origin,
      expectedRPID: config.rpID,
      credential: asWebAuthnCredential(challenge.credential),
      requireUserVerification: true,
    });
    if (!verification.verified) throw new Error('Sigbash passkey authorization could not be verified');
    const authorized = await completeSigbashCustodyAuthorization(
      challenge,
      verification.authenticationInfo.newCounter,
    );
    return Response.json({
      leaseToken: authorized.leaseToken,
      participantEnvelope: {
        version: 1,
        iv: toBase64url(authorized.participantEnvelope.iv),
        ciphertext: toBase64url(authorized.participantEnvelope.ciphertext),
        aad: toBase64url(authorized.participantEnvelope.aad),
      },
      custodyEnvelopes: authorized.custodyEnvelopes.map((envelope) => ({
        version: 1,
        revision: envelope.revision,
        iv: toBase64url(envelope.iv),
        ciphertext: toBase64url(envelope.ciphertext),
        aad: toBase64url(envelope.aad),
      })),
      nextRevision: authorized.nextRevision,
      nextAad: toBase64url(authorized.nextAad),
    });
  } catch (error) {
    return jsonError(error);
  }
}
