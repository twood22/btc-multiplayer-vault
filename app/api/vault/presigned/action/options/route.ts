import { generateAuthenticationOptions } from '@simplewebauthn/server';
import { z } from 'zod';
import { validatePresignedAction } from '@/src/presigned/ceremony';
import { webConfig } from '@/web/lib/server/config';
import { createPresignedActionChallenge } from '@/web/lib/server/presigned-store';
import { assertPresignedFundingInputsCurrent, presignedActionDependencies } from '@/web/lib/server/presigned-core';
import { readPresignedJson } from '@/web/lib/server/presigned-http';
import { assertSameOrigin, jsonError } from '@/web/lib/server/http';
import { requireSessionUser } from '@/web/lib/server/session';
import { assertPresignedFundingSignatureRelease } from '@/web/lib/server/presigned-release-store';

export const runtime = 'nodejs';
const Input = z.object({ credentialId: z.string().min(1).max(2048), action: z.unknown() }).strict();
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const input = Input.parse(await readPresignedJson(request));
    const userId = await requireSessionUser();
    const action = validatePresignedAction(input.action);
    assertPresignedFundingSignatureRelease(action.kind);
    await assertPresignedFundingInputsCurrent(userId, action);
    const options = await generateAuthenticationOptions({ rpID: webConfig().rpID,
      userVerification: 'required', timeout: 120_000 });
    const challenge = await createPresignedActionChallenge({ userId, credentialId: input.credentialId,
      challenge: options.challenge, action }, presignedActionDependencies);
    return Response.json({ challengeId: challenge.id, protocol: challenge.protocol, action: challenge.action,
      actionDigest: challenge.actionDigest, options: { ...options, allowCredentials: [{
        id: challenge.credential.id, type: 'public-key', transports: challenge.credential.transports,
      }] } }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) { return jsonError(error); }
}
