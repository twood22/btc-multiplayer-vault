import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import postgres from 'postgres';
import { deterministicKeypair, sha256Hex } from '../../src/crypto.js';
import { buildFundingProposal, fundingInputCommitmentDigest, type FundingInputCommitment } from '../../src/funding-ceremony.js';
import { authorizeFundingSignedPsbt, finalizeFundingSignatures } from '../../src/funding-signing.js';
import { BITCOIN_CORE_CHAIN, BITCOIN_NETWORK_NAME } from '../../src/network.js';
import { unsignedTx } from '../../src/psbt.js';
import { closeDatabase } from '../lib/server/db.js';
import { getFundingSigningStatus, submitPasskeyApprovedFunding } from '../lib/server/funding-signature-store.js';
import { createIsolatedSoloFixture, SOLO_PARTICIPANTS } from './solo-signing-fixture.js';

// Disposable PostgreSQL and loopback RPC only. Stored passkey approvals are
// synthetic prerequisites; wallet signatures and transaction validation are real.
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for funding submission acceptance');
const sql = postgres(process.env.DATABASE_URL, { max: 2, onnotice: () => {} });
const vaultId = randomUUID();
const fixture = createIsolatedSoloFixture(vaultId);
const users = Object.fromEntries(SOLO_PARTICIPANTS.map(id => [id, randomUUID()]));
const credentials = Object.fromEntries(SOLO_PARTICIPANTS.map(id => [id, `funding-audit-${randomUUID()}`]));
const walletKeys = Object.fromEntries(SOLO_PARTICIPANTS.map(id => [
  id, deterministicKeypair('funding-submission-acceptance', `${vaultId}:${id}`),
]));
const b = (hex: string) => Buffer.from(hex, 'hex');
const commitments: FundingInputCommitment[] = fixture.artifact.participants.map(participant => ({
  version: 1,
  network: BITCOIN_NETWORK_NAME,
  vaultId,
  rosterDigest: fixture.digest,
  participantId: participant.id,
  txid: sha256Hex(`funding-submission-input:${vaultId}:${participant.id}`),
  vout: 0,
  valueSats: fixture.artifact.economics.depositSatsPerParticipant + 530,
  scriptPubKeyHex: `5120${walletKeys[participant.id]!.xonlyPubKeyHex}`,
  changeAddress: participant.payoutAddress,
  sourceOrigin: 'https://chain.example',
  confirmations: 2,
  observedUnspent: true,
  fundingFeeSats: 600,
}));
const proposal = buildFundingProposal({ artifact: fixture.artifact, commitments, fundingFeeSats: 600 });
const signed = SOLO_PARTICIPANTS.map((participantId, index) => {
  const psbt = bitcoin.Psbt.fromBase64(proposal.psbtBase64);
  const sighash = unsignedTx(psbt).hashForWitnessV1(
    index,
    commitments.map(input => b(input.scriptPubKeyHex)),
    commitments.map(input => BigInt(input.valueSats)),
    bitcoin.Transaction.SIGHASH_DEFAULT,
  );
  psbt.updateInput(index, { tapKeySig: ecc.signSchnorr(sighash, b(walletKeys[participantId]!.privateKeyHex)) });
  return authorizeFundingSignedPsbt({ proposal, commitments, participantId, signedPsbtBase64: psbt.toBase64() });
});
const finalized = finalizeFundingSignatures({ proposal, commitments, contributions: signed.map(item => item.contribution) });
const submission = {
  vaultId,
  expectedFinalizationDigest: finalized.finalizationDigest,
  expectedFinalTxid: finalized.finalTxid,
};
let mode: 'preflight-rejected' | 'lost-response' | 'observed' = 'preflight-rejected';
let sendCount = 0;
let acceptedTransaction = false;
let holdNextPreflight = false;
let signalHeldPreflight = () => {};
let releaseHeldPreflight = () => {};
const preflightHeld = new Promise<void>(resolve => { signalHeldPreflight = resolve; });
const preflightReleased = new Promise<void>(resolve => { releaseHeldPreflight = resolve; });
const rpcErrors: unknown[] = [];
const rpc = createServer(async (request, response) => {
  try {
    let body = '';
    for await (const chunk of request) body += chunk;
    const call = JSON.parse(body) as { id: string; method: string; params: unknown[] };
    let result: unknown = null;
    let error: { code: number; message: string } | null = null;
    switch (call.method) {
      case 'getblockchaininfo':
        result = { chain: BITCOIN_CORE_CHAIN, blocks: 100, headers: 100, pruned: false, initialblockdownload: false };
        break;
      case 'getindexinfo':
        result = { txindex: { synced: true } };
        break;
      case 'testmempoolaccept': {
        assert.deepEqual(call.params[0], [finalized.transactionHex]);
        const rejected = mode === 'preflight-rejected';
        if (holdNextPreflight) {
          holdNextPreflight = false;
          signalHeldPreflight();
          await preflightReleased;
        }
        result = [{
          txid: finalized.finalTxid,
          allowed: !rejected,
          'reject-reason': rejected ? 'fixture preflight rejection' : undefined,
          vsize: finalized.vsize,
          fees: { base: finalized.feeSats / 100_000_000 },
        }];
        break;
      }
      case 'sendrawtransaction':
        assert.equal(call.params[0], finalized.transactionHex);
        sendCount += 1;
        acceptedTransaction = true;
        // Accepted bytes with a lost acknowledgement, followed by unavailable
        // reads. This cannot be interpreted as proof the send was rejected.
        error = { code: -28, message: 'fixture acknowledgement unavailable' };
        break;
      case 'getrawtransaction':
        assert.equal(call.params[0], finalized.finalTxid);
        if (mode === 'observed') {
          assert(acceptedTransaction);
          result = { txid: finalized.finalTxid, hex: finalized.transactionHex, vin: [], vout: [] };
        } else {
          error = { code: acceptedTransaction ? -28 : -5, message: 'fixture transaction lookup unavailable' };
        }
        break;
      default:
        assert.fail(`unexpected fixture RPC method ${call.method}`);
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ id: call.id, result, error }));
  } catch (error) {
    rpcErrors.push(error);
    response.statusCode = 500;
    response.end(JSON.stringify({ error: { code: -1, message: 'fixture assertion failed' } }));
  }
});
const environment = {
  BITCOIN_BACKEND: 'core',
  BITCOIN_RPC_URL: '',
  BITCOIN_RPC_USER: '',
  BITCOIN_RPC_USERNAME: '',
  BITCOIN_RPC_PASSWORD: '',
  WEBAUTHN_RP_ID: 'localhost',
  WEBAUTHN_ORIGIN: 'http://localhost:3000',
  APP_ORIGIN: 'http://localhost:3000',
  CHAIN_OBSERVATION_ORIGINS: 'https://chain.example',
  VAULT_CONFIRMATIONS_REQUIRED: '1',
};
const previousEnvironment = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
try {
  await new Promise<void>(resolve => rpc.listen(0, '127.0.0.1', resolve));
  const address = rpc.address();
  assert(address && typeof address !== 'string');
  environment.BITCOIN_RPC_URL = `http://127.0.0.1:${address.port}`;
  Object.assign(process.env, environment);
  await sql`INSERT INTO vaults (id,name,status) VALUES (${vaultId},'Isolated funding submission audit','ready')`;
  await sql`INSERT INTO vault_rosters (vault_id,version,network,artifact_json,digest,funding_address,status,confirmed_at)
    VALUES (${vaultId},1,${BITCOIN_NETWORK_NAME},${sql.json(JSON.parse(JSON.stringify(fixture.artifact)))},${b(fixture.digest)},${fixture.artifact.funding.address},'confirmed',now())`;
  for (const [index, participantId] of SOLO_PARTICIPANTS.entries()) {
    const commitment = commitments[index]!;
    const { contribution, contributionDigest } = signed[index]!;
    const inputChallengeId = randomUUID();
    const signatureChallengeId = randomUUID();
    const identity = { vault_id: vaultId, user_id: users[participantId]!, participant_id: participantId, credential_id: credentials[participantId]! };
    const ceremony = { challenge: 'synthetic-already-verified-assertion', expires_at: new Date(Date.now() + 60_000), consumed_at: new Date() };
    await sql`INSERT INTO users (id,display_name) VALUES (${users[participantId]!},${participantId})`;
    await sql`INSERT INTO vault_members (vault_id,user_id,participant_id) VALUES (${vaultId},${users[participantId]!},${participantId})`;
    await sql`INSERT INTO webauthn_credentials (credential_id,user_id,public_key,counter,device_type,backed_up,prf_enabled)
      VALUES (${credentials[participantId]!},${users[participantId]!},${Buffer.from([1])},0,'singleDevice',false,true)`;
    const inputRow = {
      ...identity, roster_digest: b(fixture.digest), txid: b(commitment.txid), vout: commitment.vout,
      value_sats: commitment.valueSats, script_pubkey: b(commitment.scriptPubKeyHex),
      change_address: commitment.changeAddress, source_origin: commitment.sourceOrigin,
      confirmations: commitment.confirmations, funding_fee_sats: commitment.fundingFeeSats,
      commitment_digest: b(fundingInputCommitmentDigest(commitment)),
    };
    await sql`INSERT INTO funding_input_challenges ${sql({ ...inputRow, ...ceremony, id: inputChallengeId })}`;
    await sql`INSERT INTO participant_funding_inputs ${sql({ ...inputRow, challenge_id: inputChallengeId })}`;
    const signatureRow = {
      ...identity, roster_digest: b(fixture.digest), proposal_digest: b(proposal.digest), input_index: index,
      signature_kind: contribution.kind, signature: b(contribution.signatureHex), public_key: null,
      contribution_digest: b(contributionDigest),
    };
    await sql`INSERT INTO funding_signature_challenges ${sql({ ...signatureRow, ...ceremony, id: signatureChallengeId })}`;
    await sql`INSERT INTO participant_funding_signatures ${sql({ ...signatureRow, challenge_id: signatureChallengeId })}`;
  }
  await sql`INSERT INTO funding_finalizations (vault_id,roster_digest,proposal_digest,finalization_digest,final_txid,transaction_hex,fee_sats,vsize,status,approved_at)
    VALUES (${vaultId},${b(fixture.digest)},${b(proposal.digest)},${b(finalized.finalizationDigest)},${b(finalized.finalTxid)},${finalized.transactionHex},${finalized.feeSats},${finalized.vsize},'approved',now())`;
  for (const participantId of SOLO_PARTICIPANTS) {
    const challengeId = randomUUID();
    const row = {
      vault_id: vaultId, user_id: users[participantId]!, participant_id: participantId,
      credential_id: credentials[participantId]!, finalization_digest: b(finalized.finalizationDigest),
    };
    await sql`INSERT INTO funding_final_approval_challenges ${sql({
      ...row, id: challengeId, challenge: 'synthetic-final-approval',
      expires_at: new Date(Date.now() + 60_000), consumed_at: new Date(),
    })}`;
    await sql`INSERT INTO funding_final_approvals ${sql({ ...row, challenge_id: challengeId })}`;
  }

  // A fresh failure before send is safe to release for a unanimous restart.
  await assert.rejects(() => submitPasskeyApprovedFunding(submission), /fixture preflight rejection/);
  assert.equal((await sql`SELECT status FROM funding_finalizations WHERE vault_id=${vaultId}`)[0]!.status, 'approved');
  assert.equal(sendCount, 0);
  assert((await getFundingSigningStatus(users.alice!)).restartStateDigest);

  // Pause a fresh attempt before send, then let another operator reclaim the
  // lease. The stale preflight must not unlock the newer, possibly sent attempt.
  holdNextPreflight = true;
  const oldAttempt = assert.rejects(() => submitPasskeyApprovedFunding(submission), /fixture preflight rejection/);
  await preflightHeld;
  await sql`UPDATE funding_finalizations
    SET submission_started_at=date_trunc('milliseconds',now()-interval '11 minutes')+interval '123 microseconds'
    WHERE vault_id=${vaultId}`;
  mode = 'lost-response';
  await assert.rejects(() => submitPasskeyApprovedFunding(submission), /fixture acknowledgement unavailable/);
  releaseHeldPreflight();
  await oldAttempt;
  const [uncertain] = await sql`SELECT status,submission_started_at,broadcast_failure FROM funding_finalizations WHERE vault_id=${vaultId}`;
  assert.equal(uncertain!.status, 'submitting', 'a possibly accepted funding transaction must remain restart-locked');
  assert(uncertain!.submission_started_at);
  assert.match(uncertain!.broadcast_failure, /fixture acknowledgement unavailable/);
  assert.equal((await getFundingSigningStatus(users.alice!)).restartStateDigest, null);
  await assert.rejects(() => submitPasskeyApprovedFunding(submission), /still in progress/);
  assert.equal(sendCount, 1);

  // A later failed preflight cannot erase uncertainty from the original send.
  await sql`UPDATE funding_finalizations
    SET submission_started_at=date_trunc('milliseconds',now()-interval '11 minutes')+interval '123 microseconds'
    WHERE vault_id=${vaultId}`;
  mode = 'preflight-rejected';
  await assert.rejects(() => submitPasskeyApprovedFunding(submission), /fixture preflight rejection/);
  assert.equal((await sql`SELECT status FROM funding_finalizations WHERE vault_id=${vaultId}`)[0]!.status, 'submitting');
  assert.equal((await getFundingSigningStatus(users.alice!)).restartStateDigest, null);
  assert.equal(sendCount, 1);

  mode = 'observed';
  const result = await submitPasskeyApprovedFunding(submission);
  assert.equal(result.status, 'broadcast');
  assert.equal(result.alreadySubmitted, true);
  assert.equal((await sql`SELECT status FROM funding_finalizations WHERE vault_id=${vaultId}`)[0]!.status, 'broadcast');
  assert.equal(sendCount, 1, 'recovering the exact accepted transaction must not require another send');
  assert.deepEqual(rpcErrors, []);
  console.log(JSON.stringify({
    ok: true, network: BITCOIN_NETWORK_NAME, freshPreflightFailureRestartable: true,
    lostAcknowledgementRestartLocked: true, stalePreflightRetainsUncertainty: true,
    oldAttemptCannotReleaseNewerClaim: true, databaseTimestampPrecisionPreserved: true,
    exactTransactionRecoveredWithoutResending: true, externalCalls: false,
  }, null, 2));
} finally {
  releaseHeldPreflight();
  await new Promise<void>((resolve, reject) => rpc.close(error => error ? reject(error) : resolve()));
  await sql`DELETE FROM funding_final_approvals WHERE vault_id=${vaultId}`;
  await sql`DELETE FROM funding_final_approval_challenges WHERE vault_id=${vaultId}`;
  await sql`DELETE FROM participant_funding_signatures WHERE vault_id=${vaultId}`;
  await sql`DELETE FROM funding_signature_challenges WHERE vault_id=${vaultId}`;
  await sql`DELETE FROM participant_funding_inputs WHERE vault_id=${vaultId}`;
  await sql`DELETE FROM funding_input_challenges WHERE vault_id=${vaultId}`;
  await sql`DELETE FROM vaults WHERE id=${vaultId}`;
  for (const id of Object.values(users)) await sql`DELETE FROM users WHERE id=${id}`;
  await closeDatabase();
  await sql.end({ timeout: 5 });
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
