import { strict as assert } from 'node:assert';
import { randomBytes, randomUUID } from 'node:crypto';
import { BITCOIN_NETWORK_NAME } from '../../src/network.js';
import {
  encryptPresignedOfflineBackup, generatePresignedOfflineSecret,
  MAX_PRESIGNED_BACKUP_FILE_BYTES, parsePresignedOfflineBackup, presignedBackupBinding,
  serializePresignedOfflineBackup, validatePresignedPublicKit,
  verifyPresignedKitRestoration, verifyPresignedOfflineBackupRestoration,
  withRestoredPresignedOfflineBackup,
  type PresignedBackupBinding, type PresignedOfflineBackup, type RestoredPresignedBackup,
} from '../../src/presigned/backup.js';
import { createPresignedFixture } from '../../src/presigned/fixtures.js';
import { createPreauthorizations } from '../../src/presigned/signing.js';
import { PARTICIPANT_IDS, PRESIGNED_PROTOCOL, type ParticipantId, type PresignedPublicKit } from '../../src/presigned/types.js';
import { genesisHash } from '../../src/presigned/validation.js';
import { toBase64url } from '../lib/client/base64url';
import { createParticipantSecretEnvelope, decryptParticipantSecretEnvelope, encryptParticipantSecretEnvelope } from '../lib/client/key-envelope';
import {
  verifyPresignedPasskeyRestoration, withUnlockedPresignedParticipant,
  type PresignedUnlockDependencies, type UnlockedPresignedParticipant,
} from '../lib/client/presigned-custody';

const checks: Array<{ name: string; ok: boolean }> = [];
const fixture = createPresignedFixture({ network: BITCOIN_NETWORK_NAME });
const publicKit: PresignedPublicKit = { version: 2, protocol: PRESIGNED_PROTOCOL,
  graph: fixture.graph,
  preauthorizations: PARTICIPANT_IDS.flatMap(id => createPreauthorizations({
    graph: fixture.graph, participantId: id, privateKeys: fixture.keysById[id].soloPrivateKeys,
    approvedGraphDigest: fixture.graph.digest,
  })),
};
const kit = validatePresignedPublicKit(publicKit);
const offlineSecret = generatePresignedOfflineSecret();
const binding = presignedBackupBinding(kit, 'alice');
const envelope = await encryptPresignedOfflineBackup({ publicKit: kit,
  participantId: 'alice', participantSecret: fixture.participantSecrets.alice, offlineSecret });

async function check(name: string, run: () => unknown | Promise<unknown>) {
  await run();
  checks.push({ name, ok: true });
}

await check('independent random 256-bit wrapping secrets are distinct from participant secrets', () => {
  const second = generatePresignedOfflineSecret();
  assert.equal(offlineSecret.length, 32);
  assert.notDeepEqual(offlineSecret, second);
  assert.notEqual(toBase64url(offlineSecret), fixture.participantSecrets.alice);
  second.fill(0);
});

await check('the whole participant kit is encrypted without leaking either secret or a signing nonce', async () => {
  const serialized = serializePresignedOfflineBackup(envelope);
  assert(!serialized.includes(fixture.participantSecrets.alice));
  assert(!serialized.includes(toBase64url(offlineSecret)));
  assert(!serialized.includes(Buffer.from(offlineSecret).toString('hex')));
  assert(!serialized.includes('preauthorizations'));
  assert(!serialized.includes('secnonce'));
  assert.deepEqual(parsePresignedOfflineBackup(serialized), envelope);
  let borrowed: RestoredPresignedBackup | undefined;
  await withRestoredPresignedOfflineBackup({ envelope, offlineSecret, expectedBinding: binding,
    action: restored => {
      borrowed = restored;
      assert.equal(restored.participantSecret, fixture.participantSecrets.alice);
      assert.deepEqual(restored.publicKit, kit);
    },
  });
  assert.equal(borrowed?.participantSecret, '');
});

await check('repeated encryption uses fresh salt and IV while preserving independently verified identity', async () => {
  const next = await encryptPresignedOfflineBackup({ publicKit: kit, participantId: 'alice',
    participantSecret: fixture.participantSecrets.alice, offlineSecret });
  assert.notEqual(next.salt, envelope.salt);
  assert.notEqual(next.iv, envelope.iv);
  assert.notEqual(next.ciphertext, envelope.ciphertext);
  assert.deepEqual(next.binding, envelope.binding);
});

await check('restoration verifies all three owner exits and returns only public proof digests', async () => {
  const proof = await verifyPresignedOfflineBackupRestoration({ envelope, offlineSecret, expectedBinding: binding });
  assert.deepEqual(proof.exitProofs.map(item => item.exitId),
    kit.graph.exits.filter(exit => exit.leaver === 'alice').map(exit => exit.id).sort());
  assert.equal(proof.exitProofs.length, 3);
  assert.match(proof.proofDigest, /^[0-9a-f]{64}$/u);
  assert.match(proof.participantIdentityDigest, /^[0-9a-f]{64}$/u);
  const serialized = JSON.stringify(proof);
  assert(!serialized.includes('transactionHex'));
  assert(!serialized.includes('participantSecret'));
  assert(!serialized.includes(fixture.participantSecrets.alice));
  assert(!serialized.includes('signatureHex'));
  for (const item of proof.exitProofs) {
    assert.match(item.transactionDigest, /^[0-9a-f]{64}$/u);
    assert.equal(item.txid, kit.graph.exits.find(exit => exit.id === item.exitId)!.txid);
  }
});

await check('all three participant identities independently restore their complete owner exit sets', async () => {
  for (const participantId of PARTICIPANT_IDS) {
    const own = await encryptPresignedOfflineBackup({ publicKit: kit, participantId,
      participantSecret: fixture.participantSecrets[participantId], offlineSecret });
    const proof = await verifyPresignedOfflineBackupRestoration({ envelope: own, offlineSecret,
      expectedBinding: presignedBackupBinding(kit, participantId) });
    assert.equal(proof.binding.participantId, participantId);
    assert.equal(proof.exitProofs.length, 3);
  }
});

await check('wrong wrapping secrets and malformed key lengths cannot decrypt a kit', async () => {
  await assert.rejects(verifyPresignedOfflineBackupRestoration({ envelope,
    offlineSecret: generatePresignedOfflineSecret(), expectedBinding: binding }), /authentication failed/u);
  await assert.rejects(verifyPresignedOfflineBackupRestoration({ envelope,
    offlineSecret: new Uint8Array(31), expectedBinding: binding }), /32 random bytes/u);
});

await check('the participant secret cannot be reused as the supposedly independent offline wrapping key', async () => {
  await assert.rejects(encryptPresignedOfflineBackup({ publicKit: kit, participantId: 'alice',
    participantSecret: fixture.participantSecrets.alice,
    offlineSecret: Buffer.from(fixture.participantSecrets.alice, 'base64url') }), /independent/u);
});

await check('changed ciphertext, salt, and IV fail authenticated decryption', async () => {
  for (const field of ['ciphertext', 'salt', 'iv'] as const) {
    const changed = { ...envelope, [field]: mutateBase64url(envelope[field]) };
    await assert.rejects(verifyPresignedOfflineBackupRestoration({ envelope: changed, offlineSecret,
      expectedBinding: binding }), /authentication failed/u);
  }
});

await check('vault, network, participant, epoch and digest substitutions are rejected', async () => {
  const replacements: Partial<PresignedBackupBinding>[] = [
    { vaultId: randomUUID() }, { participantId: 'bob' }, { epochId: randomUUID() },
    { graphDigest: 'a1'.repeat(32) }, { rosterDigest: 'a2'.repeat(32) }, { fundingTxid: 'a3'.repeat(32) },
    { network: binding.network === 'mainnet' ? 'signet' : 'mainnet',
      genesisHash: genesisHash(binding.network === 'mainnet' ? 'signet' : 'mainnet') },
  ];
  for (const replacement of replacements) {
    const swapped = { ...binding, ...replacement };
    await assert.rejects(verifyPresignedOfflineBackupRestoration({ envelope, offlineSecret,
      expectedBinding: swapped }), /binding/u);
    // Even if a caller accepts the altered public header, GCM binds the original header.
    await assert.rejects(verifyPresignedOfflineBackupRestoration({ envelope: { ...envelope, binding: swapped },
      offlineSecret, expectedBinding: swapped }), /authentication failed/u);
  }
});

await check('legacy protocol, unknown metadata, unsupported crypto and noncanonical encodings fail closed', () => {
  const variants = [
    { ...envelope, version: 2 }, { ...envelope, protocol: 'sigbash-v1' },
    { ...envelope, cipher: 'AES-CBC' }, { ...envelope, kdf: 'none' },
    { ...envelope, nonce: 'must-not-be-stored' }, { ...envelope, iv: `${envelope.iv}=` },
    { ...envelope, binding: { ...binding, protocol: 'sigbash-v1' } },
  ];
  for (const variant of variants) assert.throws(() => parsePresignedOfflineBackup(JSON.stringify(variant)));
});

await check('oversized files and deeply nested kit objects are rejected before recursive validation', () => {
  assert.throws(() => parsePresignedOfflineBackup(' '.repeat(MAX_PRESIGNED_BACKUP_FILE_BYTES + 1)), /too large/u);
  let nested: unknown = {};
  for (let depth = 0; depth < 40; depth += 1) nested = { nested };
  assert.throws(() => validatePresignedPublicKit({ ...kit, nested } as PresignedPublicKit), /too complex/u);
});

await check('incomplete or corrupted preauthorizations cannot be encrypted as a complete recovery kit', async () => {
  const incomplete = { ...kit, preauthorizations: kit.preauthorizations.slice(1) };
  await assert.rejects(encryptPresignedOfflineBackup({ publicKit: incomplete, participantId: 'alice',
    participantSecret: fixture.participantSecrets.alice, offlineSecret }), /twelve|missing/u);
  const corrupted = structuredClone(kit);
  corrupted.preauthorizations[0]!.signatureHex = '00'.repeat(64);
  await assert.rejects(encryptPresignedOfflineBackup({ publicKit: corrupted, participantId: 'alice',
    participantSecret: fixture.participantSecrets.alice, offlineSecret }), /signature/u);
});

await check('tampered graph commitments and another participant secret cannot become valid recovery kits', async () => {
  const changed = structuredClone(kit);
  changed.graph.exits[0]!.txid = 'c1'.repeat(32);
  await assert.rejects(encryptPresignedOfflineBackup({ publicKit: changed, participantId: 'alice',
    participantSecret: fixture.participantSecrets.alice, offlineSecret }), /graph/u);
  await assert.rejects(encryptPresignedOfflineBackup({ publicKit: kit, participantId: 'alice',
    participantSecret: fixture.participantSecrets.bob, offlineSecret }), /identity/u);
});

await check('restoration refuses a graph that does not match independently approved binding', () => {
  assert.throws(() => verifyPresignedKitRestoration({ publicKit: kit, participantId: 'alice',
    participantSecret: fixture.participantSecrets.alice,
    expectedBinding: { ...binding, epochId: randomUUID() } }), /binding/u);
});

await check('callback failure drops the decrypted participant-secret reference', async () => {
  let borrowed: RestoredPresignedBackup | undefined;
  await assert.rejects(withRestoredPresignedOfflineBackup({ envelope, offlineSecret, expectedBinding: binding,
    action: restored => { borrowed = restored; throw new Error('fixture callback failed'); },
  }), /fixture callback failed/u);
  assert.equal(borrowed?.participantSecret, '');
});

await check('provider-free unlock uses only exact passkey endpoints and scrubs PRF and keys after one action', async () => {
  const mock = await unlockFixture('alice');
  let borrowed: UnlockedPresignedParticipant | undefined;
  const result = await withUnlockedPresignedParticipant({ ...mock.input,
    action: unlocked => {
      borrowed = unlocked;
      assert.equal(unlocked.participantSecret, fixture.participantSecrets.alice);
      assert.deepEqual(unlocked.publicIdentity, fixture.roster.participants.find(entry => entry.id === 'alice'));
      assert(unlocked.keys.personalPrivateKey.some(byte => byte !== 0));
      return 'only a public outcome';
    },
  }, mock.dependencies);
  assert.equal(result, 'only a public outcome');
  assert.equal(borrowed?.participantSecret, '');
  assert(borrowed?.keys.personalPrivateKey.every(byte => byte === 0));
  assert(borrowed?.keys.payoutPrivateKey.every(byte => byte === 0));
  assert(Object.values(borrowed!.keys.soloPrivateKeys).every(key => key.every(byte => byte === 0)));
  assert(mock.lastPrf()?.every(byte => byte === 0));
  assert.deepEqual(mock.requests.map(request => request.path), ['/api/passkeys/unlock/options', '/api/passkeys/unlock/finish']);
  const sent = JSON.stringify(mock.requests);
  assert(!sent.includes(fixture.participantSecrets.alice));
  assert(!sent.includes('PRF_SECRET_SENTINEL'));
  assert(!sent.includes('sigbash'));
});

await check('two distinct passkey PRF envelopes restore the same complete kit without either other key', async () => {
  const primary = await unlockFixture('alice');
  const recovery = await unlockFixture('alice');
  assert.notEqual(primary.input.credentialId, recovery.input.credentialId);
  const proofs = [];
  for (const mock of [primary, recovery]) {
    proofs.push(await verifyPresignedPasskeyRestoration({ credentialId: mock.input.credentialId,
      publicKit: kit, expectedBinding: binding }, mock.dependencies));
  }
  assert.deepEqual(proofs.map(proof => proof.binding.graphDigest), [fixture.graph.digest, fixture.graph.digest]);
  assert.deepEqual(proofs.map(proof => proof.exitProofs.length), [3, 3]);
  assert.notEqual(proofs[0]!.credentialId, proofs[1]!.credentialId);
});

await check('an options response for another credential or participant is refused before assertion', async () => {
  for (const kind of ['credential', 'participant', 'identity', 'uv'] as const) {
    const mock = await unlockFixture('alice');
    if (kind === 'credential') mock.authorization.options.allowCredentials[0]!.id = toBase64url(randomBytes(24));
    if (kind === 'participant') mock.authorization.participantId = 'bob';
    if (kind === 'identity') mock.authorization.expectedIdentity.personalPublicKeyHex = fixture.roster.participants.find(entry => entry.id === 'bob')!.personalPublicKeyHex;
    if (kind === 'uv') mock.authorization.options.userVerification = 'discouraged';
    await assert.rejects(withUnlockedPresignedParticipant({ ...mock.input, action: () => assert.fail('unexpected action') }, mock.dependencies));
    assert.equal(mock.assertions(), 0);
    assert.equal(mock.requests.length, 1);
  }
});

await check('an assertion for another passkey is rejected without sending the finish request', async () => {
  const mock = await unlockFixture('alice');
  const original = mock.dependencies.assertWithPrf;
  mock.dependencies.assertWithPrf = async options => {
    const result = await original(options);
    result.response.id = toBase64url(randomBytes(24));
    return result;
  };
  await assert.rejects(withUnlockedPresignedParticipant({ ...mock.input, action: () => assert.fail('unexpected action') }, mock.dependencies), /different passkey/u);
  assert.equal(mock.requests.length, 1);
  assert(mock.lastPrf()?.every(byte => byte === 0));
});

await check('vault-substituted envelopes and mismatched round identities cannot reach a signing action', async () => {
  const wrongVault = await unlockFixture('alice');
  await assert.rejects(withUnlockedPresignedParticipant({ ...wrongVault.input, expectedVaultId: randomUUID(),
    action: () => assert.fail('unexpected action') }, wrongVault.dependencies), /another identity/u);
  const wrongRound = await unlockFixture('alice');
  const participant = structuredClone(wrongRound.input.expectedParticipant);
  participant.soloPublicKeys.alicebobcarol = fixture.roster.participants.find(entry => entry.id === 'bob')!.soloPublicKeys.alicebobcarol;
  await assert.rejects(withUnlockedPresignedParticipant({ ...wrongRound.input, expectedParticipant: participant,
    action: () => assert.fail('unexpected action') }, wrongRound.dependencies), /identity/u);
  assert(wrongVault.lastPrf()?.every(byte => byte === 0));
  assert(wrongRound.lastPrf()?.every(byte => byte === 0));
});

await check('wrong PRF and failing client actions are cleared without returning signer material', async () => {
  const wrongPrf = await unlockFixture('alice');
  wrongPrf.dependencies.assertWithPrf = async () => ({ response: { id: wrongPrf.input.credentialId }, prfOutput: randomBytes(32) });
  await assert.rejects(withUnlockedPresignedParticipant({ ...wrongPrf.input,
    action: () => assert.fail('unexpected action') }, wrongPrf.dependencies));
  const mock = await unlockFixture('alice');
  let borrowed: UnlockedPresignedParticipant | undefined;
  await assert.rejects(withUnlockedPresignedParticipant({ ...mock.input,
    action: unlocked => { borrowed = unlocked; throw new Error('fixture action failed'); },
  }, mock.dependencies), /fixture action failed/u);
  assert.equal(borrowed?.participantSecret, '');
  assert(Object.values(borrowed!.keys.soloPrivateKeys).every(key => key.every(byte => byte === 0)));
});

await check('owned envelope plaintext and PRF copies are cleared on success, crypto errors and decoding failure', async () => {
  const subtle = crypto.subtle;
  const original = { importKey: subtle.importKey, encrypt: subtle.encrypt, decrypt: subtle.decrypt,
    getRandomValues: crypto.getRandomValues };
  const retained: Uint8Array[] = [];
  let failure: 'none' | 'import' | 'encrypt' | 'round-trip' | 'decode' = 'none';
  const prf = Uint8Array.from(randomBytes(32)); const beforePrf = Uint8Array.from(prf);
  const aad = toBase64url(randomBytes(32));
  const capture = (data: ArrayBuffer) => { const bytes = new Uint8Array(data); retained.push(bytes); return bytes; };
  const assertCleared = () => {
    assert(retained.length > 0);
    assert(retained.every(value => value.every(byte => byte === 0)), 'owned mutable secret bytes survived the operation');
    retained.length = 0;
    assert.deepEqual(prf, beforePrf, 'an envelope helper must not wipe caller-owned PRF bytes');
  };
  try {
    subtle.importKey = (async (...args: any[]) => {
      if (args[0] === 'raw' && args[2] === 'HKDF') capture(args[1]);
      if (failure === 'import') throw new Error('synthetic key import failure');
      return (original.importKey as any).apply(subtle, args);
    }) as typeof subtle.importKey;
    subtle.encrypt = async (algorithm, key, data) => {
      assert(data instanceof ArrayBuffer); capture(data);
      if (failure === 'encrypt') throw new Error('synthetic encryption failure');
      return original.encrypt.call(subtle, algorithm, key, data);
    };
    subtle.decrypt = async (algorithm, key, data) => {
      const result = failure === 'decode' ? Uint8Array.of(255).buffer
        : failure === 'round-trip' ? new Uint8Array(43).fill(33).buffer
          : await original.decrypt.call(subtle, algorithm, key, data);
      capture(result); return result;
    };
    const saved = await encryptParticipantSecretEnvelope(fixture.participantSecrets.alice, prf, aad);
    assertCleared();
    assert.equal(await decryptParticipantSecretEnvelope(saved, prf), fixture.participantSecrets.alice);
    assertCleared();
    for (const mode of ['import', 'encrypt', 'round-trip'] as const) {
      failure = mode;
      await assert.rejects(encryptParticipantSecretEnvelope(fixture.participantSecrets.alice, prf, aad));
      assertCleared();
    }
    failure = 'decode';
    await assert.rejects(decryptParticipantSecretEnvelope(saved, prf)); assertCleared();
    failure = 'encrypt';
    crypto.getRandomValues = ((value: any) => {
      const result = original.getRandomValues.call(crypto, value);
      if (value instanceof Uint8Array && value.length === 32) retained.push(value);
      return result;
    }) as typeof crypto.getRandomValues;
    await assert.rejects(createParticipantSecretEnvelope(prf, aad)); assertCleared();
  } finally {
    subtle.importKey = original.importKey; subtle.encrypt = original.encrypt; subtle.decrypt = original.decrypt;
    crypto.getRandomValues = original.getRandomValues; prf.fill(0); beforePrf.fill(0);
    for (const bytes of retained) bytes.fill(0);
  }
});

offlineSecret.fill(0);
console.log(JSON.stringify({ title: 'presigned-v2 portable custody and provider-free unlock acceptance',
  network: fixture.roster.network, passed: true, externalProviderContacted: false,
  realPasskeyEvidence: false, liveBitcoinEvidence: false, checks }, null, 2));

function mutateBase64url(value: string): string {
  const decoded = Buffer.from(value, 'base64url');
  decoded[0] = decoded[0]! ^ 1;
  return decoded.toString('base64url');
}

async function unlockFixture(id: ParticipantId) {
  const credentialId = toBase64url(randomBytes(24));
  const prfSeed = randomBytes(32);
  const userId = randomUUID();
  const expectedParticipant = fixture.roster.participants.find(entry => entry.id === id)!;
  const aad = toBase64url(Buffer.from(JSON.stringify({ purpose: 'btc-multiplayer-vault-participant-secret',
    version: 1, userId, credentialId, vaultId: fixture.roster.vaultId, participantId: id })));
  const participantEnvelope = await encryptParticipantSecretEnvelope(fixture.participantSecrets[id], prfSeed, aad);
  const authorization = { challengeId: randomUUID(), participantId: id as string,
    expectedIdentity: { personalPublicKeyHex: expectedParticipant.personalPublicKeyHex,
      payoutXonlyPublicKeyHex: expectedParticipant.payoutXonlyPublicKeyHex },
    options: { challenge: toBase64url(randomBytes(32)), rpId: 'localhost', userVerification: 'required',
      allowCredentials: [{ id: credentialId, type: 'public-key' }],
      extensions: { prf: { evalByCredential: { [credentialId]: { first: toBase64url(randomBytes(32)) } } } } },
  };
  const requests: Array<{ path: string; body: unknown }> = [];
  let assertionCount = 0;
  let lastPrf: Uint8Array | undefined;
  const dependencies: PresignedUnlockDependencies = {
    postJson: async (path, body) => {
      requests.push({ path, body: structuredClone(body) });
      if (path === '/api/passkeys/unlock/options') return authorization;
      if (path === '/api/passkeys/unlock/finish') return { envelope: participantEnvelope };
      throw new Error('unexpected provider or network endpoint');
    },
    assertWithPrf: async () => {
      assertionCount += 1;
      lastPrf = Uint8Array.from(prfSeed);
      return { response: { id: credentialId,
        clientExtensionResults: { prf: { results: { first: 'PRF_SECRET_SENTINEL' } } } }, prfOutput: lastPrf };
    },
  };
  return { input: { credentialId, expectedVaultId: fixture.roster.vaultId, expectedParticipant },
    authorization, dependencies, requests, assertions: () => assertionCount, lastPrf: () => lastPrf };
}
