import type { BitcoinNetworkName } from '../types.js';
import type { PresignedEconomics } from './economics.js';

export const PRESIGNED_PROTOCOL = 'presigned-graph-v2' as const;
export const PRESIGNED_PROTOCOL_V3 = 'presigned-graph-v3' as const;
export const FIXED_RECOVERY_POLICY = 'fixed-equal-quorum-v1' as const;
export type PresignedProtocol = typeof PRESIGNED_PROTOCOL | typeof PRESIGNED_PROTOCOL_V3;
export type PresignedVersion = 2 | 3;
export function isPresignedProtocol(value: unknown): value is PresignedProtocol {
  return value === PRESIGNED_PROTOCOL || value === PRESIGNED_PROTOCOL_V3;
}
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
  recoveryAuthorizationPublicKeys?: Partial<Record<RoundId, string>>;
  recoveryTriggerPublicKeys?: Partial<Record<RoundId, string>>;
}

export interface PresignedRoster {
  version: PresignedVersion;
  protocol: PresignedProtocol;
  recoveryPolicy?: typeof FIXED_RECOVERY_POLICY;
  vaultId: string;
  network: BitcoinNetworkName;
  genesisHash: string;
  economics: PresignedEconomics;
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
  /** V3 recovery only: a mandatory, independent N-of-N setup-signature layer. */
  authorizationParticipantIds?: ParticipantId[];
  authorizationPublicKeys?: string[];
  authorizationThreshold?: number;
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
  version: PresignedVersion;
  protocol: PresignedProtocol;
  roster: PresignedRoster;
  rosterDigest: string;
  funding: PresignedFundingTemplate;
  fundingUnsignedTxHex: string;
  fundingPsbtBase64: string;
  fundingTxid: string;
  rounds: PresignedRound[];
  exits: PresignedExit[];
  /** Present only in V3; one terminal fixed refund per graph round. */
  recoveries?: PresignedRecovery[];
  digest: string;
}

export interface Preauthorization {
  version: PresignedVersion;
  protocol: PresignedProtocol;
  graphDigest: string;
  participantId: ParticipantId;
  exitId: string;
  /** Exactly 64 bytes, SIGHASH_DEFAULT; no explicit sighash byte. */
  signatureHex: string;
}

/** Entire public capability bundle; still no designated leaver signatures. */
export interface PresignedPublicKit {
  version: PresignedVersion;
  protocol: PresignedProtocol;
  graph: PresignedGraph;
  preauthorizations: Preauthorization[];
  recoveryAuthorizations?: RecoveryAuthorization[];
}

export interface PresignedRecovery {
  id: string;
  roundId: RoundId;
  parentExitId: string | null;
  recipientIds: ParticipantId[];
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

/** Setup-only authorization; never a runtime trigger or a solo capability. */
export interface RecoveryAuthorization {
  version: 3;
  protocol: typeof PRESIGNED_PROTOCOL_V3;
  purpose: 'fixed-recovery-authorization';
  graphDigest: string;
  participantId: ParticipantId;
  recoveryId: string;
  signatureHex: string;
}

/** Client-only. Never accepted by a coordinator route or a log formatter. */
export interface PresignedParticipantKeys {
  participantId: ParticipantId;
  personalPrivateKey: Uint8Array;
  payoutPrivateKey: Uint8Array;
  soloPrivateKeys: Partial<Record<RoundId, Uint8Array>>;
  recoveryAuthorizationPrivateKeys?: Partial<Record<RoundId, Uint8Array>>;
  recoveryTriggerPrivateKeys?: Partial<Record<RoundId, Uint8Array>>;
}
