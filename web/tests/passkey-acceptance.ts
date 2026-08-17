import { randomBytes } from 'node:crypto';
import {
  createParticipantSecretEnvelope,
  decryptParticipantSecretEnvelope,
  encryptParticipantSecretEnvelope,
} from '../lib/client/key-envelope';
import { toBase64url } from '../lib/client/base64url';
import { stripPrfSecrets } from '../lib/client/webauthn';
import {
  deriveParticipantIdentity,
  deriveParticipantSigbashPrivateKey,
} from '../lib/client/participant-identity';
import { deriveParticipantKeys } from '../../src/vault.js';
import { unlockPublishedVault } from '../lib/client/vault-signing.js';
import { scrubUnlockedVaultCustody } from '../lib/client/unlocked-vault-custody.js';
import { createIsolatedSoloFixture } from './solo-signing-fixture.js';

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

await check('browser BYO Sigbash share exactly matches every authoritative round derivation', async () => {
  const secret = toBase64url(randomBytes(32));
  const core = deriveParticipantKeys('alice', secret, ['alice', 'bob', 'carol']);
  for (const [round, key] of Object.entries(core.sigbashByRound)) {
    const browserPrivateKey = await deriveParticipantSigbashPrivateKey(secret, 'alice', round);
    assert(Buffer.from(browserPrivateKey).toString('hex') === key.privateKeyHex, `${round} private share mismatch`);
    browserPrivateKey.fill(0);
  }
});

await check('one-action vault unlock drops every transient private-key reference on teardown', () => {
  const fixture = createIsolatedSoloFixture('70d14fe5-e04b-4737-a098-b2482062bf16');
  const unlocked = unlockPublishedVault({
    artifact: fixture.artifact,
    expectedDigest: fixture.digest,
    participantSecret: fixture.participantSecrets.alice,
  });
  const alice = unlocked.signer.state.participants.find((item) => item.id === 'alice')!;
  assert(Boolean(alice.personal.privateKeyHex), 'test unlock has no personal private key');
  assert(Boolean(alice.payout.privateKeyHex), 'test unlock has no payout private key');
  scrubUnlockedVaultCustody(unlocked);
  for (const participant of unlocked.signer.state.participants) {
    assert(participant.personal.privateKeyHex === '', `${participant.id} personal key reference survived teardown`);
    assert(participant.payout.privateKeyHex === '', `${participant.id} payout key reference survived teardown`);
    for (const key of Object.values(participant.sigbashByRound)) {
      assert(key.privateKeyHex === '', `${participant.id} Sigbash key reference survived teardown`);
    }
  }
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
