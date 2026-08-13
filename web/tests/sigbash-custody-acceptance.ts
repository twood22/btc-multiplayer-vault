import { randomBytes } from 'node:crypto';
import { getAuthHash } from '@sigbash/sdk';
import { toBase64url } from '../lib/client/base64url';
import {
  createEmptySigbashCustodyBundle,
  decryptSigbashCustodyEnvelope,
  encryptSigbashCustodyBundle,
  generateSigbashCredentials,
  recoverLatestSigbashCustodyBundle,
  type SigbashCustodyBundle,
} from '../lib/client/sigbash-custody';
import { disposeSigbashBrowserClient } from '../lib/client/sigbash-browser';

const checks: Array<{ name: string; ok: boolean }> = [];

async function check(name: string, run: () => unknown | Promise<unknown>) {
  await run();
  checks.push({ name, ok: true });
}

const participantSecret = toBase64url(randomBytes(32));
const aadOne = toBase64url(Buffer.from('sigbash-custody-alice-vault-user-revision-1'));
const aadTwo = toBase64url(Buffer.from('sigbash-custody-alice-vault-user-revision-2'));

await check('browser credentials match the exact Sigbash 32-byte hex shape', async () => {
  const credentials = await generateSigbashCredentials();
  for (const value of Object.values(credentials)) assert(/^[0-9a-f]{64}$/u.test(value), 'credential/hash shape mismatch');
  assert(new Set([credentials.apiKey, credentials.userKey, credentials.userSecretKey]).size === 3, 'credentials reused entropy');
  const sdkHashes = await getAuthHash(credentials.apiKey, credentials.userKey);
  assert(credentials.authHash === sdkHashes.authHash, 'browser authHash differs from the pinned SDK');
  assert(credentials.apikeyHash === sdkHashes.apikeyHash, 'browser apikeyHash differs from the pinned SDK');
});

await check('participant secret encrypts and decrypts a mainnet Sigbash bundle', async () => {
  const bundle = createEmptySigbashCustodyBundle('alice', await generateSigbashCredentials());
  const envelope = await encryptSigbashCustodyBundle(bundle, participantSecret, 1, aadOne);
  const decrypted = await decryptSigbashCustodyEnvelope(envelope, participantSecret);
  assert(decrypted.credentials.apiKey === bundle.credentials.apiKey, 'credential changed after encryption');
  assert(!JSON.stringify(envelope).includes(bundle.credentials.apiKey), 'API key leaked into stored envelope');
  assert(!JSON.stringify(envelope).includes(bundle.credentials.userSecretKey), 'secret key leaked into stored envelope');
});

await check('wrong participant secret and changed AAD both fail closed', async () => {
  const bundle = createEmptySigbashCustodyBundle('alice', await generateSigbashCredentials());
  const envelope = await encryptSigbashCustodyBundle(bundle, participantSecret, 1, aadOne);
  await expectReject(() => decryptSigbashCustodyEnvelope(envelope, toBase64url(randomBytes(32))));
  await expectReject(() => decryptSigbashCustodyEnvelope({ ...envelope, aad: aadTwo }, participantSecret));
});

await check('append-only recovery falls back from a corrupt newest revision', async () => {
  const bundle = createEmptySigbashCustodyBundle('alice', await generateSigbashCredentials());
  const first = await encryptSigbashCustodyBundle(bundle, participantSecret, 1, aadOne);
  const second = await encryptSigbashCustodyBundle(
    { ...bundle, pendingKey: { round: 'alicebob', keyIndex: 0, policyId: 'alicebob:alice' } },
    participantSecret,
    2,
    aadTwo,
  );
  const corrupt = {
    ...second,
    ciphertext: `${second.ciphertext[0] === 'A' ? 'B' : 'A'}${second.ciphertext.slice(1)}`,
  };
  const recovered = await recoverLatestSigbashCustodyBundle([first, corrupt], participantSecret);
  assert(recovered?.revision === 1, 'did not recover last decryptable revision');
});

await check('recovery kit is bound to its key and mainnet', async () => {
  const empty = createEmptySigbashCustodyBundle('alice', await generateSigbashCredentials());
  const withKey: SigbashCustodyBundle = {
    ...empty,
    keys: [{
      round: 'alicebob',
      keyId: '0',
      keyIndex: 0,
      policyId: 'alicebob:alice',
      policyRoot: 'ab'.repeat(32),
      bip328Xpub: `xpub${'a'.repeat(108)}`,
      poetJSON: { version: '1.1' },
      recoveryKit: {
        version: 'sdk-recovery-v1',
        keyId: '0',
        recoveryKEK: 'cd'.repeat(32),
        cekCiphertext: 'ef'.repeat(48),
        cekNonce: '01'.repeat(12),
        network: 'mainnet',
        createdAt: 1,
      },
    }],
  };
  await encryptSigbashCustodyBundle(withKey, participantSecret, 1, aadOne);
  await expectReject(() => encryptSigbashCustodyBundle({
    ...withKey,
    keys: [{ ...withKey.keys[0]!, recoveryKit: { ...withKey.keys[0]!.recoveryKit, keyId: 'other' } }],
  }, participantSecret, 1, aadOne));
});

await check('browser Sigbash teardown disconnects sockets and disposes copied private-key material', () => {
  const calls: string[] = [];
  disposeSigbashBrowserClient({
    disconnect() { calls.push('disconnect'); },
    dispose() { calls.push('dispose'); },
  });
  assert(JSON.stringify(calls) === JSON.stringify(['disconnect', 'dispose']), 'Sigbash teardown order changed');

  let disposedAfterFailure = false;
  let rejected = false;
  try {
    disposeSigbashBrowserClient({
      disconnect() { throw new Error('controlled disconnect failure'); },
      dispose() { disposedAfterFailure = true; },
    });
  } catch (error) {
    rejected = error instanceof Error && error.message === 'controlled disconnect failure';
  }
  assert(disposedAfterFailure, 'SDK private-key disposal was skipped after disconnect failed');
  assert(rejected, 'disconnect failure was not surfaced');
});

console.log(JSON.stringify({ passed: checks.every((item) => item.ok), checks }, null, 2));

async function expectReject(run: () => Promise<unknown>): Promise<void> {
  let rejected = false;
  try { await run(); } catch { rejected = true; }
  assert(rejected, 'operation unexpectedly succeeded');
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
