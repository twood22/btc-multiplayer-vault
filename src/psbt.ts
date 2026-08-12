import { Buffer } from 'buffer';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { BITCOIN_NETWORK } from './network.js';
import { verifyVaultTransaction, type ConsensusVerification } from './consensus.js';
import { keyAggSecret, taggedHashHex, tapLeafHash, xpubMasterFingerprint } from './crypto.js';
import { participantById, policyId, roundId, sigbashRoundKey } from './vault.js';
import type {
  Hex,
  Keypair,
  PolicyTx,
  Prevout,
  PsbtInspection,
  SoloPolicy,
  VaultKeyPath,
  VaultRound,
  VaultState,
} from './types.js';

bitcoin.initEccLib(ecc);

// bitcoinjs' Psbt keeps the unsigned transaction in a private cache; the
// inspect/sighash/authorization helpers need it. Confined to this single
// accessor, which custody.ts and ceremony.ts reuse rather than re-casting.
export function unsignedTx(psbt: bitcoin.Psbt): bitcoin.Transaction {
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
  const psbt = new bitcoin.Psbt({ network: BITCOIN_NETWORK });
  const normalizedInputs = participantIds.map((participantId, index) => {
    const input = byParticipant.get(participantId)!;
    const valueSats = Number(input.valueSats);
    if (valueSats < state.economics.depositSatsPerParticipant) {
      throw new Error(`${participantId} input is below the committed participant deposit`);
    }
    const participantFee = feeShare + (index === 0 ? feeRemainder : 0);
    const changeSats = valueSats - state.economics.depositSatsPerParticipant - participantFee;
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
    value: BigInt(state.economics.depositSatsPerParticipant * participantIds.length),
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
          valueSats: state.economics.depositSatsPerParticipant * participantIds.length,
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
  const psbt = new bitcoin.Psbt({ network: BITCOIN_NETWORK });
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
  const fee = currentIds.length === 3
    ? state.economics.soloWithdrawalFeeSats
    : state.economics.soloWithdrawalFeeSats * 2;
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
  const psbt = new bitcoin.Psbt({ network: BITCOIN_NETWORK });
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

  const psbt = bitcoin.Psbt.fromBase64(psbtBase64, { network: BITCOIN_NETWORK });
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

export interface SoloSigningAuthorization {
  round: string;
  leaverId: string;
  finalTxid: string | null;
  txHexVerified: boolean;
  signedPsbtVerified: boolean;
  signedPsbtFinalized: boolean;
  partialSignatureCount: number;
  consensus: ConsensusVerification | null;
  checks: string[];
}

/**
 * Trust boundary for artifacts returned by a remote signing service. The
 * returned txHex/signedPSBT are treated as hostile: nothing is authorized for
 * broadcast unless it is exactly the transaction we asked the signer to sign
 * (version, locktime, every outpoint/sequence/scriptSig, every output value
 * and script), spends the exact vault witnessUtxo, and commits only to the
 * leaver's policy-spend leaf. Key-path signatures, identification-leaf
 * signatures or witnesses, and any transaction mutation are rejected. Final
 * transactions must additionally pass full consensus verification against the
 * original vault prevout.
 */
export function authorizeSoloSigningArtifacts(
  state: VaultState,
  currentIds: string[],
  leaverId: string,
  originalPsbtBase64: string,
  artifacts: { txHex?: string | null; signedPsbtBase64?: string | null },
): SoloSigningAuthorization {
  const round = roundId(currentIds);
  const vault = requireVault(state, currentIds);
  const { policyLeaf, identificationLeaf } = soloLeavesOf(vault, leaverId);
  const policyLeafKeyHex = singleKeyLeafKeyHex(policyLeaf.scriptHex, `${leaverId} ${round} policy-spend leaf`);
  const identificationKeyHex = singleKeyLeafKeyHex(
    identificationLeaf.scriptHex,
    `${leaverId} ${round} identification leaf`,
  );
  const policyLeafHash = tapLeafHash(Buffer.from(policyLeaf.scriptHex, 'hex'));
  const policyLeafHashHex = policyLeafHash.toString('hex');
  const identificationLeafHashHex = tapLeafHash(
    Buffer.from(identificationLeaf.scriptHex, 'hex'),
  ).toString('hex');

  const txHex = artifacts.txHex || null;
  const signedPsbtBase64 = artifacts.signedPsbtBase64 || null;
  if (!txHex && !signedPsbtBase64) {
    throw new Error('signer returned no artifacts to authorize');
  }

  const originalPsbt = bitcoin.Psbt.fromBase64(originalPsbtBase64, { network: BITCOIN_NETWORK });
  const originalTx = unsignedTx(originalPsbt);
  if (originalTx.ins.length !== 1) {
    throw new Error(`solo withdrawal PSBT must have exactly 1 input, got ${originalTx.ins.length}`);
  }
  const originalWitnessUtxo = originalPsbt.data.inputs[0]?.witnessUtxo;
  if (!originalWitnessUtxo) throw new Error('original solo PSBT is missing witnessUtxo');
  if (Buffer.from(originalWitnessUtxo.script).toString('hex') !== vault.outputScriptHex) {
    throw new Error(`original solo PSBT witnessUtxo is not the ${round} vault script`);
  }
  const vaultValue = BigInt(originalWitnessUtxo.value);
  const prevout: Prevout = { scriptPubKeyHex: vault.outputScriptHex, valueSats: Number(vaultValue) };

  const checks: string[] = [];
  const finalTxids: string[] = [];
  let consensus: ConsensusVerification | null = null;
  let signedPsbtFinalized = false;
  let partialSignatureCount = 0;

  if (signedPsbtBase64) {
    const signedPsbt = bitcoin.Psbt.fromBase64(signedPsbtBase64, { network: BITCOIN_NETWORK });
    assertSameUnsignedTransaction('signed PSBT', originalTx, unsignedTx(signedPsbt));
    const input = signedPsbt.data.inputs[0];
    if (!input?.witnessUtxo) throw new Error('signed PSBT dropped the vault witnessUtxo');
    if (Buffer.from(input.witnessUtxo.script).toString('hex') !== vault.outputScriptHex) {
      throw new Error(`signed PSBT witnessUtxo is not the ${round} vault script`);
    }
    if (BigInt(input.witnessUtxo.value) !== vaultValue) {
      throw new Error('signed PSBT witnessUtxo value differs from the original vault value');
    }
    for (const psbtInput of signedPsbt.data.inputs) {
      if (psbtInput.tapKeySig) {
        throw new Error('signed PSBT carries a tapKeySig; solo signing never authorizes a key-path spend');
      }
    }
    for (const entry of input.tapScriptSig ?? []) {
      const pubkeyHex = Buffer.from(entry.pubkey).toString('hex');
      const leafHashHex = Buffer.from(entry.leafHash).toString('hex');
      if (leafHashHex === identificationLeafHashHex || pubkeyHex === identificationKeyHex) {
        throw new Error('signed PSBT carries a tapScriptSig for the identification leaf');
      }
      if (leafHashHex !== policyLeafHashHex || pubkeyHex !== policyLeafKeyHex) {
        throw new Error('signed PSBT tapScriptSig is not bound to the leaver policy-spend leaf and key');
      }
      const { signature, hashType } = strictPolicySignature(
        Buffer.from(entry.signature),
        'signed PSBT tapScriptSig',
      );
      const sighash = originalTx.hashForWitnessV1(
        0,
        [Buffer.from(originalWitnessUtxo.script)],
        [vaultValue],
        hashType,
        policyLeafHash,
      );
      if (!ecc.verifySchnorr(sighash, Buffer.from(entry.pubkey), signature)) {
        throw new Error('signed PSBT tapScriptSig Schnorr signature is invalid for the policy-spend leaf');
      }
      partialSignatureCount += 1;
    }
    signedPsbtFinalized = Boolean(input.finalScriptWitness);
    if (signedPsbtFinalized) {
      const finalTx = signedPsbt.extractTransaction();
      assertSameUnsignedTransaction('finalized PSBT transaction', originalTx, finalTx);
      assertPolicyLeafWitness('finalized PSBT', finalTx, policyLeaf, identificationLeaf);
      consensus = verifyVaultTransaction({ txHex: finalTx.toHex(), prevouts: [prevout] });
      finalTxids.push(finalTx.getId());
      checks.push('finalized signed PSBT spends the exact policy-spend leaf and passes consensus verification');
    } else {
      if (partialSignatureCount !== 1) {
        throw new Error(
          `unfinalized signed PSBT must carry exactly 1 policy-leaf signature, got ${partialSignatureCount}`,
        );
      }
      checks.push('signed PSBT carries exactly one valid policy-leaf partial signature over the unmodified transaction');
    }
  }

  if (txHex) {
    const finalTx = bitcoin.Transaction.fromHex(txHex);
    assertSameUnsignedTransaction('final transaction', originalTx, finalTx);
    assertPolicyLeafWitness('final transaction', finalTx, policyLeaf, identificationLeaf);
    consensus = verifyVaultTransaction({ txHex, prevouts: [prevout] });
    finalTxids.push(finalTx.getId());
    checks.push('final transaction hex spends the exact policy-spend leaf and passes consensus verification');
  }

  if (finalTxids.length === 2 && finalTxids[0] !== finalTxids[1]) {
    throw new Error(
      `signer artifacts disagree: finalized PSBT txid ${finalTxids[0]} vs final transaction txid ${finalTxids[1]}`,
    );
  }
  checks.push('unsigned transaction, witnessUtxo, and leaf bindings match the locally built solo PSBT exactly');

  return {
    round,
    leaverId,
    finalTxid: finalTxids[0] ?? null,
    txHexVerified: Boolean(txHex),
    signedPsbtVerified: Boolean(signedPsbtBase64),
    signedPsbtFinalized,
    partialSignatureCount,
    consensus,
    checks,
  };
}

/**
 * Deterministic hostile-artifact fixtures for authorizeSoloSigningArtifacts
 * regressions: an output-value mutation, a final witness swapped onto the
 * identification leaf, and a PSBT whose tapScriptSig targets the
 * identification leaf. Offline only — no network, no secrets.
 */
export function buildSoloAuthorizationTamperFixtures({
  state,
  currentIds,
  leaverId,
  transactionHex,
  psbtBase64,
}: {
  state: VaultState;
  currentIds: string[];
  leaverId: string;
  transactionHex: string;
  psbtBase64: string;
}): {
  outputMutationTxHex: string;
  identificationWitnessTxHex: string;
  identificationTapScriptSigPsbtBase64: string;
} {
  const vault = requireVault(state, currentIds);
  const { identificationLeaf } = soloLeavesOf(vault, leaverId);

  const mutatedOutput = bitcoin.Transaction.fromHex(transactionHex);
  mutatedOutput.outs[0]!.value += 1n;

  const identificationWitness = bitcoin.Transaction.fromHex(transactionHex);
  const witness = identificationWitness.ins[0]!.witness;
  witness[witness.length - 2] = Buffer.from(identificationLeaf.scriptHex, 'hex');
  witness[witness.length - 1] = Buffer.from(identificationLeaf.controlBlockHex, 'hex');

  const psbt = bitcoin.Psbt.fromBase64(psbtBase64, { network: BITCOIN_NETWORK });
  psbt.updateInput(0, {
    tapScriptSig: [
      {
        pubkey: Buffer.from(
          singleKeyLeafKeyHex(identificationLeaf.scriptHex, `${leaverId} identification leaf`),
          'hex',
        ),
        leafHash: tapLeafHash(Buffer.from(identificationLeaf.scriptHex, 'hex')),
        signature: Buffer.alloc(64),
      },
    ],
  });

  return {
    outputMutationTxHex: mutatedOutput.toHex(),
    identificationWitnessTxHex: identificationWitness.toHex(),
    identificationTapScriptSigPsbtBase64: psbt.toBase64(),
  };
}

export function buildCooperativeExitPsbt({
  state,
  currentIds,
  txid,
  vout,
  valueSats,
  feeSats,
}: {
  state: VaultState;
  currentIds: string[];
  txid: string;
  vout: number;
  valueSats: number;
  feeSats?: number;
}) {
  const configuredFeeSats = feeSats ?? state.economics.cooperativeFeeSats;
  const round = roundId(currentIds);
  const vault = requireVault(state, currentIds);
  const current = currentIds.map((id) => participantById(state, id));
  // The pot is split equally after a small miner fee (a zero-fee transaction
  // is consensus-valid but will not relay). For the round-one vault this is
  // each participant's full 1 BTC deposit minus ~300 sats; for a pair round it
  // also returns the departed player's haircut instead of burning it to fees.
  const refundSats = Math.floor((valueSats - configuredFeeSats) / current.length);
  if (refundSats <= 0) throw new Error('cooperative refund is not positive after fee');

  const psbt = new bitcoin.Psbt({ network: BITCOIN_NETWORK });
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

  const psbt = bitcoin.Psbt.fromBase64(psbtBase64, { network: BITCOIN_NETWORK });
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
  const recoverEach = Math.floor((valueSats - state.economics.recoveryFeeSats) / recipients.length);
  const outputTotal = recoverEach * recipients.length;
  if (outputTotal > valueSats) {
    throw new Error(`recovery outputs ${outputTotal} sats exceed input ${valueSats} sats`);
  }

  const psbt = new bitcoin.Psbt({ network: BITCOIN_NETWORK });
  psbt.setVersion(2);
  psbt.addInput({
    hash: txid,
    index: vout,
    sequence: state.economics.recoveryDelayBlocks,
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
        sequence: state.economics.recoveryDelayBlocks,
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
  feeSats,
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
  const configuredFeeSats = feeSats ?? state.economics.finalSweepFeeSats;
  const participant = participantById(state, participantId);
  const payoutAddress = destinationAddress || participant.payoutAddress;
  const sweepValue = valueSats - configuredFeeSats;
  if (sweepValue <= 0) {
    throw new Error(`final sweep value ${sweepValue} sats is not positive after fee`);
  }

  const psbt = new bitcoin.Psbt({ network: BITCOIN_NETWORK });
  psbt.addInput({
    hash: txid,
    index: vout,
    witnessUtxo: {
      script: bitcoin.address.toOutputScript(participant.payoutAddress, BITCOIN_NETWORK),
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
          bitcoin.address.toOutputScript(participant.payoutAddress, BITCOIN_NETWORK),
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
      feeSats: configuredFeeSats,
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
  const psbt = bitcoin.Psbt.fromBase64(psbtBase64, { network: BITCOIN_NETWORK });
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

  const psbt = bitcoin.Psbt.fromBase64(psbtBase64, { network: BITCOIN_NETWORK });
  const input = psbt.data.inputs[0];
  const psbtLeaf = input?.tapLeafScript?.find(
    (item) => Buffer.from(item.script).toString('hex') === leaf.scriptHex,
  );
  if (!psbtLeaf) throw new Error(`PSBT does not contain recovery leaf for ${round}`);
  const rawTx = unsignedTx(psbt);
  const inputSequence = rawTx.ins[0]!.sequence;
  if (inputSequence < state.economics.recoveryDelayBlocks) {
    throw new Error(`recovery PSBT sequence is below ${state.economics.recoveryDelayBlocks}`);
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
  const psbt = bitcoin.Psbt.fromBase64(psbtBase64, { network: BITCOIN_NETWORK });
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
      address: bitcoin.address.fromOutputScript(output.script, BITCOIN_NETWORK),
    })),
  };
}

/** Transaction id of the exact unsigned transaction committed by a PSBT. */
export function psbtUnsignedTxid(psbtBase64: string): string {
  const psbt = bitcoin.Psbt.fromBase64(psbtBase64, { network: BITCOIN_NETWORK });
  return unsignedTx(psbt).getId();
}

/** Convert a parsed PSBT into the exact local Sigbash policy view. */
export function psbtInspectionToPolicyTx({
  state,
  inspection,
}: {
  state: VaultState;
  inspection: PsbtInspection;
}): PolicyTx {
  let sigbashLeafKey: string | undefined;
  for (const item of inspection.inputs[0]?.tapLeafScript ?? []) {
    for (const vault of state.vaults.values()) {
      const leaf = vault.tapscriptLeaves.find((candidate) => candidate.scriptHex === item.scriptHex);
      if (leaf?.type === 'solo-withdrawal') {
        sigbashLeafKey = leaf.sigbashXonlyPubkey;
        break;
      }
    }
    if (sigbashLeafKey) break;
  }
  return {
    sigbashLeafKey,
    inputCount: inspection.inputCount,
    outputs: inspection.outputs.map((output) => ({
      address: output.address,
      value: output.valueSats,
    })),
  };
}

function requireVault(state: VaultState, currentIds: string[]): VaultRound {
  const vault = state.vaults.get(roundId(currentIds));
  if (!vault) throw new Error(`unknown vault round ${roundId(currentIds)}`);
  return vault;
}

function singleKeyLeafKeyHex(scriptHex: Hex, label: string): Hex {
  if (!/^20[0-9a-f]{64}ac$/.test(scriptHex)) {
    throw new Error(`${label} script is not pk(<xonly key>)`);
  }
  return scriptHex.slice(2, 66);
}

// The vault only ever produces SIGHASH_DEFAULT signatures; SIGHASH_ALL is the
// only other type that still commits to every input and output. Anything else
// (NONE/SINGLE/ANYONECANPAY) would let a hostile signer produce a signature
// replayable against a different spend of the vault UTXO.
function strictPolicySignature(item: Buffer, label: string): { signature: Buffer; hashType: number } {
  if (item.length === 64) {
    return { signature: item, hashType: bitcoin.Transaction.SIGHASH_DEFAULT };
  }
  if (item.length === 65 && item[64] === bitcoin.Transaction.SIGHASH_ALL) {
    return { signature: item.subarray(0, 64), hashType: bitcoin.Transaction.SIGHASH_ALL };
  }
  throw new Error(`${label} must be a 64-byte SIGHASH_DEFAULT or 65-byte SIGHASH_ALL signature`);
}

function assertSameUnsignedTransaction(
  label: string,
  original: bitcoin.Transaction,
  candidate: bitcoin.Transaction,
): void {
  if (candidate.version !== original.version) throw new Error(`${label} changed the transaction version`);
  if (candidate.locktime !== original.locktime) throw new Error(`${label} changed the transaction locktime`);
  if (candidate.ins.length !== original.ins.length) throw new Error(`${label} changed the input count`);
  original.ins.forEach((input, index) => {
    const other = candidate.ins[index]!;
    if (!Buffer.from(other.hash).equals(Buffer.from(input.hash)) || other.index !== input.index) {
      throw new Error(`${label} changed input ${index}'s outpoint`);
    }
    if (other.sequence !== input.sequence) throw new Error(`${label} changed input ${index}'s sequence`);
    if (!Buffer.from(other.script).equals(Buffer.from(input.script))) {
      throw new Error(`${label} changed input ${index}'s scriptSig`);
    }
  });
  if (candidate.outs.length !== original.outs.length) throw new Error(`${label} changed the output count`);
  original.outs.forEach((output, index) => {
    const other = candidate.outs[index]!;
    if (BigInt(other.value) !== BigInt(output.value)) {
      throw new Error(`${label} changed output ${index}'s value`);
    }
    if (!Buffer.from(other.script).equals(Buffer.from(output.script))) {
      throw new Error(`${label} changed output ${index}'s script`);
    }
  });
}

function assertPolicyLeafWitness(
  label: string,
  tx: bitcoin.Transaction,
  policyLeaf: { scriptHex: Hex; controlBlockHex: Hex },
  identificationLeaf: { scriptHex: Hex; controlBlockHex: Hex },
): void {
  const witness = (tx.ins[0]?.witness ?? []).map((item) => Buffer.from(item));
  if (witness.length !== 3) {
    throw new Error(`${label} witness must be [signature, script, control block], got ${witness.length} element(s)`);
  }
  const scriptHex = witness[1]!.toString('hex');
  const controlBlockHex = witness[2]!.toString('hex');
  if (scriptHex === identificationLeaf.scriptHex || controlBlockHex === identificationLeaf.controlBlockHex) {
    throw new Error(`${label} witness spends the identification leaf`);
  }
  if (scriptHex !== policyLeaf.scriptHex) {
    throw new Error(`${label} witness script is not the exact policy-spend leaf script`);
  }
  if (controlBlockHex !== policyLeaf.controlBlockHex) {
    throw new Error(`${label} witness control block is not the exact policy-spend control block`);
  }
  strictPolicySignature(witness[0]!, `${label} witness signature`);
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

export function witnessStackToScriptWitness(stack: Buffer[]): Buffer {
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
