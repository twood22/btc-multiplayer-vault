// Loaded by cli.ts only after the protected operator environment is present.
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { assertReviewedNodeRuntime } from './runtime-version.js';
import { createSigbashCredentialFile } from './sigbash-credentials.js';
import { writeProtectedEnvironmentFile, writeProtectedFile } from './operator-environment.js';
import { createLiveSigbashProofReceipt, type LiveSigbashProofReceipt } from './live-proof-receipt.js';
import {
  AMOUNTS,
  DEFAULT_DEMO_SEED,
  DEMO_SEED,
  NETWORK,
  PARTICIPANTS,
  RECOVERY_DELAY_BLOCKS,
} from './config.js';
import { BITCOIN_CORE_CHAIN, DEFAULT_BITCOIN_RPC_URL } from './network.js';
import { auditSpecState } from './audit.js';
import { runBip327KeyAggVectors, verifyVaultTransaction } from './consensus.js';
import { runBip327ProtocolVectors } from './musig2-vectors.js';
import {
  ceremonyAggregate,
  ceremonyNonce,
  ceremonyPartial,
  ceremonyStart,
  type CeremonyContext,
} from './ceremony.js';
import {
  aggregateRecoveryShares,
  authorizeFinalSweep,
  createRecoveryShare,
  loadLocalSigner,
  loadPublicRoster,
  type RecoveryShare,
} from './custody.js';
import { runCustodyAcceptance } from './custody-acceptance.js';
import { loadAndBurnSecnonce, saveSecnonce } from './nonce-store.js';
import {
  base58CheckEncode,
  deriveXpubChildPubkey,
  deterministicKeypair,
  sha256Hex,
  tapLeafHash,
  xpubRootXonly,
} from './crypto.js';
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
  authorizeSoloSigningArtifacts,
  buildCooperativeExitPsbt,
  buildFinalSweepPsbt,
  buildFundingPsbt,
  buildIdentificationLeafMisusePsbt,
  buildRecoveryPsbt,
  buildSoloAuthorizationTamperFixtures,
  buildSoloWithdrawalPsbt,
  buildSoloWithdrawalTamperPsbts,
  inspectPsbt,
  signCooperativeExitPsbt,
  signFinalSweepPsbt,
  signRecoveryPsbt,
  signSoloWithdrawalPsbt,
  soloLeavesOf,
  type SoloSigningAuthorization,
} from './psbt.js';
import {
  LocalSigbashAdapter,
  createLiveSigbashClient,
  createSigbashAdapter,
  evaluatePolicy,
  normalizeSigbashSigningResult,
  resolveSigbashCredentials,
  sigbashVerificationExplicitlyRejected,
  sigbashVerificationPassed,
  toPoetPolicy,
} from './sigbash.js';
import { runSigbashOfflineChecks } from './sigbash-contract.js';
import {
  Ledger,
  buildCooperativeExit,
  buildFinalSweep,
  buildRecovery,
  buildSoloWithdrawal,
  consolidateDeposits,
  createDemoState,
  createRosterState,
  participantById,
  participantLeaveRounds,
  policyId,
  rosterEntry,
  roundId,
  sigbashRoundKey,
  verifyNoSigbashInKeyPath,
  type RosterEntry,
  type SigbashLeafOverrides,
} from './vault.js';
import {
  asSats,
  asTrustedVaultInput,
  type LedgerUtxo,
  type PolicyTx,
  type PsbtInspection,
  type SoloPolicy,
  type TrustedVaultInput,
  type VaultRound,
  type VaultState,
} from './types.js';
import type { RpcTransaction, RpcTxInput, RpcTxOut, RpcTxOutput } from './bitcoin-rpc.js';
import type { SigbashLiveClient, SigbashSignResult, SigbashVerifyResult } from './sigbash.js';

assertReviewedNodeRuntime();

const command = process.argv[2] || 'acceptance';

const commands: Record<string, () => Promise<void>> = {
  setup,
  'vault-keygen': vaultKeygen,
  'verify-roster': verifyRoster,
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
  'ceremony-start': ceremonyStartCommand,
  'ceremony-nonce': ceremonyNonceCommand,
  'ceremony-partial': ceremonyPartialCommand,
  'ceremony-aggregate': ceremonyAggregateCommand,
  'recovery-psbt': recoveryPsbt,
  'recovery-share': recoveryShareCommand,
  'recovery-aggregate': recoveryAggregateCommand,
  'sign-recovery-psbt': signRecoveryPsbtCommand,
  'final-sweep-psbt': finalSweepPsbt,
  'sign-final-sweep-psbt': signFinalSweepPsbtCommand,
  'sigbash-sign-psbt': sigbashSignPsbt,
  'policy-check-psbt': policyCheckPsbt,
  'inspect-psbt': inspectPsbtCommand,
  'psbt-acceptance': psbtAcceptance,
  'dual-leaf-acceptance': dualLeafAcceptance,
  'custody-acceptance': custodyAcceptance,
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
  'live-policy-dry-run': livePolicyDryRun,
  'live-solo-audit': liveSoloAudit,
  'live-cooperative-audit': liveCooperativeAudit,
  'live-recovery-audit': liveRecoveryAudit,
  'live-final-sweep-audit': liveFinalSweepAudit,
  'rpc-broadcast': rpcBroadcast,
  audit,
  'sdk-policy-check': sdkPolicyCheck,
  'sigbash-sdk-contract': sigbashSdkContract,
  'sigbash-bootstrap': sigbashBootstrap,
  'sigbash-org-id': sigbashOrgId,
  'sigbash-live-setup': sigbashLiveSetup,
  acceptance,
};

if (!commands[command]) {
  console.error(`Unknown command "${command}". Use one of: ${Object.keys(commands).join(', ')}`);
  process.exit(1);
}

try {
  await commands[command]!();
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
}

async function setup() {
  const state = createConfiguredState();
  printSetup(state);
}

// Each participant runs this on their own device with their own secret. It
// prints a public roster entry to share, and never prints private keys.
async function vaultKeygen() {
  const args = parseArgs(process.argv.slice(3));
  const participantId = requireArg(args, 'participant');
  // Secrets are only ever read from the environment: a --secret argument
  // lands in shell history, `ps` output, and CI logs.
  assert(
    args['secret'] === undefined,
    '--secret is not accepted; export VAULT_PARTICIPANT_SECRET instead so the secret never appears in argv',
  );
  const secret = process.env.VAULT_PARTICIPANT_SECRET;
  assert(
    secret && secret.length >= 32,
    'set VAULT_PARTICIPANT_SECRET (>= 32 chars) in this device\'s environment. Generate with: openssl rand -hex 32',
  );
  const allIds = PARTICIPANTS.map((p) => p.id);
  assert(allIds.includes(participantId), `participant must be one of ${allIds.join(', ')}`);
  const entry = rosterEntry(participantId, secret!, allIds);
  printResult('vault keygen (public roster entry — safe to share)', {
    rosterEntry: entry,
    instructions: [
      'Keep VAULT_PARTICIPANT_SECRET private and backed up; it derives your personal and payout keys and is never printed.',
      'The printed Sigbash fields are offline fixtures until live Sigbash roster setup replaces them. Do not fund this entry as-is.',
      'Send the rosterEntry above to the other participants.',
      'Collect all 3 roster entries into a JSON array and run verify-roster to confirm everyone derives the same vault addresses before funding.',
    ],
  });
}

// Anyone assembles the collected roster entries and confirms the derived vault
// addresses. Every participant must see identical addresses before funding.
async function verifyRoster() {
  const args = parseArgs(process.argv.slice(3));
  const { roster, state, custodyChecks } = loadPublicRoster(requireArg(args, 'roster'));
  const audit = auditSpecState(state);
  printResult('roster verification', {
    participants: state.participants.map((p) => ({ id: p.id, payoutAddress: p.payoutAddress })),
    vaultAddresses: [...state.vaults.values()].map((v) => ({
      round: v.id,
      participants: v.participantIds,
      address: v.address,
    })),
    roundOneFundingAddress: requireVault(state, roster.map((entry) => entry.id)).address,
    custodyChecks,
    specAudit: { passed: audit.passed, failed: audit.checks.filter((c) => !c.ok).map((c) => c.name) },
    confirm:
      'Every participant should run this with the same roster and see identical addresses. Fund only the roundOneFundingAddress.',
  });
  assert(audit.passed, 'roster-derived vault failed the spec audit');
}

async function cooperative() {
  const state = createDemoState();
  const ledger = new Ledger();
  createDeposits(ledger, state);
  const vaultUtxo = consolidateDeposits(ledger, state);
  const currentIds = state.participants.map((p) => p.id);
  const tx = buildCooperativeExit({ state, currentUtxo: vaultUtxo, currentIds });
  const vault = requireVault(state, currentIds);
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
  const adapter = await createSigbashAdapter({ participantId: 'alice' });
  const state = createDemoState();
  const ledger = new Ledger();
  createDeposits(ledger, state);
  const vaultUtxo = consolidateDeposits(ledger, state);
  const currentIds = state.participants.map((p) => p.id);
  const tx = buildSoloWithdrawal({ state, currentUtxo: vaultUtxo, currentIds, leaverId: 'alice' });
  const policy = requirePolicy(state, currentIds, 'alice');
  const verified = await adapter.verifyPSBT(tx, policy);
  assert(verified.success, `valid solo withdrawal rejected: ${verified.failures?.join('; ')}`);
  const signed = await adapter.signPSBT(tx, policy);
  assert(signed.success, signed.error || 'solo signing failed');

  const wrongAmount = structuredClone(tx);
  wrongAmount.outputs[0]!.value = asSats(wrongAmount.outputs[0]!.value + 1);
  const wrongAddress = structuredClone(tx);
  wrongAddress.outputs[0]!.address = participantById(state, 'bob').payoutAddress;
  const extraOutput = structuredClone(tx);
  extraOutput.outputs.push({ address: tx.outputs[0]!.address, value: asSats(1), label: 'forbidden extra output' });

  const tampered = {
    wrongAmount: await adapter.verifyPSBT(wrongAmount, policy),
    wrongAddress: await adapter.verifyPSBT(wrongAddress, policy),
    extraOutput: await adapter.verifyPSBT(extraOutput, policy),
  };
  for (const [name, result] of Object.entries(tampered)) {
    assert(!result.success, `${name} tampered PSBT unexpectedly passed`);
  }

  const committed = ledger.spend(vaultUtxo.outpoint, {
    ...tx,
    sigbashSignature: signed.psbt?.sigbashSignature,
  });
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
  const state = createDemoState();
  const ledger = new Ledger();
  createDeposits(ledger, state);
  let currentUtxo = consolidateDeposits(ledger, state);
  const events: Array<Record<string, unknown>> = [
    { step: 'deposits', value: currentUtxo.value, address: currentUtxo.address },
  ];
  const nextUnspentUtxo = (address: string): LedgerUtxo => {
    const utxo = [...ledger.utxos.values()].find(
      (item) => item.address === address && !item.spent,
    );
    if (!utxo) throw new Error(`no unspent UTXO at ${address}`);
    return utxo;
  };

  let currentIds = ['alice', 'bob', 'carol'];
  const first = buildSoloWithdrawal({ state, currentUtxo, currentIds, leaverId: 'alice' });
  let policy = requirePolicy(state, currentIds, 'alice');
  // Per-leaver adapters: each signing request runs under the leaver's own
  // Sigbash credential scope.
  let signed = await (await createSigbashAdapter({ participantId: 'alice' })).signPSBT(first, policy);
  assert(signed.success, signed.error || 'first withdrawal rejected');
  let committed = ledger.spend(currentUtxo.outpoint, first);
  events.push({
    step: 'alice first withdrawal',
    payoutSats: committed.outputs[0]!.value,
    leftoverSats: committed.outputs[1]!.value,
    nextAddress: committed.outputs[1]!.address,
  });

  const doubleSpend = buildSoloWithdrawal({ state, currentUtxo, currentIds, leaverId: 'bob' });
  let doubleSpendRejected = '';
  try {
    ledger.spend(currentUtxo.outpoint, doubleSpend);
  } catch (error) {
    doubleSpendRejected = error instanceof Error ? error.message : String(error);
  }
  assert(doubleSpendRejected, 'round-1 double-spend unexpectedly succeeded');
  events.push({ step: 'round-1 double-spend rejected', reason: doubleSpendRejected });

  currentUtxo = nextUnspentUtxo(committed.outputs[1]!.address);
  currentIds = ['bob', 'carol'];
  const second = buildSoloWithdrawal({ state, currentUtxo, currentIds, leaverId: 'bob' });
  policy = requirePolicy(state, currentIds, 'bob');
  signed = await (await createSigbashAdapter({ participantId: 'bob' })).signPSBT(second, policy);
  assert(signed.success, signed.error || 'second withdrawal rejected');
  committed = ledger.spend(currentUtxo.outpoint, second);
  events.push({
    step: 'bob second withdrawal',
    payoutSats: committed.outputs[0]!.value,
    leftoverSats: committed.outputs[1]!.value,
    nextAddress: committed.outputs[1]!.address,
  });

  currentUtxo = nextUnspentUtxo(committed.outputs[1]!.address);
  const sweep = buildFinalSweep({ state, currentUtxo, participantId: 'carol' });
  committed = ledger.spend(currentUtxo.outpoint, sweep);
  events.push({
    step: 'carol final sweep',
    sweepSats: committed.outputs[0]!.value,
    sigbashSignaturesRequested: 0,
  });

  printResult('full run-through', events);
}

async function signedLocalRun() {
  const args = parseArgs(process.argv.slice(3));
  const state = createConfiguredState();
  const startingOutpoint = args.txid
    ? {
        txid: requireArg(args, 'txid'),
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
    earlyFailure = error instanceof Error ? error.message : String(error);
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
  const roundOneVault = requireVault(state, roundOneIds);
  printResult('mainnet funding manifest', {
    network: NETWORK,
    fundingModel:
      `Build one funding transaction with Alice/Bob/Carol contributing ${state.economics.depositSatsPerParticipant} sats each and exactly one ${state.economics.depositSatsPerParticipant * 3} sat output to the round-one vault. The solo-withdrawal ordering relies on that single vault UTXO.`,
    participants: state.participants.map((participant) => ({
      id: participant.id,
      depositSats: AMOUNTS.deposit,
      payoutAddress: participant.payoutAddress,
      personalXonlyPubkey: participant.personal.xonlyPubKeyHex,
      sigbashPolicyLeafXonlyPubkeysByRound: Object.fromEntries(
        Object.entries(participant.sigbashByRound).map(([round, key]) => [round, key.xonlyPubKeyHex]),
      ),
      sigbashIdentificationLeafXonlyPubkeysByRound: Object.fromEntries(
        Object.entries(participant.sigbashByRound).map(([round, key]) => [
          round,
          key.identificationXonlyPubKeyHex,
        ]),
      ),
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
      requiredLeafKey: policyLeafKey(policy),
      outputs: [
        {
          index: 0,
          valueSats: policyOutputValue(policy, 0),
          address: policyOutputAddress(policy, 0),
        },
        {
          index: 1,
          minValueSats: policyOutputValue(policy, 1),
          address: policyOutputAddress(policy, 1),
        },
      ],
      outputCount: 2,
    })),
  });
}

function policyLeafKey(policy: SoloPolicy): string {
  const condition = policy.conditions.find((item) => item.type === 'REQKEY');
  if (condition?.type !== 'REQKEY') throw new Error(`policy ${policy.id} has no REQKEY`);
  return condition.local_key_identifier;
}

function policyOutputValue(policy: SoloPolicy, index: number): number {
  const condition = policy.conditions.find(
    (item) => item.type === 'OUTPUT_VALUE' && item.selector.index === index,
  );
  if (condition?.type !== 'OUTPUT_VALUE') {
    throw new Error(`policy ${policy.id} has no OUTPUT_VALUE for output ${index}`);
  }
  return condition.value;
}

function policyOutputAddress(policy: SoloPolicy, index: number): string {
  const condition = policy.conditions.find(
    (item) => item.type === 'OUTPUT_DEST_IS_IN_SETS' && item.selector.index === index,
  );
  if (condition?.type !== 'OUTPUT_DEST_IS_IN_SETS' || !condition.addresses[0]) {
    throw new Error(`policy ${policy.id} pins no address for output ${index}`);
  }
  return condition.addresses[0];
}

async function watchManifest() {
  const state = createConfiguredState();
  printResult('watch-only vault manifest', watchOnlyManifest(state));
}

async function rpcImportWatchonly() {
  const state = createConfiguredState();
  const manifest = watchOnlyManifest(state);
  const requests: Array<{ desc: string; timestamp: string; active: boolean; internal: boolean }> = [];
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
    walletRpcUrl: process.env.BITCOIN_RPC_URL || DEFAULT_BITCOIN_RPC_URL,
    imported: manifest.vaults.map((vault, index) => ({
      round: vault.round,
      address: vault.address,
      descriptor: requests[index]?.desc,
      result: result[index],
    })),
    passed: result.every((item) => item.success),
  });
  assert(result.every((item) => item.success), 'one or more watch-only descriptor imports failed');
}

async function vaultOutput() {
  const args = parseArgs(process.argv.slice(3));
  const state = createConfiguredState();
  const roundArg = stringArg(args, 'round');
  const currentIds = roundArg
    ? roundArg.split(',')
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
    requirePolicy(state, currentIds, leaverId),
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

// Interactive MuSig2 cooperative-exit ceremony. Each command runs on one
// participant's machine and exchanges small JSON blobs, so no machine ever
// holds another participant's key. Every command takes the *public* roster;
// the two signing steps additionally take the operator's own trusted outpoint
// (--txid/--vout/--value-sats/--script-pubkey) and read the one local secret
// from VAULT_PARTICIPANT_SECRET. Flow:
//   1. anyone: ceremony-start   → context (unsigned PSBT + signing metadata)
//   2. each:   ceremony-nonce   → their pubnonce; secret nonce goes only to a
//                                  new owner-only single-use file
//   3. each:   ceremony-partial → their partial signature
//   4. anyone: ceremony-aggregate → final signed transaction
async function ceremonyStartCommand() {
  const args = parseArgs(process.argv.slice(3));
  const { state } = loadPublicRoster(requireArg(args, 'roster'));
  const currentIds = requireArg(args, 'round').split(',');
  const trustedInput = trustedInputFromArgs(args);
  const context = ceremonyStart({ state, currentIds, trustedInput });
  printResult('cooperative ceremony context', {
    context,
    trustedInput,
    note:
      'Share this context with each participant. They independently supply the same trusted outpoint ' +
      'and run ceremony-nonce, then ceremony-partial.',
  });
}

async function ceremonyNonceCommand() {
  const args = parseArgs(process.argv.slice(3));
  const signer = loadLocalSigner(requireArg(args, 'roster'));
  const context = JSON.parse(requireArg(args, 'context')) as CeremonyContext;
  const secnonceFile = requireArg(args, 'secnonce-file');
  const trustedInput = trustedInputFromArgs(args);
  const { authorization, participantId, pubnonce, secnonce } = ceremonyNonce({
    state: signer.state,
    participantId: signer.participantId,
    context,
    trustedInput,
  });
  saveSecnonce(secnonceFile, {
    version: 1,
    participantId,
    round: context.round,
    message: context.message,
    pubnonce,
    secnonce,
  });
  printResult('cooperative ceremony nonce', {
    participantId,
    pubnonce,
    secnonceFile,
    custodyChecks: signer.custodyChecks,
    authorization,
    note: 'Share only the pubnonce. The secret nonce was saved in an owner-only file and was not printed.',
  });
}

async function ceremonyPartialCommand() {
  const args = parseArgs(process.argv.slice(3));
  const signer = loadLocalSigner(requireArg(args, 'roster'));
  const context = JSON.parse(requireArg(args, 'context')) as CeremonyContext;
  const pubnonces = JSON.parse(requireArg(args, 'pubnonces')) as Record<string, string>;
  assert(args.secnonce === undefined, '--secnonce is forbidden because command-line secrets leak; use --secnonce-file');
  const secnonceFile = requireArg(args, 'secnonce-file');
  const trustedInput = trustedInputFromArgs(args);
  const participant = participantById(signer.state, signer.participantId);
  const pubnonce = pubnonces[participant.personal.publicKeyHex];
  assert(typeof pubnonce === 'string', 'the pubnonce set is missing this participant\'s published nonce');
  const stored = loadAndBurnSecnonce(secnonceFile, {
    participantId: signer.participantId,
    round: context.round,
    message: context.message,
    pubnonce,
  });
  const partial = ceremonyPartial({
    state: signer.state,
    participantId: signer.participantId,
    context,
    pubnonces,
    secnonce: stored.secnonce,
    trustedInput,
  });
  printResult('cooperative ceremony partial signature', {
    ...partial,
    custodyChecks: signer.custodyChecks,
    note: 'The single-use secret nonce file was destroyed before signing and cannot be reused.',
  });
}

async function ceremonyAggregateCommand() {
  const args = parseArgs(process.argv.slice(3));
  const { state } = loadPublicRoster(requireArg(args, 'roster'));
  const context = JSON.parse(requireArg(args, 'context')) as CeremonyContext;
  const pubnonces = JSON.parse(requireArg(args, 'pubnonces')) as Record<string, string>;
  const partialSigs = JSON.parse(requireArg(args, 'partials')) as Record<string, string>;
  const trustedInput = trustedInputFromArgs(args);
  printResult(
    'cooperative ceremony aggregate',
    ceremonyAggregate({ state, context, pubnonces, partialSigs, trustedInput }),
  );
}

// Builders hold no secrets. Pass the public --roster for a real vault (the
// participants' own published keys); without it the command falls back to the
// demo-seed state, which only ever matches a local demo run — a signer will
// refuse to sign a PSBT built from the wrong key material.
async function recoveryPsbt() {
  const args = parseArgs(process.argv.slice(3));
  const state = builderState(args);
  const currentIds = requireArg(args, 'round').split(',').sort();
  const vanishedId = requireArg(args, 'vanished');
  const txid = requireArg(args, 'txid');
  const vout = Number(requireArg(args, 'vout'));
  const valueSats = Number(requireArg(args, 'value-sats'));
  const psbt = buildRecoveryPsbt({ state, currentIds, vanishedId, txid, vout, valueSats });
  printResult('timelocked recovery PSBT', psbt);
}

// One rescuer, on their own device, with only their own secret. The share is
// public material: a signature plus the bindings the aggregator re-derives.
async function recoveryShareCommand() {
  const args = parseArgs(process.argv.slice(3));
  const signer = loadLocalSigner(requireArg(args, 'roster'));
  const currentIds = requireArg(args, 'round').split(',');
  const vanishedId = requireArg(args, 'vanished');
  const psbtBase64 = requireArg(args, 'psbt-base64');
  const trustedInput = trustedInputFromArgs(args);
  const { share, authorization } = createRecoveryShare({
    signer,
    currentIds,
    vanishedId,
    psbtBase64,
    trustedInput,
  });
  printResult('timelocked recovery share', {
    share,
    custodyChecks: signer.custodyChecks,
    authorization: { round: authorization.round, checks: authorization.checks },
    note: 'Send the share to whoever aggregates. It carries no private key material.',
  });
}

// Anyone (no secret at all) combines the threshold of independent shares.
async function recoveryAggregateCommand() {
  const args = parseArgs(process.argv.slice(3));
  const { state } = loadPublicRoster(requireArg(args, 'roster'));
  const currentIds = requireArg(args, 'round').split(',');
  const vanishedId = requireArg(args, 'vanished');
  const psbtBase64 = requireArg(args, 'psbt-base64');
  const shares = JSON.parse(requireArg(args, 'shares')) as RecoveryShare[];
  assert(Array.isArray(shares), '--shares must be a JSON array of recovery shares');
  const trustedInput = trustedInputFromArgs(args);
  printResult(
    'aggregated timelocked recovery',
    aggregateRecoveryShares({ state, currentIds, vanishedId, psbtBase64, trustedInput, shares }),
  );
}

// Demo-only: signs a recovery with every rescuer's key on one machine. Gated
// on the public demo seed so it can never touch funded keys; production
// recovery is recovery-share (one secret each) + recovery-aggregate.
async function signRecoveryPsbtCommand() {
  assert(
    DEMO_SEED === DEFAULT_DEMO_SEED,
    'sign-recovery-psbt is the single-machine demo signer and needs every rescuer\'s key. ' +
      'With a real seed set, use recovery-share on each rescuer\'s device and then recovery-aggregate.',
  );
  const args = parseArgs(process.argv.slice(3));
  const currentIds = requireArg(args, 'round').split(',');
  const vanishedId = requireArg(args, 'vanished');
  const psbtBase64 = requireArg(args, 'psbt-base64');
  const signerIds = stringArg(args, 'signers')?.split(',');
  const state = createConfiguredState();
  const signed = signRecoveryPsbt({
    state,
    currentIds,
    vanishedId,
    psbtBase64,
    signerIds,
  });
  printResult('signed timelocked recovery (demo seed, all keys on one machine)', signed);
}

async function finalSweepPsbt() {
  const args = parseArgs(process.argv.slice(3));
  const state = builderState(args);
  const participantId = requireArg(args, 'participant');
  const txid = requireArg(args, 'txid');
  const vout = Number(requireArg(args, 'vout'));
  const valueSats = Number(requireArg(args, 'value-sats'));
  const feeSats = args['fee-sats'] === undefined ? AMOUNTS.finalSweepFee : Number(args['fee-sats']);
  const psbt = buildFinalSweepPsbt({
    state,
    participantId,
    txid,
    vout,
    valueSats,
    feeSats,
    destinationAddress: stringArg(args, 'destination'),
  });
  printResult('final participant sweep PSBT', psbt);
}

// The last participant sweeping their own payout output. Roster + this
// device's one secret; the participant is whoever the secret belongs to, and
// the sweep is authorized against the operator's own trusted outpoint before
// a signature exists, then re-verified independently afterwards.
async function signFinalSweepPsbtCommand() {
  const args = parseArgs(process.argv.slice(3));
  const signer = loadLocalSigner(requireArg(args, 'roster'));
  const psbtBase64 = requireArg(args, 'psbt-base64');
  const trustedInput = trustedInputFromArgs(args);
  const feeSats = args['fee-sats'] === undefined ? AMOUNTS.finalSweepFee : Number(args['fee-sats']);
  const authorization = authorizeFinalSweep({
    state: signer.state,
    participantId: signer.participantId,
    psbtBase64,
    trustedInput,
    destinationAddress: stringArg(args, 'destination'),
    feeSats,
  });
  const signed = signFinalSweepPsbt({
    state: signer.state,
    participantId: signer.participantId,
    psbtBase64,
  });
  const consensus = verifyVaultTransaction({
    txHex: signed.transactionHex,
    prevouts: [
      { scriptPubKeyHex: trustedInput.scriptPubKeyHex, valueSats: trustedInput.valueSats },
    ],
  });
  assert(
    signed.txid === authorization.unsignedTxid,
    'signed final sweep is not the transaction that was authorized',
  );
  printResult('signed final participant sweep', {
    ...signed,
    custodyChecks: signer.custodyChecks,
    authorization,
    consensus,
  });
}

async function sigbashSignPsbt() {
  assert(
    process.env.SIGBASH_MODE === 'live',
    'sigbash-sign-psbt contacts Sigbash; rerun with SIGBASH_MODE=live',
  );
  const args = parseArgs(process.argv.slice(3));
  const participantId = requireArg(args, 'participant');
  const psbtBase64 = requireArg(args, 'psbt-base64');

  const state = createConfiguredState();
  const inspection = inspectPsbt(psbtBase64);
  const vault = vaultFromPsbtInspection(state, inspection);
  assert(vault, 'PSBT input does not spend a known vault round scriptPubKey');
  const keyId = stringArg(args, 'key-id') || process.env[sigbashKeyIdEnvName(participantId, vault.id)];
  assert(keyId, `missing --key-id or ${sigbashKeyIdEnvName(participantId, vault.id)}`);
  const policy = {
    ...requirePolicy(state, vault.participantIds, participantId),
    keyId,
  };
  assert(policy.conditions, `unknown policy for ${participantId} in round ${vault.id}`);
  const adapter = await createSigbashAdapter({ participantId });
  const tx = { psbtBase64 };
  const verification = await adapter.verifyPSBT(tx, policy);
  if (!sigbashVerificationPassed(verification)) {
    printResult('Sigbash PSBT verification failed', verification);
    throw new Error('Sigbash rejected PSBT in dry-run');
  }
  const signed = await adapter.signPSBT(tx, policy);
  const signedArtifacts = normalizeSigbashSigningResult(signed);
  assert(
    signedArtifacts.success && (signedArtifacts.txHex || signedArtifacts.signedPsbtBase64),
    'Sigbash signing succeeded but returned no txHex or signedPSBT artifact',
  );
  const authorization = authorizeSoloSigningArtifacts(state, vault.participantIds, participantId, psbtBase64, {
    txHex: signedArtifacts.txHex,
    signedPsbtBase64: signedArtifacts.signedPsbtBase64,
  });
  printResult('Sigbash signed PSBT', {
    keyId,
    participantId,
    verification,
    ...signedArtifacts,
    authorization,
    nextCommands: sigbashSignedNextCommands(signedArtifacts),
  });
}

async function policyCheckPsbt() {
  const args = parseArgs(process.argv.slice(3));
  const participantId = requireArg(args, 'participant');
  const psbtBase64 = requireArg(args, 'psbt-base64');
  const state = createConfiguredState();
  const inspection = inspectPsbt(psbtBase64);
  const vault = vaultFromPsbtInspection(state, inspection);
  assert(vault, 'PSBT input does not spend a known vault round scriptPubKey');
  const policy = requirePolicy(state, vault.participantIds, participantId);
  assert(policy, `unknown policy for ${participantId} in round ${vault.id}`);
  const tx = psbtInspectionToPolicyTx({ state, inspection });
  const failures = evaluatePolicy(tx, policy);
  printResult('local PSBT policy check', {
    participantId,
    round: vault.id,
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
  const roundOneVault = requireVault(state, roundOneIds);
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
    soloInspection.inputs[0]!.witnessUtxo?.scriptPubKeyHex === roundOneVault.outputScriptHex,
    'solo PSBT spends wrong vault script',
  );
  assert(
    soloInspection.inputs[0]!.tapLeafScript?.[0]?.scriptHex ===
      roundOneVault.tapscriptLeaves.find(
        (leaf) => leaf.type === 'solo-withdrawal' && leaf.participantId === 'alice',
      )?.scriptHex,
    'solo PSBT uses wrong tapscript leaf',
  );
  assert(soloInspection.outputs[0].valueSats === AMOUNTS.firstWithdrawal, 'solo payout mismatch');
  assert(
    soloInspection.outputs[0].address === participantById(state, 'alice').payoutAddress,
    'solo payout destination mismatch',
  );
  assert(
    soloInspection.outputs[1].address === requireVault(state, ['bob', 'carol']).address,
    'solo re-vault destination mismatch',
  );
  assert(
    evaluatePolicy(
      psbtInspectionToPolicyTx({ state, inspection: soloInspection }),
      requirePolicy(state, roundOneIds, 'alice'),
    ).length === 0,
    'solo PSBT does not satisfy Alice policy preflight',
  );
  const tamperedSoloInspection = structuredClone(soloInspection);
  tamperedSoloInspection.outputs[0].valueSats += 1;
  assert(
    evaluatePolicy(
      psbtInspectionToPolicyTx({ state, inspection: tamperedSoloInspection }),
      requirePolicy(state, roundOneIds, 'alice'),
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
  // Cross-round confusion regression: with one Sigbash key per (participant,
  // round) there is no key that can take the round-two amount out of the
  // round-one pot. A transaction spending the round-one vault with round-two
  // shaped outputs must fail Alice's round-one policy on the amounts, and her
  // round-two policies on the leaf key (her round-two keys are not in the
  // round-one vault's tapscript tree).
  const aliceParticipant = participantById(state, 'alice');
  const bobParticipant = participantById(state, 'bob');
  const crossRoundAttackTx = {
    sigbashLeafKey: aliceParticipant.sigbashByRound[roundId(roundOneIds)].xonlyPubKeyHex,
    inputCount: 1,
    outputs: [
      { address: aliceParticipant.payoutAddress, value: AMOUNTS.secondWithdrawal },
      { address: bobParticipant.payoutAddress, value: 300_000_000 - AMOUNTS.secondWithdrawal - 1_000 },
    ],
  };
  assert(
    evaluatePolicy(crossRoundAttackTx, requirePolicy(state, roundOneIds, 'alice')).length > 0,
    'cross-round attack unexpectedly satisfied the round-one policy',
  );
  assert(
    evaluatePolicy(crossRoundAttackTx, requirePolicy(state, ['alice', 'bob'], 'alice')).length > 0,
    'cross-round attack unexpectedly satisfied the alice/bob round-two policy',
  );
  const multiInputAttackTx = {
    sigbashLeafKey: aliceParticipant.sigbashByRound[roundId(roundOneIds)].xonlyPubKeyHex,
    inputCount: 2,
    outputs: [
      { address: aliceParticipant.payoutAddress, value: AMOUNTS.firstWithdrawal },
      { address: requireVault(state, ['bob', 'carol']).address, value: 204_999_000 },
    ],
  };
  assert(
    evaluatePolicy(multiInputAttackTx, requirePolicy(state, roundOneIds, 'alice')).length > 0,
    'multi-input attack unexpectedly satisfied the round-one policy',
  );

  const soloTamperChecks = soloTamperLocalChecks({
    state,
    currentIds: roundOneIds,
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
  const expectedRefundSats = Math.floor((300_000_000 - AMOUNTS.cooperativeFee) / 3);
  assert(
    cooperativeInspection.outputs.every((output) => output.valueSats === expectedRefundSats),
    'cooperative PSBT does not refund equal shares of the pot after the miner fee',
  );
  assert(
    300_000_000 - expectedRefundSats * 3 >= AMOUNTS.cooperativeFee,
    'cooperative PSBT fee is below the configured miner fee',
  );
  const cooperativeReady = expectedCooperativeReadiness({
    state,
    currentIds: roundOneIds,
    valueSats: 300_000_000,
  });
  assert(cooperativeReady.keyPathContainsOnlyPersonalKeys, 'cooperative readiness key-path mismatch');
  assert(
    cooperativeReady.signerIds.join(',') === 'alice,bob,carol',
    'cooperative readiness signer set mismatch',
  );
  assert(
    cooperativeReady.refundOutputs.every(
      (output: { valueSats: number }) => output.valueSats === expectedRefundSats,
    ),
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
    recoveryInspection.inputs[0]!.tapLeafScript?.[0]?.scriptHex === recoveryLeaf?.scriptHex,
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
  const carol = participantById(state, 'carol');
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
    fakeFundingInputValues.every((input) => (input.valueSats ?? 0) >= AMOUNTS.deposit),
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
          { n: 1, value: 1.25, scriptPubKey: { address: 'bc1qfallback' } },
        ],
      },
    ],
  ]);
  const fakeFallbackSummaries = await fundingInputSummaries(
    fakeFallbackFundingTx.vin,
    async (txidToFetch: string) => {
      const previous = fakePreviousTransactions.get(txidToFetch);
      if (!previous) throw new Error(`no fake transaction for ${txidToFetch}`);
      return { txid: txidToFetch, vin: [], ...previous } as RpcTransaction;
    },
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
  const alice = participantById(state, 'alice');
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
        sigbashLeafKey: alice.sigbashByRound[roundId(roundOneIds)].xonlyPubKeyHex,
        inputCount: 1,
        outputs: fakeSoloOutputs.map((output) => ({
          address: output.address,
          value: output.valueSats,
        })),
      },
      requirePolicy(state, roundOneIds, 'alice'),
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
    transactionConfirmationCheck(
      'fake confirmed tx',
      { txid, vin: [], vout: [], confirmations: 2, blockhash: '00'.repeat(32) },
      2,
    ).ok,
    'confirmation helper should pass at threshold',
  );
  assert(
    !transactionConfirmationCheck('fake underconfirmed tx', { txid, vin: [], vout: [], confirmations: 1 }, 2).ok,
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
    signedRun.stages.at(-1)!.outputs[0]!.valueSats === 102_497_000 - AMOUNTS.finalSweepFee,
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

// Deterministic xpub fixture for dual-leaf tests: depth-0 mainnet xpub whose
// child 0/0 (policy leaf) and internal root (identification leaf) can be
// derived exactly like a live Sigbash bip328Xpub. No network, no secrets.
function syntheticXpubForTest(label: string): string {
  const rootKey = deterministicKeypair(DEMO_SEED, `${label}:xpub-root`);
  return base58CheckEncode(
    Buffer.concat([
      Buffer.from('0488b21e', 'hex'),
      Buffer.from([0]),
      Buffer.alloc(4),
      Buffer.alloc(4),
      Buffer.from(sha256Hex(`${label}:chaincode`), 'hex'),
      Buffer.from(rootKey.publicKeyHex, 'hex'),
    ]),
  );
}

// Focused dual-leaf regressions: the identification leaf must never be
// selected by local solo signing and must never authorize a spend through
// any local adapter path; live overrides and setup checkpoints must resolve
// to one canonical dual-leaf vault whether fresh or resumed.
async function dualLeafAcceptance() {
  const state = createDemoState();
  const roundOneIds = ['alice', 'bob', 'carol'];
  const round = roundId(roundOneIds);
  const roundOneVault = requireVault(state, roundOneIds);
  const txid = '0000000000000000000000000000000000000000000000000000000000000001';
  const potSats = AMOUNTS.deposit * 3;
  const alice = participantById(state, 'alice');
  const aliceRoundKey = alice.sigbashByRound[round]!;

  // Tree structure: per participant one policy-spend and one identification
  // leaf, plus the recovery leaf; MuSig2 key path untouched.
  const policyLeaves = roundOneVault.tapscriptLeaves.filter((leaf) => leaf.type === 'solo-withdrawal');
  const identificationLeaves = roundOneVault.tapscriptLeaves.filter(
    (leaf) => leaf.type === 'sigbash-identification',
  );
  assert(
    policyLeaves.length === 3 && identificationLeaves.length === 3,
    'round-one vault must carry 3 policy-spend and 3 identification leaves',
  );
  assert(
    roundOneVault.tapscriptLeaves.filter((leaf) => leaf.type === 'timelocked-recovery').length === 1,
    'round-one vault must keep exactly one recovery leaf',
  );
  assert(
    requireVault(state, ['bob', 'carol']).tapscriptLeaves.length === 5,
    'pair vault must carry 2 policy + 2 identification + 1 recovery leaves',
  );
  assert(verifyNoSigbashInKeyPath(roundOneVault), 'dual-leaf tree leaked keys into the key path');
  const aliceLeaves = soloLeavesOf(roundOneVault, 'alice');
  assert(
    aliceLeaves.policyLeaf.scriptHex === `20${aliceRoundKey.xonlyPubKeyHex}ac`,
    'policy-spend leaf script must be pk(round policy key)',
  );
  assert(
    aliceLeaves.identificationLeaf.scriptHex === `20${aliceRoundKey.identificationXonlyPubKeyHex}ac`,
    'identification leaf script must be pk(identification key)',
  );
  assert(
    roundOneVault.descriptor.includes(`pk(${aliceRoundKey.identificationXonlyPubKeyHex})`),
    'vault descriptor must list the identification leaf',
  );

  // Solo PSBT carries both leaves with unambiguous role metadata.
  const solo = buildSoloWithdrawalPsbt({
    state,
    currentIds: roundOneIds,
    leaverId: 'alice',
    txid,
    vout: 0,
    valueSats: potSats,
  });
  assert(solo.txTemplate.tapLeafScript.role === 'policy-spend', 'solo template policy leaf role mismatch');
  assert(
    solo.txTemplate.identificationLeaf.role === 'identification-only',
    'solo template identification leaf role mismatch',
  );
  const soloInspection = inspectPsbt(solo.psbtBase64);
  const psbtLeafScripts = (soloInspection.inputs[0]!.tapLeafScript ?? []).map((leaf) => leaf.scriptHex);
  assert(
    psbtLeafScripts.length === 2 &&
      psbtLeafScripts.includes(aliceLeaves.policyLeaf.scriptHex) &&
      psbtLeafScripts.includes(aliceLeaves.identificationLeaf.scriptHex),
    'solo PSBT must carry exactly the policy-spend and identification leaves',
  );
  assert(
    soloInspection.inputs[0]!.tapBip32Derivation === undefined,
    'local-mode solo PSBT must not fabricate a tapBip32Derivation',
  );

  // Regression: local solo signing selects the policy leaf, never the
  // identification leaf, even though both ride in the PSBT.
  const signedSolo = signSoloWithdrawalPsbt({
    state,
    currentIds: roundOneIds,
    leaverId: 'alice',
    psbtBase64: solo.psbtBase64,
  });
  assert(
    signedSolo.signedLeaf.role === 'policy-spend' &&
      signedSolo.signedLeaf.scriptHex === aliceLeaves.policyLeaf.scriptHex &&
      signedSolo.signedLeaf.scriptHex !== aliceLeaves.identificationLeaf.scriptHex,
    'local solo signing must finalize the policy-spend leaf only',
  );

  // Regression: leaf selection is by script role, not PSBT ordering.
  const reordered = structuredClone(soloInspection);
  reordered.inputs[0]!.tapLeafScript!.reverse();
  const reorderedTx = psbtInspectionToPolicyTx({ state, inspection: reordered });
  assert(
    reorderedTx.sigbashLeafKey === aliceRoundKey.xonlyPubKeyHex,
    'policy leaf key must be resolved regardless of tapLeafScript order',
  );
  assert(
    evaluatePolicy(reorderedTx, requirePolicy(state, roundOneIds, 'alice')).length === 0,
    'reordered dual-leaf PSBT must still satisfy the policy preflight',
  );

  // Regression: a PSBT carrying only the identification leaf fails the local
  // policy preflight (REQKEY) and cannot be signed by local solo signing.
  const misuse = buildIdentificationLeafMisusePsbt({
    state,
    currentIds: roundOneIds,
    leaverId: 'alice',
    txid,
    vout: 0,
    valueSats: potSats,
  });
  const misuseTx = psbtInspectionToPolicyTx({ state, inspection: inspectPsbt(misuse.psbtBase64) });
  assert(
    misuseTx.sigbashLeafKey === undefined,
    'identification leaf must never be treated as a policy leaf key',
  );
  assert(
    evaluatePolicy(misuseTx, requirePolicy(state, roundOneIds, 'alice')).length > 0,
    'identification-leaf-only PSBT unexpectedly passed the local policy',
  );
  let misuseSigningError = '';
  try {
    signSoloWithdrawalPsbt({
      state,
      currentIds: roundOneIds,
      leaverId: 'alice',
      psbtBase64: misuse.psbtBase64,
    });
  } catch (error) {
    misuseSigningError = errorMessage(error);
  }
  assert(
    misuseSigningError.includes('policy-spend'),
    'local solo signing must refuse a PSBT without the policy-spend leaf',
  );

  // Regression: no local adapter path lets the identification key authorize a
  // spend — for every (round, leaver) policy, a transaction satisfying every
  // amount/address/count condition but presenting the identification key must
  // fail verification and signing on REQKEY.
  const localAdapter = new LocalSigbashAdapter();
  for (const policy of state.policies.values()) {
    const leaver = participantById(state, policy.leaverId);
    const policyRound = roundId(policy.roundIds);
    const identificationKey = leaver.sigbashByRound[policyRound]!.identificationXonlyPubKeyHex;
    const bypassAttempt = {
      sigbashLeafKey: identificationKey,
      inputCount: 1,
      outputs: [
        { address: policyOutputAddress(policy, 0), value: policyOutputValue(policy, 0) },
        { address: policyOutputAddress(policy, 1), value: policyOutputValue(policy, 1) },
      ],
    };
    const verifyResult = await localAdapter.verifyPSBT(bypassAttempt, policy);
    assert(
      verifyResult.success === false,
      `identification key satisfied policy ${policy.id} in local verification`,
    );
    const signResult = await localAdapter.signPSBT(bypassAttempt, policy);
    assert(
      signResult.success === false && signResult.psbt === undefined,
      `identification key obtained a local signature for policy ${policy.id}`,
    );
  }

  // Live override resolution: checkpoint-derived, xpub-only, and explicit
  // overrides must all produce the identical canonical dual-leaf vault, and
  // the checkpoint parser must be the single source for resume.
  const xpub = syntheticXpubForTest(`dual-leaf-acceptance:alice:${round}`);
  const policyLeafKey = deriveXpubChildPubkey(xpub, [0, 0]).xonlyPubKeyHex;
  const identificationLeafKey = xpubRootXonly(xpub);
  const registration: LiveKeyRegistration = {
    participantId: 'alice',
    round,
    keyId: 'test-key-id',
    keyIndex: 0,
    keyIdEnvName: sigbashKeyIdEnvName('alice', round),
    bip328Xpub: xpub,
    policyLeafXonlyPubkey: policyLeafKey,
    identificationLeafXonlyPubkey: identificationLeafKey,
    helperP2trAddressDoNotFund: undefined,
    policyRoot: 'test-policy-root',
    policyId: policyId(roundOneIds, 'alice'),
  };
  const resumedOverride = checkpointRegistrationToOverride(
    parseSetupCheckpointLine(JSON.stringify(registration)),
  );
  assert(
    resumedOverride.key === policyLeafKey &&
      resumedOverride.identificationKey === identificationLeafKey &&
      resumedOverride.xpub === xpub,
    'checkpoint resume must reproduce the canonical dual-leaf override',
  );
  const liveState = createDemoState({
    sigbashLeafOverrides: { alice: { [round]: resumedOverride } },
  });
  const liveVault = requireVault(liveState, roundOneIds);
  const aliceLiveLeaves = soloLeavesOf(liveVault, 'alice');
  assert(
    aliceLiveLeaves.policyLeaf.scriptHex === `20${policyLeafKey}ac` &&
      aliceLiveLeaves.identificationLeaf.scriptHex === `20${identificationLeafKey}ac`,
    'live override must place child 0/0 in the policy leaf and the internal root in the identification leaf',
  );
  const xpubOnlyState = createDemoState({
    sigbashLeafOverrides: { alice: { [round]: { key: policyLeafKey, xpub } } },
  });
  assert(
    requireVault(xpubOnlyState, roundOneIds).address === liveVault.address,
    'xpub-only override must derive the identical dual-leaf vault address',
  );

  // Live-mode PSBT metadata: exactly one tapBip32Derivation, for the policy
  // leaf child key at m/0/0 — never for the identification leaf.
  const livePsbt = buildSoloWithdrawalPsbt({
    state: liveState,
    currentIds: roundOneIds,
    leaverId: 'alice',
    txid,
    vout: 0,
    valueSats: potSats,
  });
  const liveDerivations = inspectPsbt(livePsbt.psbtBase64).inputs[0]!.tapBip32Derivation ?? [];
  const policyLeafHashHex = tapLeafHash(
    Buffer.from(aliceLiveLeaves.policyLeaf.scriptHex, 'hex'),
  ).toString('hex');
  const identificationLeafHashHex = tapLeafHash(
    Buffer.from(aliceLiveLeaves.identificationLeaf.scriptHex, 'hex'),
  ).toString('hex');
  assert(
    liveDerivations.length === 1 &&
      liveDerivations[0]!.pubkeyHex === policyLeafKey &&
      liveDerivations[0]!.path === 'm/0/0' &&
      liveDerivations[0]!.leafHashesHex.join(',') === policyLeafHashHex &&
      !liveDerivations[0]!.leafHashesHex.includes(identificationLeafHashHex),
    'live solo PSBT must carry a tapBip32Derivation for the policy leaf only',
  );
  let liveLocalSigningError = '';
  try {
    signSoloWithdrawalPsbt({
      state: liveState,
      currentIds: roundOneIds,
      leaverId: 'alice',
      psbtBase64: livePsbt.psbtBase64,
    });
  } catch (error) {
    liveLocalSigningError = errorMessage(error);
  }
  assert(
    liveLocalSigningError.includes('live Sigbash leaf key'),
    'local signing must refuse live-keyed rounds',
  );

  // Checkpoint hygiene: legacy, incomplete, and mixed lines are rejected
  // instead of silently deriving a different vault address on resume.
  const expectRejected = (label: string, line: unknown, pattern: RegExp) => {
    let message = '';
    try {
      parseSetupCheckpointLine(JSON.stringify(line));
    } catch (error) {
      message = errorMessage(error);
    }
    assert(pattern.test(message), `${label} checkpoint entry was not rejected (${message || 'accepted'})`);
  };
  expectRejected(
    'legacy',
    { ...registration, policyLeafXonlyPubkey: undefined, leafXonlyPubkey: identificationLeafKey },
    /legacy setup checkpoint/,
  );
  expectRejected(
    'incomplete',
    { ...registration, identificationLeafXonlyPubkey: undefined },
    /missing identificationLeafXonlyPubkey/,
  );
  expectRejected(
    'mixed (identification key is not the xpub root)',
    { ...registration, identificationLeafXonlyPubkey: policyLeafKey },
    /mixed\/corrupt/,
  );
  expectRejected(
    'mixed (policy key is not the xpub child 0\\/0)',
    { ...registration, policyLeafXonlyPubkey: identificationLeafKey },
    /mixed\/corrupt/,
  );
  const expectOverrideRejected = (label: string, override: unknown, pattern: RegExp) => {
    let message = '';
    try {
      createDemoState({
        sigbashLeafOverrides: { alice: { [round]: override as never } },
      });
    } catch (error) {
      message = errorMessage(error);
    }
    assert(pattern.test(message), `${label} leaf override was not rejected (${message || 'accepted'})`);
  };
  expectOverrideRejected('legacy bare-string', policyLeafKey, /legacy single-key/);
  expectOverrideRejected('incomplete (no xpub, no identification key)', { key: policyLeafKey }, /incomplete/);
  expectOverrideRejected(
    'mixed (key is not child 0/0 of the xpub)',
    { key: identificationLeafKey, xpub },
    /not the xpub's child 0\/0/,
  );

  // Regression: remote-signer artifact authorization accepts exactly the
  // locally signed solo transaction and rejects every deterministic tamper
  // fixture (output mutation, identification-leaf witness, identification-leaf
  // tapScriptSig).
  const soloAuthorization = authorizeSoloSigningArtifacts(state, roundOneIds, 'alice', solo.psbtBase64, {
    txHex: signedSolo.transactionHex,
  });
  assert(
    soloAuthorization.txHexVerified &&
      soloAuthorization.finalTxid === signedSolo.txid &&
      soloAuthorization.consensus !== null,
    'artifact authorization must accept the exact locally signed solo transaction',
  );
  const tamperFixtures = buildSoloAuthorizationTamperFixtures({
    state,
    currentIds: roundOneIds,
    leaverId: 'alice',
    transactionHex: signedSolo.transactionHex,
    psbtBase64: solo.psbtBase64,
  });
  const expectAuthorizationRejected = (
    label: string,
    artifacts: { txHex?: string; signedPsbtBase64?: string },
    pattern: RegExp,
  ) => {
    let message = '';
    try {
      authorizeSoloSigningArtifacts(state, roundOneIds, 'alice', solo.psbtBase64, artifacts);
    } catch (error) {
      message = errorMessage(error);
    }
    assert(
      pattern.test(message),
      `${label} artifact was not rejected with a clear reason (${message || 'accepted'})`,
    );
  };
  expectAuthorizationRejected(
    'output-mutation transaction',
    { txHex: tamperFixtures.outputMutationTxHex },
    /changed output 0's value/,
  );
  expectAuthorizationRejected(
    'identification-leaf witness transaction',
    { txHex: tamperFixtures.identificationWitnessTxHex },
    /witness spends the identification leaf/,
  );
  expectAuthorizationRejected(
    'identification-leaf tapScriptSig PSBT',
    { signedPsbtBase64: tamperFixtures.identificationTapScriptSigPsbtBase64 },
    /tapScriptSig for the identification leaf/,
  );

  printResult('dual-leaf acceptance', {
    passed: true,
    checks: [
      'every vault pairs each policy-spend leaf with a distinct identification leaf and keeps the recovery leaf',
      'solo PSBTs carry both Sigbash leaves with unambiguous role metadata',
      'local solo signing finalizes the policy-spend leaf and never the identification leaf',
      'policy leaf resolution is order-independent; identification-only PSBTs fail preflight and signing',
      'no (round, leaver) policy accepts the identification key through any local adapter path',
      'checkpoint fresh/resume and xpub-only overrides derive one canonical dual-leaf vault',
      'live solo PSBTs carry a tapBip32Derivation for the policy leaf child 0/0 only',
      'legacy, incomplete, and mixed checkpoints/overrides are rejected outright',
      'artifact authorization accepts the exact signed solo transaction and rejects output-mutation, identification-witness, and identification-tapScriptSig tampering',
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
  const roundArg = stringArg(args, 'round');
  const currentIds = roundArg
    ? roundArg.split(',')
    : createConfiguredState().participants.map((participant) => participant.id);
  const state = createConfiguredState();
  const expected = expectedVaultOutput(state, currentIds);
  let actual = null;
  let fetchError = null;
  try {
    actual = await getTxOut(txid, vout);
  } catch (error) {
    fetchError = errorMessage(error);
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
    fetchError = errorMessage(error);
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
    fetchError = errorMessage(error);
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
  const participantCredentialChecks = state.participants.map((participant) => {
    const warnings: string[] = [];
    try {
      const credentials = resolveSigbashCredentials(process.env, participant.id, (message) =>
        warnings.push(message),
      );
      return check(
        `${participant.id} has an isolated Sigbash credential triplet`,
        credentials.source === 'participant',
        { source: credentials.source, warnings },
      );
    } catch (error) {
      return check(`${participant.id} has an isolated Sigbash credential triplet`, false, {
        error: errorMessage(error),
      });
    }
  });
  const envChecks = [
    checkEnvEquals('SIGBASH_MODE', 'live'),
    ...participantCredentialChecks,
    ...[
      'SIGBASH_SERVER_URL',
      'SIGBASH_WASM_URL',
      'SIGBASH_WASM_SHA384',
      'SIGBASH_LEAF_KEYS_JSON',
      ...state.participants.flatMap((participant) =>
        participantLeaveRounds(participant.id, roundOneIds).map((round) =>
          sigbashKeyIdEnvName(participant.id, round),
        ),
      ),
    ].map(checkEnvPresent),
    {
      name: 'VAULT_DEMO_SEED is not the public default',
      ok: process.env.VAULT_DEMO_SEED !== undefined,
      actual: process.env.VAULT_DEMO_SEED ? 'set' : null,
    },
  ];
  const sdkCheck = await checkSdkPolicyBuilder();
  const rpcCheck = await checkBitcoinRpc();

  const args = parseArgs(process.argv.slice(3));
  let utxoCheck = null;
  if (args.txid || args.vout !== undefined) {
    const txidArg = stringArg(args, 'txid');
    assert(txidArg && args.vout !== undefined, 'provide both --txid and --vout for UTXO readiness');
    try {
      const actual = await getTxOut(txidArg, Number(args.vout));
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
            error: errorMessage(error),
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
  const firstLeaver = stringArg(args, 'first-leaver') || 'alice';
  const secondLeaver = stringArg(args, 'second-leaver') || 'bob';
  const firstRemaining = participantIds(state).filter((id) => id !== firstLeaver);
  const lastParticipant =
    stringArg(args, 'last-participant') ||
    firstRemaining.find((id) => id !== secondLeaver) ||
    'carol';
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
        round: stringArg(args, 'cooperative-round') || roundOne,
        'min-confirmations': stringArg(args, 'min-confirmations') || '1',
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
          round: stringArg(args, 'solo-round') || roundOne,
          leaver: stringArg(args, 'solo-leaver') || firstLeaver,
          txid: argOrPlaceholder(args, 'solo-vault-txid'),
          vout: argOrPlaceholder(args, 'solo-vault-vout'),
        }),
        commandLine('npm run live-solo-audit --', {
          txid: argOrPlaceholder(args, 'solo-txid'),
          'vault-txid': argOrPlaceholder(args, 'solo-vault-txid'),
          'vault-vout': argOrPlaceholder(args, 'solo-vault-vout'),
          round: stringArg(args, 'solo-round') || roundOne,
          leaver: stringArg(args, 'solo-leaver') || firstLeaver,
          'value-sats': stringArg(args, 'solo-value-sats') || String(AMOUNTS.deposit * 3),
          'min-confirmations': stringArg(args, 'min-confirmations') || '1',
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
        round: stringArg(args, 'cooperative-round') || roundOne,
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
          round: stringArg(args, 'recovery-round') || roundOne,
          vanished: stringArg(args, 'vanished') || lastParticipant,
        }),
        commandLine('npm run live-recovery-audit --', {
          txid: argOrPlaceholder(args, 'recovery-txid'),
          'vault-txid': argOrPlaceholder(args, 'recovery-vault-txid'),
          'vault-vout': argOrPlaceholder(args, 'recovery-vault-vout'),
          round: stringArg(args, 'recovery-round') || roundOne,
          vanished: stringArg(args, 'vanished') || lastParticipant,
          'value-sats': argOrPlaceholder(args, 'recovery-value-sats'),
          'min-confirmations': stringArg(args, 'min-confirmations') || '1',
        }),
      ],
      evidence:
        'Checks the vault has enough confirmations for CSV recovery and audits the broadcast recovery transaction sequence, version, threshold model, and outputs.',
    }),
  ];

  printResult('live acceptance evidence checklist', {
    purpose: 'Run these commands with real mainnet txids/outpoints to produce evidence for the preserved round-based acceptance items in spec.md section 8.',
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
  let finalized: Awaited<ReturnType<typeof finalizePsbt>> | null = null;
  let rawTxHex = stringArg(args, 'hex');
  if (!rawTxHex) {
    const psbtBase64 = requireArg(args, 'psbt-base64');
    finalized = await finalizePsbt(psbtBase64, true);
    assert(finalized.complete, 'PSBT is not complete and cannot be extracted');
    rawTxHex = finalized.hex;
  }
  assert(rawTxHex && /^[0-9a-f]+$/i.test(rawTxHex), 'raw transaction hex is not valid hex');
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
  const finalTxid = stringArg(args, 'final-txid');
  const firstLeaverId = requireArg(args, 'first-leaver');
  const secondLeaverId = requireArg(args, 'second-leaver');
  const state = createConfiguredState();

  const firstRemaining = participantIds(state).filter((id) => id !== firstLeaverId);
  const lastParticipantId = firstRemaining.find((id) => id !== secondLeaverId);
  assert(lastParticipantId, 'could not derive last participant from leaver order');

  // verbosity 2 asks Core to include prevout data on inputs when available.
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
    Boolean(fundingVault) && transactionSpendsOutpoint(firstTx, fundingTxid, fundingVault!.vout),
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
    Boolean(roundTwoVault) && transactionSpendsOutpoint(secondTx, firstTxid, roundTwoVault!.vout),
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

  const confirmationTargets: Array<[string, RpcTransaction]> = [
    ['funding tx', fundingTx],
    ['first withdrawal tx', firstTx],
    ['second withdrawal tx', secondTx],
    ...(finalTx ? ([['final sweep tx', finalTx]] as Array<[string, RpcTransaction]>) : []),
  ];
  for (const [label, tx] of confirmationTargets) {
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
  assert(actual, 'vault UTXO not found');

  const valueSats = btcToSats(actual.value);
  const psbt = buildSoloWithdrawalPsbt({ state, currentIds, leaverId, txid, vout, valueSats });
  const inspection = inspectPsbt(psbt.psbtBase64);
  const localPolicyFailures = evaluatePolicy(
    psbtInspectionToPolicyTx({ state, inspection }),
    requirePolicy(state, currentIds, leaverId),
  );
  assert(localPolicyFailures.length === 0, `solo PSBT violates local policy: ${localPolicyFailures.join('; ')}`);

  const keyIdEnvName = sigbashKeyIdEnvName(leaverId, roundId(currentIds));
  const keyId = stringArg(args, 'key-id') || process.env[keyIdEnvName];
  const checks = [
    ...utxoChecks,
    check('local Sigbash policy preflight passes', localPolicyFailures.length === 0),
    check(`${keyIdEnvName} is available`, Boolean(keyId), { keyId: keyId || null }),
    check('SIGBASH_MODE=live', process.env.SIGBASH_MODE === 'live', {
      actual: process.env.SIGBASH_MODE || null,
    }),
  ];

  let liveVerification = null;
  let liveSignature: SigbashSignResult | null = null;
  let signedArtifacts: ReturnType<typeof normalizeSigbashSigningResult> | null = null;
  let authorization: SoloSigningAuthorization | null = null;
  if (checks.every((item) => item.ok)) {
    const adapter = await createSigbashAdapter({ participantId: leaverId });
    const policy = {
      ...requirePolicy(state, currentIds, leaverId),
      keyId,
    };
    liveVerification = await adapter.verifyPSBT({ psbtBase64: psbt.psbtBase64 }, policy);
    const verificationPassed = sigbashVerificationPassed(liveVerification);
    checks.push(check('Sigbash live verifyPSBT passes', verificationPassed, liveVerification));
    if (verificationPassed && args.sign !== 'false') {
      liveSignature = await adapter.signPSBT({ psbtBase64: psbt.psbtBase64 }, policy);
      signedArtifacts = normalizeSigbashSigningResult(liveSignature);
      const artifactsReturned = Boolean(
        signedArtifacts.success && (signedArtifacts.txHex || signedArtifacts.signedPsbtBase64),
      );
      checks.push(
        check(
          'Sigbash live signPSBT returned a broadcast or signed-PSBT artifact',
          artifactsReturned,
          signedArtifacts,
        ),
      );
      if (artifactsReturned) {
        try {
          authorization = authorizeSoloSigningArtifacts(state, currentIds, leaverId, psbt.psbtBase64, {
            txHex: signedArtifacts.txHex,
            signedPsbtBase64: signedArtifacts.signedPsbtBase64,
          });
          checks.push(
            check(
              'signer artifacts are authorized for broadcast (exact transaction, policy-spend leaf only)',
              true,
              authorization,
            ),
          );
        } catch (error) {
          checks.push(
            check(
              'signer artifacts are authorized for broadcast (exact transaction, policy-spend leaf only)',
              false,
              { error: errorMessage(error) },
            ),
          );
        }
      }
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
    authorization,
    checks,
    passed: checks.every((item) => item.ok),
    nextCommands: signedArtifacts && authorization ? sigbashSignedNextCommands(signedArtifacts) : [],
    nextStep:
      liveSignature === null
        ? 'Resolve failed checks or rerun without --sign false to request Sigbash signing.'
        : authorization === null
          ? 'Do not broadcast: the signer artifact failed local authorization.'
        : 'Broadcast txHex directly when present; otherwise merge/finalize signedPsbtBase64, broadcast it, then locate output 1 for the next round.',
  });
  assert(checks.every((item) => item.ok), 'live solo withdrawal failed');
}

// Pre-funding proving ground: builds the solo-withdrawal PSBT for a given (or
// placeholder) vault outpoint and runs live Sigbash verifyPSBT on the valid
// PSBT plus the three tamper variants without touching Bitcoin Core. With the
// explicit --sign true deployment gate, it additionally consumes one signing
// nullifier, requests a real mainnet service signature, and independently
// authorizes the returned transaction. Because every policy carries a
// descriptor-mode REQKEY, a pass also proves the tapscript leaf key we derived
// from the key's xpub matches what Sigbash itself derives.
async function livePolicyDryRun() {
  assert(
    process.env.SIGBASH_MODE === 'live',
    'live-policy-dry-run contacts Sigbash; rerun with SIGBASH_MODE=live',
  );
  const args = parseArgs(process.argv.slice(3));
  const currentIds = requireArg(args, 'round').split(',');
  const leaverId = requireArg(args, 'leaver');
  const txid = stringArg(args, 'txid') || 'f'.repeat(64);
  const vout = Number(args.vout ?? 0);
  const valueSats = Number(stringArg(args, 'value-sats') ?? expectedVaultValueSats(currentIds));
  const requestSignature = args.sign === true || args.sign === 'true';
  const placeholderOutpoint = stringArg(args, 'txid') === undefined;
  assert(!requestSignature || placeholderOutpoint,
    'the predeployment signing proof must use its deliberately unfunded placeholder outpoint');
  const proofReceiptPath = requestSignature
    ? stringArg(args, 'receipt-output') || 'live-run/predeployment-proof-receipt.json'
    : null;
  if (proofReceiptPath) assertFreshProtectedOutputPath(proofReceiptPath, 'live Sigbash proof receipt');
  const state = createConfiguredState();
  const round = roundId(currentIds);
  const leafKey = sigbashRoundKey(participantById(state, leaverId), round);
  assert(
    leafKey.isLiveKey,
    `SIGBASH_LEAF_KEYS_JSON has no live leaf key for ${leaverId}:${round}; run sigbash-live-setup first`,
  );
  const keyId = stringArg(args, 'key-id') || process.env[sigbashKeyIdEnvName(leaverId, round)];
  assert(keyId, `missing --key-id or ${sigbashKeyIdEnvName(leaverId, round)}`);
  const policy = { ...requirePolicy(state, currentIds, leaverId), keyId };

  const variants = buildSoloWithdrawalTamperPsbts({ state, currentIds, leaverId, txid, vout, valueSats });
  const adapter = await createSigbashAdapter({ participantId: leaverId });
  const liveValid = await adapter.verifyPSBT({ psbtBase64: variants.valid.psbtBase64 }, policy);
  const liveTampered: Record<string, SigbashVerifyResult> = {};
  for (const [name, psbt] of Object.entries(variants.tampered)) {
    liveTampered[name] = await adapter.verifyPSBT({ psbtBase64: psbt.psbtBase64 }, policy);
  }
  const checks = [
    check('Sigbash verifyPSBT accepts the valid solo PSBT (REQKEY leaf-key assumption holds)', sigbashVerificationPassed(liveValid), liveValid),
    ...Object.entries(liveTampered).map(([name, result]) =>
      check(
        `Sigbash verifyPSBT explicitly rejects tampered ${name} PSBT`,
        sigbashVerificationExplicitlyRejected(result),
        result,
      ),
    ),
  ];
  let liveSignature: SigbashSignResult | null = null;
  let signedArtifacts: ReturnType<typeof normalizeSigbashSigningResult> | null = null;
  let authorization: SoloSigningAuthorization | null = null;
  let proofReceipt: LiveSigbashProofReceipt | null = null;
  let proofReceiptFile: { path: string; reused: boolean } | null = null;
  if (requestSignature && checks.every((item) => item.ok)) {
    liveSignature = await adapter.signPSBT({ psbtBase64: variants.valid.psbtBase64 }, policy);
    signedArtifacts = normalizeSigbashSigningResult(liveSignature);
    const artifactsReturned = Boolean(
      signedArtifacts.success && (signedArtifacts.txHex || signedArtifacts.signedPsbtBase64),
    );
    checks.push(check(
      'Sigbash live signPSBT returns a transaction or signed PSBT artifact',
      artifactsReturned,
      signedArtifacts,
    ));
    if (artifactsReturned) {
      try {
        authorization = authorizeSoloSigningArtifacts(
          state,
          currentIds,
          leaverId,
          variants.valid.psbtBase64,
          {
            txHex: signedArtifacts.txHex,
            signedPsbtBase64: signedArtifacts.signedPsbtBase64,
          },
        );
        checks.push(check(
          'live Sigbash artifact is the exact consensus-valid policy-leaf transaction',
          Boolean(authorization.finalTxid && authorization.consensus),
          authorization,
        ));
      } catch (error) {
        checks.push(check(
          'live Sigbash artifact is the exact consensus-valid policy-leaf transaction',
          false,
          { error: errorMessage(error) },
        ));
      }
    }
  }
  if (requestSignature && checks.every((item) => item.ok) && signedArtifacts && authorization) {
    proofReceipt = createLiveSigbashProofReceipt({
      createdAt: new Date().toISOString(),
      round,
      leaverId,
      keyId,
      placeholderOutpoint,
      psbtBase64: variants.valid.psbtBase64,
      signedArtifacts,
      authorization,
      checks,
    });
    proofReceiptFile = writeProtectedFile(
      proofReceiptPath!,
      `${JSON.stringify(proofReceipt, null, 2)}\n`,
    );
  }
  printResult(requestSignature
    ? 'live predeployment Sigbash mainnet signing proof'
    : 'live policy dry-run (no chain lookup, no nullifier consumed)', {
    round,
    leaverId,
    keyId,
    outpoint: `${txid}:${vout}`,
    valueSats,
    placeholderOutpoint,
    signatureRequested: requestSignature,
    liveSignature,
    signedArtifacts,
    authorization,
    proofReceipt: proofReceipt ? {
      proofDigest: proofReceipt.proofDigest,
      finalTxid: proofReceipt.finalTxid,
      file: proofReceiptFile,
    } : null,
    checks,
    passed: checks.every((item) => item.ok),
  });
  assert(checks.every((item) => item.ok), requestSignature
    ? 'live predeployment Sigbash mainnet signing proof failed'
    : 'live policy dry-run failed');
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
  assert(actual, 'vault UTXO not found');

  const keyId = stringArg(args, 'key-id') || process.env[sigbashKeyIdEnvName(leaverId, roundId(currentIds))];
  assert(keyId, `missing --key-id or ${sigbashKeyIdEnvName(leaverId, roundId(currentIds))}`);
  const policy = {
    ...requirePolicy(state, currentIds, leaverId),
    keyId,
  };
  assert(policy.conditions, `unknown policy for ${leaverId} in ${roundId(currentIds)}`);

  const variants = buildSoloWithdrawalTamperPsbts({
    state,
    currentIds,
    leaverId,
    txid,
    vout,
    valueSats: btcToSats(actual.value),
  });
  const localChecks = soloTamperLocalChecks({ state, currentIds, leaverId, variants });
  const adapter = await createSigbashAdapter({ participantId: leaverId });
  const liveValid = await adapter.verifyPSBT({ psbtBase64: variants.valid.psbtBase64 }, policy);
  const liveTampered: Record<string, SigbashVerifyResult> = {};
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
      check(
        `Sigbash verifyPSBT explicitly rejects tampered ${name} PSBT`,
        sigbashVerificationExplicitlyRejected(result),
        result,
      ),
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
  const participant = participantById(state, leaverId);
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
      sigbashLeafKey: participant.sigbashByRound[roundId(currentIds)].xonlyPubKeyHex,
      inputCount: 1,
      outputs: actualOutputs.map((output) => ({
        address: output.address,
        value: output.valueSats,
      })),
    },
    requirePolicy(state, currentIds, leaverId),
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
  const readiness = expectedCooperativeReadiness({
    state,
    currentIds,
    valueSats: args['value-sats'] === undefined ? undefined : Number(args['value-sats']),
  });
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
      'all current participants receive exactly one equal refund of the pot',
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
      input && (input.sequence ?? 0) >= RECOVERY_DELAY_BLOCKS,
      input ? { sequence: input.sequence } : undefined,
    ),
    check(
      'recovery input sequence does not disable BIP68 CSV',
      input && (input.sequence ?? 0xffffffff) < 0x80000000,
      input ? { sequence: input.sequence } : undefined,
    ),
    check('recovery transaction version enables BIP68 CSV', (tx.version ?? 0) >= 2, {
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
  const participant = participantById(state, participantId);
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
    sighashType: stringArg(args, 'sighash-type') || 'ALL',
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
  await sigbashSdkContract();
  await psbtAcceptance();
  await dualLeafAcceptance();
  await consensusAcceptance();
  await custodyAcceptance();
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

// Consensus-level verification of every transaction shape the vault can emit.
// Each fully signed transaction is checked independently of the signing code:
// control-block merkle commitment, BIP-341 sighash recomputation, Schnorr
// signature verification, tapscript semantics (CHECKSIG / CHECKSIGADD /
// NUMEQUAL / CSV), BIP-68 sequence encoding, and a 1 sat/vB relay-fee floor.
async function consensusAcceptance() {
  const vectors = runBip327KeyAggVectors();
  assert(vectors.passed, `BIP-327 KeyAgg vectors failed: ${JSON.stringify(vectors.results)}`);

  const protocolVectors = runBip327ProtocolVectors();
  assert(
    protocolVectors.passed,
    `BIP-327 protocol vectors failed: ${JSON.stringify(
      protocolVectors.checks.filter((item) => !item.ok),
    )}`,
  );

  const state = createDemoState();
  const roundOneIds = ['alice', 'bob', 'carol'];
  const roundOneVault = requireVault(state, roundOneIds);
  const roundTwoVault = requireVault(state, ['bob', 'carol']);
  const fundingTxid = '0000000000000000000000000000000000000000000000000000000000000001';
  const verified = [];

  // Solo withdrawals + final sweep chain.
  const run = buildSignedLocalWithdrawalRun(state);
  const prevoutsByStage = [
    { scriptPubKeyHex: roundOneVault.outputScriptHex, valueSats: AMOUNTS.deposit * 3 },
    {
      scriptPubKeyHex: roundTwoVault.outputScriptHex,
      valueSats: run.stages[0].outputs[1].valueSats,
    },
    {
      scriptPubKeyHex: run.stages[1].outputs[1].scriptPubKeyHex,
      valueSats: run.stages[1].outputs[1].valueSats,
    },
  ];
  run.stages.forEach((stage, index) => {
    const result = verifyVaultTransaction({
      txHex: stage.transactionHex,
      prevouts: [prevoutsByStage[index]],
    });
    verified.push({ transaction: stage.step, ...result });
  });

  // Cooperative exit via the MuSig2 key path.
  const cooperativePsbtBuilt = buildCooperativeExitPsbt({
    state,
    currentIds: roundOneIds,
    txid: fundingTxid,
    vout: 0,
    valueSats: AMOUNTS.deposit * 3,
  });
  const cooperativeSigned = signCooperativeExitPsbt({
    state,
    currentIds: roundOneIds,
    psbtBase64: cooperativePsbtBuilt.psbtBase64,
  });
  verified.push({
    transaction: 'cooperative exit (round one)',
    ...verifyVaultTransaction({
      txHex: cooperativeSigned.transactionHex,
      prevouts: [{ scriptPubKeyHex: roundOneVault.outputScriptHex, valueSats: AMOUNTS.deposit * 3 }],
    }),
  });

  // Timelocked recovery with a vanished participant (2-of-3 CHECKSIGADD with
  // an empty witness slot) for round one, and 1-of-2 for a pair round.
  const recoveryBuilt = buildRecoveryPsbt({
    state,
    currentIds: roundOneIds,
    vanishedId: 'carol',
    txid: fundingTxid,
    vout: 0,
    valueSats: AMOUNTS.deposit * 3,
  });
  const recoverySigned = signRecoveryPsbt({
    state,
    currentIds: roundOneIds,
    vanishedId: 'carol',
    psbtBase64: recoveryBuilt.psbtBase64,
  });
  verified.push({
    transaction: 'timelocked recovery (carol vanished, 2-of-3)',
    ...verifyVaultTransaction({
      txHex: recoverySigned.transactionHex,
      prevouts: [{ scriptPubKeyHex: roundOneVault.outputScriptHex, valueSats: AMOUNTS.deposit * 3 }],
    }),
  });

  const pairRecoveryBuilt = buildRecoveryPsbt({
    state,
    currentIds: ['bob', 'carol'],
    vanishedId: 'carol',
    txid: fundingTxid,
    vout: 0,
    valueSats: 204_999_000,
  });
  const pairRecoverySigned = signRecoveryPsbt({
    state,
    currentIds: ['bob', 'carol'],
    vanishedId: 'carol',
    psbtBase64: pairRecoveryBuilt.psbtBase64,
  });
  verified.push({
    transaction: 'timelocked recovery (pair round, 1-of-2)',
    ...verifyVaultTransaction({
      txHex: pairRecoverySigned.transactionHex,
      prevouts: [{ scriptPubKeyHex: roundTwoVault.outputScriptHex, valueSats: 204_999_000 }],
    }),
  });

  // Pair-round cooperative exit exercises 2-key MuSig2 aggregation.
  const pairCooperativeBuilt = buildCooperativeExitPsbt({
    state,
    currentIds: ['bob', 'carol'],
    txid: fundingTxid,
    vout: 0,
    valueSats: 204_999_000,
  });
  const pairCooperativeSigned = signCooperativeExitPsbt({
    state,
    currentIds: ['bob', 'carol'],
    psbtBase64: pairCooperativeBuilt.psbtBase64,
  });
  verified.push({
    transaction: 'cooperative exit (pair round)',
    ...verifyVaultTransaction({
      txHex: pairCooperativeSigned.transactionHex,
      prevouts: [{ scriptPubKeyHex: roundTwoVault.outputScriptHex, valueSats: 204_999_000 }],
    }),
  });

  // Interactive MuSig2 ceremony must produce a consensus-valid cooperative
  // exit identical to the reference aggregate signer, for both round sizes.
  const ceremonyResults = [roundOneIds, ['bob', 'carol']].map((ids) => {
    const vault = requireVault(state, ids);
    const potSats = ids.length === 3 ? AMOUNTS.deposit * 3 : 204_999_000;
    const trustedInput = asTrustedVaultInput({
      txid: fundingTxid,
      vout: 0,
      valueSats: potSats,
      scriptPubKeyHex: vault.outputScriptHex,
    });
    const context = ceremonyStart({ state, currentIds: ids, trustedInput });
    const pubById = Object.fromEntries(ids.map((id) => [id, participantById(state, id).personal.publicKeyHex]));
    const nonces = ids.map((id) => ceremonyNonce({ state, participantId: id, context, trustedInput }));
    const pubnonces = Object.fromEntries(ids.map((id, i) => [pubById[id]!, nonces[i]!.pubnonce]));
    const partials = Object.fromEntries(
      ids.map((id, i) => [
        pubById[id]!,
        ceremonyPartial({ state, participantId: id, context, pubnonces, secnonce: nonces[i]!.secnonce, trustedInput })
          .partialSig,
      ]),
    );
    const finalTx = ceremonyAggregate({ state, context, pubnonces, partialSigs: partials, trustedInput });
    const verification = verifyVaultTransaction({
      txHex: finalTx.transactionHex,
      prevouts: [{ scriptPubKeyHex: vault.outputScriptHex, valueSats: potSats }],
    });
    return { round: vault.id, txid: finalTx.txid, consensusChecks: verification.checks };
  });
  assert(ceremonyResults.every((item) => item.consensusChecks.length > 0), 'ceremony produced no verified transaction');

  printResult('consensus acceptance', {
    bip327KeyAggVectors: vectors,
    interactiveMusig2Ceremony: ceremonyResults,
    bip327ProtocolVectors: {
      passed: protocolVectors.passed,
      total: protocolVectors.total,
      byVector: Object.entries(
        protocolVectors.checks.reduce<Record<string, number>>((acc, item) => {
          acc[item.vector] = (acc[item.vector] ?? 0) + 1;
          return acc;
        }, {}),
      ).map(([vector, count]) => ({ vector, count })),
    },
    verifiedTransactions: verified,
  });
}

// Offline adversarial proof of the distributed-custody boundary: one secret
// per device, independent MuSig2/recovery participation, and fail-closed
// rejection of every hostile artifact we could think to build. No network, no
// credentials, no real secrets.
async function custodyAcceptance() {
  const report = runCustodyAcceptance();
  printResult('custody acceptance (offline, adversarial)', report);
  assert(
    report.passed,
    `custody acceptance failed: ${JSON.stringify(report.checks.filter((item) => !item.ok))}`,
  );
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
  const compiled = [...state.policies.values()].map((policy) => ({
    policyId: policy.id,
    leaverId: policy.leaverId,
    poetPolicy: toPoetPolicy(sdk, policy),
  }));
  printResult('sdk policy conversion', {
    sdkVersion: sdk.SDK_VERSION || 'unknown',
    policies: compiled.map(({ policyId: id, leaverId, poetPolicy }) => ({
      policyId: id,
      leaverId,
      version: poetPolicy.version,
      rootOperator: poetPolicy.policy?.operator,
      conditionCount: poetPolicy.policy?.children?.length,
    })),
  });
}

// Offline proof of the pinned @sigbash/sdk 0.7.1 surface plus the fail-closed
// result gates, credential atomicity, and WASM-hash validation. No network,
// no credentials, no WASM loading — safe to run inside `npm test`.
async function sigbashSdkContract() {
  const { passed, checks } = await runSigbashOfflineChecks();
  printResult('sigbash sdk contract (offline)', { checks, passed });
  assert(
    passed,
    `sigbash sdk contract checks failed: ${JSON.stringify(checks.filter((item) => !item.ok))}`,
  );
}

interface LiveKeyRegistration {
  participantId: string;
  round: string;
  keyId: string;
  keyIndex: number;
  keyIdEnvName: string;
  bip328Xpub: string;
  /** Canonical policy-spend leaf key: the xpub's child 0/0. */
  policyLeafXonlyPubkey: string;
  /** Canonical identification leaf key: the xpub's internal root. */
  identificationLeafXonlyPubkey: string;
  helperP2trAddressDoNotFund: string | undefined;
  policyRoot: string;
  policyId: string;
}

// Single construction point for a leaf override, shared by the fresh
// registration path and checkpoint resume so both are guaranteed to derive
// the identical dual-leaf vault addresses.
function checkpointRegistrationToOverride(registration: LiveKeyRegistration): {
  key: string;
  xpub: string;
  identificationKey: string;
} {
  return {
    key: registration.policyLeafXonlyPubkey,
    xpub: registration.bip328Xpub,
    identificationKey: registration.identificationLeafXonlyPubkey,
  };
}

// Strict checkpoint validation: a legacy line (single ambiguous
// leafXonlyPubkey), a line missing either canonical leaf field, or a line
// whose leaf keys do not match its own xpub is rejected outright. Resuming
// from such a line would silently rebuild a different vault address than a
// fresh run — the exact bug this format exists to prevent.
function parseSetupCheckpointLine(line: string): LiveKeyRegistration {
  const parsed = JSON.parse(line) as Partial<LiveKeyRegistration> & {
    leafXonlyPubkey?: string;
  };
  const where = `${parsed.participantId ?? '?'}:${parsed.round ?? '?'}`;
  if (parsed.leafXonlyPubkey !== undefined) {
    throw new Error(
      `legacy setup checkpoint entry for ${where} (single leafXonlyPubkey): the dual-leaf ` +
        'format requires policyLeafXonlyPubkey and identificationLeafXonlyPubkey. Move the old ' +
        'checkpoint aside and re-run sigbash-live-setup (existing keys cannot be reused safely).',
    );
  }
  for (const field of [
    'participantId',
    'round',
    'keyId',
    'keyIdEnvName',
    'bip328Xpub',
    'policyLeafXonlyPubkey',
    'identificationLeafXonlyPubkey',
  ] as const) {
    if (typeof parsed[field] !== 'string' || parsed[field] === '') {
      throw new Error(`incomplete setup checkpoint entry for ${where}: missing ${field}`);
    }
  }
  const registration = parsed as LiveKeyRegistration;
  const expectedPolicyLeaf = deriveXpubChildPubkey(registration.bip328Xpub, [0, 0]).xonlyPubKeyHex;
  if (registration.policyLeafXonlyPubkey !== expectedPolicyLeaf) {
    throw new Error(
      `mixed/corrupt setup checkpoint entry for ${where}: policyLeafXonlyPubkey is not the xpub's child 0/0`,
    );
  }
  const expectedIdentificationLeaf = xpubRootXonly(registration.bip328Xpub);
  if (registration.identificationLeafXonlyPubkey !== expectedIdentificationLeaf) {
    throw new Error(
      `mixed/corrupt setup checkpoint entry for ${where}: identificationLeafXonlyPubkey is not the xpub's internal root`,
    );
  }
  return registration;
}

// Creates one immutable Sigbash key per (participant, round-they-could-leave):
// nine keys total. Pair-round keys are created first because their policies
// reference only payout addresses; round-one policies then pin the pair-round
// vault addresses computed from the pair keys. Nothing here needs the
// admin-only `updateable` flag or updatePolicy() (which would also impose a
// 24-hour signing cooldown) — every policy is final at creation time.
async function sigbashLiveSetup() {
  assert(
    process.env.SIGBASH_MODE === 'live',
    'sigbash-live-setup mutates Sigbash server state; rerun with SIGBASH_MODE=live',
  );
  const setupArgs = parseArgs(process.argv.slice(3));
  const proofRoundRaw = stringArg(setupArgs, 'proof-round');
  const proofEnvironmentOutput = stringArg(setupArgs, 'proof-env-output');
  assert(!proofEnvironmentOutput || proofRoundRaw,
    '--proof-env-output is valid only with --proof-round');
  const bootstrapState = createDemoState();
  const allIds = participantIds(bootstrapState);
  const roundOne = roundId(allIds);
  const proofRoundIds = proofRoundRaw?.split(',');
  if (proofRoundIds) {
    assert(
      proofRoundIds.length === 2 &&
        new Set(proofRoundIds).size === 2 &&
        proofRoundIds.every((id) => allIds.includes(id)),
      '--proof-round must contain exactly two distinct participants from alice,bob,carol',
    );
  }
  const proofRound = proofRoundIds ? roundId(proofRoundIds) : null;
  const leafOverrides: Record<
    string,
    Record<string, { key: string; xpub: string; identificationKey: string }>
  > = Object.fromEntries(allIds.map((id) => [id, {}]));
  // Resumable checkpoint: each successful registration is appended here so a
  // rate-limit/timeout partway through does not strand created keys. Rerunning
  // reloads it and skips (participant, round) pairs already registered. Fresh
  // and resumed runs build the leaf overrides through the same
  // checkpointRegistrationToOverride() so they can never derive different
  // vault addresses; legacy/mixed/incomplete checkpoint lines abort the run.
  const checkpointPath = process.env.SIGBASH_SETUP_CHECKPOINT || (proofRound
    ? 'live-run/predeployment-setup-checkpoint.jsonl'
    : 'live-run/setup-checkpoint.jsonl');
  const checkpointParent = dirname(checkpointPath);
  mkdirSync(checkpointParent, { recursive: true, mode: 0o700 });
  const checkpointParentStat = lstatSync(checkpointParent);
  assert(checkpointParentStat.isDirectory() && !checkpointParentStat.isSymbolicLink(),
    'Sigbash setup checkpoint parent must be a real directory, not a link');
  assert((checkpointParentStat.mode & 0o077) === 0,
    'Sigbash setup checkpoint parent must not be accessible by group or other users');
  if (existsSync(checkpointPath)) {
    const checkpointStat = lstatSync(checkpointPath);
    assert(checkpointStat.isFile() && !checkpointStat.isSymbolicLink(),
      'Sigbash setup checkpoint must be a regular file, not a link');
    assert((checkpointStat.mode & 0o077) === 0,
      'Sigbash setup checkpoint must not be accessible by group or other users');
  }
  const registrations: LiveKeyRegistration[] = [];
  const doneKeys = new Set<string>();
  if (existsSync(checkpointPath)) {
    for (const line of readFileSync(checkpointPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const registration = parseSetupCheckpointLine(line);
      if (proofRound && (
        registration.round !== proofRound || !proofRoundIds!.includes(registration.participantId)
      )) {
        throw new Error('predeployment checkpoint contains a key outside the selected pair round');
      }
      registrations.push(registration);
      doneKeys.add(`${registration.participantId}:${registration.round}`);
      leafOverrides[registration.participantId]![registration.round] =
        checkpointRegistrationToOverride(registration);
    }
    console.error(`  resuming: ${doneKeys.size} key(s) already registered`);
  }

  const registerKey = async (state: VaultState, participantId: string, round: string) => {
    if (doneKeys.has(`${participantId}:${round}`)) return;
    const participant = participantById(state, participantId);
    const vault = state.vaults.get(round);
    if (!vault) throw new Error(`unknown vault round ${round}`);
    const policy = requirePolicy(state, vault.participantIds, participantId);
    const { sdk, client } = await createLiveSigbashClient({
      participantId,
      musig2PrivateKey: sigbashRoundKey(participant, round).privateKeyHex,
    });
    const created = await createKeyWithAutoIndex(client, {
      policy: toPoetPolicy(sdk, policy),
      network: NETWORK,
      require2FA: false,
      verbose: true,
    });
    assert(created.bip328Xpub, `Sigbash did not return bip328Xpub for ${participantId}:${round}`);
    // Dual-leaf structure, live-verified (see REVIEW.md "Input identification
    // — solved"): the xpub child 0/0 is the policy-spend leaf key that
    // satisfies the descriptor-mode REQKEY clause; the xpub's internal root
    // is the identification leaf key that satisfies input identification.
    // Both are persisted as separate canonical checkpoint fields.
    const policyLeafXonlyPubkey = deriveXpubChildPubkey(created.bip328Xpub, [0, 0]).xonlyPubKeyHex;
    const identificationLeafXonlyPubkey = xpubRootXonly(created.bip328Xpub);
    const registration: LiveKeyRegistration = {
      participantId,
      round,
      keyId: created.keyId,
      keyIndex: created.keyIndex,
      keyIdEnvName: sigbashKeyIdEnvName(participantId, round),
      bip328Xpub: created.bip328Xpub,
      policyLeafXonlyPubkey,
      identificationLeafXonlyPubkey,
      helperP2trAddressDoNotFund: created.p2trAddress,
      policyRoot: created.policyRoot,
      policyId: policy.id,
    };
    leafOverrides[participantId]![round] = checkpointRegistrationToOverride(registration);
    registrations.push(registration);
    doneKeys.add(`${participantId}:${round}`);
    appendFileSync(checkpointPath, `${JSON.stringify(registration)}\n`, {
      encoding: 'utf8',
      flag: 'a',
      mode: 0o600,
    });
    chmodSync(checkpointPath, 0o600);
    console.error(
      `  registered ${participantId}:${round} as keyId ${created.keyId} ` +
      `(${doneKeys.size}/${proofRound ? 2 : 9})`,
    );
    client.disconnect?.();
  };

  if (proofRound && proofRoundIds) {
    for (const participantId of proofRoundIds) {
      await registerKey(bootstrapState, participantId, proofRound);
    }
    const proofState = createDemoState({ sigbashLeafOverrides: leafOverrides });
    const proofVault = requireVault(proofState, proofRoundIds);
    const proofRegistrations = registrations.filter((registration) =>
      registration.round === proofRound && proofRoundIds.includes(registration.participantId));
    assert(proofRegistrations.length === 2,
      'predeployment setup must contain exactly both pair-round registrations');
    const envExports = [
      `SIGBASH_LEAF_KEYS_JSON='${JSON.stringify(leafOverrides)}'`,
      ...proofRegistrations.map(
        (registration) => `${registration.keyIdEnvName}=${registration.keyId}`,
      ),
    ];
    const proofEnvironment = writeProtectedEnvironmentFile(
      proofEnvironmentOutput ?? 'live-run/predeployment.env',
      [
        '# Generated from the immutable two-key Sigbash predeployment checkpoint.',
        '# This file contains identifiers, not the credential triplet; keep both files together for the proof.',
        ...envExports,
        '',
      ].join('\n'),
    );
    printResult('live Sigbash predeployment pair setup', {
      warning: 'This is a real immutable mainnet pair-round vault setup. Do not fund its address.',
      round: proofRound,
      participants: proofRoundIds,
      registrations: proofRegistrations,
      proofEnvironment,
      envExports,
      vault: {
        address: proofVault.address,
        descriptor: proofVault.descriptor,
        tapscriptLeaves: proofVault.tapscriptLeaves,
      },
      policies: proofRoundIds.map((participantId) =>
        requirePolicy(proofState, proofRoundIds, participantId)),
      next:
        `Run live-predeployment-proof with --round ${proofRoundIds.join(',')} ` +
        `--leaver ${proofRoundIds[0]}; its package command loads the protected proof environment.`,
    });
    return;
  }

  for (const participant of bootstrapState.participants) {
    for (const round of participantLeaveRounds(participant.id, allIds)) {
      if (round === roundOne) continue;
      await registerKey(bootstrapState, participant.id, round);
    }
  }

  const statePairs = createDemoState({ sigbashLeafOverrides: leafOverrides });
  for (const participant of statePairs.participants) {
    await registerKey(statePairs, participant.id, roundOne);
  }

  const finalState = createDemoState({ sigbashLeafOverrides: leafOverrides });
  printResult('live Sigbash setup', {
    warning:
      'Do not fund any helper p2trAddress. Fund only the printed round-one vault address, and only after verifying every key registration above succeeded.',
    liveSigningGate:
      'Registration and verifyPSBT are proven live; actual live signPSBT success remains an ' +
      'external gate (Sigbash server signing service error — see REVIEW.md). Do not fund on the ' +
      'assumption that live solo signing works.',
    registrations,
    envExports: [
      `SIGBASH_LEAF_KEYS_JSON='${JSON.stringify(leafOverrides)}'`,
      ...registrations.map(
        (registration) => `${registration.keyIdEnvName}=${registration.keyId}`,
      ),
    ],
    vaults: [...finalState.vaults.values()].map((vault) => ({
      round: vault.id,
      participants: vault.participantIds,
      address: vault.address,
      descriptor: vault.descriptor,
      keyPath: vault.keyPath,
      tapscriptLeaves: vault.tapscriptLeaves,
    })),
    policies: [...finalState.policies.values()],
  });
}

/** Print only the non-secret organization identifier needed for mainnet enablement. */
async function sigbashOrgId() {
  const args = parseArgs(process.argv.slice(3));
  const participantId = stringArg(args, 'participant');
  if (participantId !== undefined) {
    assert(PARTICIPANTS.some((participant) => participant.id === participantId),
      '--participant must be alice, bob, or carol');
  }
  const credentials = resolveSigbashCredentials(process.env, participantId);
  const { getAuthHash } = await import('@sigbash/sdk');
  const { apikeyHash } = await getAuthHash(credentials.apiKey, credentials.userKey);
  printResult('Sigbash mainnet activation identifier', {
    participantId: participantId ?? null,
    credentialSource: credentials.source,
    apikeyHash,
    secretValuesPrinted: false,
    note: 'Share only apikeyHash with Sigbash; never share the raw credential triplet.',
  });
}

/** Create one CLI proof credential without exposing or permissively overwriting it. */
async function sigbashBootstrap() {
  const args = parseArgs(process.argv.slice(3));
  const created = await createSigbashCredentialFile(
    stringArg(args, 'output') ?? 'live-run/proof-credentials.env',
  );
  printResult('Sigbash CLI proof credential created', {
    ...created,
    next: 'Back up the credential file securely, request mainnet activation for apikeyHash, then run live-predeployment-setup followed by live-predeployment-proof.',
  });
}

async function createKeyWithAutoIndex(
  client: SigbashLiveClient,
  options: Omit<Parameters<SigbashLiveClient['createKey']>[0], 'keyIndex'> & { keyIndex?: number },
): ReturnType<SigbashLiveClient['createKey']> {
  let keyIndex = options.keyIndex ?? 0;
  for (let attempt = 0; attempt < 64; attempt += 1) {
    try {
      return await client.createKey({ ...options, keyIndex });
    } catch (error) {
      const nextIndex = (error as { nextAvailableIndex?: number })?.nextAvailableIndex;
      if (nextIndex !== undefined) {
        keyIndex = nextIndex;
        continue;
      }
      // The server rate-limits key registration (~1/min) and occasionally
      // times out a request; both are transient — wait and retry same index.
      const message = errorMessage(error).toLowerCase();
      if (message.includes('rate limit') || message.includes('timed out') || message.includes('timeout')) {
        console.error(`  … transient error on keyIndex ${keyIndex} (${message.slice(0, 60)}); waiting 65s`);
        await new Promise((resolve) => setTimeout(resolve, 65_000));
        continue;
      }
      throw error;
    }
  }
  throw new Error('could not create a Sigbash key after 64 attempts');
}

function createDeposits(ledger: Ledger, state: VaultState): void {
  const roundOne = requireVault(state, state.participants.map((p) => p.id));
  for (const participant of state.participants) {
    ledger.fund(roundOne.address, AMOUNTS.deposit, `${participant.label} deposit`);
  }
}

function printSetup(state: VaultState): void {
  printResult('setup', {
    participants: state.participants.map((p) => ({
      id: p.id,
      payoutAddress: p.payoutAddress,
      payoutXonlyPubkey: p.payout.xonlyPubKeyHex,
      personalXonlyPubkey: p.personal.xonlyPubKeyHex,
      sigbashPolicyLeafXonlyPubkeysByRound: Object.fromEntries(
        Object.entries(p.sigbashByRound).map(([round, key]) => [round, key.xonlyPubKeyHex]),
      ),
      sigbashIdentificationLeafXonlyPubkeysByRound: Object.fromEntries(
        Object.entries(p.sigbashByRound).map(([round, key]) => [
          round,
          key.identificationXonlyPubKeyHex,
        ]),
      ),
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
  });
}

function printResult(title: string, value: unknown): void {
  console.log(`\n=== ${title} ===`);
  console.log(JSON.stringify(value, null, 2));
}

function assertFreshProtectedOutputPath(rawPath: string, label: string): void {
  const parent = dirname(rawPath);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const parentStat = lstatSync(parent);
  assert(parentStat.isDirectory() && !parentStat.isSymbolicLink(),
    `${label} parent must be a real directory, not a link`);
  assert((parentStat.mode & 0o077) === 0,
    `${label} parent must not be accessible by group or other users`);
  assert(!existsSync(rawPath),
    `${label} already exists; archive it or choose a fresh --receipt-output before consuming another nullifier`);
}

// Live leaf keys come in one env var as nested JSON, exactly as printed by
// sigbash-live-setup: {"alice":{"alicebobcarol":"<xonly>","alicebob":"<xonly>",...},...}
function createConfiguredState() {
  let sigbashLeafOverrides = {};
  if (process.env.SIGBASH_LEAF_KEYS_JSON) {
    try {
      sigbashLeafOverrides = JSON.parse(process.env.SIGBASH_LEAF_KEYS_JSON);
    } catch (error) {
      throw new Error(`SIGBASH_LEAF_KEYS_JSON is not valid JSON: ${errorMessage(error)}`);
    }
  }
  return createDemoState({ sigbashLeafOverrides });
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface CliCheck {
  name: string;
  ok: boolean;
  [detail: string]: unknown;
}

function check(name: string, ok: unknown, details?: unknown): CliCheck {
  return { name, ok: Boolean(ok), ...(details === undefined ? {} : { details }) };
}

// Optional string arg: `--flag` with no value (true) is treated as missing.
function stringArg(args: CliArgs, name: string): string | undefined {
  const value = args[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function minConfirmationsFromArgs(args: CliArgs): number {
  const value = args['min-confirmations'] === undefined ? 1 : Number(args['min-confirmations']);
  assert(Number.isInteger(value) && value >= 0, '--min-confirmations must be a non-negative integer');
  return value;
}

function transactionConfirmationCheck(
  label: string,
  tx: RpcTransaction,
  minConfirmations: number,
): CliCheck {
  const confirmations = tx.confirmations || 0;
  return check(`${label} has at least ${minConfirmations} confirmation(s)`, confirmations >= minConfirmations, {
    confirmations,
    minConfirmations,
    txid: tx.txid,
    blockhash: tx.blockhash,
  });
}

type CliArgs = Record<string, string | true | undefined>;

function parseArgs(args: string[]): CliArgs {
  const parsed: CliArgs = {};
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index]!;
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

function requireArg(args: CliArgs, name: string): string {
  const value = args[name];
  if (value === undefined || value === true || value === '') {
    throw new Error(`missing required --${name}`);
  }
  return value;
}

// The coin a signer independently vouches for. Every signing command requires
// it: without it, "sign this PSBT" is a request to trust whoever built it
// about which outpoint and how many sats are being spent.
function trustedInputFromArgs(args: CliArgs): TrustedVaultInput {
  return asTrustedVaultInput({
    txid: requireArg(args, 'txid'),
    vout: Number(requireArg(args, 'vout')),
    valueSats: Number(requireArg(args, 'value-sats')),
    scriptPubKeyHex: requireArg(args, 'script-pubkey'),
  });
}

// Builder commands need vault state but no keys. --roster is the real thing;
// the demo-seed fallback keeps the offline demo flows working unchanged.
function builderState(args: CliArgs): VaultState {
  const roster = stringArg(args, 'roster');
  return roster ? loadPublicRoster(roster).state : createConfiguredState();
}

// Non-null lookups: rounds and policies in the precomputed tree are total for
// valid (round, leaver) combinations; a miss is a caller bug worth throwing on.
function requireVault(state: VaultState, currentIds: string[]): VaultRound {
  const vault = state.vaults.get(roundId(currentIds));
  if (!vault) throw new Error(`unknown vault round ${roundId(currentIds)}`);
  return vault;
}

function requirePolicy(state: VaultState, currentIds: string[], leaverId: string): SoloPolicy {
  const policy = state.policies.get(policyId(currentIds, leaverId));
  if (!policy) throw new Error(`unknown policy ${policyId(currentIds, leaverId)}`);
  return policy;
}

function impossibleBootstrapPolicy(participantId: string) {
  return {
    id: `bootstrap:${participantId}`,
    network: NETWORK,
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

function expectedVaultOutput(state: VaultState, currentIds: string[]) {
  const vault = requireVault(state, currentIds);
  return {
    round: vault.id,
    address: vault.address,
    valueSats: expectedVaultValueSats(currentIds),
    scriptPubKeyHex: vault.outputScriptHex,
  };
}

function expectedVaultValueSats(currentIds: string[]): number {
  if (currentIds.length === 3) {
    return AMOUNTS.deposit * 3;
  }
  if (currentIds.length === 2) {
    return AMOUNTS.deposit * 3 - AMOUNTS.firstWithdrawal - AMOUNTS.feePerSoloWithdrawal;
  }
  throw new Error(`no vault value for ${currentIds.length} participant(s); round 3 is a payout address`);
}

function expectedTransactionOutput({ args, state }: { args: CliArgs; state: VaultState }) {
  const roundArg = stringArg(args, 'round');
  if (roundArg) {
    const expected = expectedVaultOutput(state, roundArg.split(','));
    return {
      type: 'vault',
      round: expected.round,
      address: expected.address,
      scriptPubKeyHex: expected.scriptPubKeyHex,
      valueSats: expected.valueSats,
    };
  }
  const participantArg = stringArg(args, 'participant');
  if (participantArg) {
    const participant = participantById(state, participantArg);
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
  const addressArg = stringArg(args, 'address');
  if (addressArg) {
    const valueSats =
      args['value-sats'] === undefined ? undefined : Number(args['value-sats']);
    return {
      type: 'address',
      address: addressArg,
      scriptPubKeyHex: undefined,
      valueSats,
    };
  }
  throw new Error('rpc-find-output requires --round, --participant, or --address');
}

function expectedCooperativeReadiness({
  state,
  currentIds,
  valueSats,
}: {
  state: VaultState;
  currentIds: string[];
  valueSats?: number | undefined;
}) {
  const vault = requireVault(state, currentIds);
  const participants = currentIds.map((id) => participantById(state, id));
  const potSats = valueSats === undefined ? expectedVaultValueSats(currentIds) : valueSats;
  const refundSats = Math.floor((potSats - AMOUNTS.cooperativeFee) / participants.length);
  return {
    signerIds: participants.map((participant) => participant.id),
    signerPersonalXonlyPubkeys: participants.map((participant) => participant.personal.xonlyPubKeyHex),
    keyPathContainsOnlyPersonalKeys: verifyNoSigbashInKeyPath(vault),
    keyPath: vault.keyPath,
    refundOutputs: participants.map((participant, index) => ({
      index,
      address: participant.payoutAddress,
      valueSats: refundSats,
    })),
  };
}

function expectedRecoveryReadiness({
  state,
  currentIds,
  vanishedId,
}: {
  state: VaultState;
  currentIds: string[];
  vanishedId: string;
}) {
  const vault = requireVault(state, currentIds);
  const leaf = vault.tapscriptLeaves.find((item) => item.type === 'timelocked-recovery');
  if (leaf?.type !== 'timelocked-recovery') throw new Error(`no recovery leaf for ${vault.id}`);
  const signerIds = currentIds.filter((id) => id !== vanishedId);
  const signerPubkeys = signerIds.map(
    (id) => participantById(state, id).personal.xonlyPubKeyHex,
  );
  return {
    relativeBlocks: leaf.relativeBlocks,
    threshold: leaf.threshold,
    signerIds,
    signerPubkeys,
    scriptHex: leaf.scriptHex,
    controlBlockHex: leaf.controlBlockHex,
  };
}

function expectedRecoveryOutputs({
  state,
  currentIds,
  valueSats,
}: {
  state: VaultState;
  currentIds: string[];
  valueSats: number;
}) {
  const recoverEach = Math.floor((valueSats - AMOUNTS.recoveryFee) / currentIds.length);
  return currentIds.map((id, index) => {
    const participant = participantById(state, id);
    return {
      index,
      participantId: participant.id,
      address: participant.payoutAddress,
      valueSats: recoverEach,
    };
  });
}

function expectedSoloWithdrawalOutputs({
  state,
  currentIds,
  leaverId,
  inputValueSats,
}: {
  state: VaultState;
  currentIds: string[];
  leaverId: string;
  inputValueSats: number;
}) {
  const policy = requirePolicy(state, currentIds, leaverId);
  const payoutValue = policyOutputValue(policy, 0);
  const payoutAddress = policyOutputAddress(policy, 0);
  const nextAddress = policyOutputAddress(policy, 1);
  const floorSats = policyOutputValue(policy, 1);
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

// Fake transactions in the acceptance suite only carry the fields the
// locators read, so these helpers accept structural subsets of RpcTransaction.
interface TxWithOutputs {
  vout: RpcTxOutput[];
}

interface TxWithInputs {
  vin: RpcTxInput[];
}

interface ExpectedOutput {
  type?: string;
  round?: string;
  participantId?: string;
  address?: string | undefined;
  scriptPubKeyHex?: string | undefined;
  valueSats?: number | undefined;
}

function findTransactionOutputs(tx: TxWithOutputs, expected: ExpectedOutput) {
  return tx.vout
    .filter((output) => {
      const valueSats = btcToSats(output.value);
      const address = output.scriptPubKey?.address || output.scriptPubKey?.addresses?.[0];
      if (expected.valueSats !== undefined && valueSats !== expected.valueSats) return false;
      if (expected.scriptPubKeyHex && output.scriptPubKey?.hex !== expected.scriptPubKeyHex) return false;
      if (expected.address && address !== expected.address) return false;
      return true;
    })
    .map((output) => transactionOutputSummary(output));
}

function transactionOutputSummary(output: RpcTxOutput) {
  return {
    vout: output.n,
    valueBtc: output.value,
    valueSats: btcToSats(output.value),
    address: output.scriptPubKey?.address || output.scriptPubKey?.addresses?.[0],
    scriptPubKeyHex: output.scriptPubKey?.hex,
  };
}

type FetchTransaction = (txid: string, verbose?: boolean) => Promise<RpcTransaction>;

interface PrevoutView {
  value: number | null;
  scriptPubKey?: { address?: string; addresses?: string[]; hex?: string };
  fetchError?: string;
}

async function fundingInputSummaries(
  inputs: RpcTxInput[],
  fetchTransaction: FetchTransaction = getRawTransaction,
) {
  return Promise.all(
    inputs.map(async (input, index) => {
      const prevout: PrevoutView | null =
        input.prevout && input.prevout.value !== undefined
          ? { value: input.prevout.value, scriptPubKey: input.prevout.scriptPubKey }
          : await fetchPrevout(input, fetchTransaction);
      return {
        index,
        txid: input.txid,
        vout: input.vout,
        valueSats:
          prevout && prevout.value !== null && Number.isFinite(Number(prevout.value))
            ? btcToSats(prevout.value)
            : null,
        address: prevout?.scriptPubKey?.address || prevout?.scriptPubKey?.addresses?.[0] || null,
        source: input.prevout ? 'funding-tx-prevout' : prevout ? 'previous-transaction' : 'missing',
        fetchError: prevout?.fetchError,
      };
    }),
  );
}

async function fetchPrevout(
  input: RpcTxInput,
  fetchTransaction: FetchTransaction = getRawTransaction,
): Promise<PrevoutView | null> {
  if (!input?.txid || input.vout === undefined) return null;
  try {
    const previousTx = await fetchTransaction(input.txid, true);
    const output = previousTx.vout?.find((item) => item.n === input.vout);
    return output ? { value: output.value, scriptPubKey: output.scriptPubKey } : null;
  } catch (error) {
    return {
      value: null,
      scriptPubKey: {},
      fetchError: errorMessage(error),
    };
  }
}

function oneMatch(tx: TxWithOutputs, expected: ExpectedOutput) {
  const matches = findTransactionOutputs(tx, expected);
  return matches.length === 1 ? matches[0] : null;
}

function findTransactionInput(tx: TxWithInputs, txid: string, vout: number): RpcTxInput | undefined {
  return tx.vin.find((input) => input.txid === txid && input.vout === vout);
}

function transactionSpendsOutpoint(tx: TxWithInputs, txid: string, vout: number): boolean {
  return Boolean(findTransactionInput(tx, txid, vout));
}

function isTaprootKeyPathWitness(input: RpcTxInput | null | undefined): boolean {
  const witness = input?.txinwitness;
  if (!Array.isArray(witness) || witness.length !== 1) return false;
  return /^[0-9a-f]{128}([0-9a-f]{2})?$/i.test(witness[0]!);
}

function participantIds(state: VaultState): string[] {
  return state.participants.map((participant) => participant.id);
}

interface StartingOutpoint {
  txid: string;
  vout: number;
  valueSats: number;
}

function buildSignedLocalWithdrawalRun(
  state: VaultState,
  { startingOutpoint }: { startingOutpoint?: StartingOutpoint | undefined } = {},
) {
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
    requirePolicy(state, ['alice', 'bob', 'carol'], 'alice'),
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
    requirePolicy(state, ['bob', 'carol'], 'bob'),
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
      : 'Uses a placeholder funding txid for local extraction; rerun with --txid/--vout from a deliberately tiny real funded mainnet vault outpoint for broadcast-oriented transaction assembly.',
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

interface SignedRunStageInput {
  step: string;
  input: unknown;
  inspection: PsbtInspection;
  signed: { txid: string; transactionHex: string };
}

function signedRunStage({ step, input, inspection, signed }: SignedRunStageInput) {
  return {
    step,
    input,
    txid: signed.txid,
    transactionHex: signed.transactionHex,
    outputs: inspection.outputs.map((output) => ({
      index: output.index,
      address: output.address,
      valueSats: output.valueSats,
      scriptPubKeyHex: output.scriptPubKeyHex,
    })),
  };
}

function soloTamperLocalChecks({
  state,
  currentIds,
  leaverId,
  variants,
}: {
  state: VaultState;
  currentIds: string[];
  leaverId: string;
  variants: ReturnType<typeof buildSoloWithdrawalTamperPsbts>;
}) {
  const checkVariant = (psbt: { psbtBase64: string }) => {
    const inspection = inspectPsbt(psbt.psbtBase64);
    const failures = evaluatePolicy(
      psbtInspectionToPolicyTx({ state, inspection }),
      requirePolicy(state, currentIds, leaverId),
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

function evidenceItem({
  id,
  requirement,
  args,
  required,
  command,
  evidence,
}: {
  id: number;
  requirement: string;
  args: CliArgs;
  required: string[];
  command: string | string[];
  evidence: string;
}) {
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

function liveRunAuditCommand({
  args,
  firstLeaver,
  secondLeaver,
  includeFinal = false,
}: {
  args: CliArgs;
  firstLeaver: string;
  secondLeaver: string;
  includeFinal?: boolean;
}): string {
  return commandLine('npm run live-run-audit --', {
    'funding-txid': argOrPlaceholder(args, 'funding-txid'),
    'first-txid': argOrPlaceholder(args, 'first-txid'),
    'second-txid': argOrPlaceholder(args, 'second-txid'),
    ...(includeFinal ? { 'final-txid': argOrPlaceholder(args, 'final-txid') } : {}),
    'first-leaver': firstLeaver,
    'second-leaver': secondLeaver,
    'min-confirmations': stringArg(args, 'min-confirmations') || '1',
  });
}

function commandLine(prefix: string, args: Record<string, string>): string {
  return [
    prefix,
    ...Object.entries(args).map(([name, value]) => `--${name} ${value}`),
  ].join(' ');
}

function argOrPlaceholder(args: CliArgs, name: string): string {
  const value = args[name];
  return value === undefined || value === true || value === '' ? `<${name}>` : value;
}

function sigbashSignedNextCommands({
  txHex,
  signedPsbtBase64,
}: {
  txHex: string | null;
  signedPsbtBase64: string | null;
}): string[] {
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

function watchOnlyManifest(state: VaultState) {
  return {
    network: NETWORK,
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

function compareVaultUtxo({
  actual,
  expected,
}: {
  actual: RpcTxOut | null;
  expected: { round: string; address: string; valueSats: number; scriptPubKeyHex: string };
}) {
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

function btcToSats(valueBtc: number | string | null | undefined): number {
  return Math.round(Number(valueBtc) * 100_000_000);
}

function checkEnvPresent(name: string): CliCheck {
  return {
    name: `${name} is set`,
    ok: Boolean(process.env[name]),
  };
}

function checkEnvEquals(name: string, expected: string): CliCheck {
  return {
    name: `${name}=${expected}`,
    ok: process.env[name] === expected,
    actual: process.env[name] || null,
  };
}

function psbtInspectionToPolicyTx({
  state,
  inspection,
}: {
  state: VaultState;
  inspection: PsbtInspection;
}): PolicyTx {
  // Only a policy-spend leaf may supply the REQKEY-checked leaf key,
  // regardless of tapLeafScript ordering. An identification leaf (or any
  // unknown script) contributes nothing, so a PSBT carrying only the
  // identification leaf can never satisfy a policy's REQKEY clause.
  let sigbashLeafKey: string | undefined;
  for (const item of inspection.inputs[0]?.tapLeafScript ?? []) {
    const leaf = findLeafByScriptHex(state, item.scriptHex);
    if (leaf?.type === 'solo-withdrawal') {
      sigbashLeafKey = leaf.sigbashXonlyPubkey;
      break;
    }
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

function vaultFromPsbtInspection(state: VaultState, inspection: PsbtInspection): VaultRound | null {
  const scriptPubKeyHex = inspection.inputs[0]?.witnessUtxo?.scriptPubKeyHex;
  if (!scriptPubKeyHex) return null;
  return (
    [...state.vaults.values()].find((vault) => vault.outputScriptHex === scriptPubKeyHex) || null
  );
}

function sigbashKeyIdEnvName(participantId: string, round: string): string {
  return `SIGBASH_KEY_ID_${participantId.toUpperCase()}_${round.toUpperCase()}`;
}

function findLeafByScriptHex(state: VaultState, scriptHex: string) {
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
      error: errorMessage(error),
    };
  }
}

async function checkBitcoinRpc() {
  try {
    const info = await getBlockchainInfo();
    return {
      name: 'Bitcoin Core RPC is reachable on mainnet',
      ok: info.chain === BITCOIN_CORE_CHAIN,
      chain: info.chain,
      blocks: info.blocks,
      headers: info.headers,
    };
  } catch (error) {
    return {
      name: 'Bitcoin Core RPC is reachable on mainnet',
      ok: false,
      error: errorMessage(error),
    };
  }
}
