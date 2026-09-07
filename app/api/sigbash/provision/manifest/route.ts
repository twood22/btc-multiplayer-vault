import { assertSameOrigin, jsonError } from '@/web/lib/server/http';
import { requireLegacySessionUser } from '@/web/lib/server/session';
import { getSigbashProvisioningManifest } from '@/web/lib/server/sigbash-provisioning-store';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const userId = await requireLegacySessionUser();
    return Response.json(await getSigbashProvisioningManifest(userId));
  } catch (error) {
    return jsonError(error);
  }
}
