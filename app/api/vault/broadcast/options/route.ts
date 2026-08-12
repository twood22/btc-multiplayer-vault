import { generateAuthenticationOptions } from '@simplewebauthn/server';
import { z } from 'zod';
import { webConfig } from '@/web/lib/server/config';
import { assertSameOrigin, jsonError } from '@/web/lib/server/http';
import { requireSessionUser } from '@/web/lib/server/session';
import { createBroadcastApprovalChallenge } from '@/web/lib/server/vault-runtime-store';
import { consumeRateLimit } from '@/web/lib/server/rate-limit';

export const runtime = 'nodejs';

const Input = z.object({
  credentialId: z.string().min(1).max(2048),
  proposalId: z.string().uuid(),
  proposalDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  finalTxid: z.string().regex(/^[0-9a-f]{64}$/u),
}).strict();

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const input = Input.parse(await request.json());
    const userId = await requireSessionUser();
    await consumeRateLimit({
      action: 'broadcast_approval',
      subject: userId,
      limit: 5,
      windowSeconds: 900,
    });
    const options = await generateAuthenticationOptions({
      rpID: webConfig().rpID,
      userVerification: 'required',
      timeout: 120_000,
    });
    const challenge = await createBroadcastApprovalChallenge({
      userId,
      ...input,
      challenge: options.challenge,
    });
    return Response.json({
      approvalId: challenge.id,
      proposalId: challenge.proposalId,
      proposalDigest: challenge.proposalDigest,
      finalTxid: challenge.finalTxid,
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
