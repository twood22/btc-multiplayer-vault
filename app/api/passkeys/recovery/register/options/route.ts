import { generateRegistrationOptions } from '@simplewebauthn/server';
import { z } from 'zod';
import { webConfig } from '@/web/lib/server/config';
import { assertSameOrigin, jsonError } from '@/web/lib/server/http';
import { requireSessionUser } from '@/web/lib/server/session';
import {
  createRecoveryRegistrationChallenge,
  getMemberStatus,
} from '@/web/lib/server/webauthn-store';

export const runtime = 'nodejs';

const Input = z.object({ enrollmentId: z.string().uuid() });

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const input = Input.parse(await request.json());
    const userId = await requireSessionUser();
    const member = await getMemberStatus(userId);
    const config = webConfig();
    const options = await generateRegistrationOptions({
      rpName: config.rpName,
      rpID: config.rpID,
      userName: userId,
      userDisplayName: member.displayName,
      userID: Buffer.from(userId.replaceAll('-', ''), 'hex'),
      attestationType: 'none',
      authenticatorSelection: {
        residentKey: 'required',
        requireResidentKey: true,
        userVerification: 'required',
      },
      timeout: 120_000,
    });
    const challenge = await createRecoveryRegistrationChallenge({
      userId,
      enrollmentId: input.enrollmentId,
      challenge: options.challenge,
    });
    return Response.json({
      challengeId: challenge.id,
      options: {
        ...options,
        excludeCredentials: challenge.existingCredentials.map((credential) => ({
          id: credential.id,
          type: 'public-key' as const,
          transports: credential.transports,
        })),
        extensions: { ...(options.extensions || {}), prf: {} },
      },
    });
  } catch (error) {
    return jsonError(error);
  }
}
