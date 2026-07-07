// Domain model for the vault. Everything on-chain-adjacent is typed here so
// the compiler can verify the wiring between vault construction, policy
// building, PSBT signing, and the CLI.

/**
 * Branded satoshi amount. Construct via asSats() (which also validates the
 * value is a non-negative safe integer) so sats can't be confused with BTC
 * floats, fee rates, or block counts.
 */
export type Sats = number & { readonly __brand: 'sats' };

export function asSats(value: number | bigint | string): Sats {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw new Error(`not a valid satoshi amount: ${String(value)}`);
  }
  return numeric as Sats;
}

export type Hex = string;

export interface Keypair {
  privateKeyHex: Hex;
  publicKeyHex: Hex;
  xonlyPubKeyHex: Hex;
}

/**
 * The Sigbash leaf key a participant uses in one specific round. In local
 * mode this is a deterministic demo keypair; in live mode xonlyPubKeyHex is
 * overridden with the key derived from the Sigbash registration and the
 * local private key must not be used for signing.
 */
export interface SigbashRoundKey extends Keypair {
  isLiveKey: boolean;
  /**
   * The key's BIP-328 xpub (live mode only). Solo PSBTs embed a BIP-371
   * tapBip32Derivation from it so the Sigbash WASM wallet recognizes the
   * vault input as one it controls.
   */
  xpub?: string;
}

export interface Participant {
  id: string;
  label: string;
  personal: Keypair;
  payout: Keypair;
  payoutAddress: string;
  sigbashByRound: Record<string, SigbashRoundKey>;
}

export interface KeyAggregation {
  type: 'BIP327-KeyAgg';
  compressedPubkeys: Hex[];
  coefficients: Hex[];
  hasEvenY: boolean;
}

export interface KeyAggResult {
  publicKeyHex: Hex;
  xonlyPubKeyHex: Hex;
  aggregation: KeyAggregation;
}

export interface SoloTapLeaf {
  type: 'solo-withdrawal';
  participantId: string;
  sigbashXonlyPubkey: Hex;
  scriptHex: Hex;
  controlBlockHex: Hex;
}

export interface RecoveryTapLeaf {
  type: 'timelocked-recovery';
  relativeBlocks: number;
  threshold: number;
  recoveryXonlyPubkeys: Hex[];
  scriptHex: Hex;
  controlBlockHex: Hex;
}

export type TapLeaf = SoloTapLeaf | RecoveryTapLeaf;

export interface VaultKeyPath {
  type: 'MuSig2';
  personalXonlyPubkeys: Hex[];
  personalCompressedPubkeys: Hex[];
  /** Always empty — the audit suite asserts no Sigbash key is in the key path. */
  sigbashXonlyPubkeys: Hex[];
  aggregateXonlyPubkey: Hex;
  aggregateCompressedPubkey: Hex;
  aggregation: KeyAggregation;
}

export interface VaultRound {
  id: string;
  participantIds: string[];
  address: string;
  outputScriptHex: Hex;
  tapMerkleRoot: Hex;
  descriptor: string;
  keyPath: VaultKeyPath;
  tapscriptLeaves: TapLeaf[];
}

export type ComparisonOperator = 'EQ' | 'NEQ' | 'LT' | 'LTE' | 'GT' | 'GTE';

export interface IndexSelector {
  type: 'INDEX';
  index: number;
}

export type PolicyCondition =
  | {
      type: 'OUTPUT_VALUE';
      selector: IndexSelector;
      operator: ComparisonOperator;
      value: Sats;
    }
  | {
      type: 'OUTPUT_DEST_IS_IN_SETS';
      selector: IndexSelector;
      addresses: string[];
      network: string;
    }
  | { type: 'TX_OUTPUT_COUNT'; operator: ComparisonOperator; value: number }
  | { type: 'TX_INPUT_COUNT'; operator: ComparisonOperator; value: number }
  | {
      type: 'REQKEY';
      key_type: 'TAP_LEAF_XONLY_PUBKEY';
      use_descriptor: true;
      descriptor_template: string;
      /**
       * Local policy model only: the round-scoped leaf key the descriptor
       * resolves to (proven on live signet to satisfy the REQKEY clause).
       * Stripped before the policy is sent to Sigbash.
       */
      local_key_identifier: Hex;
      selector: { type: 'ALL' };
    };

export interface SoloPolicy {
  id: string;
  leaverId: string;
  roundIds: string[];
  network: string;
  logic: 'AND';
  conditions: PolicyCondition[];
  /** Attached by live-mode commands before contacting Sigbash. */
  keyId?: string;
}

/** A policy tree node as consumed by the local evaluator. */
export type PolicyNode =
  | PolicyCondition
  | { logic: 'AND' | 'OR'; conditions: PolicyNode[]; id?: string };

/**
 * The transaction shape the local policy evaluator checks — a normalized view
 * of either a ledger transaction or a PSBT inspection.
 */
export interface PolicyTx {
  sigbashLeafKey?: Hex | undefined;
  inputCount?: number;
  outputs: Array<{ address?: string | undefined; value: number }>;
}

export interface VaultState {
  participants: Participant[];
  vaults: Map<string, VaultRound>;
  policies: Map<string, SoloPolicy>;
}

export interface LedgerUtxo {
  outpoint: string;
  address: string;
  value: Sats;
  label: string;
  spent: boolean;
}

export interface LedgerOutput {
  address: string;
  value: Sats;
  label: string;
}

export interface LedgerTx {
  kind: string;
  input: string;
  inputCount: number;
  inputValue: Sats;
  outputs: LedgerOutput[];
  sigbashLeafKey?: Hex;
  txid?: string;
  fee?: Sats;
  [extra: string]: unknown;
}

export interface PsbtInspection {
  version: number;
  inputCount: number;
  outputCount: number;
  inputs: Array<{
    index: number;
    txid: string;
    vout: number;
    sequence: number;
    witnessUtxo?: { valueSats: number; scriptPubKeyHex: Hex } | undefined;
    tapInternalKey?: Hex | undefined;
    tapLeafScript?:
      | Array<{ leafVersion: number; scriptHex: Hex; controlBlockHex: Hex }>
      | undefined;
  }>;
  outputs: Array<{
    index: number;
    valueSats: number;
    scriptPubKeyHex: Hex;
    address: string;
  }>;
}

export interface Prevout {
  scriptPubKeyHex: Hex;
  valueSats: number;
}
