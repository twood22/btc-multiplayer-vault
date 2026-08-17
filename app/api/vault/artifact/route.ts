import { assertSameOrigin, jsonError } from '@/web/lib/server/http';
import { getConfirmedVaultArtifact } from '@/web/lib/server/roster-store';
import { requireSessionUser } from '@/web/lib/server/session';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const userId = await requireSessionUser();
    return Response.json(await getConfirmedVaultArtifact(userId));
  } catch (error) {
    return jsonError(error);
  }
}
