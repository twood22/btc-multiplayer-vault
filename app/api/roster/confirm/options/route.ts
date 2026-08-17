import { generateAuthenticationOptions } from '@simplewebauthn/server';
import { z } from 'zod';
import { webConfig } from '@/web/lib/server/config';
import { assertSameOrigin, jsonError } from '@/web/lib/server/http';
import { createRosterConfirmationChallenge } from '@/web/lib/server/roster-store';
import { requireSessionUser } from '@/web/lib/server/session';

export const runtime = 'nodejs';

const Input = z.object({ credentialId: z.string().min(1).max(2048) });

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const input = Input.parse(await request.json());
    const userId = await requireSessionUser();
    const options = await generateAuthenticationOptions({
      rpID: webConfig().rpID,
      userVerification: 'required',
      timeout: 120_000,
    });
    const challenge = await createRosterConfirmationChallenge({
      userId,
      credentialId: input.credentialId,
      challenge: options.challenge,
    });
    return Response.json({
      challengeId: challenge.id,
      digest: challenge.digest,
      options: {
        ...options,
        allowCredentials: [{
          id: challenge.credential.id,
          type: 'public-key',
          transports: challenge.credential.transports,
        }],
      },
    });
  } catch (error) {
    return jsonError(error, error instanceof Error && error.message.includes('authentication') ? 401 : 400);
  }
}
