import { generateAuthenticationOptions } from '@simplewebauthn/server';
import { z } from 'zod';
import { validatePresignedRuntimeAction } from '@/src/presigned/runtime';
import { webConfig } from '@/web/lib/server/config';
import { createPresignedRuntimeActionChallenge } from '@/web/lib/server/presigned-runtime-store';
import { presignedRuntimeActionDependencies } from '@/web/lib/server/presigned-core';
import { readPresignedJson } from '@/web/lib/server/presigned-http';
import { assertSameOrigin, jsonError } from '@/web/lib/server/http';
import { requireSessionUser } from '@/web/lib/server/session';
export const runtime = 'nodejs';
const Input = z.object({ credentialId: z.string().min(1).max(2048), action: z.unknown() }).strict();
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const input = Input.parse(await readPresignedJson(request));
    const action = validatePresignedRuntimeAction(input.action);
    const options = await generateAuthenticationOptions({ rpID: webConfig().rpID, userVerification: 'required', timeout: 120_000 });
    const challenge = await createPresignedRuntimeActionChallenge({ userId: await requireSessionUser(),
      credentialId: input.credentialId, challenge: options.challenge, action }, presignedRuntimeActionDependencies());
    return Response.json({ challengeId: challenge.id, protocol: challenge.protocol, action: challenge.action,
      actionDigest: challenge.actionDigest, proposal: challenge.proposal, options: { ...options,
        allowCredentials: [{ id: challenge.credential.id, type: 'public-key', transports: challenge.credential.transports }] } },
    { headers: { 'cache-control': 'no-store' } });
  } catch (error) { return jsonError(error); }
}
