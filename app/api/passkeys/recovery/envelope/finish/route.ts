import { verifyAuthenticationResponse, type AuthenticationResponseJSON } from '@simplewebauthn/server';
import { z } from 'zod';
import * as ecc from 'tiny-secp256k1';
import { envelopeAad } from '@/web/lib/server/aad';
import { webConfig } from '@/web/lib/server/config';
import { fromBase64url } from '@/web/lib/server/encoding';
import { assertSameOrigin, jsonError } from '@/web/lib/server/http';
import { requireSessionUser } from '@/web/lib/server/session';
import {
  asWebAuthnCredential,
  completeRecoveryEnvelope,
  getAssertionChallenge,
} from '@/web/lib/server/webauthn-store';

export const runtime = 'nodejs';

const Input = z.object({
  challengeId: z.string().uuid(),
  enrollmentId: z.string().uuid(),
  response: z.unknown(),
  envelope: z.object({
    version: z.literal(1),
    iv: z.string().min(16).max(32),
    ciphertext: z.string().min(44).max(700),
    aad: z.string().min(20).max(400),
  }),
  identity: z.object({
    personalPublicKeyHex: z.string().regex(/^0[23][0-9a-f]{64}$/),
    payoutXonlyPublicKeyHex: z.string().regex(/^[0-9a-f]{64}$/),
  }),
});

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
    const challenge = await getAssertionChallenge(input.challengeId, userId, 'recovery_envelope');
    if (challenge.recoveryEnrollmentId !== input.enrollmentId) {
      throw new Error('recovery envelope used the wrong enrollment');
    }
    if (response.id !== challenge.credential.id) throw new Error('recovery envelope used the wrong passkey');
    const config = webConfig();
    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: config.origin,
      expectedRPID: config.rpID,
      credential: asWebAuthnCredential(challenge.credential),
      requireUserVerification: true,
    });
    if (!verification.verified) throw new Error('recovery passkey assertion could not be verified');
    const expectedAad = envelopeAad({
      userId,
      credentialId: challenge.credential.id,
      vaultId: challenge.credential.vaultId,
      participantId: challenge.credential.participantId,
    });
    const aad = fromBase64url(input.envelope.aad, 'envelope aad');
    if (!aad.equals(expectedAad)) throw new Error('recovery envelope is bound to the wrong identity');
    const iv = fromBase64url(input.envelope.iv, 'envelope iv');
    const ciphertext = fromBase64url(input.envelope.ciphertext, 'envelope ciphertext');
    if (iv.length !== 12) throw new Error('envelope IV must be 12 bytes');
    if (ciphertext.length < 33 || ciphertext.length > 512) throw new Error('invalid recovery envelope length');
    const personalPublicKey = Buffer.from(input.identity.personalPublicKeyHex, 'hex');
    const payoutXonlyPublicKey = Buffer.from(input.identity.payoutXonlyPublicKeyHex, 'hex');
    if (!ecc.isPoint(personalPublicKey) || !ecc.isXOnlyPoint(payoutXonlyPublicKey)) {
      throw new Error('participant public key material is not on secp256k1');
    }
    await completeRecoveryEnvelope({
      challenge,
      newCounter: verification.authenticationInfo.newCounter,
      iv,
      ciphertext,
      aad,
      personalPublicKey,
      payoutXonlyPublicKey,
    });
    return Response.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}
