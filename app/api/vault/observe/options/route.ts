import { generateAuthenticationOptions } from '@simplewebauthn/server';
import { z } from 'zod';
import { webConfig } from '@/web/lib/server/config';
import { assertSameOrigin, jsonError } from '@/web/lib/server/http';
import { requireSessionUser } from '@/web/lib/server/session';
import { createCoinObservationChallenge } from '@/web/lib/server/vault-runtime-store';

export const runtime = 'nodejs';

const Input = z.object({
  credentialId: z.string().min(1).max(2048),
  snapshotDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  sourceOrigin: z.string().url().max(255),
  confirmations: z.number().int().positive().max(2_000_000),
  observedUnspent: z.literal(true),
}).strict();

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const input = Input.parse(await request.json());
    const userId = await requireSessionUser();
    const options = await generateAuthenticationOptions({
      rpID: webConfig().rpID,
      userVerification: 'required',
      timeout: 120_000,
    });
    const challenge = await createCoinObservationChallenge({
      userId,
      ...input,
      challenge: options.challenge,
    });
    return Response.json({
      challengeId: challenge.id,
      snapshotDigest: challenge.snapshotDigest,
      options: {
        ...options,
        allowCredentials: [{
          id: challenge.credential.id,
          type: 'public-key',
          transports: challenge.credential.transports,
        }],
      },
    });
  } catch (error) {
    return jsonError(error, error instanceof Error && error.message.includes('authentication') ? 401 : 400);
  }
}
