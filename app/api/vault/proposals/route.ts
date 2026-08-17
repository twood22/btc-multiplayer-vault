import { z } from 'zod';
import { assertSameOrigin, jsonError } from '@/web/lib/server/http';
import { requireSessionUser } from '@/web/lib/server/session';
import { createStoredVaultProposal } from '@/web/lib/server/vault-runtime-store';
import { consumeRateLimit } from '@/web/lib/server/rate-limit';

export const runtime = 'nodejs';

const Input = z.object({
  kind: z.enum(['solo', 'cooperative', 'recovery', 'final_sweep']),
  actorParticipantId: z.enum(['alice', 'bob', 'carol']).optional(),
}).strict();

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const input = Input.parse(await request.json());
    const userId = await requireSessionUser();
    await consumeRateLimit({
      action: 'vault_proposal',
      subject: userId,
      limit: 10,
      windowSeconds: 900,
    });
    return Response.json(await createStoredVaultProposal(userId, input));
  } catch (error) {
    return jsonError(error, error instanceof Error && error.message.includes('authentication') ? 401 : 400);
  }
}
