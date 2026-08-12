import {
  verifyAuthenticationResponse,
  type AuthenticationResponseJSON,
} from '@simplewebauthn/server';
import { z } from 'zod';
import { webConfig } from '@/web/lib/server/config';
import { assertSameOrigin, jsonError } from '@/web/lib/server/http';
import { requireSessionUser } from '@/web/lib/server/session';
import {
  completeBroadcastApproval,
  getBroadcastApprovalChallenge,
  submitApprovedBroadcast,
} from '@/web/lib/server/vault-runtime-store';
import { asWebAuthnCredential } from '@/web/lib/server/webauthn-store';

export const runtime = 'nodejs';

const Input = z.object({
  approvalId: z.string().uuid(),
  proposalId: z.string().uuid(),
  proposalDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  finalTxid: z.string().regex(/^[0-9a-f]{64}$/u),
  response: z.unknown(),
}).strict();

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const input = Input.parse(await request.json());
    const userId = await requireSessionUser();
    const challenge = await getBroadcastApprovalChallenge({
      approvalId: input.approvalId,
      userId,
    });
    if (input.proposalId !== challenge.proposalId ||
        input.proposalDigest !== challenge.proposalDigest ||
        input.finalTxid !== challenge.finalTxid) {
      throw new Error('browser approved a different finalized transaction');
    }
    const response = input.response as AuthenticationResponseJSON;
    if (response.id !== challenge.credential.id) {
      throw new Error('assertion used a different passkey than the broadcast challenge');
    }
    const config = webConfig();
    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: config.origin,
      expectedRPID: config.rpID,
      credential: asWebAuthnCredential(challenge.credential),
      requireUserVerification: true,
    });
    if (!verification.verified) throw new Error('passkey broadcast approval could not be verified');
    const approvalId = await completeBroadcastApproval(
      challenge,
      verification.authenticationInfo.newCounter,
    );
    const submitted = await submitApprovedBroadcast({ approvalId, userId });
    return Response.json({ ok: true, txid: submitted.txid, network: 'mainnet' });
  } catch (error) {
    return jsonError(error);
  }
}
