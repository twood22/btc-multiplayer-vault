import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import postgres from 'postgres';
import { BITCOIN_NETWORK_NAME } from '../../src/network.js';
import { presignedBackupBinding, verifyPresignedKitRestoration, type PresignedRestorationProof } from '../../src/presigned/backup.js';
import { newPresignedCeremony, validatePresignedAction, type PresignedAction, type PresignedCeremonySettings,
  type PresignedFundingInputVerifier } from '../../src/presigned/ceremony.js';
import { createPresignedFixture } from '../../src/presigned/fixtures.js';
import { authorizePresignedFundingSignedPsbt, type PresignedFundingSignature } from '../../src/presigned/funding.js';
import { derivePresignedParticipantKeys } from '../../src/presigned/roster.js';
import { createPreauthorizations } from '../../src/presigned/signing.js';
import { PARTICIPANT_IDS, PRESIGNED_PROTOCOL, type ParticipantId, type PresignedGraph, type PresignedPublicKit } from '../../src/presigned/types.js';
import { commitmentDigest } from '../../src/presigned/validation.js';
import { EXPECTED_MIGRATION_FILES } from '../lib/migrations.js';
import { closeDatabase } from '../lib/server/db.js';
import { completePresignedAction, createPresignedActionChallenge, getPresignedActionChallenge,
  getPresignedCeremonyStatus, initializePresignedCeremony, type PresignedActionChallenge,
  type PresignedActionDependencies } from '../lib/server/presigned-store.js';

// Disposable loopback PostgreSQL only. Credential rows/envelopes and private-chain
// observations are synthetic prerequisites, NOT hardware/WebAuthn/Core evidence.
// Preauthorizations, local owner-exit reconstruction and wallet signatures are real cryptographic checks.
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const database = new URL(process.env.DATABASE_URL);
assert(['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname) && /(?:test|acceptance)/u.test(database.pathname),
  'run only against an explicitly named disposable loopback test/acceptance database');
// Migrations carry explicit BEGIN/COMMIT; keep their connection pinned. Store operations use a separate pool.
const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
const vaultId = randomUUID();
const legacyVaultId = randomUUID();
const users = Object.fromEntries(PARTICIPANT_IDS.map(id => [id, randomUUID()])) as Record<ParticipantId, string>;
const credentials = Object.fromEntries(PARTICIPANT_IDS.map(id => [id, [0, 1].map(() => `presigned-acceptance-${randomUUID()}`)])) as Record<ParticipantId, string[]>;
const fixture = createPresignedFixture({ network: BITCOIN_NETWORK_NAME, walletKinds: ['p2wpkh', 'p2wpkh', 'p2wpkh'] });
const secrets = Object.fromEntries(PARTICIPANT_IDS.map(id => [id, randomBytes(32).toString('base64url')])) as Record<ParticipantId, string>;
const derived = Object.fromEntries(PARTICIPANT_IDS.map(id => [id, derivePresignedParticipantKeys(secrets[id], id, vaultId)])) as Record<ParticipantId, ReturnType<typeof derivePresignedParticipantKeys>>;
const settings: PresignedCeremonySettings = { network: fixture.roster.network, genesisHash: fixture.roster.genesisHash,
  economics: fixture.roster.economics, feePolicy: fixture.roster.feePolicy, fundingFeeSats: fixture.graph.funding.feeSats };
const b = (value: string) => Buffer.from(value, 'hex');
const stateDomain = 'vault/presigned-graph-v2/ceremony/state';
const results: string[] = [];
const delayTrigger = `presigned_begin_delay_${vaultId.replace(/-/gu, '')}`;
let observationCalls = 0;
const observe: PresignedFundingInputVerifier = async ({ network, genesisHash, input }) => {
  observationCalls++;
  return { network, genesisHash, txid: input.txid, vout: input.vout, valueSats: input.valueSats,
    scriptPubKeyHex: input.scriptPubKeyHex, confirmationBlockHash: input.confirmationBlockHash,
    confirmations: input.confirmations + 1, unspent: true };
};
function action(body: Record<string, unknown>): PresignedAction {
  return validatePresignedAction({ version: 2, protocol: PRESIGNED_PROTOCOL, ...body });
}
function options(id: ParticipantId, candidate: PresignedAction, credentialIndex = 0,
  dependencies: PresignedActionDependencies = { verifyFundingInput: observe }) {
  return createPresignedActionChallenge({ userId: users[id], credentialId: credentials[id][credentialIndex]!,
    challenge: randomBytes(32).toString('base64url'), action: candidate }, dependencies);
}
async function finish(challenge: PresignedActionChallenge, dependencies: PresignedActionDependencies = { verifyFundingInput: observe }) {
  return completePresignedAction(challenge, challenge.credential.counter + 1, dependencies);
}
async function perform(id: ParticipantId, candidate: PresignedAction, credentialIndex = 0) {
  return finish(await options(id, candidate, credentialIndex));
}
const status = () => getPresignedCeremonyStatus(users.alice);
async function insertEnvelope(credentialId: string) {
  await sql`INSERT INTO passkey_envelopes (credential_id,version,prf_salt,iv,ciphertext,aad)
    VALUES (${credentialId},1,${randomBytes(32)},${randomBytes(12)},${randomBytes(64)},${randomBytes(32)})`;
}
async function unchangedAfterFailure(challenge: PresignedActionChallenge, operation: () => Promise<unknown>, pattern: RegExp) {
  const before = await sql`SELECT state_digest FROM presigned_ceremonies WHERE vault_id=${vaultId}`;
  await assert.rejects(operation, pattern);
  const after = await sql`SELECT state_digest FROM presigned_ceremonies WHERE vault_id=${vaultId}`;
  assert.deepEqual(before, after);
  const pending = await getPresignedActionChallenge({ userId: challenge.credential.userId, challengeId: challenge.id });
  assert.equal(pending.credential.counter, challenge.credential.counter);
}
function walletSignature(graph: PresignedGraph, id: ParticipantId): PresignedFundingSignature {
  const wallet = fixture.walletKeys[id];
  const index = graph.funding.inputs.findIndex(input => input.participantId === id);
  const psbt = bitcoin.Psbt.fromBase64(graph.fundingPsbtBase64);
  psbt.signInput(index, { publicKey: wallet.publicKey, sign: hash => ecc.sign(hash, wallet.privateKey) });
  return authorizePresignedFundingSignedPsbt({ graph, participantId: id, signedPsbtBase64: psbt.toBase64(), approvedGraphDigest: graph.digest });
}
function fundingAction(graph: PresignedGraph, id: ParticipantId): PresignedAction {
  return action({ kind: 'submit-funding-signature', epochId: graph.funding.epochId, graphDigest: graph.digest,
    signature: walletSignature(graph, id) });
}
function beginAction(graph: PresignedGraph): PresignedAction {
  return action({ kind: 'begin-wallet-signing', epochId: graph.funding.epochId, graphDigest: graph.digest });
}
function restoreProof(graph: PresignedGraph, preauthorizations: PresignedPublicKit['preauthorizations'], id: ParticipantId) {
  const publicKit: PresignedPublicKit = { version: 2, protocol: PRESIGNED_PROTOCOL, graph, preauthorizations };
  return verifyPresignedKitRestoration({ publicKit, participantId: id, participantSecret: secrets[id],
    expectedBinding: presignedBackupBinding(publicKit, id) });
}
function backupAction(graph: PresignedGraph, id: ParticipantId, proof: PresignedRestorationProof, kind: 'offline' | 'passkey', credentialIndex = 0) {
  return action({ kind: 'confirm-backup', epochId: graph.funding.epochId, graphDigest: graph.digest, backupKind: kind,
    restoreCredentialId: kind === 'passkey' ? credentials[id][credentialIndex] : null,
    backupFileDigest: kind === 'offline' ? commitmentDigest('public-synthetic-backup-file', { graphDigest: graph.digest, id }) : null, proof });
}
async function freezeInputs() {
  let current = await status();
  for (const input of fixture.graph.funding.inputs) {
    current = await perform(input.participantId, action({ kind: 'commit-funding-input', epochId: current.epoch!.epochId,
      rosterDigest: current.rosterDigest, input }));
  }
  assert.equal(current.phase, 'preauthorizations');
  assert(current.epoch?.graph);
  assert.equal(current.fundingPsbtBase64, null);
  return current.epoch.graph;
}
async function allPreauthorizations(graph: PresignedGraph) {
  const contributions = PARTICIPANT_IDS.map(id => ({ id, entries: createPreauthorizations({ graph, participantId: id,
    privateKeys: derived[id].keys.soloPrivateKeys, approvedGraphDigest: graph.digest }) }));
  const challenges = await Promise.all(contributions.map(({ id, entries }) => options(id,
    action({ kind: 'contribute-preauthorizations', epochId: graph.funding.epochId, graphDigest: graph.digest, preauthorizations: entries }))));
  await Promise.all(challenges.map(challenge => finish(challenge)));
  const current = await status();
  assert.equal(current.epoch!.preauthorizations.length, 12);
  assert.equal(current.walletSigningReady, false);
  return current.epoch!.preauthorizations;
}
async function allBackups(graph: PresignedGraph, entries: PresignedPublicKit['preauthorizations']) {
  for (const id of PARTICIPANT_IDS) {
    const proof = restoreProof(graph, entries, id);
    await perform(id, backupAction(graph, id, proof, 'offline'));
    await perform(id, backupAction(graph, id, proof, 'passkey', 0), 0);
    await perform(id, backupAction(graph, id, proof, 'passkey', 1), 1);
  }
  assert.equal((await status()).walletSigningReady, true);
  assert.equal((await status()).fundingPsbtReleased, false);
  assert.equal((await status()).fundingPsbtBase64, null);
}

try {
  const actualFiles = readdirSync(resolve('db/migrations')).filter(file => /^\d{3}_[a-z0-9_]+\.sql$/u.test(file)).sort();
  assert.deepEqual(actualFiles, EXPECTED_MIGRATION_FILES);
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  for (const file of EXPECTED_MIGRATION_FILES.filter(file => file < '015_presigned_protocol.sql')) {
    if (!(await sql`SELECT 1 FROM schema_migrations WHERE version=${file.slice(0, -4)}`).length)
      await sql.unsafe(readFileSync(resolve('db/migrations', file), 'utf8'));
  }
  const pendingMigration = !(await sql`SELECT 1 FROM schema_migrations WHERE version='015_presigned_protocol'`).length;
  await sql`INSERT INTO vaults(id,name,status) VALUES (${legacyVaultId},'Synthetic retained V1 vault','active')`;
  const legacyArtifact = { version: 1, network: BITCOIN_NETWORK_NAME, marker: 'unchanged synthetic legacy artifact' };
  await sql`INSERT INTO vault_rosters(vault_id,version,network,artifact_json,digest,funding_address,status)
    VALUES (${legacyVaultId},1,${BITCOIN_NETWORK_NAME},${sql.json(legacyArtifact)},${randomBytes(32)},
      ${BITCOIN_NETWORK_NAME === 'signet' ? 'tb1psynthetic' : 'bc1psynthetic'},'confirmed')`;
  const legacyBefore = await sql`SELECT artifact_json,digest,funding_address,status FROM vault_rosters WHERE vault_id=${legacyVaultId}`;
  if (pendingMigration) await sql.unsafe(readFileSync(resolve('db/migrations/015_presigned_protocol.sql'), 'utf8'));
  for (const file of EXPECTED_MIGRATION_FILES.filter(file => file > '015_presigned_protocol.sql')) {
    if (!(await sql`SELECT 1 FROM schema_migrations WHERE version=${file.slice(0, -4)}`).length)
      await sql.unsafe(readFileSync(resolve('db/migrations', file), 'utf8'));
  }
  assert.equal((await sql`SELECT protocol FROM vaults WHERE id=${legacyVaultId}`)[0]!.protocol, 'sigbash-v1');
  assert.deepEqual(await sql`SELECT artifact_json,digest,funding_address,status FROM vault_rosters WHERE vault_id=${legacyVaultId}`, legacyBefore);
  await assert.rejects(() => sql`UPDATE vaults SET protocol=${PRESIGNED_PROTOCOL} WHERE id=${legacyVaultId}`, /immutable/);
  await assert.rejects(() => initializePresignedCeremony({ vaultId: legacyVaultId, settings }), /explicitly created V2/);
  const illegalLegacyState = newPresignedCeremony(legacyVaultId, settings);
  await assert.rejects(() => sql`INSERT INTO presigned_ceremonies(vault_id,settings_json,settings_digest,state_json,state_digest)
    VALUES (${legacyVaultId},${sql.json(settings as never)},${b(illegalLegacyState.settingsDigest)},
      ${sql.json(illegalLegacyState as never)},${b(commitmentDigest(stateDomain, illegalLegacyState))})`, /foreign key/);
  results.push(pendingMigration ? 'migration backfills V1 without rewriting retained artifacts; protocol and composite parent FK enforced' :
    'already-migrated default preserves V1 artifacts; protocol and composite parent FK enforced');

  await sql`INSERT INTO vaults(id,name,protocol) VALUES (${vaultId},'Synthetic V2 ceremony',${PRESIGNED_PROTOCOL})`;
  for (const id of PARTICIPANT_IDS) {
    await sql`INSERT INTO users(id,display_name) VALUES (${users[id]},${`Synthetic ${id}`})`;
    await sql`INSERT INTO vault_members(vault_id,user_id,participant_id) VALUES (${vaultId},${users[id]},${id})`;
    await sql`INSERT INTO participant_key_material(user_id,vault_id,participant_id,personal_public_key,payout_xonly_public_key)
      VALUES (${users[id]},${vaultId},${id},${b(derived[id].publicIdentity.personalPublicKeyHex)},${b(derived[id].publicIdentity.payoutXonlyPublicKeyHex)})`;
    for (const [index, credentialId] of credentials[id].entries()) {
      await sql`INSERT INTO webauthn_credentials(credential_id,user_id,public_key,counter,device_type,backed_up,prf_enabled,credential_name)
        VALUES (${credentialId},${users[id]},${randomBytes(64)},0,'multiDevice',true,true,${`Synthetic passkey ${index + 1}`})`;
      await insertEnvelope(credentialId);
    }
  }
  await initializePresignedCeremony({ vaultId, settings });
  await initializePresignedCeremony({ vaultId, settings });
  await assert.rejects(() => initializePresignedCeremony({ vaultId, settings: { ...settings, fundingFeeSats: 601 } }), /immutable settings/);
  await assert.rejects(() => sql`UPDATE presigned_ceremonies SET settings_digest=${randomBytes(32)} WHERE vault_id=${vaultId}`, /immutable/);
  let current = await status();
  const registration = action({ kind: 'register-identity', settingsDigest: current.settingsDigest, identity: derived.alice.publicIdentity });
  assert.throws(() => validatePresignedAction({ ...registration, participantSecret: 'never allowed' }), /unexpected or missing/);
  assert.throws(() => validatePresignedAction({ ...registration, identity: { ...derived.alice.publicIdentity, privateKey: 'never allowed' } }), /unexpected or missing/);
  await assert.rejects(() => options('alice', action({ kind: 'register-identity', settingsDigest: current.settingsDigest,
    identity: { ...derived.alice.publicIdentity, payoutXonlyPublicKeyHex: derived.bob.publicIdentity.payoutXonlyPublicKeyHex } })), /existing passkey-held public identity/);
  await sql`DELETE FROM passkey_envelopes WHERE credential_id=${credentials.alice[1]!}`;
  await assert.rejects(() => options('alice', registration), /two stored PRF envelopes/);
  await insertEnvelope(credentials.alice[1]!);
  const superseded = await options('alice', registration);
  const replacement = await options('alice', registration);
  await assert.rejects(() => finish(superseded), /superseded/);
  await unchangedAfterFailure(replacement, () => completePresignedAction({ ...replacement, actionDigest: '11'.repeat(32) }, 1), /changed/);
  await sql`UPDATE webauthn_credentials SET counter=1 WHERE credential_id=${credentials.alice[0]!}`;
  await assert.rejects(() => finish(replacement), /counter changed/);
  await sql`UPDATE webauthn_credentials SET counter=0 WHERE credential_id=${credentials.alice[0]!}`;
  await finish(replacement);
  await assert.rejects(() => finish(replacement), /used|superseded/);
  for (const id of ['bob', 'carol'] as const) {
    const pending = await options(id, action({ kind: 'register-identity', settingsDigest: current.settingsDigest, identity: derived[id].publicIdentity }));
    if (id === 'bob') {
      await sql`UPDATE presigned_action_challenges SET expires_at=now()-interval '1 second' WHERE id=${pending.id}`;
      await assert.rejects(() => finish(pending), /expired/);
      await perform(id, pending.action);
    } else await finish(pending);
  }
  current = await status();
  assert.equal(current.phase, 'roster-confirmation');
  await assert.rejects(() => options('alice', action({ kind: 'commit-funding-input', epochId: randomUUID(), rosterDigest: current.rosterDigest,
    input: fixture.graph.funding.inputs[0] })), /unanimous/);
  await Promise.all(PARTICIPANT_IDS.map(async id => perform(id, action({ kind: 'confirm-roster', rosterDigest: current.rosterDigest }))));
  results.push('identity/settings binding, two stored envelopes, unknown-secret rejection, supersession, expiry, payload binding and counter CAS');

  current = await status();
  const inputAction = action({ kind: 'commit-funding-input', epochId: current.epoch!.epochId, rosterDigest: current.rosterDigest,
    input: fixture.graph.funding.inputs[0] });
  await assert.rejects(() => options('alice', inputAction, 0, {}), /private-chain input verifier is required/);
  await assert.rejects(() => options('alice', inputAction, 0, { verifyFundingInput: async request => ({ ...await observe(request), valueSats: 1 }) }), /differs from funding/);
  assert(inputAction.kind === 'commit-funding-input');
  await assert.rejects(() => options('alice', action({ ...inputAction, input: { ...inputAction.input, valueSats: 1 } })), /cover (?:the )?deposit/);
  await assert.rejects(() => options('alice', action({ ...inputAction, input: { ...inputAction.input, valueSats: 10_201 } })), /dust/);
  const inputChallenge = await options('alice', inputAction);
  await unchangedAfterFailure(inputChallenge, () => finish(inputChallenge, {}), /private-chain input verifier is required/);
  await unchangedAfterFailure(inputChallenge, () => finish(inputChallenge, { verifyFundingInput: async request => ({ ...await observe(request),
    confirmationBlockHash: '22'.repeat(32) }) }), /differs from funding/);
  await unchangedAfterFailure(inputChallenge, () => completePresignedAction(inputChallenge, inputChallenge.credential.counter), /counter must advance/);
  await finish(inputChallenge);
  for (const input of fixture.graph.funding.inputs.slice(1)) await perform(input.participantId,
    action({ kind: 'commit-funding-input', epochId: current.epoch!.epochId, rosterDigest: current.rosterDigest, input }));
  current = await status();
  const firstGraph = current.epoch!.graph!;
  assert.equal(current.phase, 'preauthorizations');
  assert.equal(current.fundingPsbtBase64, null);
  assert.equal(bitcoin.Transaction.fromHex(firstGraph.exits.find(exit => exit.id === 'alice/bob')!.unsignedTxHex).outs[1]!.value, 9350n);
  await assert.rejects(() => options('alice', fundingAction(firstGraph, 'alice')), /wallet signing requires/);
  await assert.rejects(() => options('alice', beginAction(firstGraph)), /wallet signing requires/);
  const entries = await allPreauthorizations(firstGraph);
  await assert.rejects(() => options('alice', fundingAction(firstGraph, 'alice')), /wallet signing requires/);
  const proof = restoreProof(firstGraph, entries, 'alice');
  const wrongProof = structuredClone(proof); wrongProof.binding.epochId = randomUUID();
  await assert.rejects(() => options('alice', backupAction(firstGraph, 'alice', wrongProof, 'offline')), /receipt binding/);
  const wrongExit = structuredClone(proof); wrongExit.exitProofs[0]!.txid = '77'.repeat(32);
  await assert.rejects(() => options('alice', backupAction(firstGraph, 'alice', wrongExit, 'offline')), /owner exits/);
  const wrongDigest = structuredClone(proof); wrongDigest.proofDigest = '77'.repeat(32);
  await assert.rejects(() => options('alice', backupAction(firstGraph, 'alice', wrongDigest, 'offline')), /receipt digest/);
  await assert.rejects(() => options('alice', backupAction(firstGraph, 'alice', proof, 'passkey', 1), 0), /exact restored credential/);
  await allBackups(firstGraph, entries);
  current = await status();
  assert.equal(current.epoch!.backups.length, 9);
  assert.equal(current.fundingPsbtBase64, null);
  await assert.rejects(() => options('alice', fundingAction(firstGraph, 'alice')), /approve begin-wallet-signing/);
  const pendingBegin = await options('alice', beginAction(firstGraph));
  assert.equal((await status()).participantWalletSigningStarted, false);
  assert.equal((await status()).fundingPsbtReleased, false);
  assert.equal((await status()).restartStateDigest, current.restartStateDigest);
  await assert.rejects(() => sql`UPDATE presigned_funding_epochs SET snapshot_json=jsonb_set(snapshot_json,'{backups}','[]')
    WHERE epoch_id=${firstGraph.funding.epochId}`, /restore receipts.*retained/);
  await assert.rejects(() => sql`UPDATE presigned_funding_epochs SET snapshot_json=jsonb_set(snapshot_json,'{preauthorizations}','[]')
    WHERE epoch_id=${firstGraph.funding.epochId}`, /preauthorizations.*retained/);
  results.push('unsigned input observations required and rechecked; early dust rejection; concurrent complete preauthorizations; exact three-exit/two-credential/offline restore gates');

  const restartDigest = current.restartStateDigest!;
  const restart = action({ kind: 'restart-funding', epochId: firstGraph.funding.epochId, stateDigest: restartDigest,
    reason: 'Replace this unsigned funding epoch for a synthetic recovery drill.' });
  await perform('alice', restart);
  await perform('bob', action({ ...restart, reason: 'A different exact restart reason must not combine with other approvals.' }));
  await perform('carol', restart);
  assert.equal((await status()).epoch!.epochId, firstGraph.funding.epochId);
  await perform('bob', restart);
  current = await status();
  assert.notEqual(current.epoch!.epochId, firstGraph.funding.epochId);
  assert.equal(current.epochHistory.length, 2);
  assert.equal(current.epochHistory[0]!.status, 'retired');
  await assert.rejects(() => finish(pendingBegin), /superseded|old or missing/);
  const retained = await sql`SELECT snapshot_json FROM presigned_funding_epochs WHERE epoch_id=${firstGraph.funding.epochId}`;
  assert.deepEqual(retained[0]!.snapshot_json.graph, firstGraph);
  assert.equal(retained[0]!.snapshot_json.preauthorizations.length, 12);
  assert.equal(retained[0]!.snapshot_json.backups.length, 9);
  await assert.rejects(() => sql`UPDATE presigned_funding_epochs SET snapshot_json=jsonb_set(snapshot_json,'{backups}','[]')
    WHERE epoch_id=${firstGraph.funding.epochId}`, /retained unchanged/);
  await assert.rejects(() => options('alice', fundingAction(firstGraph, 'alice')), /old or missing funding epoch/);
  const graph = await freezeInputs();
  assert.notEqual(graph.digest, firstGraph.digest);
  // Reusing the same unsigned inputs deliberately preserves txid while epoch binds all approvals and kits anew.
  assert.equal(graph.fundingTxid, firstGraph.fundingTxid);
  await assert.rejects(() => options('alice', action({ kind: 'contribute-preauthorizations', epochId: graph.funding.epochId,
    graphDigest: graph.digest, preauthorizations: entries.filter(entry => entry.participantId === 'alice') })), /graph/);
  const freshEntries = await allPreauthorizations(graph);
  await allBackups(graph, freshEntries);
  results.push('unanimous exact-state/reason restart preserves old graph, 12 preauthorizations and 9 receipts; old-epoch actions rejected');

  current = await status();
  const nextRestart = action({ kind: 'restart-funding', epochId: graph.funding.epochId,
    stateDigest: current.restartStateDigest, reason: 'This unanimous pending restart must fail if wallet signing begins.' });
  await perform('bob', nextRestart);
  await perform('carol', nextRestart);
  const staleRestart = await options('alice', nextRestart);
  const begin = await options('bob', beginAction(graph));
  assert.equal((await status()).epoch!.walletSigningStarted.length, 0);
  await sql`UPDATE webauthn_credentials SET prf_enabled=false WHERE credential_id=${credentials.carol[1]!}`;
  assert.equal((await status()).walletSigningReady, false);
  assert.equal((await status()).fundingPsbtBase64, null);
  await assert.rejects(() => options('alice', beginAction(graph)), /wallet signing requires/);
  await unchangedAfterFailure(begin, () => finish(begin), /wallet signing requires/);
  await sql`UPDATE webauthn_credentials SET prf_enabled=true WHERE credential_id=${credentials.carol[1]!}`;

  // Hold a successfully applied begin intent before commit, then let the third exact restart vote
  // contend on the same vault row. This exposes an actual concurrent transaction schedule.
  await sql.unsafe(`CREATE FUNCTION ${delayTrigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(1.5); RETURN NEW; END $$`);
  await sql.unsafe(`CREATE CONSTRAINT TRIGGER ${delayTrigger} AFTER INSERT ON presigned_action_events
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.vault_id = '${vaultId}'::uuid
      AND NEW.action_json->>'kind' = 'begin-wallet-signing') EXECUTE FUNCTION ${delayTrigger}()`);
  const beginning = finish(begin).then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
  let held = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    const active = await sql`SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event='PgSleep'`;
    if (active.length) { held = true; break; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(held, true, 'begin intent must hold the vault lock at the test-only commit barrier');
  const restarting = finish(staleRestart).then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
  const [begun, restarted] = await Promise.all([beginning, restarting]);
  assert.equal(begun.ok, true);
  assert.equal(restarted.ok, false);
  if (!restarted.ok) assert.match(String(restarted.error), /wallet signing has started/);
  await sql.unsafe(`DROP TRIGGER ${delayTrigger} ON presigned_action_events`);
  await sql.unsafe(`DROP FUNCTION ${delayTrigger}()`);
  current = await status();
  assert.deepEqual(current.epoch!.walletSigningStarted, ['bob']);
  assert.equal(current.epoch!.signatures.length, 0);
  assert.equal(current.restartStateDigest, null);
  assert.equal(current.fundingPsbtBase64, null, 'one participant intent cannot release another participant PSBT');
  const bobAfterInterruptedExport = await getPresignedCeremonyStatus(users.bob);
  assert.equal(bobAfterInterruptedExport.participantWalletSigningStarted, true);
  assert.equal(bobAfterInterruptedExport.fundingPsbtReleased, true);
  assert.equal(bobAfterInterruptedExport.fundingPsbtBase64, graph.fundingPsbtBase64);
  await unchangedAfterFailure(staleRestart, () => finish(staleRestart), /wallet signing has started/);
  await assert.rejects(() => options('carol', nextRestart), /wallet signing has started/);
  await assert.rejects(() => options('bob', beginAction(graph)), /already began/);
  await assert.rejects(() => finish(begin), /used|superseded/);
  await assert.rejects(() => sql`UPDATE presigned_funding_epochs SET snapshot_json=jsonb_set(snapshot_json,'{walletSigningStarted}','[]')
    WHERE epoch_id=${graph.funding.epochId}`, /intent cannot be removed/);
  await assert.rejects(() => sql`UPDATE presigned_funding_epochs SET status='retired',snapshot_json=jsonb_set(snapshot_json,'{status}','"retired"')
    WHERE epoch_id=${graph.funding.epochId}`, /intent cannot be removed or restarted/);
  await assert.rejects(() => options('alice', fundingAction(graph, 'alice')), /approve begin-wallet-signing/);
  await perform('alice', beginAction(graph));
  assert.equal((await status()).fundingPsbtBase64, graph.fundingPsbtBase64);
  const fundingChallenge = await options('alice', fundingAction(graph, 'alice'));
  await sql`UPDATE webauthn_credentials SET prf_enabled=false WHERE credential_id=${credentials.carol[1]!}`;
  await unchangedAfterFailure(fundingChallenge, () => finish(fundingChallenge), /wallet signing requires/);
  await sql`UPDATE webauthn_credentials SET prf_enabled=true WHERE credential_id=${credentials.carol[1]!}`;
  await finish(fundingChallenge);
  await assert.rejects(() => options('carol', nextRestart), /wallet signing has started/);
  await assert.rejects(() => sql`UPDATE presigned_funding_epochs SET snapshot_json=jsonb_set(snapshot_json,'{signatures}','[]')
    WHERE epoch_id=${graph.funding.epochId}`, /signatures cannot be removed/);
  await assert.rejects(() => sql`UPDATE presigned_funding_epochs SET graph_digest=${randomBytes(32)}
    WHERE epoch_id=${graph.funding.epochId}`, /graph is immutable/);
  await perform('carol', beginAction(graph));
  const walletChallenges = await Promise.all((['bob', 'carol'] as const).map(id => options(id, fundingAction(graph, id))));
  await Promise.all(walletChallenges.map(challenge => finish(challenge)));
  current = await status();
  assert.equal(current.phase, 'funding-approvals');
  assert.equal(current.epoch!.finalization!.txid, graph.fundingTxid);
  await assert.rejects(() => sql`UPDATE presigned_funding_epochs SET snapshot_json=jsonb_set(snapshot_json,'{finalization}','null')
    WHERE epoch_id=${graph.funding.epochId}`, /finalized funding transaction is immutable/);
  await assert.rejects(() => options('alice', action({ kind: 'approve-funding', epochId: graph.funding.epochId,
    graphDigest: graph.digest, finalizationDigest: '66'.repeat(32) })), /exact transaction/);
  const approvals = await Promise.all(PARTICIPANT_IDS.map(id => options(id, action({ kind: 'approve-funding',
    epochId: graph.funding.epochId, graphDigest: graph.digest, finalizationDigest: current.epoch!.finalization!.finalizationDigest }))));
  await Promise.all(approvals.map(challenge => finish(challenge)));
  current = await status();
  assert.equal(current.phase, 'funding-approved');
  assert.equal(current.epoch!.fundingApprovals.length, 3);
  assert.equal(current.epoch!.signatures.length, 3);
  assert.equal(current.restartStateDigest, null);
  assert.equal((await sql`SELECT count(*)::int AS count FROM vault_coins WHERE vault_id=${vaultId}`)[0]!.count, 0);
  assert.equal((await sql`SELECT count(*)::int AS count FROM participant_sigbash_keys WHERE vault_id=${vaultId}`)[0]!.count, 0);
  assert.equal((await sql`SELECT count(*)::int AS count FROM vault_rosters WHERE vault_id=${vaultId}`)[0]!.count, 0);
  await sql`UPDATE vaults SET status='active' WHERE id=${vaultId}`;
  assert.equal((await status()).walletSigningReady, false);
  await assert.rejects(() => options('alice', action({ kind: 'approve-funding', epochId: graph.funding.epochId,
    graphDigest: graph.digest, finalizationDigest: current.epoch!.finalization!.finalizationDigest })), /funded or closed/);
  assert.deepEqual(await sql`SELECT artifact_json,digest,funding_address,status FROM vault_rosters WHERE vault_id=${legacyVaultId}`, legacyBefore);
  results.push('pending intent does not release PSBT or block restart; completed intent survives interrupted export/lost signature and rejects concurrent unanimous restart; own-intent release and signature prerequisites; monotonic SQL guards and replay rejection');
  results.push('finish-time backup revocation closes begin/signature gates; three exact wallet signatures plus unanimous final approval; no automatic activation/broadcast or Sigbash state');
  const eventCount = (await sql`SELECT count(*)::int AS count FROM presigned_action_events WHERE vault_id=${vaultId}`)[0]!.count;
  assert.equal(eventCount, 51);
  console.log(JSON.stringify({ suite: 'presigned-ceremony-db', network: BITCOIN_NETWORK_NAME,
    passed: results.length, results, approvedEvents: eventCount, inputObservationCalls: observationCalls,
    evidence: 'isolated PostgreSQL, synthetic stored passkeys/PRF envelopes and independent-observation callback; real preauthorization/restoration/funding cryptography; no live provider, hardware, broadcasts or funds' }, null, 2));
} finally {
  await sql.unsafe(`DROP TRIGGER IF EXISTS ${delayTrigger} ON presigned_action_events`).catch(() => undefined);
  await sql.unsafe(`DROP FUNCTION IF EXISTS ${delayTrigger}()`).catch(() => undefined);
  // Only this suite's explicit UUID fixtures. The disposable cluster can be retained for diagnostics.
  await sql`DELETE FROM presigned_action_events WHERE vault_id=${vaultId}`.catch(() => undefined);
  await sql`DELETE FROM presigned_action_challenges WHERE vault_id=${vaultId}`.catch(() => undefined);
  await sql`DELETE FROM vaults WHERE id IN (${vaultId},${legacyVaultId})`.catch(() => undefined);
  await sql`DELETE FROM users WHERE id IN (${users.alice},${users.bob},${users.carol})`.catch(() => undefined);
  for (const userId of Object.values(users)) {
    const subject = createHash('sha256').update('presigned_action').update('\0').update(userId).digest();
    await sql`DELETE FROM security_rate_limits WHERE action='presigned_action' AND subject_hash=${subject}`.catch(() => undefined);
  }
  await closeDatabase();
  await sql.end({ timeout: 5 });
}
