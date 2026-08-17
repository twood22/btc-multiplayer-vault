import { z } from 'zod';
import { assertSameOrigin, jsonError } from '@/web/lib/server/http';
import { requireSessionUser } from '@/web/lib/server/session';
import { recordRecoveryContribution } from '@/web/lib/server/vault-runtime-store';
import { consumeRateLimit } from '@/web/lib/server/rate-limit';

export const runtime = 'nodejs';

const Share = z.object({
  round: z.enum(['alicebobcarol', 'alicebob', 'alicecarol', 'bobcarol']),
  vanishedId: z.enum(['alice', 'bob', 'carol']),
  participantId: z.enum(['alice', 'bob', 'carol']),
  xonlyPubkey: z.string().regex(/^[0-9a-f]{64}$/u),
  leafHashHex: z.string().regex(/^[0-9a-f]{64}$/u),
  unsignedTxid: z.string().regex(/^[0-9a-f]{64}$/u),
  signatureHex: z.string().regex(/^[0-9a-f]{128}$/u),
}).strict();

const Input = z.object({
  proposalId: z.string().uuid(),
  proposalDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  share: Share,
}).strict();

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const parsed = Input.parse(await request.json());
    const userId = await requireSessionUser();
    await consumeRateLimit({
      action: 'vault_signature_submission',
      subject: userId,
      limit: 30,
      windowSeconds: 900,
    });
    return Response.json(await recordRecoveryContribution({ userId, ...parsed }));
  } catch (error) {
    return jsonError(error, error instanceof Error && error.message.includes('authentication') ? 401 : 400);
  }
}
