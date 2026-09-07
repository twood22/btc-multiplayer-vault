import { z } from 'zod';
import { submitPresignedFeeForUser } from '@/web/lib/server/presigned-fee-store';
import { readPresignedJson } from '@/web/lib/server/presigned-http';
import { assertSameOrigin, jsonError } from '@/web/lib/server/http';
import { requireSessionUser } from '@/web/lib/server/session';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const input = z.object({ packageId: z.string().uuid() }).strict().parse(await readPresignedJson(request));
    return Response.json(await submitPresignedFeeForUser(await requireSessionUser(), input.packageId));
  } catch (error) { return jsonError(error); }
}
