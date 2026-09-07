import 'server-only';
import { Buffer } from 'buffer';
import * as bitcoin from 'bitcoinjs-lib';
import type { TransactionSql } from 'postgres';
import { BITCOIN_NETWORK_NAME } from '../../../src/network';
import { validatePresignedFeePackage, type PresignedFeePackage } from '../../../src/presigned/fee-package';
import type { FeeCoinObservation } from '../../../src/presigned/fees';
import type { PresignedRuntimeState } from '../../../src/presigned/runtime';
import { nonWitnessTransactionHex } from '../../../src/presigned/graph';
import { type ParticipantId, PRESIGNED_PROTOCOL } from '../../../src/presigned/types';
import { assert, canonicalJson, commitmentDigest, identifier, safeInteger, sameCanonical } from '../../../src/presigned/validation';
import { exactAuthority, presignedBroadcastEnabled } from './presigned-broadcast-store';
import { loadPresignedFundingEpoch } from './presigned-chain-store';
import { presignedCoreBackend, presignedCoreRpc } from './presigned-core';
import { chainConfirmationsRequired } from './config';
import { db, transaction } from './db';
import { consumeRateLimit } from './rate-limit';
import { getPresignedRuntimeStatus } from './presigned-runtime-store';
import type { StoredCredential } from './webauthn-store';
import { assertPresignedFundingDeploymentRelease, recordPresignedFundingReleaseUse } from './presigned-release-store';

export interface PresignedFeeDependencies {
  backend: ReturnType<typeof presignedCoreBackend>;
  rpc: typeof presignedCoreRpc;
  requiredConfirmations: number;
  assertEnabled: () => void;
}
function defaultDependencies(): PresignedFeeDependencies {
  return { backend: presignedCoreBackend(), rpc: presignedCoreRpc, requiredConfirmations: chainConfirmationsRequired(),
    assertEnabled: () => assert(presignedBroadcastEnabled(), 'fee broadcasting is separately approval-gated for this network') };
}
export interface PresignedFeeChallenge {
  id: string; vaultId: string; participantId: ParticipantId; challenge: string;
  package: PresignedFeePackage; packageDigest: string; credential: StoredCredential;
}
interface FeeRow {
  id: string; vault_id: string; user_id: string; participant_id: ParticipantId;
  package_json: PresignedFeePackage; package_digest: Buffer; attempt_count: number; status: string;
}

export async function getPresignedFeeStatus(userId: string) {
  const runtime = await getPresignedRuntimeStatus(userId);
  const parents: Array<{ epochId: string; proposalId: string | null; graphDigest: string;
    kind: 'funding' | 'solo' | 'cooperative' | 'recovery' | 'final-sweep';
    transactionHex: string; txid: string; authorityDigest: string }> = [];
  for (const retained of runtime.kits) {
    if (retained.epochStatus !== 'approved') continue;
    const approved = await exactAuthority(runtime.vaultId, retained.epochId, null);
    parents.push({ epochId: retained.epochId, proposalId: null, graphDigest: retained.publicKit.graph.digest,
      kind: 'funding', transactionHex: approved.transactionHex, txid: approved.txid, authorityDigest: approved.digest });
  }
  for (const state of runtime.proposals) {
    if (!state.broadcastReady || !state.finalized || !state.proposal.participantIds.includes(runtime.participantId)) continue;
    if (state.proposal.kind === 'solo' && state.proposal.actorParticipantId !== runtime.participantId) continue;
    const approved = await exactAuthority(runtime.vaultId, state.proposal.epochId, state.proposal.proposalId);
    parents.push({ epochId: state.proposal.epochId, proposalId: state.proposal.proposalId,
      graphDigest: state.proposal.graphDigest, kind: state.proposal.kind, transactionHex: approved.transactionHex,
      txid: approved.txid, authorityDigest: approved.digest });
  }
  const packages = await db()<Array<{ id: string; package_json: PresignedFeePackage; status: string; created_at: Date }>>`
    SELECT id, package_json, status, created_at FROM presigned_fee_packages
    WHERE vault_id = ${runtime.vaultId}::uuid AND user_id = ${userId}::uuid ORDER BY created_at
  `;
  return { version: 2 as const, protocol: PRESIGNED_PROTOCOL, vaultId: runtime.vaultId,
    participantId: runtime.participantId, parents,
    packages: packages.map(row => ({ id: row.id, package: row.package_json, status: row.status,
      createdAt: row.created_at.toISOString() })), broadcastAvailable: presignedBroadcastEnabled() };
}
export type PresignedFeeStatus = Awaited<ReturnType<typeof getPresignedFeeStatus>>;

export async function createPresignedFeeChallenge(input: {
  userId: string; credentialId: string; challenge: string; package: unknown;
}, dependencies = defaultDependencies()): Promise<PresignedFeeChallenge> {
  const checked = validatePresignedFeePackage(input.package);
  assert(/^[A-Za-z0-9_-]{16,2048}$/u.test(input.challenge), 'invalid fee passkey challenge');
  await consumeRateLimit({ action: 'presigned_fee_approval', subject: input.userId, limit: 40, windowSeconds: 900 });
  return transaction(async sql => {
    const membership = await member(sql, input.userId);
    const selected = await credential(sql, input.userId, input.credentialId, membership);
    await validateAuthority(membership.vaultId, membership.participantId, checked.package, sql);
    await verifyFreshCoins(checked.package, dependencies, true);
    await sql`UPDATE presigned_fee_challenges SET invalidated_at = now() WHERE user_id = ${input.userId}::uuid
      AND vault_id = ${membership.vaultId}::uuid AND consumed_at IS NULL AND invalidated_at IS NULL`;
    const rows = await sql<Array<{ id: string }>>`INSERT INTO presigned_fee_challenges
      (vault_id, user_id, participant_id, credential_id, credential_counter, challenge, package_json, package_digest, expires_at)
      VALUES (${membership.vaultId}::uuid, ${input.userId}::uuid, ${membership.participantId}, ${selected.id}, ${selected.counter},
        ${input.challenge}, ${sql.json(json(checked.package))}, ${bytes(checked.packageDigest)}, now() + interval '5 minutes') RETURNING id`;
    return { id: rows[0]!.id, vaultId: membership.vaultId, participantId: membership.participantId,
      challenge: input.challenge, package: checked.package, packageDigest: checked.packageDigest, credential: selected };
  });
}
export async function getPresignedFeeChallenge(userId: string, challengeId: string) {
  return transaction(sql => loadChallenge(sql, userId, challengeId));
}
export async function completePresignedFeeChallenge(challenge: PresignedFeeChallenge, newCounter: number,
  dependencies = defaultDependencies()) {
  safeInteger(newCounter, 0, Number.MAX_SAFE_INTEGER, 'fee passkey counter');
  return transaction(async sql => {
    const membership = await member(sql, challenge.credential.userId);
    const current = await loadChallenge(sql, challenge.credential.userId, challenge.id);
    assert(current.vaultId === membership.vaultId && current.participantId === membership.participantId &&
      current.challenge === challenge.challenge && current.packageDigest === challenge.packageDigest &&
      current.credential.id === challenge.credential.id && current.credential.counter === challenge.credential.counter &&
      Buffer.from(current.credential.publicKey).equals(Buffer.from(challenge.credential.publicKey)), 'fee challenge changed before approval');
    sameCanonical(current.package, challenge.package, 'fee package preview and finish');
    assert((newCounter === 0 && current.credential.counter === 0) || newCounter > current.credential.counter, 'fee passkey counter did not advance');
    await validateAuthority(membership.vaultId, membership.participantId, current.package, sql);
    await verifyFreshCoins(current.package, dependencies, true);
    const consumed = await sql<Array<{ id: string }>>`UPDATE presigned_fee_challenges SET consumed_at = now()
      WHERE id = ${current.id}::uuid AND consumed_at IS NULL AND invalidated_at IS NULL AND expires_at > now() RETURNING id`;
    assert(consumed.length === 1, 'fee challenge was consumed or expired');
    const counters = await sql`UPDATE webauthn_credentials SET counter = ${newCounter}, last_used_at = now()
      WHERE credential_id = ${current.credential.id} AND user_id = ${current.credential.userId}::uuid
        AND counter = ${current.credential.counter} AND prf_enabled = true RETURNING credential_id`;
    assert(counters.length === 1, 'fee passkey changed concurrently');
    const rows = await sql<Array<{ id: string }>>`INSERT INTO presigned_fee_packages
      (vault_id, epoch_id, proposal_id, user_id, participant_id, package_json, package_digest)
      VALUES (${current.vaultId}::uuid, ${current.package.epochId}::uuid, ${current.package.proposalId}::uuid,
        ${current.credential.userId}::uuid, ${current.participantId}, ${sql.json(json(current.package))}, ${bytes(current.packageDigest)})
      ON CONFLICT (vault_id, package_digest) DO UPDATE SET updated_at = presigned_fee_packages.updated_at RETURNING id`;
    return { packageId: rows[0]!.id, packageDigest: current.packageDigest, status: 'approved' as const };
  });
}

/** Persisted, passkey-approved bytes only; there is no caller-supplied send body. */
export async function submitPresignedFeePackage(packageId: string, dependencies = defaultDependencies()) {
  dependencies.assertEnabled(); identifier(packageId, 'submitted fee package');
  const claimed = await transaction(async sql => {
    const rows = await sql<FeeRow[]>`UPDATE presigned_fee_packages SET status = 'submitting',
      attempt_count = attempt_count + 1, last_error_code = NULL, updated_at = now()
      WHERE id = ${packageId}::uuid AND (status IN ('prepared','deferred','accepted') OR
        (status = 'submitting' AND updated_at < now() - interval '45 seconds')) RETURNING *`;
    return rows[0] ?? null;
  });
  if (!claimed) return { packageId, status: 'submitting', reason: 'Package is missing or another attempt is in progress.' };
  try {
    const checked = validatePresignedFeePackage(claimed.package_json);
    assert(checked.packageDigest === claimed.package_digest.toString('hex'), 'persisted fee bytes changed');
    await validateAuthority(claimed.vault_id, claimed.participant_id, checked.package);
    const core = dependencies.backend;
    await core.getTip();
    if (await acceptedTransaction(core, checked.completed.txid, checked.completed.transactionHex)) return finish(claimed, 'accepted');
    const parentConfirmed = await acceptedTransaction(core, checked.completed.parentTxid, checked.parentTransactionHex, true);
    if (checked.package.mode === 'funding' && !await acceptedTransaction(core, checked.completed.parentTxid, checked.parentTransactionHex)) {
      const evidence = await assertPresignedFundingDeploymentRelease(claimed.vault_id, checked.package.epochId);
      await recordPresignedFundingReleaseUse({ vaultId: claimed.vault_id, epochId: checked.package.epochId,
        broadcastIntentId: null, feePackageId: claimed.id, evidence });
    }
    await verifyFreshCoins(checked.package, dependencies, !parentConfirmed);
    if (parentConfirmed) {
      const policy = await dependencies.rpc<Array<{ txid: string; allowed: boolean }>>('testmempoolaccept', [[checked.completed.transactionHex]]);
      assert(policy.length === 1 && policy[0]!.allowed && policy[0]!.txid === checked.completed.txid, 'confirmed-parent child is not relay-ready');
      assert(await dependencies.rpc('sendrawtransaction', [checked.completed.transactionHex]) === checked.completed.txid,
        'fee broadcast returned another child');
    } else {
      // submitpackage is itself the authorized send operation. It may accept a
      // subset: retain the same exact journal and discover each tx on retry.
      const result = await dependencies.rpc<{ package_msg: string; 'tx-results': Record<string, { txid?: string; error?: string }> }>(
        'submitpackage', [[checked.parentTransactionHex, checked.completed.transactionHex]]);
      assert(result.package_msg === 'success' && result['tx-results'] &&
        [checked.completed.parentTxid, checked.completed.txid].every(txid =>
          Object.values(result['tx-results']).some(item => item.txid === txid && !item.error)), 'exact fee package was not fully accepted');
    }
    return finish(claimed, 'accepted');
  } catch (error) {
    const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
    return finish(claimed, 'deferred', typeof code === 'number' && Number.isSafeInteger(code) ? code : null);
  }
}
export async function submitPresignedFeeForUser(userId: string, packageId: string) {
  identifier(userId, 'fee submit user'); identifier(packageId, 'fee submit package');
  assert(presignedBroadcastEnabled(), 'fee broadcasting is separately approval-gated for this network');
  await consumeRateLimit({ action: 'presigned_fee_broadcast', subject: userId, limit: 40, windowSeconds: 900 });
  const owned = await db()`SELECT id FROM presigned_fee_packages WHERE id = ${packageId}::uuid AND user_id = ${userId}::uuid`;
  assert(owned.length === 1, 'fee package does not belong to this user');
  // Approval is not a send intent. Only this explicit user action places a
  // package in the watcher's retry queue, before the first network request.
  await db()`UPDATE presigned_fee_packages SET status = 'prepared', updated_at = now()
    WHERE id = ${packageId}::uuid AND user_id = ${userId}::uuid AND status = 'approved'`;
  return submitPresignedFeePackage(packageId);
}
export async function retryPresignedFeePackages(dependencies?: PresignedFeeDependencies) {
  if (!presignedBroadcastEnabled()) return { enabled: false, results: [] };
  const rows = await db()<Array<{ id: string }>>`SELECT id FROM presigned_fee_packages
    WHERE status IN ('prepared','deferred','accepted') OR (status = 'submitting' AND updated_at < now() - interval '45 seconds')
    ORDER BY updated_at, id LIMIT 100`;
  const results = [];
  for (const row of rows) results.push(await submitPresignedFeePackage(row.id, dependencies));
  return { enabled: true, results };
}

async function validateAuthority(vaultId: string, participant: ParticipantId, value: PresignedFeePackage,
  connection: ReturnType<typeof db> | TransactionSql = db()) {
  const checked = validatePresignedFeePackage(value);
  assert(value.ownerParticipantId === participant && value.request.graph.roster.vaultId === vaultId &&
    value.request.graph.roster.network === BITCOIN_NETWORK_NAME, 'fee authority changed owner, vault or deployment network');
  const epoch = await loadPresignedFundingEpoch(vaultId, value.epochId, connection);
  sameCanonical(epoch.graph, value.request.graph, 'fee graph authority');
  const authority = await exactAuthority(vaultId, value.epochId, value.proposalId, connection);
  assert(authority.digest === value.parentAuthorityDigest && authority.transactionHex === checked.parentTransactionHex &&
    authority.txid === checked.completed.parentTxid, 'fee package changed its fully approved parent');
  if (value.mode !== 'funding') {
    const rows = await connection<Array<{ state_json: PresignedRuntimeState }>>`SELECT state_json FROM presigned_runtime_proposals
      WHERE id = ${value.proposalId}::uuid AND vault_id = ${vaultId}::uuid AND epoch_id = ${value.epochId}::uuid`;
    const proposal = rows[0]?.state_json.proposal;
    assert(proposal && (value.mode === 'solo' ? proposal.kind === 'solo' && proposal.exitId === value.request.exitId
      : proposal.kind !== 'solo'), 'fee package changed its exact runtime path');
    if (value.mode === 'spend') sameCanonical(proposal.spend, value.request.parentSpendProposal, 'fee runtime spend');
    const source = value.mode === 'solo' ? value.request.roundInputObservation : value.request.sourceObservation;
    assert(source.confirmationBlockHash === proposal.confirmationBlockHash, 'fee source needs renewed runtime approval after reanchoring');
  }
}
async function verifyFreshCoins(value: PresignedFeePackage, dependencies: PresignedFeeDependencies, includeParentSources: boolean) {
  const before = await dependencies.backend.getTip();
  const checked = validatePresignedFeePackage(value);
  const parentConfirmed = await acceptedTransaction(dependencies.backend, checked.completed.parentTxid, checked.parentTransactionHex, true);
  const previousId = value.request.approval.replacement
    ? bitcoin.Transaction.fromHex(value.request.approval.replacement.previousChildTransactionHex).getId() : null;
  const inputs: FeeCoinObservation[] = !includeParentSources || parentConfirmed ? [] : value.mode === 'funding'
    ? value.request.fundingInputObservations : [value.mode === 'solo' ? value.request.roundInputObservation : value.request.sourceObservation];
  for (const committed of inputs) {
    const fundingMinimum = value.mode === 'funding'
      ? value.request.graph.funding.inputs.find(input => input.txid === committed.txid && input.vout === committed.vout)!.confirmations : 0;
    checkFresh(committed, await dependencies.backend.observeConfirmedCoin(committed), Math.max(dependencies.requiredConfirmations, fundingMinimum));
    await expectedPendingSpender(committed, checked.completed.parentTxid, dependencies);
  }
  if (parentConfirmed) {
    // The original sources are now legitimately chain-spent by this exact
    // accepted parent. Revalidate the child payout/refund instead; a saved
    // public package remains recoverable across confirmation during approval.
    const child = bitcoin.Transaction.fromHex(checked.completed.transactionHex);
    const input = child.ins[0]!; const parent = bitcoin.Transaction.fromHex(checked.parentTransactionHex);
    assert(Buffer.from(input.hash).reverse().toString('hex') === parent.getId(), 'fee child changed its confirmed parent');
    const output = parent.outs[input.index]!;
    const current = await dependencies.backend.observeConfirmedCoin({ txid: parent.getId(), vout: input.index });
    assert(current.valueSats === Number(output.value) && current.scriptPubKeyHex === Buffer.from(output.script).toString('hex') &&
      current.confirmations >= dependencies.requiredConfirmations, 'confirmed fee payout/refund is unavailable or changed');
    await expectedPendingSpender(current, previousId, dependencies);
  }
  const sponsor = value.request.sponsorInput;
  const replacement = value.request.approval.replacement;
  const current = replacement ? await dependencies.backend.observeConfirmedCoin(sponsor) : await dependencies.backend.observeCoin(sponsor);
  checkFresh(sponsor, current, dependencies.requiredConfirmations);
  if (replacement) await expectedPendingSpender(sponsor, previousId, dependencies);
  sameCanonical(before, await dependencies.backend.getTip(), 'fee package observation tip');
}
async function expectedPendingSpender(coin: { txid: string; vout: number }, expected: string | null, dependencies: PresignedFeeDependencies) {
  const spenders = await dependencies.rpc<Array<{ txid: string; vout: number; spendingtxid?: string }>>('gettxspendingprevout', [[{ txid: coin.txid, vout: coin.vout }]]);
  assert(spenders.length === 1 && spenders[0]!.txid === coin.txid && spenders[0]!.vout === coin.vout &&
    (!spenders[0]!.spendingtxid || spenders[0]!.spendingtxid === expected), 'another mempool transaction has claimed a fee source or sponsor input');
}
function checkFresh(committed: FeeCoinObservation, current: FeeCoinObservation, minimum: number) {
  assert(current.network === committed.network && current.genesisHash === committed.genesisHash && current.txid === committed.txid &&
    current.vout === committed.vout && current.valueSats === committed.valueSats && current.scriptPubKeyHex === committed.scriptPubKeyHex &&
    current.confirmationBlockHash === committed.confirmationBlockHash && current.confirmations >= Math.max(minimum, committed.confirmations) &&
    current.coinbase === false && current.unspentInActiveChain === true, 'fee coin changed, reanchored or is no longer confirmed in the active chain');
}
async function acceptedTransaction(core: PresignedFeeDependencies['backend'], txid: string, transactionHex: string, confirmedOnly = false) {
  const existing = await core.getTransaction(txid);
  assert(existing.kind !== 'unknown', 'fee transaction lookup is unavailable');
  if (existing.kind === 'absent') return false;
  assert(nonWitnessTransactionHex(bitcoin.Transaction.fromHex(existing.transactionHex)) ===
    nonWitnessTransactionHex(bitcoin.Transaction.fromHex(transactionHex)), 'observed fee transaction changed its payment');
  if (!existing.blockHash) return !confirmedOnly;
  const block = await core.getBlock(existing.blockHash);
  assert(block.kind !== 'unknown', 'fee transaction anchor is unavailable');
  return block.kind === 'active';
}
async function finish(row: FeeRow, status: 'accepted' | 'deferred', code: number | null = null) {
  const rows = await db()`UPDATE presigned_fee_packages SET status = ${status}, last_error_code = ${code}, updated_at = now(),
    accepted_at = CASE WHEN ${status} = 'accepted' THEN COALESCE(accepted_at, now()) ELSE accepted_at END
    WHERE id = ${row.id}::uuid AND attempt_count = ${row.attempt_count} AND status = 'submitting' RETURNING id`;
  if (rows.length && status === 'accepted' && row.package_json.request.approval.replacement) {
    // Keep every authorization, but do not endlessly retry the explicitly
    // replaced lower-fee child. A pending old worker loses its status CAS.
    const previousHex = row.package_json.request.approval.replacement.previousChildTransactionHex;
    const previousId = bitcoin.Transaction.fromHex(previousHex).getId();
    const earlier = await db()<FeeRow[]>`SELECT * FROM presigned_fee_packages
      WHERE vault_id = ${row.vault_id}::uuid AND user_id = ${row.user_id}::uuid AND id <> ${row.id}::uuid
        AND status IN ('prepared','submitting','accepted','deferred')`;
    for (const candidate of earlier) {
      const checked = validatePresignedFeePackage(candidate.package_json);
      if (checked.completed.txid !== previousId || nonWitnessTransactionHex(bitcoin.Transaction.fromHex(checked.completed.transactionHex)) !==
        nonWitnessTransactionHex(bitcoin.Transaction.fromHex(previousHex))) continue;
      await db()`UPDATE presigned_fee_packages SET status = 'superseded', updated_at = now()
        WHERE id = ${candidate.id}::uuid AND attempt_count = ${candidate.attempt_count}
          AND status = ${candidate.status}`;
    }
  }
  return { packageId: row.id, status: rows.length ? status : 'superseded',
    reason: rows.length && status === 'accepted' ? null : 'Exact package retained. Recheck active chain, fee policy and competing spends before retry.' };
}
async function member(sql: TransactionSql, userId: string) {
  identifier(userId, 'fee user');
  const rows = await sql<Array<{ vault_id: string; participant_id: ParticipantId }>>`SELECT m.vault_id, m.participant_id
    FROM vault_members m JOIN vaults v ON v.id = m.vault_id
    WHERE m.user_id = ${userId}::uuid AND v.protocol = ${PRESIGNED_PROTOCOL} FOR UPDATE OF v`;
  assert(rows.length === 1, 'exactly one V2 fee membership is required');
  return { vaultId: rows[0]!.vault_id, participantId: rows[0]!.participant_id };
}
async function credential(sql: TransactionSql, userId: string, credentialId: string,
  membership: { vaultId: string; participantId: ParticipantId }): Promise<StoredCredential> {
  const rows = await sql<Array<{ credential_id: string; credential_name: string; public_key: Buffer; counter: string; transports: StoredCredential['transports'] }>>`
    SELECT c.credential_id, c.credential_name, c.public_key, c.counter::text, c.transports FROM webauthn_credentials c
    JOIN passkey_envelopes e ON e.credential_id = c.credential_id
    WHERE c.user_id = ${userId}::uuid AND c.credential_id = ${credentialId} AND c.prf_enabled = true`;
  const row = rows[0]; assert(row, 'fee passkey lacks a stored PRF envelope');
  const counter = Number(row.counter); safeInteger(counter, 0, Number.MAX_SAFE_INTEGER, 'fee stored counter');
  return { id: row.credential_id, name: row.credential_name, userId, publicKey: Uint8Array.from(row.public_key),
    counter, transports: row.transports, ...membership };
}
async function loadChallenge(sql: TransactionSql, userId: string, id: string): Promise<PresignedFeeChallenge> {
  identifier(userId, 'fee challenge user'); identifier(id, 'fee challenge');
  const rows = await sql<Array<{ id: string; vault_id: string; participant_id: ParticipantId; credential_id: string;
    credential_counter: string; challenge: string; package_json: PresignedFeePackage; package_digest: Buffer }>>`
    SELECT id, vault_id, participant_id, credential_id, credential_counter::text, challenge, package_json, package_digest
    FROM presigned_fee_challenges WHERE id = ${id}::uuid AND user_id = ${userId}::uuid
      AND consumed_at IS NULL AND invalidated_at IS NULL AND expires_at > now() FOR UPDATE`;
  const row = rows[0]; assert(row, 'fee challenge was consumed, superseded or expired');
  const selected = await credential(sql, userId, row.credential_id, { vaultId: row.vault_id, participantId: row.participant_id });
  const checked = validatePresignedFeePackage(row.package_json);
  assert(checked.packageDigest === row.package_digest.toString('hex') && selected.counter === Number(row.credential_counter), 'fee challenge changed');
  return { id, vaultId: row.vault_id, participantId: row.participant_id, challenge: row.challenge,
    package: checked.package, packageDigest: checked.packageDigest, credential: selected };
}
function bytes(value: string): Buffer { return Buffer.from(value, 'hex'); }
function json(value: unknown): any { return JSON.parse(canonicalJson(value)); }
