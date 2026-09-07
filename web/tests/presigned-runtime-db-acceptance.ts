import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as bitcoin from 'bitcoinjs-lib';
import postgres from 'postgres';
import { BITCOIN_NETWORK_NAME } from '../../src/network.js';
import { newPresignedCeremony, type PresignedFundingEpoch } from '../../src/presigned/ceremony.js';
import { createPresignedFixture } from '../../src/presigned/fixtures.js';
import { buildPresignedGraph } from '../../src/presigned/graph.js';
import { derivePresignedParticipantKeys } from '../../src/presigned/roster.js';
import { createPreauthorizations, completePresignedExit } from '../../src/presigned/signing.js';
import { createPresignedCooperativeNonce, signPresignedCooperativePartial, createPresignedRecoveryContribution, signPresignedFinalSweep } from '../../src/presigned/spends.js';
import { validatePresignedRuntimeAction, type PresignedRuntimeAction, type PresignedRuntimeKind, type PresignedRuntimeState } from '../../src/presigned/runtime.js';
import { PARTICIPANT_IDS, PRESIGNED_PROTOCOL, type ParticipantId } from '../../src/presigned/types.js';
import { commitmentDigest } from '../../src/presigned/validation.js';
import { EXPECTED_MIGRATION_FILES } from '../lib/migrations.js';
import { closeDatabase } from '../lib/server/db.js';
import { createPresignedRuntimeActionChallenge, getPresignedRuntimeActionChallenge, completePresignedRuntimeAction,
  getPresignedRuntimeStatus, type PresignedRuntimeActionChallenge, type PresignedRuntimeActionDependencies } from '../lib/server/presigned-runtime-store.js';

// Fresh disposable loopback PostgreSQL. Core observations and stored PRF/passkey
// prerequisites are synthetic; all Schnorr/MuSig2 contributions and witness validation are real.
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const database = new URL(process.env.DATABASE_URL);
assert(['127.0.0.1','localhost','[::1]'].includes(database.hostname) && /(?:test|acceptance)/u.test(database.pathname), 'disposable loopback test database required');
const sql = postgres(process.env.DATABASE_URL,{ max: 1, onnotice: () => {} });
const vaultId = randomUUID(); const epochId = randomUUID();
const users = Object.fromEntries(PARTICIPANT_IDS.map(id => [id,randomUUID()])) as Record<ParticipantId,string>;
const credentials = Object.fromEntries(PARTICIPANT_IDS.map(id => [id,`runtime-test-${randomUUID()}`])) as Record<ParticipantId,string>;
const secrets = Object.fromEntries(PARTICIPANT_IDS.map(id => [id,randomBytes(32).toString('base64url')])) as Record<ParticipantId,string>;
const keys = Object.fromEntries(PARTICIPANT_IDS.map(id => [id,derivePresignedParticipantKeys(secrets[id],id,vaultId)])) as Record<ParticipantId,ReturnType<typeof derivePresignedParticipantKeys>>;
const base = createPresignedFixture({ network: BITCOIN_NETWORK_NAME });
const graph = buildPresignedGraph({ roster: { ...base.roster,vaultId,participants: PARTICIPANT_IDS.map(id => keys[id].publicIdentity) },
  funding: { ...base.graph.funding,epochId } });
const entries = PARTICIPANT_IDS.flatMap(id => createPreauthorizations({ graph,participantId: id,privateKeys: keys[id].keys.soloPrivateKeys,approvedGraphDigest: graph.digest }));
const anchor = '55'.repeat(32);
const b = (hex: string) => Buffer.from(hex,'hex');
let mode: 'good'|'spent'|'reanchored'|'young'|'wrong-chain'|'unavailable' = 'good';
let observations = 0;
const dependencies: PresignedRuntimeActionDependencies = { requiredConfirmations: 2,
  async observeCoin({ network,genesisHash,source }) {
    observations++;
    if (mode === 'unavailable') throw new Error('synthetic Core unavailable');
    return { network,genesisHash: mode === 'wrong-chain' ? '11'.repeat(32) : genesisHash,
      txid: source.txid,vout: source.vout,valueSats: source.valueSats,scriptPubKeyHex: source.scriptPubKeyHex,
      confirmationBlockHash: mode === 'reanchored' ? '66'.repeat(32) : anchor,
      confirmations: mode === 'young' ? 11 : 20,unspentInActiveChain: (mode !== 'spent') as true,coinbase: false };
  },
};
function action(body: Record<string,unknown>): PresignedRuntimeAction {
  return validatePresignedRuntimeAction({ version: 2,protocol: PRESIGNED_PROTOCOL,...body });
}
function creation(kind: PresignedRuntimeKind,sourceExitId: string|null=null,exitId: string|null=null) {
  return action({ kind: 'create-proposal',epochId,graphDigest: graph.digest,proposalId: randomUUID(),
    spendKind: kind,sourceExitId,exitId,confirmationBlockHash: anchor });
}
function bound(state: PresignedRuntimeState,body: Record<string,unknown>) {
  return action({ proposalId: state.proposal.proposalId,proposalDigest: state.proposal.digest,...body });
}
const options = (id: ParticipantId,candidate: PresignedRuntimeAction) => createPresignedRuntimeActionChallenge({
  userId: users[id],credentialId: credentials[id],challenge: randomBytes(32).toString('base64url'),action: candidate },dependencies);
const finish = (challenge: PresignedRuntimeActionChallenge) => completePresignedRuntimeAction(challenge,challenge.credential.counter+1,dependencies);
async function perform(id: ParticipantId,candidate: PresignedRuntimeAction) { return (await finish(await options(id,candidate))).proposal; }
async function read(id: string) { const status = await getPresignedRuntimeStatus(users.alice); const proposal = status.proposals.find(item => item.proposal.proposalId===id); assert(proposal); return proposal; }
async function unchangedFailure(challenge: PresignedRuntimeActionChallenge,pattern: RegExp) {
  const before = await sql`SELECT state_digest FROM presigned_runtime_proposals WHERE id=${challenge.proposal.proposalId}`;
  await assert.rejects(() => finish(challenge),pattern);
  assert.deepEqual(await sql`SELECT state_digest FROM presigned_runtime_proposals WHERE id=${challenge.proposal.proposalId}`,before);
  const pending = await getPresignedRuntimeActionChallenge({ userId: challenge.credential.userId,challengeId: challenge.id });
  assert.equal(pending.credential.counter,challenge.credential.counter);
}
const results: string[] = [];
try {
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations(version text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())`;
  for (const file of EXPECTED_MIGRATION_FILES.filter(file => file <= '017_presigned_runtime.sql')) {
    if (!(await sql`SELECT 1 FROM schema_migrations WHERE version=${file.slice(0,-4)}`).length)
      await sql.unsafe(readFileSync(resolve('db/migrations',file),'utf8'));
  }
  await sql`INSERT INTO vaults(id,name,protocol) VALUES (${vaultId},'Synthetic offline-funded runtime',${PRESIGNED_PROTOCOL})`;
  for (const id of PARTICIPANT_IDS) {
    await sql`INSERT INTO users(id,display_name) VALUES (${users[id]},${`Synthetic ${id}`})`;
    await sql`INSERT INTO vault_members(vault_id,user_id,participant_id) VALUES (${vaultId},${users[id]},${id})`;
    await sql`INSERT INTO participant_key_material(user_id,vault_id,participant_id,personal_public_key,payout_xonly_public_key)
      VALUES (${users[id]},${vaultId},${id},${b(keys[id].publicIdentity.personalPublicKeyHex)},${b(keys[id].publicIdentity.payoutXonlyPublicKeyHex)})`;
    await sql`INSERT INTO webauthn_credentials(credential_id,user_id,public_key,counter,device_type,backed_up,prf_enabled,credential_name)
      VALUES (${credentials[id]},${users[id]},${randomBytes(64)},0,'multiDevice',true,true,'Synthetic surviving passkey')`;
    await sql`INSERT INTO passkey_envelopes(credential_id,version,prf_salt,iv,ciphertext,aad)
      VALUES (${credentials[id]},1,${randomBytes(32)},${randomBytes(12)},${randomBytes(64)},${randomBytes(32)})`;
  }
  const ceremony = newPresignedCeremony(vaultId,{ network: graph.roster.network,genesisHash: graph.roster.genesisHash,
    economics: graph.roster.economics,feePolicy: graph.roster.feePolicy,fundingFeeSats: graph.funding.feeSats });
  const epoch: PresignedFundingEpoch = { epochId,status: 'retired',inputs: graph.funding.inputs,graph,preauthorizations: entries,
    backups: [],walletSigningStarted: [],signatures: [],finalization: null,fundingApprovals: [],restartApprovals: [] };
  ceremony.identities=graph.roster.participants; ceremony.roster=graph.roster; ceremony.rosterDigest=graph.rosterDigest;
  ceremony.rosterApprovals=[...PARTICIPANT_IDS]; ceremony.epochs=[epoch];
  await sql`INSERT INTO presigned_ceremonies(vault_id,settings_json,settings_digest,state_json,state_digest)
    VALUES (${vaultId},${sql.json(ceremony.settings as never)},${b(ceremony.settingsDigest)},${sql.json(ceremony as never)},
      ${b(commitmentDigest('vault/presigned-graph-v2/ceremony/state',ceremony))})`;
  await sql`INSERT INTO presigned_funding_epochs(epoch_id,vault_id,ordinal,status,graph_digest,funding_txid,snapshot_json,snapshot_digest)
    VALUES (${epochId},${vaultId},1,'retired',${b(graph.digest)},${b(graph.fundingTxid)},${sql.json(epoch as never)},
      ${b(commitmentDigest('vault/presigned-graph-v2/ceremony/epoch',epoch))})`;
  const initial = await getPresignedRuntimeStatus(users.alice);
  assert.equal(initial.kits[0]!.epochStatus,'retired');
  assert.equal(initial.vaultStatus,'setup');
  assert.equal(initial.chainAuthority,'not-checked-in-status');
  assert.equal(initial.broadcastAvailable,false);
  const request = creation('cooperative');
  assert.throws(() => validatePresignedRuntimeAction({ ...request,observedUnspent: true }),/unexpected or missing/);
  await assert.rejects(() => createPresignedRuntimeActionChallenge({ userId: users.alice,credentialId: credentials.alice,
    challenge: randomBytes(32).toString('base64url'),action: request },{} as PresignedRuntimeActionDependencies),/private-Core/);
  mode='spent'; await assert.rejects(() => options('alice',request),/source changed/);
  mode='wrong-chain'; await assert.rejects(() => options('alice',request),/source changed/);
  mode='good';
  const pendingCreate=await options('alice',request);
  mode='reanchored'; await unchangedFailure(pendingCreate,/source changed/); mode='good';
  let cooperative=(await finish(pendingCreate)).proposal;
  const soloBob=await perform('bob',creation('solo',null,'bob'));
  const soloAlice=await perform('alice',creation('solo',null,'alice'));
  mode='young'; await assert.rejects(() => options('carol',creation('recovery')),/CSV age/); mode='good';
  let recovery=await perform('carol',creation('recovery'));
  await assert.rejects(() => options('bob',creation('cooperative')),/coordination slot/);
  assert.equal((await getPresignedRuntimeStatus(users.alice)).proposals.length,4);
  results.push('retired graph with no recorded funding/backup approvals remains spendable under trusted confirmed-source evidence; independent shared/solo/recovery slots');

  const oldNonce=createPresignedCooperativeNonce({ graph,proposal: cooperative.proposal.spend!,participantId: 'alice',
    personalPrivateKey: keys.alice.keys.personalPrivateKey,approvedProposalDigest: cooperative.proposal.spend!.digest });
  cooperative=await perform('alice',bound(cooperative,{ kind: 'contribute-nonce',publicNonce: oldNonce.publicNonce }));
  const beforeAbandon=observations;
  mode='unavailable';
  cooperative=await perform('carol',bound(cooperative,{ kind: 'abandon-proposal',reason: 'Restart a stalled shared ceremony without erasing exposed nonce material.' }));
  mode='good';
  assert.equal(observations,beforeAbandon);
  assert.equal(cooperative.publicNonces.length,1);
  await assert.rejects(() => sql`UPDATE presigned_runtime_nonce_commitments SET public_nonce=${randomBytes(66)}
    WHERE proposal_id=${cooperative.proposal.proposalId}`,/nonce commitment is immutable/);
  oldNonce.secretNonce.fill(0);
  await assert.rejects(() => options('alice',request),/IDs cannot be reused/);
  cooperative=await perform('bob',creation('cooperative'));
  await assert.rejects(() => options('alice',bound(cooperative,{ kind: 'contribute-nonce',publicNonce: {
    ...oldNonce.publicNonce,proposalId: cooperative.proposal.proposalId,proposalDigest: cooperative.proposal.spend!.digest,
  } })),/nonce was already committed/);
  const nonces=PARTICIPANT_IDS.map(id => createPresignedCooperativeNonce({ graph,proposal: cooperative.proposal.spend!,participantId: id,
    personalPrivateKey: keys[id].keys.personalPrivateKey,approvedProposalDigest: cooperative.proposal.spend!.digest }));
  const aNonce=await options('alice',bound(cooperative,{ kind: 'contribute-nonce',publicNonce: nonces[0]!.publicNonce }));
  await sql`UPDATE webauthn_credentials SET counter=counter+1 WHERE credential_id=${credentials.alice}`;
  await assert.rejects(() => finish(aNonce),/counter changed/);
  await sql`UPDATE webauthn_credentials SET counter=${aNonce.credential.counter} WHERE credential_id=${credentials.alice}`;
  await finish(aNonce);
  await assert.rejects(() => finish(aNonce),/used|superseded/);
  const nonceChallenges=await Promise.all(nonces.slice(1).map(item => options(item.publicNonce.participantId,
    bound(cooperative,{ kind: 'contribute-nonce',publicNonce: item.publicNonce }))));
  await Promise.all(nonceChallenges.map(finish));
  cooperative=await read(cooperative.proposal.proposalId);
  assert.equal(cooperative.publicNonces.length,3); assert(cooperative.nonceSetDigest);
  const partials=nonces.map(item => {
    const id=item.publicNonce.participantId;
    return signPresignedCooperativePartial({ graph,proposal: cooperative.proposal.spend!,participantId: id,
      personalPrivateKey: keys[id].keys.personalPrivateKey,approvedProposalDigest: cooperative.proposal.spend!.digest,
      publicNonces: cooperative.publicNonces,nonceBinding: item.binding,consumedSecretNonce: item.secretNonce });
  });
  const aPartial=await options('alice',bound(cooperative,{ kind: 'contribute-partial',partial: partials[0] }));
  mode='spent'; await unchangedFailure(aPartial,/source changed/); mode='good';
  await finish(aPartial);
  const partialChallenges=await Promise.all(partials.slice(1).map(partial => options(partial.participantId,
    bound(cooperative,{ kind: 'contribute-partial',partial }))));
  await Promise.all(partialChallenges.map(finish));
  cooperative=await read(cooperative.proposal.proposalId);
  assert.equal(cooperative.status,'finalized');
  assert.deepEqual(cooperative.finalized!.approverParticipantIds,PARTICIPANT_IDS);
  await assert.rejects(() => options('alice',bound(cooperative,{ kind: 'approve-broadcast',transactionDigest: '66'.repeat(32) })),/witness bytes/);
  const approvals=await Promise.all(PARTICIPANT_IDS.map(id => options(id,bound(cooperative,{ kind: 'approve-broadcast',transactionDigest: cooperative.finalized!.transactionDigest }))));
  await Promise.all(approvals.map(finish));
  assert.equal((await read(cooperative.proposal.proposalId)).broadcastReady,true);
  await assert.rejects(() => options('bob',bound(cooperative,{ kind: 'abandon-proposal',reason: 'This completed transaction must never be described as revoked.' })),/cannot be abandoned/);
  await assert.rejects(() => sql`UPDATE presigned_runtime_proposals SET transaction_hex='00' WHERE id=${cooperative.proposal.proposalId}`,/cannot be revoked or changed/);
  await assert.rejects(() => sql`UPDATE presigned_runtime_proposals SET state_json=jsonb_set(state_json,'{partials}','[]') WHERE id=${cooperative.proposal.proposalId}`,/cannot be removed/);
  results.push('abandon retains nonce commitment; fresh-ID and global nonce-reuse rejection; real concurrent MuSig2 contributions finalize atomically; exact-byte quorum and immutable finalized history');

  for (const initialSolo of [soloBob,soloAlice]) {
    let solo=initialSolo; const id=solo.proposal.actorParticipantId!; const exit=graph.exits.find(item => item.id===solo.proposal.exitId)!;
    const completed=completePresignedExit({ graph,preauthorizations: entries,exitId: exit.id,participantId: id,
      privateKey: keys[id].keys.soloPrivateKeys[exit.roundId]!,approvedGraphDigest: graph.digest });
    const altered=bitcoin.Transaction.fromHex(completed.transactionHex); altered.outs[0]!.value+=1n;
    await assert.rejects(() => options(id,bound(solo,{ kind: 'finalize-transaction',transactionHex: altered.toHex() })),/changed|differs/);
    solo=await perform(id,bound(solo,{ kind: 'finalize-transaction',transactionHex: completed.transactionHex }));
    solo=await perform(id,bound(solo,{ kind: 'approve-broadcast',transactionDigest: solo.finalized!.transactionDigest }));
    assert.equal((await read(solo.proposal.proposalId)).broadcastReady,true);
  }
  for (const id of ['alice','bob'] as const) recovery=await perform(id,bound(recovery,{ kind: 'contribute-recovery',
    contribution: createPresignedRecoveryContribution({ graph,proposal: recovery.proposal.spend!,participantId: id,
      personalPrivateKey: keys[id].keys.personalPrivateKey,approvedProposalDigest: recovery.proposal.spend!.digest }) }));
  assert.deepEqual(recovery.finalized!.approverParticipantIds,['alice','bob']);
  await assert.rejects(() => options('carol',bound(recovery,{ kind: 'approve-broadcast',transactionDigest: recovery.finalized!.transactionDigest })),/exact transaction signer quorum/);
  for (const id of ['alice','bob'] as const) recovery=await perform(id,bound(recovery,{ kind: 'approve-broadcast',transactionDigest: recovery.finalized!.transactionDigest }));
  assert.equal((await read(recovery.proposal.proposalId)).broadcastReady,true);
  let final=await perform('carol',creation('final-sweep','alice/bob'));
  const completed=signPresignedFinalSweep({ graph,proposal: final.proposal.spend!,participantId: 'carol',payoutPrivateKey: keys.carol.keys.payoutPrivateKey,
    approvedProposalDigest: final.proposal.spend!.digest });
  await assert.rejects(() => options('alice',bound(final,{ kind: 'finalize-transaction',transactionHex: completed.transactionHex })),/current source participant/);
  final=await perform('carol',bound(final,{ kind: 'finalize-transaction',transactionHex: completed.transactionHex }));
  await perform('carol',bound(final,{ kind: 'approve-broadcast',transactionDigest: final.finalized!.transactionDigest }));
  // Already completed conflicting transactions do not manufacture exclusive ownership of the source.
  await perform('alice',creation('cooperative'));
  let finalStatus=await getPresignedRuntimeStatus(users.alice);
  assert.equal(finalStatus.proposals.length,7);
  assert.equal(finalStatus.proposals.filter(item => item.broadcastReady).length,5);
  assert.equal(finalStatus.broadcastAvailable,false);
  assert.equal((await sql`SELECT count(*)::int AS count FROM vault_coins WHERE vault_id=${vaultId}`)[0]!.count,0);
  assert.equal((await sql`SELECT count(*)::int AS count FROM presigned_runtime_action_events WHERE vault_id=${vaultId}`)[0]!.count,28);
  results.push('competing solo/cooperative/recovery transactions coexist; recovery exact N-1 quorum; final-owner sweep from offline graph branch without coordinator predecessor history; no broadcast or legacy coin mutations');
  const previous=await sql`SELECT state_json,transaction_hex,transaction_digest FROM presigned_runtime_proposals WHERE id=${cooperative.proposal.proposalId}`;
  const reanchor=action({ kind: 'reanchor-transaction',proposalId: randomUUID(),predecessorProposalId: cooperative.proposal.proposalId,
    predecessorProposalDigest: cooperative.proposal.digest,transactionDigest: cooperative.finalized!.transactionDigest,
    confirmationBlockHash: '66'.repeat(32) });
  mode='reanchored';
  const reanchorChallenge=await options('bob',reanchor);
  mode='good'; await unchangedFailure(reanchorChallenge,/source changed/); mode='reanchored';
  let successor=(await finish(reanchorChallenge)).proposal;
  assert.equal(successor.finalized!.transactionHex,cooperative.finalized!.transactionHex);
  assert.equal(successor.finalized!.txid,cooperative.finalized!.txid);
  assert.notEqual(successor.finalized!.transactionDigest,cooperative.finalized!.transactionDigest);
  assert.deepEqual([successor.publicNonces,successor.partials,successor.recoveryContributions,successor.broadcastApprovals],[[],[],[],[]]);
  assert.equal((await read(successor.proposal.proposalId)).broadcastReady,false);
  for (const id of PARTICIPANT_IDS) successor=await perform(id,bound(successor,{ kind: 'approve-broadcast',transactionDigest: successor.finalized!.transactionDigest }));
  assert.equal((await read(successor.proposal.proposalId)).broadcastReady,true);
  assert.deepEqual(await sql`SELECT state_json,transaction_hex,transaction_digest FROM presigned_runtime_proposals WHERE id=${cooperative.proposal.proposalId}`,previous);
  finalStatus=await getPresignedRuntimeStatus(users.alice);
  assert.equal(finalStatus.proposals.length,8);
  assert.equal(finalStatus.proposals.filter(item => item.broadcastReady).length,6);
  assert.equal((await sql`SELECT count(*)::int AS count FROM presigned_runtime_action_events WHERE vault_id=${vaultId}`)[0]!.count,32);
  results.push('reanchor reuses exact completed bytes in an immutable successor despite an occupied shared slot; fresh anchor checked at both stages, full quorum repeated, predecessor retained and no nonce/partial copied');
  console.log(JSON.stringify({ suite: 'presigned-runtime-db',network: BITCOIN_NETWORK_NAME,passed: results.length,results,
    approvedActions: 32,sourceObservations: observations,
    evidence: 'isolated PostgreSQL; synthetic stored passkeys/PRF envelopes and private-Core callback facts; real Schnorr/MuSig2/witness validation; no real provider/device/chain or broadcasts' },null,2));
} finally {
  await sql`DELETE FROM presigned_runtime_action_events WHERE vault_id=${vaultId}`.catch(() => undefined);
  await sql`DELETE FROM presigned_runtime_action_challenges WHERE vault_id=${vaultId}`.catch(() => undefined);
  await sql`DELETE FROM presigned_runtime_nonce_commitments WHERE vault_id=${vaultId}`.catch(() => undefined);
  await sql`DELETE FROM presigned_runtime_proposals WHERE vault_id=${vaultId}`.catch(() => undefined);
  await sql`DELETE FROM vaults WHERE id=${vaultId}`.catch(() => undefined);
  await sql`DELETE FROM users WHERE id IN (${users.alice},${users.bob},${users.carol})`.catch(() => undefined);
  for (const userId of Object.values(users)) {
    const hash=createHash('sha256').update('presigned_runtime_action').update('\0').update(userId).digest();
    await sql`DELETE FROM security_rate_limits WHERE action='presigned_runtime_action' AND subject_hash=${hash}`.catch(() => undefined);
  }
  await closeDatabase(); await sql.end({ timeout: 5 });
}
