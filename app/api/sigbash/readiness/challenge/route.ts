import { z } from 'zod';
import { assertSameOrigin, jsonError } from '@/web/lib/server/http';
import { requireSessionUser } from '@/web/lib/server/session';
import { createSigbashReadinessChallenge } from '@/web/lib/server/sigbash-readiness-store';
import { consumeRateLimit } from '@/web/lib/server/rate-limit';

export const runtime = 'nodejs';

const Input = z.object({
  leaseToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
}).strict();

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const input = Input.parse(await request.json());
    const userId = await requireSessionUser();
    await consumeRateLimit({
      action: 'sigbash_readiness_challenge',
      subject: userId,
      limit: 12,
      windowSeconds: 900,
    });
    return Response.json(await createSigbashReadinessChallenge({ userId, ...input }));
  } catch (error) {
    return jsonError(error, error instanceof Error && error.message.includes('authentication') ? 401 : 400);
  }
}
