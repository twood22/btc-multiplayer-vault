/** Native pg_dump/pg_restore and real encrypted keys. Synthetic coins/PRF transport, no network spending. */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as bitcoin from 'bitcoinjs-lib';
import postgres from 'postgres';
import { databaseEndpointFingerprint } from '../../src/database-restore-receipt.js';
import { encryptPresignedOfflineBackup, presignedBackupBinding, serializePresignedOfflineBackup,
  verifyPresignedKitRestoration, verifyPresignedOfflineBackupRestoration } from '../../src/presigned/backup.js';
import { newPresignedCeremony, type PresignedFundingEpoch } from '../../src/presigned/ceremony.js';
import { createPresignedFixture, preauthorizePresignedFixture, signPresignedFixtureFunding } from '../../src/presigned/fixtures.js';
import { assertPresignedFundingRestoreBinding, createPresignedFundingRestoreReceipt,
  validatePresignedFundingRestoreReceipt } from '../../src/presigned/restore.js';
import { PARTICIPANT_IDS, PRESIGNED_PROTOCOL, type ParticipantId, type PresignedPublicKit } from '../../src/presigned/types.js';
import { commitmentDigest } from '../../src/presigned/validation.js';
import { decryptParticipantSecretEnvelope, encryptParticipantSecretEnvelope, type KeyEnvelope } from '../lib/client/key-envelope.js';
import { EXPECTED_MIGRATION_FILES } from '../lib/migrations.js';
import { capturePresignedFundingRestoreBinding, readPresignedFundingRestoreBinding, verifyPresignedFundingDatabaseRestore } from '../lib/presigned-funding-restore.js';

process.umask(0o077);
assert(process.env.DATABASE_URL, 'disposable restore acceptance URL required');
const sourceUrl = process.env.DATABASE_URL; const parsed = new URL(sourceUrl);
assert(['127.0.0.1', 'localhost'].includes(parsed.hostname) && /acceptance/u.test(parsed.pathname) && !parsed.password, 'only a disposable no-password loopback database is allowed');
const directory = mkdtempSync('/tmp/btc-presigned-restore.');
const binaryDirectory = process.env.POSTGRES_BIN ?? '/home/codex/.cache/btc-multiplayer-vault/postgresql-16.14/usr/lib/postgresql/16/bin';
assert(existsSync(`${binaryDirectory}/pg_dump`) && existsSync(`${binaryDirectory}/pg_restore`));
const source = postgres(sourceUrl, { max: 1, onnotice: () => {} });
const restoredName = `presigned_restore_${randomBytes(6).toString('hex')}`;
const restoredUrl = new URL(sourceUrl); restoredUrl.pathname = `/${restoredName}`;
let restored: ReturnType<typeof postgres> | null = null;
const prfs = new Map<string, Uint8Array>(); const owners = new Map<string, ParticipantId>();
const checks: string[] = []; let restoredKeys = 0; let negatives = 0;
const fixture = createPresignedFixture(); const graph = fixture.graph; const vaultId = graph.roster.vaultId; const epochId = graph.funding.epochId;
const kit: PresignedPublicKit = { version: 2, protocol: PRESIGNED_PROTOCOL, graph, preauthorizations: preauthorizePresignedFixture(fixture) };
const funding = signPresignedFixtureFunding(fixture); const fundingTx = bitcoin.Transaction.fromHex(funding.transactionHex);
const epoch: PresignedFundingEpoch = { epochId, status: 'approved', inputs: graph.funding.inputs, graph,
  preauthorizations: kit.preauthorizations, backups: [], walletSigningStarted: [...PARTICIPANT_IDS],
  signatures: PARTICIPANT_IDS.map((id, index) => ({ version: 2, protocol: PRESIGNED_PROTOCOL, graphDigest: graph.digest,
    participantId: id, inputIndex: index, witness: fundingTx.ins[index]!.witness.map(item => Buffer.from(item).toString('hex')) })),
  finalization: funding, fundingApprovals: [...PARTICIPANT_IDS], restartApprovals: [] };
async function native(binary: string, args: string[]) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(`${binaryDirectory}/${binary}`, args, { stdio: 'ignore' });
    child.once('error', () => reject(new Error('native PostgreSQL backup/restore process failed')));
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('native PostgreSQL backup/restore exited unsuccessfully')));
  });
}
try {
  for (const file of EXPECTED_MIGRATION_FILES) await source.unsafe(readFileSync(resolve('db/migrations', file), 'utf8'));
  await assert.rejects(() => capturePresignedFundingRestoreBinding(source, vaultId, epochId), /exact V2 ceremony/u); negatives++;
  await source`INSERT INTO vaults(id,name,protocol) VALUES (${vaultId},'Disposable restored V2 funding',${PRESIGNED_PROTOCOL})`;
  for (const id of PARTICIPANT_IDS) {
    const userId = randomUUID(); const identity = graph.roster.participants.find(item => item.id === id)!;
    await source`INSERT INTO users(id,display_name) VALUES (${userId},${`Synthetic ${id}`})`;
    await source`INSERT INTO vault_members(vault_id,user_id,participant_id) VALUES (${vaultId},${userId},${id})`;
    await source`INSERT INTO participant_key_material(user_id,vault_id,participant_id,personal_public_key,payout_xonly_public_key)
      VALUES (${userId},${vaultId},${id},${Buffer.from(identity.personalPublicKeyHex,'hex')},${Buffer.from(identity.payoutXonlyPublicKeyHex,'hex')})`;
    let primary = '';
    for (let index = 0; index < 2; index++) {
      const credential = `restore-acceptance-${randomUUID()}`; if (index === 0) primary = credential;
      const prf = Uint8Array.from(randomBytes(32)); prfs.set(credential, prf); owners.set(credential, id);
      const envelope = await encryptParticipantSecretEnvelope(fixture.participantSecrets[id], prf, randomBytes(32).toString('base64url'));
      const decrypted = await decryptParticipantSecretEnvelope(envelope, prf);
      const proof = verifyPresignedKitRestoration({ publicKit: kit, participantId: id, participantSecret: decrypted, expectedBinding: presignedBackupBinding(kit, id) });
      epoch.backups.push({ participantId: id, backupKind: 'passkey', restoreCredentialId: credential, approvedCredentialId: credential,
        backupFileDigest: null, proof });
      await source`INSERT INTO webauthn_credentials(credential_id,user_id,public_key,counter,device_type,backed_up,prf_enabled,credential_name)
        VALUES (${credential},${userId},${randomBytes(64)},0,'multiDevice',true,true,'Synthetic encrypted PRF key')`;
      await source`INSERT INTO passkey_envelopes(credential_id,version,prf_salt,iv,ciphertext,aad)
        VALUES (${credential},1,${randomBytes(32)},${Buffer.from(envelope.iv,'base64url')},${Buffer.from(envelope.ciphertext,'base64url')},${Buffer.from(envelope.aad,'base64url')})`;
    }
    const offlineSecret = Uint8Array.from(randomBytes(32));
    try {
      const envelope = await encryptPresignedOfflineBackup({ publicKit: kit, participantId: id, participantSecret: fixture.participantSecrets[id], offlineSecret });
      const serialized = serializePresignedOfflineBackup(envelope);
      writeFileSync(`${directory}/${id}-offline.encrypted.json`, serialized, { mode: 0o600, flag: 'wx' });
      const proof = await verifyPresignedOfflineBackupRestoration({ envelope: JSON.parse(readFileSync(`${directory}/${id}-offline.encrypted.json`, 'utf8')),
        offlineSecret, expectedBinding: presignedBackupBinding(kit, id) });
      epoch.backups.push({ participantId: id, backupKind: 'offline', restoreCredentialId: null, approvedCredentialId: primary,
        backupFileDigest: createHash('sha256').update(serialized).digest('hex'), proof });
    } finally { offlineSecret.fill(0); }
  }
  const state = newPresignedCeremony(vaultId, { network: graph.roster.network, genesisHash: graph.roster.genesisHash,
    economics: graph.roster.economics, feePolicy: graph.roster.feePolicy, fundingFeeSats: graph.funding.feeSats });
  Object.assign(state, { identities: graph.roster.participants, roster: graph.roster, rosterDigest: graph.rosterDigest,
    rosterApprovals: [...PARTICIPANT_IDS], epochs: [epoch] });
  await source`INSERT INTO presigned_ceremonies(vault_id,settings_json,settings_digest,state_json,state_digest)
    VALUES (${vaultId},${source.json(state.settings as never)},${Buffer.from(state.settingsDigest,'hex')},${source.json(state as never)},
      ${Buffer.from(commitmentDigest('vault/presigned-graph-v2/ceremony/state',state),'hex')})`;
  await source`INSERT INTO presigned_funding_epochs(epoch_id,vault_id,ordinal,status,graph_digest,funding_txid,snapshot_json,snapshot_digest)
    VALUES (${epochId},${vaultId},1,'approved',${Buffer.from(graph.digest,'hex')},${Buffer.from(graph.fundingTxid,'hex')},${source.json(epoch as never)},
      ${Buffer.from(commitmentDigest('vault/presigned-graph-v2/ceremony/epoch',epoch),'hex')})`;
  const original = await capturePresignedFundingRestoreBinding(source, vaultId, epochId);
  await native('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', `--file=${directory}/database.dump`, `--dbname=${sourceUrl}`]);
  await source.unsafe(`CREATE DATABASE "${restoredName}" TEMPLATE template0`);
  await native('pg_restore', ['--exit-on-error', '--no-owner', '--no-privileges', `--dbname=${restoredUrl}`, `${directory}/database.dump`]);
  restored = postgres(restoredUrl.toString(), { max: 1, onnotice: () => {} });
  const receipt = await verifyPresignedFundingDatabaseRestore({ source, restored, vaultId, epochId,
    sourceEndpointFingerprint: databaseEndpointFingerprint(sourceUrl), restoredEndpointFingerprint: databaseEndpointFingerprint(restoredUrl.toString()) });
  assert.deepEqual(receipt.sourceFunding, original); assert.deepEqual(receipt.restoredFunding, original);
  checks.push('native pg_dump/pg_restore reproduces the exact complete database and approved V2 funding/custody state');
  const expected = { reviewedReceiptDigest: receipt.receiptDigest, databaseRestoreReceiptDigest: receipt.databaseRestore.receiptDigest,
    sourceEndpointFingerprint: receipt.databaseRestore.sourceEndpointFingerprint,
    sourceDatabaseIdentityFingerprint: receipt.databaseRestore.sourceDatabaseIdentityFingerprint, currentFunding: original, now: Date.parse(receipt.createdAt) };
  assertPresignedFundingRestoreBinding(receipt, expected);
  const restoredEnvelopes = await restored<Array<{ credential_id: string; version: 1; iv: Buffer; ciphertext: Buffer; aad: Buffer }>>`SELECT credential_id,version,iv,ciphertext,aad FROM passkey_envelopes`;
  for (const row of restoredEnvelopes) {
    const id = owners.get(row.credential_id)!; const prf = prfs.get(row.credential_id)!;
    const envelope: KeyEnvelope = { version: row.version, iv: row.iv.toString('base64url'), ciphertext: row.ciphertext.toString('base64url'), aad: row.aad.toString('base64url') };
    const participantSecret = await decryptParticipantSecretEnvelope(envelope, prf);
    const proof = verifyPresignedKitRestoration({ publicKit: kit, participantId: id, participantSecret, expectedBinding: presignedBackupBinding(kit, id) });
    assert.equal(proof.exitProofs.length, 3); restoredKeys++;
  }
  assert.equal(restoredKeys, 6); checks.push('all six restored encrypted passkey envelopes decrypt and complete every owner exit with RAM-only synthetic PRF outputs');
  for (const field of ['graphDigest', 'fundingTxid', 'finalizationDigest', 'ceremonyStateDigest', 'retainedEpochsDigest', 'custodyMaterialDigest'] as const) {
    assert.throws(() => assertPresignedFundingRestoreBinding(receipt, { ...expected, currentFunding: { ...original, [field]: 'aa'.repeat(32) } })); negatives++;
    assert.throws(() => createPresignedFundingRestoreReceipt({ createdAt: receipt.createdAt, databaseRestore: receipt.databaseRestore,
      sourceFunding: original, restoredFunding: { ...original, [field]: 'bb'.repeat(32) } })); negatives++;
  }
  for (const field of ['reviewedReceiptDigest', 'databaseRestoreReceiptDigest', 'sourceEndpointFingerprint', 'sourceDatabaseIdentityFingerprint'] as const) {
    assert.throws(() => assertPresignedFundingRestoreBinding(receipt, { ...expected, [field]: 'cc'.repeat(32) })); negatives++;
  }
  for (const now of [Date.parse(receipt.createdAt) - 1, Date.parse(receipt.createdAt) + 24 * 60 * 60_000 + 1]) {
    assert.throws(() => assertPresignedFundingRestoreBinding(receipt, { ...expected, now })); negatives++;
  }
  assert.throws(() => validatePresignedFundingRestoreReceipt({ ...receipt, fundingAllowed: true })); negatives++;
  const credential = restoredEnvelopes[0]!.credential_id;
  await source`UPDATE webauthn_credentials SET counter=counter+1,last_used_at=now() WHERE credential_id=${credential}`;
  assert.deepEqual(await capturePresignedFundingRestoreBinding(source, vaultId, epochId), original);
  checks.push('ordinary post-drill authentication counters do not invalidate unchanged restored key material');
  const rollback = new Error('rollback isolated negative fixture');
  await assert.rejects(source.begin(async tx => {
    await tx`UPDATE passkey_envelopes SET ciphertext=${randomBytes(64)} WHERE credential_id=${credential}`;
    const changed = await readPresignedFundingRestoreBinding(tx, vaultId, epochId);
    assert.throws(() => assertPresignedFundingRestoreBinding(receipt, { ...expected, currentFunding: changed })); negatives++;
    throw rollback;
  }), error => error === rollback);
  await assert.rejects(restored.begin(async tx => {
    await tx`DELETE FROM presigned_funding_epochs WHERE vault_id=${vaultId}::uuid AND epoch_id=${epochId}::uuid`;
    await assert.rejects(() => readPresignedFundingRestoreBinding(tx, vaultId, epochId), /lost a retained/u); negatives++;
    throw rollback;
  }), error => error === rollback);
  assert.deepEqual(await capturePresignedFundingRestoreBinding(restored, vaultId, epochId), original);
  checks.push('changed custody and missing retained funding state are rejected; negative mutations roll back');
  writeFileSync(`${directory}/acceptance.json`, JSON.stringify({ passed: true, protocol: PRESIGNED_PROTOCOL,
    nativeDatabaseDumpAndRestore: true, restoredEncryptedKeys: restoredKeys, negativeBoundaries: negatives,
    syntheticFundingCoins: true, realDefaultSignetVerified: false, physicalPasskeysProven: false, fundingAuthorized: false,
    checks }, null, 2), { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ passed: true, evidence: directory, restoredEncryptedKeys: restoredKeys, negativeBoundaries: negatives, checks }));
} finally {
  for (const prf of prfs.values()) prf.fill(0);
  await restored?.end({ timeout: 5 });
  await source.unsafe(`DROP DATABASE IF EXISTS "${restoredName}" WITH (FORCE)`);
  await source.end({ timeout: 5 });
}
