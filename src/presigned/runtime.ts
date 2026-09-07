import { Buffer } from 'buffer';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { authorizePresignedExitTransaction, type AuthorizedPresignedTransaction } from './signing.js';
import { buildPresignedSpend, authorizePresignedSpendTransaction, finalizePresignedCooperative,
  finalizePresignedRecovery, validatePresignedCooperativeNonces, verifyPresignedCooperativePartial,
  verifyPresignedRecoveryContribution, type PresignedCooperativePublicNonce, type PresignedCooperativePartial,
  type PresignedRecoveryContribution, type PresignedSpendProposal, type PresignedSpendSource } from './spends.js';
import type { PresignedConfirmedCoin } from './core.js';
import { PRESIGNED_PROTOCOL, type ParticipantId, type PresignedGraph } from './types.js';
import { assert, canonicalJson, commitmentDigest, exactKeys, hexBytes, identifier, participantId,
  safeInteger, sameCanonical } from './validation.js';

const DOMAIN = 'vault/presigned-graph-v2/runtime';
export type PresignedRuntimeKind = 'solo' | 'cooperative' | 'recovery' | 'final-sweep';
type ActionBase = { version: 2; protocol: typeof PRESIGNED_PROTOCOL };
export type PresignedRuntimeAction = ActionBase & (
  { kind: 'create-proposal'; epochId: string; graphDigest: string; proposalId: string; spendKind: PresignedRuntimeKind;
    sourceExitId: string | null; exitId: string | null; confirmationBlockHash: string } |
  { kind: 'reanchor-transaction'; proposalId: string; predecessorProposalId: string; predecessorProposalDigest: string;
    transactionDigest: string; confirmationBlockHash: string } |
  { kind: 'contribute-nonce'; proposalId: string; proposalDigest: string; publicNonce: PresignedCooperativePublicNonce } |
  { kind: 'contribute-partial'; proposalId: string; proposalDigest: string; partial: PresignedCooperativePartial } |
  { kind: 'contribute-recovery'; proposalId: string; proposalDigest: string; contribution: PresignedRecoveryContribution } |
  { kind: 'finalize-transaction'; proposalId: string; proposalDigest: string; transactionHex: string } |
  { kind: 'approve-broadcast'; proposalId: string; proposalDigest: string; transactionDigest: string } |
  { kind: 'abandon-proposal'; proposalId: string; proposalDigest: string; reason: string }
);
export interface PresignedRuntimeProposal {
  version: 2;
  protocol: typeof PRESIGNED_PROTOCOL;
  proposalId: string;
  epochId: string;
  graphDigest: string;
  kind: PresignedRuntimeKind;
  sourceExitId: string | null;
  exitId: string | null;
  source: PresignedSpendSource;
  confirmationBlockHash: string;
  createdByParticipantId: ParticipantId;
  reanchoredFrom: { proposalId: string; proposalDigest: string; transactionDigest: string } | null;
  actorParticipantId: ParticipantId | null;
  participantIds: ParticipantId[];
  threshold: number;
  /** Logical coordination slot only; it neither reserves nor owns an on-chain coin. */
  slot: string;
  /** Public spends.ts proposal, whose inner digest binds MuSig/recovery contributions. */
  spend: PresignedSpendProposal | null;
  unsignedTxHex: string;
  txid: string;
  psbtBase64: string;
  feeSats: number;
  digest: string;
}
export interface PresignedRuntimeFinalization extends AuthorizedPresignedTransaction {
  transactionDigest: string;
  approverParticipantIds: ParticipantId[];
}
export interface PresignedRuntimeState {
  version: 2;
  protocol: typeof PRESIGNED_PROTOCOL;
  proposal: PresignedRuntimeProposal;
  status: 'collecting' | 'finalized' | 'abandoned';
  publicNonces: PresignedCooperativePublicNonce[];
  nonceSetDigest: string | null;
  partials: PresignedCooperativePartial[];
  recoveryContributions: PresignedRecoveryContribution[];
  finalized: PresignedRuntimeFinalization | null;
  broadcastApprovals: ParticipantId[];
  abandonedByParticipantId: ParticipantId | null;
  abandonReason: string | null;
}
/** Active-chain UTXO only: a competing mempool transaction is not exclusive ownership of the source. */
export type PresignedRuntimeCoinObservation = PresignedConfirmedCoin;
/** Trusted in-process private-Core boundary, never a client status boolean. */
export type PresignedRuntimeCoinObserver = (request: {
  network: PresignedGraph['roster']['network']; genesisHash: string; source: PresignedSpendSource;
}) => Promise<PresignedRuntimeCoinObservation>;

/** Public exact schemas intentionally have no participant seed, secret nonce, PRF or private-key fields. */
export function validatePresignedRuntimeAction(candidate: unknown): PresignedRuntimeAction {
  boundedPublicJson(candidate);
  assert(candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate), 'runtime action must be an object');
  const action = candidate as PresignedRuntimeAction;
  assert(action.version === 2 && action.protocol === PRESIGNED_PROTOCOL, 'wrong runtime action protocol');
  const fields: Record<PresignedRuntimeAction['kind'], string[]> = {
    'create-proposal': ['epochId', 'graphDigest', 'proposalId', 'spendKind', 'sourceExitId', 'exitId', 'confirmationBlockHash'],
    'reanchor-transaction': ['proposalId', 'predecessorProposalId', 'predecessorProposalDigest', 'transactionDigest', 'confirmationBlockHash'],
    'contribute-nonce': ['proposalId', 'proposalDigest', 'publicNonce'],
    'contribute-partial': ['proposalId', 'proposalDigest', 'partial'],
    'contribute-recovery': ['proposalId', 'proposalDigest', 'contribution'],
    'finalize-transaction': ['proposalId', 'proposalDigest', 'transactionHex'],
    'approve-broadcast': ['proposalId', 'proposalDigest', 'transactionDigest'],
    'abandon-proposal': ['proposalId', 'proposalDigest', 'reason'],
  };
  assert(Object.hasOwn(fields, action.kind), 'unknown runtime action');
  exactKeys(action, ['version', 'protocol', 'kind', ...fields[action.kind]], 'runtime action');
  identifier(action.proposalId, 'runtime proposal');
  if (action.kind === 'create-proposal') {
    identifier(action.epochId, 'runtime funding epoch'); hexBytes(action.graphDigest, 32, 'runtime graph');
    assert(['solo', 'cooperative', 'recovery', 'final-sweep'].includes(action.spendKind), 'unknown runtime spend kind');
    if (action.sourceExitId !== null) exitIdentifier(action.sourceExitId);
    if (action.exitId !== null) exitIdentifier(action.exitId);
    hexBytes(action.confirmationBlockHash, 32, 'runtime source anchor');
  } else if (action.kind === 'reanchor-transaction') {
    identifier(action.predecessorProposalId, 'predecessor runtime proposal');
    hexBytes(action.predecessorProposalDigest, 32, 'predecessor runtime digest');
    hexBytes(action.transactionDigest, 32, 'predecessor transaction digest');
    hexBytes(action.confirmationBlockHash, 32, 'new source confirmation anchor');
    assert(action.proposalId !== action.predecessorProposalId, 'reanchor requires a fresh proposal ID');
  } else hexBytes(action.proposalDigest, 32, 'runtime proposal digest');
  if (action.kind === 'contribute-nonce') validateContributionShape(action.publicNonce, 'nonce');
  if (action.kind === 'contribute-partial') validateContributionShape(action.partial, 'partial');
  if (action.kind === 'contribute-recovery') validateContributionShape(action.contribution, 'recovery');
  if (action.kind === 'finalize-transaction') {
    assert(typeof action.transactionHex === 'string' && /^(?:[0-9a-f]{2}){1,10000}$/u.test(action.transactionHex), 'invalid completed runtime transaction bytes');
  }
  if (action.kind === 'approve-broadcast') hexBytes(action.transactionDigest, 32, 'broadcast transaction digest');
  if (action.kind === 'abandon-proposal') {
    assert(typeof action.reason === 'string' && action.reason.length >= 10 && action.reason.length <= 500 &&
      action.reason === action.reason.trim().replace(/\s+/gu, ' '), 'abandon reason must be canonical and 10-500 characters');
  }
  return JSON.parse(canonicalJson(action)) as PresignedRuntimeAction;
}
export function presignedRuntimeActionDigest(action: PresignedRuntimeAction): string {
  return commitmentDigest(`${DOMAIN}/action`, validatePresignedRuntimeAction(action));
}

export function buildPresignedRuntimeProposal(input: {
  graph: PresignedGraph;
  action: Extract<PresignedRuntimeAction, { kind: 'create-proposal' }>;
  participantId: ParticipantId;
  reanchoredFrom?: PresignedRuntimeProposal['reanchoredFrom'];
}): PresignedRuntimeProposal {
  const action = validatePresignedRuntimeAction(input.action);
  assert(action.kind === 'create-proposal', 'runtime proposal requires a creation action');
  participantId(input.participantId);
  const reanchoredFrom = input.reanchoredFrom ?? null;
  if (reanchoredFrom) {
    exactKeys(reanchoredFrom, ['proposalId','proposalDigest','transactionDigest'], 'predecessor execution commitment');
    identifier(reanchoredFrom.proposalId, 'predecessor proposal'); hexBytes(reanchoredFrom.proposalDigest, 32, 'predecessor proposal digest');
    hexBytes(reanchoredFrom.transactionDigest, 32, 'predecessor exact transaction');
    assert(reanchoredFrom.proposalId !== action.proposalId, 'reanchor cannot replace its predecessor in place');
  }
  assert(action.graphDigest === input.graph.digest && action.epochId === input.graph.funding.epochId,
    'runtime creation changed the retained graph or epoch');
  // buildPresignedSpend independently rebuilds the graph and only recognizes its exact committed source coins.
  const built = buildPresignedSpend({ graph: input.graph, proposalId: action.proposalId,
    kind: action.spendKind === 'solo' ? 'cooperative' : action.spendKind, sourceExitId: action.sourceExitId });
  assert(built.participantIds.includes(input.participantId), 'runtime proposer is not a current source participant');
  const exit = action.spendKind === 'solo' ? input.graph.exits.find(item => item.id === action.exitId) : null;
  if (action.spendKind === 'solo') {
    assert(exit && exit.leaver === input.participantId && exit.parentExitId === action.sourceExitId,
      'solo proposal must select this participant and exact current graph branch');
    assert(exit.inputTxid === built.source.txid && exit.inputVout === built.source.vout &&
      exit.inputValueSats === built.source.valueSats && exit.inputScriptPubKeyHex === built.source.scriptPubKeyHex,
    'solo exit changed its committed source');
  } else assert(action.exitId === null, 'non-solo proposal must not name a solo exit');
  const actorParticipantId = action.spendKind === 'solo' ? input.participantId
    : action.spendKind === 'final-sweep' ? built.source.owner : null;
  const body = { version: 2 as const, protocol: PRESIGNED_PROTOCOL, proposalId: action.proposalId,
    epochId: action.epochId, graphDigest: action.graphDigest, kind: action.spendKind,
    sourceExitId: action.sourceExitId, exitId: action.exitId, source: built.source,
    confirmationBlockHash: action.confirmationBlockHash, createdByParticipantId: input.participantId, reanchoredFrom,
    actorParticipantId, participantIds: built.participantIds, threshold: exit ? 1 : built.threshold,
    slot: actorParticipantId ? `${action.spendKind}:${actorParticipantId}` : action.spendKind,
    spend: exit ? null : built, unsignedTxHex: exit?.unsignedTxHex ?? built.unsignedTxHex,
    txid: exit?.txid ?? built.txid, psbtBase64: exit?.psbtBase64 ?? built.psbtBase64, feeSats: exit?.feeSats ?? built.feeSats };
  return { ...body, digest: commitmentDigest(`${DOMAIN}/proposal`, body) };
}
export function validatePresignedRuntimeProposal(graph: PresignedGraph, proposal: PresignedRuntimeProposal): PresignedRuntimeProposal {
  exactKeys(proposal, ['version', 'protocol', 'proposalId', 'epochId', 'graphDigest', 'kind', 'sourceExitId', 'exitId',
    'source', 'confirmationBlockHash', 'createdByParticipantId', 'reanchoredFrom', 'actorParticipantId', 'participantIds', 'threshold',
    'slot', 'spend', 'unsignedTxHex', 'txid', 'psbtBase64', 'feeSats', 'digest'], 'runtime proposal');
  const rebuilt = buildPresignedRuntimeProposal({ graph, participantId: proposal.createdByParticipantId, reanchoredFrom: proposal.reanchoredFrom,
    action: { version: 2, protocol: PRESIGNED_PROTOCOL, kind: 'create-proposal', proposalId: proposal.proposalId,
      epochId: proposal.epochId, graphDigest: proposal.graphDigest, spendKind: proposal.kind,
      sourceExitId: proposal.sourceExitId, exitId: proposal.exitId, confirmationBlockHash: proposal.confirmationBlockHash } });
  sameCanonical(proposal, rebuilt, 'runtime proposal');
  return rebuilt;
}

/** New execution context for the SAME signed bytes; never reconstructs or copies MuSig nonce secrets/partials. */
export function buildPresignedRuntimeReanchor(input: {
  graph: PresignedGraph; predecessor: PresignedRuntimeState;
  action: Extract<PresignedRuntimeAction,{ kind: 'reanchor-transaction' }>; participantId: ParticipantId;
}): PresignedRuntimeProposal {
  const action = validatePresignedRuntimeAction(input.action);
  assert(action.kind === 'reanchor-transaction', 'reanchor action required');
  const previous = validatePresignedRuntimeProposal(input.graph,input.predecessor.proposal);
  assert(input.predecessor.status === 'finalized' && input.predecessor.finalized, 'only an exact retained finalized transaction can be reanchored');
  const completed = authorizedFinalization(input.graph,previous,input.predecessor.finalized,input.predecessor.finalized.approverParticipantIds);
  sameCanonical(completed,input.predecessor.finalized,'predecessor exact transaction');
  assert(action.predecessorProposalId === previous.proposalId && action.predecessorProposalDigest === previous.digest &&
    action.transactionDigest === completed.transactionDigest, 'reanchor changed its predecessor or signed transaction');
  assert(action.confirmationBlockHash !== previous.confirmationBlockHash, 'reanchor must identify a new active source block');
  const proposal = buildPresignedRuntimeProposal({ graph: input.graph, participantId: input.participantId,
    reanchoredFrom: { proposalId: previous.proposalId,proposalDigest: previous.digest,transactionDigest: completed.transactionDigest },
    action: { version: 2,protocol: PRESIGNED_PROTOCOL,kind: 'create-proposal',epochId: previous.epochId,
      graphDigest: previous.graphDigest,proposalId: action.proposalId,spendKind: previous.kind,
      sourceExitId: previous.sourceExitId,exitId: previous.exitId,confirmationBlockHash: action.confirmationBlockHash } });
  assert(proposal.txid === completed.txid && proposal.unsignedTxHex === previous.unsignedTxHex,
    'reanchor must preserve the exact unsigned transaction and txid');
  return proposal;
}

export function assertPresignedRuntimeObservation(input: {
  graph: PresignedGraph; proposal: PresignedRuntimeProposal; observed: PresignedRuntimeCoinObservation; requiredConfirmations: number;
}): void {
  safeInteger(input.requiredConfirmations, 1, 2_000_000, 'runtime required confirmations');
  const { graph, proposal, observed } = input;
  exactKeys(observed, ['network', 'genesisHash', 'txid', 'vout', 'valueSats', 'scriptPubKeyHex',
    'confirmationBlockHash', 'confirmations', 'unspentInActiveChain', 'coinbase'], 'trusted runtime source observation');
  assert(observed.network === graph.roster.network && observed.genesisHash === graph.roster.genesisHash &&
    observed.unspentInActiveChain === true && observed.coinbase === false &&
    observed.txid === proposal.source.txid && observed.vout === proposal.source.vout &&
    observed.valueSats === proposal.source.valueSats && observed.scriptPubKeyHex === proposal.source.scriptPubKeyHex &&
    observed.confirmationBlockHash === proposal.confirmationBlockHash, 'runtime source changed, was spent, reanchored or belongs to another chain');
  const minimum = proposal.kind === 'recovery' ? Math.max(input.requiredConfirmations, graph.roster.economics.recoveryDelayBlocks)
    : input.requiredConfirmations;
  safeInteger(observed.confirmations, minimum, 2_000_000, 'runtime source confirmation depth or recovery CSV age');
}

/** Public-only deterministic transition. Stores must serialize it under the shared vault row lock. */
export function applyPresignedRuntimeAction(input: {
  graph: PresignedGraph; state: PresignedRuntimeState | null; action: PresignedRuntimeAction; participantId: ParticipantId;
  observation: PresignedRuntimeCoinObservation | null; requiredConfirmations: number;
}): PresignedRuntimeState {
  const action = validatePresignedRuntimeAction(input.action);
  participantId(input.participantId);
  if (action.kind === 'create-proposal') {
    assert(input.state === null, 'runtime proposal IDs cannot be reused');
    const proposal = buildPresignedRuntimeProposal({ graph: input.graph, action, participantId: input.participantId });
    assert(input.observation, 'private-Core runtime source observation is required');
    assertPresignedRuntimeObservation({ graph: input.graph, proposal, observed: input.observation, requiredConfirmations: input.requiredConfirmations });
    return { version: 2, protocol: PRESIGNED_PROTOCOL, proposal, status: 'collecting', publicNonces: [], nonceSetDigest: null,
      partials: [], recoveryContributions: [], finalized: null, broadcastApprovals: [], abandonedByParticipantId: null, abandonReason: null };
  }
  if (action.kind === 'reanchor-transaction') {
    assert(input.state, 'reanchor predecessor is missing');
    const proposal = buildPresignedRuntimeReanchor({ graph: input.graph,predecessor: input.state,action,participantId: input.participantId });
    assert(input.observation, 'private-Core reanchor source observation is required');
    assertPresignedRuntimeObservation({ graph: input.graph,proposal,observed: input.observation,requiredConfirmations: input.requiredConfirmations });
    const finalized = authorizedFinalization(input.graph,proposal,input.state.finalized!,input.state.finalized!.approverParticipantIds);
    return { version: 2,protocol: PRESIGNED_PROTOCOL,proposal,status: 'finalized',publicNonces: [],nonceSetDigest: null,
      partials: [],recoveryContributions: [],finalized,broadcastApprovals: [],abandonedByParticipantId: null,abandonReason: null };
  }
  assert(input.state, 'runtime proposal is missing');
  const state = structuredClone(input.state);
  const proposal = validatePresignedRuntimeProposal(input.graph, state.proposal);
  assert(action.proposalId === proposal.proposalId && action.proposalDigest === proposal.digest, 'runtime action changed its exact proposal');
  assert(proposal.participantIds.includes(input.participantId), 'runtime action is not from a current source participant');
  if (action.kind === 'abandon-proposal') {
    assert(state.status === 'collecting' && !state.finalized && !state.broadcastApprovals.length, 'finalized or approved transactions cannot be abandoned or revoked');
    assert(proposal.actorParticipantId === null || proposal.actorParticipantId === input.participantId, 'another participant cannot abandon a unilateral slot');
    state.status = 'abandoned'; state.abandonReason = action.reason; state.abandonedByParticipantId = input.participantId;
    return state;
  }
  assert(input.observation, 'private-Core runtime source observation is required');
  assertPresignedRuntimeObservation({ graph: input.graph, proposal, observed: input.observation, requiredConfirmations: input.requiredConfirmations });
  if (action.kind === 'approve-broadcast') {
    assert(state.status === 'finalized' && state.finalized, 'broadcast approval requires exact completed bytes');
    const completed = authorizedFinalization(input.graph, proposal, state.finalized, state.finalized.approverParticipantIds);
    sameCanonical(state.finalized, completed, 'retained runtime finalization');
    assert(action.transactionDigest === completed.transactionDigest, 'broadcast approval changed completed witness bytes');
    assert(completed.approverParticipantIds.includes(input.participantId), 'broadcast approval requires the exact transaction signer quorum');
    assert(!state.broadcastApprovals.includes(input.participantId), 'participant already approved these broadcast bytes');
    state.broadcastApprovals.push(input.participantId); state.broadcastApprovals.sort();
    return state;
  }
  assert(state.status === 'collecting' && !state.finalized, 'runtime proposal is abandoned or already finalized');
  if (action.kind === 'contribute-nonce') {
    assert(proposal.kind === 'cooperative' && proposal.spend, 'public nonces require a cooperative proposal');
    validatePublicNonce(proposal.spend, action.publicNonce, input.participantId);
    assert(!state.publicNonces.some(item => item.participantId === input.participantId || item.pubnonce === action.publicNonce.pubnonce), 'cooperative nonce or participant already contributed');
    state.publicNonces.push(action.publicNonce); state.publicNonces.sort(byParticipant);
    if (state.publicNonces.length === proposal.participantIds.length) {
      const validated = validatePresignedCooperativeNonces({ graph: input.graph, proposal: proposal.spend, publicNonces: state.publicNonces });
      state.publicNonces = validated.publicNonces; state.nonceSetDigest = validated.nonceSetDigest;
    }
    return state;
  }
  if (action.kind === 'contribute-partial') {
    assert(proposal.kind === 'cooperative' && proposal.spend && state.nonceSetDigest, 'all public nonces must be frozen before partial signing');
    assert(action.partial.participantId === input.participantId && !state.partials.some(item => item.participantId === input.participantId), 'partial belongs to another participant or was already contributed');
    state.partials.push(verifyPresignedCooperativePartial({ graph: input.graph, proposal: proposal.spend, publicNonces: state.publicNonces, partial: action.partial }));
    state.partials.sort(byParticipant);
    if (state.partials.length === proposal.participantIds.length) {
      const completed = finalizePresignedCooperative({ graph: input.graph, proposal: proposal.spend, publicNonces: state.publicNonces, partials: state.partials });
      state.finalized = authorizedFinalization(input.graph, proposal, completed, proposal.participantIds); state.status = 'finalized';
    }
    return state;
  }
  if (action.kind === 'contribute-recovery') {
    assert(proposal.kind === 'recovery' && proposal.spend, 'recovery contributions require the CSV recovery proposal');
    assert(action.contribution.participantId === input.participantId && !state.recoveryContributions.some(item => item.participantId === input.participantId), 'recovery signature belongs to another participant or was already contributed');
    state.recoveryContributions.push(verifyPresignedRecoveryContribution({ graph: input.graph, proposal: proposal.spend, contribution: action.contribution }));
    state.recoveryContributions.sort(byParticipant);
    if (state.recoveryContributions.length === proposal.threshold) {
      const completed = finalizePresignedRecovery({ graph: input.graph, proposal: proposal.spend, contributions: state.recoveryContributions });
      state.finalized = authorizedFinalization(input.graph, proposal, completed, state.recoveryContributions.map(item => item.participantId));
      state.status = 'finalized';
    }
    return state;
  }
  assert(action.kind === 'finalize-transaction' && (proposal.kind === 'solo' || proposal.kind === 'final-sweep'), 'completed bytes are accepted only for client-finalized solo or final-owner spends');
  assert(proposal.actorParticipantId === input.participantId, 'only the designated leaver or final owner can finalize this transaction');
  state.finalized = authorizedFinalization(input.graph, proposal, { transactionHex: action.transactionHex }, [input.participantId]);
  state.status = 'finalized';
  return state;
}

export function presignedRuntimeBroadcastReady(state: PresignedRuntimeState): boolean {
  return state.status === 'finalized' && state.finalized !== null && state.finalized.approverParticipantIds.length > 0 &&
    state.finalized.approverParticipantIds.every(id => state.broadcastApprovals.includes(id));
}
export function presignedRuntimeTransactionDigest(proposal: PresignedRuntimeProposal, completed: AuthorizedPresignedTransaction,
  approverParticipantIds: ParticipantId[]): string {
  return commitmentDigest(`${DOMAIN}/completed-transaction`, { proposalDigest: proposal.digest,
    transactionHex: completed.transactionHex, txid: completed.txid, feeSats: completed.feeSats, vsize: completed.vsize,
    approverParticipantIds: [...approverParticipantIds].sort() });
}
function authorizedFinalization(graph: PresignedGraph, proposal: PresignedRuntimeProposal,
  input: { transactionHex: string }, approvers: ParticipantId[]): PresignedRuntimeFinalization {
  const completed = proposal.kind === 'solo'
    ? authorizePresignedExitTransaction({ graph, exitId: proposal.exitId!, transactionHex: input.transactionHex })
    : authorizePresignedSpendTransaction({ graph, proposal: proposal.spend!, transactionHex: input.transactionHex });
  const approverParticipantIds = [...approvers].sort();
  assert(approverParticipantIds.length === proposal.threshold && new Set(approverParticipantIds).size === approverParticipantIds.length &&
    approverParticipantIds.every(id => proposal.participantIds.includes(id)), 'completed transaction has a wrong approval quorum');
  if (proposal.actorParticipantId) assert(approverParticipantIds.length === 1 && approverParticipantIds[0] === proposal.actorParticipantId, 'wrong unilateral transaction approver');
  if (proposal.kind === 'recovery') {
    const round = graph.rounds.find(item => item.id === proposal.source.roundId)!;
    const witness = bitcoin.Transaction.fromHex(completed.transactionHex).ins[0]!.witness;
    const witnessSigners = round.recovery.participantIds.filter((_id, index) =>
      witness[round.recovery.participantIds.length - 1 - index]!.length !== 0).sort();
    sameCanonical(approverParticipantIds, witnessSigners, 'recovery broadcast approvers and exact witness signers');
  }
  return { ...completed, approverParticipantIds, transactionDigest: presignedRuntimeTransactionDigest(proposal, completed, approverParticipantIds) };
}
function validatePublicNonce(proposal: PresignedSpendProposal, nonce: PresignedCooperativePublicNonce, id: ParticipantId): void {
  validateContributionShape(nonce, 'nonce');
  assert(nonce.graphDigest === proposal.graphDigest && nonce.proposalId === proposal.proposalId &&
    nonce.proposalDigest === proposal.digest && nonce.participantId === id && proposal.participantIds.includes(id), 'nonce changed its participant or inner spend commitment');
  const bytes = Buffer.from(nonce.pubnonce, 'hex');
  assert(ecc.isPoint(bytes.subarray(0, 33)) && ecc.isPoint(bytes.subarray(33)), 'public nonce contains an invalid curve point');
}
function validateContributionShape(value: PresignedCooperativePublicNonce | PresignedCooperativePartial | PresignedRecoveryContribution,
  kind: 'nonce' | 'partial' | 'recovery'): void {
  exactKeys(value, ['version', 'protocol', 'graphDigest', 'proposalId', 'proposalDigest', 'participantId',
    ...(kind === 'nonce' ? ['pubnonce'] : kind === 'partial' ? ['nonceSetDigest', 'partialSignatureHex'] : ['signatureHex'])], 'runtime public contribution');
  assert(value.version === 2 && value.protocol === PRESIGNED_PROTOCOL, 'wrong public contribution protocol');
  participantId(value.participantId); identifier(value.proposalId, 'public contribution proposal');
  hexBytes(value.graphDigest, 32, 'public contribution graph'); hexBytes(value.proposalDigest, 32, 'inner spend digest');
  if ('pubnonce' in value) hexBytes(value.pubnonce, 66, 'public nonce');
  if ('partialSignatureHex' in value) { hexBytes(value.partialSignatureHex, 32, 'partial signature'); hexBytes(value.nonceSetDigest, 32, 'frozen nonce set'); }
  if ('signatureHex' in value) hexBytes(value.signatureHex, 64, 'recovery signature');
}
function byParticipant(a: { participantId: ParticipantId }, b: { participantId: ParticipantId }): number { return a.participantId.localeCompare(b.participantId); }
function exitIdentifier(value: string): void { assert(typeof value === 'string' && /^(alice|bob|carol)(\/(alice|bob|carol))?$/u.test(value), 'invalid runtime exit identifier'); }
function boundedPublicJson(value: unknown): void {
  const queue = [{ value, depth: 0 }]; let nodes = 0; let units = 0;
  while (queue.length) {
    const item = queue.pop()!; assert(++nodes <= 2000 && item.depth <= 12, 'runtime action JSON is too complex');
    if (typeof item.value === 'string') { units += item.value.length; assert(units <= 30_000, 'runtime action is too large'); }
    else if (item.value && typeof item.value === 'object') {
      assert(Array.isArray(item.value) || Object.getPrototypeOf(item.value) === Object.prototype, 'runtime action contains a non-JSON object');
      const children = Object.values(item.value); assert(children.length <= 2000, 'runtime action collection is too large');
      children.forEach(child => queue.push({ value: child, depth: item.depth + 1 }));
    } else assert(item.value === null || typeof item.value === 'boolean' || (typeof item.value === 'number' && Number.isSafeInteger(item.value)), 'runtime action contains unsupported JSON');
  }
}
