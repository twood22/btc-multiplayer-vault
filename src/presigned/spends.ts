import { Buffer } from 'buffer';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { taggedHash } from '../crypto.js';
import { applyTweak, keyAggContext, nonceAgg, nonceGen, partialSigAgg, partialSigVerify,
  sign as musigSign, type SessionContext } from '../musig2.js';
import { nonWitnessTransactionHex, psbtUnsignedTransaction, validatePresignedGraph } from './graph.js';
import { payoutScript } from './roster.js';
import type { AuthorizedPresignedTransaction } from './signing.js';
import { PRESIGNED_PROTOCOL, type ParticipantId, type PresignedGraph, type PresignedRound, type RoundId } from './types.js';
import { assert, commitmentDigest, exactKeys, hexBytes, identifier, networkParameters, participantId, sameCanonical } from './validation.js';

export type PresignedSpendKind = 'cooperative' | 'recovery' | 'final-sweep';
export interface PresignedSpendSource {
  txid: string;
  vout: number;
  valueSats: number;
  scriptPubKeyHex: string;
  roundId: RoundId | null;
  owner: ParticipantId | null;
}
export interface PresignedSpendProposal {
  version: 2;
  protocol: typeof PRESIGNED_PROTOCOL;
  graphDigest: string;
  proposalId: string;
  kind: PresignedSpendKind;
  sourceExitId: string | null;
  source: PresignedSpendSource;
  participantIds: ParticipantId[];
  threshold: number;
  feeSats: number;
  unsignedTxHex: string;
  txid: string;
  psbtBase64: string;
  signatureHash: string;
  digest: string;
}

interface SpendContributionBinding {
  version: 2;
  protocol: typeof PRESIGNED_PROTOCOL;
  graphDigest: string;
  proposalId: string;
  proposalDigest: string;
  participantId: ParticipantId;
}
export interface PresignedCooperativePublicNonce extends SpendContributionBinding { pubnonce: string }
export interface PresignedCooperativePartial extends SpendContributionBinding {
  nonceSetDigest: string;
  partialSignatureHex: string;
}
export interface PresignedRecoveryContribution extends SpendContributionBinding { signatureHex: string }

/** Matches the existing encrypted browser nonce store's authenticated binding. */
export interface PresignedCooperativeNonceBinding {
  proposalId: string;
  proposalDigest: string;
  participantId: ParticipantId;
  round: RoundId;
  message: string;
  pubnonce: string;
}

/**
 * Construct only committed graph coins and committed destinations/fees.
 * The caller must separately establish this exact source's active-chain
 * confirmation, unspent status, and recovery age before authorizing a signature.
 */
export function buildPresignedSpend(input: {
  graph: PresignedGraph;
  proposalId: string;
  kind: PresignedSpendKind;
  /** null = funding:0; first exit = pair:1; second exit = final payout:1. */
  sourceExitId: string | null;
}): PresignedSpendProposal {
  exactKeys(input, ['graph', 'proposalId', 'kind', 'sourceExitId'], 'spend build request');
  const graph = validatePresignedGraph(input.graph);
  identifier(input.proposalId, 'spend proposal id');
  assert(['cooperative', 'recovery', 'final-sweep'].includes(input.kind), 'unknown spend kind');
  const source = sourceFor(graph, input.sourceExitId);
  const round = source.roundId === null ? undefined : graph.rounds.find(item => item.id === source.roundId)!;
  assert(input.kind === 'final-sweep' ? source.owner !== null : Boolean(round), 'spend kind does not match the committed graph coin');
  const participants = source.owner ? [source.owner] : [...round!.participantIds].sort();
  const economics = graph.roster.economics;
  const feeSats = input.kind === 'cooperative' ? economics.cooperativeFeeSats
    : input.kind === 'recovery' ? economics.recoveryFeeSats : economics.finalSweepFeeSats;
  const threshold = input.kind === 'recovery' ? round!.recovery.threshold : participants.length;
  const psbt = new bitcoin.Psbt({ network: networkParameters(graph.roster.network) });
  // All newly proposed payouts support the same restricted-topology CPFP
  // policy. The caller confirms the source before relay; CSV permits V3.
  psbt.setVersion(3);
  psbt.setLocktime(0);
  const internalKey = round ? round.internalKeyHex
    : graph.roster.participants.find(item => item.id === source.owner)!.payoutXonlyPublicKeyHex;
  psbt.addInput({ hash: source.txid, index: source.vout,
    sequence: input.kind === 'recovery' ? economics.recoveryDelayBlocks : 0xffffffff,
    witnessUtxo: { script: Buffer.from(source.scriptPubKeyHex, 'hex'), value: BigInt(source.valueSats) },
    tapInternalKey: Buffer.from(internalKey, 'hex'),
    ...(round ? { tapMerkleRoot: Buffer.from(round.tapMerkleRoot, 'hex') } : {}),
    ...(input.kind === 'recovery' ? { tapLeafScript: [{ leafVersion: 0xc0,
      script: Buffer.from(round!.recovery.scriptHex, 'hex'), controlBlock: Buffer.from(round!.recovery.controlBlockHex, 'hex') }] } : {}),
  });
  const total = source.valueSats - feeSats;
  assert(total > 0, 'committed spend fee consumes the whole coin');
  const base = Math.floor(total / participants.length);
  const remainder = total % participants.length;
  participants.forEach((id, index) => {
    const value = base + (index < remainder ? 1 : 0);
    assert(value >= 330, 'committed spend creates dust');
    psbt.addOutput({ script: payoutScript(graph.roster, id), value: BigInt(value) });
  });
  const tx = psbtUnsignedTransaction(psbt);
  const signatureHash = tx.hashForWitnessV1(0, [Buffer.from(source.scriptPubKeyHex, 'hex')], [BigInt(source.valueSats)],
    bitcoin.Transaction.SIGHASH_DEFAULT, input.kind === 'recovery' ? Buffer.from(round!.recovery.leafHash, 'hex') : undefined);
  const body = { version: 2 as const, protocol: PRESIGNED_PROTOCOL, graphDigest: graph.digest,
    proposalId: input.proposalId, kind: input.kind, sourceExitId: input.sourceExitId, source,
    participantIds: participants, threshold, feeSats, unsignedTxHex: tx.toHex(), txid: tx.getId(),
    psbtBase64: psbt.toBase64(), signatureHash: Buffer.from(signatureHash).toString('hex') };
  return { ...body, digest: commitmentDigest('vault/presigned-graph-v2/spend-proposal', body) };
}

export function validatePresignedSpend(graph: PresignedGraph, proposal: PresignedSpendProposal): PresignedSpendProposal {
  exactKeys(proposal, ['version', 'protocol', 'graphDigest', 'proposalId', 'kind', 'sourceExitId', 'source',
    'participantIds', 'threshold', 'feeSats', 'unsignedTxHex', 'txid', 'psbtBase64', 'signatureHash', 'digest'], 'spend proposal');
  const rebuilt = buildPresignedSpend({ graph, proposalId: proposal.proposalId, kind: proposal.kind, sourceExitId: proposal.sourceExitId });
  sameCanonical(proposal, rebuilt, 'spend proposal');
  return rebuilt;
}

/**
 * CLIENT ONLY. Encrypt secretNonce immediately, then clear this buffer.
 * Transmit publicNonce alone. The complete result deliberately refuses JSON
 * serialization. Nonces must never enter portable recovery kits or the server.
 */
export function createPresignedCooperativeNonce(input: {
  graph: PresignedGraph; proposal: PresignedSpendProposal; participantId: ParticipantId;
  personalPrivateKey: Uint8Array; approvedProposalDigest: string;
}): { publicNonce: PresignedCooperativePublicNonce; binding: PresignedCooperativeNonceBinding; secretNonce: Uint8Array } {
  const proposal = approvedProposal(input.graph, input.proposal, input.approvedProposalDigest, 'cooperative');
  const round = roundFor(input.graph, proposal);
  const secret = personalKey(input.graph, proposal, input.participantId, input.personalPrivateKey);
  try {
    const context = cooperativeContext(round);
    const nonce = nonceGen({ secretKey: secret,
      publicKey: Buffer.from(personalPublicKey(input.graph, input.participantId), 'hex'),
      aggregateXonly: context.q.subarray(1), message: Buffer.from(proposal.signatureHash, 'hex'),
      extraIn: Buffer.from(proposal.digest, 'hex') });
    const publicNonce = { ...contributionBinding(proposal, input.participantId), pubnonce: nonce.pubnonce.toString('hex') };
    const result = { publicNonce, binding: nonceBinding(proposal, publicNonce), secretNonce: nonce.secnonce as Uint8Array };
    Object.defineProperty(result, 'toJSON', { value: () => { throw new Error('client-only secret nonce result must not be serialized'); } });
    return result;
  } finally { secret.fill(0); }
}

export function validatePresignedCooperativeNonces(input: {
  graph: PresignedGraph; proposal: PresignedSpendProposal; publicNonces: PresignedCooperativePublicNonce[];
}): { nonceSetDigest: string; publicNonces: PresignedCooperativePublicNonce[] } {
  const proposal = validatePresignedSpend(input.graph, input.proposal);
  const context = nonceSession(input.graph, proposal, input.publicNonces);
  return { nonceSetDigest: context.nonceSetDigest, publicNonces: context.publicNonces };
}

/** Validate one public contribution before all peers have joined an offline exchange. */
export function verifyPresignedCooperativePublicNonce(input: {
  graph: PresignedGraph; proposal: PresignedSpendProposal; publicNonce: PresignedCooperativePublicNonce;
}): PresignedCooperativePublicNonce {
  const proposal = validatePresignedSpend(input.graph, input.proposal);
  assert(proposal.kind === 'cooperative', 'public nonce requires a cooperative proposal');
  checkContribution(proposal, input.publicNonce, ['pubnonce']);
  nonceAgg([hexBytes(input.publicNonce.pubnonce, 66, 'cooperative public nonce')]);
  return { ...input.publicNonce };
}

// Defense in depth for copied buffers in the current process. Durable browser
// ciphertext consumption is still mandatory; process memory cannot prevent a
// stale encrypted snapshot from being restored after a restart.
const consumedPublicNonces = new Set<string>();

/**
 * CLIENT ONLY. The caller MUST durably delete the encrypted nonce before
 * decrypting/passing these bytes (consumeCooperativeSecnonce does this).
 * This function zeros the caller buffer before any validation or signing, and
 * destroys its working copy on success and every failure. A failed attempt
 * requires a fresh proposal/nonce ceremony, never restoring an old ciphertext.
 */
export function signPresignedCooperativePartial(input: {
  graph: PresignedGraph; proposal: PresignedSpendProposal; participantId: ParticipantId;
  personalPrivateKey: Uint8Array; approvedProposalDigest: string;
  publicNonces: PresignedCooperativePublicNonce[];
  nonceBinding: PresignedCooperativeNonceBinding;
  consumedSecretNonce: Uint8Array;
}): PresignedCooperativePartial {
  assert(input.consumedSecretNonce instanceof Uint8Array, 'consumed nonce must be client-held bytes');
  const nonce = Buffer.from(input.consumedSecretNonce);
  input.consumedSecretNonce.fill(0);
  let secret: Buffer | undefined;
  try {
    assert(nonce.length === 97, 'invalid consumed secret nonce length');
    const publicNonce = publicNonceFromSecret(nonce);
    const reuseToken = publicNonce.toString('hex');
    assert(!consumedPublicNonces.has(reuseToken), 'secret nonce was already consumed');
    consumedPublicNonces.add(reuseToken);
    const proposal = approvedProposal(input.graph, input.proposal, input.approvedProposalDigest, 'cooperative');
    secret = personalKey(input.graph, proposal, input.participantId, input.personalPrivateKey);
    const context = nonceSession(input.graph, proposal, input.publicNonces);
    const own = context.publicNonces.find(item => item.participantId === input.participantId);
    assert(own, 'cooperative nonce set omits the local participant');
    exactKeys(input.nonceBinding, ['proposalId', 'proposalDigest', 'participantId', 'round', 'message', 'pubnonce'], 'client nonce binding');
    sameCanonical(input.nonceBinding, nonceBinding(proposal, own), 'client nonce binding');
    assert(publicNonce.toString('hex') === own.pubnonce &&
      nonce.subarray(64).toString('hex') === personalPublicKey(input.graph, input.participantId),
    'secret nonce differs from the bound public nonce or signer');
    const partial = musigSign(nonce, secret, context.session);
    const contribution = { ...contributionBinding(proposal, input.participantId),
      nonceSetDigest: context.nonceSetDigest, partialSignatureHex: partial.toString('hex') };
    verifyPartial(input.graph, proposal, context, contribution);
    return contribution;
  } finally { nonce.fill(0); secret?.fill(0); }
}

export function verifyPresignedCooperativePartial(input: {
  graph: PresignedGraph; proposal: PresignedSpendProposal;
  publicNonces: PresignedCooperativePublicNonce[]; partial: PresignedCooperativePartial;
}): PresignedCooperativePartial {
  const proposal = validatePresignedSpend(input.graph, input.proposal);
  const context = nonceSession(input.graph, proposal, input.publicNonces);
  return verifyPartial(input.graph, proposal, context, input.partial);
}

export function finalizePresignedCooperative(input: {
  graph: PresignedGraph; proposal: PresignedSpendProposal;
  publicNonces: PresignedCooperativePublicNonce[]; partials: PresignedCooperativePartial[];
}): AuthorizedPresignedTransaction {
  const proposal = validatePresignedSpend(input.graph, input.proposal);
  const context = nonceSession(input.graph, proposal, input.publicNonces);
  assert(Array.isArray(input.partials) && input.partials.length === proposal.participantIds.length,
    'cooperation requires every current participant partial signature');
  const verified = input.partials.map(item => verifyPartial(input.graph, proposal, context, item));
  assert(new Set(verified.map(item => item.participantId)).size === proposal.participantIds.length, 'duplicate cooperative signer');
  const ordered = context.publicNonces.map(nonce => Buffer.from(verified.find(item => item.participantId === nonce.participantId)!.partialSignatureHex, 'hex'));
  const tx = bitcoin.Transaction.fromHex(proposal.unsignedTxHex);
  tx.setWitness(0, [partialSigAgg(ordered, context.session)]);
  return authorizePresignedSpendTransaction({ graph: input.graph, proposal, transactionHex: tx.toHex() });
}

export function createPresignedRecoveryContribution(input: {
  graph: PresignedGraph; proposal: PresignedSpendProposal; participantId: ParticipantId;
  personalPrivateKey: Uint8Array; approvedProposalDigest: string;
}): PresignedRecoveryContribution {
  const proposal = approvedProposal(input.graph, input.proposal, input.approvedProposalDigest, 'recovery');
  const secret = personalKey(input.graph, proposal, input.participantId, input.personalPrivateKey);
  try {
    return { ...contributionBinding(proposal, input.participantId), signatureHex:
      Buffer.from(ecc.signSchnorr(Buffer.from(proposal.signatureHash, 'hex'), secret)).toString('hex') };
  } finally { secret.fill(0); }
}

export function verifyPresignedRecoveryContribution(input: {
  graph: PresignedGraph; proposal: PresignedSpendProposal; contribution: PresignedRecoveryContribution;
}): PresignedRecoveryContribution {
  const proposal = validatePresignedSpend(input.graph, input.proposal);
  return verifyRecovery(input.graph, proposal, input.contribution);
}

export function finalizePresignedRecovery(input: {
  graph: PresignedGraph; proposal: PresignedSpendProposal; contributions: PresignedRecoveryContribution[];
}): AuthorizedPresignedTransaction {
  const proposal = validatePresignedSpend(input.graph, input.proposal);
  assert(proposal.kind === 'recovery', 'not a recovery proposal');
  const round = roundFor(input.graph, proposal);
  assert(Array.isArray(input.contributions) && input.contributions.length === round.recovery.threshold,
    'recovery requires exactly the committed N-1 threshold');
  const verified = input.contributions.map(item => verifyRecovery(input.graph, proposal, item));
  assert(new Set(verified.map(item => item.participantId)).size === verified.length, 'duplicate recovery signer');
  const signatures = round.recovery.participantIds.map(id => {
    const contribution = verified.find(item => item.participantId === id);
    return contribution ? Buffer.from(contribution.signatureHex, 'hex') : Buffer.alloc(0);
  });
  const tx = bitcoin.Transaction.fromHex(proposal.unsignedTxHex);
  tx.setWitness(0, signatures.reverse().concat([
    Buffer.from(round.recovery.scriptHex, 'hex'), Buffer.from(round.recovery.controlBlockHex, 'hex'),
  ]));
  return authorizePresignedSpendTransaction({ graph: input.graph, proposal, transactionHex: tx.toHex() });
}

export function signPresignedFinalSweep(input: {
  graph: PresignedGraph; proposal: PresignedSpendProposal; participantId: ParticipantId;
  payoutPrivateKey: Uint8Array; approvedProposalDigest: string;
}): AuthorizedPresignedTransaction {
  const proposal = approvedProposal(input.graph, input.proposal, input.approvedProposalDigest, 'final-sweep');
  assert(input.participantId === proposal.source.owner, 'only the final payout owner can sweep');
  const participant = input.graph.roster.participants.find(item => item.id === input.participantId)!;
  const secret = privateKeyCopy(input.payoutPrivateKey);
  let adjusted: Buffer | undefined;
  let tweaked: Buffer | undefined;
  try {
    const point = Buffer.from(ecc.pointFromScalar(secret, true)!);
    assert(point.subarray(1).toString('hex') === participant.payoutXonlyPublicKeyHex, 'final sweep must use the committed payout key');
    adjusted = Buffer.from(point[0] === 3 ? ecc.privateNegate(secret) : secret);
    const result = ecc.privateAdd(adjusted, taggedHash('TapTweak', point.subarray(1)));
    assert(result, 'invalid payout Taproot tweak');
    tweaked = Buffer.from(result);
    const tx = bitcoin.Transaction.fromHex(proposal.unsignedTxHex);
    tx.setWitness(0, [ecc.signSchnorr(Buffer.from(proposal.signatureHash, 'hex'), tweaked)]);
    return authorizePresignedSpendTransaction({ graph: input.graph, proposal, transactionHex: tx.toHex() });
  } finally { secret.fill(0); adjusted?.fill(0); tweaked?.fill(0); }
}

/** Exact non-witness bytes, verified witness; current recovery age is external. */
export function authorizePresignedSpendTransaction(input: {
  graph: PresignedGraph; proposal: PresignedSpendProposal; transactionHex: string;
}): AuthorizedPresignedTransaction {
  const proposal = validatePresignedSpend(input.graph, input.proposal);
  assert(typeof input.transactionHex === 'string' && input.transactionHex.length <= 20_000 && /^(?:[0-9a-f]{2})+$/u.test(input.transactionHex), 'malformed spend transaction');
  const tx = bitcoin.Transaction.fromHex(input.transactionHex);
  assert(tx.ins.length === 1 && tx.ins[0]!.script.length === 0 &&
    nonWitnessTransactionHex(tx) === proposal.unsignedTxHex && tx.getId() === proposal.txid,
  'spend changed the approved transaction or graph coin');
  const witness = tx.ins[0]!.witness;
  const message = Buffer.from(proposal.signatureHash, 'hex');
  if (proposal.kind === 'recovery') {
    const round = roundFor(input.graph, proposal);
    assert(tx.version === 3 && tx.ins[0]!.sequence === input.graph.roster.economics.recoveryDelayBlocks,
      'recovery must enforce the committed block-based relative lock');
    assert(witness.length === round.recovery.publicKeys.length + 2 &&
      Buffer.from(witness.at(-2)!).toString('hex') === round.recovery.scriptHex &&
      Buffer.from(witness.at(-1)!).toString('hex') === round.recovery.controlBlockHex,
    'recovery selected the wrong CSV/VERIFY leaf or control block');
    let valid = 0;
    round.recovery.publicKeys.forEach((key, index) => {
      const signature = witness[round.recovery.publicKeys.length - 1 - index]!;
      if (signature.length === 0) return;
      assert(signature.length === 64 && ecc.verifySchnorr(message, Buffer.from(key, 'hex'), signature), 'invalid recovery witness signature');
      valid += 1;
    });
    assert(valid === round.recovery.threshold, 'recovery witness does not satisfy exactly N-1');
  } else {
    assert(witness.length === 1 && witness[0]!.length === 64, 'key-path spend requires one SIGHASH_DEFAULT signature without annex');
    const outputKey = Buffer.from(proposal.source.scriptPubKeyHex, 'hex').subarray(2);
    assert(ecc.verifySchnorr(message, outputKey, witness[0]!), 'invalid tweaked key-path signature');
  }
  const feeSats = proposal.source.valueSats - tx.outs.reduce((sum, output) => sum + Number(output.value), 0);
  assert(feeSats === proposal.feeSats && feeSats >= tx.virtualSize(), 'spend fee differs from commitment or relay floor');
  return { transactionHex: tx.toHex(), txid: tx.getId(), feeSats, vsize: tx.virtualSize() };
}

function sourceFor(graph: PresignedGraph, sourceExitId: string | null): PresignedSpendSource {
  const exit = sourceExitId === null ? undefined : graph.exits.find(item => item.id === sourceExitId);
  assert(sourceExitId === null || exit, 'source is not an exact committed graph exit');
  const tx = bitcoin.Transaction.fromHex(exit?.unsignedTxHex ?? graph.fundingUnsignedTxHex);
  const vout = exit ? 1 : 0;
  const output = tx.outs[vout]!;
  const scriptPubKeyHex = Buffer.from(output.script).toString('hex');
  const terminal = exit?.parentExitId !== undefined && exit.parentExitId !== null;
  const round = graph.rounds.find(item => item.outputScriptHex === scriptPubKeyHex);
  assert(terminal || round, 'source is not a committed vault or final payout');
  return { txid: tx.getId(), vout, valueSats: Number(output.value), scriptPubKeyHex,
    roundId: terminal ? null : round!.id, owner: terminal ? exit!.finalParticipant : null };
}

function approvedProposal(graph: PresignedGraph, input: PresignedSpendProposal, digest: string, kind: PresignedSpendKind): PresignedSpendProposal {
  const proposal = validatePresignedSpend(graph, input);
  hexBytes(digest, 32, 'approved spend digest');
  assert(proposal.kind === kind && proposal.digest === digest, 'signer did not approve this exact spend proposal');
  return proposal;
}

function roundFor(graph: PresignedGraph, proposal: PresignedSpendProposal): PresignedRound {
  const round = graph.rounds.find(item => item.id === proposal.source.roundId);
  assert(round, 'spend does not reference a committed vault round');
  return round;
}

function personalPublicKey(graph: PresignedGraph, id: ParticipantId): string {
  participantId(id);
  const participant = graph.roster.participants.find(item => item.id === id);
  assert(participant, 'unknown personal-key participant');
  return participant.personalPublicKeyHex;
}

function privateKeyCopy(value: Uint8Array): Buffer {
  assert(value instanceof Uint8Array && value.length === 32 && ecc.isPrivate(value), 'invalid client private key');
  return Buffer.from(value);
}

function personalKey(graph: PresignedGraph, proposal: PresignedSpendProposal, id: ParticipantId, value: Uint8Array): Buffer {
  participantId(id);
  assert(proposal.participantIds.includes(id), 'participant is not a member of the current round');
  const secret = privateKeyCopy(value);
  const actual = Buffer.from(ecc.pointFromScalar(secret, true)!).toString('hex');
  if (actual !== personalPublicKey(graph, id)) {
    secret.fill(0);
    throw new Error('presigned-v2: personal private key differs from the approved roster');
  }
  return secret;
}

function contributionBinding(proposal: PresignedSpendProposal, id: ParticipantId): SpendContributionBinding {
  return { version: 2, protocol: PRESIGNED_PROTOCOL, graphDigest: proposal.graphDigest,
    proposalId: proposal.proposalId, proposalDigest: proposal.digest, participantId: id };
}

function checkContribution(proposal: PresignedSpendProposal, contribution: SpendContributionBinding, extra: string[]): void {
  exactKeys(contribution, ['version', 'protocol', 'graphDigest', 'proposalId', 'proposalDigest', 'participantId', ...extra], 'spend contribution');
  participantId(contribution.participantId);
  assert(proposal.participantIds.includes(contribution.participantId), 'contribution from a nonmember');
  const { participantId: id } = contribution;
  for (const [key, value] of Object.entries(contributionBinding(proposal, id))) {
    assert((contribution as unknown as Record<string, unknown>)[key] === value, 'contribution belongs to another proposal, graph or protocol');
  }
}

function cooperativeContext(round: PresignedRound) {
  const tweak = taggedHash('TapTweak', Buffer.concat([Buffer.from(round.internalKeyHex, 'hex'), Buffer.from(round.tapMerkleRoot, 'hex')]));
  const context = applyTweak(keyAggContext(round.personalPublicKeys), tweak, true);
  assert(context.q.subarray(1).toString('hex') === round.outputScriptHex.slice(4), 'MuSig2 tweak does not reproduce the committed output key');
  return { ...context, tweak };
}

function nonceBinding(proposal: PresignedSpendProposal, nonce: PresignedCooperativePublicNonce): PresignedCooperativeNonceBinding {
  assert(proposal.source.roundId !== null, 'cooperative nonce needs a vault round');
  return { proposalId: proposal.proposalId, proposalDigest: proposal.digest, participantId: nonce.participantId,
    round: proposal.source.roundId, message: proposal.signatureHash, pubnonce: nonce.pubnonce };
}

function publicNonceFromSecret(secnonce: Buffer): Buffer {
  const first = secnonce.subarray(0, 32);
  const second = secnonce.subarray(32, 64);
  assert(ecc.isPrivate(first) && ecc.isPrivate(second), 'secret nonce is absent, consumed, or invalid');
  return Buffer.concat([Buffer.from(ecc.pointFromScalar(first, true)!), Buffer.from(ecc.pointFromScalar(second, true)!)]);
}

function nonceSession(graph: PresignedGraph, proposal: PresignedSpendProposal, nonces: PresignedCooperativePublicNonce[]): {
  session: SessionContext; publicNonces: PresignedCooperativePublicNonce[]; pubnonceBytes: Buffer[]; nonceSetDigest: string;
} {
  assert(proposal.kind === 'cooperative', 'nonce ceremony requires a cooperative proposal');
  const round = roundFor(graph, proposal);
  assert(Array.isArray(nonces) && nonces.length === proposal.participantIds.length, 'cooperation requires every current participant public nonce');
  nonces.forEach(item => {
    checkContribution(proposal, item, ['pubnonce']);
    nonceAgg([hexBytes(item.pubnonce, 66, 'cooperative public nonce')]);
  });
  assert(new Set(nonces.map(item => item.participantId)).size === nonces.length &&
    new Set(nonces.map(item => item.pubnonce)).size === nonces.length, 'duplicate cooperative nonce or participant');
  const ordered = round.personalPublicKeys.map(key => {
    const id = graph.roster.participants.find(item => item.personalPublicKeyHex === key)!.id;
    const contribution = nonces.find(item => item.participantId === id);
    assert(contribution, 'nonce set omits a current participant');
    return { ...contribution };
  });
  const pubnonceBytes = ordered.map(item => Buffer.from(item.pubnonce, 'hex'));
  const session: SessionContext = { aggnonce: nonceAgg(pubnonceBytes), pubkeys: round.personalPublicKeys,
    tweaks: [cooperativeContext(round).tweak], isXonly: [true], message: Buffer.from(proposal.signatureHash, 'hex') };
  return { session, publicNonces: ordered, pubnonceBytes,
    nonceSetDigest: commitmentDigest('vault/presigned-graph-v2/cooperative-nonce-set', ordered) };
}

function verifyPartial(graph: PresignedGraph, proposal: PresignedSpendProposal,
  context: ReturnType<typeof nonceSession>, contribution: PresignedCooperativePartial): PresignedCooperativePartial {
  checkContribution(proposal, contribution, ['nonceSetDigest', 'partialSignatureHex']);
  assert(contribution.nonceSetDigest === context.nonceSetDigest, 'partial signature belongs to another nonce set');
  const index = context.session.pubkeys.indexOf(personalPublicKey(graph, contribution.participantId));
  assert(index >= 0 && partialSigVerify(hexBytes(contribution.partialSignatureHex, 32, 'cooperative partial signature'),
    context.pubnonceBytes, context.session, index), 'invalid cooperative partial signature');
  return { ...contribution };
}

function verifyRecovery(graph: PresignedGraph, proposal: PresignedSpendProposal,
  contribution: PresignedRecoveryContribution): PresignedRecoveryContribution {
  assert(proposal.kind === 'recovery', 'not a recovery proposal');
  checkContribution(proposal, contribution, ['signatureHex']);
  const key = Buffer.from(personalPublicKey(graph, contribution.participantId), 'hex').subarray(1);
  assert(ecc.verifySchnorr(Buffer.from(proposal.signatureHash, 'hex'), key,
    hexBytes(contribution.signatureHex, 64, 'recovery signature')), 'invalid recovery signature');
  return { ...contribution };
}
