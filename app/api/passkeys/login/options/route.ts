import { generateAuthenticationOptions } from '@simplewebauthn/server';
import { webConfig } from '@/web/lib/server/config';
import { assertSameOrigin, jsonError } from '@/web/lib/server/http';
import { createLoginChallenge } from '@/web/lib/server/webauthn-store';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const options = await generateAuthenticationOptions({
      rpID: webConfig().rpID,
      userVerification: 'required',
      timeout: 120_000,
    });
    const challengeId = await createLoginChallenge(options.challenge);
    return Response.json({ challengeId, options });
  } catch (error) {
    return jsonError(error);
  }
}
