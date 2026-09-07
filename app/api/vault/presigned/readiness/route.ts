import { getPresignedFundingReadiness } from '@/web/lib/server/presigned-release-store';
import { requireSessionUser } from '@/web/lib/server/session';
import { jsonError } from '@/web/lib/server/http';
export const runtime = 'nodejs';
export async function GET() {
  try {
    return Response.json(await getPresignedFundingReadiness(await requireSessionUser()), { headers: { 'cache-control': 'no-store' } });
  } catch (error) { return jsonError(error); }
}
