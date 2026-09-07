import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as bitcoin from 'bitcoinjs-lib';
import postgres from 'postgres';
import { withPresignedRegtest } from '../../scripts/lib/presigned-regtest.js';
import { createPresignedCoreBackend, type PresignedCoreRpc } from '../../src/presigned/core.js';
import { newPresignedCeremony, type PresignedFundingEpoch } from '../../src/presigned/ceremony.js';
import { createPresignedFixture, preauthorizePresignedFixture, signPresignedFixtureFunding } from '../../src/presigned/fixtures.js';
import { buildPresignedGraph } from '../../src/presigned/graph.js';
import { derivePresignedParticipantKeys } from '../../src/presigned/roster.js';
import { completePresignedExit } from '../../src/presigned/signing.js';
import { createPresignedCooperativeNonce, signPresignedCooperativePartial, signPresignedFinalSweep } from '../../src/presigned/spends.js';
import { validatePresignedRuntimeAction, type PresignedRuntimeState, type PresignedRuntimeKind } from '../../src/presigned/runtime.js';
import { PARTICIPANT_IDS, PRESIGNED_PROTOCOL, type ParticipantId } from '../../src/presigned/types.js';
import { commitmentDigest } from '../../src/presigned/validation.js';
import { EXPECTED_MIGRATION_FILES } from '../lib/migrations.js';
import { closeDatabase } from '../lib/server/db.js';
import { getPresignedChainStatus, pollPresignedVaultChains } from '../lib/server/presigned-chain-store.js';
import { preparePresignedBroadcast, retryPresignedBroadcasts, submitPresignedBroadcast, type PresignedBroadcastDependencies } from '../lib/server/presigned-broadcast-store.js';
import { createPresignedRuntimeActionChallenge, completePresignedRuntimeAction } from '../lib/server/presigned-runtime-store.js';
import { withChainWatcherLease } from '../lib/server/watcher-lease.js';
import { presignedCoreRpc } from '../lib/server/presigned-core.js';

// Test-only RPC bridge relabels chain/genesis because production deliberately
// supports Signet/mainnet only. All transactions, headers, UTXOs, reorgs and
// policy results otherwise come from actual network-disabled Core 31.1.
// Production authentication and genuine Signet transport are NOT proven here.
assert(process.env.DATABASE_URL && process.env.VAULT_NETWORK === 'signet');
const dbUrl = new URL(process.env.DATABASE_URL);
assert(['127.0.0.1', 'localhost', '[::1]'].includes(dbUrl.hostname) && /(?:test|acceptance)/u.test(dbUrl.pathname));
assert.equal(process.env.PRESIGNED_V2_BROADCAST_NETWORK, 'signet', 'explicit disposable Signet-format policy flag required');
const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
const bytes = (hex: string) => Buffer.from(hex, 'hex');
const json = (value: unknown): any => JSON.parse(JSON.stringify(value));
const results: string[] = []; const findings: string[] = [];
const pass = (message: string) => { results.push(message); console.log(JSON.stringify({ stage: 'passed', message })); };
const note = (message: string) => { findings.push(message); console.log(JSON.stringify({ stage: 'reproduced-finding', message })); };

try {
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations(version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  for (const file of EXPECTED_MIGRATION_FILES) {
    if (!(await sql`SELECT 1 FROM schema_migrations WHERE version = ${file.slice(0, -4)}`).length)
      await sql.unsafe(readFileSync(resolve('db/migrations', file), 'utf8'));
  }
  const names = ['BITCOIN_RPC_URL', 'BITCOIN_RPC_USER', 'BITCOIN_RPC_USERNAME', 'BITCOIN_RPC_PASSWORD', 'BITCOIN_RPC_COOKIE_FILE'] as const;
  const prior = Object.fromEntries(names.map(name => [name, process.env[name]])); const originalFetch = globalThis.fetch;
  try {
    for (const name of names) delete process.env[name];
    process.env.BITCOIN_RPC_URL = 'http://127.0.0.1:1';
    let requests = 0;
    globalThis.fetch = async () => { requests++; throw new Error('synthetic network forbidden'); };
    await assert.rejects(() => presignedCoreRpc('getblockchaininfo'), /authentication is required/);
    process.env.BITCOIN_RPC_USER = 'public-test-fixture';
    await assert.rejects(() => presignedCoreRpc('getblockchaininfo'), /both RPC/);
    process.env.BITCOIN_RPC_PASSWORD = 'public-test-fixture';
    process.env.BITCOIN_RPC_URL = 'http://example.invalid';
    await assert.rejects(() => presignedCoreRpc('getblockchaininfo'), /requires HTTPS/);
    process.env.BITCOIN_RPC_URL = 'https://user:pass@example.invalid';
    await assert.rejects(() => presignedCoreRpc('getblockchaininfo'), /configuration is invalid/);
    assert.equal(requests, 0);
    process.env.BITCOIN_RPC_URL = 'http://127.0.0.1:1';
    globalThis.fetch = async (_url, options) => {
      requests++; assert.equal(options!.redirect, 'error'); assert(options!.signal);
      assert.equal(new Headers(options!.headers).get('authorization'), `Basic ${Buffer.from('public-test-fixture:public-test-fixture').toString('base64')}`);
      return new Response(JSON.stringify({ error: { code: -5, message: 'DO-NOT-RETAIN-RAW-SERVER-DIAGNOSTIC' } }), { status: 500 });
    };
    await assert.rejects(() => presignedCoreRpc('getrawtransaction', ['11'.repeat(32)]), (error: unknown) => {
      const value = error as Error & { code: number };
      return value.code === -5 && !value.message.includes('DO-NOT-RETAIN') && !value.message.includes('public-test-fixture');
    });
    assert.equal(requests, 1);
    pass('production RPC mock contract rejects missing/partial auth, cleartext remote endpoints and URL credentials; bounded fetch preserves numeric error only');
  } finally {
    globalThis.fetch = originalFetch;
    for (const name of names) { if (prior[name] === undefined) delete process.env[name]; else process.env[name] = prior[name]; }
  }
  await withPresignedRegtest(async core => {
    const approvedGenesis = createPresignedFixture().roster.genesisHash;
    const bridge: PresignedCoreRpc = async <T>(method: string, params: unknown[] = []): Promise<T> => {
      try {
        const result = await core.rpc(method, params);
        if (method === 'getblockchaininfo') return { ...result, chain: 'signet' } as T;
        if (method === 'getblockhash' && params[0] === 0) return approvedGenesis as T;
        return result as T;
      } catch (error) {
        const code = (error as { rpcCode?: number }).rpcCode;
        throw Object.assign(new Error('isolated Core rejected test request'), { code });
      }
    };
    const backend = createPresignedCoreBackend({ network: 'signet', genesisHash: approvedGenesis, rpc: bridge });
    const dependencies: PresignedBroadcastDependencies = { assertEnabled: () => undefined, backend, rpc: bridge, requiredConfirmations: 1 };
    async function mine(n = 1) {
      const hashes = await core.mine(n);
      for (let i = 0; i < 100; i++) {
        if ((await core.rpc('getindexinfo')).txindex?.synced === true) return hashes;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error('isolated txindex did not catch up');
    }
    const secretsByVault = new Map<string, ReturnType<typeof createPresignedFixture>['participantSecrets']>();
    async function fixtureFor(vaultId: string = randomUUID()) {
      const fixture = createPresignedFixture();
      if (!secretsByVault.has(vaultId)) secretsByVault.set(vaultId,
        Object.fromEntries(PARTICIPANT_IDS.map(id => [id, randomBytes(32).toString('base64url')])) as typeof fixture.participantSecrets);
      fixture.participantSecrets = secretsByVault.get(vaultId)!;
      const derived = PARTICIPANT_IDS.map(id => derivePresignedParticipantKeys(fixture.participantSecrets[id], id, vaultId));
      fixture.keysById = Object.fromEntries(derived.map(item => [item.publicIdentity.id, item.keys])) as typeof fixture.keysById;
      fixture.roster = { ...fixture.roster, vaultId, participants: derived.map(item => item.publicIdentity) };
      const coins = await core.fundScripts(PARTICIPANT_IDS.map(id => ({ scriptPubKeyHex: fixture.walletKeys[id].scriptPubKeyHex, valueSats: 12_000 })));
      fixture.graph = buildPresignedGraph({ roster: fixture.roster, funding: { ...fixture.graph.funding, epochId: randomUUID(),
        inputs: coins.map((coin, index) => ({ ...coin, participantId: PARTICIPANT_IDS[index]!, changeScriptPubKeyHex: coin.scriptPubKeyHex })) } });
      return fixture;
    }
    type Fixture = Awaited<ReturnType<typeof fixtureFor>>;
    interface Stored { fixture: Fixture; users: Record<ParticipantId, string>; credentials: Record<ParticipantId, string>;
      epoch: PresignedFundingEpoch; funding: ReturnType<typeof signPresignedFixtureFunding>;
      preauthorizations: ReturnType<typeof preauthorizePresignedFixture> }
    async function persist(fixture: Fixture, status: 'signed' | 'approved' | 'retired' = 'approved', ordinal = 1, existing?: Stored): Promise<Stored> {
      const graph = fixture.graph; const vaultId = graph.roster.vaultId; const epochId = graph.funding.epochId;
      const users = existing?.users ?? Object.fromEntries(PARTICIPANT_IDS.map(id => [id, randomUUID()])) as Record<ParticipantId, string>;
      const credentials = existing?.credentials ?? Object.fromEntries(PARTICIPANT_IDS.map(id => [id, `test-watch-${randomUUID()}`])) as Record<ParticipantId, string>;
      const funding = signPresignedFixtureFunding(fixture); const tx = bitcoin.Transaction.fromHex(funding.transactionHex);
      const preauthorizations = preauthorizePresignedFixture(fixture);
      const signatures = PARTICIPANT_IDS.map((id, index) => ({ version: 2 as const, protocol: PRESIGNED_PROTOCOL,
        graphDigest: graph.digest, participantId: id, inputIndex: index, witness: tx.ins[index]!.witness.map(value => Buffer.from(value).toString('hex')) }));
      const epoch: PresignedFundingEpoch = { epochId, status, inputs: graph.funding.inputs, graph, preauthorizations, backups: [],
        walletSigningStarted: status === 'retired' ? [] : [...PARTICIPANT_IDS], signatures: status === 'retired' ? [] : signatures,
        finalization: status === 'retired' ? null : funding, fundingApprovals: status === 'approved' ? [...PARTICIPANT_IDS] : [], restartApprovals: [] };
      if (!existing) {
        await sql`INSERT INTO vaults(id, name, protocol) VALUES (${vaultId}, 'Isolated Core watch acceptance', ${PRESIGNED_PROTOCOL})`;
        for (const id of PARTICIPANT_IDS) {
          await sql`INSERT INTO users(id, display_name) VALUES (${users[id]}, ${`Synthetic ${id}`})`;
          await sql`INSERT INTO vault_members(vault_id, user_id, participant_id) VALUES (${vaultId}, ${users[id]}, ${id})`;
          const identity = graph.roster.participants.find(item => item.id === id)!;
          await sql`INSERT INTO participant_key_material(user_id, vault_id, participant_id, personal_public_key, payout_xonly_public_key)
            VALUES (${users[id]}, ${vaultId}, ${id}, ${bytes(identity.personalPublicKeyHex)}, ${bytes(identity.payoutXonlyPublicKeyHex)})`;
          await sql`INSERT INTO webauthn_credentials(credential_id, user_id, public_key, counter, device_type, backed_up, prf_enabled, credential_name)
            VALUES (${credentials[id]}, ${users[id]}, ${randomBytes(64)}, 0, 'multiDevice', true, true, 'Synthetic passkey')`;
          await sql`INSERT INTO passkey_envelopes(credential_id, version, prf_salt, iv, ciphertext, aad)
            VALUES (${credentials[id]}, 1, ${randomBytes(32)}, ${randomBytes(12)}, ${randomBytes(64)}, ${randomBytes(32)})`;
        }
        const ceremony = newPresignedCeremony(vaultId, { network: graph.roster.network, genesisHash: graph.roster.genesisHash,
          economics: graph.roster.economics, feePolicy: graph.roster.feePolicy, fundingFeeSats: graph.funding.feeSats });
        ceremony.identities = graph.roster.participants; ceremony.roster = graph.roster; ceremony.rosterDigest = graph.rosterDigest;
        ceremony.rosterApprovals = [...PARTICIPANT_IDS]; ceremony.epochs = [epoch];
        await sql`INSERT INTO presigned_ceremonies(vault_id, settings_json, settings_digest, state_json, state_digest)
          VALUES (${vaultId}, ${sql.json(json(ceremony.settings))}, ${bytes(ceremony.settingsDigest)}, ${sql.json(json(ceremony))},
            ${bytes(commitmentDigest('vault/presigned-graph-v2/ceremony/state', ceremony))})`;
      }
      await sql`INSERT INTO presigned_funding_epochs(epoch_id, vault_id, ordinal, status, graph_digest, funding_txid, snapshot_json, snapshot_digest)
        VALUES (${epochId}, ${vaultId}, ${ordinal}, ${status}, ${bytes(graph.digest)}, ${bytes(graph.fundingTxid)}, ${sql.json(json(epoch))},
          ${bytes(commitmentDigest('vault/presigned-graph-v2/ceremony/epoch', epoch))})`;
      return { fixture, users, credentials, epoch, funding, preauthorizations };
    }
    async function poll(stored: Stored, override = backend) {
      const result = await pollPresignedVaultChains({ backend: override, requiredConfirmations: 1, vaultId: stored.fixture.roster.vaultId });
      return { result, status: await getPresignedChainStatus(stored.users.alice) };
    }
    async function perform(stored: Stored, id: ParticipantId, body: Record<string, unknown>) {
      const action = validatePresignedRuntimeAction({ version: 2, protocol: PRESIGNED_PROTOCOL, ...body });
      const deps = { requiredConfirmations: 1, observeCoin: ({ source }: { source: { txid: string; vout: number } }) => backend.observeConfirmedCoin(source) };
      const challenge = await createPresignedRuntimeActionChallenge({ userId: stored.users[id], credentialId: stored.credentials[id],
        challenge: randomBytes(32).toString('base64url'), action }, deps);
      return (await completePresignedRuntimeAction(challenge, challenge.credential.counter + 1, deps)).proposal;
    }
    async function create(stored: Stored, id: ParticipantId, kind: PresignedRuntimeKind, sourceExitId: string | null = null, exitId: string | null = null) {
      const graph = stored.fixture.graph;
      const txid = sourceExitId === null ? graph.fundingTxid : graph.exits.find(item => item.id === sourceExitId)!.txid;
      const observation = await backend.observeConfirmedCoin({ txid, vout: sourceExitId === null ? 0 : 1 });
      return perform(stored, id, { kind: 'create-proposal', epochId: graph.funding.epochId, graphDigest: graph.digest,
        proposalId: randomUUID(), spendKind: kind, sourceExitId, exitId, confirmationBlockHash: observation.confirmationBlockHash });
    }
    function bound(state: PresignedRuntimeState, body: Record<string, unknown>) {
      return { proposalId: state.proposal.proposalId, proposalDigest: state.proposal.digest, ...body };
    }
    async function approve(stored: Stored, state: PresignedRuntimeState) {
      for (const id of state.finalized!.approverParticipantIds) state = await perform(stored, id,
        bound(state, { kind: 'approve-broadcast', transactionDigest: state.finalized!.transactionDigest }));
      return state;
    }
    async function solo(stored: Stored, id: ParticipantId, exitId: string, sourceExitId: string | null) {
      let state = await create(stored, id, 'solo', sourceExitId, exitId); const { graph, keysById } = stored.fixture;
      const exit = graph.exits.find(item => item.id === exitId)!;
      const completed = completePresignedExit({ graph, preauthorizations: stored.preauthorizations, exitId, participantId: id,
        privateKey: keysById[id].soloPrivateKeys[exit.roundId]!, approvedGraphDigest: graph.digest });
      state = await perform(stored, id, bound(state, { kind: 'finalize-transaction', transactionHex: completed.transactionHex }));
      await assert.rejects(() => preparePresignedBroadcast({ userId: stored.users[id], epochId: graph.funding.epochId,
        proposalId: state.proposal.proposalId }), /quorum/);
      return approve(stored, state);
    }
    async function cooperative(stored: Stored) {
      let state = await create(stored, 'alice', 'cooperative'); const graph = stored.fixture.graph;
      const abandoned = createPresignedCooperativeNonce({ graph, proposal: state.proposal.spend!, participantId: 'alice',
        personalPrivateKey: stored.fixture.keysById.alice.personalPrivateKey, approvedProposalDigest: state.proposal.spend!.digest });
      state = await perform(stored, 'alice', bound(state, { kind: 'contribute-nonce', publicNonce: abandoned.publicNonce }));
      const oldProposal = state.proposal;
      await perform(stored, 'bob', bound(state, { kind: 'abandon-proposal', reason: 'Retain exposed nonce while restarting the incomplete shared signing ceremony.' }));
      abandoned.secretNonce.fill(0);
      state = await create(stored, 'alice', 'cooperative');
      assert.equal(state.proposal.txid, oldProposal.txid); assert.notEqual(state.proposal.proposalId, oldProposal.proposalId);
      const nonces = PARTICIPANT_IDS.map(id => createPresignedCooperativeNonce({ graph, proposal: state.proposal.spend!, participantId: id,
        personalPrivateKey: stored.fixture.keysById[id].personalPrivateKey, approvedProposalDigest: state.proposal.spend!.digest }));
      for (const nonce of nonces) state = await perform(stored, nonce.publicNonce.participantId,
        bound(state, { kind: 'contribute-nonce', publicNonce: nonce.publicNonce }));
      const publicNonces = state.publicNonces;
      for (const nonce of nonces) {
        const id = nonce.publicNonce.participantId;
        const partial = signPresignedCooperativePartial({ graph, proposal: state.proposal.spend!, participantId: id,
          personalPrivateKey: stored.fixture.keysById[id].personalPrivateKey, approvedProposalDigest: state.proposal.spend!.digest,
          publicNonces, nonceBinding: nonce.binding, consumedSecretNonce: nonce.secretNonce });
        state = await perform(stored, id, bound(state, { kind: 'contribute-partial', partial }));
      }
      return approve(stored, state);
    }
    const stored = await persist(await fixtureFor(), 'signed');
    await assert.rejects(() => preparePresignedBroadcast({ userId: stored.users.alice, epochId: stored.epoch.epochId, proposalId: null }), /three exact/);
    let changedSnapshot = false;
    const sameEpochRace = await poll(stored, { ...backend, async getTip() {
      if (!changedSnapshot) {
        changedSnapshot = true; stored.epoch.status = 'approved'; stored.epoch.fundingApprovals = [...PARTICIPANT_IDS];
        await sql`UPDATE presigned_funding_epochs SET status = 'approved', snapshot_json = ${sql.json(json(stored.epoch))},
          snapshot_digest = ${bytes(commitmentDigest('vault/presigned-graph-v2/ceremony/epoch', stored.epoch))} WHERE epoch_id = ${stored.epoch.epochId}`;
      }
      return backend.getTip();
    } });
    if (sameEpochRace.result.deferredVaults === 0)
      note('watcher commits stale same-epoch snapshot despite concurrent exact funding-approval update; snapshot digest not CAS checked');
    else assert.equal(sameEpochRace.result.vaults[0]!.updatedEpochs, 0);
    const fundingIntent = await preparePresignedBroadcast({ userId: stored.users.alice, epochId: stored.epoch.epochId, proposalId: null });
    assert.equal((await preparePresignedBroadcast({ userId: stored.users.bob, epochId: stored.epoch.epochId, proposalId: null })).intentId, fundingIntent.intentId);
    await assert.rejects(() => sql`UPDATE presigned_broadcast_intents SET transaction_json = '[]'::jsonb WHERE id = ${fundingIntent.intentId}`, /immutable/);
    let sends = 0;
    const loseResponse: PresignedCoreRpc = async <T>(method: string, params?: unknown[]): Promise<T> => {
      const result = await bridge<T>(method, params);
      if (method === 'sendrawtransaction') { sends++; throw new Error('synthetic lost reply after Core accepted'); }
      return result;
    };
    assert.equal((await submitPresignedBroadcast(fundingIntent.intentId, { ...dependencies, rpc: loseResponse })).status, 'deferred');
    assert.equal((await submitPresignedBroadcast(fundingIntent.intentId, { ...dependencies, rpc: loseResponse })).status, 'accepted');
    assert.equal(sends, 1);
    await mine();
    const firstPoll = await poll(stored); assert.equal(firstPoll.result.deferredVaults, 0);
    assert.equal(firstPoll.status.epochs[0]!.snapshot!.output!.availability, 'available');
    pass('real funding quorum guard, immutable/idempotent prepared intent, lost send reply retry recognizes acceptance without a second send');

    let first = await solo(stored, 'alice', 'alice', null);
    const firstIntent = await preparePresignedBroadcast({ userId: stored.users.alice, epochId: stored.epoch.epochId, proposalId: first.proposal.proposalId });
    await sql`UPDATE presigned_broadcast_intents SET status = 'submitting', updated_at = now() - interval '46 seconds' WHERE id = ${firstIntent.intentId}`;
    assert.equal((await submitPresignedBroadcast(firstIntent.intentId, dependencies)).status, 'accepted');
    const pending = await poll(stored); assert.equal(pending.status.epochs[0]!.snapshot!.output!.availability, 'mempool-spent');
    assert.equal((await backend.observeConfirmedCoin(first.proposal.source)).unspentInActiveChain, true);
    await assert.rejects(() => backend.observeCoin(first.proposal.source));
    const [firstBlock] = await mine();
    const firstConfirmed = await poll(stored);
    assert.deepEqual(firstConfirmed.status.epochs[0]!.snapshot!.state.graph.confirmed.map(item => item.exitId), [null, 'alice']);
    const beforeUnknown = firstConfirmed.status.epochs[0]!.snapshot;
    const unknown = await poll(stored, { ...backend, getOutputAvailability: async () => ({ kind: 'unknown' as const }) });
    assert.equal(unknown.result.deferredVaults, 1); assert.deepEqual(unknown.status.epochs[0]!.snapshot, beforeUnknown);
    assert.equal(unknown.status.epochs[0]!.deferredReason, 'unknown-or-inconsistent-private-Core-watch');
    pass('crashed submitting intent resumes; mempool-spent does not become chain-spent; unavailable txout retains prior chain state with explicit deferral');

    const second = await solo(stored, 'bob', 'alice/bob', 'alice');
    const secondIntent = await preparePresignedBroadcast({ userId: stored.users.bob, epochId: stored.epoch.epochId, proposalId: second.proposal.proposalId });
    assert.equal((await submitPresignedBroadcast(secondIntent.intentId, dependencies)).status, 'accepted'); await mine();
    let final = await create(stored, 'carol', 'final-sweep', 'alice/bob');
    const sweep = signPresignedFinalSweep({ graph: stored.fixture.graph, proposal: final.proposal.spend!, participantId: 'carol',
      payoutPrivateKey: stored.fixture.keysById.carol.payoutPrivateKey, approvedProposalDigest: final.proposal.spend!.digest });
    final = await perform(stored, 'carol', bound(final, { kind: 'finalize-transaction', transactionHex: sweep.transactionHex }));
    final = await approve(stored, final);
    const finalIntent = await preparePresignedBroadcast({ userId: stored.users.carol, epochId: stored.epoch.epochId, proposalId: final.proposal.proposalId });
    assert.equal((await submitPresignedBroadcast(finalIntent.intentId, dependencies)).status, 'accepted'); await mine();
    const closed = await poll(stored); const closedSnapshot = closed.status.epochs[0]!.snapshot!;
    assert.equal(closedSnapshot.state.graph.confirmed.length, 3); assert.equal(closedSnapshot.state.terminals.length, 1);
    assert.equal(closedSnapshot.output!.availability, 'chain-spent'); assert.equal(closedSnapshot.output!.knownTerminalTxid, sweep.txid);
    assert.equal((await sql`SELECT status FROM vaults WHERE id = ${stored.fixture.roster.vaultId}`)[0]!.status, 'closed');
    const unknownTerminal = await poll(stored, { ...backend, async getTransaction(txid) {
      return txid === sweep.txid ? { kind: 'unknown' as const, txid } : backend.getTransaction(txid);
    } });
    assert.equal(unknownTerminal.result.deferredVaults, 1);
    assert.deepEqual(unknownTerminal.status.epochs[0]!.snapshot, closedSnapshot);
    assert.equal(unknownTerminal.status.epochs[0]!.deferredReason, 'unknown-or-inconsistent-private-Core-watch');
    await closeDatabase();
    assert.equal((await poll(stored)).result.deferredVaults, 0);
    await core.rpc('invalidateblock', [firstBlock]);
    const invalidated = await poll(stored);
    assert.deepEqual(invalidated.status.epochs[0]!.snapshot!.invalidatedTxids,
      [sweep.txid, second.proposal.txid, first.proposal.txid]);
    assert.equal((await sql`SELECT status FROM vaults WHERE id = ${stored.fixture.roster.vaultId}`)[0]!.status, 'active');
    // Use exact bytes and actual inactive Core header from txindex, even if Core
    // also retained the transaction in its mempool. An orphan anchor alone must
    // not trigger the already-accepted short circuit.
    let policyReached = false;
    const orphanResult = await submitPresignedBroadcast(firstIntent.intentId, { ...dependencies,
      backend: { ...backend, async getTransaction(txid) {
        const raw = await core.rpc('getrawtransaction', [txid, true, firstBlock]);
        return { kind: 'present' as const, txid, transactionHex: raw.hex, blockHash: firstBlock! };
      } }, rpc: async <T>(method: string, params?: unknown[]): Promise<T> => {
        if (method === 'testmempoolaccept') { policyReached = true; return [{ txid: first.proposal.txid, allowed: false }] as T; }
        return bridge<T>(method, params);
      } });
    assert.equal(orphanResult.status, 'deferred'); assert.equal(policyReached, true);
    await core.rpc('reconsiderblock', [firstBlock]);
    const restored = await poll(stored);
    assert.deepEqual(restored.status.epochs[0]!.snapshot!.addedTxids,
      [first.proposal.txid, second.proposal.txid, sweep.txid]);
    // Simulated stale restored DB status is repaired from current private Core.
    await sql`UPDATE vaults SET status = 'active' WHERE id = ${stored.fixture.roster.vaultId}`;
    await poll(stored);
    assert.equal((await sql`SELECT status FROM vaults WHERE id = ${stored.fixture.roster.vaultId}`)[0]!.status, 'closed');
    pass('actual Core graph and terminal closure; new DB pool; reverse-order reorg invalidation and ordered restoration; stale restored vault status repaired');

    // The per-intent function must not let an obsolete attempt overwrite a
    // newer accepted result if the surrounding session lease was lost.
    let releaseOld!: () => void; let enteredOld!: () => void;
    const held = new Promise<void>(resolve => { releaseOld = resolve; });
    const entered = new Promise<void>(resolve => { enteredOld = resolve; });
    const obsolete = submitPresignedBroadcast(fundingIntent.intentId, { ...dependencies,
      backend: { ...backend, async getTransaction(txid) { enteredOld(); await held; return { kind: 'unknown' as const, txid }; } } });
    await entered;
    const overlap = await submitPresignedBroadcast(fundingIntent.intentId, dependencies); assert.equal(overlap.status, 'submitting');
    await sql`UPDATE presigned_broadcast_intents SET updated_at = now() - interval '46 seconds' WHERE id = ${fundingIntent.intentId}`;
    assert.equal((await submitPresignedBroadcast(fundingIntent.intentId, dependencies)).status, 'accepted');
    releaseOld(); await obsolete;
    const staleStatus = (await sql`SELECT status FROM presigned_broadcast_intents WHERE id = ${fundingIntent.intentId}`)[0]!.status;
    if (staleStatus === 'deferred') note('obsolete expired broadcast attempt overwrites successor accepted status: terminal updates lack claim-token CAS');
    else assert.equal(staleStatus, 'accepted');
    assert.equal((await submitPresignedBroadcast(fundingIntent.intentId, dependencies)).status, 'accepted');
    const heldAccepted = new Promise<void>(resolve => { releaseOld = resolve; });
    const enteredAccepted = new Promise<void>(resolve => { enteredOld = resolve; });
    const oldAccepted = submitPresignedBroadcast(fundingIntent.intentId, { ...dependencies,
      backend: { ...backend, async getTransaction(txid) { enteredOld(); await heldAccepted; return backend.getTransaction(txid); } } });
    await enteredAccepted;
    await sql`UPDATE presigned_broadcast_intents SET updated_at = now() - interval '46 seconds' WHERE id = ${fundingIntent.intentId}`;
    assert.equal((await submitPresignedBroadcast(fundingIntent.intentId, { ...dependencies,
      backend: { ...backend, async getTransaction(txid) { return { kind: 'unknown' as const, txid }; } } })).status, 'deferred');
    releaseOld(); await oldAccepted;
    const staleAccepted = (await sql`SELECT status FROM presigned_broadcast_intents WHERE id = ${fundingIntent.intentId}`)[0]!.status;
    if (staleAccepted === 'accepted') note('obsolete accepted broadcast attempt overwrites newer deferred attempt; accepted update lacks claim-token CAS');
    else assert.equal(staleAccepted, 'deferred');
    assert.equal((await submitPresignedBroadcast(fundingIntent.intentId, dependencies)).status, 'accepted');
    let nested = false;
    const lease = await withChainWatcherLease(async () => { const inner = await withChainWatcherLease(async () => { nested = true; }); assert.equal(inner.acquired, false); });
    assert.equal(lease.acquired, true); assert.equal(nested, false);
    pass('fresh submitting claim blocks overlap and global session lease blocks normal concurrent watchers; exact-byte accepted retry remains recoverable');

    // Watch epoch-set race: a setup action can freeze a new retained graph after
    // the watcher reads its epoch list, before the watcher takes the vault lock.
    const race = await persist(await fixtureFor(), 'retired');
    await bridge('sendrawtransaction', [race.funding.transactionHex]); await mine();
    await poll(race);
    const newFixture = await fixtureFor(race.fixture.roster.vaultId);
    let inserted = false;
    const raced = await poll(race, { ...backend, async getTip() {
      if (!inserted) { inserted = true; await persist(newFixture, 'approved', 2, race); }
      return backend.getTip();
    } });
    const epochCount = (await sql`SELECT count(*)::int AS count FROM presigned_funding_epochs WHERE vault_id = ${race.fixture.roster.vaultId}`)[0]!.count;
    assert.equal(epochCount, 2);
    if (raced.result.deferredVaults === 0 && raced.result.vaults[0]!.updatedEpochs === 1)
      note('watcher reports successful complete-vault reconciliation after a newly frozen retained epoch appears during collection; epoch-set membership not CAS checked');
    else assert.equal(raced.result.deferredVaults, 1);
    const repaired = await poll(race); assert.equal(repaired.status.epochs.length, 2);
    await bridge('sendrawtransaction', [signPresignedFixtureFunding(newFixture).transactionHex]); await mine();
    const conflict = await poll(race);
    assert(conflict.result.vaults[0]!.conflicts.some(item => item.kind === 'multiple-funded-epochs'));
    const stable = conflict.status.epochs.map(item => item.snapshot);
    const unknownEpoch = await poll(race, { ...backend, async getTransaction(txid) {
      return txid === newFixture.graph.fundingTxid ? { kind: 'unknown' as const, txid } : backend.getTransaction(txid);
    } });
    assert.equal(unknownEpoch.result.deferredVaults, 1);
    assert.deepEqual(unknownEpoch.status.epochs.map(item => item.snapshot), stable);
    assert(unknownEpoch.status.epochs.every(item => item.deferredReason !== null));
    pass('all retained epochs observed on next poll; simultaneous funded epochs flagged; one unknown epoch defers the complete vault without partial state replacement');

    const coop = await cooperative(race);
    const coopIntent = await preparePresignedBroadcast({ userId: race.users.alice, epochId: race.epoch.epochId, proposalId: coop.proposal.proposalId });
    assert.equal((await submitPresignedBroadcast(coopIntent.intentId, dependencies)).status, 'accepted'); await mine();
    let terminalLookups = 0;
    const duplicate = await poll(race, { ...backend, async getTransaction(txid) {
      if (txid === coop.proposal.txid) terminalLookups++;
      return backend.getTransaction(txid);
    } });
    assert.equal(duplicate.result.deferredVaults, 0); assert.equal(terminalLookups, 1);
    assert.equal(duplicate.status.epochs.find(item => item.epochId === race.epoch.epochId)!.snapshot!.state.terminals.length, 1);
    assert.equal((await sql`SELECT status FROM vaults WHERE id = ${race.fixture.roster.vaultId}`)[0]!.status, 'active');
    pass('actual MuSig2 cooperative terminal recognized once across retained same-unsigned-tx proposals; another funded open epoch prevents vault closure');

    // An interrupted pre-wallet ceremony can reuse all the exact same coins.
    // Its new graph commitment is a distinct retained epoch, not a second coin.
    const replayFixture = { ...stored.fixture, graph: buildPresignedGraph({ roster: stored.fixture.roster,
      funding: { ...stored.fixture.graph.funding, epochId: randomUUID() } }) };
    assert.equal(replayFixture.graph.fundingTxid, stored.fixture.graph.fundingTxid);
    assert.notEqual(replayFixture.graph.digest, stored.fixture.graph.digest);
    const replay = await persist(replayFixture, 'retired', 2, stored);
    assert.equal((await sql`SELECT count(*)::int AS count FROM presigned_runtime_proposals WHERE epoch_id = ${replay.epoch.epochId}`)[0]!.count, 0);
    const rediscovered = await poll(stored);
    assert.equal(rediscovered.result.deferredVaults, 0);
    assert.deepEqual(rediscovered.result.vaults[0]!.conflicts, []);
    assert.equal(rediscovered.status.epochs.length, 2);
    assert(rediscovered.status.epochs.every(epoch => epoch.snapshot?.output?.knownTerminalTxid === sweep.txid));
    assert.equal((await sql`SELECT status FROM vaults WHERE id = ${stored.fixture.roster.vaultId}`)[0]!.status, 'closed');
    await core.rpc('invalidateblock', [firstBlock]);
    const offlineReorg = await poll(stored);
    assert(offlineReorg.status.epochs.every(epoch => epoch.snapshot?.state.terminals.length === 0));
    assert.equal((await sql`SELECT status FROM vaults WHERE id = ${stored.fixture.roster.vaultId}`)[0]!.status, 'active');
    await core.rpc('reconsiderblock', [firstBlock]);
    assert.equal((await poll(stored)).result.deferredVaults, 0);
    assert.equal((await sql`SELECT status FROM vaults WHERE id = ${stored.fixture.roster.vaultId}`)[0]!.status, 'closed');
    pass('same-transaction restart epochs retain histories without a false double-funding alarm; proposal-free terminal detection closes both and survives a real reorg');

    // Emulate a worker that lost its separate session lease after collecting
    // the final Core tip but before acquiring the publication transaction.
    // A content hash alone does not order different observations of one state.
    async function holdBeforeWatchPersistence(target: Stored) {
      let release!: () => void; let reached!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      const entered = new Promise<void>(resolve => { reached = resolve; });
      let outputObserved = false; let tipsAfterOutput = 0;
      const pending = poll(target, { ...backend,
        async getOutputAvailability(output) {
          const value = await backend.getOutputAvailability(output); outputObserved = true; return value;
        },
        async getTip() {
          const value = await backend.getTip();
          // First: collectPresignedEpochWatch's final check. Second: the
          // store's complete-vault final check, immediately before persistence.
          if (outputObserved && ++tipsAfterOutput === 2) { reached(); await held; }
          return value;
        },
      });
      await Promise.race([entered, pending.then(() => { throw new Error('watch did not reach the persistence barrier'); })]);
      return { pending, release };
    }
    const fenced = await persist(await fixtureFor(), 'approved');
    await bridge('sendrawtransaction', [fenced.funding.transactionHex]); await mine();
    await poll(fenced);
    const fencedSolo = await solo(fenced, 'alice', 'alice', null);
    const staleAvailable = await holdBeforeWatchPersistence(fenced);
    try {
      await bridge('sendrawtransaction', [fencedSolo.finalized!.transactionHex]);
      const successor = await poll(fenced);
      assert.equal(successor.status.epochs[0]!.snapshot!.output!.availability, 'mempool-spent');
      const successorDigest = (await sql`SELECT state_digest FROM presigned_chain_states WHERE epoch_id = ${fenced.epoch.epochId}`)[0]!.state_digest;
      staleAvailable.release();
      const staleResult = await staleAvailable.pending;
      if (staleResult.result.deferredVaults === 0)
        note('stale watch overwrites a newer same-state output-availability snapshot after losing its session lease');
      else {
        assert.deepEqual(staleResult.status.epochs, successor.status.epochs);
        assert.deepEqual((await sql`SELECT state_digest FROM presigned_chain_states WHERE epoch_id = ${fenced.epoch.epochId}`)[0]!.state_digest, successorDigest);
        pass('stale watch cannot replace newer same-state mempool availability or observation metadata');
      }
    } finally { staleAvailable.release(); await staleAvailable.pending; }
    await poll(fenced);

    // A genuinely mined first exit followed by block invalidation returns the
    // persisted graph state to its original digest: the classic ABA interleave.
    const beforeAba = (await sql`SELECT state_digest FROM presigned_chain_states WHERE epoch_id = ${fenced.epoch.epochId}`)[0]!.state_digest;
    const [abaBlock] = await mine();
    const staleConfirmed = await holdBeforeWatchPersistence(fenced);
    try {
      const advanced = await poll(fenced);
      assert.equal(advanced.status.epochs[0]!.snapshot!.state.graph.confirmed.length, 2);
      await core.rpc('invalidateblock', [abaBlock]);
      const successor = await poll(fenced);
      assert.equal(successor.status.epochs[0]!.snapshot!.state.graph.confirmed.length, 1);
      assert.deepEqual((await sql`SELECT state_digest FROM presigned_chain_states WHERE epoch_id = ${fenced.epoch.epochId}`)[0]!.state_digest, beforeAba);
      staleConfirmed.release();
      const staleResult = await staleConfirmed.pending;
      if (staleResult.result.deferredVaults === 0)
        note('stale pre-reorg watch resurrects confirmations after successor advance/reorg returns to the same state digest');
      else {
        assert.deepEqual(staleResult.status.epochs, successor.status.epochs);
        pass('watch persistence rejects an ABA state-digest race after actual Core confirmation and block invalidation');
      }
    } finally { staleConfirmed.release(); await staleConfirmed.pending; }
    await core.rpc('reconsiderblock', [abaBlock]); await poll(fenced);

    const staleBeforeDeferred = await holdBeforeWatchPersistence(fenced);
    try {
      const successor = await poll(fenced, { ...backend, async getOutputAvailability() { return { kind: 'unknown' as const }; } });
      assert.equal(successor.result.deferredVaults, 1);
      assert(successor.status.epochs[0]!.deferredReason);
      staleBeforeDeferred.release();
      const staleResult = await staleBeforeDeferred.pending;
      if (staleResult.result.deferredVaults === 0)
        note('stale successful watch erases a newer deferred observation with an unchanged state digest');
      else {
        assert.deepEqual(staleResult.status.epochs, successor.status.epochs);
        pass('successful and deferred watch publications share the same stale-worker fence');
      }
    } finally { staleBeforeDeferred.release(); await staleBeforeDeferred.pending; }
    await poll(fenced);

    // Public queue metadata fixtures, not 100 genuine accepted transactions.
    // Their deliberately mismatched authority is rejected before any Core send;
    // accepted and deferred rows are equally eligible on subsequent polls.
    await sql`INSERT INTO presigned_broadcast_intents (vault_id, epoch_id, kind,
      authorization_digest, transaction_json, txids_json, status, created_at, updated_at)
      SELECT ${stored.fixture.roster.vaultId}::uuid, ${stored.epoch.epochId}::uuid, 'funding',
        decode(lpad(to_hex(i), 64, '0'), 'hex'), ${sql.json([stored.funding.transactionHex])},
        ${sql.json([stored.funding.txid])}, 'accepted',
        '2000-01-01'::timestamptz + i * interval '1 second', '2000-01-01'::timestamptz + i * interval '1 second'
      FROM generate_series(1, 100) AS i`;
    await sql`UPDATE presigned_broadcast_intents SET status = 'deferred', updated_at = now() WHERE id = ${fundingIntent.intentId}`;
    let retrySends = 0;
    const retryDependencies = { ...dependencies, rpc: (async <T>(method: string, params?: unknown[]): Promise<T> => {
      if (['sendrawtransaction', 'submitpackage'].includes(method)) { retrySends++; throw new Error('queue drill must only rediscover existing exact transactions'); }
      return bridge<T>(method, params);
    }) as PresignedCoreRpc };
    const firstRetry = await retryPresignedBroadcasts(retryDependencies);
    assert.equal(firstRetry.results.length, 100);
    assert(!firstRetry.results.some(row => row.intentId === fundingIntent.intentId));
    const secondRetry = await retryPresignedBroadcasts(retryDependencies);
    if (!secondRetry.results.some(row => row.intentId === fundingIntent.intentId && row.status === 'accepted'))
      note('100 old accepted/deferred broadcast rows permanently starve a newer interrupted exact transaction');
    else pass('broadcast retry queue rotates beyond 100 retained rows and discovers a newer lost-reply transaction without resending');
    assert.equal(retrySends, 0);

    const summary = { passed: findings.length === 0, completedChecks: results.length, findings, results,
      coreVersion: core.coreVersion, chain: 'network-disabled-regtest-with-test-only-signet-format-bridge',
      database: 'disposable-loopback-PostgreSQL', publicNetworkBroadcasts: 0,
      actualWebAuthnVerification: false, setupPrerequisites: 'synthetic-DB-fixtures-with-real-wallet-signatures',
      actualSignetTransport: false, authenticatedProductionRpc: false };
    core.record('chain-broadcast-db-acceptance', summary);
    console.log(JSON.stringify({ evidence: core.directory, ...summary }, null, 2));
    if (findings.length) process.exitCode = 1;
  });
} finally { await closeDatabase(); await sql.end(); }
