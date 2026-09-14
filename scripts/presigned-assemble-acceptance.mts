/** Only actual complete retained runs plus a fresh read-only Signet audit can
 * produce this software receipt. It grants no deployment or spending authority. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { assertReviewedNodeRuntime } from '../src/runtime-version.js';
import { PRESIGNED_V3_RELEASE_CHECKS, presignedReleaseChecks, validatePresignedAcceptanceReceipt, type PresignedAcceptanceReceipt } from '../src/presigned/release.js';
import { commitmentDigest, genesisHash, presignedDomain, presignedVersion } from '../src/presigned/validation.js';
import { isPresignedProtocol, PRESIGNED_PROTOCOL_V3, type PresignedProtocol } from '../src/presigned/types.js';
import { acceptanceEnvironment, parseAcceptanceJson, validateLocalAcceptanceRun, writeAcceptanceJson } from './lib/presigned-acceptance-run.js';
import { validateRetainedImageEvidence } from './lib/presigned-image-evidence.js';
import { presignedSourceDigest } from './presigned-build-identity.mjs';

process.umask(0o077); assertReviewedNodeRuntime();
const selectedProtocol = process.env.PRESIGNED_ACCEPTANCE_PROTOCOL ?? PRESIGNED_PROTOCOL_V3;
assert(isPresignedProtocol(selectedProtocol), 'unknown acceptance assembly protocol');
const protocol: PresignedProtocol = selectedProtocol;
const flags = new Map<string, string>(); const args = process.argv.slice(2);
const required = ['--local-run', '--signet-image', '--mainnet-image', '--signet-control', '--network', '--write-protected-receipt'];
for (let index = 0; index < args.length; index += 2) {
  const name = args[index]!; const value = args[index + 1];
  assert(required.includes(name) && value && !value.startsWith('--') && !flags.has(name), 'invalid or repeated acceptance assembly argument');
  flags.set(name, value);
}
assert(required.every(name => flags.has(name)) && flags.size === required.length, `required arguments: ${required.join(' ')}`);
const network = flags.get('--network'); assert(network === 'mainnet' || network === 'signet');
for (const name of required.filter(name => name !== '--network')) assert(isAbsolute(flags.get(name)!), 'use explicit absolute evidence paths');
const output = resolve(flags.get('--write-protected-receipt')!);
assert(!existsSync(output), 'refusing to overwrite an existing acceptance receipt');
const parent = lstatSync(dirname(output));
assert(parent.isDirectory() && !parent.isSymbolicLink() && parent.uid === process.getuid?.() && (parent.mode & 0o077) === 0,
  'acceptance receipt output directory must already be private and owned');
const sourceDigest = presignedSourceDigest();
const local = validateLocalAcceptanceRun(flags.get('--local-run')!, sourceDigest, 'local', protocol);
const signetImage = await validateRetainedImageEvidence(flags.get('--signet-image')!, sourceDigest, 'signet', protocol);
const mainnetImage = await validateRetainedImageEvidence(flags.get('--mainnet-image')!, sourceDigest, 'mainnet', protocol);
const utilityDigest = createHash('sha256').update(readFileSync('public/offline/presigned-recovery.html')).digest('hex');
assert(local.offlineUtilityDigest === utilityDigest && signetImage.offlineUtilityDigest === utilityDigest && mainnetImage.offlineUtilityDigest === utilityDigest,
  'local tests and both OCI images must contain the same fully tested offline artifact');

// Execute the real verifier now; do not accept a caller-supplied passed flag or
// a historical JSON file that has never been compared to the actual chain.
const stdout: Buffer[] = []; let length = 0;
const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/presigned-signet-lifecycle.mts', 'verify', flags.get('--signet-control')!],
  { cwd: process.cwd(), env: acceptanceEnvironment('signet', protocol), stdio: ['ignore', 'pipe', 'ignore'] });
child.stdout.on('data', (chunk: Buffer) => { length += chunk.length; if (length > 2 * 1024 * 1024) child.kill('SIGTERM'); else stdout.push(Buffer.from(chunk)); });
const code = await new Promise<number | null>((resolveExit, reject) => {
  child.once('error', () => reject(new Error('actual read-only default-Signet verifier could not start')));
  child.once('close', resolveExit);
});
assert(code === 0 && length <= 2 * 1024 * 1024, 'actual completed default-Signet verification failed; no acceptance receipt was created');
const live = parseAcceptanceJson(Buffer.concat(stdout)) as any;
const { receiptDigest: liveDigest, ...liveBody } = live;
assert(live.version === (protocol === PRESIGNED_PROTOCOL_V3 ? 5 : 3) && live.protocol === protocol && live.kind === `presigned-v${presignedVersion(protocol)}-verified-live-lifecycle` &&
  live.sourceDigest === sourceDigest && live.chain === 'default-Signet' && live.actualGenesisHash === genesisHash('signet') &&
  live.complete === true && live.realDefaultSignetVerified === true && live.soloOrderingsConfirmed === 6 && live.cooperativeRoundsConfirmed === 4 &&
  live.recoverySubsetsConfirmed === 9 && live.feeFamiliesConfirmed === 5 && live.restoredKits === 57 && live.hostileRejections === 80 &&
  live.everyPayoutRefundAndSponsorChangeVerified === true && live.freshRandomParticipantKeys === true && live.externalWalletKeysExported === false &&
  live.physicalPasskeysVerified === false && live.liveBrowserPasskeysVerified === false && live.fundingAuthorized === false);
if (protocol === PRESIGNED_PROTOCOL_V3) assert(live.recoveryPolicy === 'fixed-equal-quorum-v1' && live.payoutSchedule === 'last-survivor-net-v1' &&
  live.setupSignaturesPerCase === 21 && live.fixedRecoveryTemplatesPerCase === 4 && live.fixedRecoveryQuorumsConfirmed === 9 &&
  JSON.stringify(live.normalPayoutSats) === JSON.stringify([9120, 9600, 10080]),
  'V3 live evidence must prove fixed-refund, twenty-one-signature last-survivor ceremonies');
const capital = live.capitalRecyclingEvidence;
const ownedCashout = protocol === PRESIGNED_PROTOCOL_V3;
assert(capital?.version === (ownedCashout ? 3 : 2) && capital.execution === 'bounded-sequential-recycling-v2' &&
  Number.isSafeInteger(capital.initialCapitalSats) && capital.initialCapitalSats >= (ownedCashout ? 88_652 : 88_352) &&
  capital.initialCapitalSats <= capital.capitalLimitSats && capital.capitalLimitSats <= 1_000_000 &&
  capital.unrelatedWalletInputsUsed === 0 && capital.confirmedAllocations === 20 && capital.uniqueConfirmedTransactions === (ownedCashout ? 85 : 84) &&
  capital.fixedConfirmedFeesSats === (ownedCashout ? 47_300 : 47_000) && capital.allocationFeesSats <= 6760 &&
  capital.uniqueConfirmedFeesSats === capital.fixedConfirmedFeesSats + capital.allocationFeesSats &&
  capital.maximumUniqueConfirmedFeesSats === (ownedCashout ? 54_060 : 53_760) && capital.returnedSats >= 330 &&
  capital.initialCapitalSats === capital.returnedSats + capital.uniqueConfirmedFeesSats &&
  capital.allTerminalOutputsAndReservesConsumedExactlyOnce === true && capital.finalWalletReturnConfirmedAndUnspent === true,
  'completed Signet evidence lacks exact closed-budget capital recycling and confirmed return');
if (ownedCashout) {
  const payout = live.ownedPayoutCashoutEvidence;
  const profile = 'missing-carol-refund-to-native-wallet-v1';
  assert(live.ownedCashoutProfile === profile && live.ownedPayoutCashoutsConfirmed === 1 &&
    capital.ownedCashoutProfile === profile && capital.minimumInitialCapitalSats === 88_652 &&
    payout?.version === 1 && payout.profile === profile && payout.caseId === 'case-12' && payout.participantId === 'carol' &&
    payout.source?.vout === 2 && payout.source.valueSats === 9833 && payout.payoutSats === 9533 && payout.feeSats === 300 &&
    [payout.source.txid,payout.txid,payout.ownerRestorationCheckpointDigest].every(value => typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value)) &&
    [payout.source.scriptPubKeyHex,payout.destinationScriptPubKeyHex].every(value => typeof value === 'string' && /^(?:[0-9a-f]{2})+$/u.test(value)) &&
    payout.source.scriptPubKeyHex !== payout.destinationScriptPubKeyHex &&
    payout.sourceAnchor?.txid === payout.source.txid && payout.cashoutAnchor?.txid === payout.txid &&
    [payout.sourceAnchor,payout.cashoutAnchor].every(anchor => /^[0-9a-f]{64}$/u.test(anchor.blockHash) &&
      Number.isSafeInteger(anchor.height) && anchor.height > 0 && Number.isSafeInteger(anchor.confirmations) && anchor.confirmations > 0) &&
    payout.omittedParticipantRefund === true && payout.restoredOwnerKit === true &&
    payout.externalNativeDestinationBackedUp === true && payout.exactOwnerSignatureVerified === true,
  'completed V3 Signet evidence lacks the exact omitted-party restored owner cash-out and both active-chain anchors');
}
const custody = live.durableCustodyEvidence;
assert(custody?.version === 1 && custody.independentRollbackAnchorVerified === true && custody.allRequiredCustodyBytesHashVerified === true &&
  custody.independentlyRestoredCasesBeforeFunding === 19 && custody.actualNativeWalletRestoredSignatures === 83 &&
  custody.allNativeSignaturesBindExactRunAndBackup === true && custody.persistentStorageRequired === true && custody.wholeDiskLossProtectionClaimed === false &&
  [custody.checkpointDigest, custody.journalIdentityDigest, custody.nativeWalletBackupSha256, custody.nativeWalletProofSha256]
    .every(value => typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value)) &&
  Array.isArray(custody.independentCaseCheckpoints) && custody.independentCaseCheckpoints.length === 19 &&
  new Set(custody.independentCaseCheckpoints).size === 19 && custody.independentCaseCheckpoints.every((value: string) => /^[0-9a-f]{64}$/u.test(value)),
  'completed Signet evidence lacks current complete persistent custody and independently restored native and participant keys');
assert.equal(commitmentDigest(presignedDomain(protocol, 'verified-live-lifecycle'), liveBody), liveDigest);
assert.equal(presignedSourceDigest(), sourceDigest, 'source changed during final acceptance assembly');

const executions = (ids: string[]) => ids.map(id => {
  const execution = local.commands.find(item => item.command.id === id); assert(execution, `required executed command ${id} is missing`);
  return { id, executionDigest: execution.executionDigest };
});
const liveCommand = protocol === PRESIGNED_PROTOCOL_V3 ? 'presigned-live-lifecycle-v3-regtest' : 'presigned-live-lifecycle-regtest';
const databaseCommand = protocol === PRESIGNED_PROTOCOL_V3 ? 'database-v3-all' : 'database-v2-all';
const v3CoreCommands = protocol === PRESIGNED_PROTOCOL_V3 ? ['presigned-core-v3-recovery'] : [];
const cashoutCoreCommands = protocol === PRESIGNED_PROTOCOL_V3 ? ['presigned-core-cashout'] : [];
const fileExecutions = (files: string[]) => executions(files.flatMap(file => {
  const matches = local.commands.filter(item => item.command.args.at(-1) === file);
  assert(matches.length === 2 && matches.some(item => item.command.network === 'signet') && matches.some(item => item.command.network === 'mainnet'),
    `missing actual both-network executions for ${file}`);
  return matches.map(item => item.command.id);
}));
const dossiers: Partial<Record<typeof PRESIGNED_V3_RELEASE_CHECKS[number], unknown>> = {
  'exact-graph-and-nine-exits-both-network-formats': { sourceDigest,
    commands: local.commands.filter(item => item.command.category === 'cryptographic' || item.command.category === 'typecheck').map(item => item.executionDigest) },
  'core-six-exit-orders-cooperative-recovery-final-sweeps': executions(['presigned-core-acceptance', 'presigned-core-spends', liveCommand, ...v3CoreCommands, ...cashoutCoreCommands]),
  'core-hostile-witnesses-and-transaction-mutations': executions(['presigned-core-acceptance', 'presigned-core-spends', 'presigned-core-observed-witnesses', ...v3CoreCommands, ...cashoutCoreCommands]),
  'core-real-rolling-fee-floor-truc-and-child-replacement': executions(['presigned-core-fees', 'presigned-core-funding-fees', 'presigned-core-spend-fees', liveCommand, 'offline-full']),
  'core-database-restart-reorganization-and-broadcast-races': executions([databaseCommand, 'presigned-core-observed-witnesses',
    'presigned-wallet-restore-verification', liveCommand, ...v3CoreCommands]),
  'optimized-browser-three-participants-two-prf-passkeys': { sourceDigest, signetImage, mainnetImage,
    local: executions(['optimized-browser']), mainnetScope: 'full pre-funding custody and refusal without actual separate release',
    signetScope: 'full game and fee execution; Bitcoin facts bridged from isolated Core' },
  'provider-free-offline-recovery-browser': { offlineUtilityDigest: utilityDigest, commands: executions(['offline-build', 'offline-full']) },
  'legacy-protocol-boundary-and-funding-intent-restart': executions(['legacy-unit-signet', 'legacy-unit-mainnet', 'database-v2-all', 'optimized-browser']),
  'real-default-signet-lifecycle': live,
};
if (protocol === PRESIGNED_PROTOCOL_V3) Object.assign(dossiers, {
  'fixed-refund-four-rounds-all-nine-trigger-quorums': { core: executions(v3CoreCommands), live,
    graph: fileExecutions(['src/presigned/fixed-recovery-acceptance.ts']) },
  'fresh-colluder-signatures-no-unrestricted-tree-bypass': { core: executions(v3CoreCommands),
    graph: fileExecutions(['src/presigned/fixed-recovery-acceptance.ts']) },
  'twenty-one-setup-signatures-before-funding-and-restoration': { database: executions([databaseCommand]),
    browser: executions(['optimized-browser']), graph: fileExecutions(['src/presigned/fixed-recovery-acceptance.ts']), live },
  'v3-server-independent-missing-participant-recovery': { browser: executions(['offline-full']),
    portable: fileExecutions(['src/presigned/v3-offline-acceptance.ts', 'src/presigned/v3-offline-merge-acceptance.ts']), utilityDigest,
    ownedPayoutCashout: { pure: fileExecutions(['src/presigned/cashout-acceptance.ts']), core: executions(cashoutCoreCommands),
      browser: executions(['optimized-browser']), offline: executions(['offline-full']), database: executions([databaseCommand]) } },
});
const dossierDirectory = mkdtempSync('/tmp/btc-presigned-release-evidence.');
const evidence = presignedReleaseChecks(protocol).map(check => {
  const dossier = dossiers[check]; assert(dossier, `required executable evidence category ${check} is missing`);
  writeAcceptanceJson(`${dossierDirectory}/${check}.json`, dossier);
  return { check, artifactDigest: commitmentDigest(presignedDomain(protocol, 'acceptance-category'), { check, dossier }) };
});
const body: Omit<PresignedAcceptanceReceipt, 'receiptDigest'> = { version: presignedVersion(protocol), protocol,
  kind: protocol === PRESIGNED_PROTOCOL_V3 ? 'presigned-v3-executable-acceptance' : 'presigned-v2-executable-acceptance', createdAt: new Date().toISOString(), sourceDigest,
  testedImageManifestDigest: (network === 'mainnet' ? mainnetImage : signetImage).testedImageManifestDigest,
  offlineUtilityDigest: utilityDigest, physicalPasskeys: 'deferred-to-friends-onboarding', evidence, liveSignetReceiptDigest: liveDigest };
const receipt = validatePresignedAcceptanceReceipt({ ...body,
  receiptDigest: commitmentDigest(presignedDomain(protocol, 'executable-acceptance'), body) });
writeAcceptanceJson(output, receipt);
console.log(JSON.stringify({ passed: true, receiptDigest: receipt.receiptDigest, protocol, network, sourceDigest,
  testedImageManifestDigest: receipt.testedImageManifestDigest, evidence: dossierDirectory,
  physicalPasskeys: 'deferred-to-friends-onboarding', fundingAuthorized: false, imagePublished: false }));
