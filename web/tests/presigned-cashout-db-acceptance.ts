import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as bitcoin from 'bitcoinjs-lib';
import postgres from 'postgres';
import { withPresignedRegtest } from '../../scripts/lib/presigned-regtest.js';
import { createPresignedCoreBackend, type PresignedCoreRpc } from '../../src/presigned/core.js';
import { createPresignedPublicKit, encryptPresignedOfflineBackup, presignedBackupBinding, withRestoredPresignedOfflineBackup } from '../../src/presigned/backup.js';
import { buildPresignedCashout, signPresignedCashout, type PresignedCashoutRequest } from '../../src/presigned/cashout.js';
import { newPresignedCeremony, type PresignedFundingEpoch } from '../../src/presigned/ceremony.js';
import { createPresignedFixture, authorizePresignedFixtureRecoveries, preauthorizePresignedFixture, signPresignedFixtureFunding } from '../../src/presigned/fixtures.js';
import { buildPresignedGraph } from '../../src/presigned/graph.js';
import { clearPresignedParticipantKeys, derivePresignedParticipantKeys } from '../../src/presigned/roster.js';
import { buildPresignedSpend, createPresignedRecoveryContribution, finalizePresignedRecovery } from '../../src/presigned/spends.js';
import { FIXED_RECOVERY_POLICY, PARTICIPANT_IDS, PRESIGNED_PROTOCOL, PRESIGNED_PROTOCOL_V3, type ParticipantId } from '../../src/presigned/types.js';
import { commitmentDigest, networkParameters, presignedDomain } from '../../src/presigned/validation.js';
import { EXPECTED_MIGRATION_FILES } from '../lib/migrations.js';
import { closeDatabase } from '../lib/server/db.js';
import { presignedBroadcastEnabled } from '../lib/server/presigned-broadcast-store.js';
import { getPresignedCashoutStatus, preparePresignedCashout, queuePresignedCashout, retryPresignedCashouts,
  submitPresignedCashout, type PresignedCashoutDependencies, type PresignedSignedCashout } from '../lib/server/presigned-cashout-store.js';

assert(process.env.DATABASE_URL && process.env.VAULT_NETWORK === 'signet' && process.env.PRESIGNED_V2_BROADCAST_NETWORK === 'signet');
const endpoint = new URL(process.env.DATABASE_URL);
assert(['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname) && /acceptance/u.test(endpoint.pathname));
const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
const json = (value: unknown): any => JSON.parse(JSON.stringify(value));
const bytes = (hex: string) => Buffer.from(hex, 'hex');
const protocol = PRESIGNED_PROTOCOL_V3;
const checks: string[] = [];
try {
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations(version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  for (const file of EXPECTED_MIGRATION_FILES) if (!(await sql`SELECT 1 FROM schema_migrations WHERE version=${file.slice(0,-4)}`).length)
    await sql.unsafe(readFileSync(resolve('db/migrations',file),'utf8'));
  await withPresignedRegtest(async core => {
    const fixture = createPresignedFixture({ protocol });
    const bridge: PresignedCoreRpc = async <T>(method: string, params: unknown[] = []): Promise<T> => {
      try {
        const value = await core.rpc(method, params);
        if (method === 'getblockchaininfo') return { ...value, chain: 'signet' } as T;
        if (method === 'getblockhash' && params[0] === 0) return fixture.roster.genesisHash as T;
        return value as T;
      } catch (error) { throw Object.assign(new Error('isolated Core rejected cash-out check'), { code: (error as { rpcCode?: number }).rpcCode }); }
    };
    const backend = createPresignedCoreBackend({ network: 'signet', genesisHash: fixture.roster.genesisHash, rpc: bridge });
    let sends = 0;
    const counted: PresignedCoreRpc = async <T>(method: string, params?: unknown[]): Promise<T> => {
      if (method === 'sendrawtransaction') sends++;
      return bridge<T>(method, params);
    };
    const dependencies: PresignedCashoutDependencies = { backend, rpc: counted, requiredConfirmations: 1,
      assertEnabled: protocol => assert(presignedBroadcastEnabled(protocol)) };
    async function mine(count = 1) {
      const blocks = await core.mine(count);
      for (let i = 0; i < 100; i++) {
        if ((await core.rpc('getindexinfo')).txindex?.synced === true) return blocks;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error('cash-out test txindex did not synchronize');
    }
    const coins = await core.fundScripts(PARTICIPANT_IDS.map(id => ({ scriptPubKeyHex: fixture.walletKeys[id].scriptPubKeyHex, valueSats: 12_000 })));
    fixture.graph = buildPresignedGraph({ roster: fixture.roster, funding: { ...fixture.graph.funding,
      inputs: coins.map((coin,index) => ({ ...coin, participantId: PARTICIPANT_IDS[index]!, changeScriptPubKeyHex: coin.scriptPubKeyHex })) } });
    const graph = fixture.graph;
    const preauthorizations = preauthorizePresignedFixture(fixture);
    const recoveryAuthorizations = authorizePresignedFixtureRecoveries(fixture);
    const publicKit = createPresignedPublicKit({ graph, preauthorizations, recoveryAuthorizations });
    const funding = signPresignedFixtureFunding(fixture);
    const fundingTx = bitcoin.Transaction.fromHex(funding.transactionHex);
    const epoch: PresignedFundingEpoch = { epochId: graph.funding.epochId, status: 'approved', inputs: graph.funding.inputs,
      graph, preauthorizations, recoveryAuthorizations, backups: [], walletSigningStarted: [...PARTICIPANT_IDS],
      signatures: PARTICIPANT_IDS.map((id,index) => ({ version: 3, protocol, graphDigest: graph.digest, participantId: id,
        inputIndex: index, witness: fundingTx.ins[index]!.witness.map(item => Buffer.from(item).toString('hex')) })),
      finalization: funding, fundingApprovals: [...PARTICIPANT_IDS], restartApprovals: [] };
    const state = newPresignedCeremony(graph.roster.vaultId, { protocol, recoveryPolicy: FIXED_RECOVERY_POLICY,
      network: 'signet', genesisHash: graph.roster.genesisHash, economics: graph.roster.economics,
      feePolicy: graph.roster.feePolicy, fundingFeeSats: graph.funding.feeSats });
    state.identities=graph.roster.participants; state.roster=graph.roster; state.rosterDigest=graph.rosterDigest;
    state.rosterApprovals=[...PARTICIPANT_IDS]; state.epochs=[epoch];
    const users = Object.fromEntries(PARTICIPANT_IDS.map(id => [id,randomUUID()])) as Record<ParticipantId,string>;
    await sql`INSERT INTO vaults(id,name,protocol) VALUES (${graph.roster.vaultId},'Isolated owner cash-out test',${protocol})`;
    for (const id of PARTICIPANT_IDS) {
      await sql`INSERT INTO users(id,display_name) VALUES (${users[id]},${`Synthetic ${id}`})`;
      await sql`INSERT INTO vault_members(vault_id,user_id,participant_id) VALUES (${graph.roster.vaultId},${users[id]},${id})`;
    }
    await sql`INSERT INTO presigned_ceremonies(vault_id,protocol,settings_json,settings_digest,state_json,state_digest)
      VALUES (${graph.roster.vaultId},${protocol},${sql.json(json(state.settings))},${bytes(state.settingsDigest)},
        ${sql.json(json(state))},${bytes(commitmentDigest(presignedDomain(protocol,'ceremony/state'),state))})`;
    await sql`INSERT INTO presigned_funding_epochs(epoch_id,vault_id,protocol,ordinal,status,graph_digest,funding_txid,snapshot_json,snapshot_digest)
      VALUES (${epoch.epochId},${graph.roster.vaultId},${protocol},1,'approved',${bytes(graph.digest)},${bytes(graph.fundingTxid)},
        ${sql.json(json(epoch))},${bytes(commitmentDigest(presignedDomain(protocol,'ceremony/epoch'),epoch))})`;
    await core.rpc('sendrawtransaction',[funding.transactionHex]); await mine(graph.roster.economics.recoveryDelayBlocks);
    const proposal = buildPresignedSpend({ graph, kind:'recovery',sourceExitId:null,proposalId:randomUUID() });
    const refund = finalizePresignedRecovery({ graph, proposal, recoveryAuthorizations,
      contributions: (['alice','bob'] as const).map(participantId => createPresignedRecoveryContribution({ graph,proposal,participantId,
        recoveryTriggerPrivateKey:fixture.keysById[participantId].recoveryTriggerPrivateKeys!.alicebobcarol!,approvedProposalDigest:proposal.digest })) });
    await core.rpc('sendrawtransaction',[refund.transactionHex]); const [refundBlock] = await mine();
    async function artifactFor(id: ParticipantId, feeSats=300): Promise<PresignedSignedCashout> {
      const sourceObservation = await backend.observeConfirmedCoin({ txid:refund.txid,vout:PARTICIPANT_IDS.indexOf(id) });
      const request: PresignedCashoutRequest = { publicKit,participantId:id,parentTransactionHex:refund.transactionHex,sourceObservation,
        destinationAddress:bitcoin.address.fromOutputScript(Buffer.from(fixture.walletKeys.alice.scriptPubKeyHex,'hex'),networkParameters('signet')),
        feeSats,maxFeeSats:1000 };
      const cashout = buildPresignedCashout(request);
      const offlineSecret = randomBytes(32);
      const envelope = await encryptPresignedOfflineBackup({ publicKit, participantId:id,participantSecret:fixture.participantSecrets[id],offlineSecret });
      try {
        const signed = await withRestoredPresignedOfflineBackup({ envelope,offlineSecret,expectedBinding:presignedBackupBinding(publicKit,id),
          action: restored => {
            const derived = derivePresignedParticipantKeys(restored.participantSecret,id,graph.roster.vaultId,protocol);
            try { return signPresignedCashout({ request,cashout,keys:derived.keys,approvedCashoutDigest:cashout.digest }); }
            finally { clearPresignedParticipantKeys(derived.keys); }
          } });
        return { request,cashout,transactionHex:signed.transactionHex };
      } finally { offlineSecret.fill(0); }
    }
    const value = await artifactFor('carol');
    await assert.rejects(() => preparePresignedCashout(users.alice,value,dependencies),/another vault, protocol or participant/);
    await assert.rejects(() => preparePresignedCashout(users.carol,{ ...value,cashout:{ ...value.cashout,version:2,protocol:PRESIGNED_PROTOCOL } },dependencies));
    const saved = await preparePresignedCashout(users.carol,value,dependencies);
    assert.equal(saved.status,'approved');
    assert.equal((await preparePresignedCashout(users.carol,value,dependencies)).cashoutId,saved.cashoutId);
    assert.equal((await getPresignedCashoutStatus(users.alice)).intents.length,0);
    assert.equal((await getPresignedCashoutStatus(users.carol)).intents.length,1);
    await assert.rejects(() => sql`UPDATE presigned_cashout_intents SET artifact_json='{}'::jsonb WHERE id=${saved.cashoutId}`,/immutable/);
    await assert.rejects(() => queuePresignedCashout(users.alice,saved.cashoutId),/not owned/);
    assert.equal((await retryPresignedCashouts(dependencies)).results.length,0);
    assert.equal(sends,0);
    checks.push('absent recovery participant independently restores payout key; own signed refund cash-out saved idempotently; cross-member/protocol and immutable mutations rejected; approved-only never sent');
    assert.equal((await queuePresignedCashout(users.carol,saved.cashoutId)).status,'prepared');
    let lost=true;
    const dropped: PresignedCoreRpc = async <T>(method:string,params?:unknown[]):Promise<T> => {
      const result=await counted<T>(method,params);
      if(method==='sendrawtransaction'&&lost){lost=false;throw new Error('synthetic lost reply after actual Core send');}
      return result;
    };
    assert.equal((await submitPresignedCashout(saved.cashoutId,{...dependencies,rpc:dropped})).status,'deferred');
    assert.equal(sends,1);
    await closeDatabase();
    assert.equal((await submitPresignedCashout(saved.cashoutId,dependencies)).status,'pending');
    assert.equal(sends,1);
    const [cashoutBlock] = await mine();
    assert.equal((await submitPresignedCashout(saved.cashoutId,dependencies)).status,'confirmed');
    assert.equal((await queuePresignedCashout(users.carol,saved.cashoutId)).status,'confirmed',
      'an idempotent request must not downgrade the retained confirmation if another watcher owns the lease');
    assert.equal((await preparePresignedCashout(users.carol,value,dependencies)).cashoutId,saved.cashoutId);
    await core.rpc('invalidateblock',[cashoutBlock]);
    assert.notEqual((await submitPresignedCashout(saved.cashoutId,dependencies)).status,'confirmed');
    await core.rpc('reconsiderblock',[cashoutBlock]);
    assert.equal((await submitPresignedCashout(saved.cashoutId,dependencies)).status,'confirmed');
    checks.push('exact durable send intent survives lost reply and new database pool without second send; actual Core confirmation/reorg/restoration never reports inactive confirmation as confirmed');
    const first = await artifactFor('bob',300); const alternate = await artifactFor('bob',500);
    const firstSaved=await preparePresignedCashout(users.bob,first,dependencies);
    await core.rpc('sendrawtransaction',[alternate.transactionHex]); await mine();
    await queuePresignedCashout(users.bob,firstSaved.cashoutId);
    assert.equal((await submitPresignedCashout(firstSaved.cashoutId,dependencies)).status,'spent');
    assert.equal(sends,1);
    checks.push('a different owner-signed confirmed spend marks the original intent spent without rebroadcast or any quorum signature');
    // The payout parent itself reanchors. Retained signed bytes stay immutable,
    // and no orphan source/old anchor may be called confirmed or spendable.
    await core.rpc('invalidateblock',[refundBlock]);
    assert.notEqual((await submitPresignedCashout(saved.cashoutId,dependencies)).status,'confirmed');
    await core.rpc('reconsiderblock',[refundBlock]);
    assert.equal((await submitPresignedCashout(saved.cashoutId,dependencies)).status,'confirmed');
    assert.equal((await getPresignedCashoutStatus(users.carol)).intents[0]!.txid,value.cashout.txid);
    checks.push('ancestor refund reorg preserves exact owner artifact and restores confirmed status only on the active chain');
    const summary = { passed:true,protocol,actualDatabase:'isolated-PostgreSQL',actualChain:'isolated-regtest',
      networkIdentityBridge:true,realDefaultSignetEvidence:false,realWebAuthnTransport:false,publicNetworkBroadcasts:0,
      missingParticipantRefundCashedOut:true,serverIndependentKeyRestoration:true,ownerCashoutSends:sends,checks };
    core.record('cashout-db-acceptance',summary); console.log(JSON.stringify(summary,null,2));
  },{maximumMinutes:45});
} finally { await closeDatabase(); await sql.end(); }
