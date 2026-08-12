import { z } from 'zod';
import { assertSameOrigin, jsonError } from '@/web/lib/server/http';
import { requireSessionUser } from '@/web/lib/server/session';
import { finalizeStoredSoloProposal } from '@/web/lib/server/vault-runtime-store';

export const runtime = 'nodejs';

const Input = z.object({
  proposalId: z.string().uuid(),
  proposalDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  transactionHex: z.string().regex(/^[0-9a-f]+$/u).max(400_000),
  signedPsbtBase64: z.string().min(20).max(100_000).optional(),
}).strict();

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const parsed = Input.parse(await request.json());
    const userId = await requireSessionUser();
    return Response.json(await finalizeStoredSoloProposal({ userId, ...parsed }));
  } catch (error) {
    return jsonError(error, error instanceof Error && error.message.includes('authentication') ? 401 : 400);
  }
}
