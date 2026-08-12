import { z } from 'zod';
import { assertSameOrigin, jsonError } from '@/web/lib/server/http';
import { requireSessionUser } from '@/web/lib/server/session';
import { completeSigbashReadinessProof } from '@/web/lib/server/sigbash-readiness-store';

export const runtime = 'nodejs';

const Input = z.object({
  leaseToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  challengeId: z.string().uuid(),
  transactionHex: z.string().regex(/^[0-9a-f]+$/u).max(400_000),
  signedPsbtBase64: z.string().min(20).max(100_000).optional(),
}).strict();

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const input = Input.parse(await request.json());
    const userId = await requireSessionUser();
    return Response.json(await completeSigbashReadinessProof({ userId, ...input }));
  } catch (error) {
    return jsonError(error, error instanceof Error && error.message.includes('authentication') ? 401 : 400);
  }
}
