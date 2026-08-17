import { generateAuthenticationOptions } from '@simplewebauthn/server';
import { webConfig } from '@/web/lib/server/config';
import { assertSameOrigin, jsonError } from '@/web/lib/server/http';
import { createLoginChallenge } from '@/web/lib/server/webauthn-store';
import { consumeRateLimit } from '@/web/lib/server/rate-limit';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    await consumeRateLimit({
      action: 'passkey_login_challenge',
      // No account is disclosed before a discoverable-credential assertion.
      // The private beta therefore uses one deployment-wide challenge budget.
      subject: 'private_beta',
      limit: 120,
      windowSeconds: 600,
    });
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
