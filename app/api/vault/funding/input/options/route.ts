import { generateAuthenticationOptions } from '@simplewebauthn/server';
import { z } from 'zod';
import { webConfig } from '@/web/lib/server/config';
import { createFundingInputChallenge } from '@/web/lib/server/funding-ceremony-store';
import { assertSameOrigin, jsonError } from '@/web/lib/server/http';
import { requireSessionUser } from '@/web/lib/server/session';

export const runtime = 'nodejs';

const Input = z.object({
  credentialId: z.string().min(1).max(2048),
  txid: z.string().regex(/^[0-9a-f]{64}$/u),
  vout: z.number().int().min(0).max(0xffffffff),
  valueSats: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  scriptPubKeyHex: z.string().regex(/^[0-9a-f]+$/u).max(200),
  changeAddress: z.string().min(14).max(90).nullable(),
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
    const challenge = await createFundingInputChallenge({
      userId,
      ...input,
      challenge: options.challenge,
    });
    return Response.json({
      challengeId: challenge.id,
      commitment: challenge.commitment,
      commitmentDigest: challenge.commitmentDigest,
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
