import { assertSameOrigin, jsonError } from '@/web/lib/server/http';
import { requireSessionUser } from '@/web/lib/server/session';
import { getPresignedCeremonyStatus } from '@/web/lib/server/presigned-store';

export const runtime = 'nodejs';
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    return Response.json(await getPresignedCeremonyStatus(await requireSessionUser()), {
      headers: { 'cache-control': 'no-store' },
    });
  } catch (error) { return jsonError(error); }
}
