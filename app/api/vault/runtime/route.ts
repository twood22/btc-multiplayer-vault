import { z } from 'zod';
import { assertSameOrigin, jsonError } from '@/web/lib/server/http';
import { requireLegacySessionUser } from '@/web/lib/server/session';
import { getVaultRuntimeStatus } from '@/web/lib/server/vault-runtime-store';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const userId = await requireLegacySessionUser();
    const input = z.object({ proposalId: z.string().uuid().optional() }).strict().parse(await request.json());
    return Response.json(await getVaultRuntimeStatus(userId, input.proposalId));
  } catch (error) {
    return jsonError(error, error instanceof Error && error.message.includes('authentication') ? 401 : 400);
  }
}
