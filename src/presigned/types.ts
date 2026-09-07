import type { BitcoinNetworkName, VaultEconomics } from '../types.js';

export const PRESIGNED_PROTOCOL = 'presigned-graph-v2' as const;
export const LEGACY_PROTOCOL = 'sigbash-v1' as const;
export const PARTICIPANT_IDS = ['alice', 'bob', 'carol'] as const;
export type ParticipantId = typeof PARTICIPANT_IDS[number];
export type RoundId = 'alicebobcarol' | 'alicebob' | 'alicecarol' | 'bobcarol';

/** Public only. No v1 Sigbash fields are accepted in a v2 artifact. */
export interface PresignedParticipant {
  id: ParticipantId;
  personalPublicKeyHex: string;
  payoutXonlyPublicKeyHex: string;
  soloPublicKeys: Partial<Record<RoundId, string>>;
}

export interface PresignedRoster {
  version: 2;
  protocol: typeof PRESIGNED_PROTOCOL;
  vaultId: string;
  network: BitcoinNetworkName;
  genesisHash: string;
  economics: VaultEconomics;
  feePolicy: {
    kind: 'confirmed-truc-payout-cpfp-v1';
    maxChildFeeSats: number;
  };
  participants: PresignedParticipant[];
}

export interface PresignedLeaf {
  kind: 'preauthorized-solo' | 'timelocked-recovery';
  participantIds: ParticipantId[];
  publicKeys: string[];
  threshold: number;
  scriptHex: string;
  leafHash: string;
  controlBlockHex: string;
}

export interface PresignedRound {
  id: RoundId;
  participantIds: ParticipantId[];
  address: string;
  outputScriptHex: string;
  descriptor: string;
  internalKeyHex: string;
  personalPublicKeys: string[];
  tapMerkleRoot: string;
  solo: PresignedLeaf;
  recovery: PresignedLeaf;
}

/** Observations are rechecked by each client and the private chain backend. */
export interface PresignedFundingInput {
  participantId: ParticipantId;
  txid: string;
  vout: number;
  valueSats: number;
  scriptPubKeyHex: string;
  changeScriptPubKeyHex: string | null;
  /** Initial active-chain selection anchor. Reconfirmation never edits this audit record. */
  confirmationBlockHash: string;
  confirmations: number;
}

export interface PresignedFundingTemplate {
  /** Unique, monotonically retained ceremony identifier, never reused. */
  epochId: string;
  inputs: PresignedFundingInput[];
  feeSats: number;
}

export interface PresignedExit {
  id: string;
  roundId: RoundId;
  firstLeaver: ParticipantId;
  leaver: ParticipantId;
  finalParticipant: ParticipantId | null;
  parentExitId: string | null;
  inputTxid: string;
  inputVout: number;
  inputValueSats: number;
  inputScriptPubKeyHex: string;
  unsignedTxHex: string;
  txid: string;
  psbtBase64: string;
  feeSats: number;
  signatureHash: string;
}

export interface PresignedGraph {
  version: 2;
  protocol: typeof PRESIGNED_PROTOCOL;
  roster: PresignedRoster;
  rosterDigest: string;
  funding: PresignedFundingTemplate;
  fundingUnsignedTxHex: string;
  fundingPsbtBase64: string;
  fundingTxid: string;
  rounds: PresignedRound[];
  exits: PresignedExit[];
  digest: string;
}

export interface Preauthorization {
  version: 2;
  protocol: typeof PRESIGNED_PROTOCOL;
  graphDigest: string;
  participantId: ParticipantId;
  exitId: string;
  /** Exactly 64 bytes, SIGHASH_DEFAULT; no explicit sighash byte. */
  signatureHex: string;
}

/** Entire public capability bundle; still no designated leaver signatures. */
export interface PresignedPublicKit {
  version: 2;
  protocol: typeof PRESIGNED_PROTOCOL;
  graph: PresignedGraph;
  preauthorizations: Preauthorization[];
}

/** Client-only. Never accepted by a coordinator route or a log formatter. */
export interface PresignedParticipantKeys {
  participantId: ParticipantId;
  personalPrivateKey: Uint8Array;
  payoutPrivateKey: Uint8Array;
  soloPrivateKeys: Partial<Record<RoundId, Uint8Array>>;
}
