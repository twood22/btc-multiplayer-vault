import { z } from 'zod';
import { assertSameOrigin, jsonError } from '@/web/lib/server/http';
import { requireSessionUser } from '@/web/lib/server/session';
import { createStoredVaultProposal } from '@/web/lib/server/vault-runtime-store';

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
    return Response.json(await createStoredVaultProposal(userId, input));
  } catch (error) {
    return jsonError(error, error instanceof Error && error.message.includes('authentication') ? 401 : 400);
  }
}
