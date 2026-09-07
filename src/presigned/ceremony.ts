import { validateVaultEconomics } from '../config.js';
import type { BitcoinNetworkName, VaultEconomics } from '../types.js';
import { presignedBackupBinding, type PresignedRestorationProof } from './backup.js';
import { buildPresignedGraph, fundingFeeShare } from './graph.js';
import { finalizePresignedFunding, verifyPresignedFundingSignature, type PresignedFundingSignature } from './funding.js';
import { buildPresignedRounds, validatePresignedRoster } from './roster.js';
import { verifyPreauthorizations } from './signing.js';
import { PARTICIPANT_IDS, PRESIGNED_PROTOCOL, type ParticipantId, type Preauthorization,
  type PresignedFundingInput, type PresignedGraph, type PresignedParticipant, type PresignedRoster } from './types.js';
import { assert, canonicalJson, commitmentDigest, exactKeys, genesisHash, hexBytes, identifier,
  memberRounds, participantId, publicKey, safeInteger, sameCanonical, supportedWalletScript } from './validation.js';

const DOMAIN = 'vault/presigned-graph-v2/ceremony';
const BACKUP_DOMAIN = 'btc-multiplayer-vault/presigned-offline-recovery/v1';
export interface PresignedCeremonySettings {
  network: BitcoinNetworkName;
  genesisHash: string;
  economics: VaultEconomics;
  feePolicy: PresignedRoster['feePolicy'];
  fundingFeeSats: number;
}
type ActionBase = { version: 2; protocol: typeof PRESIGNED_PROTOCOL };
export type PresignedAction = ActionBase & (
  { kind: 'register-identity'; settingsDigest: string; identity: PresignedParticipant } |
  { kind: 'confirm-roster'; rosterDigest: string } |
  { kind: 'commit-funding-input'; epochId: string; rosterDigest: string; input: PresignedFundingInput } |
  { kind: 'contribute-preauthorizations'; epochId: string; graphDigest: string; preauthorizations: Preauthorization[] } |
  { kind: 'confirm-backup'; epochId: string; graphDigest: string; backupKind: 'offline' | 'passkey';
    restoreCredentialId: string | null; backupFileDigest: string | null; proof: PresignedRestorationProof } |
  { kind: 'begin-wallet-signing'; epochId: string; graphDigest: string } |
  { kind: 'submit-funding-signature'; epochId: string; graphDigest: string; signature: PresignedFundingSignature } |
  { kind: 'approve-funding'; epochId: string; graphDigest: string; finalizationDigest: string } |
  { kind: 'restart-funding'; epochId: string; stateDigest: string; reason: string }
);

export interface PresignedBackupReceipt {
  participantId: ParticipantId;
  backupKind: 'offline' | 'passkey';
  restoreCredentialId: string | null;
  approvedCredentialId: string;
  backupFileDigest: string | null;
  proof: PresignedRestorationProof;
}
export interface PresignedFundingEpoch {
  epochId: string;
  status: 'collecting' | 'frozen' | 'signed' | 'approved' | 'retired';
  inputs: PresignedFundingInput[];
  graph: PresignedGraph | null;
  preauthorizations: Preauthorization[];
  backups: PresignedBackupReceipt[];
  /** Recorded before honest-client export/wallet invocation; signatures may exist even if upload is lost. */
  walletSigningStarted: ParticipantId[];
  signatures: PresignedFundingSignature[];
  finalization: ReturnType<typeof finalizePresignedFunding> | null;
  fundingApprovals: ParticipantId[];
  restartApprovals: Array<{ participantId: ParticipantId; stateDigest: string; reason: string }>;
}
export interface PresignedCeremonyState {
  version: 2;
  protocol: typeof PRESIGNED_PROTOCOL;
  vaultId: string;
  settings: PresignedCeremonySettings;
  settingsDigest: string;
  identities: PresignedParticipant[];
  roster: PresignedRoster | null;
  rosterDigest: string | null;
  rosterApprovals: ParticipantId[];
  epochs: PresignedFundingEpoch[];
}
export type PresignedEligibleCredentials = Record<ParticipantId, string[]>;

/** Only independently observed facts from the private chain adapter satisfy this boundary. */
export interface PresignedFundingObservation {
  network: BitcoinNetworkName;
  genesisHash: string;
  txid: string;
  vout: number;
  valueSats: number;
  scriptPubKeyHex: string;
  confirmationBlockHash: string;
  confirmations: number;
  unspent: true;
}
export type PresignedFundingInputVerifier = (input: {
  network: BitcoinNetworkName; genesisHash: string; input: PresignedFundingInput;
}) => Promise<PresignedFundingObservation>;

export function validatePresignedCeremonySettings(input: PresignedCeremonySettings): PresignedCeremonySettings {
  exactKeys(input, ['network', 'genesisHash', 'economics', 'feePolicy', 'fundingFeeSats'], 'ceremony settings');
  assert(input.genesisHash === genesisHash(input.network), 'wrong ceremony genesis');
  exactKeys(input.economics, ['depositSatsPerParticipant', 'firstWithdrawalSats', 'secondWithdrawalSats',
    'soloFeeBudgetSats', 'soloWithdrawalFeeSats', 'cooperativeFeeSats', 'recoveryFeeSats', 'finalSweepFeeSats', 'recoveryDelayBlocks'], 'ceremony economics');
  const economics = validateVaultEconomics(input.economics);
  const haircut = Math.round(economics.depositSatsPerParticipant * 0.05);
  assert(economics.firstWithdrawalSats === economics.depositSatsPerParticipant - haircut &&
    economics.secondWithdrawalSats === economics.depositSatsPerParticipant + Math.floor(haircut / 2), 'ceremony changed withdrawal proportions');
  safeInteger(economics.depositSatsPerParticipant, 10_000, 700_000_000_000_000, 'ceremony deposit');
  assert(economics.depositSatsPerParticipant * 3 - economics.firstWithdrawalSats - economics.secondWithdrawalSats -
    economics.soloWithdrawalFeeSats * 3 >= 330, 'ceremony would create a dust final payout');
  exactKeys(input.feePolicy, ['kind', 'maxChildFeeSats'], 'ceremony fee policy');
  assert(input.feePolicy.kind === 'confirmed-truc-payout-cpfp-v1', 'unsupported ceremony fee policy');
  safeInteger(input.feePolicy.maxChildFeeSats, 1, 100_000_000, 'fee child cap');
  safeInteger(input.fundingFeeSats, 1, Math.min(100_000_000, economics.depositSatsPerParticipant), 'funding fee');
  return { network: input.network, genesisHash: input.genesisHash, economics,
    feePolicy: { ...input.feePolicy }, fundingFeeSats: input.fundingFeeSats };
}

export function newPresignedCeremony(vaultId: string, candidate: PresignedCeremonySettings): PresignedCeremonyState {
  identifier(vaultId, 'ceremony vault');
  const settings = validatePresignedCeremonySettings(candidate);
  return { version: 2, protocol: PRESIGNED_PROTOCOL, vaultId, settings,
    settingsDigest: commitmentDigest(`${DOMAIN}/settings`, { vaultId, ...settings }),
    identities: [], roster: null, rosterDigest: null, rosterApprovals: [], epochs: [] };
}

export function presignedActionDigest(action: PresignedAction): string {
  return commitmentDigest(`${DOMAIN}/action`, validatePresignedAction(action));
}

/** Exact public schemas reject accidental private keys, seeds, PRF results and nonce fields. */
export function validatePresignedAction(candidate: unknown): PresignedAction {
  boundedPublicAction(candidate);
  assert(candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate), 'action must be an object');
  const action = candidate as PresignedAction;
  assert(action.version === 2 && action.protocol === PRESIGNED_PROTOCOL, 'wrong action protocol');
  const fields: Record<PresignedAction['kind'], string[]> = {
    'register-identity': ['settingsDigest', 'identity'], 'confirm-roster': ['rosterDigest'],
    'commit-funding-input': ['epochId', 'rosterDigest', 'input'],
    'contribute-preauthorizations': ['epochId', 'graphDigest', 'preauthorizations'],
    'confirm-backup': ['epochId', 'graphDigest', 'backupKind', 'restoreCredentialId', 'backupFileDigest', 'proof'],
    'begin-wallet-signing': ['epochId', 'graphDigest'],
    'submit-funding-signature': ['epochId', 'graphDigest', 'signature'],
    'approve-funding': ['epochId', 'graphDigest', 'finalizationDigest'],
    'restart-funding': ['epochId', 'stateDigest', 'reason'],
  };
  assert(Object.hasOwn(fields, action.kind), 'unknown ceremony action');
  exactKeys(action, ['version', 'protocol', 'kind', ...fields[action.kind]], 'ceremony action');
  for (const field of ['settingsDigest', 'rosterDigest', 'graphDigest', 'finalizationDigest', 'stateDigest'] as const) {
    if (field in action) hexBytes((action as unknown as Record<string, string>)[field]!, 32, field);
  }
  if ('epochId' in action) identifier(action.epochId, 'action epoch');
  if (action.kind === 'register-identity') validatePublicIdentity(action.identity);
  if (action.kind === 'commit-funding-input') validateFundingInput(action.input);
  if (action.kind === 'contribute-preauthorizations') {
    assert(Array.isArray(action.preauthorizations) && action.preauthorizations.length === 4, 'one participant must contribute all four preauthorizations');
    for (const entry of action.preauthorizations) {
      exactKeys(entry, ['version', 'protocol', 'graphDigest', 'participantId', 'exitId', 'signatureHex'], 'preauthorization');
      assert(entry.version === 2 && entry.protocol === PRESIGNED_PROTOCOL, 'wrong preauthorization protocol');
      participantId(entry.participantId); hexBytes(entry.graphDigest, 32, 'preauthorization graph');
      exitIdentifier(entry.exitId); hexBytes(entry.signatureHex, 64, 'preauthorization signature');
    }
  }
  if (action.kind === 'confirm-backup') {
    assert(action.backupKind === 'offline' || action.backupKind === 'passkey', 'unknown backup kind');
    if (action.backupKind === 'offline') {
      assert(action.restoreCredentialId === null, 'offline restore cannot claim a passkey');
      hexBytes(action.backupFileDigest!, 32, 'offline backup file digest');
    } else {
      credentialIdentifier(action.restoreCredentialId!);
      assert(action.backupFileDigest === null, 'passkey restore cannot claim an offline file');
    }
    validateRestoreProofShape(action.proof);
  }
  if (action.kind === 'submit-funding-signature') {
    const signature = action.signature;
    exactKeys(signature, ['version', 'protocol', 'graphDigest', 'participantId', 'inputIndex', 'witness'], 'funding signature');
    assert(signature.version === 2 && signature.protocol === PRESIGNED_PROTOCOL, 'wrong funding signature protocol');
    participantId(signature.participantId); hexBytes(signature.graphDigest, 32, 'funding signature graph');
    safeInteger(signature.inputIndex, 0, 2, 'funding signature input');
    assert(Array.isArray(signature.witness) && signature.witness.length >= 1 && signature.witness.length <= 2 &&
      signature.witness.every(item => typeof item === 'string' && /^(?:[0-9a-f]{2}){1,73}$/u.test(item)), 'invalid funding witness');
  }
  if (action.kind === 'restart-funding') {
    assert(typeof action.reason === 'string' && action.reason.length >= 10 && action.reason.length <= 500 &&
      action.reason === action.reason.trim().replace(/\s+/gu, ' '), 'restart reason must be canonical and 10-500 characters');
  }
  return JSON.parse(canonicalJson(action)) as PresignedAction;
}

export function currentPresignedEpoch(state: PresignedCeremonyState): PresignedFundingEpoch | null {
  return [...state.epochs].reverse().find(epoch => epoch.status !== 'retired') ?? null;
}

export function presignedWalletSigningReady(state: PresignedCeremonyState, eligible: PresignedEligibleCredentials): boolean {
  const epoch = currentPresignedEpoch(state);
  if (!epoch?.graph || state.rosterApprovals.length !== 3 || epoch.preauthorizations.length !== 12) return false;
  verifyPreauthorizations(epoch.graph, epoch.preauthorizations, true);
  return PARTICIPANT_IDS.every(id => {
    const available = new Set(eligible[id]);
    const receipts = epoch.backups.filter(receipt => receipt.participantId === id);
    const restored = new Set(receipts.filter(receipt => receipt.backupKind === 'passkey' &&
      receipt.restoreCredentialId !== null && available.has(receipt.restoreCredentialId)).map(receipt => receipt.restoreCredentialId));
    return available.size >= 2 && restored.size >= 2 && receipts.some(receipt => receipt.backupKind === 'offline');
  });
}

export function presignedRestartStateDigest(state: PresignedCeremonyState): string | null {
  const epoch = currentPresignedEpoch(state);
  if (!epoch || epoch.walletSigningStarted.length || epoch.signatures.length || epoch.finalization) return null;
  const { restartApprovals: _approvals, ...snapshot } = epoch;
  return commitmentDigest(`${DOMAIN}/restart-state`, { vaultId: state.vaultId, settingsDigest: state.settingsDigest,
    rosterDigest: state.rosterDigest, epoch: snapshot });
}

/** Pure preview/transition. The store invokes this under the same shared vault lock at both API stages. */
export function applyPresignedAction(input: {
  state: PresignedCeremonyState; action: PresignedAction; participantId: ParticipantId;
  credentialId: string; eligibleCredentials: PresignedEligibleCredentials; nextEpochId: string;
}): PresignedCeremonyState {
  const action = validatePresignedAction(input.action);
  const state = structuredClone(input.state);
  participantId(input.participantId); credentialIdentifier(input.credentialId);
  assert(input.eligibleCredentials[input.participantId].includes(input.credentialId), 'action passkey has no stored PRF envelope');
  assert(input.eligibleCredentials[input.participantId].length >= 2, 'participant needs two stored PRF envelopes');
  if (action.kind === 'register-identity') {
    assert(action.settingsDigest === state.settingsDigest, 'identity approval changed immutable settings');
    assert(action.identity.id === input.participantId, 'identity registration belongs to another participant');
    assert(!state.roster && !state.identities.some(identity => identity.id === input.participantId), 'participant identity is immutable once registered');
    const publicKeys = [...state.identities, action.identity].flatMap(identity => [identity.personalPublicKeyHex.slice(2),
      identity.payoutXonlyPublicKeyHex, ...Object.values(identity.soloPublicKeys)]);
    assert(new Set(publicKeys).size === publicKeys.length, 'identity keys must be unique across participants, roles and rounds');
    state.identities.push(validatePublicIdentity(action.identity));
    state.identities.sort((a, b) => a.id.localeCompare(b.id));
    if (state.identities.length === 3) {
      state.roster = validatePresignedRoster({ version: 2, protocol: PRESIGNED_PROTOCOL, vaultId: state.vaultId,
        network: state.settings.network, genesisHash: state.settings.genesisHash, economics: state.settings.economics,
        feePolicy: state.settings.feePolicy, participants: state.identities });
      state.rosterDigest = commitmentDigest('vault/presigned-graph-v2/roster', state.roster);
    }
    return state;
  }
  assert(state.roster && state.rosterDigest, 'all three public identities must be registered');
  if (action.kind === 'confirm-roster') {
    assert(action.rosterDigest === state.rosterDigest, 'roster approval changed immutable digest');
    assert(!state.rosterApprovals.includes(input.participantId), 'participant already confirmed the roster');
    state.rosterApprovals.push(input.participantId); state.rosterApprovals.sort();
    if (state.rosterApprovals.length === 3) state.epochs.push(newEpoch(input.nextEpochId));
    return state;
  }
  assert(state.rosterApprovals.length === 3, 'funding commitments require unanimous roster approval');
  const epoch = currentPresignedEpoch(state);
  assert(epoch && epoch.epochId === action.epochId, 'action belongs to an old or missing funding epoch');
  if (action.kind === 'restart-funding') {
    assert(!epoch.walletSigningStarted.length, 'wallet signing has started; explicit future recovery is required even if no signature was uploaded');
    assert(!epoch.signatures.length && !epoch.finalization, 'funding already has a wallet signature; explicit future recovery is required');
    assert(action.stateDigest === presignedRestartStateDigest(state), 'funding restart state changed');
    assert(!epoch.restartApprovals.some(approval => approval.participantId === input.participantId &&
      approval.stateDigest === action.stateDigest && approval.reason === action.reason), 'participant already approved this restart');
    // The append-only event ledger retains superseded votes; the active tally holds one per participant.
    epoch.restartApprovals = epoch.restartApprovals.filter(approval => approval.participantId !== input.participantId);
    epoch.restartApprovals.push({ participantId: input.participantId, stateDigest: action.stateDigest, reason: action.reason });
    const approved = new Set(epoch.restartApprovals.filter(approval => approval.stateDigest === action.stateDigest &&
      approval.reason === action.reason).map(approval => approval.participantId));
    if (approved.size === 3) {
      assert(state.epochs.length < 64, 'ceremony epoch limit reached; retained history requires explicit operator review');
      epoch.status = 'retired'; state.epochs.push(newEpoch(input.nextEpochId));
    }
    return state;
  }
  if (action.kind === 'commit-funding-input') {
    assert(action.rosterDigest === state.rosterDigest && action.input.participantId === input.participantId, 'funding input has wrong participant or roster');
    assert(epoch.status === 'collecting' && !epoch.graph, 'funding transaction is already frozen');
    assert(!epoch.inputs.some(coin => coin.participantId === input.participantId ||
      (coin.txid === action.input.txid && coin.vout === action.input.vout)), 'funding input or participant is already committed');
    // Reject an unusable first/second commitment immediately, not only when the third input freezes the graph.
    const change = action.input.valueSats - state.settings.economics.depositSatsPerParticipant -
      fundingFeeShare(state.settings.fundingFeeSats, PARTICIPANT_IDS.indexOf(input.participantId));
    assert(change >= 330, 'funding input must cover the deposit, fee share and non-dust wallet refund');
    assert(action.input.changeScriptPubKeyHex === action.input.scriptPubKeyHex,
      'funding refund must return to the exact input wallet script for independent fee rescue');
    const vaultScripts = buildPresignedRounds(state.roster).map(round => round.outputScriptHex);
    assert(!vaultScripts.includes(action.input.changeScriptPubKeyHex), 'funding change must not recreate a vault coin');
    epoch.inputs.push(validateFundingInput(action.input)); epoch.inputs.sort((a, b) => a.participantId.localeCompare(b.participantId));
    if (epoch.inputs.length === 3) {
      epoch.graph = buildPresignedGraph({ roster: state.roster,
        funding: { epochId: epoch.epochId, inputs: epoch.inputs, feeSats: state.settings.fundingFeeSats } });
      epoch.status = 'frozen';
    }
    return state;
  }
  assert(epoch.graph && action.graphDigest === epoch.graph.digest, 'action changed or omitted the frozen graph');
  if (action.kind === 'contribute-preauthorizations') {
    assert(!epoch.preauthorizations.some(entry => entry.participantId === input.participantId), 'participant preauthorizations are immutable');
    assert(action.preauthorizations.every(entry => entry.participantId === input.participantId), 'preauthorization belongs to another participant');
    const contribution = verifyPreauthorizations(epoch.graph, action.preauthorizations, false);
    epoch.preauthorizations = verifyPreauthorizations(epoch.graph, [...epoch.preauthorizations, ...contribution], false);
    return state;
  }
  if (action.kind === 'confirm-backup') {
    verifyPreauthorizations(epoch.graph, epoch.preauthorizations, true);
    if (action.backupKind === 'passkey') assert(action.restoreCredentialId === input.credentialId, 'restore must be approved by that exact restored credential');
    validatePresignedRestorationReceipt({ graph: epoch.graph, preauthorizations: epoch.preauthorizations,
      participantId: input.participantId, proof: action.proof });
    assert(!epoch.backups.some(receipt => receipt.participantId === input.participantId && receipt.backupKind === action.backupKind &&
      receipt.restoreCredentialId === action.restoreCredentialId), 'this backup restoration is already recorded');
    epoch.backups.push({ participantId: input.participantId, backupKind: action.backupKind,
      restoreCredentialId: action.restoreCredentialId, approvedCredentialId: input.credentialId,
      backupFileDigest: action.backupFileDigest, proof: action.proof });
    epoch.backups.sort((a, b) => `${a.participantId}:${a.backupKind}:${a.restoreCredentialId}`.localeCompare(`${b.participantId}:${b.backupKind}:${b.restoreCredentialId}`));
    return state;
  }
  assert(presignedWalletSigningReady(state, input.eligibleCredentials), 'wallet signing requires all preauthorizations, offline restores and two exact passkey restores per participant');
  if (action.kind === 'begin-wallet-signing') {
    assert(!epoch.walletSigningStarted.includes(input.participantId), 'participant already began wallet signing');
    epoch.walletSigningStarted.push(input.participantId); epoch.walletSigningStarted.sort();
    return state;
  }
  if (action.kind === 'submit-funding-signature') {
    assert(epoch.walletSigningStarted.includes(input.participantId), 'participant must approve begin-wallet-signing before exporting to or accepting a wallet signature');
    assert(action.signature.participantId === input.participantId, 'wallet signature belongs to another participant');
    assert(!epoch.signatures.some(signature => signature.participantId === input.participantId), 'wallet signature is immutable');
    epoch.signatures.push(verifyPresignedFundingSignature(epoch.graph, action.signature));
    epoch.signatures.sort((a, b) => a.participantId.localeCompare(b.participantId));
    epoch.status = 'signed';
    if (epoch.signatures.length === 3) epoch.finalization = finalizePresignedFunding({ graph: epoch.graph, signatures: epoch.signatures });
    return state;
  }
  assert(action.kind === 'approve-funding' && epoch.finalization, 'funding needs all three wallet signatures');
  assert(action.finalizationDigest === epoch.finalization.finalizationDigest, 'final funding approval changed exact transaction');
  assert(!epoch.fundingApprovals.includes(input.participantId), 'participant already approved final funding');
  epoch.fundingApprovals.push(input.participantId); epoch.fundingApprovals.sort();
  if (epoch.fundingApprovals.length === 3) epoch.status = 'approved';
  return state;
}

export function validatePresignedRestorationReceipt(input: {
  graph: PresignedGraph; preauthorizations: Preauthorization[]; participantId: ParticipantId; proof: PresignedRestorationProof;
}): PresignedRestorationProof {
  validateRestoreProofShape(input.proof);
  const preauthorizations = verifyPreauthorizations(input.graph, input.preauthorizations, true);
  const kit = { version: 2 as const, protocol: PRESIGNED_PROTOCOL, graph: input.graph, preauthorizations };
  sameCanonical(input.proof.binding, presignedBackupBinding(kit, input.participantId), 'restore receipt binding');
  const identity = input.graph.roster.participants.find(entry => entry.id === input.participantId)!;
  assert(input.proof.publicKitDigest === commitmentDigest(`${BACKUP_DOMAIN}/public-kit`, kit) &&
    input.proof.participantIdentityDigest === commitmentDigest(`${BACKUP_DOMAIN}/participant`, identity), 'restore receipt changed public kit or identity');
  const exits = input.graph.exits.filter(exit => exit.leaver === input.participantId).sort((a, b) => a.id.localeCompare(b.id));
  sameCanonical(input.proof.exitProofs.map(proof => ({ exitId: proof.exitId, txid: proof.txid })),
    exits.map(exit => ({ exitId: exit.id, txid: exit.txid })), 'restore receipt owner exits');
  const { proofDigest, ...body } = input.proof;
  assert(proofDigest === commitmentDigest(`${BACKUP_DOMAIN}/restoration-proof`, body), 'restore receipt digest changed');
  // The witness digests attest to a client-side check; they are not a proof of durable file storage.
  return structuredClone(input.proof);
}

export function assertPresignedFundingObservation(input: PresignedFundingInput, settings: PresignedCeremonySettings,
  observed: PresignedFundingObservation): void {
  exactKeys(observed, ['network', 'genesisHash', 'txid', 'vout', 'valueSats', 'scriptPubKeyHex', 'confirmationBlockHash', 'confirmations', 'unspent'], 'independent funding observation');
  assert(observed.network === settings.network && observed.genesisHash === settings.genesisHash && observed.unspent === true &&
    observed.txid === input.txid && observed.vout === input.vout && observed.valueSats === input.valueSats &&
    observed.scriptPubKeyHex === input.scriptPubKeyHex && observed.confirmationBlockHash === input.confirmationBlockHash,
  'private chain observation differs from funding commitment');
  safeInteger(observed.confirmations, input.confirmations, 2_000_000, 'independent funding confirmations');
}

function newEpoch(epochId: string): PresignedFundingEpoch {
  identifier(epochId, 'new funding epoch');
  return { epochId, status: 'collecting', inputs: [], graph: null, preauthorizations: [], backups: [], walletSigningStarted: [],
    signatures: [], finalization: null, fundingApprovals: [], restartApprovals: [] };
}
function validatePublicIdentity(input: PresignedParticipant): PresignedParticipant {
  exactKeys(input, ['id', 'personalPublicKeyHex', 'payoutXonlyPublicKeyHex', 'soloPublicKeys'], 'participant identity');
  participantId(input.id); publicKey(input.personalPublicKeyHex, true, 'participant personal key');
  publicKey(input.payoutXonlyPublicKeyHex, false, 'participant payout key');
  exactKeys(input.soloPublicKeys, memberRounds(input.id), 'participant round keys');
  Object.values(input.soloPublicKeys).forEach(key => publicKey(key, false, 'participant solo key'));
  return structuredClone(input);
}
function validateFundingInput(input: PresignedFundingInput): PresignedFundingInput {
  exactKeys(input, ['participantId', 'txid', 'vout', 'valueSats', 'scriptPubKeyHex', 'changeScriptPubKeyHex', 'confirmationBlockHash', 'confirmations'], 'funding input');
  participantId(input.participantId); hexBytes(input.txid, 32, 'funding outpoint');
  hexBytes(input.confirmationBlockHash, 32, 'funding block anchor');
  safeInteger(input.vout, 0, 0xffffffff, 'funding vout'); safeInteger(input.valueSats, 1, 700_000_000_000_000, 'funding value');
  safeInteger(input.confirmations, 1, 2_000_000, 'funding confirmations');
  assert(supportedWalletScript(input.scriptPubKeyHex), 'funding input must be native SegWit');
  assert(input.changeScriptPubKeyHex === null || supportedWalletScript(input.changeScriptPubKeyHex), 'funding change must be native SegWit');
  return { ...input };
}
function validateRestoreProofShape(proof: PresignedRestorationProof): void {
  exactKeys(proof, ['version', 'protocol', 'binding', 'publicKitDigest', 'participantIdentityDigest', 'exitProofs', 'proofDigest'], 'restore receipt');
  assert(proof.version === 2 && proof.protocol === PRESIGNED_PROTOCOL, 'wrong restore receipt protocol');
  exactKeys(proof.binding, ['protocol', 'network', 'genesisHash', 'vaultId', 'participantId', 'epochId', 'rosterDigest', 'graphDigest', 'fundingTxid'], 'restore receipt binding');
  assert(proof.binding.protocol === PRESIGNED_PROTOCOL && proof.binding.genesisHash === genesisHash(proof.binding.network), 'wrong restore receipt network or protocol');
  identifier(proof.binding.vaultId, 'restore vault'); identifier(proof.binding.epochId, 'restore epoch'); participantId(proof.binding.participantId);
  for (const value of [proof.publicKitDigest, proof.participantIdentityDigest, proof.proofDigest,
    proof.binding.rosterDigest, proof.binding.graphDigest, proof.binding.fundingTxid]) hexBytes(value, 32, 'restore receipt digest');
  assert(Array.isArray(proof.exitProofs) && proof.exitProofs.length === 3, 'restore must verify all three owner exits');
  for (const exit of proof.exitProofs) {
    exactKeys(exit, ['exitId', 'txid', 'transactionDigest'], 'restore exit proof');
    exitIdentifier(exit.exitId); hexBytes(exit.txid, 32, 'restore exit txid'); hexBytes(exit.transactionDigest, 32, 'restore exit witness digest');
  }
}
function exitIdentifier(value: string): void {
  assert(typeof value === 'string' && /^(alice|bob|carol)(\/(alice|bob|carol))?$/u.test(value), 'invalid exit identifier');
}
function credentialIdentifier(value: string): void {
  assert(typeof value === 'string' && /^[A-Za-z0-9_-]{1,2048}$/u.test(value), 'invalid credential identifier');
}
function boundedPublicAction(value: unknown): void {
  const queue = [{ value, depth: 0 }];
  let nodes = 0; let units = 0;
  while (queue.length) {
    const item = queue.pop()!;
    assert(++nodes <= 3000 && item.depth <= 16, 'action JSON too complex');
    if (typeof item.value === 'string') { units += item.value.length; assert(units <= 16_384, 'action payload too large'); }
    else if (item.value && typeof item.value === 'object') {
      assert(Array.isArray(item.value) || Object.getPrototypeOf(item.value) === Object.prototype, 'action contains a non-JSON object');
      const children = Object.values(item.value); assert(children.length <= 3000, 'action collection too large');
      children.forEach(child => queue.push({ value: child, depth: item.depth + 1 }));
    } else assert(item.value === null || typeof item.value === 'boolean' ||
      (typeof item.value === 'number' && Number.isSafeInteger(item.value)), 'action contains unsupported JSON');
  }
}
