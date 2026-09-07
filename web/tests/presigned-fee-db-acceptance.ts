/** Real PostgreSQL and network-disabled Core. Passkey persistence contract, not WebAuthn transport evidence. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import postgres from 'postgres';
import { withPresignedRegtest } from '../../scripts/lib/presigned-regtest.js';
import { newPresignedCeremony, type PresignedFundingEpoch } from '../../src/presigned/ceremony.js';
import { createPresignedCoreBackend, type PresignedCoreRpc } from '../../src/presigned/core.js';
import { buildPresignedFeeDraft, validatePresignedFeePackage, type PresignedFeeDraft, type PresignedFeePackage } from '../../src/presigned/fee-package.js';
import { signPresignedFeePayout } from '../../src/presigned/fees.js';
import { authorizePresignedFundingFeeWalletPsbt } from '../../src/presigned/funding-fees.js';
import { createPresignedFixture, preauthorizePresignedFixture, signPresignedFixtureFunding } from '../../src/presigned/fixtures.js';
import { buildPresignedGraph } from '../../src/presigned/graph.js';
import { derivePresignedParticipantKeys } from '../../src/presigned/roster.js';
import { validatePresignedRuntimeAction, type PresignedRuntimeKind, type PresignedRuntimeState } from '../../src/presigned/runtime.js';
import { completePresignedExit } from '../../src/presigned/signing.js';
import { signPresignedSpendFeePayout } from '../../src/presigned/spend-fees.js';
import { createPresignedCooperativeNonce, createPresignedRecoveryContribution, signPresignedCooperativePartial, signPresignedFinalSweep } from '../../src/presigned/spends.js';
import { PARTICIPANT_IDS, PRESIGNED_PROTOCOL, type ParticipantId } from '../../src/presigned/types.js';
import { commitmentDigest } from '../../src/presigned/validation.js';
import { EXPECTED_MIGRATION_FILES } from '../lib/migrations.js';
import { closeDatabase } from '../lib/server/db.js';
import { exactAuthority } from '../lib/server/presigned-broadcast-store.js';
import { createPresignedFeeChallenge, completePresignedFeeChallenge, getPresignedFeeStatus,
  retryPresignedFeePackages, submitPresignedFeePackage, submitPresignedFeeForUser, type PresignedFeeDependencies } from '../lib/server/presigned-fee-store.js';
import { createPresignedRuntimeActionChallenge, completePresignedRuntimeAction } from '../lib/server/presigned-runtime-store.js';

assert(process.env.DATABASE_URL && process.env.VAULT_NETWORK === 'signet' && process.env.PRESIGNED_V2_BROADCAST_NETWORK === 'signet');
const url = new URL(process.env.DATABASE_URL);
assert(['127.0.0.1','localhost','[::1]'].includes(url.hostname) && /acceptance/u.test(url.pathname));
const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
const json = (value: unknown): any => JSON.parse(JSON.stringify(value));
const bytes = (value: string) => Buffer.from(value, 'hex');
const results: string[] = [];
let sends = 0;
try {
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations(version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  for (const file of EXPECTED_MIGRATION_FILES) await sql.unsafe(readFileSync(resolve('db/migrations', file), 'utf8'));
  await withPresignedRegtest(async core => {
    const genesisHash = createPresignedFixture().roster.genesisHash;
    // Explicit test-only chain identity bridge. All coins, blocks, signatures,
    // packages and replacement outcomes come from actual isolated regtest.
    const bridge: PresignedCoreRpc = async <T,>(method: string, params: unknown[] = []): Promise<T> => {
      try {
        if (['submitpackage','sendrawtransaction'].includes(method)) sends++;
        const value = await core.rpc(method, params);
        if (method === 'getblockchaininfo') return { ...value, chain: 'signet' } as T;
        if (method === 'getblockhash' && params[0] === 0) return genesisHash as T;
        return value as T;
      } catch (error) { throw Object.assign(new Error('isolated Core request failed'), { code: (error as any).rpcCode }); }
    };
    const backend = createPresignedCoreBackend({ network: 'signet', genesisHash, rpc: bridge });
    const dependencies: PresignedFeeDependencies = { backend, rpc: bridge, requiredConfirmations: 1, assertEnabled: () => undefined };
    async function freshFixture() {
      const fixture = createPresignedFixture(); const vaultId = randomUUID();
      fixture.participantSecrets = Object.fromEntries(PARTICIPANT_IDS.map(id => [id, randomBytes(32).toString('base64url')])) as typeof fixture.participantSecrets;
      const keys = PARTICIPANT_IDS.map(id => derivePresignedParticipantKeys(fixture.participantSecrets[id], id, vaultId));
      fixture.keysById = Object.fromEntries(keys.map(item => [item.publicIdentity.id, item.keys])) as typeof fixture.keysById;
      fixture.roster = { ...fixture.roster, vaultId, participants: keys.map(item => item.publicIdentity) };
      const coins = await core.fundScripts(PARTICIPANT_IDS.map(id => ({ scriptPubKeyHex: fixture.walletKeys[id].scriptPubKeyHex, valueSats: 12_000 })));
      fixture.graph = buildPresignedGraph({ roster: fixture.roster, funding: { ...fixture.graph.funding, epochId: randomUUID(),
        inputs: coins.map((coin, index) => ({ ...coin, participantId: PARTICIPANT_IDS[index]!, changeScriptPubKeyHex: coin.scriptPubKeyHex })) } });
      const sponsor = (await core.fundScripts([{ scriptPubKeyHex: fixture.walletKeys.alice.scriptPubKeyHex, valueSats: 20_000 }]))[0]!;
      const graph = fixture.graph; const funding = signPresignedFixtureFunding(fixture); const tx = bitcoin.Transaction.fromHex(funding.transactionHex);
      const epoch: PresignedFundingEpoch = { epochId: graph.funding.epochId, status: 'approved', inputs: graph.funding.inputs,
        graph, preauthorizations: preauthorizePresignedFixture(fixture), backups: [], walletSigningStarted: [...PARTICIPANT_IDS],
        signatures: PARTICIPANT_IDS.map((id, index) => ({ version: 2, protocol: PRESIGNED_PROTOCOL, graphDigest: graph.digest,
          participantId: id, inputIndex: index, witness: tx.ins[index]!.witness.map(value => Buffer.from(value).toString('hex')) })),
        finalization: funding, fundingApprovals: [...PARTICIPANT_IDS], restartApprovals: [] };
      const users = Object.fromEntries(PARTICIPANT_IDS.map(id => [id, randomUUID()])) as Record<ParticipantId, string>;
      const credentials = Object.fromEntries(PARTICIPANT_IDS.map(id => [id, `fee-acceptance-${randomUUID()}`])) as Record<ParticipantId, string>;
      await sql`INSERT INTO vaults(id,name,protocol) VALUES (${vaultId},'Isolated fee acceptance',${PRESIGNED_PROTOCOL})`;
      for (const id of PARTICIPANT_IDS) {
        const identity = graph.roster.participants.find(item => item.id === id)!;
        await sql`INSERT INTO users(id,display_name) VALUES (${users[id]},${`Synthetic ${id}`})`;
        await sql`INSERT INTO vault_members(vault_id,user_id,participant_id) VALUES (${vaultId},${users[id]},${id})`;
        await sql`INSERT INTO participant_key_material(user_id,vault_id,participant_id,personal_public_key,payout_xonly_public_key)
          VALUES (${users[id]},${vaultId},${id},${bytes(identity.personalPublicKeyHex)},${bytes(identity.payoutXonlyPublicKeyHex)})`;
        await sql`INSERT INTO webauthn_credentials(credential_id,user_id,public_key,counter,device_type,backed_up,prf_enabled,credential_name)
          VALUES (${credentials[id]},${users[id]},${randomBytes(64)},0,'multiDevice',true,true,'Synthetic PRF credential')`;
        await sql`INSERT INTO passkey_envelopes(credential_id,version,prf_salt,iv,ciphertext,aad)
          VALUES (${credentials[id]},1,${randomBytes(32)},${randomBytes(12)},${randomBytes(64)},${randomBytes(32)})`;
      }
      const ceremony = newPresignedCeremony(vaultId, { network: graph.roster.network, genesisHash, economics: graph.roster.economics,
        feePolicy: graph.roster.feePolicy, fundingFeeSats: graph.funding.feeSats });
      Object.assign(ceremony, { identities: graph.roster.participants, roster: graph.roster, rosterDigest: graph.rosterDigest,
        rosterApprovals: [...PARTICIPANT_IDS], epochs: [epoch] });
      await sql`INSERT INTO presigned_ceremonies(vault_id,settings_json,settings_digest,state_json,state_digest)
        VALUES (${vaultId},${sql.json(json(ceremony.settings))},${bytes(ceremony.settingsDigest)},${sql.json(json(ceremony))},
          ${bytes(commitmentDigest('vault/presigned-graph-v2/ceremony/state', ceremony))})`;
      await sql`INSERT INTO presigned_funding_epochs(epoch_id,vault_id,ordinal,status,graph_digest,funding_txid,snapshot_json,snapshot_digest)
        VALUES (${epoch.epochId},${vaultId},1,'approved',${bytes(graph.digest)},${bytes(graph.fundingTxid)},${sql.json(json(epoch))},
          ${bytes(commitmentDigest('vault/presigned-graph-v2/ceremony/epoch', epoch))})`;
      return { fixture, sponsor, users, credentials, epoch, funding, graph };
    }
    type Stored = Awaited<ReturnType<typeof freshFixture>>;
    async function runtimeAction(stored: Stored, id: ParticipantId, body: Record<string, unknown>) {
      const deps = { requiredConfirmations: 1, observeCoin: ({ source }: any) => backend.observeConfirmedCoin(source) };
      const challenge = await createPresignedRuntimeActionChallenge({ userId: stored.users[id], credentialId: stored.credentials[id],
        challenge: randomBytes(32).toString('base64url'), action: validatePresignedRuntimeAction({ version: 2, protocol: PRESIGNED_PROTOCOL, ...body }) }, deps);
      return (await completePresignedRuntimeAction(challenge, challenge.credential.counter + 1, deps)).proposal;
    }
    const bound = (state: PresignedRuntimeState, body: Record<string, unknown>) => ({ proposalId: state.proposal.proposalId,
      proposalDigest: state.proposal.digest, ...body });
    async function runtimeParent(stored: Stored, kind: PresignedRuntimeKind) {
      const graph = stored.graph; const keys = stored.fixture.keysById;
      await core.rpc('sendrawtransaction', [stored.funding.transactionHex]); await core.mine();
      let sourceExitId: string | null = null; const owner: ParticipantId = kind === 'final-sweep' ? 'carol' : 'alice';
      if (kind === 'final-sweep') {
        for (const exitId of ['alice','alice/bob']) {
          const exit = graph.exits.find(item => item.id === exitId)!;
          const signed = completePresignedExit({ graph, preauthorizations: stored.epoch.preauthorizations, exitId,
            participantId: exit.leaver, privateKey: keys[exit.leaver].soloPrivateKeys[exit.roundId]!, approvedGraphDigest: graph.digest });
          await core.rpc('sendrawtransaction', [signed.transactionHex]); await core.mine();
        }
        sourceExitId = 'alice/bob';
      }
      if (kind === 'recovery') await core.mine(graph.roster.economics.recoveryDelayBlocks - 1);
      const observation = await backend.observeConfirmedCoin({ txid: sourceExitId ? graph.exits.find(item => item.id === sourceExitId)!.txid : graph.fundingTxid,
        vout: sourceExitId ? 1 : 0 });
      let state = await runtimeAction(stored, owner, { kind: 'create-proposal', epochId: stored.epoch.epochId, graphDigest: graph.digest,
        proposalId: randomUUID(), spendKind: kind, sourceExitId, exitId: kind === 'solo' ? 'alice' : null,
        confirmationBlockHash: observation.confirmationBlockHash });
      if (kind === 'solo' || kind === 'final-sweep') {
        const signed = kind === 'solo' ? completePresignedExit({ graph, preauthorizations: stored.epoch.preauthorizations, exitId: 'alice',
          participantId: 'alice', privateKey: keys.alice.soloPrivateKeys[graph.exits.find(item => item.id === 'alice')!.roundId]!, approvedGraphDigest: graph.digest })
          : signPresignedFinalSweep({ graph, proposal: state.proposal.spend!, participantId: 'carol',
            payoutPrivateKey: keys.carol.payoutPrivateKey, approvedProposalDigest: state.proposal.spend!.digest });
        state = await runtimeAction(stored, owner, bound(state, { kind: 'finalize-transaction', transactionHex: signed.transactionHex }));
      } else if (kind === 'cooperative') {
        const nonces = PARTICIPANT_IDS.map(id => createPresignedCooperativeNonce({ graph, proposal: state.proposal.spend!, participantId: id,
          personalPrivateKey: keys[id].personalPrivateKey, approvedProposalDigest: state.proposal.spend!.digest }));
        for (const nonce of nonces) state = await runtimeAction(stored, nonce.publicNonce.participantId, bound(state, { kind: 'contribute-nonce', publicNonce: nonce.publicNonce }));
        for (const nonce of nonces) {
          const id = nonce.publicNonce.participantId;
          const partial = signPresignedCooperativePartial({ graph, proposal: state.proposal.spend!, participantId: id, personalPrivateKey: keys[id].personalPrivateKey,
            approvedProposalDigest: state.proposal.spend!.digest, publicNonces: state.publicNonces, nonceBinding: nonce.binding, consumedSecretNonce: nonce.secretNonce });
          state = await runtimeAction(stored, id, bound(state, { kind: 'contribute-partial', partial }));
        }
      } else for (const id of ['alice','bob'] as const) {
        const contribution = createPresignedRecoveryContribution({ graph, proposal: state.proposal.spend!, participantId: id,
          personalPrivateKey: keys[id].personalPrivateKey, approvedProposalDigest: state.proposal.spend!.digest });
        state = await runtimeAction(stored, id, bound(state, { kind: 'contribute-recovery', contribution }));
      }
      assert(state.finalized);
      for (const id of state.finalized.approverParticipantIds) state = await runtimeAction(stored, id,
        bound(state, { kind: 'approve-broadcast', transactionDigest: state.finalized!.transactionDigest }));
      return { state, owner, observation };
    }
    function walletPsbt(psbtBase64: string, stored: Stored, indexes: number[]) {
      const wallet = stored.fixture.walletKeys.alice; const psbt = bitcoin.Psbt.fromBase64(psbtBase64);
      const tx = bitcoin.Transaction.fromBuffer(psbt.data.globalMap.unsignedTx.toBuffer());
      for (const index of indexes) {
        const even = wallet.publicKey[0] === 3 ? ecc.privateNegate(wallet.privateKey) : wallet.privateKey;
        const key = ecc.privateAdd(even, bitcoin.crypto.taggedHash('TapTweak', wallet.publicKey.subarray(1)))!;
        const hash = tx.hashForWitnessV1(index, psbt.data.inputs.map(item => item.witnessUtxo!.script),
          psbt.data.inputs.map(item => item.witnessUtxo!.value), bitcoin.Transaction.SIGHASH_DEFAULT);
        psbt.updateInput(index, { tapKeySig: Buffer.from(ecc.signSchnorr(hash, key)) });
      }
      return psbt.toBase64();
    }
    async function makePackage(stored: Stored, parent: Awaited<ReturnType<typeof runtimeParent>> | null, previous: string | null = null): Promise<PresignedFeePackage> {
      const graph = stored.graph; const authority = await exactAuthority(graph.roster.vaultId, stored.epoch.epochId, parent?.state.proposal.proposalId ?? null);
      const sponsorInput = await backend.observeConfirmedCoin(stored.sponsor);
      const approval = { childFeeSats: previous ? 2_000 : 1_000, maxChildFeeSats: 5_000, targetPackageRateMillisatsPerVbyte: 1_000,
        minRelayRateMillisatsPerVbyte: 1_000, sponsorChangeScriptPubKeyHex: sponsorInput.scriptPubKeyHex, approveExactNoChangeFee: false,
        replacement: previous ? { previousChildTransactionHex: previous, incrementalRelayRateMillisatsPerVbyte: 1_000 } : null };
      const base = { version: 2 as const, protocol: PRESIGNED_PROTOCOL, epochId: stored.epoch.epochId,
        proposalId: parent?.state.proposal.proposalId ?? null, parentAuthorityDigest: authority.digest, ownerParticipantId: parent?.owner ?? 'alice' as ParticipantId };
      let draft: PresignedFeeDraft;
      if (!parent) draft = { ...base, mode: 'funding', request: { graph, fundingTransactionHex: authority.transactionHex, changeParticipantId: 'alice',
        fundingInputObservations: await Promise.all(graph.funding.inputs.map(coin => backend.observeConfirmedCoin(coin))), sponsorInput, approval } };
      else if (parent.state.proposal.kind === 'solo') draft = { ...base, mode: 'solo', request: { graph, exitId: 'alice', parentTransactionHex: authority.transactionHex,
        roundInputObservation: await backend.observeConfirmedCoin(parent.state.proposal.source), sponsorInput, approval } };
      else draft = { ...base, mode: 'spend', request: { graph, parentSpendProposal: parent.state.proposal.spend!, parentTransactionHex: authority.transactionHex,
        payoutParticipantId: parent.owner, sourceObservation: await backend.observeConfirmedCoin(parent.state.proposal.source), sponsorInput, approval } };
      const built = buildPresignedFeeDraft(draft);
      if (draft.mode === 'funding') return { ...draft, signatures: authorizePresignedFundingFeeWalletPsbt({ request: draft.request,
        roles: ['change','sponsor'], signedPsbtBase64: walletPsbt(built.psbtBase64, stored, [0,1]), approvalDigest: built.approvalDigest }) };
      const keys = stored.fixture.keysById[base.ownerParticipantId];
      const signed = draft.mode === 'solo' ? signPresignedFeePayout({ request: draft.request, psbtBase64: built.psbtBase64, approvalDigest: built.approvalDigest, keys })
        : signPresignedSpendFeePayout({ request: draft.request, psbtBase64: built.psbtBase64, approvalDigest: built.approvalDigest, keys });
      return { ...draft, signatures: { payoutSignatureHex: signed.payoutSignatureHex,
        sponsorSignedPsbtBase64: walletPsbt(built.psbtBase64, stored, [1]) } };
    }
    async function approve(stored: Stored, value: PresignedFeePackage) {
      const id = value.ownerParticipantId;
      const challenge = await createPresignedFeeChallenge({ userId: stored.users[id], credentialId: stored.credentials[id],
        challenge: randomBytes(32).toString('base64url'), package: value }, dependencies);
      const completed = await completePresignedFeeChallenge(challenge, challenge.credential.counter + 1, dependencies);
      await assert.rejects(() => completePresignedFeeChallenge(challenge, challenge.credential.counter + 2, dependencies), /consumed|superseded|expired/);
      return completed;
    }
    async function prepare(id: string) {
      // Test-only simulation of the exact explicit-user send transition;
      // submitPresignedFeeForUser itself is separately owner/flag-checked below.
      await sql`UPDATE presigned_fee_packages SET status = 'prepared' WHERE id = ${id}::uuid AND status = 'approved'`;
    }
    for (const kind of ['funding','solo','cooperative','recovery','final-sweep'] as const) {
      const stored = await freshFixture();
      const parent = kind === 'funding' ? null : await runtimeParent(stored, kind);
      const value = await makePackage(stored, parent); const checked = validatePresignedFeePackage(value);
      const owner = value.ownerParticipantId;
      const changed = json(value); changed.parentAuthorityDigest = '11'.repeat(32);
      await assert.rejects(() => createPresignedFeeChallenge({ userId: stored.users[owner], credentialId: stored.credentials[owner],
        challenge: randomBytes(32).toString('base64url'), package: changed }, dependencies), /approved parent/);
      const approved = await approve(stored, value); assert.equal(approved.status, 'approved');
      const beforeSend = sends;
      await submitPresignedFeePackage(approved.packageId, dependencies);
      assert.equal(sends, beforeSend, 'approval alone must never enter the send queue');
      assert.equal((await sql`SELECT status FROM presigned_fee_packages WHERE id = ${approved.packageId}`)[0]!.status, 'approved');
      await assert.rejects(() => submitPresignedFeeForUser(stored.users[owner === 'alice' ? 'bob' : 'alice'], approved.packageId), /belong/);
      await assert.rejects(() => sql`UPDATE presigned_fee_packages SET package_digest = ${Buffer.alloc(32)} WHERE id = ${approved.packageId}`, /immutable/);
      await prepare(approved.packageId);
      let lost = false;
      const loseReply: PresignedCoreRpc = async <T,>(method: string, params?: unknown[]): Promise<T> => {
        const result = await bridge<T>(method, params);
        if (!lost && method === 'submitpackage') { lost = true; throw new Error('synthetic lost reply after real Core acceptance'); }
        return result;
      };
      assert.equal((await submitPresignedFeePackage(approved.packageId, { ...dependencies, rpc: loseReply })).status, 'deferred');
      const afterLost = sends;
      assert.equal((await submitPresignedFeePackage(approved.packageId, dependencies)).status, 'accepted');
      assert.equal(sends, afterLost, 'lost acknowledgement retry must discover exact existing child without another send');
      const replacement = await makePackage(stored, parent, checked.completed.transactionHex);
      const replacementChecked = validatePresignedFeePackage(replacement);
      const replacementApproved = await approve(stored, replacement); await prepare(replacementApproved.packageId);
      assert.equal((await submitPresignedFeePackage(replacementApproved.packageId, dependencies)).status, 'accepted');
      assert.equal((await sql`SELECT status FROM presigned_fee_packages WHERE id = ${approved.packageId}`)[0]!.status, 'superseded');
      const pool = await core.rpc('getrawmempool'); assert(pool.includes(replacementChecked.completed.txid) && !pool.includes(checked.completed.txid));
      await core.mine();
      assert((await core.rpc('getrawtransaction', [replacementChecked.completed.txid, true])).confirmations >= 1);
      await closeDatabase(); // Actual connection recreation simulates worker restart, not saved in-memory authority.
      const afterMine = sends;
      assert.equal((await submitPresignedFeePackage(replacementApproved.packageId, dependencies)).status, 'accepted'); assert.equal(sends, afterMine);
      const own = await getPresignedFeeStatus(stored.users[owner]); assert(own.packages.some(item => item.id === replacementApproved.packageId && item.status === 'accepted'));
      const other = await getPresignedFeeStatus(stored.users[owner === 'alice' ? 'bob' : 'alice']); assert.equal(other.packages.length, 0);
      results.push(`${kind}: exact authority, replay rejection, explicit send, lost response, replacement, mined restart and owner isolation`);
      console.log(JSON.stringify({ stage: kind, passed: true }));
    }
    {
      const stored = await freshFixture(); const value = await makePackage(stored, null);
      const checked = validatePresignedFeePackage(value);
      // The user may sign an offline fee child while the parent is pending,
      // then return after only the parent confirmed. Preserve that valid child.
      await core.rpc('sendrawtransaction', [stored.funding.transactionHex]); await core.mine();
      const approved = await approve(stored, value); await prepare(approved.packageId);
      const before = sends;
      assert.equal((await submitPresignedFeePackage(approved.packageId, dependencies)).status, 'accepted');
      assert.equal(sends, before + 1, 'confirmed-parent rescue sends only the exact child');
      await core.mine(); assert((await core.rpc('getrawtransaction', [checked.completed.txid, true])).confirmations >= 1);
      results.push('parent confirmed while the independently signed child was offline; fresh approval and child-only send remain available');
      console.log(JSON.stringify({ stage: 'parent-confirmed-before-fee-approval', passed: true }));

      // Synthetic public journal rows exercise scheduling, not fee authority.
      // Each old row is deliberately invalid and must fail before any Core send.
      await sql`INSERT INTO presigned_fee_packages (vault_id, epoch_id, user_id, participant_id,
        package_json, package_digest, status, created_at, updated_at)
        SELECT ${stored.graph.roster.vaultId}::uuid, ${stored.epoch.epochId}::uuid, ${stored.users.alice}::uuid, 'alice',
          '{}'::jsonb, decode(lpad(to_hex(i), 64, '0'), 'hex'), 'accepted',
          '2000-01-01'::timestamptz + i * interval '1 second', '2000-01-01'::timestamptz + i * interval '1 second'
        FROM generate_series(1, 100) AS i`;
      const unqueued: string[] = [];
      for (const status of ['approved', 'superseded', 'submitting']) {
        const id = randomUUID(); unqueued.push(id);
        await sql`INSERT INTO presigned_fee_packages (id, vault_id, epoch_id, user_id, participant_id,
          package_json, package_digest, status, created_at, updated_at)
          VALUES (${id}, ${stored.graph.roster.vaultId}, ${stored.epoch.epochId}, ${stored.users.alice}, 'alice',
            '{}'::jsonb, ${randomBytes(32)}, ${status}, '1999-01-01', now() + interval '1 day')`;
      }
      await sql`UPDATE presigned_fee_packages SET status = 'deferred', updated_at = now() WHERE id = ${approved.packageId}`;
      const beforeRetries = sends;
      const firstRetry = await retryPresignedFeePackages(dependencies);
      assert.equal(firstRetry.results.length, 100);
      assert(!firstRetry.results.some(row => row.packageId === approved.packageId));
      const secondRetry = await retryPresignedFeePackages(dependencies);
      assert(secondRetry.results.some(row => row.packageId === approved.packageId && row.status === 'accepted'),
        '100 old accepted/deferred fee rows must not starve a newer interrupted exact package');
      assert.equal(sends, beforeRetries, 'retry must rediscover confirmed packages without resending');
      const protectedRows = await sql`SELECT id, status, attempt_count FROM presigned_fee_packages WHERE id IN ${sql(unqueued)}`;
      assert.equal(protectedRows.length, 3);
      assert(protectedRows.every(row => row.attempt_count === 0 && ['approved','superseded','submitting'].includes(row.status)));
      results.push('fee retry queue rotates beyond 100 retained rows without sending approved-only, superseded or actively claimed packages');
      console.log(JSON.stringify({ stage: 'fee-retry-fairness', passed: true }));
    }
    const summary = { passed: true, protocol: PRESIGNED_PROTOCOL, actualChain: 'isolated-regtest', networkIdentityBridge: true,
      actualDatabase: 'isolated-PostgreSQL', realWebAuthnTransport: false, realDefaultSignetEvidence: false,
      publicNetworkBroadcasts: 0, feeFamilies: 5, results };
    core.record('fee-db-acceptance', summary); console.log(JSON.stringify(summary, null, 2));
  });
} finally { await closeDatabase(); await sql.end(); }
