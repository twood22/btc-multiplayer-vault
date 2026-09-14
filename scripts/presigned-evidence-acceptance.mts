/** Evidence-parser/runner regressions, deliberately not release evidence. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { acceptanceEnvironment, acceptanceJsonRecords, acceptancePlan, executeAcceptanceCommand,
  parseAcceptanceJson, readPrivateAcceptanceFile, validateAcceptanceArtifacts, validateBrowserAcceptance,
  validateCommandResults, validateLocalAcceptanceRun, writeAcceptanceJson } from './lib/presigned-acceptance-run.js';
import { IMAGE_EXECUTION_STAGES, imageExecutionCommand } from './lib/presigned-image-commands.js';
import { presignedSourceDigest } from './presigned-build-identity.mjs';
import { commitmentDigest } from '../src/presigned/validation.js';
import { PRESIGNED_RELEASE_CHECKS } from '../src/presigned/release.js';
import { PRESIGNED_PROTOCOL, PRESIGNED_PROTOCOL_V3 } from '../src/presigned/types.js';
import { runEvidenceArchiveBoundaryTests } from './presigned-archive-acceptance.mjs';

process.umask(0o077);
const checks: string[] = [];
let negatives = 0;
const denied = (action: () => unknown) => { assert.throws(action); negatives++; };
const plan = acceptancePlan('pure');
assert.equal(new Set(plan.map(item => item.id)).size, plan.length);
assert.deepEqual(plan.filter(item => item.args.at(-1) === 'src/presigned/acceptance.ts').map(item => item.network), ['signet', 'mainnet']);
assert(acceptancePlan('local').some(item => item.id === 'offline-full'));
assert(acceptancePlan('local').some(item => item.id === 'optimized-browser'));
for (const id of ['presigned-core-v3-recovery', 'presigned-core-cashout', 'presigned-live-lifecycle-v3-regtest', 'database-v3-all']) {
  assert(acceptancePlan('local').some(item => item.id === id));
  assert(!acceptancePlan('local', PRESIGNED_PROTOCOL).some(item => item.id === id));
}
denied(() => acceptancePlan('optional' as 'pure'));
checks.push('fixed unique mandatory plan and both explicit graph-format runs');
const deployment = plan.find(item => item.id === 'deployment-policy-boundaries')!;
assert(deployment && !acceptancePlan('pure',PRESIGNED_PROTOCOL).some(item=>item.id===deployment.id));
const deploymentPolicy = {passed:true,syntheticParserFixture:true,suite:'private-deployment-policy',protocol:PRESIGNED_PROTOCOL_V3,
  negativeControls:112,hardenedCommandRoles:3,realPrivateJournalChecks:true,exactImageEvidenceRefusals:40,runtimeHardeningRefusals:40,operationalDatabaseAccess:false,containerExecution:false,
  actualDeploymentRollbackVerified:false,publicNetworkBroadcasts:0,publicListener:false,fundingAuthorized:false};
validateCommandResults(deployment,JSON.stringify(deploymentPolicy));
for (const mutation of [{negativeControls:111},{hardenedCommandRoles:2},{realPrivateJournalChecks:false},{operationalDatabaseAccess:true},
  {containerExecution:true},{actualDeploymentRollbackVerified:true},{publicNetworkBroadcasts:1},{publicListener:true},{fundingAuthorized:true},{exactImageEvidenceRefusals:39},{runtimeHardeningRefusals:39}])
  denied(()=>validateCommandResults(deployment,JSON.stringify({...deploymentPolicy,...mutation})));
const restorationBatch=plan.find(item=>item.args.at(-1)==='src/presigned/restoration-batch-acceptance.ts')!;
const restorationBatchSummary={passed:true,syntheticParserFixture:true,suite:'restoration-batch-boundaries',protocols:2,networkFormats:2,
  verifiedReceipts:36,independentSingleChecks:12,refusals:84,globalCache:false,networkOrDatabaseContacted:false};
validateCommandResults(restorationBatch,JSON.stringify(restorationBatchSummary));
for(const mutation of [{protocols:1},{networkFormats:1},{verifiedReceipts:35},{independentSingleChecks:11},{refusals:83},{globalCache:true},{networkOrDatabaseContacted:true}])
  denied(()=>validateCommandResults(restorationBatch,JSON.stringify({...restorationBatchSummary,...mutation})));

const previous = process.env.BITCOIN_RPC_PASSWORD;
try {
  process.env.BITCOIN_RPC_PASSWORD = 'synthetic-runtime-boundary-marker';
  const environment = acceptanceEnvironment('mainnet');
  assert.equal(environment.BITCOIN_RPC_PASSWORD, undefined);
  assert.equal(environment.NODE_OPTIONS, undefined); assert.equal(environment.BTC_VAULT_ENV_FILE, undefined);
  assert.equal(environment.PRESIGNED_V2_MAINNET_AUTHORIZATION, undefined);
  assert.equal(environment.PRESIGNED_V3_MAINNET_AUTHORIZATION, undefined);
  assert.equal(environment.PRESIGNED_OFFLINE_FEES_ONLY, undefined);
  assert.equal(environment.VAULT_NETWORK, 'mainnet');
  assert.equal(environment.PRESIGNED_DB_PROTOCOL, PRESIGNED_PROTOCOL_V3);
  assert.equal(environment.PRESIGNED_OFFLINE_TEST_PROTOCOL, PRESIGNED_PROTOCOL_V3);
  assert.equal(acceptanceEnvironment('signet', PRESIGNED_PROTOCOL).PRESIGNED_BROWSER_PROTOCOL, PRESIGNED_PROTOCOL);
} finally { if (previous === undefined) delete process.env.BITCOIN_RPC_PASSWORD; else process.env.BITCOIN_RPC_PASSWORD = previous; }
checks.push('clean child environment omits operational credentials, authorization and test narrowing');
assert.deepEqual(acceptanceJsonRecords('progress\n{"stage":"start"}\n{\n "passed":true,\n "text":"} { \\\""\n}\nend\n'),
  [{ stage: 'start' }, { passed: true, text: '} { "' }]);
denied(() => acceptanceJsonRecords('{"unfinished":'));
denied(() => parseAcceptanceJson('{"private-synthetic-marker"'));
const graph = plan.find(item => item.args.at(-1) === 'src/presigned/acceptance.ts')!;
denied(() => validateCommandResults(graph, '{"passed":true,"network":"mainnet","nativeWalletCombinations":8,"exitsPerCombination":9}\n'));
denied(() => validateCommandResults(graph, '{"passed":true,"network":"signet","nativeWalletCombinations":7,"exitsPerCombination":9}\n'));
denied(() => validateCommandResults(graph, '{"passed":false}\n'));
denied(() => validateCommandResults(graph, 'no actual result\n'));
const offline = acceptancePlan('local').find(item => item.id === 'offline-full')!;
denied(() => validateCommandResults(offline, '{"passed":true,"completeFeeEvidence":true,"completeLifecycleEvidence":false}\n'));
const core = acceptancePlan('local').find(item => item.id === 'presigned-core-acceptance')!;
const coreSummary = JSON.stringify({ passed: true, publicNetworkBroadcasts: 0, coreVersion: 310100, syntheticParserFixture: true });
validateCommandResults(core, `${coreSummary}\n`);
for (const failed of [{ passed: false }, { status: 'failed' }]) {
  denied(() => validateCommandResults(core, `${JSON.stringify(failed)}\n${coreSummary}\n`));
  denied(() => validateCommandResults(core, `${coreSummary}\n${JSON.stringify(failed)}\n`));
}
checks.push('whole JSON parsing, explicit network coverage and rejection of partial/failed evidence');
const v3Core = acceptancePlan('local').find(item => item.id === 'presigned-core-v3-recovery')!;
const v3CoreSummary = { passed: true, syntheticParserFixture: true, protocol: PRESIGNED_PROTOCOL_V3,
  actualBitcoinChain: 'isolated-regtest', publicNetworkBroadcasts: 0, coreVersion: 310100,
  confirmedRecoveryQuorums: 9, confirmedNormalOrderings: 6, freshCollusionRefusals: 108, witnessRefusals: 66,
  annexConsensusRefusals: 9, exactBoundaryChecks: 9, reorgBoundaryChecks: 9,
  recoveryVsizeByMemberCount: { '2': 240, '3': 332 }, mainnetFundingAuthorized: false };
validateCommandResults(v3Core, JSON.stringify(v3CoreSummary));
for (const mutation of [{ protocol: PRESIGNED_PROTOCOL }, { confirmedRecoveryQuorums: 8 }, { confirmedNormalOrderings: 5 },
  { freshCollusionRefusals: 107 }, { witnessRefusals: 65 }, { annexConsensusRefusals: 8 }, { exactBoundaryChecks: 8 },
  { reorgBoundaryChecks: 8 }, { recoveryVsizeByMemberCount: { '2': 232, '3': 324 } }, { mainnetFundingAuthorized: true }])
  denied(() => validateCommandResults(v3Core, JSON.stringify({ ...v3CoreSummary, ...mutation })));
checks.push('V3 requires complete actual two-leaf quorum, fresh-colluder, witness, annex and reorg evidence; V2 or exploratory sizes cannot substitute');
const cashoutPure = plan.find(item => item.args.at(-1) === 'src/presigned/cashout-acceptance.ts')!;
assert.deepEqual(plan.filter(item => item.args.at(-1) === 'src/presigned/cashout-acceptance.ts').map(item => item.network), ['signet','mainnet']);
const cashoutPureSummary = { passed: true, syntheticParserFixture: true, suite: 'owned-payout-cashout',
  protocols: [PRESIGNED_PROTOCOL,PRESIGNED_PROTOCOL_V3], networkFormats: ['signet','mainnet'],
  signedCashouts: 48, negativeControls: 224, destinationTypes: 5, callerPayoutKeyZeroized: true,
  actualChainVerified: false, publicNetworkBroadcasts: 0, mainnetAuthorized: false,
  payoutFamilies: ['solo-first','solo-second','final-owned','cooperative','recovery','final-sweep','same-key-external-or-fee-child'] };
validateCommandResults(cashoutPure, JSON.stringify(cashoutPureSummary));
for (const mutation of [{ signedCashouts: 47 }, { negativeControls: 223 }, { destinationTypes: 4 }, { callerPayoutKeyZeroized: false },
  { actualChainVerified: true }, { protocols: [PRESIGNED_PROTOCOL_V3] }, { networkFormats: ['signet'] }, { payoutFamilies: ['solo-first'] }])
  denied(() => validateCommandResults(cashoutPure, JSON.stringify({ ...cashoutPureSummary, ...mutation })));
const cashoutCore = acceptancePlan('local').find(item => item.id === 'presigned-core-cashout')!;
const cashoutCoreSummary = { passed: true, syntheticParserFixture: true, suite: 'owned-payout-cashout-core',
  protocols: [PRESIGNED_PROTOCOL,PRESIGNED_PROTOCOL_V3], actualChain: 'isolated-regtest', coreVersion: 310100,
  confirmedCashouts: 24, confirmedParents: 18, rejectedMutations: 192, destinationTypes: 5,
  actualCoinAnchorsVerified: true, publicNetworkBroadcasts: 0, liveSignetVerified: false, mainnetAuthorized: false,
  payoutFamilies: ['solo-first','solo-second','final-sweep','final-owned','cooperative','recovery','cpfp-preserved-payout','independently-owned-same-key'] };
validateCommandResults(cashoutCore, JSON.stringify(cashoutCoreSummary));
for (const mutation of [{ confirmedCashouts: 23 }, { confirmedParents: 17 }, { rejectedMutations: 191 }, { destinationTypes: 4 },
  { actualCoinAnchorsVerified: false }, { liveSignetVerified: true }, { mainnetAuthorized: true }, { protocols: [PRESIGNED_PROTOCOL_V3] },
  { payoutFamilies: ['solo-first'] }, { actualChain: 'signet' }])
  denied(() => validateCommandResults(cashoutCore, JSON.stringify({ ...cashoutCoreSummary, ...mutation })));
const offlineCashoutSummary = { passed: true, syntheticParserFixture: true, completeLifecycleEvidence: true, completeFeeEvidence: true,
  fullSoloOrderings: 6, cooperativeRounds: 4, recoverySignerSubsets: 9, actualBrowserSignedTransactionsConfirmedByCore: 31,
  feeRescueWalletAndParentCases: 10, replacementFeeChildrenConfirmedByCore: 10, networkRequests: 0, persistentSecretStorage: false,
  utilitySha256: createHash('sha256').update(readFileSync('public/offline/presigned-recovery.html')).digest('hex'),
  protocol: PRESIGNED_PROTOCOL_V3, exactArtifactInputsVerified: true, mainnetBoundaryProtocols: [PRESIGNED_PROTOCOL,PRESIGNED_PROTOCOL_V3],
  ownedPayoutCashoutsConfirmed: 12, cashoutOwnerAndReviewMutationRefusals: 37,
  cashoutPayoutFamilies: ['cooperative','cpfp-preserved-payout','final-sweep','recovery','solo'] };
validateCommandResults(offline, JSON.stringify(offlineCashoutSummary));
for (const mutation of [{ ownedPayoutCashoutsConfirmed: undefined }, { ownedPayoutCashoutsConfirmed: 5 },
  { cashoutOwnerAndReviewMutationRefusals: undefined }, { cashoutOwnerAndReviewMutationRefusals: 36 },
  { cashoutPayoutFamilies: ['solo'] }, { cashoutPayoutFamilies: undefined }, { completeLifecycleEvidence: false }, { completeFeeEvidence: false }])
  denied(() => validateCommandResults(offline, JSON.stringify({ ...offlineCashoutSummary, ...mutation })));
checks.push('owned-payout cash-out requires full pure/Core coverage and actual full saved-file browser proof; focused/missing cash-outs cannot satisfy release');
const offlineMerge = plan.find(item => item.args.at(-1) === 'src/presigned/v3-offline-merge-acceptance.ts')!;
const mergeSummary = { passed: true, syntheticParserFixture: true, protocols: [PRESIGNED_PROTOCOL,PRESIGNED_PROTOCOL_V3],
  hostilePeerOrKitRefusals: 26, completeCooperativeMerges: 2, browserExecution: false, publicNetworkBroadcasts: 0 };
validateCommandResults(offlineMerge, JSON.stringify(mergeSummary));
for (const mutation of [{ hostilePeerOrKitRefusals: 25 }, { completeCooperativeMerges: 1 }, { browserExecution: true },
  { publicNetworkBroadcasts: 1 }, { protocols: [PRESIGNED_PROTOCOL_V3] }])
  denied(() => validateCommandResults(offlineMerge, JSON.stringify({ ...mergeSummary, ...mutation })));
const recycling = plan.find(item => item.args.at(-1) === 'scripts/presigned-live-recycling-verification.mts')!;
const pureCapital = { passed: true, syntheticParserFixture: true, configuredNetwork: 'signet', scope: 'pure-offline-capital-recycling',
  signedTransactions: 10, normalizedWalletPsbts: 8, rejectedMutations: 96, completedChecks: 13,
  networkCalls: 0, walletCalls: 0, consensusOrLiveSignetVerified: false };
validateCommandResults(recycling, JSON.stringify(pureCapital));
for (const mutation of [{ configuredNetwork: 'mainnet' }, { rejectedMutations: 95 }, { signedTransactions: 9 }, { normalizedWalletPsbts: 7 },
  { networkCalls: 1 }, { walletCalls: 1 }, { consensusOrLiveSignetVerified: true }])
  denied(() => validateCommandResults(recycling, JSON.stringify({ ...pureCapital, ...mutation })));
const lowCapital = acceptancePlan('local').find(item => item.id === 'presigned-live-lifecycle-regtest')!;
const capitalAudit = { initialCapitalSats: 89_000, fixedConfirmedFeesSats: 47_000, allocationFeesSats: 3500,
  returnedSats: 38_500, confirmedAllocations: 20, recycledParticipantPayouts: 57, unrelatedWalletInputsUsed: 0,
  allTerminalOutputsAndReservesConsumedExactlyOnce: true };
const csvBoundaryAudit = { cases: 9, delayBlocks: 12, justBeforeMaturityRejected: 9,
  matureTransactionsAllowed: 9, sameStoredTransactionBytes: true };
const durableCustodyAudit = { primaryLossRestorations: 2, initializationInterruptions: 2, durableSendChecks: 84, uniqueSubmittedTransactions: 89,
  actualNativeWalletRestoredSignatures: 83, independentlyRestoredCasesBeforeFunding: 19, nativeTargetsRegenerated: 0 };
const lowCapitalSummary = { passed: true, syntheticParserFixture: true, publicNetworkBroadcasts: 0, coreVersion: 310100,
  cases: 19, feeFamilies: 5, lostRepliesWithoutResending: 6, capitalAudit, csvBoundaryAudit, durableCustodyAudit };
validateCommandResults(lowCapital, JSON.stringify(lowCapitalSummary));
const v3LowCapital = acceptancePlan('local').find(item => item.id === 'presigned-live-lifecycle-v3-regtest')!;
const v3LowCapitalSummary = { ...lowCapitalSummary, protocol: PRESIGNED_PROTOCOL_V3, setupSignaturesPerCase: 21, fixedRecoveryTemplatesPerCase: 4,
  lostRepliesWithoutResending:7, capitalAudit:{ ...capitalAudit, fixedConfirmedFeesSats:47300, returnedSats:38200, recycledParticipantPayouts:56 },
  durableCustodyAudit:{ ...durableCustodyAudit, durableSendChecks:85, uniqueSubmittedTransactions:90 },
  ownedCashoutProfile:'missing-carol-refund-to-native-wallet-v1', ownedPayoutCashoutsConfirmed:1,
  ownedCashoutAudit:{ confirmed:1, feeSats:300, omittedParticipant:'carol', destinationAlreadyBackedUp:true, ownerOnlySignatureVerified:true,
    lostReplyReconciledWithoutResend:true, cashoutReorganizationRejected:true, refundAncestorReorganizationRejected:true },
  publicCompletedCaseCacheAudit:{fileMutationsRejected:25,missingFileRejected:true,permissionsRejected:true,returnedAliasMutationIsolated:true,
    sourceAndProtocolChangesRejected:true,coldMilliseconds:1,warmMilliseconds:1} };
validateCommandResults(v3LowCapital, JSON.stringify(v3LowCapitalSummary));
for (const mutation of [{ protocol: PRESIGNED_PROTOCOL }, { setupSignaturesPerCase: 12 }, { fixedRecoveryTemplatesPerCase: 0 }])
  denied(() => validateCommandResults(v3LowCapital, JSON.stringify({ ...v3LowCapitalSummary, ...mutation })));
for (const mutation of [{ ownedCashoutProfile:undefined }, { ownedPayoutCashoutsConfirmed:0 }, { ownedCashoutAudit:undefined },
  { lostRepliesWithoutResending:6 }, { capitalAudit }, { durableCustodyAudit }])
  denied(() => validateCommandResults(v3LowCapital, JSON.stringify({ ...v3LowCapitalSummary, ...mutation })));
for (const field of Object.keys(v3LowCapitalSummary.ownedCashoutAudit))
  denied(() => validateCommandResults(v3LowCapital, JSON.stringify({ ...v3LowCapitalSummary,
    ownedCashoutAudit:{ ...v3LowCapitalSummary.ownedCashoutAudit, [field]:undefined } })));
for(const field of Object.keys(v3LowCapitalSummary.publicCompletedCaseCacheAudit))
  denied(()=>validateCommandResults(v3LowCapital,JSON.stringify({...v3LowCapitalSummary,
    publicCompletedCaseCacheAudit:{...v3LowCapitalSummary.publicCompletedCaseCacheAudit,[field]:undefined}})));
for (const mutation of [{ cases: 18 }, { feeFamilies: 4 }, { lostRepliesWithoutResending: 5 }])
  denied(() => validateCommandResults(lowCapital, JSON.stringify({ ...lowCapitalSummary, ...mutation })));
for (const mutation of [{ initialCapitalSats: 88_999 }, { fixedConfirmedFeesSats: 46_000 }, { allocationFeesSats: 6761 },
  { returnedSats: 38_501 }, { confirmedAllocations: 19 }, { recycledParticipantPayouts: 56 }, { unrelatedWalletInputsUsed: 1 },
  { allTerminalOutputsAndReservesConsumedExactlyOnce: false }])
  denied(() => validateCommandResults(lowCapital, JSON.stringify({ ...lowCapitalSummary, capitalAudit: { ...capitalAudit, ...mutation } })));
denied(() => validateCommandResults(lowCapital, JSON.stringify({ ...lowCapitalSummary, csvBoundaryAudit: undefined })));
for (const mutation of [{ cases: 8 }, { delayBlocks: 11 }, { justBeforeMaturityRejected: 8 },
  { matureTransactionsAllowed: 8 }, { sameStoredTransactionBytes: false }])
  denied(() => validateCommandResults(lowCapital, JSON.stringify({ ...lowCapitalSummary,
    csvBoundaryAudit: { ...csvBoundaryAudit, ...mutation } })));
checks.push('pure capital signatures and complete confined Core recycling are mandatory on the exact required matrix');
denied(() => validateCommandResults(lowCapital, JSON.stringify({ ...lowCapitalSummary, durableCustodyAudit: undefined })));
for (const mutation of [{ primaryLossRestorations: 1 }, { initializationInterruptions: 1 }, { durableSendChecks: 83 }, { uniqueSubmittedTransactions: 88 },
  { actualNativeWalletRestoredSignatures: 82 }, { independentlyRestoredCasesBeforeFunding: 18 }, { nativeTargetsRegenerated: 1 }])
  denied(() => validateCommandResults(lowCapital, JSON.stringify({ ...lowCapitalSummary, durableCustodyAudit: { ...durableCustodyAudit, ...mutation } })));
const durableCommand = plan.find(item => item.args.at(-1) === 'scripts/presigned-durable-journal-verification.mts')!;
const durableSummary = { passed: true, syntheticParserFixture: true, configuredNetwork: 'signet', scope: 'private-journal-filesystem-fixtures',
  completeCheckpoints: 19, actualCompleteRestorations: 14, rejectedBoundaries: 42, kernelLockChecks: 4, actualPrimaryCutovers: 2,
  metadataLossRestorations: 3, interruptedCheckpointRepairs: 3, atomicCutoverPreflightChecks: 1,
  independentRollbackAnchorRequired: true, networkCalls: 0, walletCalls: 0, publicBroadcasts: 0,
  realParticipantCustodyVerified: false, realSignetVerified: false };
validateCommandResults(durableCommand, JSON.stringify(durableSummary));
for (const mutation of [{ completeCheckpoints: 18 }, { actualCompleteRestorations: 13 }, { rejectedBoundaries: 41 },
  { metadataLossRestorations: 2 }, { interruptedCheckpointRepairs: 2 }, { atomicCutoverPreflightChecks: 0 },
  { kernelLockChecks: 3 }, { actualPrimaryCutovers: 1 }, { independentRollbackAnchorRequired: false }, { publicBroadcasts: 1 }, { realSignetVerified: true }])
  denied(() => validateCommandResults(durableCommand, JSON.stringify({ ...durableSummary, ...mutation })));
const nativeCommand = acceptancePlan('local').find(item => item.id === 'presigned-wallet-restore-verification')!;
const nativeSummary = { passed: true, syntheticParserFixture: true, scope: 'actual-isolated-native-wallet-restoration',
  publicNetworkBroadcasts: 0, coreVersion: 310100, actualRestoredNativeSignatures: 83, rejectedBindings: 15, sourceWalletCalls: 1,
  coreDataDirectoryLockChecks: 4,
  sourceBalancesUnchanged: true, originalBackupUnchanged: true, networkingDisabled: true, participantKeysImported: false,
  realDefaultSignetVerified: false, signatureContextBindingVerified: true, cleanRestoreShutdownVerified: true };
validateCommandResults(nativeCommand, JSON.stringify(nativeSummary));
for (const mutation of [{ actualRestoredNativeSignatures: 82 }, { rejectedBindings: 14 }, { sourceWalletCalls: 2 }, { coreDataDirectoryLockChecks: 3 },
  { sourceBalancesUnchanged: false }, { originalBackupUnchanged: false }, { networkingDisabled: false },
  { participantKeysImported: true }, { signatureContextBindingVerified: false }, { cleanRestoreShutdownVerified: false }])
  denied(() => validateCommandResults(nativeCommand, JSON.stringify({ ...nativeSummary, ...mutation })));
checks.push('full-primary-loss, exact initialization resumption, kernel locking and native signature-context custody proofs cannot be omitted');
denied(() => validateCommandResults(lowCapital, JSON.stringify({ passed: true, scope: 'isolated-durable-custody-smoke-only',
  coreVersion: 310100, publicNetworkBroadcasts: 0, primaryLossRestorations: 2, fullLifecycleAcceptanceCompleted: false })));
const directory = mkdtempSync('/tmp/btc-presigned-evidence-boundary.');
const filename = `${directory}/synthetic.json`;
writeFileSync(filename, '{"synthetic":true}', { mode: 0o600, flag: 'wx' });
assert.deepEqual(parseAcceptanceJson(readPrivateAcceptanceFile(filename)), { synthetic: true });
symlinkSync(filename, `${directory}/link.json`); denied(() => readPrivateAcceptanceFile(`${directory}/link.json`));
denied(() => readPrivateAcceptanceFile(filename, 1));
chmodSync(filename, 0o644); denied(() => readPrivateAcceptanceFile(filename)); chmodSync(filename, 0o600);
chmodSync(directory, 0o755); denied(() => readPrivateAcceptanceFile(filename)); chmodSync(directory, 0o700);
checks.push('protected bounded evidence rejects links and group/world-accessible files or directories');
const observed = await executeAcceptanceCommand({ id: 'actual-runtime', executable: 'node', args: ['scripts/check-runtime.mjs'],
  network: 'signet', category: 'typecheck' }, directory, presignedSourceDigest());
assert.equal(observed.exitCode, 0); assert(observed.stdoutSha256 && observed.stderrSha256);
await assert.rejects(() => executeAcceptanceCommand({ id: 'stale-source', executable: 'node', args: ['scripts/check-runtime.mjs'],
  network: 'signet', category: 'typecheck' }, directory, '00'.repeat(32))); negatives++;
checks.push('real child exit and transcript recording; changed source rejected before spawning');

const sourceDigest = presignedSourceDigest();
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const browser = acceptancePlan('local').find(item => item.id === 'optimized-browser')!;
const syntheticBrowser = { passed: true, protocol: PRESIGNED_PROTOCOL_V3, bundle: 'optimized-webpack-standalone',
  sourceDigest, appNetwork: 'signet', actualBitcoinChain: 'isolated-regtest', networkIdentityBridge: true,
  virtualPrfPasskeys: 6, coreVersion: 310100, realSignetAcceptance: false, physicalPasskeyEvidence: false,
  publicNetworkBroadcasts: 0, mainnetFundingAuthorized: false, completeGameExecution: true, reauthentications: 1,
  setupSignatures: 21, fixedRecoveryTemplates: 4, fixedMissingParticipantRefundVerified: true,
  cashoutDestinationAndFeeReviewed: true, cashoutUnsignedPreviewVerified: true,
  ownedPayoutCashoutsConfirmed: 1, cashoutOwnerAndReviewMutationRefusals: 2,
  audit: { sensitiveRequestDetected: false, forbidden: [], unexpected: [] } };
validateBrowserAcceptance(syntheticBrowser, sourceDigest, 'signet');
for (const alteration of [
  { appNetwork: 'mainnet' }, { sourceDigest: '00'.repeat(32) }, { completeGameExecution: false }, { virtualPrfPasskeys: 5 },
  { reauthentications: 0 }, { mainnetFundingAuthorized: true }, { realSignetAcceptance: true }, { physicalPasskeyEvidence: true },
  { publicNetworkBroadcasts: 1 }, { coreVersion: 300000 }, { audit: { sensitiveRequestDetected: true, forbidden: [], unexpected: [] } },
  { protocol: PRESIGNED_PROTOCOL }, { setupSignatures: 12 }, { fixedRecoveryTemplates: 3 }, { fixedMissingParticipantRefundVerified: false },
  { cashoutDestinationAndFeeReviewed: false }, { cashoutUnsignedPreviewVerified: false },
  { cashoutDestinationAndFeeReviewed: undefined }, { cashoutUnsignedPreviewVerified: undefined },
  { ownedPayoutCashoutsConfirmed: 0 }, { ownedPayoutCashoutsConfirmed: undefined },
  { cashoutOwnerAndReviewMutationRefusals: 1 }, { cashoutOwnerAndReviewMutationRefusals: undefined },
]) denied(() => validateBrowserAcceptance({ ...syntheticBrowser, ...alteration }, sourceDigest, 'signet'));
const { setupSignatures: ignoredSetup, fixedRecoveryTemplates: ignoredRefunds, fixedMissingParticipantRefundVerified: ignoredRecovery, ...legacyBrowser } = syntheticBrowser;
void ignoredSetup; void ignoredRefunds; void ignoredRecovery;
validateBrowserAcceptance({ ...legacyBrowser, protocol: PRESIGNED_PROTOCOL }, sourceDigest, 'signet', PRESIGNED_PROTOCOL);
denied(() => validateBrowserAcceptance(syntheticBrowser, sourceDigest, 'signet', PRESIGNED_PROTOCOL));
const syntheticMainnet = { ...syntheticBrowser, appNetwork: 'mainnet', completeGameExecution: false, mainnetFundingGateVerified: true };
validateBrowserAcceptance(syntheticMainnet, sourceDigest, 'mainnet');
denied(() => validateBrowserAcceptance({ ...syntheticMainnet, mainnetFundingGateVerified: false }, sourceDigest, 'mainnet'));
denied(() => validateBrowserAcceptance({ ...syntheticMainnet, completeGameExecution: true }, sourceDigest, 'mainnet'));
denied(() => validateBrowserAcceptance({ ...syntheticMainnet, cashoutDestinationAndFeeReviewed: undefined }, sourceDigest, 'mainnet'));
denied(() => validateBrowserAcceptance({ ...syntheticMainnet, cashoutUnsignedPreviewVerified: undefined }, sourceDigest, 'mainnet'));
const browserPath = `${browser.id}-browser.json`;
const browserBytes = JSON.stringify(syntheticBrowser);
writeFileSync(`${directory}/${browserPath}`, browserBytes, { mode: 0o600, flag: 'wx' });
const browserArtifacts = [{ relativePath: browserPath, sha256: sha256(browserBytes) }];
validateAcceptanceArtifacts(browser, browserArtifacts, directory, sourceDigest);
denied(() => validateAcceptanceArtifacts(browser, [], directory, sourceDigest));
denied(() => validateAcceptanceArtifacts(browser, [...browserArtifacts, ...browserArtifacts], directory, sourceDigest));
denied(() => validateAcceptanceArtifacts(browser, [{ ...browserArtifacts[0]!, relativePath: '../substituted.json' }], directory, sourceDigest));
writeFileSync(`${directory}/${browserPath}`, JSON.stringify({ ...syntheticBrowser, completeGameExecution: false }), { mode: 0o600 });
denied(() => validateAcceptanceArtifacts(browser, browserArtifacts, directory, sourceDigest));
denied(() => validateAcceptanceArtifacts(browser, [{ relativePath: browserPath,
  sha256: sha256(readFileSync(`${directory}/${browserPath}`)) }], directory, sourceDigest));
checks.push('retained browser artifacts revalidate exact role, full-game or mainnet-refusal scope, source, bytes and paths');

const database = acceptancePlan('local').find(item => item.id === 'database-v2-all')!;
const dbArtifacts = ['ceremony', 'runtime', 'chain-broadcast', 'fee', 'restore'].map(name => {
  const relativePath = `${database.id}-${name}.log`;
  const bytes = JSON.stringify({ passed: true, syntheticParserFixture: true, ...(name === 'restore' ? { restoredEncryptedKeys: 6, negativeBoundaries: 22 } : {}) });
  writeFileSync(`${directory}/${relativePath}`, bytes, { mode: 0o600, flag: 'wx' });
  return { relativePath, sha256: sha256(bytes) };
});
validateAcceptanceArtifacts(database, dbArtifacts, directory, sourceDigest);
denied(() => validateAcceptanceArtifacts(database, dbArtifacts.slice(0, 4), directory, sourceDigest));
const restorePath = dbArtifacts.at(-1)!.relativePath;
const noRestoredCustody = JSON.stringify({ passed: true, restoredEncryptedKeys: 0, negativeBoundaries: 22 });
writeFileSync(`${directory}/${restorePath}`, noRestoredCustody, { mode: 0o600 });
dbArtifacts.at(-1)!.sha256 = sha256(noRestoredCustody);
denied(() => validateAcceptanceArtifacts(database, dbArtifacts, directory, sourceDigest));
checks.push('all five distinct retained database artifacts mandatory; a rehashed missing custody restoration remains rejected');
const v3Database = acceptancePlan('local').find(item => item.id === 'database-v3-all')!;
const cashoutDbSummary = { actualDatabase: 'isolated-PostgreSQL', actualChain: 'isolated-regtest', networkIdentityBridge: true,
  realDefaultSignetEvidence: false, realWebAuthnTransport: false, publicNetworkBroadcasts: 0,
  missingParticipantRefundCashedOut: true, serverIndependentKeyRestoration: true, ownerCashoutSends: 1,
  checks: ['synthetic-owner-boundary','synthetic-durable-send','synthetic-confirmed-conflict','synthetic-reorg'] };
const queueDbSummary = { actualDatabase: 'disposable-loopback-PostgreSQL', disabledV2RowsPerQueue: 100,
  enabledV3RowsRetriedPerQueue: 1, rpcCalls: 0, publicNetworkBroadcasts: 0, realMainnetAuthorizationGranted: false };
const v3DbArtifacts = ['ceremony', 'runtime', 'chain-broadcast', 'fee', 'restore', 'cashout', 'protocol-queue'].map(name => {
  const relativePath = `${v3Database.id}-${name}.log`;
  const bytes = JSON.stringify({ passed: true, syntheticParserFixture: true, protocol: PRESIGNED_PROTOCOL_V3,
    ...(name === 'restore' ? { restoredEncryptedKeys: 6, negativeBoundaries: 22 } : {}),
    ...(name === 'cashout' ? cashoutDbSummary : {}), ...(name === 'protocol-queue' ? queueDbSummary : {}) });
  writeFileSync(`${directory}/${relativePath}`, bytes, { mode: 0o600, flag: 'wx' });
  return { relativePath, sha256: sha256(bytes) };
});
validateAcceptanceArtifacts(v3Database, v3DbArtifacts, directory, sourceDigest);
denied(() => validateAcceptanceArtifacts(v3Database, v3DbArtifacts.slice(0, 5), directory, sourceDigest));
for (const [name, summary, mutations] of [
  ['cashout', cashoutDbSummary, [{ missingParticipantRefundCashedOut: undefined }, { serverIndependentKeyRestoration: false },
    { ownerCashoutSends: 2 }, { checks: [] }]],
  ['protocol-queue', queueDbSummary, [{ disabledV2RowsPerQueue: 99 }, { enabledV3RowsRetriedPerQueue: 0 },
    { rpcCalls: 1 }, { realMainnetAuthorizationGranted: true }]],
] as const) {
  const artifact = v3DbArtifacts.find(item => item.relativePath === `${v3Database.id}-${name}.log`)!;
  for (const mutation of mutations) {
    const changed = JSON.stringify({ passed: true, syntheticParserFixture: true, protocol: PRESIGNED_PROTOCOL_V3, ...summary, ...mutation });
    writeFileSync(`${directory}/${artifact.relativePath}`, changed, { mode: 0o600 }); artifact.sha256 = sha256(changed);
    denied(() => validateAcceptanceArtifacts(v3Database, v3DbArtifacts, directory, sourceDigest));
  }
  const restored = JSON.stringify({ passed: true, syntheticParserFixture: true, protocol: PRESIGNED_PROTOCOL_V3, ...summary });
  writeFileSync(`${directory}/${artifact.relativePath}`, restored, { mode: 0o600 }); artifact.sha256 = sha256(restored);
}
const legacyDbSubstitution = JSON.stringify({ passed: true, syntheticParserFixture: true, protocol: PRESIGNED_PROTOCOL });
writeFileSync(`${directory}/${v3DbArtifacts[0]!.relativePath}`, legacyDbSubstitution, { mode: 0o600 });
v3DbArtifacts[0]!.sha256 = sha256(legacyDbSubstitution);
denied(() => validateAcceptanceArtifacts(v3Database, v3DbArtifacts, directory, sourceDigest));
checks.push('V3 low-capital and database evidence require actual V3 setup and all seven matching-protocol suite outputs including durable cash-out and queue isolation');

for (const network of ['signet', 'mainnet'] as const) {
  const fixed = IMAGE_EXECUTION_STAGES.map(stage => imageExecutionCommand(stage, network, '/tmp/btc-presigned-image.synthetic', `sha256:${'12'.repeat(32)}`));
  assert.equal(fixed.length, 7);
  assert(fixed[4]!.args.includes('--read-only') && fixed[4]!.args.includes('none'));
  assert.deepEqual(fixed[6]!.environment, { PRESIGNED_BROWSER_NETWORK: network,
    PRESIGNED_BROWSER_PROTOCOL: PRESIGNED_PROTOCOL_V3,
    PRESIGNED_BROWSER_CONTAINER_IMAGE_ID: `sha256:${'12'.repeat(32)}`,
    BROWSER_TEST_BUILD_IDENTITY: '/tmp/btc-presigned-image.synthetic/build-identity.json' });
}
denied(() => imageExecutionCommand('unreviewed' as 'build-image', 'signet', '/tmp/btc-presigned-image.synthetic'));
denied(() => imageExecutionCommand('build-image', 'signet', '/tmp/../../unsafe'));
denied(() => imageExecutionCommand('runtime-identity', 'signet', '/tmp/btc-presigned-image.synthetic', 'mutable:tag'));
checks.push('image stages reconstruct exact fixed commands, immutable IDs, read-only runtime and network environment');

// An intentionally incomplete negative fixture, not a passing run or release.
const partial = mkdtempSync('/tmp/btc-presigned-incomplete-run.');
const now = new Date().toISOString();
const partialBody = { version: 3, protocol: PRESIGNED_PROTOCOL_V3, kind: 'presigned-v3-local-executable-run', mode: 'local',
  sourceDigest, createdAt: now, completedAt: now, reviewedNodeVersion: readFileSync('.node-version', 'utf8').trim(),
  commands: [], offlineUtilityDigest: null, physicalPasskeysVerified: false, realSignetVerified: false,
  exactImageVerified: false, fundingAuthorized: false };
writeAcceptanceJson(`${partial}/run.json`, { ...partialBody,
  runDigest: commitmentDigest('vault/presigned-graph-v3/local-executable-run', partialBody) });
denied(() => validateLocalAcceptanceRun(partial, sourceDigest, 'local'));
const output = `${partial}/must-not-exist.json`;
const assemblyArgs = ['--local-run', partial, '--signet-image', `${partial}/missing-signet`, '--mainnet-image', `${partial}/missing-mainnet`,
  '--signet-control', `${partial}/missing-control`, '--network', 'signet', '--write-protected-receipt', output];
const refusedAssembly = (args: string[], message: string) => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/presigned-assemble-acceptance.mts', ...args],
    { env: acceptanceEnvironment('signet'), encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 1); assert(result.stderr.includes(message)); assert.equal(existsSync(output), false); negatives++;
};
refusedAssembly([], 'required arguments');
refusedAssembly([...assemblyArgs, '--network', 'mainnet'], 'invalid or repeated acceptance assembly argument');
refusedAssembly(assemblyArgs.map(value => value === partial ? 'relative-evidence' : value), 'use explicit absolute evidence paths');
refusedAssembly(assemblyArgs, 'missing or substituted fixed acceptance command');
const existing = `${partial}/existing.json`; writeFileSync(existing, 'retained-not-a-receipt', { mode: 0o600, flag: 'wx' });
refusedAssembly(assemblyArgs.map(value => value === output ? existing : value), 'refusing to overwrite an existing acceptance receipt');
assert.equal(readFileSync(existing, 'utf8'), 'retained-not-a-receipt');
checks.push('actual assembly CLI rejects omitted, duplicate, relative, incomplete and existing-output inputs without creating a release');

// The supported npm entry point must load its dynamic server imports, not just
// pass a guard before importing them. No live configuration survives this probe.
const releaseProbe = spawnSync('npm', ['run', 'presigned:release-status', '--',
  '--vault-id', '11111111-1111-4111-8111-111111111111', '--epoch-id', '22222222-2222-4222-8222-222222222222'],
{ env: acceptanceEnvironment('signet'), encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024 });
assert.equal(releaseProbe.status, 1);
assert(!releaseProbe.stderr.includes('This module cannot be imported from a Client Component module'));
const prerequisiteResult = acceptanceJsonRecords(releaseProbe.stdout).findLast(item => item.passed === false);
assert(prerequisiteResult?.reportWritten === false && prerequisiteResult.fundingAllowed === false && typeof prerequisiteResult.detail === 'string');
negatives++;
checks.push('supported operator npm command loads the full server path and rejects absent release prerequisites without external access');

// Counterfactual binding fixtures only, not executed image/Signet receipts.
// Run the real release CLI against an isolated filesystem and forbid all
// network transport. It must reject a changed/missing utility before accessing
// the database or writing even a descriptive funding report.
const utilityFixture = mkdtempSync('/tmp/btc-presigned-synthetic-release-negative.');
mkdirSync(`${utilityFixture}/public/offline`, { recursive: true, mode: 0o700 });
const testedUtility = 'SYNTHETIC NON-EXECUTABLE UTILITY BINDING FIXTURE';
const syntheticReceiptBody = { version: 2, protocol: 'presigned-graph-v2', kind: 'presigned-v2-executable-acceptance',
  createdAt: new Date().toISOString(), sourceDigest: '11'.repeat(32), testedImageManifestDigest: `sha256:${'22'.repeat(32)}`,
  offlineUtilityDigest: sha256(testedUtility), physicalPasskeys: 'deferred-to-friends-onboarding',
  evidence: PRESIGNED_RELEASE_CHECKS.map(check => ({ check, artifactDigest: '44'.repeat(32) })), liveSignetReceiptDigest: '55'.repeat(32) };
const syntheticReceipt = { ...syntheticReceiptBody,
  receiptDigest: commitmentDigest('vault/presigned-graph-v2/executable-acceptance', syntheticReceiptBody) };
writeAcceptanceJson(`${utilityFixture}/synthetic-binding-only.json`, syntheticReceipt);
writeAcceptanceJson(`${utilityFixture}/vault-presigned-build.json`, { version: 2, protocol: 'presigned-graph-v2',
  network: 'signet', sourceDigest: syntheticReceipt.sourceDigest });
writeAcceptanceJson(`${utilityFixture}/vault-build-network.json`, { version: 1, network: 'signet' });
writeFileSync(`${utilityFixture}/public/offline/presigned-recovery.html`, `${testedUtility} CHANGED`, { mode: 0o600, flag: 'wx' });
const syntheticReport = `${utilityFixture}/must-not-create-report.json`;
const releaseEntry = pathToFileURL(resolve('web/scripts/presigned-release-status.ts')).href;
const guardProgram = `
  import net from 'node:net';
  let networkAttempts = 0;
  net.Socket.prototype.connect = function() { networkAttempts++; throw new Error('synthetic probe forbids network transport'); };
  globalThis.fetch = async function() { networkAttempts++; throw new Error('synthetic probe forbids network transport'); };
  process.argv = [process.execPath, ${JSON.stringify(releaseEntry)}, '--vault-id', '11111111-1111-4111-8111-111111111111',
    '--epoch-id', '22222222-2222-4222-8222-222222222222', '--write-protected-report', ${JSON.stringify(syntheticReport)}];
  await import(${JSON.stringify(releaseEntry)});
  console.log(JSON.stringify({ syntheticNegativeProbe: true, networkAttempts }));
`;
const runSyntheticRelease = (expected: string) => {
  const result = spawnSync(process.execPath, ['--conditions=react-server', '--import', import.meta.resolve('tsx'), '--input-type=module', '-e', guardProgram],
    { cwd: utilityFixture, env: { ...acceptanceEnvironment('signet'),
      PRESIGNED_V2_ACCEPTANCE_RECEIPT: `${utilityFixture}/synthetic-binding-only.json`,
      PRESIGNED_V2_ACCEPTANCE_RECEIPT_DIGEST: syntheticReceipt.receiptDigest,
      DEPLOYED_IMAGE_MANIFEST_DIGEST: syntheticReceipt.testedImageManifestDigest,
      WEBAUTHN_RP_ID: 'example.invalid', WEBAUTHN_ORIGIN: 'https://example.invalid', APP_ORIGIN: 'https://example.invalid',
      CHAIN_OBSERVATION_ORIGINS: 'https://source.invalid' }, encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 1);
  const records = acceptanceJsonRecords(result.stdout);
  const refusal = records.find(item => item.passed === false);
  assert(refusal?.reportWritten === false && refusal.fundingAllowed === false && refusal.detail.includes(expected),
    JSON.stringify({ expectedSyntheticRefusal: expected, observedSyntheticRefusal: refusal?.detail }));
  assert.equal(records.find(item => item.syntheticNegativeProbe)?.networkAttempts, 0);
  assert.equal(existsSync(syntheticReport), false); negatives++;
};
runSyntheticRelease('deployed offline recovery utility differs from the actually tested artifact');
// A matching fixture reaches the next real prerequisite, never a funded or
// passing release: no operational database endpoint exists in this child.
writeFileSync(`${utilityFixture}/public/offline/presigned-recovery.html`, testedUtility, { mode: 0o600 });
runSyntheticRelease('DATABASE_URL is required for v2 funding release');
checks.push('actual release CLI shares deployed utility/source/image validation; altered utility and absent database refuse report creation with zero network attempts');
const archiveBoundaries = await runEvidenceArchiveBoundaryTests();
checks.push('local-only allowlisted evidence archives preserve exact bytes through an actual private restoration; synthetic transport fixtures only');
console.log(JSON.stringify({ passed: true, negativeBoundaries: negatives, archiveBoundaries, checks,
  realSignetEvidence: false, exactContainerEvidence: false, releaseReceiptProduced: false, fundingAuthorized: false }));
