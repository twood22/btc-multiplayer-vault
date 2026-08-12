import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { AMOUNTS, PARTICIPANTS, RECOVERY_DELAY_BLOCKS } from './config.js';
import { verifyVaultTransaction, type ConsensusVerification } from './consensus.js';
import { taggedHash, tapLeafHash, taprootAddress } from './crypto.js';
import {
  buildFinalSweepPsbt,
  buildRecoveryPsbt,
  unsignedTx,
  witnessStackToScriptWitness,
} from './psbt.js';
import {
  createRosterState,
  deriveParticipantKeys,
  participantById,
  participantLeaveRounds,
  roundId,
  type RosterEntry,
} from './vault.js';
import type {
  Hex,
  Keypair,
  Prevout,
  RecoveryTapLeaf,
  TrustedVaultInput,
  VaultRound,
  VaultState,
} from './types.js';

bitcoin.initEccLib(ecc);

// ── The custody boundary ───────────────────────────────────────────────────
// Everything in this file exists to keep two properties true on a production
// signing device:
//
//   1. Exactly one participant's private keys are present. They come from one
//      secret held only on that device, read only from the environment, and
//      they must reproduce that participant's published identity and payout
//      keys. Sigbash leaf keys are public-only for everyone because Sigbash,
//      not the participant secret, controls those signing shares. Every other
//      participant is public-key material only — structurally unable to sign.
//   2. Nothing is signed until the transaction has been re-derived locally
//      from public roster data plus an independently trusted outpoint, and the
//      artifact handed to us matches that re-derivation byte for byte.
//
// The demo helpers that reconstruct every key from one seed (createDemoState,
// signCooperativeExitPsbt, signRecoveryPsbt, keyAggSecret) are deliberately
// not reachable from any command that loads a real secret.

const SECRET_ENV = 'VAULT_PARTICIPANT_SECRET';
const MIN_SECRET_LENGTH = 32;

export interface LocalSigner {
  /** Resolved from the secret itself, never from a command-line argument. */
  participantId: string;
  roster: RosterEntry[];
  state: VaultState;
  /** Custody proof lines. Public material only — never secrets or keys. */
  custodyChecks: string[];
}

export interface PublicRoster {
  roster: RosterEntry[];
  state: VaultState;
  custodyChecks: string[];
}

// ── Roster validation ──────────────────────────────────────────────────────

export function parseRoster(rosterJson: string): RosterEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rosterJson);
  } catch (error) {
    throw new Error(`--roster is not valid JSON: ${(error as Error).message}`);
  }
  return validateRoster(parsed);
}

/**
 * Strict public-roster validation. A roster is the only input a signing device
 * accepts about the other participants, so every field is checked rather than
 * trusted: known ids and labels, well-formed on-curve keys, payout addresses
 * that actually correspond to their published payout key, exactly the rounds
 * this participant could leave in, and no key or address reused anywhere in
 * the roster (which would collapse two participants' authority into one).
 */
export function validateRoster(candidate: unknown): RosterEntry[] {
  if (!Array.isArray(candidate)) {
    throw new Error('roster must be a JSON array of public roster entries');
  }
  const expectedIds = PARTICIPANTS.map((participant) => participant.id);
  if (candidate.length !== expectedIds.length) {
    throw new Error(
      `roster must contain exactly ${expectedIds.length} entries (${expectedIds.join(', ')}), got ${candidate.length}`,
    );
  }

  const claimedBy = new Map<string, string>();
  const claim = (material: string, label: string): void => {
    const previous = claimedBy.get(material);
    if (previous) {
      throw new Error(`roster reuses public material: ${label} is already ${previous}`);
    }
    claimedBy.set(material, label);
  };

  const entries = candidate.map((raw): RosterEntry => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('every roster entry must be a JSON object');
    }
    const entry = raw as Partial<RosterEntry>;
    const id = typeof entry.id === 'string' ? entry.id : '';
    const config = PARTICIPANTS.find((participant) => participant.id === id);
    if (!config) {
      throw new Error(
        `roster contains unknown participant id ${JSON.stringify(entry.id)}; expected one of ${expectedIds.join(', ')}`,
      );
    }
    if (entry.label !== config.label) {
      throw new Error(
        `roster entry for ${id} has label ${JSON.stringify(entry.label)}, expected ${JSON.stringify(config.label)}`,
      );
    }
    const personalPublicKeyHex = requireCompressedPubkey(
      entry.personalPublicKeyHex,
      `${id} personalPublicKeyHex`,
    );
    const payoutXonlyPubkeyHex = requireXonlyPubkey(
      entry.payoutXonlyPubkeyHex,
      `${id} payoutXonlyPubkeyHex`,
    );
    if (typeof entry.payoutAddress !== 'string' || !entry.payoutAddress) {
      throw new Error(`roster entry for ${id} is missing payoutAddress`);
    }
    if (entry.payoutAddress !== taprootAddress(payoutXonlyPubkeyHex)) {
      throw new Error(
        `roster entry for ${id}: payoutAddress is not the P2TR address of payoutXonlyPubkeyHex`,
      );
    }
    const expectedRounds = participantLeaveRounds(id, expectedIds).sort();
    const sigbashLeafByRound = requireRoundKeyMap(
      entry.sigbashLeafByRound,
      expectedRounds,
      `${id} sigbashLeafByRound`,
    );
    const sigbashIdentificationLeafByRound = requireRoundKeyMap(
      entry.sigbashIdentificationLeafByRound,
      expectedRounds,
      `${id} sigbashIdentificationLeafByRound`,
    );

    claim(personalPublicKeyHex, `${id}'s personal public key`);
    claim(personalPublicKeyHex.slice(2), `${id}'s personal public key (x-only)`);
    claim(payoutXonlyPubkeyHex, `${id}'s payout public key`);
    claim(entry.payoutAddress, `${id}'s payout address`);
    for (const round of expectedRounds) {
      const leaf = sigbashLeafByRound[round]!;
      const identification = sigbashIdentificationLeafByRound[round]!;
      if (leaf === identification) {
        throw new Error(
          `roster entry for ${id}: the ${round} identification leaf key repeats the policy-spend leaf key`,
        );
      }
      claim(leaf, `${id}'s ${round} policy-spend leaf key`);
      claim(identification, `${id}'s ${round} identification leaf key`);
    }

    return {
      id,
      label: config.label,
      personalPublicKeyHex,
      payoutAddress: entry.payoutAddress,
      payoutXonlyPubkeyHex,
      sigbashLeafByRound,
      sigbashIdentificationLeafByRound,
    };
  });

  const ids = entries.map((entry) => entry.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error('roster contains duplicate participant ids');
  }
  for (const expected of expectedIds) {
    if (!ids.includes(expected)) throw new Error(`roster is missing participant ${expected}`);
  }
  return entries;
}

function requireCompressedPubkey(value: unknown, label: string): Hex {
  const hex = typeof value === 'string' ? value.toLowerCase() : '';
  if (!/^0[23][0-9a-f]{64}$/.test(hex) || !ecc.isPoint(Buffer.from(hex, 'hex'))) {
    throw new Error(`${label} must be a valid 33-byte compressed secp256k1 public key`);
  }
  return hex;
}

function requireXonlyPubkey(value: unknown, label: string): Hex {
  const hex = typeof value === 'string' ? value.toLowerCase() : '';
  if (!/^[0-9a-f]{64}$/.test(hex) || !ecc.isXOnlyPoint(Buffer.from(hex, 'hex'))) {
    throw new Error(`${label} must be a valid 32-byte x-only secp256k1 public key`);
  }
  return hex;
}

function requireRoundKeyMap(
  value: unknown,
  expectedRounds: string[],
  label: string,
): Record<string, Hex> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object keyed by round id`);
  }
  const map = value as Record<string, unknown>;
  const rounds = Object.keys(map).sort();
  if (rounds.join(',') !== expectedRounds.join(',')) {
    throw new Error(
      `${label} must cover exactly the rounds [${expectedRounds.join(', ')}], got [${rounds.join(', ')}]`,
    );
  }
  return Object.fromEntries(
    expectedRounds.map((round) => [round, requireXonlyPubkey(map[round], `${label}.${round}`)]),
  );
}

// ── Local signer loading ───────────────────────────────────────────────────

/**
 * Load the signing state for whoever holds VAULT_PARTICIPANT_SECRET. The
 * secret is never accepted as a command-line argument (it would land in shell
 * history, `ps` output, and CI logs) and the participant id is *derived* from
 * the secret rather than asserted by the caller: the only participant this
 * device can sign for is the one whose published personal and payout keys the
 * secret reproduces exactly. Sigbash-managed leaf keys are intentionally not
 * derived from this secret.
 */
export function loadLocalSigner(rosterJson: string): LocalSigner {
  const secret = process.env[SECRET_ENV];
  if (!secret) {
    throw new Error(
      `set ${SECRET_ENV} in this device's environment (never pass a secret as a command-line argument)`,
    );
  }
  return localSignerFromSecret(parseRoster(rosterJson), secret);
}

export function localSignerFromSecret(roster: RosterEntry[], secret: string): LocalSigner {
  if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `${SECRET_ENV} must be at least ${MIN_SECRET_LENGTH} characters; generate one with: openssl rand -hex 32`,
    );
  }
  const allIds = roster.map((entry) => entry.id);
  const matches = roster.filter((entry) => entryMatchesSecret(entry, secret, allIds));
  if (matches.length === 0) {
    throw new Error(
      `${SECRET_ENV} does not reproduce any participant's published personal and payout keys: wrong secret, wrong roster, or a tampered roster`,
    );
  }
  if (matches.length > 1) {
    throw new Error(`${SECRET_ENV} reproduces more than one participant identity; the roster is not key-unique`);
  }
  const local = matches[0]!;
  const state = createRosterState(roster, { participantId: local.id, secret });
  return {
    participantId: local.id,
    roster,
    state,
    custodyChecks: assertSingleSecretCustody(state, local.id),
  };
}

/** Public-only vault state: enough to verify addresses, never to sign. */
export function loadPublicRoster(rosterJson: string): PublicRoster {
  const roster = parseRoster(rosterJson);
  const state = createRosterState(roster);
  for (const participant of state.participants) {
    assertNoPrivateKey(participant.personal.privateKeyHex, `${participant.id} personal key`);
    assertNoPrivateKey(participant.payout.privateKeyHex, `${participant.id} payout key`);
    for (const [round, key] of Object.entries(participant.sigbashByRound)) {
      assertNoPrivateKey(key.privateKeyHex, `${participant.id} ${round} Sigbash leaf key`);
    }
  }
  return {
    roster,
    state,
    custodyChecks: [
      `roster-derived state for ${roster.length} participant(s) carries no private key material at all`,
    ],
  };
}

/**
 * The one-secret proof: the local participant owns their personal and payout
 * keys (verified by re-deriving their public keys), while every Sigbash leaf
 * remains public-only and no other participant contributes private material.
 */
export function assertSingleSecretCustody(state: VaultState, participantId: string): string[] {
  const local = participantById(state, participantId);
  assertOwnedKeypair(local.personal, `${participantId} personal key`);
  assertOwnedKeypair(local.payout, `${participantId} payout key`);
  if (taprootAddress(local.payout.xonlyPubKeyHex) !== local.payoutAddress) {
    throw new Error(`${participantId}'s payout address does not match their payout key`);
  }
  const localRounds = Object.keys(local.sigbashByRound).sort();
  for (const participant of state.participants) {
    if (participant.id !== participantId) {
      assertNoPrivateKey(participant.personal.privateKeyHex, `${participant.id} personal key`);
      assertNoPrivateKey(participant.payout.privateKeyHex, `${participant.id} payout key`);
    }
    for (const [round, key] of Object.entries(participant.sigbashByRound)) {
      assertNoPrivateKey(key.privateKeyHex, `${participant.id} ${round} Sigbash leaf key`);
    }
  }
  const others = state.participants.filter((participant) => participant.id !== participantId);

  return [
    `local signer ${participantId} holds only private personal and payout keys, each proven to derive its published public key`,
    `all ${localRounds.length} local Sigbash round key(s), and every remote Sigbash key, are public-only because leaf signing is delegated to Sigbash`,
    `remote participant(s) ${others.map((other) => other.id).join(', ') || '(none)'} are public-key only: no private key material is present for them`,
  ];
}

export function assertOwnedKeypair(keypair: Keypair, label: string): void {
  if (!/^[0-9a-f]{64}$/.test(keypair.privateKeyHex)) {
    throw new Error(`${label} is missing usable private key material on this device`);
  }
  const derived = ecc.pointFromScalar(Buffer.from(keypair.privateKeyHex, 'hex'), true);
  if (!derived) throw new Error(`${label} private key is not a valid secp256k1 scalar`);
  const derivedHex = Buffer.from(derived).toString('hex');
  if (derivedHex !== keypair.publicKeyHex) {
    throw new Error(`${label} private key does not derive its published public key`);
  }
  if (derivedHex.slice(2) !== keypair.xonlyPubKeyHex) {
    throw new Error(`${label} x-only public key does not match its compressed public key`);
  }
}

function assertNoPrivateKey(privateKeyHex: string, label: string): void {
  // Deliberately never echoes the value it rejects.
  if (privateKeyHex !== '') {
    throw new Error(`custody violation: ${label} carries private key material on this device`);
  }
}

function entryMatchesSecret(entry: RosterEntry, secret: string, allIds: string[]): boolean {
  const keys = deriveParticipantKeys(entry.id, secret, allIds);
  return (
    keys.personal.publicKeyHex === entry.personalPublicKeyHex &&
    keys.payout.xonlyPubKeyHex === entry.payoutXonlyPubkeyHex &&
    taprootAddress(keys.payout.xonlyPubKeyHex) === entry.payoutAddress
  );
}

// ── Shared PSBT authorization primitives ───────────────────────────────────

export function vaultForRound(state: VaultState, currentIds: string[]): VaultRound {
  const vault = state.vaults.get(roundId(currentIds));
  if (!vault) throw new Error(`unknown vault round ${roundId(currentIds)}`);
  return vault;
}

/** Independently recomputed P2TR scriptPubKey for an internal key + tap tree. */
export function taprootOutputScriptHex(
  internalXonlyHex: Hex,
  tapMerkleRootHex: Hex | null,
): Hex {
  const internal = Buffer.from(internalXonlyHex, 'hex');
  const tweak = taggedHash(
    'TapTweak',
    tapMerkleRootHex ? Buffer.concat([internal, Buffer.from(tapMerkleRootHex, 'hex')]) : internal,
  );
  const output = ecc.xOnlyPointAddTweak(internal, tweak);
  if (!output) throw new Error('failed to derive taproot output key');
  return `5120${Buffer.from(output.xOnlyPubkey).toString('hex')}`;
}

/**
 * The PSBT must be exactly what we rebuilt locally. Comparing serialized
 * bytes (rather than field-by-field) means an attacker cannot smuggle extra
 * PSBT fields — proprietary key-value pairs, extra derivations, a second
 * tapLeafScript — past the structural checks below.
 */
export function assertRebuiltPsbtMatches(
  label: string,
  expectedBase64: string,
  candidateBase64: string,
): void {
  if (expectedBase64 !== candidateBase64) {
    throw new Error(
      `${label} is not byte-for-byte the transaction this device rebuilt from the roster and the trusted outpoint`,
    );
  }
}

/** The PSBT spends exactly the coin the operator independently vouched for. */
export function assertTrustedInputMatchesPsbt(
  label: string,
  psbt: bitcoin.Psbt,
  trustedInput: TrustedVaultInput,
): void {
  const tx = unsignedTx(psbt);
  if (tx.ins.length !== 1) {
    throw new Error(`${label} must have exactly 1 input, got ${tx.ins.length}`);
  }
  const input = tx.ins[0]!;
  const txid = Buffer.from(input.hash).reverse().toString('hex');
  if (txid !== trustedInput.txid) {
    throw new Error(`${label} spends txid ${txid}, not the trusted outpoint ${trustedInput.txid}`);
  }
  if (input.index !== trustedInput.vout) {
    throw new Error(
      `${label} spends output index ${input.index}, not the trusted outpoint index ${trustedInput.vout}`,
    );
  }
  if (input.script.length !== 0) {
    throw new Error(`${label} carries a non-empty scriptSig on the vault input`);
  }
  const witnessUtxo = psbt.data.inputs[0]?.witnessUtxo;
  if (!witnessUtxo) throw new Error(`${label} is missing the vault witnessUtxo`);
  if (Buffer.from(witnessUtxo.script).toString('hex') !== trustedInput.scriptPubKeyHex) {
    throw new Error(`${label} witnessUtxo script is not the trusted input's scriptPubKey`);
  }
  if (BigInt(witnessUtxo.value) !== BigInt(trustedInput.valueSats)) {
    throw new Error(
      `${label} witnessUtxo value ${witnessUtxo.value} sats is not the trusted ${trustedInput.valueSats} sats (this changes the BIP-341 sighash)`,
    );
  }
}

/**
 * Nothing signed, nothing finalized, nothing pre-committed. A PSBT that
 * already carries signature material is not an unsigned transaction we are
 * being asked to authorize; it is someone else's half-built spend.
 */
export function assertNoSignatureMaterial(label: string, psbt: bitcoin.Psbt): void {
  psbt.data.inputs.forEach((input, index) => {
    const where = `${label} input ${index}`;
    if (input.tapKeySig) throw new Error(`${where} already carries a tapKeySig`);
    if (input.tapScriptSig?.length) throw new Error(`${where} already carries a tapScriptSig`);
    if (input.partialSig?.length) throw new Error(`${where} already carries a partial signature`);
    if (input.finalScriptSig) throw new Error(`${where} already carries a finalScriptSig`);
    if (input.finalScriptWitness) throw new Error(`${where} already carries a final witness`);
    if (input.sighashType !== undefined && input.sighashType !== bitcoin.Transaction.SIGHASH_DEFAULT) {
      throw new Error(`${where} requests sighash type ${input.sighashType}; only SIGHASH_DEFAULT is authorized`);
    }
  });
}

export function assertUnsignedTransactionShape(
  label: string,
  psbt: bitcoin.Psbt,
  expected: { version: number; locktime: number; sequence: number; outputCount: number },
): void {
  const tx = unsignedTx(psbt);
  if (tx.version !== expected.version) {
    throw new Error(`${label} transaction version is ${tx.version}, expected ${expected.version}`);
  }
  if (tx.locktime !== expected.locktime) {
    throw new Error(`${label} locktime is ${tx.locktime}, expected ${expected.locktime}`);
  }
  const sequence = tx.ins[0]?.sequence;
  if (sequence !== expected.sequence) {
    throw new Error(`${label} input sequence is ${sequence}, expected ${expected.sequence}`);
  }
  if (tx.outs.length !== expected.outputCount) {
    throw new Error(`${label} has ${tx.outs.length} output(s), expected ${expected.outputCount}`);
  }
}

export function assertOutputsMatch(
  label: string,
  psbt: bitcoin.Psbt,
  expectedOutputs: Array<{ address: string; valueSats: number }>,
): void {
  const tx = unsignedTx(psbt);
  if (tx.outs.length !== expectedOutputs.length) {
    throw new Error(`${label} has ${tx.outs.length} output(s), expected ${expectedOutputs.length}`);
  }
  expectedOutputs.forEach((expected, index) => {
    const output = tx.outs[index]!;
    const expectedScript = bitcoin.address.toOutputScript(expected.address, bitcoin.networks.testnet);
    if (!Buffer.from(output.script).equals(Buffer.from(expectedScript))) {
      throw new Error(`${label} output ${index} does not pay the expected address ${expected.address}`);
    }
    if (BigInt(output.value) !== BigInt(expected.valueSats)) {
      throw new Error(
        `${label} output ${index} pays ${output.value} sats, expected ${expected.valueSats} sats`,
      );
    }
  });
}

export function outputTotalSats(psbt: bitcoin.Psbt): number {
  return unsignedTx(psbt).outs.reduce((sum, output) => sum + Number(output.value), 0);
}

// ── Timelocked recovery: independent shares, then aggregation ──────────────

export interface RecoveryAuthorization {
  round: string;
  vanishedId: string;
  trustedInput: TrustedVaultInput;
  leaf: RecoveryTapLeaf;
  leafHashHex: Hex;
  /** BIP-341 script-path sighash every share must sign. */
  messageHex: Hex;
  unsignedTxid: string;
  outputs: Array<{ index: number; address: string; valueSats: number }>;
  feeSats: number;
  checks: string[];
}

/**
 * Fail-closed authorization of a recovery PSBT. The PSBT is rebuilt locally
 * from the roster and the trusted outpoint and compared byte for byte, then
 * re-checked structurally: the exact recovery leaf and control block, a BIP-68
 * sequence that actually enforces the CSV delay, every payout pinned to a
 * roster payout address, the configured fee, and no signature material.
 */
export function authorizeRecoveryPsbt({
  state,
  currentIds,
  vanishedId,
  psbtBase64,
  trustedInput,
}: {
  state: VaultState;
  currentIds: string[];
  vanishedId: string;
  psbtBase64: string;
  trustedInput: TrustedVaultInput;
}): RecoveryAuthorization {
  const round = roundId(currentIds);
  const vault = vaultForRound(state, currentIds);
  // Canonical (sorted) participant order, so two devices holding the same
  // roster in different orders still rebuild the identical transaction.
  const canonicalIds = canonicalParticipantIds(vault);
  if (!canonicalIds.includes(vanishedId)) {
    throw new Error(`${vanishedId} is not a participant in round ${round}`);
  }
  const leaf = recoveryLeafOf(vault);
  if (trustedInput.scriptPubKeyHex !== vault.outputScriptHex) {
    throw new Error(
      `trusted input scriptPubKey is not the ${round} vault script; this coin is not the round-${round} vault UTXO`,
    );
  }
  if (
    taprootOutputScriptHex(vault.keyPath.aggregateXonlyPubkey, vault.tapMerkleRoot) !==
    vault.outputScriptHex
  ) {
    throw new Error(`the ${round} vault script does not commit to its own key path and tap tree`);
  }

  const psbt = bitcoin.Psbt.fromBase64(psbtBase64, { network: bitcoin.networks.testnet });
  assertTrustedInputMatchesPsbt('recovery PSBT', psbt, trustedInput);
  const rebuilt = buildRecoveryPsbt({
    state,
    currentIds: canonicalIds,
    vanishedId,
    txid: trustedInput.txid,
    vout: trustedInput.vout,
    valueSats: trustedInput.valueSats,
  });
  assertRebuiltPsbtMatches('recovery PSBT', rebuilt.psbtBase64, psbtBase64);
  assertNoSignatureMaterial('recovery PSBT', psbt);
  assertUnsignedTransactionShape('recovery PSBT', psbt, {
    version: 2,
    locktime: 0,
    sequence: RECOVERY_DELAY_BLOCKS,
    outputCount: canonicalIds.length,
  });
  const tx = unsignedTx(psbt);
  if (tx.ins[0]!.sequence >= 0x80000000) {
    throw new Error('recovery PSBT sequence disables BIP-68 relative locktime');
  }
  if (tx.ins[0]!.sequence & (1 << 22)) {
    throw new Error('recovery PSBT sequence encodes a time-based, not block-based, relative locktime');
  }

  const input = psbt.data.inputs[0]!;
  if (Buffer.from(input.tapInternalKey ?? []).toString('hex') !== vault.keyPath.aggregateXonlyPubkey) {
    throw new Error(`recovery PSBT does not carry the ${round} key-path internal key`);
  }
  const leafScripts = input.tapLeafScript ?? [];
  if (leafScripts.length !== 1) {
    throw new Error(`recovery PSBT must offer exactly the recovery leaf, got ${leafScripts.length} leaf script(s)`);
  }
  const offered = leafScripts[0]!;
  if (offered.leafVersion !== 0xc0) throw new Error('recovery PSBT leaf version is not 0xc0');
  if (Buffer.from(offered.script).toString('hex') !== leaf.scriptHex) {
    throw new Error('recovery PSBT leaf script is not the round\'s timelocked recovery leaf');
  }
  if (Buffer.from(offered.controlBlock).toString('hex') !== leaf.controlBlockHex) {
    throw new Error('recovery PSBT control block is not the recovery leaf\'s control block');
  }

  const recipients = canonicalIds.map((id) => participantById(state, id));
  const recoverEach = Math.floor((trustedInput.valueSats - AMOUNTS.recoveryFee) / recipients.length);
  assertOutputsMatch(
    'recovery PSBT',
    psbt,
    recipients.map((participant) => ({
      address: participant.payoutAddress,
      valueSats: recoverEach,
    })),
  );
  const feeSats = trustedInput.valueSats - outputTotalSats(psbt);
  if (feeSats < AMOUNTS.recoveryFee || feeSats >= AMOUNTS.recoveryFee + recipients.length) {
    throw new Error(
      `recovery PSBT fee ${feeSats} sats is not the configured ${AMOUNTS.recoveryFee} sats (plus rounding dust)`,
    );
  }

  const leafHash = tapLeafHash(Buffer.from(leaf.scriptHex, 'hex'));
  const message = Buffer.from(
    tx.hashForWitnessV1(
      0,
      [Buffer.from(trustedInput.scriptPubKeyHex, 'hex')],
      [BigInt(trustedInput.valueSats)],
      bitcoin.Transaction.SIGHASH_DEFAULT,
      leafHash,
    ),
  );

  return {
    round,
    vanishedId,
    trustedInput,
    leaf,
    leafHashHex: leafHash.toString('hex'),
    messageHex: message.toString('hex'),
    unsignedTxid: tx.getId(),
    outputs: recipients.map((participant, index) => ({
      index,
      address: participant.payoutAddress,
      valueSats: recoverEach,
    })),
    feeSats,
    checks: [
      'recovery PSBT is byte-for-byte the transaction rebuilt from the roster and the trusted outpoint',
      'input is the trusted outpoint with the trusted value and the round vault script',
      `only the ${round} timelocked recovery leaf (threshold ${leaf.threshold}, ${leaf.relativeBlocks} blocks) is offered`,
      'sequence enforces the block-based BIP-68 delay and version is 2',
      'every output pays a roster payout address for the configured recovery split and fee',
      'no signature or final witness material was present before signing',
    ],
  };
}

export interface RecoveryShare {
  round: string;
  vanishedId: string;
  participantId: string;
  /** The signer's recovery key; must appear in the round's multi_a leaf. */
  xonlyPubkey: Hex;
  leafHashHex: Hex;
  /** Binds the share to one exact unsigned transaction. */
  unsignedTxid: string;
  signatureHex: Hex;
}

/**
 * One participant's recovery signature, produced on their own device from
 * their own secret. The share carries no private material and is useless for
 * any other transaction: it commits to the exact unsigned txid and leaf hash
 * the aggregator will independently re-derive.
 */
export function createRecoveryShare({
  signer,
  currentIds,
  vanishedId,
  psbtBase64,
  trustedInput,
}: {
  signer: LocalSigner;
  currentIds: string[];
  vanishedId: string;
  psbtBase64: string;
  trustedInput: TrustedVaultInput;
}): { share: RecoveryShare; authorization: RecoveryAuthorization } {
  const authorization = authorizeRecoveryPsbt({
    state: signer.state,
    currentIds,
    vanishedId,
    psbtBase64,
    trustedInput,
  });
  if (signer.participantId === vanishedId) {
    throw new Error(`${vanishedId} is the vanished participant and cannot sign their own recovery`);
  }
  const participant = participantById(signer.state, signer.participantId);
  if (!authorization.leaf.recoveryXonlyPubkeys.includes(participant.personal.xonlyPubKeyHex)) {
    throw new Error(
      `${signer.participantId} is not a recovery signer for round ${authorization.round}`,
    );
  }
  assertOwnedKeypair(participant.personal, `${signer.participantId} personal key`);

  const message = Buffer.from(authorization.messageHex, 'hex');
  const signature = Buffer.from(
    ecc.signSchnorr(message, Buffer.from(participant.personal.privateKeyHex, 'hex')),
  );
  if (!ecc.verifySchnorr(message, Buffer.from(participant.personal.xonlyPubKeyHex, 'hex'), signature)) {
    throw new Error('own recovery share failed Schnorr self-verification');
  }
  return {
    share: {
      round: authorization.round,
      vanishedId,
      participantId: signer.participantId,
      xonlyPubkey: participant.personal.xonlyPubKeyHex,
      leafHashHex: authorization.leafHashHex,
      unsignedTxid: authorization.unsignedTxid,
      signatureHex: signature.toString('hex'),
    },
    authorization,
  };
}

export interface AggregatedRecovery {
  round: string;
  vanishedId: string;
  signerIds: string[];
  threshold: number;
  signedPsbtBase64: string;
  transactionHex: string;
  txid: string;
  consensus: ConsensusVerification;
  authorization: RecoveryAuthorization;
  checks: string[];
}

/**
 * Aggregate independent recovery shares into a broadcastable transaction. The
 * aggregator re-derives the authorization itself, so shares are only ever
 * checked against locally computed truth: right round, right leaf, right
 * transaction, distinct signers that are actually in the multi_a key set, and
 * a valid BIP-340 signature each. The witness is assembled explicitly in
 * multi_a order and the result is re-verified from scratch.
 */
export function aggregateRecoveryShares({
  state,
  currentIds,
  vanishedId,
  psbtBase64,
  trustedInput,
  shares,
}: {
  state: VaultState;
  currentIds: string[];
  vanishedId: string;
  psbtBase64: string;
  trustedInput: TrustedVaultInput;
  shares: RecoveryShare[];
}): AggregatedRecovery {
  const authorization = authorizeRecoveryPsbt({
    state,
    currentIds,
    vanishedId,
    psbtBase64,
    trustedInput,
  });
  const { leaf } = authorization;
  if (!Array.isArray(shares) || shares.length === 0) {
    throw new Error('no recovery shares supplied');
  }
  // multi_a's OP_NUMEQUAL demands *exactly* `threshold` signatures: fewer
  // fails the threshold, more fails the script.
  if (shares.length !== leaf.threshold) {
    throw new Error(
      `recovery needs exactly ${leaf.threshold} distinct share(s) for round ${authorization.round}, got ${shares.length}`,
    );
  }

  const message = Buffer.from(authorization.messageHex, 'hex');
  const vanished = participantById(state, vanishedId);
  const signatureByPubkey = new Map<Hex, Buffer>();
  const signerIds: string[] = [];
  for (const share of shares) {
    if (!share || typeof share !== 'object') throw new Error('recovery share must be an object');
    if (share.round !== authorization.round) {
      throw new Error(`recovery share from ${share.participantId} is for round ${share.round}, not ${authorization.round}`);
    }
    if (share.vanishedId !== vanishedId) {
      throw new Error(`recovery share from ${share.participantId} names a different vanished participant`);
    }
    if (share.leafHashHex !== authorization.leafHashHex) {
      throw new Error(`recovery share from ${share.participantId} is bound to a different tapscript leaf`);
    }
    if (share.unsignedTxid !== authorization.unsignedTxid) {
      throw new Error(`recovery share from ${share.participantId} is bound to a different transaction`);
    }
    const xonlyPubkey = requireXonlyPubkey(share.xonlyPubkey, `recovery share ${share.participantId} key`);
    if (!leaf.recoveryXonlyPubkeys.includes(xonlyPubkey)) {
      throw new Error(`recovery share key is not in the ${authorization.round} recovery key set`);
    }
    if (xonlyPubkey === vanished.personal.xonlyPubKeyHex) {
      throw new Error(`the vanished participant ${vanishedId} cannot contribute a recovery share`);
    }
    if (signatureByPubkey.has(xonlyPubkey)) {
      throw new Error('duplicate recovery share: the same key signed twice');
    }
    if (typeof share.signatureHex !== 'string' || !/^[0-9a-f]{128}$/.test(share.signatureHex)) {
      throw new Error(`recovery share from ${share.participantId} is not a 64-byte BIP-340 signature`);
    }
    const signature = Buffer.from(share.signatureHex, 'hex');
    if (!ecc.verifySchnorr(message, Buffer.from(xonlyPubkey, 'hex'), signature)) {
      throw new Error(`recovery share from ${share.participantId} is not a valid signature over this transaction`);
    }
    // The roster is the source of truth for who a key belongs to.
    const claimed = state.participants.find(
      (participant) => participant.personal.xonlyPubKeyHex === xonlyPubkey,
    );
    if (!claimed || claimed.id !== share.participantId) {
      throw new Error(`recovery share from ${share.participantId} does not use that participant's roster key`);
    }
    signatureByPubkey.set(xonlyPubkey, signature);
    signerIds.push(claimed.id);
  }

  // multi_a semantics: missing signers get an empty stack element and the
  // first script key's signature must end up on top of the initial stack.
  const signaturesInKeyOrder = leaf.recoveryXonlyPubkeys.map(
    (pubkey) => signatureByPubkey.get(pubkey) ?? Buffer.alloc(0),
  );
  const witnessStack = [
    ...[...signaturesInKeyOrder].reverse(),
    Buffer.from(leaf.scriptHex, 'hex'),
    Buffer.from(leaf.controlBlockHex, 'hex'),
  ];
  const psbt = bitcoin.Psbt.fromBase64(psbtBase64, { network: bitcoin.networks.testnet });
  psbt.finalizeInput(0, () => ({
    finalScriptSig: undefined,
    finalScriptWitness: witnessStackToScriptWitness(witnessStack),
  }));
  const transaction = psbt.extractTransaction();
  if (transaction.getId() !== authorization.unsignedTxid) {
    throw new Error('aggregated recovery transaction is not the transaction the shares authorized');
  }
  const witness = transaction.ins[0]?.witness ?? [];
  if (witness.length !== leaf.recoveryXonlyPubkeys.length + 2) {
    throw new Error(`aggregated recovery witness has ${witness.length} elements, expected ${leaf.recoveryXonlyPubkeys.length + 2}`);
  }
  if (Buffer.from(witness.at(-2)!).toString('hex') !== leaf.scriptHex) {
    throw new Error('aggregated recovery witness does not spend the recovery leaf');
  }
  if (Buffer.from(witness.at(-1)!).toString('hex') !== leaf.controlBlockHex) {
    throw new Error('aggregated recovery witness carries the wrong control block');
  }
  const signatureElements = witness.slice(0, leaf.recoveryXonlyPubkeys.length).filter((item) => item.length > 0);
  if (signatureElements.length !== leaf.threshold) {
    throw new Error(
      `aggregated recovery witness carries ${signatureElements.length} signature(s), multi_a requires exactly ${leaf.threshold}`,
    );
  }

  const prevout: Prevout = {
    scriptPubKeyHex: trustedInput.scriptPubKeyHex,
    valueSats: trustedInput.valueSats,
  };
  const consensus = verifyVaultTransaction({
    txHex: transaction.toHex(),
    prevouts: [prevout],
  });

  return {
    round: authorization.round,
    vanishedId,
    signerIds,
    threshold: leaf.threshold,
    signedPsbtBase64: psbt.toBase64(),
    transactionHex: transaction.toHex(),
    txid: transaction.getId(),
    consensus,
    authorization,
    checks: [
      ...authorization.checks,
      `exactly ${leaf.threshold} distinct roster-bound recovery key(s) signed the authorized transaction`,
      'every share is a valid BIP-340 signature over the recomputed BIP-341 script-path message',
      'the finalized witness is the exact multi_a stack for the recovery leaf',
      'the aggregated transaction passes independent consensus verification',
    ],
  };
}

/**
 * Round membership in canonical (sorted) order. The vault tree itself is
 * already order-independent; this makes the *transactions* order-independent
 * too, so participants never disagree on output ordering because they typed
 * the roster in a different order.
 */
export function canonicalParticipantIds(vault: VaultRound): string[] {
  return [...vault.participantIds].sort();
}

function recoveryLeafOf(vault: VaultRound): RecoveryTapLeaf {
  const leaf = vault.tapscriptLeaves.find((item) => item.type === 'timelocked-recovery');
  if (leaf?.type !== 'timelocked-recovery') throw new Error(`no recovery leaf for ${vault.id}`);
  return leaf;
}

// ── Final sweep ────────────────────────────────────────────────────────────

export interface FinalSweepAuthorization {
  participantId: string;
  trustedInput: TrustedVaultInput;
  destinationAddress: string;
  sweepSats: number;
  feeSats: number;
  signerXonlyPubkey: Hex;
  unsignedTxid: string;
  checks: string[];
}

/**
 * Fail-closed authorization of the last participant's sweep of their own
 * payout output. The signer proves the coin is spendable by *their* payout key
 * path (by re-deriving the output script from that key), that the PSBT is the
 * one they rebuilt, and that the destination, amount, and fee are exactly what
 * they intended before a signature exists.
 */
export function authorizeFinalSweep({
  state,
  participantId,
  psbtBase64,
  trustedInput,
  destinationAddress,
  feeSats,
}: {
  state: VaultState;
  participantId: string;
  psbtBase64: string;
  trustedInput: TrustedVaultInput;
  destinationAddress?: string | undefined;
  feeSats: number;
}): FinalSweepAuthorization {
  const participant = participantById(state, participantId);
  if (!Number.isSafeInteger(feeSats) || feeSats <= 0) {
    throw new Error('final sweep --fee-sats must be a positive integer');
  }
  const payoutScriptHex = Buffer.from(
    bitcoin.address.toOutputScript(participant.payoutAddress, bitcoin.networks.testnet),
  ).toString('hex');
  if (trustedInput.scriptPubKeyHex !== payoutScriptHex) {
    throw new Error(
      `trusted input scriptPubKey is not ${participantId}'s payout output; this device can only sweep its owner's coin`,
    );
  }
  if (taprootOutputScriptHex(participant.payout.xonlyPubKeyHex, null) !== payoutScriptHex) {
    throw new Error(`${participantId}'s payout address is not the key-path output of their payout key`);
  }
  const destination = destinationAddress || participant.payoutAddress;
  const sweepSats = trustedInput.valueSats - feeSats;
  if (sweepSats <= 0) throw new Error(`final sweep value ${sweepSats} sats is not positive after fee`);

  const psbt = bitcoin.Psbt.fromBase64(psbtBase64, { network: bitcoin.networks.testnet });
  assertTrustedInputMatchesPsbt('final sweep PSBT', psbt, trustedInput);
  const rebuilt = buildFinalSweepPsbt({
    state,
    participantId,
    txid: trustedInput.txid,
    vout: trustedInput.vout,
    valueSats: trustedInput.valueSats,
    feeSats,
    ...(destinationAddress ? { destinationAddress } : {}),
  });
  assertRebuiltPsbtMatches('final sweep PSBT', rebuilt.psbtBase64, psbtBase64);
  assertNoSignatureMaterial('final sweep PSBT', psbt);
  assertUnsignedTransactionShape('final sweep PSBT', psbt, {
    version: 2,
    locktime: 0,
    sequence: 0xffffffff,
    outputCount: 1,
  });
  assertOutputsMatch('final sweep PSBT', psbt, [{ address: destination, valueSats: sweepSats }]);

  const input = psbt.data.inputs[0]!;
  if (Buffer.from(input.tapInternalKey ?? []).toString('hex') !== participant.payout.xonlyPubKeyHex) {
    throw new Error('final sweep PSBT does not commit to the sweeping participant\'s payout key path');
  }
  if (input.tapLeafScript?.length) {
    throw new Error('final sweep PSBT offers a tapscript leaf; the sweep is a pure key-path spend');
  }
  const actualFee = trustedInput.valueSats - outputTotalSats(psbt);
  if (actualFee !== feeSats) {
    throw new Error(`final sweep fee is ${actualFee} sats, expected exactly ${feeSats} sats`);
  }

  return {
    participantId,
    trustedInput,
    destinationAddress: destination,
    sweepSats,
    feeSats,
    signerXonlyPubkey: participant.payout.xonlyPubKeyHex,
    unsignedTxid: unsignedTx(psbt).getId(),
    checks: [
      'final sweep PSBT is byte-for-byte the transaction rebuilt from the roster and the trusted outpoint',
      'the trusted input is the local signer\'s own payout output, re-derived from their payout key',
      'single key-path input, single output, exact destination, amount, and fee',
      'no tapscript leaf, no signature material present before signing',
    ],
  };
}
