import { buildSoloWithdrawalTamperPsbts } from './psbt.js';
import {
  canonicalRosterJson,
  createPublishedRosterArtifact,
  publishedRosterDigest,
  type PublishedRosterArtifact,
} from './roster-ceremony.js';
import type { VaultCoinSnapshot } from './vault-runtime.js';
import { createRosterState } from './vault.js';

export interface SigbashReadinessFixture {
  participantId: string;
  round: string;
  currentIds: string[];
  coin: VaultCoinSnapshot;
  key: { keyId: string; keyIndex: number; policyId: string; policyRoot: string };
  validPsbtBase64: string;
  tamperedPsbts: Record<'wrongAmount' | 'wrongAddress' | 'extraOutput', string>;
}

/** Build the exact pre-funding live-signing challenge from immutable truth. */
export function buildSigbashReadinessFixture(input: {
  artifact: PublishedRosterArtifact;
  rosterDigest: string;
  participantId: string;
  round: string;
  inputTxid: string;
}): SigbashReadinessFixture {
  const rebuilt = createPublishedRosterArtifact(
    input.artifact.vaultId,
    input.artifact.participants,
    input.artifact.economics,
  );
  if (canonicalRosterJson(rebuilt) !== canonicalRosterJson(input.artifact) ||
      publishedRosterDigest(rebuilt) !== input.rosterDigest) {
    throw new Error('Sigbash readiness artifact does not match the confirmed roster digest');
  }
  if (!/^[0-9a-f]{64}$/u.test(input.inputTxid)) {
    throw new Error('Sigbash readiness input txid is invalid');
  }
  const participant = rebuilt.participants.find((item) => item.id === input.participantId);
  const registration = participant?.sigbashRegistrationByRound?.[input.round];
  const vault = rebuilt.vaults.find((item) => item.round === input.round);
  if (!participant || !registration || !vault || !vault.outputScriptHex ||
      !vault.participantIds.includes(input.participantId)) {
    throw new Error('confirmed roster is missing the challenged Sigbash key or vault round');
  }
  const valueSats = vault.participantIds.length === 3
    ? rebuilt.funding.valueSats
    : rebuilt.funding.valueSats - rebuilt.economics.firstWithdrawalSats -
      rebuilt.economics.soloWithdrawalFeeSats;
  const coin: VaultCoinSnapshot = {
    vaultId: rebuilt.vaultId,
    rosterDigest: input.rosterDigest,
    kind: 'vault',
    roundId: input.round,
    ownerParticipantId: null,
    txid: input.inputTxid,
    vout: 0,
    valueSats,
    scriptPubKeyHex: vault.outputScriptHex,
  };
  const state = createRosterState(rebuilt.participants, undefined, rebuilt.economics);
  const variants = buildSoloWithdrawalTamperPsbts({
    state,
    currentIds: vault.participantIds,
    leaverId: input.participantId,
    txid: coin.txid,
    vout: coin.vout,
    valueSats: coin.valueSats,
  });
  return {
    participantId: input.participantId,
    round: input.round,
    currentIds: vault.participantIds,
    coin,
    key: {
      keyId: registration.keyId,
      keyIndex: registration.keyIndex,
      policyId: registration.policyId,
      policyRoot: registration.policyRoot,
    },
    validPsbtBase64: variants.valid.psbtBase64,
    tamperedPsbts: {
      wrongAmount: variants.tampered.wrongAmount.psbtBase64,
      wrongAddress: variants.tampered.wrongAddress.psbtBase64,
      extraOutput: variants.tampered.extraOutput.psbtBase64,
    },
  };
}
