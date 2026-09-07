import { getPresignedFeeStatus } from '@/web/lib/server/presigned-fee-store';
import { jsonError } from '@/web/lib/server/http';
import { requireSessionUser } from '@/web/lib/server/session';
export const runtime = 'nodejs';
export async function GET() {
  try { return Response.json(await getPresignedFeeStatus(await requireSessionUser()), { headers: { 'cache-control': 'no-store' } }); }
  catch (error) { return jsonError(error); }
}
