import 'server-only';
import { conditionConfigToPoetPolicy, type POETPolicy } from '@sigbash/sdk';
import { deterministicKeypair, taprootAddress } from '@/src/crypto';
import { planSigbashProvisioning } from '@/src/sigbash-provisioning';
import type { SoloPolicy } from '@/src/types';
import {
  participantLeaveRounds,
  type RosterEntry,
  type SigbashRosterRegistration,
} from '@/src/vault';
import { db } from './db';

export interface SigbashProvisioningStep {
  round: string;
  keyIndex: number;
  policyId: string;
  policy: SoloPolicy;
  conditionConfig: unknown;
  poetPolicy: POETPolicy;
}

export interface SigbashProvisioningManifest {
  network: 'mainnet';
  vaultId: string;
  participantId: string;
  roster: RosterEntry[];
  completedRounds: string[];
  totalPairRegistrations: number;
  next: SigbashProvisioningStep | null;
  waitingFor: string[];
}

export async function getSigbashProvisioningManifest(userId: string): Promise<SigbashProvisioningManifest> {
  const memberships = await db()<Array<{ vault_id: string; participant_id: string }>>`
    SELECT vault_id, participant_id FROM vault_members WHERE user_id = ${userId}::uuid
  `;
  if (memberships.length !== 1) throw new Error('Sigbash provisioning requires exactly one vault membership');
  const membership = memberships[0]!;
  const members = await db()<Array<{
    user_id: string;
    participant_id: string;
    personal_public_key: Buffer | null;
    payout_xonly_public_key: Buffer | null;
  }>>`
    SELECT m.user_id, m.participant_id, k.personal_public_key, k.payout_xonly_public_key
    FROM vault_members m
    LEFT JOIN participant_key_material k ON k.user_id = m.user_id
    WHERE m.vault_id = ${membership.vault_id}::uuid
    ORDER BY m.participant_id
  `;
  const expectedIds = ['alice', 'bob', 'carol'];
  const waitingFor: string[] = [];
  for (const id of expectedIds) {
    const member = members.find((item) => item.participant_id === id);
    if (!member) waitingFor.push(`${id} has not joined`);
    else if (!member.personal_public_key || !member.payout_xonly_public_key) {
      waitingFor.push(`${id} has not completed participant key setup`);
    }
  }
  if (waitingFor.length) {
    return {
      network: 'mainnet',
      vaultId: membership.vault_id,
      participantId: membership.participant_id,
      roster: [],
      completedRounds: [],
      totalPairRegistrations: 0,
      next: null,
      waitingFor,
    };
  }
  const registrations = await db()<Array<{
    user_id: string;
    participant_id: string;
    round_id: string;
    network: 'mainnet';
    key_id: string;
    key_index: number;
    bip328_xpub: string;
    policy_leaf_xonly: Buffer;
    identification_leaf_xonly: Buffer;
    policy_root: Buffer;
    policy_id: string;
  }>>`
    SELECT user_id, participant_id, round_id, network, key_id, key_index, bip328_xpub,
           policy_leaf_xonly, identification_leaf_xonly, policy_root, policy_id
    FROM participant_sigbash_keys
    WHERE vault_id = ${membership.vault_id}::uuid
    ORDER BY participant_id, round_id
  `;
  const roster = members.map((member) => rosterEntryForProvisioning(
    membership.vault_id,
    member as typeof member & { personal_public_key: Buffer; payout_xonly_public_key: Buffer },
    registrations.filter((registration) => registration.user_id === member.user_id),
    expectedIds,
  ));
  const plan = planSigbashProvisioning(roster, membership.participant_id);
  waitingFor.push(...plan.waitingFor);
  const next = plan.next ? {
    ...plan.next,
    poetPolicy: conditionConfigToPoetPolicy(plan.next.conditionConfig as never),
  } : null;
  return {
    network: 'mainnet',
    vaultId: membership.vault_id,
    participantId: membership.participant_id,
    roster,
    completedRounds: plan.completedRounds,
    totalPairRegistrations: plan.totalPairRegistrations,
    next,
    waitingFor,
  };
}

function rosterEntryForProvisioning(
  vaultId: string,
  member: {
    participant_id: string;
    personal_public_key: Buffer;
    payout_xonly_public_key: Buffer;
  },
  registrations: Array<{
    round_id: string;
    network: 'mainnet';
    key_id: string;
    key_index: number;
    bip328_xpub: string;
    policy_leaf_xonly: Buffer;
    identification_leaf_xonly: Buffer;
    policy_root: Buffer;
    policy_id: string;
  }>,
  allIds: string[],
): RosterEntry {
  const registrationByRound = Object.fromEntries(registrations.map((row) => [
    row.round_id,
    {
      network: row.network,
      keyId: row.key_id,
      keyIndex: row.key_index,
      bip328Xpub: row.bip328_xpub,
      policyLeafXonlyPubkey: row.policy_leaf_xonly.toString('hex'),
      identificationLeafXonlyPubkey: row.identification_leaf_xonly.toString('hex'),
      policyRoot: row.policy_root.toString('hex'),
      policyId: row.policy_id,
    } satisfies SigbashRosterRegistration,
  ]));
  const leaves = Object.fromEntries(participantLeaveRounds(member.participant_id, allIds).map((round) => {
    const registration = registrationByRound[round];
    const placeholder = deterministicKeypair(
      `public-provisioning-placeholder:${vaultId}`,
      `${member.participant_id}:${round}:policy`,
    );
    return [round, registration?.policyLeafXonlyPubkey ?? placeholder.xonlyPubKeyHex];
  }));
  const identificationLeaves = Object.fromEntries(participantLeaveRounds(member.participant_id, allIds).map((round) => {
    const registration = registrationByRound[round];
    const placeholder = deterministicKeypair(
      `public-provisioning-placeholder:${vaultId}`,
      `${member.participant_id}:${round}:identification`,
    );
    return [round, registration?.identificationLeafXonlyPubkey ?? placeholder.xonlyPubKeyHex];
  }));
  return {
    id: member.participant_id,
    label: member.participant_id[0]!.toUpperCase() + member.participant_id.slice(1),
    personalPublicKeyHex: member.personal_public_key.toString('hex'),
    payoutXonlyPubkeyHex: member.payout_xonly_public_key.toString('hex'),
    payoutAddress: taprootAddress(member.payout_xonly_public_key.toString('hex')),
    sigbashLeafByRound: leaves,
    sigbashIdentificationLeafByRound: identificationLeaves,
    sigbashRegistrationByRound: registrationByRound,
  };
}
