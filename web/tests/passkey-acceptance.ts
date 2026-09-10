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
import { createParticipantSetupMaterial, participantSetupReadiness } from '../lib/client/participant-setup.js';
import { LEGACY_PROTOCOL, PRESIGNED_PROTOCOL } from '../../src/presigned/types.js';

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

await check('setup guidance preserves explicit V1 and V2 recovery requirements for both networks', () => {
  for (const network of ['signet', 'mainnet']) {
    const v2 = participantSetupReadiness(PRESIGNED_PROTOCOL, network);
    assert(v2.includes('both distinct passkeys and their saved offline recovery kit'), 'V2 omitted a mandatory recovery method');
    assert(v2.includes('independently verify the same graph and exact payouts'), 'V2 omitted independent graph verification');
    assert(v2.includes(`presigned ${network} release checks`), 'V2 guidance selected the wrong release network');
    assert(!/Sigbash|second passkey or/i.test(v2), 'V2 inherited a legacy readiness requirement');
    const v1 = participantSetupReadiness(LEGACY_PROTOCOL, network);
    assert(v1.includes('second passkey or offline recovery kit') && v1.includes(`live Sigbash ${network}`), 'legacy guidance changed');
    assert(!v1.includes('presigned'), 'legacy setup was silently reinterpreted as V2');
  }
});

await check('setup guidance never infers a protocol from missing or unknown membership', async () => {
  for (const protocol of [undefined, null, '', 'sigbash-v2', 'mainnet', {}]) {
    await expectReject(async () => participantSetupReadiness(protocol, 'mainnet'));
  }
});

await check('initial and resumed setup material returns only ciphertext and public identity and consumes PRF', async () => {
  const prf = randomBytes(32); const restorationPrf = Uint8Array.from(prf);
  let secret = '';
  try {
    const result = await createParticipantSetupMaterial(prf, toBase64url(Buffer.from('setup-identity-binding-v1')), 'carol');
    assert(Object.keys(result).sort().join(',') === 'envelope,identity', 'setup returned private participant material');
    assert(prf.every(byte => byte === 0), 'caller PRF survived successful setup');
    secret = await decryptParticipantSecretEnvelope(result.envelope, restorationPrf);
    assert(!JSON.stringify(result).includes(secret), 'returned setup material contains plaintext');
    const expected = await deriveParticipantIdentity(secret, 'carol');
    assert(JSON.stringify(result.identity) === JSON.stringify(expected), 'setup public identity does not match the encrypted backup');
  } finally { prf.fill(0); restorationPrf.fill(0); secret = ''; }
});

for (const fault of ['none', 'import', 'encrypt', 'identity-first', 'identity-second', 'participant'] as const) {
  await check(`setup consumes owned PRF and derivation buffers on ${fault} path`, async () => {
    const subtle = crypto.subtle;
    const original = { importKey: subtle.importKey, encrypt: subtle.encrypt, digest: subtle.digest };
    const prf = randomBytes(32); const retained: Uint8Array[] = [];
    let digestCalls = 0; let intendedFailureObserved = false;
    const fail = () => { intendedFailureObserved = true; throw new Error('isolated setup failure injection'); };
    try {
      subtle.importKey = (async (...args: any[]) => {
        if (fault === 'import') fail();
        return (original.importKey as any).apply(subtle, args);
      }) as typeof subtle.importKey;
      subtle.encrypt = async (algorithm, key, data) => {
        if (fault === 'encrypt') fail();
        return original.encrypt.call(subtle, algorithm, key, data);
      };
      subtle.digest = async (algorithm, data) => {
        digestCalls++;
        if (digestCalls >= 2) retained.push(ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data));
        if ((fault === 'identity-first' && digestCalls === 2) || (fault === 'identity-second' && digestCalls === 3)) fail();
        const result = await original.digest.call(subtle, algorithm, data);
        if (digestCalls >= 2) retained.push(new Uint8Array(result));
        return result;
      };
      const operation = () => createParticipantSetupMaterial(prf, toBase64url(Buffer.from('fault-bound-setup-v1')),
        fault === 'participant' ? 'not-a-participant' : 'alice');
      if (fault === 'none') await operation();
      else await expectReject(operation);
      assert(prf.every(byte => byte === 0), 'owned caller PRF survived setup completion or failure');
      assert(retained.every(bytes => bytes.every(byte => byte === 0)), 'owned identity derivation material survived completion or failure');
      if (fault.startsWith('identity-')) assert(intendedFailureObserved, 'identity failure was not reached');
      if (fault === 'import' || fault === 'encrypt') assert(intendedFailureObserved, 'requested crypto failure was not reached');
      if (fault === 'none') assert(retained.length === 4, 'success did not inspect both private scalars and their input material');
      if (fault === 'identity-second') assert(retained.length === 3, 'second failure did not inspect the previously derived private scalar');
    } finally {
      subtle.importKey = original.importKey; subtle.encrypt = original.encrypt; subtle.digest = original.digest;
      prf.fill(0); retained.forEach(bytes => bytes.fill(0));
    }
  });
}

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
