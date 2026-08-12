import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { AMOUNTS, RECOVERY_DELAY_BLOCKS } from './config.js';
import { keyAggSecret, taggedHashHex, tapLeafHash, xpubMasterFingerprint } from './crypto.js';
import { participantById, policyId, roundId, sigbashRoundKey } from './vault.js';
import type {
  Hex,
  Keypair,
  PsbtInspection,
  SoloPolicy,
  VaultKeyPath,
  VaultRound,
  VaultState,
} from './types.js';

bitcoin.initEccLib(ecc);

// bitcoinjs' Psbt keeps the unsigned transaction in a private cache; the
// inspect/sighash helpers need it. Confined to this single accessor.
function unsignedTx(psbt: bitcoin.Psbt): bitcoin.Transaction {
  return (psbt as unknown as { __CACHE: { __TX: bitcoin.Transaction } }).__CACHE.__TX;
}

// bitcoinjs' Signer interface demands an ECDSA sign() even for pure taproot
// signers; ours are Schnorr-only.
function schnorrOnlySigner(publicKey: Buffer, privateKey: Buffer): bitcoin.Signer {
  return {
    publicKey,
    sign(): Buffer {
      throw new Error('this signer only produces BIP-340 Schnorr signatures');
    },
    signSchnorr(hash: Buffer): Buffer {
      return Buffer.from(ecc.signSchnorr(hash, privateKey));
    },
  };
}

export interface FundingInput {
  participantId: string;
  txid: string;
  vout: number | string;
  valueSats: number | string;
  scriptPubKeyHex: Hex;
  changeAddress?: string;
}

export function buildFundingPsbt({
  state,
  inputs,
  feeSats = 0,
}: {
  state: VaultState;
  inputs: FundingInput[];
  feeSats?: number;
}) {
  const participantIds = state.participants.map((participant) => participant.id);
  const roundOneVault = requireVault(state, participantIds);
  const byParticipant = new Map(inputs.map((input) => [input.participantId, input]));
  const missing = participantIds.filter((participantId) => !byParticipant.has(participantId));
  if (missing.length > 0) {
    throw new Error(`funding PSBT missing input for ${missing.join(', ')}`);
  }
  const feeShare = Math.floor(feeSats / participantIds.length);
  const feeRemainder = feeSats - feeShare * participantIds.length;
  const psbt = new bitcoin.Psbt({ network: bitcoin.networks.testnet });
  const normalizedInputs = participantIds.map((participantId, index) => {
    const input = byParticipant.get(participantId)!;
    const valueSats = Number(input.valueSats);
    if (valueSats < AMOUNTS.deposit) {
      throw new Error(`${participantId} input is below 1 BTC deposit`);
    }
    const participantFee = feeShare + (index === 0 ? feeRemainder : 0);
    const changeSats = valueSats - AMOUNTS.deposit - participantFee;
    if (changeSats < 0) {
      throw new Error(`${participantId} input cannot cover deposit plus fee share`);
    }
    psbt.addInput({
      hash: input.txid,
      index: Number(input.vout),
      witnessUtxo: {
        script: Buffer.from(input.scriptPubKeyHex, 'hex'),
        value: BigInt(valueSats),
      },
    });
    return {
      participantId,
      txid: input.txid,
      vout: Number(input.vout),
      valueSats,
      scriptPubKeyHex: input.scriptPubKeyHex,
      changeAddress: input.changeAddress,
      changeSats,
      feeSats: participantFee,
    };
  });

  psbt.addOutput({
    address: roundOneVault.address,
    value: BigInt(AMOUNTS.deposit * participantIds.length),
  });
  for (const input of normalizedInputs) {
    if (input.changeSats > 0) {
      if (!input.changeAddress) {
        throw new Error(`${input.participantId} needs changeAddress for ${input.changeSats} sats change`);
      }
      psbt.addOutput({ address: input.changeAddress, value: BigInt(input.changeSats) });
    }
  }

  return {
    psbtBase64: psbt.toBase64(),
    psbtHex: psbt.toHex(),
    txTemplate: {
      inputs: normalizedInputs,
      outputs: [
        {
          index: 0,
          address: roundOneVault.address,
          valueSats: AMOUNTS.deposit * participantIds.length,
          scriptPubKeyHex: roundOneVault.outputScriptHex,
          label: 'round-one vault',
        },
        ...normalizedInputs
          .filter((input) => input.changeSats > 0)
          .map((input, changeIndex) => ({
            index: changeIndex + 1,
            address: input.changeAddress,
            valueSats: input.changeSats,
            label: `${input.participantId} change`,
          })),
      ],
      feeSats,
    },
  };
}

export interface SoloPsbtParams {
  state: VaultState;
  currentIds: string[];
  leaverId: string;
  txid: string;
  vout: number;
  valueSats: number;
}

export interface BuiltPsbt {
  round: string;
  leaverId: string;
  tamper?: string;
  psbtBase64: string;
  psbtHex: string;
  txTemplate: {
    input: { txid: string; vout: number; valueSats: number; scriptPubKeyHex: Hex };
    /** The policy-spend leaf — the only leaf solo signing may use. */
    tapLeafScript: {
      leafVersion: number;
      scriptHex: Hex;
      controlBlockHex: Hex;
      role: 'policy-spend';
    };
    /**
     * The Sigbash identification leaf. Included in the PSBT so live Sigbash
     * recognizes the input; must never be signed or finalized.
     */
    identificationLeaf: {
      leafVersion: number;
      scriptHex: Hex;
      controlBlockHex: Hex;
      role: 'identification-only';
    };
    outputs: Array<{ index: number; address: string; valueSats: number }>;
    feeSats: number;
    configuredFeeSats: number;
  };
}

export function buildSoloWithdrawalPsbt(params: SoloPsbtParams): BuiltPsbt {
  const context = soloWithdrawalContext(params);
  return buildSoloWithdrawalPsbtFromOutputs(context);
}

export function buildSoloWithdrawalTamperPsbts(params: SoloPsbtParams): {
  valid: BuiltPsbt;
  tampered: Record<'wrongAmount' | 'wrongAddress' | 'extraOutput', BuiltPsbt>;
} {
  const context = soloWithdrawalContext(params);
  const valid = buildSoloWithdrawalPsbtFromOutputs(context);
  const otherParticipant = params.state.participants.find(
    (participant) => participant.id !== params.leaverId,
  );
  if (!otherParticipant) throw new Error(`could not find wrong-address participant for ${params.leaverId}`);

  const wrongAmountOutputs = structuredClone(context.outputs);
  wrongAmountOutputs[0]!.valueSats += 1;
  const wrongAddressOutputs = structuredClone(context.outputs);
  wrongAddressOutputs[0]!.address = otherParticipant.payoutAddress;
  const extraOutputOutputs = [
    ...structuredClone(context.outputs),
    { address: context.outputs[0]!.address, valueSats: 1 },
  ];

  return {
    valid,
    tampered: {
      wrongAmount: buildSoloWithdrawalPsbtFromOutputs({
        ...context,
        outputs: wrongAmountOutputs,
        tamper: 'wrongAmount',
      }),
      wrongAddress: buildSoloWithdrawalPsbtFromOutputs({
        ...context,
        outputs: wrongAddressOutputs,
        tamper: 'wrongAddress',
      }),
      extraOutput: buildSoloWithdrawalPsbtFromOutputs({
        ...context,
        outputs: extraOutputOutputs,
        tamper: 'extraOutput',
      }),
    },
  };
}

/**
 * Negative-regression fixture only: a solo-shaped PSBT whose sole
 * tapLeafScript is the Sigbash identification leaf. Local solo signing and
 * the local policy preflight must both reject it — the identification leaf
 * carries no spend authority in the local model.
 */
export function buildIdentificationLeafMisusePsbt(params: SoloPsbtParams): {
  round: string;
  leaverId: string;
  psbtBase64: string;
  identificationLeafScriptHex: Hex;
} {
  const context = soloWithdrawalContext(params);
  const psbt = new bitcoin.Psbt({ network: bitcoin.networks.testnet });
  psbt.addInput({
    hash: context.txid,
    index: context.vout,
    witnessUtxo: {
      script: Buffer.from(context.vault.outputScriptHex, 'hex'),
      value: BigInt(context.valueSats),
    },
    tapInternalKey: Buffer.from(context.vault.keyPath.aggregateXonlyPubkey, 'hex'),
    tapLeafScript: [
      {
        leafVersion: 0xc0,
        script: Buffer.from(context.identificationLeaf.scriptHex, 'hex'),
        controlBlock: Buffer.from(context.identificationLeaf.controlBlockHex, 'hex'),
      },
    ],
  });
  for (const output of context.outputs) {
    psbt.addOutput({ address: output.address, value: BigInt(output.valueSats) });
  }
  return {
    round: context.round,
    leaverId: context.leaverId,
    psbtBase64: psbt.toBase64(),
    identificationLeafScriptHex: context.identificationLeaf.scriptHex,
  };
}

interface SoloContext {
  round: string;
  vault: VaultRound;
  /** Policy-spend leaf pk(child 0/0): the leaf that is signed and finalized. */
  leaf: { scriptHex: Hex; controlBlockHex: Hex };
  /** Identification leaf pk(internal root): carried for Sigbash, never signed. */
  identificationLeaf: { scriptHex: Hex; controlBlockHex: Hex };
  leaverId: string;
  txid: string;
  vout: number;
  valueSats: number;
  fee: number;
  policy: SoloPolicy;
  outputs: Array<{ index?: number; address: string; valueSats: number }>;
  tamper?: string;
  /**
   * BIP-371 derivation for the Sigbash *policy* leaf key — the xpub child
   * 0/0 (live mode). Without this the Sigbash WASM wallet does not recognize
   * the vault input as one it controls ("no Sigbash-controlled inputs found
   * in PSBT"). The identification leaf gets no derivation entry: it carries
   * the xpub's own root key.
   */
  tapBip32Derivation?: {
    masterFingerprint: Buffer;
    pubkey: Buffer;
    path: string;
    leafHashes: Buffer[];
  };
}

export function soloLeavesOf(vault: VaultRound, participantId: string) {
  const policyLeaf = vault.tapscriptLeaves.find(
    (item) => item.type === 'solo-withdrawal' && item.participantId === participantId,
  );
  if (!policyLeaf) throw new Error(`no solo leaf for ${participantId} in ${vault.id}`);
  const identificationLeaf = vault.tapscriptLeaves.find(
    (item) => item.type === 'sigbash-identification' && item.participantId === participantId,
  );
  if (!identificationLeaf) {
    throw new Error(`no Sigbash identification leaf for ${participantId} in ${vault.id}`);
  }
  if (identificationLeaf.scriptHex === policyLeaf.scriptHex) {
    throw new Error(`identification leaf equals policy leaf for ${participantId} in ${vault.id}`);
  }
  return { policyLeaf, identificationLeaf };
}

function soloWithdrawalContext({ state, currentIds, leaverId, txid, vout, valueSats }: SoloPsbtParams): SoloContext {
  const round = roundId(currentIds);
  const vault = requireVault(state, currentIds);
  const policy = state.policies.get(policyId(currentIds, leaverId));
  if (!policy) throw new Error(`unknown solo policy ${policyId(currentIds, leaverId)}`);
  const { policyLeaf: leaf, identificationLeaf } = soloLeavesOf(vault, leaverId);

  const payout = outputValue(policy, 0, 'EQ');
  const nextAddress = outputAddress(policy, 1);
  const fee = currentIds.length === 3 ? AMOUNTS.feePerSoloWithdrawal : AMOUNTS.feePerSoloWithdrawal * 2;
  const leftover = valueSats - payout - fee;
  const floor = outputValue(policy, 1, 'GTE');
  if (leftover < floor) {
    throw new Error(`leftover ${leftover} sats is below policy floor ${floor}`);
  }
  const roundKey = sigbashRoundKey(participantById(state, leaverId), round);
  const tapBip32Derivation = roundKey.xpub
    ? {
        masterFingerprint: xpubMasterFingerprint(roundKey.xpub),
        pubkey: Buffer.from(roundKey.xonlyPubKeyHex, 'hex'),
        path: 'm/0/0',
        leafHashes: [tapLeafHash(Buffer.from(leaf.scriptHex, 'hex'))],
      }
    : undefined;
  return {
    round,
    vault,
    leaf,
    identificationLeaf,
    leaverId,
    txid,
    vout,
    valueSats,
    fee,
    policy,
    ...(tapBip32Derivation ? { tapBip32Derivation } : {}),
    outputs: [
      { index: 0, address: outputAddress(policy, 0), valueSats: payout },
      { index: 1, address: nextAddress, valueSats: leftover },
    ],
  };
}

function buildSoloWithdrawalPsbtFromOutputs({
  round,
  vault,
  leaf,
  identificationLeaf,
  leaverId,
  txid,
  vout,
  valueSats,
  fee,
  outputs,
  tamper = undefined,
  tapBip32Derivation = undefined,
}: SoloContext): BuiltPsbt {
  const outputTotal = outputs.reduce((sum, output) => sum + output.valueSats, 0);
  if (outputTotal >= valueSats) {
    throw new Error(`solo withdrawal outputs ${outputTotal} sats leave no fee from ${valueSats} sats input`);
  }
  const psbt = new bitcoin.Psbt({ network: bitcoin.networks.testnet });
  psbt.addInput({
    hash: txid,
    index: vout,
    witnessUtxo: {
      script: Buffer.from(vault.outputScriptHex, 'hex'),
      value: BigInt(valueSats),
    },
    tapInternalKey: Buffer.from(vault.keyPath.aggregateXonlyPubkey, 'hex'),
    // Both Sigbash leaves ride in the PSBT: the policy leaf is the one that
    // gets signed; the identification leaf lets live Sigbash recognize the
    // input ("aggregate key found in tapscript leaf"). Local signing selects
    // by script, never by position.
    tapLeafScript: [
      {
        leafVersion: 0xc0,
        script: Buffer.from(leaf.scriptHex, 'hex'),
        controlBlock: Buffer.from(leaf.controlBlockHex, 'hex'),
      },
      {
        leafVersion: 0xc0,
        script: Buffer.from(identificationLeaf.scriptHex, 'hex'),
        controlBlock: Buffer.from(identificationLeaf.controlBlockHex, 'hex'),
      },
    ],
    ...(tapBip32Derivation ? { tapBip32Derivation: [tapBip32Derivation] } : {}),
  });
  for (const output of outputs) {
    psbt.addOutput({ address: output.address, value: BigInt(output.valueSats) });
  }

  return {
    round,
    leaverId,
    ...(tamper ? { tamper } : {}),
    psbtBase64: psbt.toBase64(),
    psbtHex: psbt.toHex(),
    txTemplate: {
      input: { txid, vout, valueSats, scriptPubKeyHex: vault.outputScriptHex },
      tapLeafScript: {
        leafVersion: 0xc0,
        scriptHex: leaf.scriptHex,
        controlBlockHex: leaf.controlBlockHex,
        role: 'policy-spend',
      },
      identificationLeaf: {
        leafVersion: 0xc0,
        scriptHex: identificationLeaf.scriptHex,
        controlBlockHex: identificationLeaf.controlBlockHex,
        role: 'identification-only',
      },
      outputs: outputs.map((output, index) => ({
        index,
        address: output.address,
        valueSats: output.valueSats,
      })),
      feeSats: valueSats - outputTotal,
      configuredFeeSats: fee,
    },
  };
}

export interface SignedTransaction {
  signedPsbtBase64: string;
  signedPsbtHex: string;
  transactionHex: string;
  txid: string;
}

export function signSoloWithdrawalPsbt({
  state,
  currentIds,
  leaverId,
  psbtBase64,
}: {
  state: VaultState;
  currentIds: string[];
  leaverId: string;
  psbtBase64: string;
}): SignedTransaction & {
  round: string;
  leaverId: string;
  mode: string;
  signedLeaf: { role: 'policy-spend'; scriptHex: Hex };
} {
  const round = roundId(currentIds);
  const vault = requireVault(state, currentIds);
  const participant = participantById(state, leaverId);
  const { policyLeaf: leaf, identificationLeaf } = soloLeavesOf(vault, leaverId);

  const psbt = bitcoin.Psbt.fromBase64(psbtBase64, { network: bitcoin.networks.testnet });
  const input = psbt.data.inputs[0];
  const psbtLeaf = input?.tapLeafScript?.find(
    (item) => Buffer.from(item.script).toString('hex') === leaf.scriptHex,
  );
  if (!psbtLeaf) {
    throw new Error(
      `PSBT does not contain the ${leaverId} policy-spend leaf for ${round}; ` +
        'the identification leaf alone is never signable',
    );
  }
  const roundSigbashKey = sigbashRoundKey(participant, round);
  if (roundSigbashKey.isLiveKey) {
    throw new Error(
      `${leaverId} uses a live Sigbash leaf key for ${round}; sign with sigbash-sign-psbt instead of the local model`,
    );
  }
  psbt.signTaprootInput(0, taprootScriptSigner(roundSigbashKey));
  const signaturesValid = psbt.validateSignaturesOfInput(0, (pubkey, hash, signature) =>
    ecc.verifySchnorr(hash, pubkey, signature),
  );
  if (!signaturesValid) throw new Error('solo withdrawal signature validation failed');
  // Finalize the policy leaf by its leaf hash so the identification leaf can
  // never be selected, then verify the extracted witness actually spends the
  // policy leaf script.
  psbt.finalizeTaprootInput(0, tapLeafHash(Buffer.from(leaf.scriptHex, 'hex')));
  const transaction = psbt.extractTransaction();
  const witness = transaction.ins[0]?.witness ?? [];
  const witnessScriptHex = witness.at(-2) ? Buffer.from(witness.at(-2)!).toString('hex') : '';
  if (witnessScriptHex !== leaf.scriptHex) {
    throw new Error('finalized solo witness does not spend the policy-spend leaf');
  }
  if (witnessScriptHex === identificationLeaf.scriptHex) {
    throw new Error('finalized solo witness spends the identification leaf');
  }
  return {
    round,
    leaverId,
    signedPsbtBase64: psbt.toBase64(),
    signedPsbtHex: psbt.toHex(),
    transactionHex: transaction.toHex(),
    txid: transaction.getId(),
    mode: 'local-deterministic-sigbash-leaf',
    signedLeaf: { role: 'policy-spend', scriptHex: leaf.scriptHex },
  };
}

export function buildCooperativeExitPsbt({
  state,
  currentIds,
  txid,
  vout,
  valueSats,
  feeSats = AMOUNTS.cooperativeFee,
}: {
  state: VaultState;
  currentIds: string[];
  txid: string;
  vout: number;
  valueSats: number;
  feeSats?: number;
}) {
  const round = roundId(currentIds);
  const vault = requireVault(state, currentIds);
  const current = currentIds.map((id) => participantById(state, id));
  // The pot is split equally after a small miner fee (a zero-fee transaction
  // is consensus-valid but will not relay). For the round-one vault this is
  // each participant's full 1 BTC deposit minus ~300 sats; for a pair round it
  // also returns the departed player's haircut instead of burning it to fees.
  const refundSats = Math.floor((valueSats - feeSats) / current.length);
  if (refundSats <= 0) throw new Error('cooperative refund is not positive after fee');

  const psbt = new bitcoin.Psbt({ network: bitcoin.networks.testnet });
  psbt.addInput({
    hash: txid,
    index: vout,
    witnessUtxo: {
      script: Buffer.from(vault.outputScriptHex, 'hex'),
      value: BigInt(valueSats),
    },
    tapInternalKey: Buffer.from(vault.keyPath.aggregateXonlyPubkey, 'hex'),
  });
  for (const participant of current) {
    psbt.addOutput({
      address: participant.payoutAddress,
      value: BigInt(refundSats),
    });
  }

  return {
    round,
    psbtBase64: psbt.toBase64(),
    psbtHex: psbt.toHex(),
    txTemplate: {
      input: { txid, vout, valueSats, scriptPubKeyHex: vault.outputScriptHex },
      keyPath: vault.keyPath,
      outputs: current.map((participant, index) => ({
        index,
        address: participant.payoutAddress,
        valueSats: refundSats,
      })),
      feeSats: valueSats - refundSats * current.length,
    },
  };
}

export function signCooperativeExitPsbt({
  state,
  currentIds,
  psbtBase64,
}: {
  state: VaultState;
  currentIds: string[];
  psbtBase64: string;
}): SignedTransaction & { round: string; signerIds: string[]; mode: string } {
  const round = roundId(currentIds);
  const vault = requireVault(state, currentIds);
  const participants = currentIds.map((id) => participantById(state, id));
  if (vault.keyPath.sigbashXonlyPubkeys.length !== 0) {
    throw new Error('cooperative key path includes Sigbash keys');
  }

  const psbt = bitcoin.Psbt.fromBase64(psbtBase64, { network: bitcoin.networks.testnet });
  const input = psbt.data.inputs[0];
  if (!input?.witnessUtxo) throw new Error('cooperative PSBT input 0 is missing witnessUtxo');
  if (Buffer.from(input.tapInternalKey || []).toString('hex') !== vault.keyPath.aggregateXonlyPubkey) {
    throw new Error(`PSBT does not use the ${round} cooperative aggregate key`);
  }
  const message = taprootKeySpendHash(psbt, 0);
  const signature = cooperativeSignature({
    participants: participants.map((participant) => participant.personal),
    keyPath: vault.keyPath,
    tapMerkleRoot: vault.tapMerkleRoot,
    message,
  });
  const outputKey = Buffer.from(input.witnessUtxo.script).subarray(2, 34);
  if (!ecc.verifySchnorr(message, outputKey, signature)) {
    throw new Error('cooperative aggregate signature validation failed');
  }
  psbt.updateInput(0, { tapKeySig: signature });
  psbt.finalizeInput(0);
  const transaction = psbt.extractTransaction();
  return {
    round,
    signerIds: participants.map((participant) => participant.id),
    signedPsbtBase64: psbt.toBase64(),
    signedPsbtHex: psbt.toHex(),
    transactionHex: transaction.toHex(),
    txid: transaction.getId(),
    mode: 'deterministic-local-cooperative-aggregate',
  };
}

export function buildRecoveryPsbt({
  state,
  currentIds,
  vanishedId,
  txid,
  vout,
  valueSats,
}: {
  state: VaultState;
  currentIds: string[];
  vanishedId: string;
  txid: string;
  vout: number;
  valueSats: number;
}) {
  const round = roundId(currentIds);
  const vault = requireVault(state, currentIds);
  const leaf = recoveryLeafOf(vault);
  const rescuers = currentIds
    .filter((id) => id !== vanishedId)
    .map((id) => participantById(state, id));
  if (rescuers.length < leaf.threshold) {
    throw new Error(
      `recovery requires ${leaf.threshold} signer(s), only ${rescuers.length} available after ${vanishedId} vanished`,
    );
  }
  const recipients = currentIds.map((id) => participantById(state, id));
  const recoverEach = Math.floor((valueSats - AMOUNTS.recoveryFee) / recipients.length);
  const outputTotal = recoverEach * recipients.length;
  if (outputTotal > valueSats) {
    throw new Error(`recovery outputs ${outputTotal} sats exceed input ${valueSats} sats`);
  }

  const psbt = new bitcoin.Psbt({ network: bitcoin.networks.testnet });
  psbt.setVersion(2);
  psbt.addInput({
    hash: txid,
    index: vout,
    sequence: RECOVERY_DELAY_BLOCKS,
    witnessUtxo: {
      script: Buffer.from(vault.outputScriptHex, 'hex'),
      value: BigInt(valueSats),
    },
    tapInternalKey: Buffer.from(vault.keyPath.aggregateXonlyPubkey, 'hex'),
    tapLeafScript: [
      {
        leafVersion: 0xc0,
        script: Buffer.from(leaf.scriptHex, 'hex'),
        controlBlock: Buffer.from(leaf.controlBlockHex, 'hex'),
      },
    ],
  });
  for (const participant of recipients) {
    psbt.addOutput({ address: participant.payoutAddress, value: BigInt(recoverEach) });
  }

  return {
    round,
    vanishedId,
    psbtBase64: psbt.toBase64(),
    psbtHex: psbt.toHex(),
    txTemplate: {
      version: 2,
      input: {
        txid,
        vout,
        valueSats,
        sequence: RECOVERY_DELAY_BLOCKS,
        scriptPubKeyHex: vault.outputScriptHex,
      },
      tapLeafScript: {
        leafVersion: 0xc0,
        scriptHex: leaf.scriptHex,
        controlBlockHex: leaf.controlBlockHex,
        threshold: leaf.threshold,
        recoveryXonlyPubkeys: leaf.recoveryXonlyPubkeys,
      },
      signerIds: rescuers.map((participant) => participant.id),
      outputs: recipients.map((participant, index) => ({
        index,
        address: participant.payoutAddress,
        valueSats: recoverEach,
      })),
      feeSats: valueSats - outputTotal,
    },
  };
}

export function buildFinalSweepPsbt({
  state,
  participantId,
  txid,
  vout,
  valueSats,
  feeSats = AMOUNTS.finalSweepFee,
  destinationAddress,
}: {
  state: VaultState;
  participantId: string;
  txid: string;
  vout: number;
  valueSats: number;
  feeSats?: number;
  destinationAddress?: string;
}) {
  const participant = participantById(state, participantId);
  const payoutAddress = destinationAddress || participant.payoutAddress;
  const sweepValue = valueSats - feeSats;
  if (sweepValue <= 0) {
    throw new Error(`final sweep value ${sweepValue} sats is not positive after fee`);
  }

  const psbt = new bitcoin.Psbt({ network: bitcoin.networks.testnet });
  psbt.addInput({
    hash: txid,
    index: vout,
    witnessUtxo: {
      script: bitcoin.address.toOutputScript(participant.payoutAddress, bitcoin.networks.testnet),
      value: BigInt(valueSats),
    },
    tapInternalKey: Buffer.from(participant.payout.xonlyPubKeyHex, 'hex'),
  });
  psbt.addOutput({ address: payoutAddress, value: BigInt(sweepValue) });

  return {
    participantId,
    psbtBase64: psbt.toBase64(),
    psbtHex: psbt.toHex(),
    txTemplate: {
      input: {
        txid,
        vout,
        valueSats,
        scriptPubKeyHex: Buffer.from(
          bitcoin.address.toOutputScript(participant.payoutAddress, bitcoin.networks.testnet),
        ).toString('hex'),
      },
      keyPath: {
        type: 'single-participant-final-sweep',
        signerId: participant.id,
        signerXonlyPubkey: participant.payout.xonlyPubKeyHex,
        sigbashInvolved: false,
      },
      outputs: [
        {
          index: 0,
          address: payoutAddress,
          valueSats: sweepValue,
        },
      ],
      feeSats,
    },
  };
}

export function signFinalSweepPsbt({
  state,
  participantId,
  psbtBase64,
}: {
  state: VaultState;
  participantId: string;
  psbtBase64: string;
}): SignedTransaction & { participantId: string } {
  const participant = participantById(state, participantId);
  const psbt = bitcoin.Psbt.fromBase64(psbtBase64, { network: bitcoin.networks.testnet });
  const signer = taprootKeyPathSigner(participant.payout.privateKeyHex);
  psbt.signInput(0, signer);
  const signaturesValid = psbt.validateSignaturesOfInput(0, (pubkey, hash, signature) =>
    ecc.verifySchnorr(hash, pubkey, signature),
  );
  if (!signaturesValid) throw new Error('final sweep signature validation failed');
  psbt.finalizeInput(0);
  const transaction = psbt.extractTransaction();
  return {
    participantId,
    signedPsbtBase64: psbt.toBase64(),
    signedPsbtHex: psbt.toHex(),
    transactionHex: transaction.toHex(),
    txid: transaction.getId(),
  };
}

export function signRecoveryPsbt({
  state,
  currentIds,
  vanishedId,
  psbtBase64,
  signerIds = currentIds.filter((id) => id !== vanishedId),
}: {
  state: VaultState;
  currentIds: string[];
  vanishedId: string;
  psbtBase64: string;
  signerIds?: string[];
}): SignedTransaction & {
  round: string;
  vanishedId: string;
  signerIds: string[];
  threshold: number;
} {
  const round = roundId(currentIds);
  const vault = requireVault(state, currentIds);
  const leaf = recoveryLeafOf(vault);
  if (signerIds.includes(vanishedId)) {
    throw new Error(`vanished participant ${vanishedId} cannot sign recovery`);
  }
  if (signerIds.length < leaf.threshold) {
    throw new Error(`recovery requires ${leaf.threshold} signer(s), got ${signerIds.length}`);
  }

  const psbt = bitcoin.Psbt.fromBase64(psbtBase64, { network: bitcoin.networks.testnet });
  const input = psbt.data.inputs[0];
  const psbtLeaf = input?.tapLeafScript?.find(
    (item) => Buffer.from(item.script).toString('hex') === leaf.scriptHex,
  );
  if (!psbtLeaf) throw new Error(`PSBT does not contain recovery leaf for ${round}`);
  const rawTx = unsignedTx(psbt);
  const inputSequence = rawTx.ins[0]!.sequence;
  if (inputSequence < RECOVERY_DELAY_BLOCKS) {
    throw new Error(`recovery PSBT sequence is below ${RECOVERY_DELAY_BLOCKS}`);
  }
  if (inputSequence >= 0x80000000) {
    throw new Error('recovery PSBT sequence disables BIP68 CSV');
  }
  if (rawTx.version < 2) {
    throw new Error('recovery PSBT version must be at least 2 for BIP68 CSV');
  }

  const signers = signerIds.map((id) => {
    const participant = participantById(state, id);
    if (!leaf.recoveryXonlyPubkeys.includes(participant.personal.xonlyPubKeyHex)) {
      throw new Error(`${id} is not a recovery signer for ${round}`);
    }
    return participant;
  });
  for (const participant of signers) {
    psbt.signTaprootInput(0, taprootScriptSigner(participant.personal));
  }
  const signaturesValid = psbt.validateSignaturesOfInput(0, (pubkey, hash, signature) =>
    ecc.verifySchnorr(hash, pubkey, signature),
  );
  if (!signaturesValid) throw new Error('recovery signature validation failed');
  const tapScriptSig = psbt.data.inputs[0]?.tapScriptSig || [];
  const signatureByPubkey = new Map(
    tapScriptSig.map((item) => [Buffer.from(item.pubkey).toString('hex'), Buffer.from(item.signature)]),
  );
  const availableCount = leaf.recoveryXonlyPubkeys.filter((pubkey) =>
    signatureByPubkey.has(pubkey),
  ).length;
  if (availableCount < leaf.threshold) {
    throw new Error(`recovery has ${availableCount} signature(s), threshold is ${leaf.threshold}`);
  }

  // multi_a semantics: OP_NUMEQUAL requires *exactly* `threshold` valid
  // signatures, missing signers get an empty stack element, and the first
  // script key's signature must be on top of the initial stack (i.e. last
  // in reverse key order). bitcoinjs' default tapscript finalizer does not
  // build this witness shape, so it is constructed explicitly.
  let remainingSlots = leaf.threshold;
  const signaturesInKeyOrder = leaf.recoveryXonlyPubkeys.map((pubkey) => {
    const signature = signatureByPubkey.get(pubkey);
    if (signature && remainingSlots > 0) {
      remainingSlots -= 1;
      return signature;
    }
    return Buffer.alloc(0);
  });
  const witnessStack = [
    ...[...signaturesInKeyOrder].reverse(),
    Buffer.from(leaf.scriptHex, 'hex'),
    Buffer.from(leaf.controlBlockHex, 'hex'),
  ];
  psbt.finalizeInput(0, () => ({
    finalScriptSig: undefined,
    finalScriptWitness: witnessStackToScriptWitness(witnessStack),
  }));
  const transaction = psbt.extractTransaction();
  return {
    round,
    vanishedId,
    signerIds: signers.map((participant) => participant.id),
    threshold: leaf.threshold,
    signedPsbtBase64: psbt.toBase64(),
    signedPsbtHex: psbt.toHex(),
    transactionHex: transaction.toHex(),
    txid: transaction.getId(),
  };
}

export function inspectPsbt(psbtBase64: string): PsbtInspection {
  const psbt = bitcoin.Psbt.fromBase64(psbtBase64, { network: bitcoin.networks.testnet });
  const tx = unsignedTx(psbt);
  return {
    version: tx.version,
    inputCount: tx.ins.length,
    outputCount: tx.outs.length,
    inputs: tx.ins.map((input, index) => {
      const psbtInput = psbt.data.inputs[index];
      return {
        index,
        txid: Buffer.from(input.hash).reverse().toString('hex'),
        vout: input.index,
        sequence: input.sequence,
        witnessUtxo: psbtInput?.witnessUtxo
          ? {
              valueSats: Number(psbtInput.witnessUtxo.value),
              scriptPubKeyHex: Buffer.from(psbtInput.witnessUtxo.script).toString('hex'),
            }
          : undefined,
        tapInternalKey: psbtInput?.tapInternalKey
          ? Buffer.from(psbtInput.tapInternalKey).toString('hex')
          : undefined,
        tapLeafScript: psbtInput?.tapLeafScript?.map((leaf) => ({
          leafVersion: leaf.leafVersion,
          scriptHex: Buffer.from(leaf.script).toString('hex'),
          controlBlockHex: Buffer.from(leaf.controlBlock).toString('hex'),
        })),
        tapBip32Derivation: psbtInput?.tapBip32Derivation?.map((derivation) => ({
          masterFingerprintHex: Buffer.from(derivation.masterFingerprint).toString('hex'),
          pubkeyHex: Buffer.from(derivation.pubkey).toString('hex'),
          path: derivation.path,
          leafHashesHex: derivation.leafHashes.map((hash) => Buffer.from(hash).toString('hex')),
        })),
      };
    }),
    outputs: tx.outs.map((output, index) => ({
      index,
      valueSats: Number(output.value),
      scriptPubKeyHex: Buffer.from(output.script).toString('hex'),
      address: bitcoin.address.fromOutputScript(output.script, bitcoin.networks.testnet),
    })),
  };
}

function requireVault(state: VaultState, currentIds: string[]): VaultRound {
  const vault = state.vaults.get(roundId(currentIds));
  if (!vault) throw new Error(`unknown vault round ${roundId(currentIds)}`);
  return vault;
}

function recoveryLeafOf(vault: VaultRound) {
  const leaf = vault.tapscriptLeaves.find((item) => item.type === 'timelocked-recovery');
  if (leaf?.type !== 'timelocked-recovery') {
    throw new Error(`no recovery leaf for ${vault.id}`);
  }
  return leaf;
}

function outputValue(policy: SoloPolicy, index: number, operator: 'EQ' | 'GTE'): number {
  const condition = policy.conditions.find(
    (item) =>
      item.type === 'OUTPUT_VALUE' &&
      item.selector.index === index &&
      item.operator === operator,
  );
  if (condition?.type !== 'OUTPUT_VALUE') {
    throw new Error(`policy ${policy.id} has no OUTPUT_VALUE ${operator} for output ${index}`);
  }
  return condition.value;
}

function outputAddress(policy: SoloPolicy, index: number): string {
  const condition = policy.conditions.find(
    (item) => item.type === 'OUTPUT_DEST_IS_IN_SETS' && item.selector.index === index,
  );
  if (condition?.type !== 'OUTPUT_DEST_IS_IN_SETS' || !condition.addresses[0]) {
    throw new Error(`policy ${policy.id} pins no address for output ${index}`);
  }
  return condition.addresses[0];
}

function taprootKeySpendHash(psbt: bitcoin.Psbt, inputIndex: number): Buffer {
  const tx = unsignedTx(psbt);
  const signingScripts = psbt.data.inputs.map((input) => {
    if (!input.witnessUtxo) throw new Error('all inputs need witnessUtxo for the key-spend sighash');
    return Buffer.from(input.witnessUtxo.script);
  });
  const values = psbt.data.inputs.map((input) => input.witnessUtxo!.value);
  return Buffer.from(
    tx.hashForWitnessV1(inputIndex, signingScripts, values, bitcoin.Transaction.SIGHASH_DEFAULT),
  );
}

// Demo-only cooperative signer. All current participants' personal keys are
// available locally, so the BIP-327 aggregate secret is reconstructed, taproot
// tweaked with the vault's merkle root, and the signature is produced by the
// library's BIP-340 signer. The resulting signature is exactly what a real
// interactive MuSig2 session between the participants would produce for the
// same standard KeyAgg aggregate — but a production wallet must run the real
// two-round MuSig2 protocol so no single machine ever holds all the keys.
function cooperativeSignature({
  participants,
  keyPath,
  tapMerkleRoot,
  message,
}: {
  participants: Keypair[];
  keyPath: VaultKeyPath;
  tapMerkleRoot: Hex;
  message: Buffer;
}): Buffer {
  const privateKeysByPubkeyHex = Object.fromEntries(
    participants.map((keypair) => [keypair.publicKeyHex, keypair.privateKeyHex]),
  );
  const internalSecret = keyAggSecret(keyPath.aggregation, privateKeysByPubkeyHex);
  const tweak = Buffer.from(
    taggedHashHex(
      'TapTweak',
      Buffer.concat([
        Buffer.from(keyPath.aggregateXonlyPubkey, 'hex'),
        Buffer.from(tapMerkleRoot, 'hex'),
      ]),
    ),
    'hex',
  );
  const outputSecret = ecc.privateAdd(internalSecret, tweak);
  if (!outputSecret) throw new Error('failed to tweak cooperative aggregate secret');
  const output = ecc.xOnlyPointAddTweak(
    Buffer.from(keyPath.aggregateXonlyPubkey, 'hex'),
    tweak,
  );
  if (!output) throw new Error('failed to derive cooperative Taproot output key');
  const signature = Buffer.from(ecc.signSchnorr(message, Buffer.from(outputSecret)));
  if (!ecc.verifySchnorr(message, Buffer.from(output.xOnlyPubkey), signature)) {
    throw new Error('local cooperative aggregate signature failed self-check');
  }
  return signature;
}

function witnessStackToScriptWitness(stack: Buffer[]): Buffer {
  const parts: Buffer[] = [Buffer.from([stack.length])];
  for (const item of stack) {
    if (item.length > 0xfc) throw new Error('witness item too large for compact size 1');
    parts.push(Buffer.from([item.length]), item);
  }
  return Buffer.concat(parts);
}

function taprootKeyPathSigner(privateKeyHex: Hex): bitcoin.Signer {
  const privateKey = Buffer.from(privateKeyHex, 'hex');
  const internalPoint = Buffer.from(ecc.pointFromScalar(privateKey, true)!);
  const internalXonly = internalPoint.subarray(1);
  const tweak = Buffer.from(taggedHashHex('TapTweak', internalXonly), 'hex');
  const evenPrivateKey = internalPoint[0] === 0x03 ? ecc.privateNegate(privateKey) : privateKey;
  if (!evenPrivateKey) throw new Error('failed to normalize Taproot private key parity');
  const tweakedPrivateKey = ecc.privateAdd(Buffer.from(evenPrivateKey), tweak);
  if (!tweakedPrivateKey) throw new Error('failed to tweak Taproot private key');
  const tweakedPoint = ecc.xOnlyPointAddTweak(internalXonly, tweak);
  if (!tweakedPoint) throw new Error('failed to derive Taproot output key');
  return schnorrOnlySigner(Buffer.from(tweakedPoint.xOnlyPubkey), Buffer.from(tweakedPrivateKey));
}

function taprootScriptSigner(keypair: { xonlyPubKeyHex: Hex; privateKeyHex: Hex }): bitcoin.Signer {
  return schnorrOnlySigner(
    Buffer.from(keypair.xonlyPubKeyHex, 'hex'),
    Buffer.from(keypair.privateKeyHex, 'hex'),
  );
}
