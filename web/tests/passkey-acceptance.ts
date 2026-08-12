import { randomBytes } from 'node:crypto';
import {
  createParticipantSecretEnvelope,
  decryptParticipantSecretEnvelope,
  encryptParticipantSecretEnvelope,
} from '../lib/client/key-envelope';
import { toBase64url } from '../lib/client/base64url';
import { stripPrfSecrets } from '../lib/client/webauthn';
import { deriveParticipantIdentity } from '../lib/client/participant-identity';
import { deriveParticipantKeys } from '../../src/vault.js';

const checks: Array<{ name: string; ok: boolean }> = [];

async function check(name: string, run: () => unknown | Promise<unknown>) {
  try {
    await run();
    checks.push({ name, ok: true });
  } catch (error) {
    checks.push({ name, ok: false });
    throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

await check('passkey PRF output encrypts and decrypts one participant secret', async () => {
  const prf = randomBytes(32);
  const aad = toBase64url(Buffer.from('fixed-test-identity-binding-v1'));
  const protectedKey = await createParticipantSecretEnvelope(prf, aad);
  const secret = await decryptParticipantSecretEnvelope(protectedKey.envelope, prf);
  assert(/^[A-Za-z0-9_-]{43}$/.test(secret), 'decrypted secret shape mismatch');
  assert(!JSON.stringify(protectedKey.envelope).includes(secret), 'plaintext secret appears in stored envelope');
});

await check('a different passkey PRF output cannot decrypt the envelope', async () => {
  const { envelope } = await createParticipantSecretEnvelope(
    randomBytes(32),
    toBase64url(Buffer.from('identity-binding-v1')),
  );
  await expectReject(() => decryptParticipantSecretEnvelope(envelope, randomBytes(32)));
});

await check('two distinct passkeys protect the exact same participant identity', async () => {
  const original = await createParticipantSecretEnvelope(
    randomBytes(32),
    toBase64url(Buffer.from('primary-credential-binding-v1')),
  );
  const recoveryPrf = randomBytes(32);
  const recovery = await encryptParticipantSecretEnvelope(
    original.participantSecret,
    recoveryPrf,
    toBase64url(Buffer.from('recovery-credential-binding-v1')),
  );
  const recoveredSecret = await decryptParticipantSecretEnvelope(recovery, recoveryPrf);
  assert(recoveredSecret === original.participantSecret, 'recovery envelope changed the participant secret');
  const originalIdentity = await deriveParticipantIdentity(original.participantSecret, 'bob');
  const recoveredIdentity = await deriveParticipantIdentity(recoveredSecret, 'bob');
  assert(
    originalIdentity.personalPublicKeyHex === recoveredIdentity.personalPublicKeyHex,
    'recovery envelope changed the personal public key',
  );
  assert(
    originalIdentity.payoutXonlyPublicKeyHex === recoveredIdentity.payoutXonlyPublicKeyHex,
    'recovery envelope changed the payout public key',
  );
});

await check('changing the envelope identity binding invalidates AES-GCM', async () => {
  const prf = randomBytes(32);
  const { envelope } = await createParticipantSecretEnvelope(
    prf,
    toBase64url(Buffer.from('alice-vault-one-credential-one')),
  );
  await expectReject(() =>
    decryptParticipantSecretEnvelope(
      { ...envelope, aad: toBase64url(Buffer.from('mallory-vault-one-credential-one')) },
      prf,
    ),
  );
});

await check('browser key derivation exactly matches the existing vault core', async () => {
  const secret = toBase64url(randomBytes(32));
  const browser = await deriveParticipantIdentity(secret, 'alice');
  const core = deriveParticipantKeys('alice', secret, ['alice', 'bob', 'carol']);
  assert(browser.personalPublicKeyHex === core.personal.publicKeyHex, 'personal public key mismatch');
  assert(browser.payoutXonlyPublicKeyHex === core.payout.xonlyPubKeyHex, 'payout public key mismatch');
});

await check('PRF encryption material is removed from server-bound assertions', () => {
  const sentinel = 'server-must-never-see-this-prf-output';
  const response: Record<string, unknown> = {
    id: 'credential',
    clientExtensionResults: { prf: { results: { first: sentinel } } },
  };
  stripPrfSecrets(response);
  assert(!JSON.stringify(response).includes(sentinel), 'PRF output survived assertion sanitization');
});

console.log(JSON.stringify({ passed: checks.every((item) => item.ok), checks }, null, 2));

async function expectReject(run: () => Promise<unknown>): Promise<void> {
  let rejected = false;
  try {
    await run();
  } catch {
    rejected = true;
  }
  assert(rejected, 'operation unexpectedly succeeded');
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
