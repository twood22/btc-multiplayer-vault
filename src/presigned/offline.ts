import { validatePresignedPublicKit } from './backup.js';
import { authorizePresignedFundingTransaction } from './funding.js';
import { authorizePresignedExitTransaction } from './signing.js';
import { authorizePresignedSpendTransaction, finalizePresignedCooperative, finalizePresignedRecovery,
  validatePresignedCooperativeNonces, validatePresignedSpend, verifyPresignedCooperativePartial,
  verifyPresignedCooperativePublicNonce, verifyPresignedRecoveryContribution,
  type PresignedSpendProposal, type PresignedCooperativePartial, type PresignedCooperativePublicNonce,
  type PresignedRecoveryContribution } from './spends.js';
import { PRESIGNED_PROTOCOL, type PresignedGraph, type PresignedPublicKit } from './types.js';
import { assert, canonicalJson, exactKeys, sameCanonical } from './validation.js';

/** Public-only peer file. Secret nonces are never exportable or restorable. */
export interface PresignedOfflineExchange {
  version: 2; protocol: typeof PRESIGNED_PROTOCOL; format: 'presigned-offline-exchange-v1';
  graphDigest: string; proposal: PresignedSpendProposal;
  publicNonces: PresignedCooperativePublicNonce[];
  partials: PresignedCooperativePartial[];
  recoveryContributions: PresignedRecoveryContribution[];
}
export function newPresignedOfflineExchange(graph: PresignedGraph, proposal: PresignedSpendProposal): PresignedOfflineExchange {
  validatePresignedSpend(graph, proposal);
  assert(proposal.kind !== 'final-sweep', 'final sweep needs no peer exchange');
  return { version: 2, protocol: PRESIGNED_PROTOCOL, format: 'presigned-offline-exchange-v1',
    graphDigest: graph.digest, proposal, publicNonces: [], partials: [], recoveryContributions: [] };
}
export function validatePresignedOfflineExchange(kit: PresignedPublicKit, input: unknown): PresignedOfflineExchange {
  const { graph } = validatePresignedPublicKit(kit);
  exactKeys(input, ['version','protocol','format','graphDigest','proposal','publicNonces','partials','recoveryContributions'], 'offline peer file');
  const exchange = input as PresignedOfflineExchange;
  assert(exchange.version === 2 && exchange.protocol === PRESIGNED_PROTOCOL &&
    exchange.format === 'presigned-offline-exchange-v1' && exchange.graphDigest === graph.digest, 'offline peer file changed its protocol or graph');
  const proposal = validatePresignedSpend(graph, exchange.proposal);
  assert(proposal.kind === 'cooperative' || proposal.kind === 'recovery', 'offline peer file has another spend kind');
  for (const list of [exchange.publicNonces, exchange.partials, exchange.recoveryContributions]) {
    assert(Array.isArray(list) && list.length <= proposal.participantIds.length &&
      new Set(list.map(item => item.participantId)).size === list.length, 'offline peer file repeats a signer or exceeds the roster');
  }
  if (proposal.kind === 'cooperative') {
    assert(exchange.recoveryContributions.length === 0, 'cooperative file contains recovery contributions');
    for (const publicNonce of exchange.publicNonces) verifyPresignedCooperativePublicNonce({ graph, proposal, publicNonce });
    assert(new Set(exchange.publicNonces.map(item => item.pubnonce)).size === exchange.publicNonces.length, 'offline peer file repeats a public nonce');
    if (exchange.partials.length) validatePresignedCooperativeNonces({ graph, proposal, publicNonces: exchange.publicNonces });
    for (const partial of exchange.partials) verifyPresignedCooperativePartial({ graph, proposal, publicNonces: exchange.publicNonces, partial });
  } else {
    assert(!exchange.publicNonces.length && !exchange.partials.length, 'recovery file contains cooperative material');
    for (const contribution of exchange.recoveryContributions) verifyPresignedRecoveryContribution({ graph, proposal, contribution });
  }
  return JSON.parse(canonicalJson(exchange)) as PresignedOfflineExchange;
}
export function mergePresignedOfflineExchanges(kit: PresignedPublicKit, current: PresignedOfflineExchange, incoming: unknown): PresignedOfflineExchange {
  const left = validatePresignedOfflineExchange(kit, current);
  const right = validatePresignedOfflineExchange(kit, incoming);
  sameCanonical(left.proposal, right.proposal, 'offline peer proposal');
  const merge = <T extends { participantId: string }>(first: T[], second: T[]): T[] => {
    const values = new Map(first.map(item => [item.participantId, item]));
    for (const item of second) {
      const before = values.get(item.participantId);
      if (before) sameCanonical(before, item, 'previously accepted offline contribution');
      values.set(item.participantId, item);
    }
    return [...values.values()].sort((a, b) => a.participantId.localeCompare(b.participantId));
  };
  return validatePresignedOfflineExchange(kit, { ...left,
    publicNonces: merge(left.publicNonces, right.publicNonces), partials: merge(left.partials, right.partials),
    recoveryContributions: merge(left.recoveryContributions, right.recoveryContributions) });
}
export function finalizePresignedOfflineExchange(kit: PresignedPublicKit, value: PresignedOfflineExchange) {
  const exchange = validatePresignedOfflineExchange(kit, value);
  return exchange.proposal.kind === 'cooperative' ? finalizePresignedCooperative({ graph: kit.graph,
    proposal: exchange.proposal, publicNonces: exchange.publicNonces, partials: exchange.partials })
    : finalizePresignedRecovery({ graph: kit.graph, proposal: exchange.proposal, contributions: exchange.recoveryContributions });
}

export type PresignedOfflineTransaction = {
  version: 2; protocol: typeof PRESIGNED_PROTOCOL; format: 'presigned-offline-transaction-v1';
  graphDigest: string; transactionHex: string; txid: string;
} & ({ kind: 'funding'; exitId: null; proposal: null } |
  { kind: 'solo'; exitId: string; proposal: null } |
  { kind: 'cooperative' | 'recovery' | 'final-sweep'; exitId: null; proposal: PresignedSpendProposal });

/** This verifies signatures and economics, not chain inclusion or spendability. */
export function validatePresignedOfflineTransaction(kit: PresignedPublicKit, input: unknown): PresignedOfflineTransaction {
  const { graph } = validatePresignedPublicKit(kit);
  exactKeys(input, ['version','protocol','format','graphDigest','transactionHex','txid','kind','exitId','proposal'], 'offline transaction file');
  const value = input as PresignedOfflineTransaction;
  assert(value.version === 2 && value.protocol === PRESIGNED_PROTOCOL && value.format === 'presigned-offline-transaction-v1' &&
    value.graphDigest === graph.digest, 'offline transaction changed its protocol or graph');
  let completed;
  if (value.kind === 'funding') {
    assert(value.proposal === null && value.exitId === null, 'funding file contains another proposal');
    completed = authorizePresignedFundingTransaction({ graph, transactionHex: value.transactionHex });
  } else if (value.kind === 'solo') {
    assert(value.proposal === null, 'solo file contains another proposal');
    completed = authorizePresignedExitTransaction({ graph, exitId: value.exitId, transactionHex: value.transactionHex });
  } else {
    assert(['cooperative','recovery','final-sweep'].includes(value.kind) && value.exitId === null &&
      value.proposal && value.proposal.kind === value.kind, 'offline transaction has another spend kind');
    completed = authorizePresignedSpendTransaction({ graph, proposal: value.proposal, transactionHex: value.transactionHex });
  }
  assert(completed.txid === value.txid, 'offline transaction ID changed');
  return value;
}

/** Parse any PUBLIC peer/draft file with a bound before recursive validation. */
export function parsePresignedOfflinePublicJson(raw: string): unknown {
  assert(typeof raw === 'string' && raw.length <= 1_048_576, 'offline public file is too large');
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('presigned-v2: offline public file is not JSON'); }
  const pending = [{ value, depth: 0 }]; let count = 0;
  while (pending.length) {
    const item = pending.pop()!;
    assert(++count <= 30_000 && item.depth < 32, 'offline public file is too complex');
    if (item.value && typeof item.value === 'object') {
      for (const child of Object.values(item.value)) pending.push({ value: child, depth: item.depth + 1 });
    }
  }
  return value;
}
