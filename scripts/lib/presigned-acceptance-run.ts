/** A fixed executable plan, not an API for checking operator-supplied hashes. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { commitmentDigest, presignedDomain, presignedVersion, validatePresignedProtocol } from '../../src/presigned/validation.js';
import { PRESIGNED_PROTOCOL, PRESIGNED_PROTOCOL_V3, type PresignedProtocol, type PresignedVersion } from '../../src/presigned/types.js';
import { presignedSourceDigest } from '../presigned-build-identity.mjs';
import { LIVE_REGTEST_CAPITAL_SATS, RECYCLING_FEE_CAP } from './presigned-live-capital.js';

export type AcceptanceMode = 'pure' | 'local';
export interface AcceptanceCommand {
  id: string;
  executable: 'node' | 'bash' | 'npm';
  args: string[];
  network: 'signet' | 'mainnet';
  category: 'typecheck' | 'cryptographic' | 'core' | 'database' | 'offline-browser' | 'browser' | 'legacy';
  /** Explicit target inside a mixed-protocol regression matrix. */
  protocol?: PresignedProtocol;
}
const pureFiles = [
  'src/presigned/acceptance.ts', 'src/presigned/spends-acceptance.ts', 'src/presigned/fees-acceptance.ts',
  'src/presigned/funding-fees-acceptance.ts', 'src/presigned/spend-fees-acceptance.ts',
  'src/presigned/chain-acceptance.ts', 'src/presigned/core-acceptance.ts', 'src/presigned/runtime-acceptance.ts',
  'src/presigned/coin-observations-acceptance.ts', 'src/presigned/release-acceptance.ts',
  'web/tests/presigned-custody-acceptance.ts', 'web/tests/presigned-local-lock-acceptance.ts',
  'web/tests/presigned-browser-review-probe.ts', 'web/tests/presigned-chain-review-acceptance.ts',
  'scripts/presigned-live-recycling-verification.mts',
  'scripts/presigned-durable-journal-verification.mts',
  'src/presigned/economics-acceptance.ts',
];
const v3PureFiles = ['src/presigned/fixed-recovery-acceptance.ts', 'src/presigned/v3-runtime-acceptance.ts',
  'src/presigned/v3-offline-acceptance.ts', 'web/tests/presigned-v3-release-acceptance.ts', 'src/presigned/cashout-acceptance.ts',
  'src/presigned/v3-offline-merge-acceptance.ts','src/presigned/restoration-batch-acceptance.ts'];
export function acceptancePlan(mode: AcceptanceMode, protocol: PresignedProtocol = PRESIGNED_PROTOCOL_V3): AcceptanceCommand[] {
  assert(mode === 'pure' || mode === 'local');
  presignedVersion(protocol);
  const plan: AcceptanceCommand[] = ['tsconfig.json', 'tsconfig.web.json', 'tsconfig.offline.json', 'tsconfig.scripts.json']
    .map((file, index) => ({ id: `types-${index}`, executable: 'node',
      args: ['node_modules/typescript/bin/tsc', '--noEmit', '-p', file], network: 'signet', category: 'typecheck' }));
  for (const network of ['signet', 'mainnet'] as const) for (const [index, file] of pureFiles.entries()) plan.push({
    id: `crypto-${network}-${String(index).padStart(2, '0')}`, executable: 'node',
    args: ['--conditions=react-server', '--import', 'tsx', file], network, category: 'cryptographic',
  });
  plan.push({ id: 'evidence-boundaries', executable: 'node', args: ['--import', 'tsx', 'scripts/presigned-evidence-acceptance.mts'],
    network: 'signet', category: 'cryptographic' });
  plan.push({ id: 'oci-boundaries', executable: 'node', args: ['--import', 'tsx', 'scripts/presigned-oci-acceptance.mts'],
    network: 'signet', category: 'cryptographic' });
  for (const network of ['signet', 'mainnet'] as const) plan.push({ id: `legacy-unit-${network}`, executable: 'npm',
    args: ['run', 'web:test'], network, category: 'legacy' });
  if (protocol === PRESIGNED_PROTOCOL_V3) {
    for (const network of ['signet', 'mainnet'] as const) for (const [index, file] of v3PureFiles.entries()) plan.push({
      id: `v3-crypto-${network}-${String(index).padStart(2, '0')}`, executable: 'node',
      args: ['--conditions=react-server', '--import', 'tsx', file], network, category: 'cryptographic', protocol });
    plan.push({ id: 'v3-mainnet-authorization-boundary', executable: 'node', network: 'mainnet', category: 'cryptographic', protocol,
      args: ['--conditions=react-server', '--import', 'tsx', 'web/tests/presigned-mainnet-protocol-authorization-acceptance.ts'] });
    plan.push({ id:'deployment-policy-boundaries',executable:'node',network:'signet',category:'cryptographic',protocol,
      args:['--conditions=react-server','--import','tsx','scripts/presigned-deployment-acceptance.mts'] });
  }
  if (mode === 'local') {
    for (const file of ['presigned-core-acceptance', 'presigned-core-spends', 'presigned-core-fees',
      'presigned-core-funding-fees', 'presigned-core-spend-fees', 'presigned-core-observed-witnesses',
      'presigned-wallet-restore-verification', 'presigned-live-lifecycle-regtest', 'presigned-core-economics']) plan.push({ id: file, executable: 'node',
      args: ['--import', 'tsx', `scripts/${file}.mts`], network: 'signet', category: 'core' });
    plan.push({ id: 'database-v2-all', executable: 'bash', args: ['scripts/run-presigned-db-acceptance.sh', 'all'],
      network: 'signet', category: 'database' });
    plan.push({ id: 'offline-build', executable: 'node', args: ['scripts/build-presigned-offline.mjs'], network: 'signet', category: 'offline-browser' });
    plan.push({ id: 'offline-full', executable: 'node', args: ['--import', 'tsx', 'scripts/presigned-offline-acceptance.mts'],
      network: 'signet', category: 'offline-browser' });
    plan.push({ id: 'optimized-browser', executable: 'bash', args: ['scripts/run-presigned-browser-acceptance.sh'],
      network: 'signet', category: 'browser' });
    if (protocol === PRESIGNED_PROTOCOL_V3) {
      for (const id of ['presigned-live-lifecycle-regtest', 'database-v2-all']) plan.find(item => item.id === id)!.protocol = PRESIGNED_PROTOCOL;
      plan.push({ id: 'presigned-core-v3-recovery', executable: 'node', args: ['--import', 'tsx', 'scripts/presigned-core-v3-recovery.mts'],
        network: 'signet', category: 'core', protocol });
      plan.push({ id: 'presigned-core-cashout', executable: 'node', args: ['--import', 'tsx', 'scripts/presigned-core-cashout.mts'],
        network: 'signet', category: 'core', protocol });
      plan.push({ id: 'presigned-live-lifecycle-v3-regtest', executable: 'node', args: ['--import', 'tsx', 'scripts/presigned-live-lifecycle-regtest.mts'],
        network: 'signet', category: 'core', protocol });
      plan.push({ id: 'database-v3-all', executable: 'bash', args: ['scripts/run-presigned-db-acceptance.sh', 'all'],
        network: 'signet', category: 'database', protocol });
    }
  }
  return plan;
}

/** No operational dotenv loaders, credentials, signing opt-ins, NODE_OPTIONS,
 * proxies or caller-selected test filters survive into an acceptance command. */
export function acceptanceEnvironment(network: 'signet' | 'mainnet', protocol: PresignedProtocol = PRESIGNED_PROTOCOL_V3): NodeJS.ProcessEnv {
  presignedVersion(protocol);
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'LD_LIBRARY_PATH', 'POSTGRES_BIN', 'POSTGRES_LIB',
    'BITCOIN_CORE_BIN', 'PLAYWRIGHT_BROWSERS_PATH', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR', 'TERM']) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return { ...environment, NODE_EXECUTABLE: process.execPath, VAULT_NETWORK: network, NEXT_PUBLIC_VAULT_NETWORK: network,
    NEXT_TELEMETRY_DISABLED: '1', NODE_ENV: 'test', PRESIGNED_BROWSER_BUILD_APPROVED: 'true',
    PRESIGNED_ACCEPTANCE_PROTOCOL: protocol, PRESIGNED_BUILD_PROTOCOL: protocol, PRESIGNED_BROWSER_PROTOCOL: protocol,
    PRESIGNED_OFFLINE_TEST_PROTOCOL: protocol, PRESIGNED_DB_PROTOCOL: protocol, PRESIGNED_LIVE_TEST_PROTOCOL: protocol };
}

export interface ExecutedCommand {
  command: AcceptanceCommand;
  startedAt: string;
  completedAt: string;
  sourceDigest: string;
  exitCode: 0;
  stdoutSha256: string;
  stderrSha256: string;
  artifactDigests: Array<{ relativePath: string; sha256: string }>;
  executionDigest: string;
}
export interface LocalAcceptanceRun {
  version: PresignedVersion;
  protocol: PresignedProtocol;
  kind: 'presigned-v2-local-executable-run' | 'presigned-v3-local-executable-run';
  mode: AcceptanceMode;
  sourceDigest: string;
  createdAt: string;
  completedAt: string;
  reviewedNodeVersion: string;
  commands: ExecutedCommand[];
  offlineUtilityDigest: string | null;
  physicalPasskeysVerified: false;
  realSignetVerified: false;
  exactImageVerified: false;
  fundingAuthorized: false;
  runDigest: string;
}
const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
export function readPrivateAcceptanceFile(filename: string, maximumBytes = 16 * 1024 * 1024): Buffer {
  const parent = lstatSync(dirname(filename));
  assert(parent.isDirectory() && !parent.isSymbolicLink() && parent.uid === process.getuid?.() &&
    (parent.mode & 0o077) === 0, 'acceptance evidence directory must be owner-only');
  const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    assert(stat.isFile() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0 &&
      stat.size <= maximumBytes, 'acceptance evidence must be a bounded owner-only regular file');
    return readFileSync(fd);
  } finally { closeSync(fd); }
}
export function parseAcceptanceJson(data: Buffer | string): unknown {
  try { return JSON.parse(data.toString()); }
  catch { throw new Error('acceptance evidence contains invalid JSON; contents deliberately omitted'); }
}
export function writeAcceptanceJson(filename: string, body: unknown) {
  writeFileSync(filename, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
}

/** Collect whole JSON objects from mixed command progress output. Strings and
 * braces inside strings are handled by JSON.parse, never by eval or a shell. */
export function acceptanceJsonRecords(data: string): Array<Record<string, any>> {
  const records: Array<Record<string, any>> = [];
  let buffer = '';
  for (const line of data.split('\n')) {
    if (!buffer && !line.startsWith('{')) continue;
    buffer += `${line}\n`;
    if (buffer.length > 2 * 1024 * 1024) throw new Error('acceptance JSON record exceeds its bound');
    try {
      const value = JSON.parse(buffer);
      if (value && typeof value === 'object' && !Array.isArray(value)) records.push(value);
      buffer = '';
    } catch { /* Wait for a complete pretty-printed JSON object. */ }
  }
  assert(!buffer.trim(), 'acceptance output ended inside an incomplete JSON object');
  return records;
}
function resultPassed(record: Record<string, any>) {
  return record.passed === true || (Number.isSafeInteger(record.passed) && record.passed > 0) || record.status === 'passed';
}
export function validateCommandResults(command: AcceptanceCommand, stdout: string, protocol: PresignedProtocol = PRESIGNED_PROTOCOL_V3) {
  if (command.category === 'typecheck' || command.id === 'offline-build') return;
  const records = acceptanceJsonRecords(stdout);
  if (command.category === 'cryptographic') {
    assert(records.some(resultPassed), `${command.id} did not emit an actual successful suite result`);
    assert(!records.some(item => item.passed === false || item.status === 'failed'), `${command.id} reported a failed result`);
    if (command.args.at(-1) === 'src/presigned/acceptance.ts') {
      const result = records.findLast(resultPassed);
      assert(result?.network === command.network && result.nativeWalletCombinations === 8 && result.exitsPerCombination === 9,
        'graph acceptance did not cover the actual requested network and wallet matrix');
    }
    const result = records.findLast(resultPassed);
    if (command.id === 'deployment-policy-boundaries') assert(result?.suite === 'private-deployment-policy' &&
      result.protocol === PRESIGNED_PROTOCOL_V3 && result.negativeControls >= 112 && result.hardenedCommandRoles === 3 &&
      result.realPrivateJournalChecks === true && result.exactImageEvidenceRefusals >= 40 && result.runtimeHardeningRefusals >= 40 &&
      result.operationalDatabaseAccess === false && result.containerExecution === false &&
      result.actualDeploymentRollbackVerified === false && result.publicNetworkBroadcasts === 0 && result.publicListener === false && result.fundingAuthorized === false,
    'private deployment policy tests must cover hostile inputs and private journals without impersonating actual deployment evidence');
    if(command.args.at(-1)==='src/presigned/restoration-batch-acceptance.ts') assert(result?.suite==='restoration-batch-boundaries' &&
      result.protocols===2 && result.networkFormats===2 && result.verifiedReceipts===36 && result.independentSingleChecks===12 && result.refusals>=84 &&
      result.globalCache===false && result.networkOrDatabaseContacted===false,'batched restoration proof dropped independent kit, owner, proof, alias or protocol validation');
    if (command.args.at(-1) === 'src/presigned/fixed-recovery-acceptance.ts') assert(result?.protocol === PRESIGNED_PROTOCOL_V3 &&
      result.exactRefunds === 4 && result.setupAuthorizations === 21 && result.refusalChecks >= 42 && result.signedExits === 144 &&
      result.networkFormats === 2 && result.walletCombinations === 8 && result.actualPublicNetworkBroadcasts === 0,
    'V3 graph proof omits exact refunds, complete setup, wallet coverage or hostile controls');
    if (command.args.at(-1) === 'src/presigned/v3-runtime-acceptance.ts') assert(result?.protocol === PRESIGNED_PROTOCOL_V3 &&
      result.recoveryQuorums === 9 && result.sponsoredRefundPositions === 9 && result.replacements === 9 && result.runtimeReanchors === 4 &&
      result.cooperativeMuSig2 === true && result.sponsoredParentFamilies === 5 && result.publicNetworkBroadcasts === 0,
    'V3 runtime proof lacks all quorum, sponsor, cooperative or source-reanchor cases');
    if (command.args.at(-1) === 'src/presigned/v3-offline-acceptance.ts') assert(result?.protocol === PRESIGNED_PROTOCOL_V3 &&
      result.encryptedPortableRestores >= 3 && result.missingParticipantRecoveries === 9 && result.soloExports === 9 && result.finalSweeps === 6 &&
      result.websiteContact === false && result.actualBrowserExecuted === false && result.actualBlockchainContact === false && result.publicNetworkBroadcasts === 0,
    'V3 portable proof lacks missing-participant recovery or misstates its offline-only scope');
    if (command.args.at(-1) === 'src/presigned/cashout-acceptance.ts') {
      assert(result?.suite === 'owned-payout-cashout' && result.signedCashouts === 48 && result.negativeControls >= 224 &&
        result.destinationTypes === 5 && result.callerPayoutKeyZeroized === true && result.actualChainVerified === false &&
        result.publicNetworkBroadcasts === 0 && result.mainnetAuthorized === false, 'cash-out pure proof lacks exact owner/address/fee and mutation coverage');
      assert.deepEqual(result.protocols, [PRESIGNED_PROTOCOL, PRESIGNED_PROTOCOL_V3]);
      assert.deepEqual(result.networkFormats, ['signet', 'mainnet']);
      assert.deepEqual(result.payoutFamilies, ['solo-first','solo-second','final-owned','cooperative','recovery','final-sweep','same-key-external-or-fee-child']);
    }
    if (command.args.at(-1) === 'src/presigned/v3-offline-merge-acceptance.ts') {
      assert(result && result.hostilePeerOrKitRefusals >= 26 && result.completeCooperativeMerges === 2 &&
        result.browserExecution === false && result.publicNetworkBroadcasts === 0,
      'offline merge proof lacks complete-kit and peer/nonce/context validation');
      assert.deepEqual(result.protocols, [PRESIGNED_PROTOCOL, PRESIGNED_PROTOCOL_V3]);
    }
    if (command.args.at(-1) === 'scripts/presigned-live-recycling-verification.mts') {
      const result = records.findLast(resultPassed);
      assert(result?.configuredNetwork === command.network && result.scope === 'pure-offline-capital-recycling' &&
        result.signedTransactions === 10 && result.normalizedWalletPsbts === 8 && result.rejectedMutations >= 96 && result.completedChecks >= 13 &&
        result.networkCalls === 0 && result.walletCalls === 0 && result.consensusOrLiveSignetVerified === false,
      'capital signing proof lacks the actual mixed-native and hostile-journal regressions');
    }
    if (command.args.at(-1) === 'scripts/presigned-durable-journal-verification.mts') {
      const result = records.findLast(resultPassed);
      assert(result?.configuredNetwork === command.network && result.scope === 'private-journal-filesystem-fixtures' &&
        result.completeCheckpoints >= 19 && result.actualCompleteRestorations >= 14 && result.rejectedBoundaries >= 42 &&
        result.kernelLockChecks === 4 && result.actualPrimaryCutovers === 2 &&
        result.metadataLossRestorations === 3 && result.interruptedCheckpointRepairs === 3 && result.atomicCutoverPreflightChecks === 1 &&
        result.independentRollbackAnchorRequired === true && result.networkCalls === 0 && result.walletCalls === 0 &&
        result.publicBroadcasts === 0 && result.realParticipantCustodyVerified === false && result.realSignetVerified === false,
      'private checkpoint proof lacks complete restores, independent rollback refusal or safe filesystem boundaries');
    }
  } else if (command.category === 'core') {
    assert(!records.some(item => item.passed === false || item.status === 'failed'), `${command.id} reported a failed result`);
    const record = records.findLast(resultPassed);
    assert(record, `${command.id} did not emit a successful Core summary`);
    assert(record.publicNetworkBroadcasts === 0, 'local Core proof cannot include a public-network broadcast');
    assert(record.coreVersion === 310100, 'unreviewed Core evidence');
    if (command.id === 'presigned-core-fees') assert(record.actualRollingFloorFromEviction === true &&
      record.adequatePackageAndReplacementConfirmed === true && record.fundingAndGraphUnchanged === true);
    if (command.id === 'presigned-core-funding-fees') assert(record.dynamicMempoolFloorRaisedByRealEviction === true &&
      record.adequatelySponsoredFundingAndReplacementConfirmed === true && record.exactGraphAndNineExitTxidsUnchanged === true);
    if (command.id === 'presigned-wallet-restore-verification') assert(record.scope === 'actual-isolated-native-wallet-restoration' &&
      record.actualRestoredNativeSignatures === 83 && record.rejectedBindings >= 15 && record.sourceWalletCalls === 1 &&
      record.coreDataDirectoryLockChecks === 4 &&
      record.sourceBalancesUnchanged === true && record.originalBackupUnchanged === true && record.networkingDisabled === true &&
      record.participantKeysImported === false && record.realDefaultSignetVerified === false &&
      record.signatureContextBindingVerified === true && record.cleanRestoreShutdownVerified === true,
      'native wallet proof lacks actual separately restored signatures for every reserved target');
    if (command.id === 'presigned-core-v3-recovery') assert(record.protocol === PRESIGNED_PROTOCOL_V3 && record.actualBitcoinChain === 'isolated-regtest' &&
      record.confirmedRecoveryQuorums === 9 && record.confirmedNormalOrderings === 6 && record.freshCollusionRefusals >= 108 &&
      record.witnessRefusals >= 66 && record.annexConsensusRefusals === 9 && record.exactBoundaryChecks === 9 && record.reorgBoundaryChecks === 9 &&
      record.recoveryVsizeByMemberCount?.['2'] === 240 && record.recoveryVsizeByMemberCount?.['3'] === 332 && record.mainnetFundingAuthorized === false,
    'V3 Core proof lacks complete fixed-recovery consensus, collusion, witness and reorg coverage');
    if (command.id === 'presigned-core-cashout') {
      assert(record.suite === 'owned-payout-cashout-core' && record.actualChain === 'isolated-regtest' &&
        record.confirmedCashouts === 24 && record.confirmedParents === 18 && record.rejectedMutations >= 192 &&
        record.destinationTypes === 5 && record.actualCoinAnchorsVerified === true && record.liveSignetVerified === false &&
        record.mainnetAuthorized === false, 'cash-out Core proof lacks actual owned payouts, chain anchors or hostile mutations');
      assert.deepEqual(record.protocols, [PRESIGNED_PROTOCOL, PRESIGNED_PROTOCOL_V3]);
      assert.deepEqual(record.payoutFamilies, ['solo-first','solo-second','final-sweep','final-owned','cooperative','recovery','cpfp-preserved-payout','independently-owned-same-key']);
    }
    if (command.id === 'presigned-live-lifecycle-regtest' || command.id === 'presigned-live-lifecycle-v3-regtest') {
      const fixedCashout = command.id === 'presigned-live-lifecycle-v3-regtest';
      if (command.id === 'presigned-live-lifecycle-v3-regtest') assert(record.protocol === PRESIGNED_PROTOCOL_V3 &&
        record.setupSignaturesPerCase === 21 && record.fixedRecoveryTemplatesPerCase === 4,
        'V3 lifecycle must execute actual V3 graphs, never relabel the legacy run');
      const capital = record.capitalAudit;
      const csv = record.csvBoundaryAudit;
      const custody = record.durableCustodyAudit;
      assert(record.cases === 19 && record.feeFamilies === 5 && record.lostRepliesWithoutResending === (fixedCashout ? 7 : 6) &&
        capital?.initialCapitalSats === LIVE_REGTEST_CAPITAL_SATS && capital.fixedConfirmedFeesSats === (fixedCashout ? 47_300 : 47_000) &&
        Number.isSafeInteger(capital.allocationFeesSats) && capital.allocationFeesSats > 0 && capital.allocationFeesSats <= 20 * RECYCLING_FEE_CAP &&
        capital.returnedSats + capital.fixedConfirmedFeesSats + capital.allocationFeesSats === capital.initialCapitalSats &&
        capital.confirmedAllocations === 20 && capital.recycledParticipantPayouts === (fixedCashout ? 56 : 57) && capital.unrelatedWalletInputsUsed === 0 &&
        capital.allTerminalOutputsAndReservesConsumedExactlyOnce === true &&
        csv?.cases === 9 && csv.delayBlocks === 12 && csv.justBeforeMaturityRejected === 9 &&
        csv.matureTransactionsAllowed === 9 && csv.sameStoredTransactionBytes === true &&
        custody?.primaryLossRestorations === 2 && custody.initializationInterruptions === 2 && custody.durableSendChecks === (fixedCashout ? 85 : 84) && custody.uniqueSubmittedTransactions === (fixedCashout ? 90 : 89) &&
        custody.actualNativeWalletRestoredSignatures === 83 && custody.independentlyRestoredCasesBeforeFunding === 19 && custody.nativeTargetsRegenerated === 0,
      'resumable Core proof omits the complete confined low-capital money trail, exact CSV boundaries or restart faults');
      if (fixedCashout) {
        const cashout = record.ownedCashoutAudit;
        assert(record.ownedCashoutProfile === 'missing-carol-refund-to-native-wallet-v1' && record.ownedPayoutCashoutsConfirmed === 1 &&
          cashout?.confirmed === 1 && cashout.feeSats === 300 && cashout.omittedParticipant === 'carol' &&
          cashout.destinationAlreadyBackedUp === true && cashout.ownerOnlySignatureVerified === true &&
          cashout.lostReplyReconciledWithoutResend === true && cashout.cashoutReorganizationRejected === true &&
          cashout.refundAncestorReorganizationRejected === true, 'V3 lifecycle lacks the omitted-owner restored refund cash-out and reorg boundaries');
        const cache=record.publicCompletedCaseCacheAudit;
        assert(cache?.fileMutationsRejected>=25 && cache.missingFileRejected===true && cache.permissionsRejected===true &&
          cache.returnedAliasMutationIsolated===true && cache.sourceAndProtocolChangesRejected===true &&
          Number.isFinite(cache.coldMilliseconds) && cache.coldMilliseconds>=0 && Number.isFinite(cache.warmMilliseconds) && cache.warmMilliseconds>=0,
        'V3 lifecycle public-case cache lacks current-byte, permission, source/protocol and alias invalidation proof');
      }
    }
  } else if (command.id === 'offline-full') {
    assert(!records.some(item => item.passed === false || item.status === 'failed'), 'offline proof reported a failed result');
    const record = records.findLast(resultPassed);
    assert(record?.completeLifecycleEvidence === true && record.completeFeeEvidence === true &&
      record.fullSoloOrderings === 6 && record.cooperativeRounds === 4 && record.recoverySignerSubsets === 9 &&
      record.actualBrowserSignedTransactionsConfirmedByCore === 31 && record.feeRescueWalletAndParentCases === 10 &&
      record.replacementFeeChildrenConfirmedByCore === 10 && record.networkRequests === 0 && record.persistentSecretStorage === false,
    'offline proof is partial or lacks actual Core lifecycle/fee confirmations');
    assert(record.utilitySha256 === sha256(readFileSync('public/offline/presigned-recovery.html')), 'offline proof is for a different artifact');
    assert(record.protocol === (command.protocol ?? protocol), 'offline evidence belongs to another vault protocol');
    if ((command.protocol ?? protocol) === PRESIGNED_PROTOCOL_V3) {
      assert(record.exactArtifactInputsVerified === true &&
        Array.isArray(record.mainnetBoundaryProtocols) && record.mainnetBoundaryProtocols.includes(PRESIGNED_PROTOCOL_V3) &&
        record.mainnetBoundaryProtocols.includes(PRESIGNED_PROTOCOL), 'V3 offline proof omits exact artifact or cross-protocol funding boundaries');
      assert(record.ownedPayoutCashoutsConfirmed === 12 && record.cashoutOwnerAndReviewMutationRefusals >= 37,
        'V3 offline proof omits actual owner-reviewed cash-outs or wrong-owner/review-mutation refusals');
      assert.deepEqual(record.cashoutPayoutFamilies, ['cooperative','cpfp-preserved-payout','final-sweep','recovery','solo']);
    }
  }
}

export function validateBrowserAcceptance(json: any, sourceDigest: string, network: 'signet' | 'mainnet', protocol: PresignedProtocol = PRESIGNED_PROTOCOL_V3) {
  presignedVersion(protocol);
  assert(json?.passed === true && json.protocol === protocol && json.bundle === 'optimized-webpack-standalone' &&
    json.sourceDigest === sourceDigest && json.appNetwork === network && json.actualBitcoinChain === 'isolated-regtest' &&
    json.networkIdentityBridge === true && json.virtualPrfPasskeys === 6 && json.coreVersion === 310100 &&
    json.realSignetAcceptance === false && json.physicalPasskeyEvidence === false && json.publicNetworkBroadcasts === 0 &&
    json.mainnetFundingAuthorized === false && json.audit?.sensitiveRequestDetected === false,
  'browser evidence does not prove the required source, network and custody execution');
  assert.deepEqual(json.audit.forbidden, []); assert.deepEqual(json.audit.unexpected, []);
  if (protocol === PRESIGNED_PROTOCOL_V3) {
    assert(json.setupSignatures === 21 && json.fixedRecoveryTemplates === 4 &&
      (network !== 'signet' || json.fixedMissingParticipantRefundVerified === true), 'V3 browser proof omits fixed-refund setup or missing-participant recovery');
    assert(json.cashoutDestinationAndFeeReviewed === true && json.cashoutUnsignedPreviewVerified === true,
      'V3 browser proof omits actual owner-reviewed cash-out destination, fee or unsigned preview');
    if (network === 'signet') assert(Number.isSafeInteger(json.ownedPayoutCashoutsConfirmed) && json.ownedPayoutCashoutsConfirmed >= 1 &&
      Number.isSafeInteger(json.cashoutOwnerAndReviewMutationRefusals) && json.cashoutOwnerAndReviewMutationRefusals >= 2,
      'V3 browser proof omits actual cash-out confirmation or owner/review mutation refusals');
  }
  if (network === 'signet') assert(json.completeGameExecution === true && Number.isSafeInteger(json.reauthentications) && json.reauthentications > 0,
    'Signet-format browser evidence must include full game execution and session reauthentication');
  else assert(json.mainnetFundingGateVerified === true && json.completeGameExecution === false,
    'mainnet-format browser evidence must prove the actual unauthorized funding refusal');
}

export function validateAcceptanceArtifacts(command: AcceptanceCommand, artifacts: ExecutedCommand['artifactDigests'],
  directory: string, sourceDigest: string, protocol: PresignedProtocol = PRESIGNED_PROTOCOL_V3) {
  const expected = command.category === 'database'
    ? databaseArtifactNames(command, protocol).map(name => `${command.id}-${name}.log`)
    : command.category === 'browser' ? [`${command.id}-browser.json`] : [];
  assert.deepEqual(artifacts.map(item => item.relativePath), expected, 'required acceptance artifacts are missing, duplicated or substituted');
  for (const artifact of artifacts) {
    const bytes = readPrivateAcceptanceFile(`${directory}/${artifact.relativePath}`);
    assert.equal(sha256(bytes), artifact.sha256, 'acceptance artifact changed');
    if (command.category === 'browser') validateBrowserAcceptance(parseAcceptanceJson(bytes), sourceDigest, command.network, command.protocol ?? protocol);
    else {
      const results = acceptanceJsonRecords(bytes.toString());
      assert(results.some(resultPassed) && !results.some(item => item.passed === false || item.status === 'failed'),
        'retained database suite did not pass');
      if ((command.protocol ?? protocol) === PRESIGNED_PROTOCOL_V3) assert(results.findLast(resultPassed)?.protocol === PRESIGNED_PROTOCOL_V3,
        'V3 database artifact must come from an actual V3 suite');
      if (artifact.relativePath.endsWith('-restore.log')) {
        const restored = results.findLast(resultPassed);
        assert(restored?.restoredEncryptedKeys === 6 && restored.negativeBoundaries >= 22,
          'database evidence lacks the actual full restore and custody boundary drill');
      }
      if (artifact.relativePath.endsWith('-cashout.log')) {
        const cashout = results.findLast(resultPassed);
        assert(cashout?.actualDatabase === 'isolated-PostgreSQL' && cashout.actualChain === 'isolated-regtest' &&
          cashout.networkIdentityBridge === true && cashout.realDefaultSignetEvidence === false && cashout.realWebAuthnTransport === false &&
          cashout.publicNetworkBroadcasts === 0 && cashout.missingParticipantRefundCashedOut === true &&
          cashout.serverIndependentKeyRestoration === true && cashout.ownerCashoutSends === 1 &&
          Array.isArray(cashout.checks) && cashout.checks.length >= 4,
        'database cash-out proof lacks actual missing-participant restoration, durable exact send or reorg coverage');
      }
      if (artifact.relativePath.endsWith('-protocol-queue.log')) {
        const queue = results.findLast(resultPassed);
        assert(queue?.actualDatabase === 'disposable-loopback-PostgreSQL' && queue.disabledV2RowsPerQueue === 100 &&
          queue.enabledV3RowsRetriedPerQueue === 1 && queue.rpcCalls === 0 && queue.publicNetworkBroadcasts === 0 &&
          queue.realMainnetAuthorizationGranted === false,
        'database queue proof lacks actual pre-limit protocol isolation and no-network boundaries');
      }
    }
  }
}
function databaseArtifactNames(command: AcceptanceCommand, protocol: PresignedProtocol): string[] {
  return ['ceremony','runtime','chain-broadcast','fee','restore',
    ...((command.protocol ?? protocol) === PRESIGNED_PROTOCOL_V3 ? ['cashout','protocol-queue'] : [])];
}

export async function executeAcceptanceCommand(command: AcceptanceCommand, directory: string, sourceDigest: string,
  protocol: PresignedProtocol = PRESIGNED_PROTOCOL_V3): Promise<ExecutedCommand> {
  assert.equal(presignedSourceDigest(), sourceDigest, 'source changed during acceptance; start a reviewed run of the new source');
  const startedAt = new Date().toISOString();
  const stdoutPath = `${directory}/${command.id}.stdout.log`; const stderrPath = `${directory}/${command.id}.stderr.log`;
  const stdout: Buffer[] = []; const stderr: Buffer[] = []; let totalBytes = 0;
  const child = spawn(command.executable === 'node' ? process.execPath : command.executable, command.args,
    { cwd: process.cwd(), env: acceptanceEnvironment(command.network, command.protocol ?? protocol), stdio: ['ignore', 'pipe', 'pipe'] });
  const capture = (target: Buffer[]) => (chunk: Buffer) => {
    totalBytes += chunk.length;
    if (totalBytes > 16 * 1024 * 1024) { child.kill('SIGTERM'); return; }
    target.push(Buffer.from(chunk));
  };
  child.stdout.on('data', capture(stdout)); child.stderr.on('data', capture(stderr));
  const exitCode = await new Promise<number | null>((resolveExit, reject) => {
    child.once('error', () => reject(new Error(`could not start fixed acceptance command ${command.id}`)));
    child.once('close', code => resolveExit(code));
  });
  const stdoutBytes = Buffer.concat(stdout); const stderrBytes = Buffer.concat(stderr);
  writeFileSync(stdoutPath, stdoutBytes, { mode: 0o600, flag: 'wx' });
  writeFileSync(stderrPath, stderrBytes, { mode: 0o600, flag: 'wx' });
  assert(totalBytes <= 16 * 1024 * 1024, 'acceptance command output exceeded its bound');
  assert.equal(exitCode, 0, `fixed acceptance command ${command.id} failed; inspect its owner-only log`);
  assert.equal(presignedSourceDigest(), sourceDigest, 'source changed during an executing suite; no valid receipt was produced');
  const output = stdoutBytes.toString(); validateCommandResults(command, output, protocol);
  const artifacts: Array<{ relativePath: string; sha256: string }> = [];
  const copyArtifact = (filename: string, label: string, validate?: (json: any) => void) => {
    const bytes = readPrivateAcceptanceFile(filename); const json = parseAcceptanceJson(bytes);
    validate?.(json);
    const relativePath = `${command.id}-${label}.json`;
    writeFileSync(`${directory}/${relativePath}`, bytes, { mode: 0o600, flag: 'wx' });
    artifacts.push({ relativePath, sha256: sha256(bytes) });
  };
  if (command.category === 'database') {
    const paths = [...output.matchAll(/Owner-only test evidence retained at (\/tmp\/btc-presigned-db\.[A-Za-z0-9]+)/gu)];
    assert.equal(paths.length, 1, 'database runner did not retain an exact disposable evidence directory');
    for (const name of databaseArtifactNames(command, protocol)) {
      const bytes = readPrivateAcceptanceFile(`${paths[0]![1]}/presigned-${name}-db-acceptance.log`);
      const results = acceptanceJsonRecords(bytes.toString());
      assert(results.some(resultPassed) && !results.some(item => item.passed === false), `database ${name} proof is missing or failed`);
      const relativePath = `${command.id}-${name}.log`;
      writeFileSync(`${directory}/${relativePath}`, bytes, { mode: 0o600, flag: 'wx' });
      artifacts.push({ relativePath, sha256: sha256(bytes) });
    }
  } else if (command.category === 'browser') {
    const paths = [...output.matchAll(/Owner-only browser acceptance evidence: (\/tmp\/btc-presigned-browser\.[A-Za-z0-9]+)/gu)];
    assert.equal(paths.length, 1, 'browser runner did not retain an exact disposable evidence directory');
    copyArtifact(`${paths[0]![1]}/presigned-browser-acceptance.json`, 'browser', json =>
      validateBrowserAcceptance(json, sourceDigest, command.network, command.protocol ?? protocol));
  }
  validateAcceptanceArtifacts(command, artifacts, directory, sourceDigest, protocol);
  const body = { command, startedAt, completedAt: new Date().toISOString(), sourceDigest, exitCode: 0 as const,
    stdoutSha256: sha256(stdoutBytes), stderrSha256: sha256(stderrBytes), artifactDigests: artifacts };
  const execution = { ...body, executionDigest: commitmentDigest(presignedDomain(protocol, 'executed-command'), body) };
  writeAcceptanceJson(`${directory}/${command.id}.json`, execution);
  return execution;
}

/** Re-read every transcript and auxiliary artifact; stale/tampered/incomplete
 * runs cannot be promoted merely because they contain a passed field. */
export function validateLocalAcceptanceRun(directory: string, expectedSource: string, requiredMode: AcceptanceMode,
  expectedProtocol: PresignedProtocol = PRESIGNED_PROTOCOL_V3): LocalAcceptanceRun {
  const run = parseAcceptanceJson(readPrivateAcceptanceFile(`${resolve(directory)}/run.json`)) as LocalAcceptanceRun;
  const { runDigest, ...body } = run;
  validatePresignedProtocol(run.version, run.protocol);
  assert(run.protocol === expectedProtocol && run.kind === `presigned-v${run.version}-local-executable-run` &&
    run.mode === requiredMode && run.sourceDigest === expectedSource && run.fundingAuthorized === false &&
    run.exactImageVerified === false && run.realSignetVerified === false && run.physicalPasskeysVerified === false);
  assert.equal(commitmentDigest(presignedDomain(run.protocol, 'local-executable-run'), body), runDigest);
  const plan = acceptancePlan(requiredMode, run.protocol);
  assert.deepEqual(run.commands.map(item => item.command), plan, 'missing or substituted fixed acceptance command');
  assert(run.reviewedNodeVersion === readFileSync('.node-version', 'utf8').trim());
  for (const execution of run.commands) {
    const { executionDigest, ...executionBody } = execution;
    assert.equal(commitmentDigest(presignedDomain(run.protocol, 'executed-command'), executionBody), executionDigest);
    assert(execution.sourceDigest === expectedSource && execution.exitCode === 0);
    assert(Date.parse(execution.startedAt) >= Date.parse(run.createdAt) && Date.parse(execution.completedAt) <= Date.parse(run.completedAt) &&
      Date.parse(execution.completedAt) >= Date.parse(execution.startedAt));
    for (const [kind, digest] of [['stdout', execution.stdoutSha256], ['stderr', execution.stderrSha256]] as const) {
      const bytes = readPrivateAcceptanceFile(`${directory}/${execution.command.id}.${kind}.log`);
      assert.equal(sha256(bytes), digest, 'executed command transcript changed');
      if (kind === 'stdout') validateCommandResults(execution.command, bytes.toString(), run.protocol);
    }
    validateAcceptanceArtifacts(execution.command, execution.artifactDigests, directory, expectedSource, run.protocol);
  }
  if (requiredMode === 'local') assert(run.offlineUtilityDigest === sha256(readFileSync('public/offline/presigned-recovery.html')));
  else assert.equal(run.offlineUtilityDigest, null);
  return run;
}
