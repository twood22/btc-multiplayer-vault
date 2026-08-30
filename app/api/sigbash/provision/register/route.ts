import { z } from 'zod';
import { deriveXpubChildPubkey, xpubRootXonly } from '@/src/crypto';
import { BITCOIN_NETWORK_NAME } from '@/src/network';
import { assertSameOrigin, jsonError } from '@/web/lib/server/http';
import { recordLiveSigbashRegistration } from '@/web/lib/server/roster-store';
import { assertSigbashCustodyLease } from '@/web/lib/server/sigbash-custody-store';
import { getSigbashProvisioningManifest } from '@/web/lib/server/sigbash-provisioning-store';
import { requireSessionUser } from '@/web/lib/server/session';
import { consumeRateLimit } from '@/web/lib/server/rate-limit';

export const runtime = 'nodejs';

const Input = z.object({
  leaseToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  round: z.string().regex(/^(alicebobcarol|alicebob|alicecarol|bobcarol)$/u),
  keyId: z.string().min(1).max(256),
  keyIndex: z.number().int().min(0).max(63),
  policyId: z.string().min(1).max(128),
  policyRoot: z.string().regex(/^[0-9a-f]{64}$/u),
  bip328Xpub: z.string().min(100).max(160),
  requestedPoetPolicy: z.unknown(),
  compiledPoetPolicy: z.unknown(),
});

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const input = Input.parse(await request.json());
    const userId = await requireSessionUser();
    await consumeRateLimit({
      action: 'sigbash_key_registration',
      subject: userId,
      limit: 6,
      windowSeconds: 3600,
    });
    await assertSigbashCustodyLease(userId, input.leaseToken);
    const manifest = await getSigbashProvisioningManifest(userId);
    if (!manifest.next || manifest.next.round !== input.round) {
      throw new Error('this is not the participant’s next canonical Sigbash round');
    }
    if (manifest.next.keyIndex !== input.keyIndex || manifest.next.policyId !== input.policyId) {
      throw new Error('Sigbash key index or policy id differs from the canonical manifest');
    }
    if (canonicalJson(input.requestedPoetPolicy) !== canonicalJson(manifest.next.poetPolicy)) {
      throw new Error('browser requested a Sigbash policy different from the canonical vault policy');
    }
    if (canonicalJson(input.compiledPoetPolicy) !== canonicalJson(manifest.next.poetPolicy)) {
      throw new Error('Sigbash returned a compiled policy different from the canonical vault policy');
    }
    const policyLeafXonlyPubkey = deriveXpubChildPubkey(input.bip328Xpub, [0, 0]).xonlyPubKeyHex;
    const identificationLeafXonlyPubkey = xpubRootXonly(input.bip328Xpub);
    await recordLiveSigbashRegistration({
      userId,
      round: input.round,
      registration: {
        network: BITCOIN_NETWORK_NAME,
        keyId: input.keyId,
        keyIndex: input.keyIndex,
        bip328Xpub: input.bip328Xpub,
        policyLeafXonlyPubkey,
        identificationLeafXonlyPubkey,
        policyRoot: input.policyRoot,
        policyId: input.policyId,
      },
    });
    return Response.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}
