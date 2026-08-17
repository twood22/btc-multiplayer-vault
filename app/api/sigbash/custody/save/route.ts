import { z } from 'zod';
import { fromBase64url, toBase64url } from '@/web/lib/server/encoding';
import { assertSameOrigin, jsonError } from '@/web/lib/server/http';
import { requireSessionUser } from '@/web/lib/server/session';
import { appendSigbashCustodyEnvelope } from '@/web/lib/server/sigbash-custody-store';

export const runtime = 'nodejs';

const Base64url = z.string().regex(/^[A-Za-z0-9_-]+$/u);
const Input = z.object({
  leaseToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  envelope: z.object({
    version: z.literal(1),
    revision: z.number().int().min(1).max(32),
    iv: Base64url.max(32),
    ciphertext: Base64url.max(90_000),
    aad: Base64url.max(1024),
  }),
});

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const input = Input.parse(await request.json());
    const userId = await requireSessionUser();
    const result = await appendSigbashCustodyEnvelope({
      userId,
      leaseToken: input.leaseToken,
      version: input.envelope.version,
      revision: input.envelope.revision,
      iv: fromBase64url(input.envelope.iv, 'Sigbash custody IV'),
      ciphertext: fromBase64url(input.envelope.ciphertext, 'Sigbash custody ciphertext'),
      aad: fromBase64url(input.envelope.aad, 'Sigbash custody AAD'),
    });
    return Response.json({
      ok: true,
      nextRevision: result.nextRevision,
      nextAad: result.nextAad ? toBase64url(result.nextAad) : null,
    });
  } catch (error) {
    return jsonError(error);
  }
}
