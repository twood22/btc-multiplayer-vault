import { sha256Hex } from './crypto.js';
import { AMOUNTS, NETWORK, PARTICIPANTS, RECOVERY_DELAY_BLOCKS, SOLO_FEE_BUDGET_SATS } from './config.js';
import { auditSpecState } from './audit.js';
import { validateRoster } from './custody.js';
import { createRosterState, roundId, type RosterEntry } from './vault.js';
import type { PolicyCondition, TapLeaf, VaultKeyPath } from './types.js';

export interface PublishedRosterArtifact {
  version: 1;
  network: 'mainnet';
  vaultId: string;
  participants: RosterEntry[];
  economics: {
    depositSatsPerParticipant: number;
    firstWithdrawalSats: number;
    secondWithdrawalSats: number;
    soloFeeBudgetSats: number;
    recoveryDelayBlocks: number;
  };
  vaults: Array<{
    round: string;
    participantIds: string[];
    address: string;
    outputScriptHex: string;
    tapMerkleRoot: string;
    descriptor: string;
    keyPath: VaultKeyPath;
    tapscriptLeaves: TapLeaf[];
  }>;
  policies: Array<{
    id: string;
    leaverId: string;
    roundIds: string[];
    network: 'mainnet';
    logic: 'AND';
    keyId: string;
    conditions: PolicyCondition[];
  }>;
  funding: {
    round: string;
    address: string;
    outputScriptHex: string;
    valueSats: number;
  };
}

export interface RosterReview {
  digest: string;
  network: 'mainnet';
  economics: PublishedRosterArtifact['economics'];
  participants: Array<{
    id: string;
    label: string;
    personalPublicKeyHex: string;
    payoutAddress: string;
    sigbashRounds: Array<{
      round: string;
      keyId: string;
      policyId: string;
      policyRoot: string;
      registrationCommitment: string;
    }>;
  }>;
  vaults: Array<{
    round: string;
    participantIds: string[];
    address: string | null;
    outputScriptHex: string | null;
    vaultCommitment: string;
  }>;
  policies: Array<{ id: string; keyId: string; policyCommitment: string }>;
  fundingAddressCommitment: string;
  fundingAddress: string | null;
  confirmations: string[];
  unanimous: boolean;
}

/**
 * Build the only roster shape the user-facing ceremony may publish. Unlike the
 * older offline RosterEntry fixture, this requires a validated service-created
 * mainnet Sigbash registration for every (participant, leave-round) pair.
 */
export function createPublishedRosterArtifact(
  vaultId: string,
  candidate: unknown,
): PublishedRosterArtifact {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(vaultId)) {
    throw new Error('vaultId must be a UUID string');
  }
  const roster = validateRoster(candidate)
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(canonicalRosterEntry);
  for (const entry of roster) {
    if (!entry.sigbashRegistrationByRound) {
      throw new Error(`publishable roster is missing live Sigbash registrations for ${entry.id}`);
    }
  }
  const state = createRosterState(roster);
  const audit = auditSpecState(state);
  if (!audit.passed) {
    throw new Error(`publishable roster failed vault audit: ${audit.checks.filter((item) => !item.ok).map((item) => item.name).join(', ')}`);
  }
  for (const participant of state.participants) {
    for (const [round, key] of Object.entries(participant.sigbashByRound)) {
      if (!key.isLiveKey || !key.xpub) {
        throw new Error(`publishable roster contains an offline Sigbash leaf for ${participant.id}:${round}`);
      }
    }
  }
  const vaults = [...state.vaults.values()]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((vault) => ({
      round: vault.id,
      participantIds: [...vault.participantIds].sort(),
      address: vault.address,
      outputScriptHex: vault.outputScriptHex,
      tapMerkleRoot: vault.tapMerkleRoot,
      descriptor: vault.descriptor,
      keyPath: vault.keyPath,
      tapscriptLeaves: vault.tapscriptLeaves,
    }));
  const policies = [...state.policies.values()]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((policy) => {
      if (!policy.keyId) throw new Error(`publishable roster policy ${policy.id} has no live Sigbash keyId`);
      return {
        id: policy.id,
        leaverId: policy.leaverId,
        roundIds: [...policy.roundIds].sort(),
        network: policy.network,
        logic: policy.logic,
        keyId: policy.keyId,
        conditions: policy.conditions,
      };
    });
  const fundingRound = roundId(PARTICIPANTS.map((participant) => participant.id));
  const fundingVault = vaults.find((vault) => vault.round === fundingRound);
  if (!fundingVault) throw new Error('publishable roster is missing the round-one funding vault');
  return {
    version: 1,
    network: NETWORK,
    vaultId: vaultId.toLowerCase(),
    participants: roster,
    economics: {
      depositSatsPerParticipant: AMOUNTS.deposit,
      firstWithdrawalSats: AMOUNTS.firstWithdrawal,
      secondWithdrawalSats: AMOUNTS.secondWithdrawal,
      soloFeeBudgetSats: SOLO_FEE_BUDGET_SATS,
      recoveryDelayBlocks: RECOVERY_DELAY_BLOCKS,
    },
    vaults,
    policies,
    funding: {
      round: fundingRound,
      address: fundingVault.address,
      outputScriptHex: fundingVault.outputScriptHex,
      valueSats: AMOUNTS.deposit * PARTICIPANTS.length,
    },
  };
}

export function canonicalRosterJson(artifact: PublishedRosterArtifact): string {
  return JSON.stringify(sortObjectKeys(artifact));
}

export function publishedRosterDigest(artifact: PublishedRosterArtifact): string {
  return sha256Hex(canonicalRosterJson(artifact));
}

/** Return a review projection that withholds the round-one address until all three seats confirm. */
export function rosterReview(
  artifact: PublishedRosterArtifact,
  confirmedParticipantIds: string[],
): RosterReview {
  const confirmations = [...new Set(confirmedParticipantIds)].sort();
  const expected = artifact.participants.map((participant) => participant.id).sort();
  const unanimous = confirmations.join(',') === expected.join(',');
  const digest = publishedRosterDigest(artifact);
  return {
    digest,
    network: artifact.network,
    economics: artifact.economics,
    participants: artifact.participants.map((participant) => ({
      id: participant.id,
      label: participant.label,
      personalPublicKeyHex: participant.personalPublicKeyHex,
      payoutAddress: participant.payoutAddress,
      sigbashRounds: Object.entries(participant.sigbashRegistrationByRound || {})
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([round, registration]) => ({
          round,
          keyId: registration.keyId,
          policyId: registration.policyId,
          policyRoot: registration.policyRoot,
          registrationCommitment: sha256Hex(JSON.stringify(sortObjectKeys(registration))),
        })),
    })),
    vaults: artifact.vaults.map((vault) => ({
      round: vault.round,
      participantIds: vault.participantIds,
      address: vault.round === artifact.funding.round && !unanimous ? null : vault.address,
      outputScriptHex: vault.round === artifact.funding.round && !unanimous ? null : vault.outputScriptHex,
      vaultCommitment: sha256Hex(JSON.stringify(sortObjectKeys(vault))),
    })),
    policies: artifact.policies.map((policy) => ({
      id: policy.id,
      keyId: policy.keyId,
      policyCommitment: sha256Hex(JSON.stringify(sortObjectKeys(policy))),
    })),
    fundingAddressCommitment: sha256Hex(`btc-multiplayer-vault:funding-address:${artifact.funding.address}`),
    fundingAddress: unanimous ? artifact.funding.address : null,
    confirmations,
    unanimous,
  };
}

function canonicalRosterEntry(entry: RosterEntry): RosterEntry {
  return {
    ...entry,
    sigbashLeafByRound: sortStringRecord(entry.sigbashLeafByRound),
    sigbashIdentificationLeafByRound: sortStringRecord(entry.sigbashIdentificationLeafByRound),
    ...(entry.sigbashRegistrationByRound
      ? { sigbashRegistrationByRound: Object.fromEntries(
          Object.entries(entry.sigbashRegistrationByRound).sort(([left], [right]) => left.localeCompare(right)),
        ) }
      : {}),
  };
}

function sortStringRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
}

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortObjectKeys(item)]),
    );
  }
  return value;
}
