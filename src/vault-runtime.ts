import { Buffer } from 'buffer';
import * as bitcoin from 'bitcoinjs-lib';
import { vaultPolicyFloors } from './config.js';
import { sha256Hex } from './crypto.js';
import { BITCOIN_NETWORK } from './network.js';
import {
  buildCooperativeExitPsbt,
  buildFinalSweepPsbt,
  buildRecoveryPsbt,
  buildSoloWithdrawalPsbt,
  psbtUnsignedTxid,
} from './psbt.js';
import {
  canonicalRosterJson,
  createPublishedRosterArtifact,
  publishedRosterDigest,
  type PublishedRosterArtifact,
} from './roster-ceremony.js';
import { asTrustedVaultInput, type TrustedVaultInput, type VaultState } from './types.js';
import { createRosterState } from './vault.js';

export type VaultCoinKind = 'vault' | 'final_payout';
export type VaultProposalKind = 'solo' | 'cooperative' | 'recovery' | 'final_sweep';
export type VaultProposalStatus =
  | 'collecting'
  | 'finalized'
  | 'broadcast'
  | 'confirmed'
  | 'rejected'
  | 'stale';

export interface VaultCoinSnapshot extends TrustedVaultInput {
  vaultId: string;
  rosterDigest: string;
  kind: VaultCoinKind;
  roundId: string | null;
  ownerParticipantId: string | null;
}

export interface VaultProposalCommitment {
  version: 1;
  vaultId: string;
  rosterDigest: string;
  coinSnapshotDigest: string;
  kind: VaultProposalKind;
  roundId: string | null;
  actorParticipantId: string | null;
  psbtBase64: string;
  unsignedTxid: string;
  expiresAt: string;
}

export interface BuiltVaultProposal {
  commitment: VaultProposalCommitment;
  digest: string;
  requiredSignerIds: string[];
  psbtBase64: string;
  unsignedTxid: string;
}

export interface ValidatedVaultCoin {
  coin: VaultCoinSnapshot;
  state: VaultState;
  currentParticipantIds: string[];
}

/**
 * Validate coordinator state against the complete immutable roster. The server
 * record is still not a chain oracle: each signer separately compares these
 * exact fields to an independent mainnet source before producing a signature.
 */
export function validateVaultCoin(
  artifact: PublishedRosterArtifact,
  candidate: VaultCoinSnapshot,
): ValidatedVaultCoin {
  const rebuilt = createPublishedRosterArtifact(
    artifact.vaultId,
    artifact.participants,
    artifact.economics,
  );
  if (canonicalRosterJson(rebuilt) !== canonicalRosterJson(artifact)) {
    throw new Error('vault artifact does not reproduce from its immutable commitments');
  }
  const digest = publishedRosterDigest(rebuilt);
  if (candidate.vaultId !== rebuilt.vaultId || candidate.rosterDigest !== digest) {
    throw new Error('coin snapshot belongs to a different vault roster');
  }
  const trusted = asTrustedVaultInput(candidate);
  const state = createRosterState(rebuilt.participants, undefined, rebuilt.economics);
  const floors = vaultPolicyFloors(rebuilt.economics);
  const maximumPairValue = rebuilt.funding.valueSats - rebuilt.economics.firstWithdrawalSats;
  const maximumFinalValue = maximumPairValue - rebuilt.economics.secondWithdrawalSats;

  let currentParticipantIds: string[];
  if (candidate.kind === 'vault') {
    if (candidate.ownerParticipantId !== null || !candidate.roundId) {
      throw new Error('vault coin must name a round and cannot name a payout owner');
    }
    const vault = rebuilt.vaults.find((item) => item.round === candidate.roundId);
    if (!vault) throw new Error(`coin snapshot names unknown vault round ${candidate.roundId}`);
    if (trusted.scriptPubKeyHex !== vault.outputScriptHex) {
      throw new Error('coin script does not match the committed vault round');
    }
    currentParticipantIds = [...vault.participantIds];
    if (currentParticipantIds.length === 3 && trusted.valueSats !== rebuilt.funding.valueSats) {
      throw new Error('round-one vault coin value does not equal the committed funding value');
    }
    if (
      currentParticipantIds.length === 2 &&
      (trusted.valueSats < floors.roundOneLeftover || trusted.valueSats > maximumPairValue)
    ) {
      throw new Error('pair-round vault coin value is outside the committed solo-policy bounds');
    }
  } else {
    if (candidate.roundId !== null || !candidate.ownerParticipantId) {
      throw new Error('final payout coin must name its owner and cannot name a vault round');
    }
    const participant = state.participants.find((item) => item.id === candidate.ownerParticipantId);
    if (!participant) throw new Error(`coin snapshot names unknown payout owner ${candidate.ownerParticipantId}`);
    const expectedScript = Buffer.from(
      bitcoin.address.toOutputScript(participant.payoutAddress, BITCOIN_NETWORK),
    ).toString('hex');
    if (trusted.scriptPubKeyHex !== expectedScript) {
      throw new Error('coin script does not match the committed participant payout');
    }
    if (trusted.valueSats < floors.roundTwoLeftover || trusted.valueSats > maximumFinalValue) {
      throw new Error('final payout coin value is outside the committed solo-policy bounds');
    }
    currentParticipantIds = [participant.id];
  }

  return {
    coin: { ...candidate, ...trusted },
    state,
    currentParticipantIds,
  };
}

export function vaultCoinSnapshotDigest(coin: VaultCoinSnapshot): string {
  const normalized = {
    version: 1,
    vaultId: coin.vaultId,
    rosterDigest: coin.rosterDigest,
    kind: coin.kind,
    roundId: coin.roundId,
    ownerParticipantId: coin.ownerParticipantId,
    txid: coin.txid.toLowerCase(),
    vout: coin.vout,
    valueSats: coin.valueSats,
    scriptPubKeyHex: coin.scriptPubKeyHex.toLowerCase(),
  };
  return sha256Hex(JSON.stringify(normalized));
}

export function buildVaultProposal(input: {
  artifact: PublishedRosterArtifact;
  coin: VaultCoinSnapshot;
  kind: VaultProposalKind;
  actorParticipantId?: string;
  expiresAt: string;
}): BuiltVaultProposal {
  const validated = validateVaultCoin(input.artifact, input.coin);
  const actor = input.actorParticipantId ?? null;
  const expiry = new Date(input.expiresAt);
  if (!Number.isFinite(expiry.getTime())) throw new Error('proposal expiry is invalid');

  const shared = {
    state: validated.state,
    txid: validated.coin.txid,
    vout: validated.coin.vout,
    valueSats: validated.coin.valueSats,
  };
  let psbtBase64: string;
  let requiredSignerIds: string[];
  if (input.kind === 'solo') {
    assertVaultRound(validated);
    if (!actor || !validated.currentParticipantIds.includes(actor)) {
      throw new Error('solo proposal actor must be a participant in the current vault round');
    }
    psbtBase64 = buildSoloWithdrawalPsbt({
      ...shared,
      currentIds: validated.currentParticipantIds,
      leaverId: actor,
    }).psbtBase64;
    requiredSignerIds = [actor];
  } else if (input.kind === 'cooperative') {
    assertVaultRound(validated);
    if (actor !== null) throw new Error('cooperative proposal cannot name a unilateral actor');
    psbtBase64 = buildCooperativeExitPsbt({
      ...shared,
      currentIds: validated.currentParticipantIds,
    }).psbtBase64;
    requiredSignerIds = [...validated.currentParticipantIds];
  } else if (input.kind === 'recovery') {
    assertVaultRound(validated);
    if (!actor || !validated.currentParticipantIds.includes(actor)) {
      throw new Error('recovery proposal must name the vanished participant in the current round');
    }
    psbtBase64 = buildRecoveryPsbt({
      ...shared,
      currentIds: validated.currentParticipantIds,
      vanishedId: actor,
    }).psbtBase64;
    requiredSignerIds = validated.currentParticipantIds.filter((id) => id !== actor);
  } else {
    if (validated.coin.kind !== 'final_payout' || actor !== validated.coin.ownerParticipantId) {
      throw new Error('final sweep actor must own the current final payout coin');
    }
    if (!actor) throw new Error('final sweep actor is missing');
    psbtBase64 = buildFinalSweepPsbt({
      ...shared,
      participantId: actor,
    }).psbtBase64;
    requiredSignerIds = [actor];
  }

  const unsignedTxid = psbtUnsignedTxid(psbtBase64);
  const commitment: VaultProposalCommitment = {
    version: 1,
    vaultId: validated.coin.vaultId,
    rosterDigest: validated.coin.rosterDigest,
    coinSnapshotDigest: vaultCoinSnapshotDigest(validated.coin),
    kind: input.kind,
    roundId: validated.coin.roundId,
    actorParticipantId: actor,
    psbtBase64,
    unsignedTxid,
    expiresAt: expiry.toISOString(),
  };
  return {
    commitment,
    digest: vaultProposalDigest(commitment),
    requiredSignerIds,
    psbtBase64,
    unsignedTxid,
  };
}

export function vaultProposalDigest(commitment: VaultProposalCommitment): string {
  return sha256Hex(JSON.stringify(commitment));
}

export function assertProposalStatusTransition(
  current: VaultProposalStatus,
  next: VaultProposalStatus,
): void {
  const allowed: Record<VaultProposalStatus, VaultProposalStatus[]> = {
    collecting: ['finalized', 'rejected', 'stale'],
    finalized: ['broadcast', 'rejected', 'stale'],
    broadcast: ['confirmed', 'stale'],
    confirmed: [],
    rejected: [],
    stale: [],
  };
  if (!allowed[current].includes(next)) {
    throw new Error(`invalid proposal status transition ${current} -> ${next}`);
  }
}

function assertVaultRound(validated: ValidatedVaultCoin): void {
  if (validated.coin.kind !== 'vault' || !validated.coin.roundId) {
    throw new Error('proposal requires a current vault-round coin');
  }
}
