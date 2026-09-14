import { getPresignedCashoutStatus } from '@/web/lib/server/presigned-cashout-store';
import { jsonError } from '@/web/lib/server/http';
import { requireSessionUser } from '@/web/lib/server/session';
export const runtime = 'nodejs';
export async function GET() {
  try {
    return Response.json(await getPresignedCashoutStatus(await requireSessionUser()), { headers: { 'cache-control': 'no-store' } });
  } catch {
    return jsonError(new Error('Your saved cash-out records are unavailable; no transaction was submitted.'));
  }
}
