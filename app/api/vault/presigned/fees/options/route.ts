import { generateAuthenticationOptions } from '@simplewebauthn/server';
import { z } from 'zod';
import { createPresignedFeeChallenge } from '@/web/lib/server/presigned-fee-store';
import { webConfig } from '@/web/lib/server/config';
import { readPresignedJson } from '@/web/lib/server/presigned-http';
import { assertSameOrigin, jsonError } from '@/web/lib/server/http';
import { requireSessionUser } from '@/web/lib/server/session';
export const runtime = 'nodejs';
const Input = z.object({ credentialId: z.string().min(1).max(2048), package: z.unknown() }).strict();
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const input = Input.parse(await readPresignedJson(request));
    const options = await generateAuthenticationOptions({ rpID: webConfig().rpID, userVerification: 'required', timeout: 120_000 });
    const challenge = await createPresignedFeeChallenge({ ...input, userId: await requireSessionUser(), challenge: options.challenge });
    return Response.json({ challengeId: challenge.id, package: challenge.package, packageDigest: challenge.packageDigest,
      options: { ...options, allowCredentials: [{ type: 'public-key', id: challenge.credential.id, transports: challenge.credential.transports }] } },
    { headers: { 'cache-control': 'no-store' } });
  } catch (error) { return jsonError(error); }
}
