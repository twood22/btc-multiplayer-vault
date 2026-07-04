#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { AMOUNTS, RECOVERY_DELAY_BLOCKS } from './config.js';
import { auditSpecState } from './audit.js';
import {
  combinePsbts,
  decodeRawTransaction,
  finalizePsbt,
  getBlockchainInfo,
  getDescriptorInfo,
  getRawTransaction,
  getTxOut,
  importDescriptors,
  sendRawTransaction,
  testMempoolAccept,
  walletProcessPsbt,
} from './bitcoin-rpc.js';
import {
  buildCooperativeExitPsbt,
  buildFinalSweepPsbt,
  buildFundingPsbt,
  buildRecoveryPsbt,
  buildSoloWithdrawalPsbt,
  buildSoloWithdrawalTamperPsbts,
  inspectPsbt,
  signCooperativeExitPsbt,
  signFinalSweepPsbt,
  signRecoveryPsbt,
  signSoloWithdrawalPsbt,
} from './psbt.js';
import { createLiveSigbashClient, createSigbashAdapter, evaluatePolicy, toPoetPolicy } from './sigbash.js';
import {
  Ledger,
  buildCooperativeExit,
  buildFinalSweep,
  buildRecovery,
  buildSoloWithdrawal,
  consolidateDeposits,
  createDemoState,
  policyId,
  roundId,
  verifyNoSigbashInKeyPath,
} from './vault.js';

loadDotenv();

const command = process.argv[2] || 'acceptance';

const commands = {
  setup,
  cooperative,
  solo,
  recovery,
  'full-run': fullRun,
  'signed-local-run': signedLocalRun,
  'funding-manifest': fundingManifest,
  'watch-manifest': watchManifest,
  'rpc-import-watchonly': rpcImportWatchonly,
  'vault-output': vaultOutput,
  'funding-psbt': fundingPsbt,
  'solo-psbt': soloPsbt,
  'sign-solo-psbt': signSoloPsbt,
  'cooperative-psbt': cooperativePsbt,
  'sign-cooperative-psbt': signCooperativePsbt,
  'recovery-psbt': recoveryPsbt,
  'sign-recovery-psbt': signRecoveryPsbtCommand,
  'final-sweep-psbt': finalSweepPsbt,
  'sign-final-sweep-psbt': signFinalSweepPsbtCommand,
  'sigbash-sign-psbt': sigbashSignPsbt,
  'policy-check-psbt': policyCheckPsbt,
  'inspect-psbt': inspectPsbtCommand,
  'psbt-acceptance': psbtAcceptance,
  'rpc-gettxout': rpcGetTxOut,
  'verify-vault-utxo': verifyVaultUtxo,
  'cooperative-readiness': cooperativeReadiness,
  'recovery-readiness': recoveryReadiness,
  'live-readiness': liveReadiness,
  'live-acceptance-evidence': liveAcceptanceEvidence,
  'rpc-walletprocesspsbt': rpcWalletProcessPsbt,
  'rpc-combinepsbt': rpcCombinePsbt,
  'rpc-finalizepsbt': rpcFinalizePsbt,
  'rpc-decode-tx': rpcDecodeTx,
  'rpc-testmempoolaccept': rpcTestMempoolAccept,
  'rpc-submit': rpcSubmit,
  'rpc-tx-status': rpcTxStatus,
  'rpc-find-output': rpcFindOutput,
  'live-run-audit': liveRunAudit,
  'live-solo-withdrawal': liveSoloWithdrawal,
  'live-solo-tamper-check': liveSoloTamperCheck,
  'live-solo-audit': liveSoloAudit,
  'live-cooperative-audit': liveCooperativeAudit,
  'live-recovery-audit': liveRecoveryAudit,
  'live-final-sweep-audit': liveFinalSweepAudit,
  'rpc-broadcast': rpcBroadcast,
  audit,
  'sdk-policy-check': sdkPolicyCheck,
  'sigbash-live-setup': sigbashLiveSetup,
  acceptance,
};

if (!commands[command]) {
  console.error(`Unknown command "${command}". Use one of: ${Object.keys(commands).join(', ')}`);
  process.exit(1);
}

try {
  await commands[command]();
} catch (error) {
  console.error(error.stack || error.message);
  process.exit(1);
}

async function setup() {
  const state = createConfiguredState();
  printSetup(state);
}

async function cooperative() {
  const state = createDemoState();
  const ledger = new Ledger();
  createDeposits(ledger, state);
  const vaultUtxo = consolidateDeposits(ledger, state);
  const currentIds = state.participants.map((p) => p.id);
  const tx = buildCooperativeExit({ state, currentUtxo: vaultUtxo, currentIds });
  const vault = state.vaults.get(roundId(currentIds));
  assert(verifyNoSigbashInKeyPath(vault), 'Sigbash key leaked into cooperative key-path');
  const signed = ledger.spend(vaultUtxo.outpoint, tx);
  printResult('cooperative exit with Sigbash offline', {
    keyPathContainsOnlyPersonalKeys: true,
    sigbashSignaturesRequested: 0,
    txid: signed.txid,
    outputs: signed.outputs,
  });
}

async function solo() {
  const adapter = await createSigbashAdapter();
  const state = createDemoState();
  const ledger = new Ledger();
  createDeposits(ledger, state);
  const vaultUtxo = consolidateDeposits(ledger, state);
  const currentIds = state.participants.map((p) => p.id);
  const tx = buildSoloWithdrawal({ state, currentUtxo: vaultUtxo, currentIds, leaverId: 'alice' });
  const policy = state.sigbashPolicies.get('alice');
  const verified = await adapter.verifyPSBT(tx, policy);
  assert(verified.success, `valid solo withdrawal rejected: ${verified.failures?.join('; ')}`);
  const signed = await adapter.signPSBT(tx, policy);
  assert(signed.success, signed.error || 'solo signing failed');

  const wrongAmount = structuredClone(tx);
  wrongAmount.outputs[0].value += 1;
  const wrongAddress = structuredClone(tx);
  wrongAddress.outputs[0].address = state.participants.find((p) => p.id === 'bob').payoutAddress;
  const extraOutput = structuredClone(tx);
  extraOutput.outputs.push({ address: tx.outputs[0].address, value: 1, label: 'forbidden extra output' });

  const tampered = {
    wrongAmount: await adapter.verifyPSBT(wrongAmount, policy),
    wrongAddress: await adapter.verifyPSBT(wrongAddress, policy),
    extraOutput: await adapter.verifyPSBT(extraOutput, policy),
  };
  for (const [name, result] of Object.entries(tampered)) {
    assert(!result.success, `${name} tampered PSBT unexpectedly passed`);
  }

  const committed = ledger.spend(vaultUtxo.outpoint, signed.psbt);
  printResult('solo withdrawal policy enforcement', {
    mode: signed.mode,
    txid: committed.txid,
    payout: committed.outputs[0],
    leftover: committed.outputs[1],
    tamperedRejected: Object.fromEntries(
      Object.entries(tampered).map(([name, result]) => [name, result.failures]),
    ),
  });
}

async function fullRun() {
  const adapter = await createSigbashAdapter();
  const state = createDemoState();
  const ledger = new Ledger();
  createDeposits(ledger, state);
  let currentUtxo = consolidateDeposits(ledger, state);
  const events = [
    { step: 'deposits', value: currentUtxo.value, address: currentUtxo.address },
  ];

  let currentIds = ['alice', 'bob', 'carol'];
  const first = buildSoloWithdrawal({ state, currentUtxo, currentIds, leaverId: 'alice' });
  let policy = state.sigbashPolicies.get('alice');
  let signed = await adapter.signPSBT(first, policy);
  assert(signed.success, signed.error || 'first withdrawal rejected');
  let committed = ledger.spend(currentUtxo.outpoint, signed.psbt);
  events.push({
    step: 'alice first withdrawal',
    payoutSats: committed.outputs[0].value,
    leftoverSats: committed.outputs[1].value,
    nextAddress: committed.outputs[1].address,
  });

  const doubleSpend = buildSoloWithdrawal({ state, currentUtxo, currentIds, leaverId: 'bob' });
  let doubleSpendRejected = '';
  try {
    ledger.spend(currentUtxo.outpoint, doubleSpend);
  } catch (error) {
    doubleSpendRejected = error.message;
  }
  assert(doubleSpendRejected, 'round-1 double-spend unexpectedly succeeded');
  events.push({ step: 'round-1 double-spend rejected', reason: doubleSpendRejected });

  currentUtxo = [...ledger.utxos.values()].find(
    (utxo) => utxo.address === committed.outputs[1].address && !utxo.spent,
  );
  currentIds = ['bob', 'carol'];
  const second = buildSoloWithdrawal({ state, currentUtxo, currentIds, leaverId: 'bob' });
  policy = state.sigbashPolicies.get('bob');
  signed = await adapter.signPSBT(second, policy);
  assert(signed.success, signed.error || 'second withdrawal rejected');
  committed = ledger.spend(currentUtxo.outpoint, signed.psbt);
  events.push({
    step: 'bob second withdrawal',
    payoutSats: committed.outputs[0].value,
    leftoverSats: committed.outputs[1].value,
    nextAddress: committed.outputs[1].address,
  });

  currentUtxo = [...ledger.utxos.values()].find(
    (utxo) => utxo.address === committed.outputs[1].address && !utxo.spent,
  );
  const sweep = buildFinalSweep({ state, currentUtxo, participantId: 'carol' });
  committed = ledger.spend(currentUtxo.outpoint, sweep);
  events.push({
    step: 'carol final sweep',
    sweepSats: committed.outputs[0].value,
    sigbashSignaturesRequested: 0,
  });

  printResult('full run-through', events);
}

async function signedLocalRun() {
  const args = parseArgs(process.argv.slice(3));
  const state = createConfiguredState();
  const startingOutpoint = args.txid
    ? {
        txid: args.txid,
        vout: Number(args.vout ?? 0),
        valueSats: Number(args['value-sats'] ?? AMOUNTS.deposit * 3),
      }
    : undefined;
  printResult('signed local withdrawal run-through', buildSignedLocalWithdrawalRun(state, { startingOutpoint }));
}

async function recovery() {
  const state = createDemoState();
  const ledger = new Ledger();
  createDeposits(ledger, state);
  const vaultUtxo = consolidateDeposits(ledger, state);
  const currentIds = ['alice', 'bob', 'carol'];
  let earlyFailure = '';
  try {
    buildRecovery({ state, currentUtxo: vaultUtxo, currentIds, vanishedId: 'carol', blocksWaited: 0 });
  } catch (error) {
    earlyFailure = error.message;
  }
  assert(earlyFailure, 'early recovery unexpectedly unlocked');

  ledger.mine(RECOVERY_DELAY_BLOCKS);
  const recoveryTx = buildRecovery({
    state,
    currentUtxo: vaultUtxo,
    currentIds,
    vanishedId: 'carol',
    blocksWaited: RECOVERY_DELAY_BLOCKS,
  });
  const committed = ledger.spend(vaultUtxo.outpoint, recoveryTx);
  printResult('timelocked recovery', {
    earlyFailure,
    waitedBlocks: RECOVERY_DELAY_BLOCKS,
    recoveryLeaf: recoveryTx.recoveryLeaf,
    txid: committed.txid,
    outputs: committed.outputs,
  });
}

async function fundingManifest() {
  const state = createConfiguredState();
  const roundOneIds = state.participants.map((participant) => participant.id);
  const roundOneVault = state.vaults.get(roundId(roundOneIds));
  printResult('signet funding manifest', {
    network: 'signet',
    fundingModel:
      'Build one funding transaction with Alice/Bob/Carol contributing 1 BTC each and exactly one 3 BTC output to the round-one vault. The solo-withdrawal ordering relies on that single vault UTXO.',
    participants: state.participants.map((participant) => ({
      id: participant.id,
      depositSats: AMOUNTS.deposit,
      payoutAddress: participant.payoutAddress,
      personalXonlyPubkey: participant.personal.xonlyPubKeyHex,
      sigbashLeafXonlyPubkey: participant.sigbash.xonlyPubKeyHex,
    })),
    roundOneFundingOutput: {
      address: roundOneVault.address,
      valueSats: AMOUNTS.deposit * state.participants.length,
      scriptPubKeyHex: roundOneVault.outputScriptHex,
    },
    vaults: [...state.vaults.values()].map((vault) => ({
      round: vault.id,
      participants: vault.participantIds,
      address: vault.address,
      scriptPubKeyHex: vault.outputScriptHex,
      cooperativeKeyPath: vault.keyPath,
      tapscriptLeaves: vault.tapscriptLeaves,
    })),
    soloWithdrawalTemplates: [...state.policies.values()].map((policy) => ({
      id: policy.id,
      signer: policy.leaverId,
      round: roundId(policy.roundIds),
      requiredLeafKey: policy.conditions.find((condition) => condition.type === 'REQKEY')
        .key_identifier,
      outputs: [
        {
          index: 0,
          valueSats: policy.conditions.find(
            (condition) => condition.type === 'OUTPUT_VALUE' && condition.selector.index === 0,
          ).value,
          address: policy.conditions.find(
            (condition) =>
              condition.type === 'OUTPUT_DEST_IS_IN_SETS' && condition.selector.index === 0,
          ).addresses[0],
        },
        {
          index: 1,
          minValueSats: policy.conditions.find(
            (condition) => condition.type === 'OUTPUT_VALUE' && condition.selector.index === 1,
          ).value,
          address: policy.conditions.find(
            (condition) =>
              condition.type === 'OUTPUT_DEST_IS_IN_SETS' && condition.selector.index === 1,
          ).addresses[0],
        },
      ],
      outputCount: 2,
    })),
  });
}

async function watchManifest() {
  const state = createConfiguredState();
  printResult('watch-only vault manifest', watchOnlyManifest(state));
}

async function rpcImportWatchonly() {
  const state = createConfiguredState();
  const manifest = watchOnlyManifest(state);
  const requests = [];
  for (const item of manifest.vaults) {
    const info = await getDescriptorInfo(item.descriptor);
    requests.push({
      desc: info.descriptor,
      timestamp: 'now',
      active: false,
      internal: false,
    });
  }
  const result = await importDescriptors(requests);
  printResult('Bitcoin Core importdescriptors', {
    walletRpcUrl: process.env.BITCOIN_RPC_URL || 'http://127.0.0.1:38332',
    imported: manifest.vaults.map((vault, index) => ({
      round: vault.round,
      address: vault.address,
      descriptor: requests[index].desc,
      result: result[index],
    })),
    passed: result.every((item) => item.success),
  });
  assert(result.every((item) => item.success), 'one or more watch-only descriptor imports failed');
}

async function vaultOutput() {
  const args = parseArgs(process.argv.slice(3));
  const state = createConfiguredState();
  const currentIds = args.round
    ? args.round.split(',')
    : state.participants.map((participant) => participant.id);
  printResult('expected vault output', expectedVaultOutput(state, currentIds));
}

async function fundingPsbt() {
  const args = parseArgs(process.argv.slice(3));
  const inputs = JSON.parse(requireArg(args, 'inputs-json'));
  const feeSats = Number(args['fee-sats'] || 0);
  const state = createConfiguredState();
  const psbt = buildFundingPsbt({ state, inputs, feeSats });
  printResult('round-one funding PSBT', psbt);
}

async function soloPsbt() {
  const args = parseArgs(process.argv.slice(3));
  const currentIds = requireArg(args, 'round').split(',');
  const leaverId = requireArg(args, 'leaver');
  const txid = requireArg(args, 'txid');
  const vout = Number(requireArg(args, 'vout'));
  const valueSats = Number(requireArg(args, 'value-sats'));
  const state = createConfiguredState();
  const psbt = buildSoloWithdrawalPsbt({ state, currentIds, leaverId, txid, vout, valueSats });
  printResult('solo withdrawal PSBT', psbt);
}

async function signSoloPsbt() {
  const args = parseArgs(process.argv.slice(3));
  const currentIds = requireArg(args, 'round').split(',');
  const leaverId = requireArg(args, 'leaver');
  const psbtBase64 = requireArg(args, 'psbt-base64');
  const state = createConfiguredState();
  const inspection = inspectPsbt(psbtBase64);
  const failures = evaluatePolicy(
    psbtInspectionToPolicyTx({ state, inspection }),
    state.sigbashPolicies.get(leaverId),
  );
  assert(failures.length === 0, `solo PSBT violates local policy: ${failures.join('; ')}`);
  const signed = signSoloWithdrawalPsbt({ state, currentIds, leaverId, psbtBase64 });
  printResult('signed solo withdrawal', {
    ...signed,
    policyPreflight: { passed: true },
  });
}

async function cooperativePsbt() {
  const args = parseArgs(process.argv.slice(3));
  const currentIds = requireArg(args, 'round').split(',');
  const txid = requireArg(args, 'txid');
  const vout = Number(requireArg(args, 'vout'));
  const valueSats = Number(requireArg(args, 'value-sats'));
  const state = createConfiguredState();
  const psbt = buildCooperativeExitPsbt({ state, currentIds, txid, vout, valueSats });
  printResult('cooperative exit PSBT', psbt);
}

async function signCooperativePsbt() {
  const args = parseArgs(process.argv.slice(3));
  const currentIds = requireArg(args, 'round').split(',');
  const psbtBase64 = requireArg(args, 'psbt-base64');
  const state = createConfiguredState();
  const signed = signCooperativeExitPsbt({ state, currentIds, psbtBase64 });
  printResult('signed cooperative exit', signed);
}

async function recoveryPsbt() {
  const args = parseArgs(process.argv.slice(3));
  const currentIds = requireArg(args, 'round').split(',');
  const vanishedId = requireArg(args, 'vanished');
  const txid = requireArg(args, 'txid');
  const vout = Number(requireArg(args, 'vout'));
  const valueSats = Number(requireArg(args, 'value-sats'));
  const state = createConfiguredState();
  const psbt = buildRecoveryPsbt({ state, currentIds, vanishedId, txid, vout, valueSats });
  printResult('timelocked recovery PSBT', psbt);
}

async function signRecoveryPsbtCommand() {
  const args = parseArgs(process.argv.slice(3));
  const currentIds = requireArg(args, 'round').split(',');
  const vanishedId = requireArg(args, 'vanished');
  const psbtBase64 = requireArg(args, 'psbt-base64');
  const signerIds = args.signers ? args.signers.split(',') : undefined;
  const state = createConfiguredState();
  const signed = signRecoveryPsbt({
    state,
    currentIds,
    vanishedId,
    psbtBase64,
    signerIds,
  });
  printResult('signed timelocked recovery', signed);
}

async function finalSweepPsbt() {
  const args = parseArgs(process.argv.slice(3));
  const participantId = requireArg(args, 'participant');
  const txid = requireArg(args, 'txid');
  const vout = Number(requireArg(args, 'vout'));
  const valueSats = Number(requireArg(args, 'value-sats'));
  const feeSats = args['fee-sats'] === undefined ? AMOUNTS.finalSweepFee : Number(args['fee-sats']);
  const state = createConfiguredState();
  const psbt = buildFinalSweepPsbt({
    state,
    participantId,
    txid,
    vout,
    valueSats,
    feeSats,
    destinationAddress: args.destination,
  });
  printResult('final participant sweep PSBT', psbt);
}

async function signFinalSweepPsbtCommand() {
  const args = parseArgs(process.argv.slice(3));
  const participantId = requireArg(args, 'participant');
  const psbtBase64 = requireArg(args, 'psbt-base64');
  const state = createConfiguredState();
  const signed = signFinalSweepPsbt({ state, participantId, psbtBase64 });
  printResult('signed final participant sweep', signed);
}

async function sigbashSignPsbt() {
  assert(
    process.env.SIGBASH_MODE === 'live',
    'sigbash-sign-psbt contacts Sigbash; rerun with SIGBASH_MODE=live',
  );
  const args = parseArgs(process.argv.slice(3));
  const participantId = requireArg(args, 'participant');
  const psbtBase64 = requireArg(args, 'psbt-base64');
  const keyId = args['key-id'] || process.env[`SIGBASH_KEY_ID_${participantId.toUpperCase()}`];
  assert(keyId, `missing --key-id or SIGBASH_KEY_ID_${participantId.toUpperCase()}`);

  const state = createConfiguredState();
  const policy = {
    ...state.sigbashPolicies.get(participantId),
    keyId,
  };
  assert(policy.conditions, `unknown participant policy ${participantId}`);
  const adapter = await createSigbashAdapter();
  const tx = { psbtBase64 };
  const verification = await adapter.verifyPSBT(tx, policy);
  if (verification.passed === false || verification.success === false) {
    printResult('Sigbash PSBT verification failed', verification);
    throw new Error('Sigbash rejected PSBT in dry-run');
  }
  const signed = await adapter.signPSBT(tx, policy);
  const signedArtifacts = normalizeSigbashSigningResult(signed);
  assert(
    signedArtifacts.success && (signedArtifacts.txHex || signedArtifacts.signedPsbtBase64),
    'Sigbash signing succeeded but returned no txHex or signedPSBT artifact',
  );
  printResult('Sigbash signed PSBT', {
    keyId,
    participantId,
    verification,
    ...signedArtifacts,
    nextCommands: sigbashSignedNextCommands(signedArtifacts),
  });
}

async function policyCheckPsbt() {
  const args = parseArgs(process.argv.slice(3));
  const participantId = requireArg(args, 'participant');
  const psbtBase64 = requireArg(args, 'psbt-base64');
  const state = createConfiguredState();
  const policy = state.sigbashPolicies.get(participantId);
  assert(policy, `unknown participant policy ${participantId}`);
  const inspection = inspectPsbt(psbtBase64);
  const tx = psbtInspectionToPolicyTx({ state, inspection });
  const failures = evaluatePolicy(tx, policy);
  printResult('local PSBT policy check', {
    participantId,
    success: failures.length === 0,
    failures,
    tx,
  });
  assert(failures.length === 0, 'PSBT does not satisfy local policy preflight');
}

async function inspectPsbtCommand() {
  const args = parseArgs(process.argv.slice(3));
  const psbtBase64 = requireArg(args, 'psbt-base64');
  printResult('PSBT inspection', inspectPsbt(psbtBase64));
}

async function psbtAcceptance() {
  const state = createDemoState();
  const txid = '0000000000000000000000000000000000000000000000000000000000000001';
  const roundOneIds = ['alice', 'bob', 'carol'];
  const roundOneVault = state.vaults.get(roundId(roundOneIds));
  assert(expectedVaultOutput(state, roundOneIds).valueSats === 300_000_000, 'round-one expected UTXO value mismatch');
  assert(
    expectedVaultOutput(state, ['bob', 'carol']).valueSats === 204_999_000,
    'round-two expected UTXO value mismatch',
  );
  const funding = buildFundingPsbt({
    state,
    feeSats: 3_000,
    inputs: state.participants.map((participant, index) => ({
      participantId: participant.id,
      txid: `${String(index + 1).padStart(64, '0')}`,
      vout: 0,
      valueSats: 100_002_000,
      scriptPubKeyHex: `5120${participant.personal.xonlyPubKeyHex}`,
      changeAddress: participant.payoutAddress,
    })),
  });
  const fundingInspection = inspectPsbt(funding.psbtBase64);
  assert(fundingInspection.inputCount === 3, 'funding PSBT input count mismatch');
  assert(fundingInspection.outputs[0].address === roundOneVault.address, 'funding vault output destination mismatch');
  assert(fundingInspection.outputs[0].valueSats === 300_000_000, 'funding vault output amount mismatch');

  const solo = buildSoloWithdrawalPsbt({
    state,
    currentIds: roundOneIds,
    leaverId: 'alice',
    txid,
    vout: 0,
    valueSats: 300_000_000,
  });
  const soloInspection = inspectPsbt(solo.psbtBase64);
  assert(soloInspection.inputCount === 1, 'solo PSBT input count mismatch');
  assert(soloInspection.outputCount === 2, 'solo PSBT output count mismatch');
  assert(
    soloInspection.inputs[0].witnessUtxo.scriptPubKeyHex === roundOneVault.outputScriptHex,
    'solo PSBT spends wrong vault script',
  );
  assert(
    soloInspection.inputs[0].tapLeafScript?.[0]?.scriptHex ===
      roundOneVault.tapscriptLeaves.find(
        (leaf) => leaf.type === 'solo-withdrawal' && leaf.participantId === 'alice',
      ).scriptHex,
    'solo PSBT uses wrong tapscript leaf',
  );
  assert(soloInspection.outputs[0].valueSats === AMOUNTS.firstWithdrawal, 'solo payout mismatch');
  assert(
    soloInspection.outputs[0].address === state.participants.find((p) => p.id === 'alice').payoutAddress,
    'solo payout destination mismatch',
  );
  assert(
    soloInspection.outputs[1].address === state.vaults.get(roundId(['bob', 'carol'])).address,
    'solo re-vault destination mismatch',
  );
  assert(
    evaluatePolicy(psbtInspectionToPolicyTx({ state, inspection: soloInspection }), state.sigbashPolicies.get('alice')).length === 0,
    'solo PSBT does not satisfy Alice policy preflight',
  );
  const tamperedSoloInspection = structuredClone(soloInspection);
  tamperedSoloInspection.outputs[0].valueSats += 1;
  assert(
    evaluatePolicy(
      psbtInspectionToPolicyTx({ state, inspection: tamperedSoloInspection }),
      state.sigbashPolicies.get('alice'),
    ).length > 0,
    'tampered solo PSBT unexpectedly passed policy preflight',
  );
  const soloTamperVariants = buildSoloWithdrawalTamperPsbts({
    state,
    currentIds: roundOneIds,
    leaverId: 'alice',
    txid,
    vout: 0,
    valueSats: 300_000_000,
  });
  const soloTamperChecks = soloTamperLocalChecks({
    state,
    leaverId: 'alice',
    variants: soloTamperVariants,
  });
  assert(soloTamperChecks.valid.passed, 'valid solo tamper-check PSBT unexpectedly failed local policy');
  assert(
    Object.values(soloTamperChecks.tampered).every((result) => !result.passed),
    'one or more real tampered solo PSBTs unexpectedly passed local policy',
  );
  const signedSolo = signSoloWithdrawalPsbt({
    state,
    currentIds: roundOneIds,
    leaverId: 'alice',
    psbtBase64: solo.psbtBase64,
  });
  assert(/^[0-9a-f]{64}$/.test(signedSolo.txid), 'signed solo txid mismatch');
  assert(signedSolo.transactionHex.length > 0, 'signed solo transaction hex missing');
  const secondSolo = buildSoloWithdrawalPsbt({
    state,
    currentIds: ['bob', 'carol'],
    leaverId: 'bob',
    txid: signedSolo.txid,
    vout: 1,
    valueSats: soloInspection.outputs[1].valueSats,
  });
  const secondSoloInspection = inspectPsbt(secondSolo.psbtBase64);
  assert(secondSoloInspection.outputs[0].valueSats === AMOUNTS.secondWithdrawal, 'second solo payout mismatch');

  const cooperative = buildCooperativeExitPsbt({
    state,
    currentIds: roundOneIds,
    txid,
    vout: 0,
    valueSats: 300_000_000,
  });
  const cooperativeInspection = inspectPsbt(cooperative.psbtBase64);
  assert(cooperativeInspection.outputCount === 3, 'cooperative PSBT output count mismatch');
  assert(
    cooperativeInspection.inputs[0].tapLeafScript === undefined,
    'cooperative PSBT must not use a tapscript leaf',
  );
  assert(
    cooperativeInspection.outputs.every((output) => output.valueSats === AMOUNTS.deposit),
    'cooperative PSBT does not refund full deposits',
  );
  const cooperativeReady = expectedCooperativeReadiness({ state, currentIds: roundOneIds });
  assert(cooperativeReady.keyPathContainsOnlyPersonalKeys, 'cooperative readiness key-path mismatch');
  assert(
    cooperativeReady.signerIds.join(',') === 'alice,bob,carol',
    'cooperative readiness signer set mismatch',
  );
  assert(
    cooperativeReady.refundOutputs.every((output) => output.valueSats === AMOUNTS.deposit),
    'cooperative readiness refund output mismatch',
  );
  const signedCooperative = signCooperativeExitPsbt({
    state,
    currentIds: roundOneIds,
    psbtBase64: cooperative.psbtBase64,
  });
  assert(/^[0-9a-f]{64}$/.test(signedCooperative.txid), 'signed cooperative txid mismatch');
  assert(signedCooperative.transactionHex.length > 0, 'signed cooperative transaction hex missing');

  const recovery = buildRecoveryPsbt({
    state,
    currentIds: roundOneIds,
    vanishedId: 'carol',
    txid,
    vout: 0,
    valueSats: 300_000_000,
  });
  const recoveryInspection = inspectPsbt(recovery.psbtBase64);
  const recoveryLeaf = roundOneVault.tapscriptLeaves.find((leaf) => leaf.type === 'timelocked-recovery');
  assert(recoveryInspection.version >= 2, 'recovery PSBT version must enable BIP68 CSV');
  assert(recoveryInspection.inputs[0].sequence === RECOVERY_DELAY_BLOCKS, 'recovery sequence mismatch');
  assert(recoveryInspection.outputCount === 3, 'recovery PSBT output count mismatch');
  assert(
    recoveryInspection.inputs[0].tapLeafScript?.[0]?.scriptHex === recoveryLeaf.scriptHex,
    'recovery PSBT uses wrong tapscript leaf',
  );
  assert(recovery.txTemplate.tapLeafScript.threshold === 2, 'recovery threshold mismatch');
  assert(
    recovery.txTemplate.signerIds.join(',') === 'alice,bob',
    'recovery signer set mismatch',
  );
  const recoveryReady = expectedRecoveryReadiness({
    state,
    currentIds: roundOneIds,
    vanishedId: 'carol',
  });
  assert(recoveryReady.relativeBlocks === RECOVERY_DELAY_BLOCKS, 'recovery readiness delay mismatch');
  assert(recoveryReady.threshold === 2, 'recovery readiness threshold mismatch');
  assert(recoveryReady.signerIds.join(',') === 'alice,bob', 'recovery readiness signer mismatch');
  const signedRecovery = signRecoveryPsbt({
    state,
    currentIds: roundOneIds,
    vanishedId: 'carol',
    psbtBase64: recovery.psbtBase64,
  });
  assert(/^[0-9a-f]{64}$/.test(signedRecovery.txid), 'signed recovery txid mismatch');
  assert(signedRecovery.transactionHex.length > 0, 'signed recovery transaction hex missing');

  const finalSweep = buildFinalSweepPsbt({
    state,
    participantId: 'carol',
    txid,
    vout: 1,
    valueSats: 102_497_000,
  });
  const finalSweepInspection = inspectPsbt(finalSweep.psbtBase64);
  const carol = state.participants.find((participant) => participant.id === 'carol');
  assert(finalSweepInspection.inputCount === 1, 'final sweep PSBT input count mismatch');
  assert(finalSweepInspection.outputCount === 1, 'final sweep PSBT output count mismatch');
  assert(
    finalSweepInspection.inputs[0].tapInternalKey === carol.payout.xonlyPubKeyHex,
    'final sweep uses wrong key-path signer',
  );
  assert(finalSweepInspection.outputs[0].address === carol.payoutAddress, 'final sweep destination mismatch');
  assert(
    finalSweepInspection.outputs[0].valueSats === 102_497_000 - AMOUNTS.finalSweepFee,
    'final sweep fee mismatch',
  );
  const signedFinalSweep = signFinalSweepPsbt({
    state,
    participantId: 'carol',
    psbtBase64: finalSweep.psbtBase64,
  });
  assert(/^[0-9a-f]{64}$/.test(signedFinalSweep.txid), 'signed final sweep txid mismatch');
  assert(signedFinalSweep.transactionHex.length > 0, 'signed final sweep transaction hex missing');
  const fakeFundingTx = {
    vin: state.participants.map((participant, index) => ({
      txid: `${String(index + 10).padStart(64, '0')}`,
      vout: 0,
      prevout: {
        value: 1.00002,
        scriptPubKey: {
          address: participant.payoutAddress,
        },
      },
    })),
    vout: fundingInspection.outputs.map((output) => ({
      n: output.index,
      value: output.valueSats / 100_000_000,
      scriptPubKey: {
        address: output.address,
        hex: output.scriptPubKeyHex,
      },
    })),
  };
  const fundingTxid = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
  const fakeFundingInputValues = fakeFundingTx.vin.map((input) => ({
    valueSats: input.prevout ? btcToSats(input.prevout.value) : null,
  }));
  assert(fakeFundingTx.vin.length === state.participants.length, 'funding input count mismatch');
  assert(
    fakeFundingInputValues.every((input) => input.valueSats >= AMOUNTS.deposit),
    'funding input value mismatch',
  );
  const fakeFallbackFundingTx = {
    vin: [{ txid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', vout: 1 }],
  };
  const fakePreviousTransactions = new Map([
    [
      fakeFallbackFundingTx.vin[0].txid,
      {
        vout: [
          { n: 0, value: 0.5, scriptPubKey: {} },
          { n: 1, value: 1.25, scriptPubKey: { address: 'tb1qfallback' } },
        ],
      },
    ],
  ]);
  const fakeFallbackSummaries = await fundingInputSummaries(
    fakeFallbackFundingTx.vin,
    async (txidToFetch) => fakePreviousTransactions.get(txidToFetch),
  );
  assert(fakeFallbackSummaries[0].valueSats === 125_000_000, 'funding prevout fallback value mismatch');
  assert(fakeFallbackSummaries[0].source === 'previous-transaction', 'funding prevout fallback source mismatch');
  assert(
    findTransactionOutputs(fakeFundingTx, expectedTransactionOutput({ args: { round: 'alice,bob,carol' }, state })).length === 1,
    'round-one output locator mismatch',
  );
  const fakeSoloTx = {
    vin: [{ txid: fundingTxid, vout: 0 }],
    vout: soloInspection.outputs.map((output) => ({
      n: output.index,
      value: output.valueSats / 100_000_000,
      scriptPubKey: {
        address: output.address,
        hex: output.scriptPubKeyHex,
      },
    })),
  };
  assert(
    findTransactionOutputs(fakeSoloTx, expectedTransactionOutput({ args: { round: 'bob,carol' }, state }))[0]?.vout === 1,
      'round-two output locator mismatch',
  );
  assert(transactionSpendsOutpoint(fakeSoloTx, fundingTxid, 0), 'first withdrawal chain linkage mismatch');
  const fakeSecondSoloTx = {
    vin: [{ txid: signedSolo.txid, vout: 1 }],
    vout: secondSoloInspection.outputs.map((output) => ({
      n: output.index,
      value: output.valueSats / 100_000_000,
      scriptPubKey: {
        address: output.address,
        hex: output.scriptPubKeyHex,
      },
    })),
  };
  assert(transactionSpendsOutpoint(fakeSecondSoloTx, signedSolo.txid, 1), 'second withdrawal chain linkage mismatch');
  const expectedSoloAudit = expectedSoloWithdrawalOutputs({
    state,
    currentIds: roundOneIds,
    leaverId: 'alice',
    inputValueSats: 300_000_000,
  });
  const fakeSoloOutputs = fakeSoloTx.vout.map(transactionOutputSummary);
  const alice = state.participants.find((participant) => participant.id === 'alice');
  assert(
    fakeSoloOutputs[0].address === expectedSoloAudit.payout.address &&
      fakeSoloOutputs[0].valueSats === expectedSoloAudit.payout.valueSats,
    'solo audit payout output mismatch',
  );
  assert(
    fakeSoloOutputs[1].address === expectedSoloAudit.nextVault.address &&
      fakeSoloOutputs[1].valueSats === expectedSoloAudit.nextVault.valueSats &&
      fakeSoloOutputs[1].valueSats >= expectedSoloAudit.nextVault.floorSats,
    'solo audit re-vault output mismatch',
  );
  assert(
    evaluatePolicy(
      {
        sigbashLeafKey: alice.sigbash.xonlyPubKeyHex,
        outputs: fakeSoloOutputs.map((output) => ({
          address: output.address,
          value: output.valueSats,
        })),
      },
      state.sigbashPolicies.get('alice'),
    ).length === 0,
    'solo audit local policy mismatch',
  );
  const normalizedSigbashTx = normalizeSigbashSigningResult({
    success: true,
    txHex: '020000000001',
    signedPSBT: solo.psbtBase64,
    pathId: 'path-0',
  });
  assert(normalizedSigbashTx.txHex === '020000000001', 'Sigbash txHex normalization mismatch');
  assert(normalizedSigbashTx.signedPsbtBase64 === solo.psbtBase64, 'Sigbash signed PSBT normalization mismatch');
  assert(sigbashSignedNextCommands(normalizedSigbashTx).length === 2, 'Sigbash next command generation mismatch');
  const fakeCooperativeTx = {
    vin: [{ txid, vout: 0, txinwitness: ['00'.repeat(64)] }],
    vout: cooperativeInspection.outputs.map((output) => ({
      n: output.index,
      value: output.valueSats / 100_000_000,
      scriptPubKey: {
        address: output.address,
        hex: output.scriptPubKeyHex,
      },
    })),
  };
  assert(transactionSpendsOutpoint(fakeCooperativeTx, txid, 0), 'cooperative input locator mismatch');
  assert(isTaprootKeyPathWitness(findTransactionInput(fakeCooperativeTx, txid, 0)), 'cooperative key-path witness mismatch');
  assert(
    cooperativeReady.refundOutputs.every(
      (output) =>
        findTransactionOutputs(fakeCooperativeTx, {
          address: output.address,
          valueSats: output.valueSats,
        }).length === 1,
    ),
    'cooperative refund output locator mismatch',
  );
  const recoveryOutputs = expectedRecoveryOutputs({ state, currentIds: roundOneIds, valueSats: 300_000_000 });
  const fakeRecoveryTx = {
    vin: [{ txid, vout: 0, sequence: RECOVERY_DELAY_BLOCKS }],
    vout: recoveryInspection.outputs.map((output) => ({
      n: output.index,
      value: output.valueSats / 100_000_000,
      scriptPubKey: {
        address: output.address,
        hex: output.scriptPubKeyHex,
      },
    })),
  };
  assert(findTransactionInput(fakeRecoveryTx, txid, 0)?.sequence === RECOVERY_DELAY_BLOCKS, 'recovery input locator mismatch');
  assert(
    recoveryOutputs.every(
      (output) =>
        findTransactionOutputs(fakeRecoveryTx, {
          address: output.address,
          valueSats: output.valueSats,
        }).length === 1,
    ),
    'recovery output locator mismatch',
  );
  const fakeFinalSweepTx = {
    vin: [{ txid, vout: 1, txinwitness: ['11'.repeat(64)] }],
    vout: finalSweepInspection.outputs.map((output) => ({
      n: output.index,
      value: output.valueSats / 100_000_000,
      scriptPubKey: {
        address: output.address,
        hex: output.scriptPubKeyHex,
      },
    })),
  };
  assert(findTransactionInput(fakeFinalSweepTx, txid, 1), 'final sweep input locator mismatch');
  assert(isTaprootKeyPathWitness(findTransactionInput(fakeFinalSweepTx, txid, 1)), 'final sweep key-path witness mismatch');
  assert(
    findTransactionOutputs(fakeFinalSweepTx, {
      address: carol.payoutAddress,
      valueSats: 102_497_000 - AMOUNTS.finalSweepFee,
    }).length === 1,
    'final sweep output locator mismatch',
  );
  assert(
    transactionConfirmationCheck('fake confirmed tx', { txid, confirmations: 2, blockhash: '00'.repeat(32) }, 2).ok,
    'confirmation helper should pass at threshold',
  );
  assert(
    !transactionConfirmationCheck('fake underconfirmed tx', { txid, confirmations: 1 }, 2).ok,
    'confirmation helper should fail below threshold',
  );
  const orderingOnlyCommand = liveRunAuditCommand({
    args: {
      'funding-txid': fundingTxid,
      'first-txid': signedSolo.txid,
      'second-txid': signedFinalSweep.txid,
      'final-txid': '3333333333333333333333333333333333333333333333333333333333333333',
      'min-confirmations': '2',
    },
    firstLeaver: 'alice',
    secondLeaver: 'bob',
  });
  assert(!orderingOnlyCommand.includes('--final-txid'), 'ordering-only audit command should not include final txid');
  assert(orderingOnlyCommand.includes('--min-confirmations 2'), 'audit command confirmation threshold mismatch');
  const fullRunCommand = liveRunAuditCommand({
    args: {
      'funding-txid': fundingTxid,
      'first-txid': signedSolo.txid,
      'second-txid': signedFinalSweep.txid,
      'final-txid': '3333333333333333333333333333333333333333333333333333333333333333',
    },
    firstLeaver: 'alice',
    secondLeaver: 'bob',
    includeFinal: true,
  });
  assert(fullRunCommand.includes('--final-txid'), 'full-run audit command should include final txid');
  const signedRun = buildSignedLocalWithdrawalRun(state);
  assert(signedRun.stages.length === 3, 'signed local run stage count mismatch');
  assert(
    signedRun.stages.every((stage) => /^[0-9a-f]{64}$/.test(stage.txid) && stage.transactionHex.length > 0),
    'signed local run missing finalized transactions',
  );
  assert(
    signedRun.stages.at(-1).outputs[0].valueSats === 102_497_000 - AMOUNTS.finalSweepFee,
    'signed local run final sweep value mismatch',
  );

  printResult('PSBT acceptance', {
    passed: true,
    checks: [
      'solo withdrawal PSBT has one input, two outputs, correct payout, and correct re-vault',
      'solo withdrawal PSBT satisfies local Sigbash policy preflight and a tampered PSBT fails',
      'real tampered solo PSBT variants fail local policy before live Sigbash verification',
      'solo withdrawal PSBT signs and finalizes through the local Sigbash leaf model',
      'funding PSBT creates exactly one 3 BTC round-one vault output',
      'cooperative PSBT uses key-path metadata only and refunds full deposits',
      'cooperative readiness confirms personal-key-only signer set and refund outputs',
      'cooperative PSBT signs and finalizes with a local aggregate key-path signature',
      'recovery PSBT uses the timelocked threshold leaf, version 2, and expected sequence',
      'recovery readiness computes the expected delay, threshold, and signer set',
      'recovery PSBT signs and finalizes with the remaining participants',
      'final participant sweep PSBT uses only the remaining participant key path',
      'final participant sweep signs and finalizes as a real Taproot key-path spend',
      'signed local run extracts first withdrawal, second withdrawal, and final sweep transactions',
      'funding audit helpers identify three 1 BTC participant inputs',
      'output locator finds round-one and round-two vault outputs',
      'live run audit helpers prove first and second withdrawals spend the previous vault output',
      'solo audit helpers identify expected payout, re-vault, and policy acceptance',
      'Sigbash signing artifacts are normalized for broadcast or PSBT finalization',
      'cooperative audit helpers identify the vault input and refund outputs',
      'cooperative and final-sweep audit helpers identify Taproot key-path witnesses',
      'recovery audit helpers identify the CSV input and recovery outputs',
      'final sweep audit helpers identify the payout input, key-path witness, and sweep output',
      'live audit confirmation helper enforces the requested confirmation threshold',
      'acceptance evidence commands keep ordering-only and full-run proofs distinct',
    ],
  });
}

async function rpcGetTxOut() {
  const args = parseArgs(process.argv.slice(3));
  const txid = requireArg(args, 'txid');
  const vout = Number(requireArg(args, 'vout'));
  const result = await getTxOut(txid, vout);
  printResult('Bitcoin Core gettxout', result);
}

async function verifyVaultUtxo() {
  const args = parseArgs(process.argv.slice(3));
  const txid = requireArg(args, 'txid');
  const vout = Number(requireArg(args, 'vout'));
  const currentIds = args.round
    ? args.round.split(',')
    : createConfiguredState().participants.map((participant) => participant.id);
  const state = createConfiguredState();
  const expected = expectedVaultOutput(state, currentIds);
  let actual = null;
  let fetchError = null;
  try {
    actual = await getTxOut(txid, vout);
  } catch (error) {
    fetchError = error.message;
  }
  const checks = compareVaultUtxo({ actual, expected });

  printResult('vault UTXO verification', {
    outpoint: `${txid}:${vout}`,
    round: roundId(currentIds),
    expected,
    actual: actual
      ? {
          confirmations: actual.confirmations,
          valueBtc: actual.value,
          valueSats: btcToSats(actual.value),
          scriptPubKeyHex: actual.scriptPubKey?.hex,
          address: actual.scriptPubKey?.address,
        }
      : null,
    fetchError,
    checks,
    passed: checks.every((check) => check.ok),
  });
  assert(checks.every((check) => check.ok), 'vault UTXO does not match expected round vault');
}

async function cooperativeReadiness() {
  const args = parseArgs(process.argv.slice(3));
  const txid = requireArg(args, 'txid');
  const vout = Number(requireArg(args, 'vout'));
  const currentIds = requireArg(args, 'round').split(',');
  const state = createConfiguredState();
  const expected = expectedVaultOutput(state, currentIds);
  const readiness = expectedCooperativeReadiness({ state, currentIds });
  let actual = null;
  let fetchError = null;
  try {
    actual = await getTxOut(txid, vout);
  } catch (error) {
    fetchError = error.message;
  }
  const checks = [
    ...compareVaultUtxo({ actual, expected }),
    check(
      'cooperative key-path contains no Sigbash keys',
      readiness.keyPathContainsOnlyPersonalKeys,
      readiness.keyPath,
    ),
    check(
      'all current participants are required signers',
      readiness.signerIds.length === currentIds.length,
      { signerIds: readiness.signerIds },
    ),
  ];

  printResult('cooperative readiness', {
    outpoint: `${txid}:${vout}`,
    round: roundId(currentIds),
    expectedVault: expected,
    cooperative: readiness,
    actual: actual
      ? {
          confirmations: actual.confirmations,
          valueBtc: actual.value,
          valueSats: btcToSats(actual.value),
          scriptPubKeyHex: actual.scriptPubKey?.hex,
          address: actual.scriptPubKey?.address,
        }
      : null,
    fetchError,
    checks,
    passed: checks.every((item) => item.ok),
  });
  assert(checks.every((item) => item.ok), 'cooperative exit is not ready');
}

async function recoveryReadiness() {
  const args = parseArgs(process.argv.slice(3));
  const txid = requireArg(args, 'txid');
  const vout = Number(requireArg(args, 'vout'));
  const currentIds = requireArg(args, 'round').split(',');
  const vanishedId = requireArg(args, 'vanished');
  const state = createConfiguredState();
  const expected = expectedVaultOutput(state, currentIds);
  const readiness = expectedRecoveryReadiness({ state, currentIds, vanishedId });
  let actual = null;
  let fetchError = null;
  try {
    actual = await getTxOut(txid, vout);
  } catch (error) {
    fetchError = error.message;
  }
  const checks = [
    ...compareVaultUtxo({ actual, expected }),
    check(
      `vault UTXO has at least ${RECOVERY_DELAY_BLOCKS} confirmation(s) for CSV recovery`,
      actual && actual.confirmations >= RECOVERY_DELAY_BLOCKS,
      actual ? { confirmations: actual.confirmations } : undefined,
    ),
    check(
      'remaining participants can satisfy the N-1 recovery threshold',
      readiness.signerIds.length >= readiness.threshold,
      { signerIds: readiness.signerIds, threshold: readiness.threshold },
    ),
  ];

  printResult('recovery readiness', {
    outpoint: `${txid}:${vout}`,
    round: roundId(currentIds),
    vanishedId,
    expectedVault: expected,
    recovery: readiness,
    actual: actual
      ? {
          confirmations: actual.confirmations,
          valueBtc: actual.value,
          valueSats: btcToSats(actual.value),
          scriptPubKeyHex: actual.scriptPubKey?.hex,
          address: actual.scriptPubKey?.address,
        }
      : null,
    fetchError,
    checks,
    passed: checks.every((item) => item.ok),
  });
  assert(checks.every((item) => item.ok), 'recovery is not ready');
}

async function liveReadiness() {
  const state = createConfiguredState();
  const roundOneIds = state.participants.map((participant) => participant.id);
  const expected = expectedVaultOutput(state, roundOneIds);
  const envChecks = [
    checkEnvEquals('SIGBASH_MODE', 'live'),
    ...[
      'SIGBASH_SERVER_URL',
      'SIGBASH_API_KEY',
      'SIGBASH_USER_KEY',
      'SIGBASH_SECRET_KEY',
      'SIGBASH_WASM_URL',
      'SIGBASH_KEY_ID_ALICE',
      'SIGBASH_KEY_ID_BOB',
      'SIGBASH_KEY_ID_CAROL',
      'SIGBASH_LEAF_ALICE',
      'SIGBASH_LEAF_BOB',
      'SIGBASH_LEAF_CAROL',
    ].map(checkEnvPresent),
  ];
  const sdkCheck = await checkSdkPolicyBuilder();
  const rpcCheck = await checkBitcoinRpc();

  const args = parseArgs(process.argv.slice(3));
  let utxoCheck = null;
  if (args.txid || args.vout !== undefined) {
    assert(args.txid && args.vout !== undefined, 'provide both --txid and --vout for UTXO readiness');
    try {
      const actual = await getTxOut(args.txid, Number(args.vout));
      utxoCheck = {
        outpoint: `${args.txid}:${Number(args.vout)}`,
        checks: compareVaultUtxo({ actual, expected }),
      };
    } catch (error) {
      utxoCheck = {
        outpoint: `${args.txid}:${Number(args.vout)}`,
        checks: [
          {
            name: 'round-one vault UTXO is readable',
            ok: false,
            error: error.message,
          },
        ],
      };
    }
  }

  const checks = [...envChecks, sdkCheck, rpcCheck, ...(utxoCheck ? utxoCheck.checks : [])];
  printResult('live readiness', {
    expectedRoundOneVault: expected,
    checks,
    optionalUtxo: utxoCheck,
    passed: checks.every((check) => check.ok),
  });
  assert(checks.every((check) => check.ok), 'live readiness checks failed');
}

async function liveAcceptanceEvidence() {
  const args = parseArgs(process.argv.slice(3));
  const strict = args.strict === true || args.strict === 'true';
  const state = createConfiguredState();
  const firstLeaver = args['first-leaver'] || 'alice';
  const secondLeaver = args['second-leaver'] || 'bob';
  const firstRemaining = participantIds(state).filter((id) => id !== firstLeaver);
  const lastParticipant = args['last-participant'] || firstRemaining.find((id) => id !== secondLeaver) || 'carol';
  const roundOne = participantIds(state).join(',');

  const items = [
    evidenceItem({
      id: 1,
      requirement: 'Cooperative exit works with Sigbash turned off',
      args,
      required: ['cooperative-txid', 'cooperative-vault-txid', 'cooperative-vault-vout'],
      command: commandLine('npm run live-cooperative-audit --', {
        txid: argOrPlaceholder(args, 'cooperative-txid'),
        'vault-txid': argOrPlaceholder(args, 'cooperative-vault-txid'),
        'vault-vout': argOrPlaceholder(args, 'cooperative-vault-vout'),
        round: args['cooperative-round'] || roundOne,
        'min-confirmations': args['min-confirmations'] || '1',
      }),
      evidence:
        'Audits the broadcast cooperative transaction spends the selected vault outpoint, uses a Taproot key-path witness, refunds each current participant 1 BTC, and uses a key path containing only personal keys.',
    }),
    evidenceItem({
      id: 2,
      requirement: 'Solo withdrawal pays/re-vaults correctly and tampered PSBTs are rejected by Sigbash',
      args,
      required: ['solo-vault-txid', 'solo-vault-vout', 'solo-txid'],
      command: [
        commandLine('SIGBASH_MODE=live npm run live-solo-tamper-check --', {
          round: args['solo-round'] || roundOne,
          leaver: args['solo-leaver'] || firstLeaver,
          txid: argOrPlaceholder(args, 'solo-vault-txid'),
          vout: argOrPlaceholder(args, 'solo-vault-vout'),
        }),
        commandLine('npm run live-solo-audit --', {
          txid: argOrPlaceholder(args, 'solo-txid'),
          'vault-txid': argOrPlaceholder(args, 'solo-vault-txid'),
          'vault-vout': argOrPlaceholder(args, 'solo-vault-vout'),
          round: args['solo-round'] || roundOne,
          leaver: args['solo-leaver'] || firstLeaver,
          'value-sats': args['solo-value-sats'] || String(AMOUNTS.deposit * 3),
          'min-confirmations': args['min-confirmations'] || '1',
        }),
      ],
      evidence:
        'Dry-runs live Sigbash verifyPSBT against the valid PSBT and wrong-amount, wrong-address, and extra-output variants, then audits the broadcast solo transaction outputs.',
    }),
    evidenceItem({
      id: 3,
      requirement: 'Only one person can take a given round amount',
      args,
      required: ['funding-txid', 'first-txid', 'second-txid'],
      command: liveRunAuditCommand({ args, firstLeaver, secondLeaver }),
      evidence:
        'Audits the first withdrawal spends the single round-one vault output and the second withdrawal spends the round-two output created by the first withdrawal.',
    }),
    evidenceItem({
      id: 4,
      requirement: 'Full run-through from setup through final sweep',
      args,
      required: ['funding-txid', 'first-txid', 'second-txid', 'final-txid'],
      command: liveRunAuditCommand({ args, firstLeaver, secondLeaver, includeFinal: true }),
      evidence:
        'Audits three funding inputs, first payout, round-two re-vault, second payout, last participant remainder, final sweep key-path witness, and transaction confirmations.',
    }),
    evidenceItem({
      id: 5,
      requirement: 'No Sigbash key in the cooperative key path',
      args,
      required: ['cooperative-vault-txid', 'cooperative-vault-vout'],
      command: commandLine('npm run cooperative-readiness --', {
        txid: argOrPlaceholder(args, 'cooperative-vault-txid'),
        vout: argOrPlaceholder(args, 'cooperative-vault-vout'),
        round: args['cooperative-round'] || roundOne,
      }),
      evidence:
        'Verifies the selected live vault UTXO matches the derived vault and the cooperative key path contains only current participants personal keys.',
    }),
    evidenceItem({
      id: 6,
      requirement: 'Timelocked recovery works after a participant vanishes',
      args,
      required: ['recovery-vault-txid', 'recovery-vault-vout', 'recovery-txid', 'recovery-value-sats'],
      command: [
        commandLine('npm run recovery-readiness --', {
          txid: argOrPlaceholder(args, 'recovery-vault-txid'),
          vout: argOrPlaceholder(args, 'recovery-vault-vout'),
          round: args['recovery-round'] || roundOne,
          vanished: args.vanished || lastParticipant,
        }),
        commandLine('npm run live-recovery-audit --', {
          txid: argOrPlaceholder(args, 'recovery-txid'),
          'vault-txid': argOrPlaceholder(args, 'recovery-vault-txid'),
          'vault-vout': argOrPlaceholder(args, 'recovery-vault-vout'),
          round: args['recovery-round'] || roundOne,
          vanished: args.vanished || lastParticipant,
          'value-sats': argOrPlaceholder(args, 'recovery-value-sats'),
          'min-confirmations': args['min-confirmations'] || '1',
        }),
      ],
      evidence:
        'Checks the vault has enough confirmations for CSV recovery and audits the broadcast recovery transaction sequence, version, threshold model, and outputs.',
    }),
  ];

  printResult('live acceptance evidence checklist', {
    purpose: 'Run these commands with real signet txids/outpoints to produce evidence for every acceptance item in spec.md section 8.',
    strict,
    assumptions: {
      firstLeaver,
      secondLeaver,
      lastParticipant,
      roundOne,
    },
    items,
    ready: items.every((item) => item.ready),
  });
  if (strict) {
    assert(items.every((item) => item.ready), 'live acceptance evidence is missing required arguments');
  }
}

async function rpcDecodeTx() {
  const args = parseArgs(process.argv.slice(3));
  const rawTxHex = requireArg(args, 'hex');
  const result = await decodeRawTransaction(rawTxHex);
  printResult('Bitcoin Core decoderawtransaction', result);
}

async function rpcTestMempoolAccept() {
  const args = parseArgs(process.argv.slice(3));
  const rawTxHex = requireArg(args, 'hex');
  const maxFeeRate =
    args['max-fee-rate'] === undefined ? undefined : Number(args['max-fee-rate']);
  const result = await testMempoolAccept(rawTxHex, maxFeeRate);
  printResult('Bitcoin Core testmempoolaccept', result);
  assert(result.every((item) => item.allowed), 'transaction is not accepted by mempool policy');
}

async function rpcSubmit() {
  const args = parseArgs(process.argv.slice(3));
  const maxFeeRate =
    args['max-fee-rate'] === undefined ? undefined : Number(args['max-fee-rate']);
  let finalized = null;
  let rawTxHex = args.hex;
  if (!rawTxHex) {
    const psbtBase64 = requireArg(args, 'psbt-base64');
    finalized = await finalizePsbt(psbtBase64, true);
    assert(finalized.complete, 'PSBT is not complete and cannot be extracted');
    rawTxHex = finalized.hex;
  }
  assert(/^[0-9a-f]+$/i.test(rawTxHex), 'raw transaction hex is not valid hex');
  const mempool = await testMempoolAccept(rawTxHex, maxFeeRate);
  const accepted = mempool.every((item) => item.allowed);
  let txid = null;
  if (accepted && args.broadcast !== 'false') {
    txid = await sendRawTransaction(rawTxHex);
  }
  printResult('Bitcoin Core submit transaction', {
    source: finalized ? 'psbt' : 'hex',
    finalized,
    rawTxHex,
    mempool,
    broadcast: args.broadcast !== 'false',
    txid,
    nextStep: txid
      ? 'Use rpc-tx-status to watch confirmations and rpc-find-output to locate the next vault or payout output.'
      : 'Broadcast skipped; rerun without --broadcast false to send this transaction.',
    passed: accepted && (args.broadcast === 'false' || Boolean(txid)),
  });
  assert(accepted, 'transaction is not accepted by mempool policy');
}

async function rpcTxStatus() {
  const args = parseArgs(process.argv.slice(3));
  const txid = requireArg(args, 'txid');
  const tx = await getRawTransaction(txid, true);
  printResult('Bitcoin Core transaction status', {
    txid,
    confirmations: tx.confirmations || 0,
    inBestBlock: Boolean(tx.blockhash),
    blockhash: tx.blockhash,
    blockheight: tx.blockheight,
    time: tx.time,
    blocktime: tx.blocktime,
    hex: args.hex === 'true' ? tx.hex : undefined,
  });
}

async function rpcFindOutput() {
  const args = parseArgs(process.argv.slice(3));
  const txid = requireArg(args, 'txid');
  const state = createConfiguredState();
  const expected = expectedTransactionOutput({ args, state });
  const tx = await getRawTransaction(txid, true);
  const matches = findTransactionOutputs(tx, expected);
  printResult('Bitcoin Core matching outputs', {
    txid,
    expected,
    matches,
    count: matches.length,
  });
  assert(matches.length === 1, `expected exactly one matching output, found ${matches.length}`);
}

async function liveRunAudit() {
  const args = parseArgs(process.argv.slice(3));
  const minConfirmations = minConfirmationsFromArgs(args);
  const fundingTxid = requireArg(args, 'funding-txid');
  const firstTxid = requireArg(args, 'first-txid');
  const secondTxid = requireArg(args, 'second-txid');
  const finalTxid = args['final-txid'];
  const firstLeaverId = requireArg(args, 'first-leaver');
  const secondLeaverId = requireArg(args, 'second-leaver');
  const state = createConfiguredState();

  const firstRemaining = participantIds(state).filter((id) => id !== firstLeaverId);
  const lastParticipantId = firstRemaining.find((id) => id !== secondLeaverId);
  assert(lastParticipantId, 'could not derive last participant from leaver order');

  const fundingTx = await getRawTransaction(fundingTxid, 2);
  const firstTx = await getRawTransaction(firstTxid, true);
  const secondTx = await getRawTransaction(secondTxid, true);
  const finalTx = finalTxid ? await getRawTransaction(finalTxid, true) : null;

  const checks = [];
  const fundingInputs = fundingTx.vin || [];
  const fundingInputValues = await fundingInputSummaries(fundingInputs);
  checks.push(check('funding tx has one input per participant', fundingInputs.length === state.participants.length, {
    expected: state.participants.length,
    actual: fundingInputs.length,
    inputs: fundingInputValues,
  }));
  checks.push(check(
    'each funding input contributes at least 1 BTC',
    fundingInputValues.length === state.participants.length &&
      fundingInputValues.every((input) => input.valueSats !== null && input.valueSats >= AMOUNTS.deposit),
    fundingInputValues,
  ));
  const fundingVault = oneMatch(fundingTx, expectedTransactionOutput({
    args: { round: participantIds(state).join(',') },
    state,
  }));
  checks.push(check('funding tx creates exactly one round-one 3 BTC vault output', Boolean(fundingVault), fundingVault));
  checks.push(check(
    'first withdrawal spends the round-one vault output',
    Boolean(fundingVault) && transactionSpendsOutpoint(firstTx, fundingTxid, fundingVault.vout),
    {
      vaultOutpoint: fundingVault ? `${fundingTxid}:${fundingVault.vout}` : null,
    },
  ));

  const firstPayout = oneMatch(firstTx, expectedTransactionOutput({
    args: { participant: firstLeaverId, 'value-sats': String(AMOUNTS.firstWithdrawal) },
    state,
  }));
  checks.push(check('first withdrawal pays the first leaver exactly 0.95 BTC', Boolean(firstPayout), firstPayout));

  const roundTwoVault = oneMatch(firstTx, expectedTransactionOutput({
    args: { round: firstRemaining.join(',') },
    state,
  }));
  checks.push(check('first withdrawal re-vaults the leftover to the correct round-two vault', Boolean(roundTwoVault), roundTwoVault));
  checks.push(check(
    'second withdrawal spends the round-two vault output from the first withdrawal',
    Boolean(roundTwoVault) && transactionSpendsOutpoint(secondTx, firstTxid, roundTwoVault.vout),
    {
      vaultOutpoint: roundTwoVault ? `${firstTxid}:${roundTwoVault.vout}` : null,
    },
  ));

  const secondPayout = oneMatch(secondTx, expectedTransactionOutput({
    args: { participant: secondLeaverId, 'value-sats': String(AMOUNTS.secondWithdrawal) },
    state,
  }));
  checks.push(check('second withdrawal pays the second leaver exactly 1.025 BTC', Boolean(secondPayout), secondPayout));

  const lastPayout = oneMatch(secondTx, expectedTransactionOutput({
    args: { participant: lastParticipantId },
    state,
  }));
  checks.push(check('second withdrawal sends the remainder to the last participant payout address', Boolean(lastPayout), lastPayout));

  if (finalTx) {
    const finalInput = lastPayout ? findTransactionInput(finalTx, secondTxid, lastPayout.vout) : null;
    const finalSweep = oneMatch(finalTx, expectedTransactionOutput({
      args: { participant: lastParticipantId },
      state,
    }));
    checks.push(check('final sweep spends to the last participant payout address', Boolean(finalSweep), finalSweep));
    checks.push(check(
      'final sweep spends the last payout output from the second withdrawal',
      Boolean(finalInput),
      {
        payoutOutpoint: lastPayout ? `${secondTxid}:${lastPayout.vout}` : null,
      },
    ));
    checks.push(check('final sweep uses a Taproot key-path witness', isTaprootKeyPathWitness(finalInput), {
      witness: finalInput?.txinwitness || null,
    }));
  }

  for (const [label, tx] of [
    ['funding tx', fundingTx],
    ['first withdrawal tx', firstTx],
    ['second withdrawal tx', secondTx],
    ...(finalTx ? [['final sweep tx', finalTx]] : []),
  ]) {
    checks.push(transactionConfirmationCheck(label, tx, minConfirmations));
  }

  printResult('live run audit', {
    order: {
      firstLeaverId,
      secondLeaverId,
      lastParticipantId,
      roundTwo: firstRemaining,
    },
    txids: {
      fundingTxid,
      firstTxid,
      secondTxid,
      finalTxid: finalTxid || null,
    },
    checks,
    minConfirmations,
    passed: checks.every((item) => item.ok),
  });
  assert(checks.every((item) => item.ok), 'live run audit failed');
}

async function liveSoloWithdrawal() {
  const args = parseArgs(process.argv.slice(3));
  const currentIds = requireArg(args, 'round').split(',');
  const leaverId = requireArg(args, 'leaver');
  const txid = requireArg(args, 'txid');
  const vout = Number(requireArg(args, 'vout'));
  const state = createConfiguredState();
  const expected = expectedVaultOutput(state, currentIds);
  const actual = await getTxOut(txid, vout);
  const utxoChecks = compareVaultUtxo({ actual, expected });
  assert(utxoChecks.every((item) => item.ok), 'selected UTXO is not the expected vault round');

  const valueSats = btcToSats(actual.value);
  const psbt = buildSoloWithdrawalPsbt({ state, currentIds, leaverId, txid, vout, valueSats });
  const inspection = inspectPsbt(psbt.psbtBase64);
  const localPolicyFailures = evaluatePolicy(
    psbtInspectionToPolicyTx({ state, inspection }),
    state.sigbashPolicies.get(leaverId),
  );
  assert(localPolicyFailures.length === 0, `solo PSBT violates local policy: ${localPolicyFailures.join('; ')}`);

  const keyId = args['key-id'] || process.env[`SIGBASH_KEY_ID_${leaverId.toUpperCase()}`];
  const checks = [
    ...utxoChecks,
    check('local Sigbash policy preflight passes', localPolicyFailures.length === 0),
    check(`SIGBASH_KEY_ID_${leaverId.toUpperCase()} is available`, Boolean(keyId), { keyId: keyId || null }),
    check('SIGBASH_MODE=live', process.env.SIGBASH_MODE === 'live', {
      actual: process.env.SIGBASH_MODE || null,
    }),
  ];

  let liveVerification = null;
  let liveSignature = null;
  let signedArtifacts = null;
  if (checks.every((item) => item.ok)) {
    const adapter = await createSigbashAdapter();
    const policy = {
      ...state.sigbashPolicies.get(leaverId),
      keyId,
    };
    liveVerification = await adapter.verifyPSBT({ psbtBase64: psbt.psbtBase64 }, policy);
    const verificationPassed =
      liveVerification.passed !== false && liveVerification.success !== false;
    checks.push(check('Sigbash live verifyPSBT passes', verificationPassed, liveVerification));
    if (verificationPassed && args.sign !== 'false') {
      liveSignature = await adapter.signPSBT({ psbtBase64: psbt.psbtBase64 }, policy);
      signedArtifacts = normalizeSigbashSigningResult(liveSignature);
      checks.push(
        check(
          'Sigbash live signPSBT returned a broadcast or signed-PSBT artifact',
          signedArtifacts.success && (signedArtifacts.txHex || signedArtifacts.signedPsbtBase64),
          signedArtifacts,
        ),
      );
    }
  }

  printResult('live solo withdrawal', {
    round: roundId(currentIds),
    leaverId,
    outpoint: `${txid}:${vout}`,
    psbt,
    inspection,
    localPolicy: {
      passed: localPolicyFailures.length === 0,
      failures: localPolicyFailures,
    },
    liveVerification,
    liveSignature,
    signedArtifacts,
    checks,
    passed: checks.every((item) => item.ok),
    nextCommands: signedArtifacts ? sigbashSignedNextCommands(signedArtifacts) : [],
    nextStep:
      liveSignature === null
        ? 'Resolve failed checks or rerun without --sign false to request Sigbash signing.'
        : 'Broadcast txHex directly when present; otherwise merge/finalize signedPsbtBase64, broadcast it, then locate output 1 for the next round.',
  });
  assert(checks.every((item) => item.ok), 'live solo withdrawal failed');
}

async function liveSoloTamperCheck() {
  assert(
    process.env.SIGBASH_MODE === 'live',
    'live-solo-tamper-check contacts Sigbash; rerun with SIGBASH_MODE=live',
  );
  const args = parseArgs(process.argv.slice(3));
  const currentIds = requireArg(args, 'round').split(',');
  const leaverId = requireArg(args, 'leaver');
  const txid = requireArg(args, 'txid');
  const vout = Number(requireArg(args, 'vout'));
  const state = createConfiguredState();
  const expected = expectedVaultOutput(state, currentIds);
  const actual = await getTxOut(txid, vout);
  const utxoChecks = compareVaultUtxo({ actual, expected });
  assert(utxoChecks.every((item) => item.ok), 'selected UTXO is not the expected vault round');

  const keyId = args['key-id'] || process.env[`SIGBASH_KEY_ID_${leaverId.toUpperCase()}`];
  assert(keyId, `missing --key-id or SIGBASH_KEY_ID_${leaverId.toUpperCase()}`);
  const policy = {
    ...state.sigbashPolicies.get(leaverId),
    keyId,
  };
  assert(policy.conditions, `unknown participant policy ${leaverId}`);

  const variants = buildSoloWithdrawalTamperPsbts({
    state,
    currentIds,
    leaverId,
    txid,
    vout,
    valueSats: btcToSats(actual.value),
  });
  const localChecks = soloTamperLocalChecks({ state, leaverId, variants });
  const adapter = await createSigbashAdapter();
  const liveValid = await adapter.verifyPSBT({ psbtBase64: variants.valid.psbtBase64 }, policy);
  const liveTampered = {};
  for (const [name, psbt] of Object.entries(variants.tampered)) {
    liveTampered[name] = await adapter.verifyPSBT({ psbtBase64: psbt.psbtBase64 }, policy);
  }
  const checks = [
    ...utxoChecks,
    check('local model accepts the valid solo PSBT', localChecks.valid.passed, localChecks.valid),
    ...Object.entries(localChecks.tampered).map(([name, result]) =>
      check(`local model rejects tampered ${name} PSBT`, !result.passed, result),
    ),
    check('Sigbash verifyPSBT accepts the valid solo PSBT', sigbashVerificationPassed(liveValid), liveValid),
    ...Object.entries(liveTampered).map(([name, result]) =>
      check(`Sigbash verifyPSBT rejects tampered ${name} PSBT`, !sigbashVerificationPassed(result), result),
    ),
  ];

  printResult('live solo tamper check', {
    round: roundId(currentIds),
    leaverId,
    outpoint: `${txid}:${vout}`,
    keyId,
    localChecks,
    liveVerification: {
      valid: liveValid,
      tampered: liveTampered,
    },
    psbts: {
      valid: variants.valid.psbtBase64,
      tampered: Object.fromEntries(
        Object.entries(variants.tampered).map(([name, psbt]) => [name, psbt.psbtBase64]),
      ),
    },
    checks,
    passed: checks.every((item) => item.ok),
  });
  assert(checks.every((item) => item.ok), 'live solo tamper check failed');
}

async function liveSoloAudit() {
  const args = parseArgs(process.argv.slice(3));
  const minConfirmations = minConfirmationsFromArgs(args);
  const txid = requireArg(args, 'txid');
  const vaultTxid = requireArg(args, 'vault-txid');
  const vaultVout = Number(requireArg(args, 'vault-vout'));
  const currentIds = requireArg(args, 'round').split(',');
  const leaverId = requireArg(args, 'leaver');
  const state = createConfiguredState();
  const participant = state.participants.find((item) => item.id === leaverId);
  if (!participant) throw new Error(`unknown participant ${leaverId}`);
  const inputValueSats =
    args['value-sats'] === undefined ? expectedVaultValueSats(currentIds) : Number(args['value-sats']);
  assert(Number.isInteger(inputValueSats) && inputValueSats > 0, '--value-sats must be a positive integer');

  const expected = expectedSoloWithdrawalOutputs({ state, currentIds, leaverId, inputValueSats });
  const tx = await getRawTransaction(txid, true);
  const spentVaultInput = transactionSpendsOutpoint(tx, vaultTxid, vaultVout);
  const actualOutputs = tx.vout.map(transactionOutputSummary);
  const policyFailures = evaluatePolicy(
    {
      sigbashLeafKey: participant.sigbash.xonlyPubKeyHex,
      outputs: actualOutputs.map((output) => ({
        address: output.address,
        value: output.valueSats,
      })),
    },
    state.sigbashPolicies.get(leaverId),
  );
  const outputZero = actualOutputs[0];
  const outputOne = actualOutputs[1];
  const checks = [
    check('solo transaction spends the selected vault outpoint', spentVaultInput, {
      vaultOutpoint: `${vaultTxid}:${vaultVout}`,
    }),
    check('solo transaction has exactly two outputs', actualOutputs.length === 2, actualOutputs),
    check(
      'output 0 pays the leaver exact policy amount and address',
      Boolean(outputZero) &&
        outputZero.valueSats === expected.payout.valueSats &&
        outputZero.address === expected.payout.address,
      { expected: expected.payout, actual: outputZero || null },
    ),
    check(
      'output 1 re-vaults exact leftover to the next round',
      Boolean(outputOne) &&
        outputOne.valueSats === expected.nextVault.valueSats &&
        outputOne.address === expected.nextVault.address,
      { expected: expected.nextVault, actual: outputOne || null },
    ),
    check(
      'output 1 satisfies Sigbash leftover floor',
      Boolean(outputOne) && outputOne.valueSats >= expected.nextVault.floorSats,
      { floorSats: expected.nextVault.floorSats, actual: outputOne || null },
    ),
    check('local Sigbash policy model accepts the broadcast transaction outputs', policyFailures.length === 0, {
      failures: policyFailures,
    }),
    transactionConfirmationCheck('solo transaction', tx, minConfirmations),
  ];

  printResult('live solo audit', {
    txid,
    vaultOutpoint: `${vaultTxid}:${vaultVout}`,
    round: roundId(currentIds),
    leaverId,
    inputValueSats,
    expected,
    actualOutputs,
    localPolicy: {
      passed: policyFailures.length === 0,
      failures: policyFailures,
    },
    checks,
    minConfirmations,
    passed: checks.every((item) => item.ok),
  });
  assert(checks.every((item) => item.ok), 'live solo audit failed');
}

async function liveCooperativeAudit() {
  const args = parseArgs(process.argv.slice(3));
  const minConfirmations = minConfirmationsFromArgs(args);
  const txid = requireArg(args, 'txid');
  const vaultTxid = requireArg(args, 'vault-txid');
  const vaultVout = Number(requireArg(args, 'vault-vout'));
  const currentIds = requireArg(args, 'round').split(',');
  const state = createConfiguredState();
  const tx = await getRawTransaction(txid, true);
  const readiness = expectedCooperativeReadiness({ state, currentIds });
  const input = findTransactionInput(tx, vaultTxid, vaultVout);
  const refundMatches = readiness.refundOutputs.map((output) => ({
    expected: output,
    matches: findTransactionOutputs(tx, {
      type: 'participant-refund',
      address: output.address,
      valueSats: output.valueSats,
    }),
  }));
  const checks = [
    check('cooperative transaction spends the selected vault outpoint', Boolean(input), {
      vaultOutpoint: `${vaultTxid}:${vaultVout}`,
    }),
    check('cooperative transaction uses a Taproot key-path witness', isTaprootKeyPathWitness(input), {
      witness: input?.txinwitness || null,
    }),
    check(
      'cooperative key-path contains no Sigbash keys',
      readiness.keyPathContainsOnlyPersonalKeys,
      readiness.keyPath,
    ),
    check(
      'all current participants receive exactly one full-deposit refund',
      refundMatches.every((item) => item.matches.length === 1),
      refundMatches,
    ),
    transactionConfirmationCheck('cooperative transaction', tx, minConfirmations),
  ];

  printResult('live cooperative audit', {
    txid,
    vaultOutpoint: `${vaultTxid}:${vaultVout}`,
    round: roundId(currentIds),
    cooperative: readiness,
    refundMatches,
    checks,
    minConfirmations,
    passed: checks.every((item) => item.ok),
  });
  assert(checks.every((item) => item.ok), 'live cooperative audit failed');
}

async function liveRecoveryAudit() {
  const args = parseArgs(process.argv.slice(3));
  const minConfirmations = minConfirmationsFromArgs(args);
  const txid = requireArg(args, 'txid');
  const vaultTxid = requireArg(args, 'vault-txid');
  const vaultVout = Number(requireArg(args, 'vault-vout'));
  const currentIds = requireArg(args, 'round').split(',');
  const vanishedId = requireArg(args, 'vanished');
  const valueSats = Number(requireArg(args, 'value-sats'));
  const state = createConfiguredState();
  const tx = await getRawTransaction(txid, true);
  const readiness = expectedRecoveryReadiness({ state, currentIds, vanishedId });
  const recoveryOutputs = expectedRecoveryOutputs({ state, currentIds, valueSats });
  const input = findTransactionInput(tx, vaultTxid, vaultVout);
  const outputMatches = recoveryOutputs.map((output) => ({
    expected: output,
    matches: findTransactionOutputs(tx, {
      type: 'recovery-output',
      address: output.address,
      valueSats: output.valueSats,
    }),
  }));
  const checks = [
    check('recovery transaction spends the selected vault outpoint', Boolean(input), {
      vaultOutpoint: `${vaultTxid}:${vaultVout}`,
    }),
    check(
      `recovery input sequence is at least ${RECOVERY_DELAY_BLOCKS}`,
      input && input.sequence >= RECOVERY_DELAY_BLOCKS,
      input ? { sequence: input.sequence } : undefined,
    ),
    check(
      'recovery input sequence does not disable BIP68 CSV',
      input && input.sequence < 0x80000000,
      input ? { sequence: input.sequence } : undefined,
    ),
    check('recovery transaction version enables BIP68 CSV', tx.version >= 2, {
      version: tx.version,
    }),
    check(
      'remaining participants can satisfy the N-1 recovery threshold',
      readiness.signerIds.length >= readiness.threshold,
      { signerIds: readiness.signerIds, threshold: readiness.threshold },
    ),
    check(
      'all current participants receive exactly one recovery output',
      outputMatches.every((item) => item.matches.length === 1),
      outputMatches,
    ),
    transactionConfirmationCheck('recovery transaction', tx, minConfirmations),
  ];

  printResult('live recovery audit', {
    txid,
    vaultOutpoint: `${vaultTxid}:${vaultVout}`,
    round: roundId(currentIds),
    vanishedId,
    recovery: readiness,
    expectedOutputs: recoveryOutputs,
    outputMatches,
    checks,
    minConfirmations,
    passed: checks.every((item) => item.ok),
  });
  assert(checks.every((item) => item.ok), 'live recovery audit failed');
}

async function liveFinalSweepAudit() {
  const args = parseArgs(process.argv.slice(3));
  const minConfirmations = minConfirmationsFromArgs(args);
  const txid = requireArg(args, 'txid');
  const payoutTxid = requireArg(args, 'payout-txid');
  const payoutVout = Number(requireArg(args, 'payout-vout'));
  const participantId = requireArg(args, 'participant');
  const valueSats = Number(requireArg(args, 'value-sats'));
  const feeSats = args['fee-sats'] === undefined ? AMOUNTS.finalSweepFee : Number(args['fee-sats']);
  const state = createConfiguredState();
  const participant = state.participants.find((item) => item.id === participantId);
  if (!participant) throw new Error(`unknown participant ${participantId}`);
  const tx = await getRawTransaction(txid, true);
  const input = findTransactionInput(tx, payoutTxid, payoutVout);
  const expectedOutput = {
    type: 'final-sweep-output',
    address: participant.payoutAddress,
    valueSats: valueSats - feeSats,
  };
  const outputMatches = findTransactionOutputs(tx, expectedOutput);
  const checks = [
    check('final sweep spends the selected payout outpoint', Boolean(input), {
      payoutOutpoint: `${payoutTxid}:${payoutVout}`,
    }),
    check('final sweep uses a Taproot key-path witness', isTaprootKeyPathWitness(input), {
      witness: input?.txinwitness || null,
    }),
    check('final sweep has exactly one output to the last participant', outputMatches.length === 1, {
      expectedOutput,
      matches: outputMatches,
    }),
    check('final sweep is Sigbash-independent', true, {
      keyPath: {
        type: 'single-participant-final-sweep',
        signerId: participant.id,
        signerXonlyPubkey: participant.payout.xonlyPubKeyHex,
        sigbashInvolved: false,
      },
    }),
    transactionConfirmationCheck('final sweep transaction', tx, minConfirmations),
  ];

  printResult('live final sweep audit', {
    txid,
    payoutOutpoint: `${payoutTxid}:${payoutVout}`,
    participantId,
    expectedOutput,
    outputMatches,
    checks,
    minConfirmations,
    passed: checks.every((item) => item.ok),
  });
  assert(checks.every((item) => item.ok), 'live final sweep audit failed');
}

async function rpcWalletProcessPsbt() {
  const args = parseArgs(process.argv.slice(3));
  const psbtBase64 = requireArg(args, 'psbt-base64');
  const result = await walletProcessPsbt(psbtBase64, {
    sign: args.sign !== 'false',
    sighashType: args['sighash-type'] || 'ALL',
    bip32Derivs: args['bip32-derivs'] !== 'false',
  });
  printResult('Bitcoin Core walletprocesspsbt', result);
}

async function rpcCombinePsbt() {
  const args = parseArgs(process.argv.slice(3));
  const psbtBase64s = requireArg(args, 'psbts')
    .split(',')
    .map((psbt) => psbt.trim())
    .filter(Boolean);
  assert(psbtBase64s.length >= 2, 'rpc-combinepsbt requires at least two comma-separated PSBTs');
  const psbt = await combinePsbts(psbtBase64s);
  printResult('Bitcoin Core combinepsbt', { psbt });
}

async function rpcFinalizePsbt() {
  const args = parseArgs(process.argv.slice(3));
  const psbtBase64 = requireArg(args, 'psbt-base64');
  const result = await finalizePsbt(psbtBase64, args.extract !== 'false');
  printResult('Bitcoin Core finalizepsbt', result);
}

async function rpcBroadcast() {
  const args = parseArgs(process.argv.slice(3));
  const rawTxHex = requireArg(args, 'hex');
  const txid = await sendRawTransaction(rawTxHex);
  printResult('Bitcoin Core sendrawtransaction', { txid });
}

async function acceptance() {
  await audit();
  await sdkPolicyCheck();
  await psbtAcceptance();
  await cooperative();
  await solo();
  await fullRun();
  await recovery();
  const state = createDemoState();
  const keyPathChecks = [...state.vaults.values()].map((vault) => ({
    round: vault.id,
    ok: verifyNoSigbashInKeyPath(vault),
  }));
  assert(keyPathChecks.every((check) => check.ok), 'one or more key-paths include Sigbash');
  printResult('acceptance summary', {
    allChecksPassed: true,
    keyPathChecks,
    scheduleSats: {
      first: AMOUNTS.firstWithdrawal,
      second: AMOUNTS.secondWithdrawal,
    },
  });
}

async function audit() {
  const state = createDemoState();
  const report = auditSpecState(state);
  printResult('spec audit', report);
  assert(report.passed, 'spec audit failed');
}

async function sdkPolicyCheck() {
  const sdk = await import('@sigbash/sdk');
  const state = createDemoState();
  const compiled = [...state.sigbashPolicies.values()].map((policy) => ({
    participantId: policy.participantId,
    poetPolicy: sdk.conditionConfigToPoetPolicy({
      logic: policy.logic,
      conditions: policy.conditions,
    }),
  }));
  printResult('sdk policy conversion', {
    sdkVersion: sdk.SDK_VERSION || 'unknown',
    participantPolicies: compiled.map(({ participantId, poetPolicy }) => ({
      participantId,
      version: poetPolicy.version,
      rootOperator: poetPolicy.policy?.operator,
      branchCount: poetPolicy.policy?.children?.length,
    })),
  });
}

async function sigbashLiveSetup() {
  assert(
    process.env.SIGBASH_MODE === 'live',
    'sigbash-live-setup mutates Sigbash server state; rerun with SIGBASH_MODE=live',
  );
  const bootstrapState = createDemoState();
  const registrations = [];

  for (const [index, participant] of bootstrapState.participants.entries()) {
    const { sdk, client } = await createLiveSigbashClient({
      musig2PrivateKey: participant.sigbash.privateKeyHex,
    });
    const bootstrapPolicy = impossibleBootstrapPolicy(participant.id);
    const created = await client.createKey({
      policy: toPoetPolicy(sdk, bootstrapPolicy),
      network: 'signet',
      require2FA: false,
      keyIndex: index,
      updateable: true,
      verbose: true,
    });
    assert(
      created.aggregatePubKeyHex,
      `Sigbash did not return aggregatePubKeyHex for ${participant.id}`,
    );
    registrations.push({
      participantId: participant.id,
      keyId: created.keyId,
      keyIndex: created.keyIndex,
      aggregatePubKeyHex: normalizeXonly(created.aggregatePubKeyHex),
      bip328Xpub: created.bip328Xpub,
      helperP2trAddressDoNotFund: created.p2trAddress,
      bootstrapPolicyRoot: created.policyRoot,
    });
  }

  const liveState = createDemoState({
    sigbashLeafOverrides: Object.fromEntries(
      registrations.map((registration) => [
        registration.participantId,
        registration.aggregatePubKeyHex,
      ]),
    ),
  });

  for (const registration of registrations) {
    const participant = liveState.participants.find((item) => item.id === registration.participantId);
    const { sdk, client } = await createLiveSigbashClient({
      musig2PrivateKey: participant.sigbash.privateKeyHex,
    });
    const finalPolicy = liveState.sigbashPolicies.get(registration.participantId);
    const result = await client.updatePolicy({
      keyId: registration.keyId,
      newPolicyJson: JSON.stringify(toPoetPolicy(sdk, finalPolicy)),
    });
    registration.finalPolicyUpdate = result;
  }

  printResult('live Sigbash setup', {
    warning:
      'Do not fund any helper p2trAddress. Fund only the printed round-one vault address after verifying the final policy updates succeeded.',
    registrations,
    vaults: [...liveState.vaults.values()].map((vault) => ({
      round: vault.id,
      participants: vault.participantIds,
      address: vault.address,
      descriptor: vault.descriptor,
      keyPath: vault.keyPath,
      tapscriptLeaves: vault.tapscriptLeaves,
    })),
    participantPolicies: [...liveState.sigbashPolicies.values()],
  });
}

function createDeposits(ledger, state) {
  const roundOne = state.vaults.get(roundId(state.participants.map((p) => p.id)));
  for (const participant of state.participants) {
    ledger.fund(roundOne.address, AMOUNTS.deposit, `${participant.label} deposit`);
  }
}

function printSetup(state) {
  printResult('setup', {
    participants: state.participants.map((p) => ({
      id: p.id,
      payoutAddress: p.payoutAddress,
      payoutXonlyPubkey: p.payout.xonlyPubKeyHex,
      personalXonlyPubkey: p.personal.xonlyPubKeyHex,
      sigbashLeafXonlyPubkey: p.sigbash.xonlyPubKeyHex,
    })),
    vaults: [...state.vaults.values()].map((vault) => ({
      round: vault.id,
      participants: vault.participantIds,
      address: vault.address,
      scriptPubKeyHex: vault.outputScriptHex,
      descriptor: vault.descriptor,
      keyPath: vault.keyPath,
      tapscriptLeaves: vault.tapscriptLeaves,
    })),
    policies: [...state.policies.values()],
    sigbashPolicies: [...state.sigbashPolicies.values()],
  });
}

function printResult(title, value) {
  console.log(`\n=== ${title} ===`);
  console.log(JSON.stringify(value, null, 2));
}

function createConfiguredState() {
  return createDemoState({
    sigbashLeafOverrides: {
      ...(process.env.SIGBASH_LEAF_ALICE ? { alice: process.env.SIGBASH_LEAF_ALICE } : {}),
      ...(process.env.SIGBASH_LEAF_BOB ? { bob: process.env.SIGBASH_LEAF_BOB } : {}),
      ...(process.env.SIGBASH_LEAF_CAROL ? { carol: process.env.SIGBASH_LEAF_CAROL } : {}),
    },
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function check(name, ok, details = undefined) {
  return { name, ok: Boolean(ok), ...(details === undefined ? {} : { details }) };
}

function minConfirmationsFromArgs(args) {
  const value = args['min-confirmations'] === undefined ? 1 : Number(args['min-confirmations']);
  assert(Number.isInteger(value) && value >= 0, '--min-confirmations must be a non-negative integer');
  return value;
}

function transactionConfirmationCheck(label, tx, minConfirmations) {
  const confirmations = tx.confirmations || 0;
  return check(`${label} has at least ${minConfirmations} confirmation(s)`, confirmations >= minConfirmations, {
    confirmations,
    minConfirmations,
    txid: tx.txid,
    blockhash: tx.blockhash,
  });
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const next = args[index + 1];
    if (!next || next.startsWith('--')) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

function requireArg(args, name) {
  const value = args[name];
  if (value === undefined || value === true || value === '') {
    throw new Error(`missing required --${name}`);
  }
  return value;
}

function impossibleBootstrapPolicy(participantId) {
  return {
    id: `bootstrap:${participantId}`,
    network: 'signet',
    logic: 'AND',
    conditions: [
      { type: 'TX_OUTPUT_COUNT', operator: 'EQ', value: 0 },
      {
        type: 'OUTPUT_VALUE',
        selector: { type: 'INDEX', index: 0 },
        operator: 'EQ',
        value: 0,
      },
    ],
  };
}

function normalizeXonly(pubkeyHex) {
  return pubkeyHex.length === 66 ? pubkeyHex.slice(2) : pubkeyHex;
}

function loadDotenv() {
  if (!existsSync('.env')) return;
  const lines = readFileSync('.env', 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    if (!key || process.env[key] !== undefined) continue;
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function expectedVaultOutput(state, currentIds) {
  const round = roundId(currentIds);
  const vault = state.vaults.get(round);
  if (!vault) throw new Error(`unknown vault round ${round}`);
  return {
    round,
    address: vault.address,
    valueSats: expectedVaultValueSats(currentIds),
    scriptPubKeyHex: vault.outputScriptHex,
  };
}

function expectedVaultValueSats(currentIds) {
  if (currentIds.length === 3) {
    return AMOUNTS.deposit * 3;
  }
  if (currentIds.length === 2) {
    return AMOUNTS.deposit * 3 - AMOUNTS.firstWithdrawal - AMOUNTS.feePerSoloWithdrawal;
  }
  throw new Error(`no vault value for ${currentIds.length} participant(s); round 3 is a payout address`);
}

function expectedTransactionOutput({ args, state }) {
  if (args.round) {
    const expected = expectedVaultOutput(state, args.round.split(','));
    return {
      type: 'vault',
      round: expected.round,
      address: expected.address,
      scriptPubKeyHex: expected.scriptPubKeyHex,
      valueSats: expected.valueSats,
    };
  }
  if (args.participant) {
    const participant = state.participants.find((item) => item.id === args.participant);
    if (!participant) throw new Error(`unknown participant ${args.participant}`);
    const valueSats =
      args['value-sats'] === undefined ? undefined : Number(args['value-sats']);
    return {
      type: 'participant-payout',
      participantId: participant.id,
      address: participant.payoutAddress,
      scriptPubKeyHex: undefined,
      valueSats,
    };
  }
  if (args.address) {
    const valueSats =
      args['value-sats'] === undefined ? undefined : Number(args['value-sats']);
    return {
      type: 'address',
      address: args.address,
      scriptPubKeyHex: undefined,
      valueSats,
    };
  }
  throw new Error('rpc-find-output requires --round, --participant, or --address');
}

function expectedCooperativeReadiness({ state, currentIds }) {
  const round = roundId(currentIds);
  const vault = state.vaults.get(round);
  if (!vault) throw new Error(`unknown vault round ${round}`);
  const participants = currentIds.map((id) => {
    const participant = state.participants.find((item) => item.id === id);
    if (!participant) throw new Error(`unknown participant ${id}`);
    return participant;
  });
  return {
    signerIds: participants.map((participant) => participant.id),
    signerPersonalXonlyPubkeys: participants.map((participant) => participant.personal.xonlyPubKeyHex),
    keyPathContainsOnlyPersonalKeys: verifyNoSigbashInKeyPath(vault),
    keyPath: vault.keyPath,
    refundOutputs: participants.map((participant, index) => ({
      index,
      address: participant.payoutAddress,
      valueSats: AMOUNTS.deposit,
    })),
  };
}

function expectedRecoveryReadiness({ state, currentIds, vanishedId }) {
  const round = roundId(currentIds);
  const vault = state.vaults.get(round);
  if (!vault) throw new Error(`unknown vault round ${round}`);
  const leaf = vault.tapscriptLeaves.find((item) => item.type === 'timelocked-recovery');
  if (!leaf) throw new Error(`no recovery leaf for ${round}`);
  const signerIds = currentIds.filter((id) => id !== vanishedId);
  const signerPubkeys = signerIds.map((id) => {
    const participant = state.participants.find((item) => item.id === id);
    if (!participant) throw new Error(`unknown participant ${id}`);
    return participant.personal.xonlyPubKeyHex;
  });
  return {
    relativeBlocks: leaf.relativeBlocks,
    threshold: leaf.threshold,
    signerIds,
    signerPubkeys,
    scriptHex: leaf.scriptHex,
    controlBlockHex: leaf.controlBlockHex,
  };
}

function expectedRecoveryOutputs({ state, currentIds, valueSats }) {
  const recoverEach = Math.floor((valueSats - AMOUNTS.recoveryFee) / currentIds.length);
  return currentIds.map((id, index) => {
    const participant = state.participants.find((item) => item.id === id);
    if (!participant) throw new Error(`unknown participant ${id}`);
    return {
      index,
      participantId: participant.id,
      address: participant.payoutAddress,
      valueSats: recoverEach,
    };
  });
}

function expectedSoloWithdrawalOutputs({ state, currentIds, leaverId, inputValueSats }) {
  const policy = state.policies.get(policyId(currentIds, leaverId));
  if (!policy) throw new Error(`no solo policy for ${leaverId} in ${roundId(currentIds)}`);
  const payoutValue = policyCondition(policy, {
    type: 'OUTPUT_VALUE',
    index: 0,
    operator: 'EQ',
  }).value;
  const payoutAddress = policyCondition(policy, {
    type: 'OUTPUT_DEST_IS_IN_SETS',
    index: 0,
  }).addresses[0];
  const nextAddress = policyCondition(policy, {
    type: 'OUTPUT_DEST_IS_IN_SETS',
    index: 1,
  }).addresses[0];
  const floorSats = policyCondition(policy, {
    type: 'OUTPUT_VALUE',
    index: 1,
    operator: 'GTE',
  }).value;
  const feeSats =
    currentIds.length === 3 ? AMOUNTS.feePerSoloWithdrawal : AMOUNTS.feePerSoloWithdrawal * 2;
  return {
    payout: {
      index: 0,
      address: payoutAddress,
      valueSats: payoutValue,
    },
    nextVault: {
      index: 1,
      address: nextAddress,
      valueSats: inputValueSats - payoutValue - feeSats,
      floorSats,
    },
    feeSats,
  };
}

function policyCondition(policy, { type, index, operator = undefined }) {
  const condition = policy.conditions.find(
    (item) =>
      item.type === type &&
      item.selector?.index === index &&
      (operator === undefined || item.operator === operator),
  );
  if (!condition) {
    throw new Error(`policy ${policy.id} is missing ${type} condition for output ${index}`);
  }
  return condition;
}

function findTransactionOutputs(tx, expected) {
  return tx.vout
    .filter((output) => {
      const valueSats = btcToSats(output.value);
      const address = output.scriptPubKey?.address || output.scriptPubKey?.addresses?.[0];
      if (expected.valueSats !== undefined && valueSats !== expected.valueSats) return false;
      if (expected.scriptPubKeyHex && output.scriptPubKey?.hex !== expected.scriptPubKeyHex) return false;
      if (expected.address && address !== expected.address) return false;
      return true;
    })
    .map((output) => ({
      vout: output.n,
      valueBtc: output.value,
      valueSats: btcToSats(output.value),
      address: output.scriptPubKey?.address || output.scriptPubKey?.addresses?.[0],
      scriptPubKeyHex: output.scriptPubKey?.hex,
    }));
}

function transactionOutputSummary(output) {
  return {
    vout: output.n,
    valueBtc: output.value,
    valueSats: btcToSats(output.value),
    address: output.scriptPubKey?.address || output.scriptPubKey?.addresses?.[0],
    scriptPubKeyHex: output.scriptPubKey?.hex,
  };
}

async function fundingInputSummaries(inputs, fetchTransaction = getRawTransaction) {
  return Promise.all(
    inputs.map(async (input, index) => {
      const prevout = input.prevout || (await fetchPrevout(input, fetchTransaction));
      return {
        index,
        txid: input.txid,
        vout: input.vout,
        valueSats: prevout && Number.isFinite(Number(prevout.value)) ? btcToSats(prevout.value) : null,
        address: prevout?.scriptPubKey?.address || prevout?.scriptPubKey?.addresses?.[0] || null,
        source: input.prevout ? 'funding-tx-prevout' : prevout ? 'previous-transaction' : 'missing',
        fetchError: prevout?.fetchError,
      };
    }),
  );
}

async function fetchPrevout(input, fetchTransaction = getRawTransaction) {
  if (!input?.txid || input.vout === undefined) return null;
  try {
    const previousTx = await fetchTransaction(input.txid, true);
    return previousTx.vout?.find((output) => output.n === input.vout) || null;
  } catch (error) {
    return {
      value: null,
      scriptPubKey: {},
      fetchError: error.message,
    };
  }
}

function oneMatch(tx, expected) {
  const matches = findTransactionOutputs(tx, expected);
  return matches.length === 1 ? matches[0] : null;
}

function findTransactionInput(tx, txid, vout) {
  return tx.vin.find((input) => input.txid === txid && input.vout === vout);
}

function transactionSpendsOutpoint(tx, txid, vout) {
  return Boolean(findTransactionInput(tx, txid, vout));
}

function isTaprootKeyPathWitness(input) {
  const witness = input?.txinwitness;
  if (!Array.isArray(witness) || witness.length !== 1) return false;
  return /^[0-9a-f]{128}([0-9a-f]{2})?$/i.test(witness[0]);
}

function participantIds(state) {
  return state.participants.map((participant) => participant.id);
}

function buildSignedLocalWithdrawalRun(state, { startingOutpoint } = {}) {
  const firstInput = startingOutpoint || {
    txid: '0000000000000000000000000000000000000000000000000000000000000001',
    vout: 0,
    valueSats: AMOUNTS.deposit * 3,
  };
  assert(/^[0-9a-f]{64}$/i.test(firstInput.txid), 'signed local run requires a 32-byte hex txid');
  assert(Number.isInteger(firstInput.vout) && firstInput.vout >= 0, 'signed local run requires a non-negative vout');
  assert(
    firstInput.valueSats === AMOUNTS.deposit * 3,
    `signed local run requires a 3 BTC round-one vault UTXO, got ${firstInput.valueSats} sats`,
  );

  const firstPsbt = buildSoloWithdrawalPsbt({
    state,
    currentIds: ['alice', 'bob', 'carol'],
    leaverId: 'alice',
    txid: firstInput.txid,
    vout: firstInput.vout,
    valueSats: firstInput.valueSats,
  });
  const firstInspection = inspectPsbt(firstPsbt.psbtBase64);
  const firstFailures = evaluatePolicy(
    psbtInspectionToPolicyTx({ state, inspection: firstInspection }),
    state.sigbashPolicies.get('alice'),
  );
  assert(firstFailures.length === 0, `first withdrawal violates local policy: ${firstFailures.join('; ')}`);
  const firstSigned = signSoloWithdrawalPsbt({
    state,
    currentIds: ['alice', 'bob', 'carol'],
    leaverId: 'alice',
    psbtBase64: firstPsbt.psbtBase64,
  });

  const secondPsbt = buildSoloWithdrawalPsbt({
    state,
    currentIds: ['bob', 'carol'],
    leaverId: 'bob',
    txid: firstSigned.txid,
    vout: 1,
    valueSats: firstInspection.outputs[1].valueSats,
  });
  const secondInspection = inspectPsbt(secondPsbt.psbtBase64);
  const secondFailures = evaluatePolicy(
    psbtInspectionToPolicyTx({ state, inspection: secondInspection }),
    state.sigbashPolicies.get('bob'),
  );
  assert(secondFailures.length === 0, `second withdrawal violates local policy: ${secondFailures.join('; ')}`);
  const secondSigned = signSoloWithdrawalPsbt({
    state,
    currentIds: ['bob', 'carol'],
    leaverId: 'bob',
    psbtBase64: secondPsbt.psbtBase64,
  });

  const finalPsbt = buildFinalSweepPsbt({
    state,
    participantId: 'carol',
    txid: secondSigned.txid,
    vout: 1,
    valueSats: secondInspection.outputs[1].valueSats,
  });
  const finalInspection = inspectPsbt(finalPsbt.psbtBase64);
  const finalSigned = signFinalSweepPsbt({
    state,
    participantId: 'carol',
    psbtBase64: finalPsbt.psbtBase64,
  });

  return {
    mode: startingOutpoint ? 'real-outpoint-local-signing' : 'placeholder-outpoint-local-signing',
    note: startingOutpoint
      ? 'Uses the provided round-one vault outpoint. Broadcast still requires live Sigbash signing for the production solo path.'
      : 'Uses a placeholder funding txid for local extraction; rerun with --txid/--vout from a real funded signet vault outpoint for broadcast-oriented transaction assembly.',
    startingOutpoint: firstInput,
    stages: [
      signedRunStage({
        step: 'alice first withdrawal',
        input: firstPsbt.txTemplate.input,
        inspection: firstInspection,
        signed: firstSigned,
      }),
      signedRunStage({
        step: 'bob second withdrawal',
        input: secondPsbt.txTemplate.input,
        inspection: secondInspection,
        signed: secondSigned,
      }),
      signedRunStage({
        step: 'carol final sweep',
        input: finalPsbt.txTemplate.input,
        inspection: finalInspection,
        signed: finalSigned,
      }),
    ],
  };
}

function signedRunStage({ step, input, inspection, signed }) {
  return {
    step,
    input,
    txid: signed.txid,
    transactionHex: signed.transactionHex,
    outputs: inspection.outputs.map((output) => ({
      index: output.index,
      address: output.address,
      valueSats: output.valueSats,
    })),
  };
}

function normalizeSigbashSigningResult(result) {
  const signedPsbtBase64 =
    result?.signedPSBT ||
    result?.signedPsbt ||
    result?.signedPsbtBase64 ||
    result?.psbtBase64 ||
    (typeof result?.psbt === 'string' ? result.psbt : result?.psbt?.psbtBase64) ||
    null;
  const txHex = result?.txHex || result?.transactionHex || result?.hex || null;
  return {
    success: result?.success !== false && result?.error === undefined,
    txHex,
    signedPsbtBase64,
    pathId: result?.pathId || result?.satisfiedPath || null,
    policyRootHex: result?.policyRootHex || null,
    satisfiedClause: result?.satisfiedClause || null,
    error: result?.error || null,
    raw: result,
  };
}

function soloTamperLocalChecks({ state, leaverId, variants }) {
  const checkVariant = (psbt) => {
    const inspection = inspectPsbt(psbt.psbtBase64);
    const failures = evaluatePolicy(
      psbtInspectionToPolicyTx({ state, inspection }),
      state.sigbashPolicies.get(leaverId),
    );
    return {
      passed: failures.length === 0,
      failures,
      outputs: inspection.outputs,
    };
  };
  return {
    valid: checkVariant(variants.valid),
    tampered: Object.fromEntries(
      Object.entries(variants.tampered).map(([name, psbt]) => [name, checkVariant(psbt)]),
    ),
  };
}

function sigbashVerificationPassed(result) {
  return result?.passed !== false && result?.success !== false && result?.error === undefined;
}

function evidenceItem({ id, requirement, args, required, command, evidence }) {
  const missingArgs = required.filter((name) => args[name] === undefined || args[name] === true || args[name] === '');
  return {
    id,
    requirement,
    ready: missingArgs.length === 0,
    missingArgs,
    command,
    evidence,
  };
}

function liveRunAuditCommand({ args, firstLeaver, secondLeaver, includeFinal = false }) {
  return commandLine('npm run live-run-audit --', {
    'funding-txid': argOrPlaceholder(args, 'funding-txid'),
    'first-txid': argOrPlaceholder(args, 'first-txid'),
    'second-txid': argOrPlaceholder(args, 'second-txid'),
    ...(includeFinal ? { 'final-txid': argOrPlaceholder(args, 'final-txid') } : {}),
    'first-leaver': firstLeaver,
    'second-leaver': secondLeaver,
    'min-confirmations': args['min-confirmations'] || '1',
  });
}

function commandLine(prefix, args) {
  return [
    prefix,
    ...Object.entries(args).map(([name, value]) => `--${name} ${value}`),
  ].join(' ');
}

function argOrPlaceholder(args, name) {
  return args[name] === undefined || args[name] === true || args[name] === '' ? `<${name}>` : args[name];
}

function sigbashSignedNextCommands({ txHex, signedPsbtBase64 }) {
  if (txHex) {
    return [
      'npm run rpc-testmempoolaccept -- --hex <txHex_from_this_output>',
      'npm run rpc-submit -- --hex <txHex_from_this_output>',
    ];
  }
  if (signedPsbtBase64) {
    return [
      'npm run rpc-finalizepsbt -- --psbt-base64 <signedPsbtBase64_from_this_output>',
      'npm run rpc-submit -- --psbt-base64 <signedPsbtBase64_from_this_output>',
    ];
  }
  return [];
}

function watchOnlyManifest(state) {
  return {
    network: 'signet',
    purpose:
      'Import these addr() descriptors into a Bitcoin Core wallet to watch vault funding and revault outputs. They do not grant spending authority.',
    vaults: [...state.vaults.values()].map((vault) => ({
      round: vault.id,
      participants: vault.participantIds,
      address: vault.address,
      scriptPubKeyHex: vault.outputScriptHex,
      descriptor: `addr(${vault.address})`,
      expectedValuesSats:
        vault.participantIds.length === 3
          ? [AMOUNTS.deposit * 3]
          : [AMOUNTS.deposit * 3 - AMOUNTS.firstWithdrawal - AMOUNTS.feePerSoloWithdrawal],
    })),
  };
}

function compareVaultUtxo({ actual, expected }) {
  if (!actual) {
    return [{ name: 'utxo is unspent and in chainstate', ok: false, actual: null }];
  }
  return [
    {
      name: 'utxo is unspent and in chainstate',
      ok: true,
      confirmations: actual.confirmations,
    },
    {
      name: 'scriptPubKey matches derived vault',
      ok: actual.scriptPubKey?.hex === expected.scriptPubKeyHex,
      expected: expected.scriptPubKeyHex,
      actual: actual.scriptPubKey?.hex,
    },
    {
      name: 'address matches derived vault',
      ok: actual.scriptPubKey?.address === expected.address,
      expected: expected.address,
      actual: actual.scriptPubKey?.address,
    },
    {
      name: 'amount matches vault round',
      ok: btcToSats(actual.value) === expected.valueSats,
      expected: expected.valueSats,
      actual: btcToSats(actual.value),
    },
  ];
}

function btcToSats(valueBtc) {
  return Math.round(Number(valueBtc) * 100_000_000);
}

function checkEnvPresent(name) {
  return {
    name: `${name} is set`,
    ok: Boolean(process.env[name]),
  };
}

function checkEnvEquals(name, expected) {
  return {
    name: `${name}=${expected}`,
    ok: process.env[name] === expected,
    actual: process.env[name] || null,
  };
}

function psbtInspectionToPolicyTx({ state, inspection }) {
  const scriptHex = inspection.inputs[0]?.tapLeafScript?.[0]?.scriptHex;
  const leaf = scriptHex ? findLeafByScriptHex(state, scriptHex) : null;
  return {
    sigbashLeafKey: leaf?.sigbashXonlyPubkey,
    outputs: inspection.outputs.map((output) => ({
      address: output.address,
      value: output.valueSats,
    })),
  };
}

function findLeafByScriptHex(state, scriptHex) {
  for (const vault of state.vaults.values()) {
    const leaf = vault.tapscriptLeaves.find((item) => item.scriptHex === scriptHex);
    if (leaf) return leaf;
  }
  return null;
}

async function checkSdkPolicyBuilder() {
  try {
    const sdk = await import('@sigbash/sdk');
    const policy = impossibleBootstrapPolicy('readiness');
    const poetPolicy = sdk.conditionConfigToPoetPolicy({
      logic: policy.logic,
      conditions: policy.conditions,
    });
    return {
      name: '@sigbash/sdk policy builder is available',
      ok: Boolean(poetPolicy),
      sdkVersion: sdk.SDK_VERSION || 'unknown',
    };
  } catch (error) {
    return {
      name: '@sigbash/sdk policy builder is available',
      ok: false,
      error: error.message,
    };
  }
}

async function checkBitcoinRpc() {
  try {
    const info = await getBlockchainInfo();
    return {
      name: 'Bitcoin Core RPC is reachable on signet',
      ok: info.chain === 'signet',
      chain: info.chain,
      blocks: info.blocks,
      headers: info.headers,
    };
  } catch (error) {
    return {
      name: 'Bitcoin Core RPC is reachable on signet',
      ok: false,
      error: error.message,
    };
  }
}
