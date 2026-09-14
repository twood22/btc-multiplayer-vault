import { preparePresignedCashout, type PresignedSignedCashout } from '@/web/lib/server/presigned-cashout-store';
import { assertSameOrigin, jsonError } from '@/web/lib/server/http';
import { requireSessionUser } from '@/web/lib/server/session';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const userId = await requireSessionUser();
    if (!request.body) throw new Error('missing body');
    const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    let artifact: PresignedSignedCashout;
    try {
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.length; if (size > 1024 * 1024) throw new Error('oversized cash-out artifact');
        chunks.push(part.value);
      }
      artifact = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as PresignedSignedCashout;
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    return Response.json(await preparePresignedCashout(userId, artifact), { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return jsonError(error instanceof Error && error.message.startsWith('presigned-v2:') ? error
      : new Error('Cash-out could not be saved. Check your signed artifact and current payout; nothing was submitted.'));
  }
}
