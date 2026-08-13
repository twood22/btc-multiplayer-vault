import { assertSameOrigin, jsonError } from '@/web/lib/server/http';
import { destroyCurrentSession } from '@/web/lib/server/session';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    await destroyCurrentSession();
    return Response.json({ signedOut: true });
  } catch (error) {
    return jsonError(error);
  }
}
