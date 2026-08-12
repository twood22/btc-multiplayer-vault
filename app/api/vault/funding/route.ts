import { assertSameOrigin, jsonError } from '@/web/lib/server/http';
import { requireSessionUser } from '@/web/lib/server/session';
import { getFundingCeremonyStatus } from '@/web/lib/server/funding-ceremony-store';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const userId = await requireSessionUser();
    return Response.json(await getFundingCeremonyStatus(userId));
  } catch (error) {
    return jsonError(error, error instanceof Error && error.message.includes('authentication') ? 401 : 400);
  }
}
