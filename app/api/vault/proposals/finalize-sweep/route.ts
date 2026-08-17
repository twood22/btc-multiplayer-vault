import { z } from 'zod';
import { assertSameOrigin, jsonError } from '@/web/lib/server/http';
import { requireSessionUser } from '@/web/lib/server/session';
import { finalizeStoredFinalSweep } from '@/web/lib/server/vault-runtime-store';
import { consumeRateLimit } from '@/web/lib/server/rate-limit';

export const runtime = 'nodejs';

const Input = z.object({
  proposalId: z.string().uuid(),
  proposalDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  transactionHex: z.string().regex(/^[0-9a-f]+$/u).max(400_000),
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
    return Response.json(await finalizeStoredFinalSweep({ userId, ...parsed }));
  } catch (error) {
    return jsonError(error, error instanceof Error && error.message.includes('authentication') ? 401 : 400);
  }
}
