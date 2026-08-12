import { randomUUID } from 'node:crypto';
import { generateRegistrationOptions } from '@simplewebauthn/server';
import { z } from 'zod';
import { webConfig } from '@/web/lib/server/config';
import { createRegistrationChallenge } from '@/web/lib/server/webauthn-store';
import { assertSameOrigin, jsonError } from '@/web/lib/server/http';
import { consumeRateLimit } from '@/web/lib/server/rate-limit';

export const runtime = 'nodejs';

const Input = z.object({
  inviteToken: z.string().min(32).max(256),
  displayName: z.string().trim().min(1).max(80),
});

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const input = Input.parse(await request.json());
    await consumeRateLimit({
      action: 'passkey_registration',
      // This endpoint is unauthenticated. A fixed subject bounds database
      // growth without creating one counter row per attacker-chosen token.
      subject: 'private_beta',
      limit: 60,
      windowSeconds: 600,
    });
    const config = webConfig();
    const userId = randomUUID();
    const options = await generateRegistrationOptions({
      rpName: config.rpName,
      rpID: config.rpID,
      userName: userId,
      userDisplayName: input.displayName,
      userID: Buffer.from(userId.replaceAll('-', ''), 'hex'),
      attestationType: 'none',
      authenticatorSelection: {
        residentKey: 'required',
        requireResidentKey: true,
        userVerification: 'required',
      },
      timeout: 120_000,
    });
    const challenge = await createRegistrationChallenge({
      inviteToken: input.inviteToken,
      displayName: input.displayName,
      challenge: options.challenge,
      prospectiveUserId: userId,
    });
    return Response.json({
      challengeId: challenge.id,
      options: {
        ...options,
        extensions: { ...(options.extensions || {}), prf: {} },
      },
    });
  } catch (error) {
    return jsonError(error);
  }
}
