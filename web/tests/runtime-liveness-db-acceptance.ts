import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import * as bitcoin from 'bitcoinjs-lib';
import postgres from 'postgres';
import { BITCOIN_CORE_CHAIN } from '../../src/network.js';
import { createIsolatedSoloFixture, signPolicyLeafPsbt, SOLO_PARTICIPANTS } from './solo-signing-fixture.js';
import { createSigbashReadinessChallenge, completeSigbashReadinessProof, getSigbashReadinessStatus } from '../lib/server/sigbash-readiness-store.js';
import { createStoredVaultProposal, finalizeStoredSoloProposal, submitApprovedBroadcast, getVaultRuntimeStatus, createBroadcastApprovalChallenge, completeBroadcastApproval, pollVaultChain } from '../lib/server/vault-runtime-store.js';
import { completeSigbashCustodyAuthorization } from '../lib/server/sigbash-custody-store.js';
import { tokenHash } from '../lib/server/encoding.js';
import { closeDatabase } from '../lib/server/db.js';
import { buildVaultProposal, vaultCoinSnapshotDigest } from '../../src/vault-runtime.js';

// Run only against a disposable acceptance database; all signing material is synthetic.
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for runtime liveness acceptance');
const sql = postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => {} });
const fixtureEnvironment = {
  WEBAUTHN_RP_ID: 'localhost',
  WEBAUTHN_ORIGIN: 'http://localhost:3000',
  APP_ORIGIN: 'http://localhost:3000',
  CHAIN_OBSERVATION_ORIGINS: 'https://chain.example',
  VAULT_CONFIRMATIONS_REQUIRED: '1',
};
const priorEnvironment = Object.fromEntries(Object.keys(fixtureEnvironment).map(key => [key, process.env[key]]));
Object.assign(process.env, fixtureEnvironment);
const vaultId = randomUUID();
const coinId = randomUUID();
const fixture = createIsolatedSoloFixture(vaultId);
const users = Object.fromEntries(SOLO_PARTICIPANTS.map(id => [id, randomUUID()]));
const credentials = Object.fromEntries(SOLO_PARTICIPANTS.map(id => [id, `audit-credential-${randomUUID()}`]));
const leases = Object.fromEntries(SOLO_PARTICIPANTS.map(id => [id, `synthetic-audit-lease-${randomUUID()}`]));
const b = (hex: string) => Buffer.from(hex, 'hex');
const coin = { vaultId, rosterDigest: fixture.digest, kind: 'vault' as const, roundId: 'alicebobcarol', ownerParticipantId: null, txid: randomBytes(32).toString('hex'), vout: 0, valueSats: fixture.artifact.funding.valueSats, scriptPubKeyHex: fixture.artifact.funding.outputScriptHex };
const results: unknown[] = [];
let rpcServer: ReturnType<typeof createServer> | undefined;
let releasePendingRpc = () => {};
const previousRpcUrl = process.env.BITCOIN_RPC_URL;
const previousBackend = process.env.BITCOIN_BACKEND;
try {
  await sql`INSERT INTO vaults (id,name,status) VALUES (${vaultId},'Isolated security audit','roster_confirmed')`;
  for (const id of SOLO_PARTICIPANTS) {
    const participant = fixture.artifact.participants.find(p => p.id === id)!;
    await sql`INSERT INTO users (id,display_name) VALUES (${users[id]},${id})`;
    await sql`INSERT INTO vault_members (vault_id,user_id,participant_id) VALUES (${vaultId},${users[id]},${id})`;
    await sql`INSERT INTO webauthn_credentials (credential_id,user_id,public_key,counter,device_type,backed_up,prf_enabled) VALUES (${credentials[id]},${users[id]},${Buffer.from([1])},0,'singleDevice',false,true)`;
    await sql`INSERT INTO participant_key_material (user_id,vault_id,participant_id,personal_public_key,payout_xonly_public_key) VALUES (${users[id]},${vaultId},${id},${b(participant.personalPublicKeyHex)},${b(participant.payoutXonlyPubkeyHex)})`;
    await sql`INSERT INTO sigbash_custody_leases (token_hash,user_id,credential_id,expires_at) VALUES (${tokenHash(leases[id])},${users[id]},${credentials[id]},now()+interval '15 minutes')`;
    for (const [round, key] of Object.entries(participant.sigbashRegistrationByRound!)) {
      await sql`INSERT INTO participant_sigbash_keys (vault_id,user_id,participant_id,round_id,network,key_id,key_index,bip328_xpub,policy_leaf_xonly,identification_leaf_xonly,policy_root,policy_id) VALUES (${vaultId},${users[id]},${id},${round},${fixture.artifact.network},${key.keyId},${key.keyIndex},${key.bip328Xpub},${b(key.policyLeafXonlyPubkey)},${b(key.identificationLeafXonlyPubkey)},${b(key.policyRoot)},${key.policyId})`;
    }
  }
  await sql`INSERT INTO vault_rosters (vault_id,version,network,artifact_json,digest,funding_address,status,confirmed_at) VALUES (${vaultId},1,${fixture.artifact.network},${sql.json(JSON.parse(JSON.stringify(fixture.artifact)))},${b(fixture.digest)},${fixture.artifact.funding.address},'confirmed',now())`;

  async function signedReadiness(id: string) {
    const challenge = await createSigbashReadinessChallenge({ userId: users[id], leaseToken: leases[id] });
    const signed = signPolicyLeafPsbt(challenge.validPsbtBase64, fixture.policyPrivateKeys.get(`${id}:${challenge.round}`)!);
    return { userId: users[id], leaseToken: leases[id], challengeId: challenge.id, transactionHex: signed.txHex, signedPsbtBase64: signed.psbtBase64 };
  }
  // Seven proofs pass through the actual completion function, without Sigbash.
  for (const id of ['alice','alice','alice','bob','bob','carol','carol']) {
    await completeSigbashReadinessProof(await signedReadiness(id));
  }
  const lastTwo = await Promise.all(['bob','carol'].map(signedReadiness));
  // Test-only commit barrier creates the ordinary overlapping-transaction schedule.
  // It does not alter the application queries, checks, or transaction isolation.
  await sql.unsafe(`CREATE FUNCTION audit_delay_proof_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(1.5); RETURN NEW; END $$`);
  await sql.unsafe(`CREATE CONSTRAINT TRIGGER audit_delay_proof_commit AFTER INSERT ON participant_sigbash_readiness_proofs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.vault_id = '${vaultId}'::uuid) EXECUTE FUNCTION audit_delay_proof_commit()`);
  await Promise.all(lastTwo.map(input => completeSigbashReadinessProof(input)));
  await sql.unsafe('DROP TRIGGER audit_delay_proof_commit ON participant_sigbash_readiness_proofs');
  await sql.unsafe('DROP FUNCTION audit_delay_proof_commit()');
  let readiness = await getSigbashReadinessStatus(users.bob);
  assert.equal(readiness.totalProofCount, 9);
  assert.equal(readiness.ready, true);
  assert.equal(readiness.nextRound, null);
  // Replaying an existing exact receipt also repairs a legacy nine-proof limbo.
  await sql`UPDATE vaults SET status='roster_confirmed' WHERE id=${vaultId}`;
  await completeSigbashReadinessProof(lastTwo[0]);
  readiness = await getSigbashReadinessStatus(users.bob);
  assert.equal(readiness.ready, true);
  await assert.rejects(() => createSigbashReadinessChallenge({ userId: users.bob, leaseToken: leases.bob }), /already proven/);
  results.push({ issue: 'readiness concurrency', proofs: 9, ready: readiness.ready, nextRound: readiness.nextRound, idempotentRetryRepairs: true });

  // Independent runtime scenario begins with an already-active vault and fresh observations.
  await sql`UPDATE vaults SET status='active' WHERE id=${vaultId}`;
  await sql`INSERT INTO vault_coins (id,vault_id,roster_digest,kind,round_id,txid,vout,value_sats,script_pubkey,status,confirmed_height) VALUES (${coinId},${vaultId},${b(fixture.digest)},'vault','alicebobcarol',${b(coin.txid)},0,${coin.valueSats},${b(coin.scriptPubKeyHex)},'current',100000)`;
  for (const id of SOLO_PARTICIPANTS) {
    await sql`INSERT INTO vault_coin_observations (coin_id,vault_id,user_id,participant_id,credential_id,snapshot_digest,source_origin,confirmations,observed_unspent) VALUES (${coinId},${vaultId},${users[id]},${id},${credentials[id]},${b(vaultCoinSnapshotDigest(coin))},'https://audit-chain.example',20,true)`;
  }
  const coop = await createStoredVaultProposal(users.alice, { kind: 'cooperative' });
  const bobSolo = await createStoredVaultProposal(users.bob, { kind: 'solo', actorParticipantId: 'bob' });
  const parallel = await Promise.all(['alice', 'carol'].map(id =>
    createStoredVaultProposal(users[id], { kind: 'solo', actorParticipantId: id })));
  await assert.rejects(() => createStoredVaultProposal(users.bob, { kind: 'solo', actorParticipantId: 'bob' }), /already has a live proposal/);
  const bobView = await getVaultRuntimeStatus(users.bob);
  assert.equal(bobView.proposalChoices.length, 4);
  assert.equal(bobView.proposal?.id, bobSolo.id);
  assert.equal((await getVaultRuntimeStatus(users.bob, coop.id)).proposal?.id, coop.id);
  assert.equal((await getVaultRuntimeStatus(users.bob, randomUUID())).proposal?.id, bobSolo.id);
  results.push({ issue: 'independent proposals', cooperativeAndThreeSoloExits: true, duplicateActionRejected: true, participantCanSelectSharedProposal: true });
  await sql`UPDATE vault_transaction_proposals SET status='stale',rejection_reason='Independent acceptance scenario complete' WHERE id=ANY(${[coop.id, bobSolo.id, ...parallel.map(p => p.id)]}::uuid[])`;

  // Actual finalized solo transaction + an authorized broadcast, but ONLY a loopback RPC fixture.
  const proposalId = randomUUID();
  const expiry = new Date(Date.now() + 3000);
  const proposal = buildVaultProposal({ artifact: fixture.artifact, coin, kind: 'solo', actorParticipantId: 'alice', expiresAt: expiry.toISOString() });
  await sql`INSERT INTO vault_transaction_proposals (id,vault_id,roster_digest,input_coin_id,kind,round_id,actor_participant_id,proposer_user_id,psbt_base64,unsigned_txid,proposal_digest,expires_at) VALUES (${proposalId},${vaultId},${b(fixture.digest)},${coinId},'solo','alicebobcarol','alice',${users.alice},${proposal.psbtBase64},${b(proposal.unsignedTxid)},${b(proposal.digest)},${expiry})`;
  const signed = signPolicyLeafPsbt(proposal.psbtBase64, fixture.policyPrivateKeys.get('alice:alicebobcarol')!);
  await finalizeStoredSoloProposal({ userId: users.alice, proposalId, proposalDigest: proposal.digest, transactionHex: signed.txHex, signedPsbtBase64: signed.psbtBase64 });
  const approval = await createBroadcastApprovalChallenge({ userId: users.alice, credentialId: credentials.alice, proposalId, proposalDigest: proposal.digest, finalTxid: proposal.unsignedTxid, challenge: 'synthetic-verified-approval' });
  const approvalId = await completeBroadcastApproval(approval, 1);
  let announceSend!: () => void;
  const sendArrived = new Promise<void>(resolve => { announceSend = resolve; });
  let releaseSend!: () => void;
  const gate = new Promise<void>(resolve => { releaseSend = resolve; });
  releasePendingRpc = releaseSend;
  let winnerConfirmed = false;
  const winningTransaction = bitcoin.Transaction.fromHex(signed.txHex);
  const blockHash = '83'.repeat(32);
  let rejectedCompetingSends = 0;
  let loseAcknowledgementFor: string | null = null;
  rpcServer = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw);
    let result: unknown;
    const rpcError = (code: number, message: string) => {
      res.writeHead(500); res.end(JSON.stringify({ error: { code, message } }));
    };
    if (request.method === 'getblockchaininfo') result = { chain: BITCOIN_CORE_CHAIN, pruned: false, initialblockdownload: false, blocks: 100020, headers: 100020 };
    else if (request.method === 'getindexinfo') result = { txindex: { synced: true } };
    else if (request.method === 'sendrawtransaction') {
      const txid = bitcoin.Transaction.fromHex(request.params[0]).getId();
      if (winnerConfirmed && txid !== proposal.unsignedTxid) {
        rejectedCompetingSends++;
        rpcError(-26, 'fixture competing input already spent'); return;
      }
      if (txid === loseAcknowledgementFor) {
        rpcError(-28, 'fixture send response unavailable after submission'); return;
      }
      announceSend(); await gate; result = txid;
    } else if (request.method === 'getrawtransaction' && winnerConfirmed && request.params[0] === proposal.unsignedTxid) {
      result = {
        txid: proposal.unsignedTxid, hex: signed.txHex, confirmations: 2,
        blockhash: blockHash, blockheight: 100019,
        vin: [{ txid: coin.txid, vout: coin.vout }],
        vout: winningTransaction.outs.map((output, n) => ({ n, value: Number(output.value) / 100_000_000, scriptPubKey: { hex: Buffer.from(output.script).toString('hex') } })),
      };
    } else if (request.method === 'getrawtransaction' && request.params[0] === loseAcknowledgementFor) {
      rpcError(-28, 'fixture transaction lookup temporarily unavailable'); return;
    } else if (request.method === 'getrawtransaction') { rpcError(-5, 'fixture transaction not found'); return; }
    else if (request.method === 'getblockheader') result = { hash: blockHash, height: 100019, confirmations: 2 };
    else { rpcError(-1, 'unexpected test RPC'); return; }
    res.setHeader('content-type','application/json'); res.end(JSON.stringify({ result, error: null, id: request.id }));
  });
  await new Promise<void>(resolve => rpcServer!.listen(0,'127.0.0.1',resolve));
  process.env.BITCOIN_RPC_URL = `http://127.0.0.1:${(rpcServer.address() as {port: number}).port}`;
  process.env.BITCOIN_BACKEND = 'core';
  const broadcasting = submitApprovedBroadcast({ userId: users.alice, approvalId });
  await Promise.race([sendArrived, broadcasting.then(() => { throw new Error('broadcast finished before the test barrier'); })]);
  await new Promise(resolve => setTimeout(resolve, Math.max(0, expiry.getTime() - Date.now() + 100)));
  const replacement = await createStoredVaultProposal(users.bob, { kind: 'solo', actorParticipantId: 'bob' });
  assert.equal((await getVaultRuntimeStatus(users.alice)).proposal?.id, proposalId);
  await assert.rejects(() => completeBroadcastApproval(approval, 2), /changed or expired before approval/);
  releaseSend();
  assert.equal((await broadcasting).txid, proposal.unsignedTxid);
  const [stored] = await sql`SELECT p.status AS proposal_status,a.status AS approval_status FROM vault_transaction_proposals p JOIN vault_broadcast_approvals a ON a.proposal_id=p.id WHERE p.id=${proposalId}`;
  assert.deepEqual({ ...stored }, { proposal_status: 'broadcast', approval_status: 'broadcast' });
  results.push({ issue: 'broadcast expiry race', loopbackRpcAcceptedOriginal: true, ...stored, broadcastCompleted: true, expiryDidNotDiscardApprovedIntent: true, replacementCreated: Boolean(replacement.id) });

  const competingSigned = signPolicyLeafPsbt(replacement.psbtBase64, fixture.policyPrivateKeys.get('bob:alicebobcarol')!);
  await finalizeStoredSoloProposal({ userId: users.bob, proposalId: replacement.id, proposalDigest: replacement.digest, transactionHex: competingSigned.txHex, signedPsbtBase64: competingSigned.psbtBase64 });
  const competingApproval = await createBroadcastApprovalChallenge({ userId: users.bob, credentialId: credentials.bob, proposalId: replacement.id, proposalDigest: replacement.digest, finalTxid: replacement.unsignedTxid, challenge: 'synthetic-competing-approval' });
  const competingApprovalId = await completeBroadcastApproval(competingApproval, 1);
  // A crash between passkey approval and RPC must also be recoverable.
  await sql`UPDATE vault_broadcast_approvals SET updated_at=now()-interval '31 seconds' WHERE id=${competingApprovalId}`;
  loseAcknowledgementFor = replacement.unsignedTxid;
  const uncertain = await pollVaultChain();
  assert(uncertain.broadcastErrors.some(item => item.approvalId === competingApprovalId));
  const [retryable] = await sql`SELECT status,failure_reason FROM vault_broadcast_approvals WHERE id=${competingApprovalId}`;
  assert.equal(retryable.status, 'submitting');
  assert.equal(retryable.failure_reason, null);
  loseAcknowledgementFor = null;
  await sql`UPDATE vault_broadcast_approvals SET updated_at=now()-interval '31 seconds' WHERE id=${competingApprovalId}`;
  const resumed = await pollVaultChain();
  assert(resumed.resumedBroadcasts.includes(replacement.unsignedTxid));
  // Both transactions have authorized broadcast history. The node now knows
  // only Alice's confirmed winner; Bob's absent/rejected retry is visited first.
  winnerConfirmed = true;
  const polled = await pollVaultChain();
  assert(polled.confirmedTransactions.includes(proposal.unsignedTxid));
  assert(polled.broadcastErrors.some(item => item.txid === replacement.unsignedTxid));
  assert.equal(rejectedCompetingSends, 1);
  const [advancedCoin] = await sql`SELECT txid,round_id FROM vault_coins WHERE vault_id=${vaultId} AND status='current'`;
  assert.equal(advancedCoin.txid.toString('hex'), proposal.unsignedTxid);
  assert.equal(advancedCoin.round_id, 'bobcarol');
  const nextPoll = await pollVaultChain();
  assert.equal(nextPoll.broadcastErrors.length, 0);
  assert.equal(rejectedCompetingSends, 1);
  results.push({ issue: 'competing broadcast reconciliation', interruptedApprovalResumed: true, lostRpcAcknowledgementRemainsRetryable: true, rejectedCompetitorDidNotBlockWinner: true, onlyConfirmedWinnerAdvancedCoin: true, spentInputNotRetried: true });

  // Store boundary receives an already-verified assertion; this is not a WebAuthn bypass test.
  await sql`INSERT INTO passkey_envelopes (credential_id,version,prf_salt,iv,ciphertext,aad) VALUES (${credentials.alice},1,${Buffer.alloc(32)},${Buffer.alloc(12)},${Buffer.alloc(48)},${Buffer.alloc(32)})`;
  for (let revision = 1; revision <= 32; revision++) {
    await sql`INSERT INTO participant_sigbash_custody_versions (user_id,vault_id,participant_id,revision,version,iv,ciphertext,aad,envelope_hash) VALUES (${users.alice},${vaultId},'alice',${revision},1,${Buffer.alloc(12)},${Buffer.alloc(128)},${Buffer.alloc(64)},${Buffer.alloc(32,revision)})`;
  }
  const challengeId = randomUUID();
  await sql`INSERT INTO webauthn_challenges (id,kind,challenge,user_id,credential_id,prf_salt,expires_at) VALUES (${challengeId},'sigbash_custody','synthetic-verified-assertion',${users.alice},${credentials.alice},${Buffer.alloc(32)},now()+interval '15 minutes')`;
  const unlocked = await completeSigbashCustodyAuthorization({ id: challengeId, challenge: 'synthetic-verified-assertion', prfSalt: Buffer.alloc(32), credential: { id: credentials.alice, name: 'Audit', userId: users.alice, publicKey: new Uint8Array([1]), counter: 1, transports: [], vaultId, participantId: 'alice' } },2);
  assert.equal(unlocked.custodyEnvelopes.length, 32);
  assert.equal(unlocked.nextRevision, 33);
  assert.equal(unlocked.nextAad, null);
  assert.equal(unlocked.participantEnvelope.ciphertext.length, 48);
  results.push({ issue: 'custody history exhaustion', allowedStoredRevisions: 32, readUnlockAvailable: true, furtherWritesAvailable: false });
  console.log(JSON.stringify({ passed: true, actualProviderContact: false, actualBlockchainContact: false, results }, null, 2));
} finally {
  releasePendingRpc();
  if (rpcServer) await new Promise<void>(resolve => rpcServer!.close(() => resolve()));
  if (previousRpcUrl === undefined) delete process.env.BITCOIN_RPC_URL;
  else process.env.BITCOIN_RPC_URL = previousRpcUrl;
  if (previousBackend === undefined) delete process.env.BITCOIN_BACKEND;
  else process.env.BITCOIN_BACKEND = previousBackend;
  for (const [key, value] of Object.entries(priorEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await sql.unsafe('DROP TRIGGER IF EXISTS audit_delay_proof_commit ON participant_sigbash_readiness_proofs').catch(() => undefined);
  await sql.unsafe('DROP FUNCTION IF EXISTS audit_delay_proof_commit()').catch(() => undefined);
  await closeDatabase();
  // Explicit dependency order keeps cleanup scoped to this fixture.
  await sql`DELETE FROM participant_sigbash_readiness_proofs WHERE vault_id=${vaultId}`;
  await sql`DELETE FROM vault_transaction_proposals WHERE vault_id=${vaultId}`;
  await sql`DELETE FROM vault_coins WHERE vault_id=${vaultId}`;
  await sql`DELETE FROM vaults WHERE id=${vaultId}`;
  await sql`DELETE FROM users WHERE id=ANY(${Object.values(users)}::uuid[])`;
  await sql.end({ timeout: 5 });
}
