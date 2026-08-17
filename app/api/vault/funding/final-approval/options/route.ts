import { generateAuthenticationOptions } from '@simplewebauthn/server';
import { z } from 'zod';
import { webConfig } from '@/web/lib/server/config';
import { createFundingFinalApprovalChallenge } from '@/web/lib/server/funding-signature-store';
import { assertSameOrigin, jsonError } from '@/web/lib/server/http';
import { requireSessionUser } from '@/web/lib/server/session';

export const runtime = 'nodejs';

const Input = z.object({ credentialId: z.string().min(1).max(2048) }).strict();

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
    const challenge = await createFundingFinalApprovalChallenge({
      userId,
      ...input,
      challenge: options.challenge,
    });
    return Response.json({
      challengeId: challenge.id,
      finalizationDigest: challenge.finalizationDigest,
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
