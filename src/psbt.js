import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { AMOUNTS, RECOVERY_DELAY_BLOCKS } from './config.js';
import { taggedHashHex } from './crypto.js';
import { policyId, roundId } from './vault.js';

bitcoin.initEccLib(ecc);

const SECP_ORDER = BigInt(
  '0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141',
);

export function buildFundingPsbt({ state, inputs, feeSats = 0 }) {
  const participantIds = state.participants.map((participant) => participant.id);
  const roundOneVault = state.vaults.get(roundId(participantIds));
  const byParticipant = new Map(inputs.map((input) => [input.participantId, input]));
  const missing = participantIds.filter((participantId) => !byParticipant.has(participantId));
  if (missing.length > 0) {
    throw new Error(`funding PSBT missing input for ${missing.join(', ')}`);
  }
  const feeShare = Math.floor(feeSats / participantIds.length);
  const feeRemainder = feeSats - feeShare * participantIds.length;
  const psbt = new bitcoin.Psbt({ network: bitcoin.networks.testnet });
  const normalizedInputs = participantIds.map((participantId, index) => {
    const input = byParticipant.get(participantId);
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

export function buildSoloWithdrawalPsbt({ state, currentIds, leaverId, txid, vout, valueSats }) {
  const context = soloWithdrawalContext({ state, currentIds, leaverId, txid, vout, valueSats });
  return buildSoloWithdrawalPsbtFromOutputs(context);
}

export function buildSoloWithdrawalTamperPsbts({ state, currentIds, leaverId, txid, vout, valueSats }) {
  const context = soloWithdrawalContext({ state, currentIds, leaverId, txid, vout, valueSats });
  const valid = buildSoloWithdrawalPsbtFromOutputs(context);
  const otherParticipant = state.participants.find((participant) => participant.id !== leaverId);
  if (!otherParticipant) throw new Error(`could not find wrong-address participant for ${leaverId}`);

  const wrongAmountOutputs = structuredClone(context.outputs);
  wrongAmountOutputs[0].valueSats += 1;
  const wrongAddressOutputs = structuredClone(context.outputs);
  wrongAddressOutputs[0].address = otherParticipant.payoutAddress;
  const extraOutputOutputs = [
    ...structuredClone(context.outputs),
    { address: context.outputs[0].address, valueSats: 1 },
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

function soloWithdrawalContext({ state, currentIds, leaverId, txid, vout, valueSats }) {
  const round = roundId(currentIds);
  const vault = state.vaults.get(round);
  if (!vault) throw new Error(`unknown vault round ${round}`);
  const policy = state.policies.get(policyId(currentIds, leaverId));
  if (!policy) throw new Error(`unknown solo policy ${policyId(currentIds, leaverId)}`);
  const leaf = vault.tapscriptLeaves.find(
    (item) => item.type === 'solo-withdrawal' && item.participantId === leaverId,
  );
  if (!leaf) throw new Error(`no solo leaf for ${leaverId} in ${round}`);

  const payout = outputValue(policy, 0, 'EQ');
  const nextAddress = outputAddress(policy, 1);
  const fee = currentIds.length === 3 ? AMOUNTS.feePerSoloWithdrawal : AMOUNTS.feePerSoloWithdrawal * 2;
  const leftover = valueSats - payout - fee;
  const floor = outputValue(policy, 1, 'GTE');
  if (leftover < floor) {
    throw new Error(`leftover ${leftover} sats is below policy floor ${floor}`);
  }
  return {
    round,
    vault,
    leaf,
    leaverId,
    txid,
    vout,
    valueSats,
    fee,
    policy,
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
  leaverId,
  txid,
  vout,
  valueSats,
  fee,
  outputs,
  tamper = undefined,
}) {
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
    tapLeafScript: [
      {
        leafVersion: 0xc0,
        script: Buffer.from(leaf.scriptHex, 'hex'),
        controlBlock: Buffer.from(leaf.controlBlockHex, 'hex'),
      },
    ],
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

export function signSoloWithdrawalPsbt({ state, currentIds, leaverId, psbtBase64 }) {
  const round = roundId(currentIds);
  const vault = state.vaults.get(round);
  if (!vault) throw new Error(`unknown vault round ${round}`);
  const participant = state.participants.find((item) => item.id === leaverId);
  if (!participant) throw new Error(`unknown participant ${leaverId}`);
  const leaf = vault.tapscriptLeaves.find(
    (item) => item.type === 'solo-withdrawal' && item.participantId === leaverId,
  );
  if (!leaf) throw new Error(`no solo leaf for ${leaverId} in ${round}`);

  const psbt = bitcoin.Psbt.fromBase64(psbtBase64, { network: bitcoin.networks.testnet });
  const input = psbt.data.inputs[0];
  const psbtLeaf = input.tapLeafScript?.find(
    (item) => Buffer.from(item.script).toString('hex') === leaf.scriptHex,
  );
  if (!psbtLeaf) throw new Error(`PSBT does not contain ${leaverId} solo leaf for ${round}`);
  psbt.signTaprootInput(0, taprootScriptSigner(participant.sigbash));
  const signaturesValid = psbt.validateSignaturesOfInput(0, (pubkey, hash, signature) =>
    ecc.verifySchnorr(hash, pubkey, signature),
  );
  if (!signaturesValid) throw new Error('solo withdrawal signature validation failed');
  psbt.finalizeTaprootInput(0);
  const transaction = psbt.extractTransaction();
  return {
    round,
    leaverId,
    signedPsbtBase64: psbt.toBase64(),
    signedPsbtHex: psbt.toHex(),
    transactionHex: transaction.toHex(),
    txid: transaction.getId(),
    mode: 'local-deterministic-sigbash-leaf',
  };
}

export function buildCooperativeExitPsbt({ state, currentIds, txid, vout, valueSats }) {
  const round = roundId(currentIds);
  const vault = state.vaults.get(round);
  if (!vault) throw new Error(`unknown vault round ${round}`);
  const current = currentIds.map((id) => {
    const participant = state.participants.find((item) => item.id === id);
    if (!participant) throw new Error(`unknown participant ${id}`);
    return participant;
  });

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
      value: BigInt(AMOUNTS.deposit),
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
        valueSats: AMOUNTS.deposit,
      })),
      feeSats: valueSats - AMOUNTS.deposit * current.length,
    },
  };
}

export function signCooperativeExitPsbt({ state, currentIds, psbtBase64 }) {
  const round = roundId(currentIds);
  const vault = state.vaults.get(round);
  if (!vault) throw new Error(`unknown vault round ${round}`);
  const participants = currentIds.map((id) => {
    const participant = state.participants.find((item) => item.id === id);
    if (!participant) throw new Error(`unknown participant ${id}`);
    return participant;
  });
  if (vault.keyPath.sigbashXonlyPubkeys.length !== 0) {
    throw new Error('cooperative key path includes Sigbash keys');
  }

  const psbt = bitcoin.Psbt.fromBase64(psbtBase64, { network: bitcoin.networks.testnet });
  const input = psbt.data.inputs[0];
  if (Buffer.from(input.tapInternalKey || []).toString('hex') !== vault.keyPath.aggregateXonlyPubkey) {
    throw new Error(`PSBT does not use the ${round} cooperative aggregate key`);
  }
  const message = taprootKeySpendHash(psbt, 0);
  const signature = cooperativeSignature({
    participants,
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

export function buildRecoveryPsbt({ state, currentIds, vanishedId, txid, vout, valueSats }) {
  const round = roundId(currentIds);
  const vault = state.vaults.get(round);
  if (!vault) throw new Error(`unknown vault round ${round}`);
  const leaf = vault.tapscriptLeaves.find((item) => item.type === 'timelocked-recovery');
  if (!leaf) throw new Error(`no recovery leaf for ${round}`);
  const rescuers = currentIds
    .filter((id) => id !== vanishedId)
    .map((id) => {
      const participant = state.participants.find((item) => item.id === id);
      if (!participant) throw new Error(`unknown participant ${id}`);
      return participant;
    });
  if (rescuers.length < leaf.threshold) {
    throw new Error(
      `recovery requires ${leaf.threshold} signer(s), only ${rescuers.length} available after ${vanishedId} vanished`,
    );
  }
  const recipients = currentIds.map((id) => {
    const participant = state.participants.find((item) => item.id === id);
    if (!participant) throw new Error(`unknown participant ${id}`);
    return participant;
  });
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
}) {
  const participant = state.participants.find((item) => item.id === participantId);
  if (!participant) throw new Error(`unknown participant ${participantId}`);
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

export function signFinalSweepPsbt({ state, participantId, psbtBase64 }) {
  const participant = state.participants.find((item) => item.id === participantId);
  if (!participant) throw new Error(`unknown participant ${participantId}`);
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
}) {
  const round = roundId(currentIds);
  const vault = state.vaults.get(round);
  if (!vault) throw new Error(`unknown vault round ${round}`);
  const leaf = vault.tapscriptLeaves.find((item) => item.type === 'timelocked-recovery');
  if (!leaf) throw new Error(`no recovery leaf for ${round}`);
  if (signerIds.includes(vanishedId)) {
    throw new Error(`vanished participant ${vanishedId} cannot sign recovery`);
  }
  if (signerIds.length < leaf.threshold) {
    throw new Error(`recovery requires ${leaf.threshold} signer(s), got ${signerIds.length}`);
  }

  const psbt = bitcoin.Psbt.fromBase64(psbtBase64, { network: bitcoin.networks.testnet });
  const input = psbt.data.inputs[0];
  const psbtLeaf = input.tapLeafScript?.find(
    (item) => Buffer.from(item.script).toString('hex') === leaf.scriptHex,
  );
  if (!psbtLeaf) throw new Error(`PSBT does not contain recovery leaf for ${round}`);
  if (psbt.__CACHE.__TX.ins[0].sequence < RECOVERY_DELAY_BLOCKS) {
    throw new Error(`recovery PSBT sequence is below ${RECOVERY_DELAY_BLOCKS}`);
  }
  if (psbt.__CACHE.__TX.ins[0].sequence >= 0x80000000) {
    throw new Error('recovery PSBT sequence disables BIP68 CSV');
  }
  if (psbt.__CACHE.__TX.version < 2) {
    throw new Error('recovery PSBT version must be at least 2 for BIP68 CSV');
  }

  const signers = signerIds.map((id) => {
    const participant = state.participants.find((item) => item.id === id);
    if (!participant) throw new Error(`unknown participant ${id}`);
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
  const signatureCount = psbt.data.inputs[0].tapScriptSig?.length || 0;
  if (signatureCount < leaf.threshold) {
    throw new Error(`recovery has ${signatureCount} signature(s), threshold is ${leaf.threshold}`);
  }

  psbt.finalizeTaprootInput(0);
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

export function inspectPsbt(psbtBase64) {
  const psbt = bitcoin.Psbt.fromBase64(psbtBase64, { network: bitcoin.networks.testnet });
  const tx = psbt.__CACHE.__TX;
  return {
    version: tx.version,
    inputCount: tx.ins.length,
    outputCount: tx.outs.length,
    inputs: tx.ins.map((input, index) => ({
      index,
      txid: Buffer.from(input.hash).reverse().toString('hex'),
      vout: input.index,
      sequence: input.sequence,
      witnessUtxo: psbt.data.inputs[index].witnessUtxo
        ? {
            valueSats: Number(psbt.data.inputs[index].witnessUtxo.value),
            scriptPubKeyHex: Buffer.from(psbt.data.inputs[index].witnessUtxo.script).toString('hex'),
          }
        : undefined,
      tapInternalKey: psbt.data.inputs[index].tapInternalKey
        ? Buffer.from(psbt.data.inputs[index].tapInternalKey).toString('hex')
        : undefined,
      tapLeafScript: psbt.data.inputs[index].tapLeafScript?.map((leaf) => ({
        leafVersion: leaf.leafVersion,
        scriptHex: Buffer.from(leaf.script).toString('hex'),
        controlBlockHex: Buffer.from(leaf.controlBlock).toString('hex'),
      })),
    })),
    outputs: tx.outs.map((output, index) => ({
      index,
      valueSats: Number(output.value),
      scriptPubKeyHex: Buffer.from(output.script).toString('hex'),
      address: bitcoin.address.fromOutputScript(output.script, bitcoin.networks.testnet),
    })),
  };
}

function outputValue(policy, index, operator) {
  return policy.conditions.find(
    (condition) =>
      condition.type === 'OUTPUT_VALUE' &&
      condition.selector.index === index &&
      condition.operator === operator,
  ).value;
}

function outputAddress(policy, index) {
  return policy.conditions.find(
    (condition) =>
      condition.type === 'OUTPUT_DEST_IS_IN_SETS' && condition.selector.index === index,
  ).addresses[0];
}

function taprootKeySpendHash(psbt, inputIndex) {
  const tx = psbt.__CACHE.__TX;
  const signingScripts = psbt.data.inputs.map((input) => input.witnessUtxo.script);
  const values = psbt.data.inputs.map((input) => input.witnessUtxo.value);
  return Buffer.from(tx.hashForWitnessV1(inputIndex, signingScripts, values, bitcoin.Transaction.SIGHASH_DEFAULT));
}

function cooperativeSignature({ participants, keyPath, tapMerkleRoot, message }) {
  const signerState = participants.map((participant) => {
    const point = Buffer.from(ecc.pointFromScalar(Buffer.from(participant.personal.privateKeyHex, 'hex'), true));
    const evenPrivateKey =
      point[0] === 0x03
        ? Buffer.from(ecc.privateNegate(Buffer.from(participant.personal.privateKeyHex, 'hex')))
        : Buffer.from(participant.personal.privateKeyHex, 'hex');
    return {
      participant,
      evenPrivateKey,
      xonlyPubkey: point.subarray(1).toString('hex'),
      coefficient: cooperativeCoefficient(keyPath.aggregation, point.subarray(1).toString('hex')),
    };
  });

  const internalPoint = Buffer.from(`02${keyPath.aggregateXonlyPubkey}`, 'hex');
  const internalParity = Buffer.from(keyPath.aggregateCompressedPubkey, 'hex')[0] === 0x03 ? -1n : 1n;
  const tweak = scalarFromHex(taggedHashHex(
    'TapTweak',
    Buffer.concat([
      Buffer.from(keyPath.aggregateXonlyPubkey, 'hex'),
      Buffer.from(tapMerkleRoot, 'hex'),
    ]),
  ));
  const output = ecc.xOnlyPointAddTweak(Buffer.from(keyPath.aggregateXonlyPubkey, 'hex'), scalarToBuffer(tweak));
  if (!output) throw new Error('failed to derive cooperative Taproot output key');
  const outputParity = output.parity === 1 ? -1n : 1n;

  const nonces = signerState.map(({ participant }) => {
    const nonce = deterministicScalar('VaultDemo MuSig nonce', Buffer.concat([
      Buffer.from(participant.personal.privateKeyHex, 'hex'),
      message,
      Buffer.from(keyPath.aggregateXonlyPubkey, 'hex'),
    ]));
    const point = Buffer.from(ecc.pointFromScalar(scalarToBuffer(nonce), true));
    return { nonce, point };
  });
  let aggregateNonce = null;
  for (const { point } of nonces) {
    if (aggregateNonce) {
      const added = ecc.pointAdd(aggregateNonce, point, true);
      if (!added) throw new Error('failed to aggregate cooperative nonces');
      aggregateNonce = Buffer.from(added);
    } else {
      aggregateNonce = point;
    }
  }
  const nonceParity = aggregateNonce[0] === 0x03 ? -1n : 1n;
  const nonceXonly = aggregateNonce.subarray(1);
  const challenge = scalarFromHex(taggedHashHex(
    'BIP0340/challenge',
    Buffer.concat([nonceXonly, Buffer.from(output.xOnlyPubkey), message]),
  ));

  let nonceSum = 0n;
  nonces.forEach(({ nonce }) => {
    nonceSum = modN(nonceSum + nonceParity * nonce);
  });
  let secretSum = 0n;
  signerState.forEach(({ evenPrivateKey, coefficient }) => {
    secretSum = modN(secretSum + coefficient * scalarFromHex(evenPrivateKey.toString('hex')));
  });
  const effectiveSecret = modN(outputParity * modN(internalParity * secretSum + tweak));
  const s = modN(nonceSum + challenge * effectiveSecret);
  const signature = Buffer.concat([nonceXonly, scalarToBuffer(s)]);
  if (!ecc.verifySchnorr(message, Buffer.from(output.xOnlyPubkey), signature)) {
    throw new Error('local cooperative aggregate signature failed self-check');
  }
  return signature;
}

function cooperativeCoefficient(aggregation, xonlyPubkey) {
  if (aggregation.type === 'single-key') return 1n;
  if (xonlyPubkey === aggregation.secondUniqueXonlyPubkey) return 1n;
  return scalarFromHex(taggedHashHex(
    'KeyAgg coefficient',
    Buffer.concat([
      Buffer.from(aggregation.keyAggListHash, 'hex'),
      Buffer.from(xonlyPubkey, 'hex'),
    ]),
  ));
}

function deterministicScalar(tag, seed) {
  let counter = 0;
  while (true) {
    const scalar = scalarFromHex(taggedHashHex(tag, Buffer.concat([seed, scalarToBuffer(BigInt(counter))])));
    if (scalar > 0n) return scalar;
    counter += 1;
  }
}

function scalarFromHex(hex) {
  return BigInt(`0x${hex}`) % SECP_ORDER;
}

function scalarToBuffer(value) {
  return Buffer.from(modN(value).toString(16).padStart(64, '0'), 'hex');
}

function modN(value) {
  const result = value % SECP_ORDER;
  return result >= 0n ? result : result + SECP_ORDER;
}

function taprootKeyPathSigner(privateKeyHex) {
  const privateKey = Buffer.from(privateKeyHex, 'hex');
  const internalPoint = Buffer.from(ecc.pointFromScalar(privateKey, true));
  const internalXonly = internalPoint.subarray(1);
  const tweak = Buffer.from(taggedHashHex('TapTweak', internalXonly), 'hex');
  const evenPrivateKey = internalPoint[0] === 0x03 ? ecc.privateNegate(privateKey) : privateKey;
  if (!evenPrivateKey) throw new Error('failed to normalize Taproot private key parity');
  const tweakedPrivateKey = ecc.privateAdd(Buffer.from(evenPrivateKey), tweak);
  if (!tweakedPrivateKey) throw new Error('failed to tweak Taproot private key');
  const tweakedPoint = ecc.xOnlyPointAddTweak(internalXonly, tweak);
  if (!tweakedPoint) throw new Error('failed to derive Taproot output key');
  return {
    publicKey: Buffer.from(tweakedPoint.xOnlyPubkey),
    signSchnorr(hash) {
      return Buffer.from(ecc.signSchnorr(hash, Buffer.from(tweakedPrivateKey)));
    },
  };
}

function taprootScriptSigner(keypair) {
  return {
    publicKey: Buffer.from(keypair.xonlyPubKeyHex, 'hex'),
    signSchnorr(hash) {
      return Buffer.from(ecc.signSchnorr(hash, Buffer.from(keypair.privateKeyHex, 'hex')));
    },
  };
}
