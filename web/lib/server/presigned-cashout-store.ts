import 'server-only';
import { Buffer } from 'buffer';
import type { Sql, TransactionSql } from 'postgres';
import * as bitcoin from 'bitcoinjs-lib';
import { BITCOIN_NETWORK_NAME } from '../../../src/network';
import { createPresignedPublicKit } from '../../../src/presigned/backup';
import { authorizePresignedCashoutTransaction, type PresignedCashout, type PresignedCashoutRequest } from '../../../src/presigned/cashout';
import { nonWitnessTransactionHex } from '../../../src/presigned/graph';
import { PRESIGNED_PROTOCOL, PRESIGNED_PROTOCOL_V3, isPresignedProtocol, type ParticipantId, type PresignedProtocol } from '../../../src/presigned/types';
import { assert, canonicalJson, commitmentDigest, exactKeys, identifier, presignedDomain, presignedVersion, sameCanonical } from '../../../src/presigned/validation';
import { db, transaction } from './db';
import { presignedBroadcastEnabled } from './presigned-broadcast-store';
import { loadPresignedFundingEpoch } from './presigned-chain-store';
import { presignedCoreBackend, presignedCoreRpc } from './presigned-core';
import { chainConfirmationsRequired } from './config';
import { consumeRateLimit } from './rate-limit';

export interface PresignedSignedCashout {
  request: PresignedCashoutRequest; cashout: PresignedCashout; transactionHex: string;
}
export interface PresignedCashoutDependencies {
  backend: ReturnType<typeof presignedCoreBackend>;
  rpc: typeof presignedCoreRpc;
  requiredConfirmations: number;
  assertEnabled: (protocol: PresignedProtocol) => void;
}
type CashoutStatus = 'approved' | 'prepared' | 'submitting' | 'pending' | 'confirmed' | 'spent' | 'deferred';
interface Row {
  id: string; vault_id: string; protocol: PresignedProtocol; epoch_id: string; user_id: string; participant_id: ParticipantId;
  artifact_json: PresignedSignedCashout; artifact_digest: Buffer; graph_digest: Buffer; txid: Buffer;
  source_txid: Buffer; source_vout: string; status: CashoutStatus; attempt_count: number;
  reason: string | null; confirmation_block_hash: Buffer | null; confirmation_height: number | null;
  created_at: Date; updated_at: Date; last_checked_at: Date | null;
}
interface Member { vaultId: string; protocol: PresignedProtocol; participantId: ParticipantId }
function dependencies(): PresignedCashoutDependencies {
  return { backend: presignedCoreBackend(), rpc: presignedCoreRpc, requiredConfirmations: chainConfirmationsRequired(),
    assertEnabled: protocol => assert(presignedBroadcastEnabled(protocol), 'cash-out broadcasting needs separate approval for this exact protocol and network') };
}
const json = (value: unknown): any => JSON.parse(JSON.stringify(value));
const bytes = (hex: string) => Buffer.from(hex, 'hex');

/** Public signed bytes only. Neither coordinator membership nor a JSON label is spend authority. */
function validateArtifact(value: PresignedSignedCashout) {
  assert(canonicalJson(value).length <= 1024 * 1024, 'cash-out artifact is too large');
  exactKeys(value, ['request','cashout','transactionHex'], 'signed cash-out artifact');
  const completed = authorizePresignedCashoutTransaction(value);
  assert(value.request.publicKit.graph.roster.network === BITCOIN_NETWORK_NAME, 'cash-out belongs to another deployment network');
  return { completed, digest: commitmentDigest(presignedDomain(value.cashout.protocol, 'signed-owned-cashout'), value) };
}
async function memberFor(userId: string, sql: Sql | TransactionSql): Promise<Member> {
  identifier(userId, 'cash-out user');
  const rows = await sql<Array<{ vault_id: string; protocol: string; participant_id: ParticipantId }>>`
    SELECT m.vault_id,v.protocol,m.participant_id FROM vault_members m JOIN vaults v ON v.id=m.vault_id WHERE m.user_id=${userId}::uuid`;
  assert(rows.length === 1 && isPresignedProtocol(rows[0]!.protocol), 'one known presigned cash-out membership is required');
  return { vaultId: rows[0]!.vault_id, protocol: rows[0]!.protocol as PresignedProtocol, participantId: rows[0]!.participant_id };
}
async function retainedAuthority(member: Member, value: PresignedSignedCashout, sql: Sql | TransactionSql) {
  assert(value.cashout.protocol === member.protocol && value.cashout.participantId === member.participantId &&
    value.request.participantId === member.participantId && value.request.publicKit.graph.roster.vaultId === member.vaultId,
    'cash-out belongs to another vault, protocol or participant');
  const graph = value.request.publicKit.graph;
  const epoch = await loadPresignedFundingEpoch(member.vaultId, graph.funding.epochId, sql);
  assert(epoch.graph, 'cash-out lost its retained graph');
  const retained = createPresignedPublicKit({ graph: epoch.graph, preauthorizations: epoch.preauthorizations,
    recoveryAuthorizations: epoch.recoveryAuthorizations });
  sameCanonical(value.request.publicKit, retained, 'cash-out retained public kit');
  return validateArtifact(value);
}
function summary(row: Row) {
  return { cashoutId: row.id, txid: row.txid.toString('hex'), status: row.status, reason: row.reason,
    artifact: row.artifact_json, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
    lastCheckedAt: row.last_checked_at?.toISOString() ?? null,
    confirmationBlockHash: row.confirmation_block_hash?.toString('hex') ?? null, confirmationHeight: row.confirmation_height };
}

/** Last observed status only; an authenticated GET does not initiate a spend. */
export async function getPresignedCashoutStatus(userId: string) {
  const member = await memberFor(userId, db());
  const rows = await db()<Row[]>`SELECT * FROM presigned_cashout_intents
    WHERE vault_id=${member.vaultId}::uuid AND user_id=${userId}::uuid AND participant_id=${member.participantId}
      AND protocol=${member.protocol} ORDER BY created_at DESC,id DESC LIMIT 32`;
  for (const row of rows) {
    const checked = validateArtifact(row.artifact_json);
    assert(checked.digest === row.artifact_digest.toString('hex'), 'retained cash-out artifact changed');
  }
  return { version: presignedVersion(member.protocol), ...member, broadcastAvailable: presignedBroadcastEnabled(member.protocol),
    chainAuthority: 'last-observed-not-live' as const, intents: rows.map(summary) };
}
export type PresignedCashoutStatus = Awaited<ReturnType<typeof getPresignedCashoutStatus>>;

/** Save only. An explicit owner broadcast request must queue these immutable bytes. */
export async function preparePresignedCashout(userId: string, value: PresignedSignedCashout,
  backend: PresignedCashoutDependencies = dependencies()) {
  identifier(userId, 'cash-out user');
  await consumeRateLimit({ action: 'presigned_cashout_prepare', subject: userId, limit: 40, windowSeconds: 900 });
  validateArtifact(value);
  return transaction(async sql => {
    const member = await memberFor(userId, sql);
    await sql`SELECT id FROM vaults WHERE id=${member.vaultId}::uuid FOR UPDATE`;
    const checked = await retainedAuthority(member, value, sql);
    const existing = await sql<Row[]>`SELECT * FROM presigned_cashout_intents
      WHERE vault_id=${member.vaultId}::uuid AND user_id=${userId}::uuid AND txid=${bytes(checked.completed.txid)}`;
    if (existing.length) {
      assert(existing[0]!.graph_digest.toString('hex') === value.cashout.graphDigest &&
        existing[0]!.participant_id === member.participantId, 'same cash-out transaction changed graph or owner');
      // Valid alternate witnesses/confirmation metadata do not replace the first retained bytes.
      assert(nonWitnessTransactionHex(bitcoin.Transaction.fromHex(existing[0]!.artifact_json.transactionHex)) === value.cashout.unsignedTxHex,
        'cash-out transaction ID collision');
      return summary(existing[0]!);
    }
    assert(await sourceState(value, backend, true) === 'available', 'cash-out source is unavailable or already spent');
    const rows = await sql<Row[]>`INSERT INTO presigned_cashout_intents
      (vault_id,protocol,epoch_id,user_id,participant_id,artifact_json,artifact_digest,graph_digest,txid,source_txid,source_vout)
      VALUES (${member.vaultId}::uuid,${member.protocol},${value.request.publicKit.graph.funding.epochId}::uuid,${userId}::uuid,
        ${member.participantId},${sql.json(json(value))},${bytes(checked.digest)},${bytes(value.cashout.graphDigest)},
        ${bytes(value.cashout.txid)},${bytes(value.cashout.source.txid)},${value.cashout.source.vout}) RETURNING *`;
    return summary(rows[0]!);
  });
}

/** Only an authenticated owner may turn a saved signed artifact into a send intent. */
export async function queuePresignedCashout(userId: string, cashoutId: string) {
  identifier(cashoutId, 'cash-out intent');
  await consumeRateLimit({ action: 'presigned_cashout_broadcast', subject: userId, limit: 40, windowSeconds: 900 });
  return transaction(async sql => {
    const member = await memberFor(userId, sql);
    assert(presignedBroadcastEnabled(member.protocol), 'cash-out broadcasting needs separate approval for this exact protocol and network');
    const rows = await sql<Row[]>`SELECT * FROM presigned_cashout_intents WHERE id=${cashoutId}::uuid
      AND user_id=${userId}::uuid AND vault_id=${member.vaultId}::uuid AND participant_id=${member.participantId}
      AND protocol=${member.protocol} FOR UPDATE`;
    assert(rows.length === 1, 'cash-out intent is not owned by this member');
    await retainedAuthority(member, rows[0]!.artifact_json, sql);
    await sql`UPDATE presigned_cashout_intents SET status='prepared',updated_at=now(),reason=NULL
      WHERE id=${cashoutId}::uuid AND status='approved'`;
    return { cashoutId, txid: rows[0]!.txid.toString('hex'),
      status: rows[0]!.status === 'approved' ? 'prepared' as const : rows[0]!.status };
  });
}

/** Call under the global watcher lease. A per-attempt fence protects lost-lease workers too. */
export async function submitPresignedCashout(cashoutId: string, backend: PresignedCashoutDependencies = dependencies()) {
  identifier(cashoutId, 'cash-out intent');
  const claimed = await transaction(async sql => {
    const rows = await sql<Row[]>`SELECT * FROM presigned_cashout_intents WHERE id=${cashoutId}::uuid FOR UPDATE`;
    const row = rows[0]; assert(row, 'cash-out intent is missing'); backend.assertEnabled(row.protocol);
    const updated = await sql<Row[]>`UPDATE presigned_cashout_intents SET status='submitting',attempt_count=attempt_count+1,
      updated_at=now(),reason=NULL,last_error_code=NULL WHERE id=${cashoutId}::uuid
      AND (status IN ('prepared','pending','confirmed','spent','deferred') OR (status='submitting' AND updated_at<now()-interval '45 seconds')) RETURNING *`;
    return updated[0] ?? null;
  });
  if (!claimed) return { cashoutId, status: 'submitting' as const, reason: 'This intent is not queued or another submission is in progress.' };
  try {
    const member = await memberFor(claimed.user_id, db());
    assert(member.vaultId === claimed.vault_id && member.participantId === claimed.participant_id && member.protocol === claimed.protocol,
      'cash-out membership changed');
    const checked = await retainedAuthority(member, claimed.artifact_json, db());
    assert(checked.digest === claimed.artifact_digest.toString('hex') && checked.completed.txid === claimed.txid.toString('hex'),
      'cash-out retained bytes changed');
    const existing = await existingState(claimed.artifact_json, backend);
    if (existing) return finish(claimed, existing.status, null, existing.blockHash, existing.height);
    const source = await sourceState(claimed.artifact_json, backend, false);
    if (source === 'spent') return finish(claimed, 'spent', 'The exact owner payout was spent by another confirmed transaction.');
    assert(source === 'available', 'another mempool transaction has claimed this payout');
    const policy = await backend.rpc<Array<{ txid: string; allowed: boolean }>>('testmempoolaccept', [[checked.completed.transactionHex]]);
    assert(policy.length === 1 && policy[0]!.txid === checked.completed.txid && policy[0]!.allowed === true,
      'Core policy deferred this exact cash-out; prepare a separately reviewed replacement if its fee is insufficient');
    assert(await backend.rpc<string>('sendrawtransaction', [checked.completed.transactionHex]) === checked.completed.txid,
      'Core returned another cash-out transaction ID');
    return finish(claimed, 'pending', null);
  } catch (error) {
    const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
    return finish(claimed, 'deferred', 'Exact signed cash-out is retained. Current source, confirmation or fee readiness could not be verified.',
      null, null, typeof code === 'number' && Number.isSafeInteger(code) ? code : null);
  }
}

export async function retryPresignedCashouts(backend?: PresignedCashoutDependencies) {
  const protocols = [PRESIGNED_PROTOCOL, PRESIGNED_PROTOCOL_V3].filter(protocol => presignedBroadcastEnabled(protocol));
  if (!protocols.length) return { enabled: false, results: [] };
  const rows = await db()<Array<{ id: string }>>`SELECT id FROM presigned_cashout_intents WHERE protocol IN ${db()(protocols)}
    AND (status IN ('prepared','pending','confirmed','spent','deferred') OR (status='submitting' AND updated_at<now()-interval '45 seconds'))
    ORDER BY updated_at,id LIMIT 100`;
  const results = [];
  for (const row of rows) results.push(await submitPresignedCashout(row.id, backend));
  return { enabled: true, results };
}

async function existingState(value: PresignedSignedCashout, backend: PresignedCashoutDependencies) {
  const before = await backend.backend.getTip();
  const existing = await backend.backend.getTransaction(value.cashout.txid);
  assert(existing.kind !== 'unknown', 'cash-out transaction lookup is unavailable');
  if (existing.kind === 'absent') return null;
  assert(nonWitnessTransactionHex(bitcoin.Transaction.fromHex(existing.transactionHex)) === value.cashout.unsignedTxHex,
    'observed cash-out changed its exact transaction');
  if (existing.blockHash) {
    const block = await backend.backend.getBlock(existing.blockHash);
    assert(block.kind !== 'unknown', 'cash-out confirmation anchor is unknown');
    if (block.kind === 'inactive') return null;
    assert(block.confirmations === before.height - block.height + 1, 'cash-out confirmation depth changed');
    sameCanonical(before, await backend.backend.getTip(), 'cash-out confirmation tip');
    return { status: block.confirmations >= backend.requiredConfirmations ? 'confirmed' as const : 'pending' as const,
      blockHash: block.hash, height: block.height };
  }
  // getrawtransaction without a block anchor is Core's actual mempool result.
  sameCanonical(before, await backend.backend.getTip(), 'cash-out mempool observation tip');
  return { status: 'pending' as const, blockHash: null, height: null };
}
async function sourceState(value: PresignedSignedCashout, backend: PresignedCashoutDependencies, originalAnchor: boolean) {
  const before = await backend.backend.getTip();
  const source = value.cashout.source;
  const parent = await backend.backend.getTransaction(source.txid);
  assert(parent.kind === 'present' && parent.blockHash, 'cash-out parent is not confirmed');
  assert(nonWitnessTransactionHex(bitcoin.Transaction.fromHex(parent.transactionHex)) ===
    nonWitnessTransactionHex(bitcoin.Transaction.fromHex(value.request.parentTransactionHex)), 'cash-out parent changed');
  const block = await backend.backend.getBlock(parent.blockHash);
  assert(block.kind === 'active' && block.confirmations >= backend.requiredConfirmations &&
    block.confirmations === before.height - block.height + 1, 'cash-out parent lacks an active sufficiently deep anchor');
  if (originalAnchor) assert(block.hash === value.request.sourceObservation.confirmationBlockHash &&
    block.confirmations >= value.request.sourceObservation.confirmations, 'cash-out initial source observation changed');
  const available = await backend.backend.getOutputAvailability(source);
  assert(available.kind !== 'unknown', 'cash-out source availability is unknown');
  if (available.kind === 'available') {
    const coin = await backend.backend.observeCoin(source);
    assert(coin.valueSats === source.valueSats && coin.scriptPubKeyHex === source.scriptPubKeyHex &&
      coin.confirmationBlockHash === block.hash && coin.confirmations >= backend.requiredConfirmations,
      'cash-out confirmed source changed');
  }
  sameCanonical(before, await backend.backend.getTip(), 'cash-out source observation tip');
  return available.kind === 'chain-spent' ? 'spent' : available.kind === 'mempool-spent' ? 'pending-spend' : 'available';
}
async function finish(row: Row, status: CashoutStatus, reason: string | null,
  blockHash: string | null = null, height: number | null = null, errorCode: number | null = null) {
  const updated = await db()<Row[]>`UPDATE presigned_cashout_intents SET status=${status},reason=${reason},last_error_code=${errorCode},
    confirmation_block_hash=${blockHash ? bytes(blockHash) : null},confirmation_height=${height},last_checked_at=now(),updated_at=now()
    WHERE id=${row.id}::uuid AND status='submitting' AND attempt_count=${row.attempt_count} RETURNING *`;
  if (!updated.length) return { cashoutId: row.id, txid: row.txid.toString('hex'), status: 'submitting' as const,
    reason: 'A newer attempt owns this intent; its state was not overwritten.' };
  const result = summary(updated[0]!);
  const { artifact: _artifact, ...publicResult } = result;
  return publicResult;
}
