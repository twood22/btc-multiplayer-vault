/** Only actual complete retained runs plus a fresh read-only Signet audit can
 * produce this software receipt. It grants no deployment or spending authority. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { assertReviewedNodeRuntime } from '../src/runtime-version.js';
import { PRESIGNED_RELEASE_CHECKS, validatePresignedAcceptanceReceipt, type PresignedAcceptanceReceipt } from '../src/presigned/release.js';
import { commitmentDigest, genesisHash } from '../src/presigned/validation.js';
import { acceptanceEnvironment, parseAcceptanceJson, validateLocalAcceptanceRun, writeAcceptanceJson } from './lib/presigned-acceptance-run.js';
import { validateRetainedImageEvidence } from './lib/presigned-image-evidence.js';
import { presignedSourceDigest } from './presigned-build-identity.mjs';

process.umask(0o077); assertReviewedNodeRuntime();
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
const local = validateLocalAcceptanceRun(flags.get('--local-run')!, sourceDigest, 'local');
const signetImage = await validateRetainedImageEvidence(flags.get('--signet-image')!, sourceDigest, 'signet');
const mainnetImage = await validateRetainedImageEvidence(flags.get('--mainnet-image')!, sourceDigest, 'mainnet');
const utilityDigest = createHash('sha256').update(readFileSync('public/offline/presigned-recovery.html')).digest('hex');
assert(local.offlineUtilityDigest === utilityDigest && signetImage.offlineUtilityDigest === utilityDigest && mainnetImage.offlineUtilityDigest === utilityDigest,
  'local tests and both OCI images must contain the same fully tested offline artifact');

// Execute the real verifier now; do not accept a caller-supplied passed flag or
// a historical JSON file that has never been compared to the actual chain.
const stdout: Buffer[] = []; let length = 0;
const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/presigned-signet-lifecycle.mts', 'verify', flags.get('--signet-control')!],
  { cwd: process.cwd(), env: acceptanceEnvironment('signet'), stdio: ['ignore', 'pipe', 'ignore'] });
child.stdout.on('data', (chunk: Buffer) => { length += chunk.length; if (length > 2 * 1024 * 1024) child.kill('SIGTERM'); else stdout.push(Buffer.from(chunk)); });
const code = await new Promise<number | null>((resolveExit, reject) => {
  child.once('error', () => reject(new Error('actual read-only default-Signet verifier could not start')));
  child.once('close', resolveExit);
});
assert(code === 0 && length <= 2 * 1024 * 1024, 'actual completed default-Signet verification failed; no acceptance receipt was created');
const live = parseAcceptanceJson(Buffer.concat(stdout)) as any;
const { receiptDigest: liveDigest, ...liveBody } = live;
assert(live.version === 2 && live.protocol === 'presigned-graph-v2' && live.kind === 'presigned-v2-verified-live-lifecycle' &&
  live.sourceDigest === sourceDigest && live.chain === 'default-Signet' && live.actualGenesisHash === genesisHash('signet') &&
  live.complete === true && live.realDefaultSignetVerified === true && live.soloOrderingsConfirmed === 6 && live.cooperativeRoundsConfirmed === 4 &&
  live.recoverySubsetsConfirmed === 9 && live.feeFamiliesConfirmed === 5 && live.restoredKits === 57 && live.hostileRejections === 80 &&
  live.everyPayoutRefundAndSponsorChangeVerified === true && live.freshRandomParticipantKeys === true && live.externalWalletKeysExported === false &&
  live.physicalPasskeysVerified === false && live.liveBrowserPasskeysVerified === false && live.fundingAuthorized === false);
assert.equal(commitmentDigest('vault/presigned-graph-v2/verified-live-lifecycle', liveBody), liveDigest);
assert.equal(presignedSourceDigest(), sourceDigest, 'source changed during final acceptance assembly');

const executions = (ids: string[]) => ids.map(id => {
  const execution = local.commands.find(item => item.command.id === id); assert(execution, `required executed command ${id} is missing`);
  return { id, executionDigest: execution.executionDigest };
});
const dossiers: Record<typeof PRESIGNED_RELEASE_CHECKS[number], unknown> = {
  'exact-graph-and-nine-exits-both-network-formats': { sourceDigest,
    commands: local.commands.filter(item => item.command.category === 'cryptographic' || item.command.category === 'typecheck').map(item => item.executionDigest) },
  'core-six-exit-orders-cooperative-recovery-final-sweeps': executions(['presigned-core-acceptance', 'presigned-core-spends', 'presigned-live-lifecycle-regtest']),
  'core-hostile-witnesses-and-transaction-mutations': executions(['presigned-core-acceptance', 'presigned-core-spends', 'presigned-core-observed-witnesses']),
  'core-real-rolling-fee-floor-truc-and-child-replacement': executions(['presigned-core-fees', 'presigned-core-funding-fees', 'presigned-core-spend-fees']),
  'core-database-restart-reorganization-and-broadcast-races': executions(['database-v2-all', 'presigned-core-observed-witnesses', 'presigned-live-lifecycle-regtest']),
  'optimized-browser-three-participants-two-prf-passkeys': { sourceDigest, signetImage, mainnetImage,
    local: executions(['optimized-browser']), mainnetScope: 'full pre-funding custody and refusal without actual separate release',
    signetScope: 'full game and fee execution; Bitcoin facts bridged from isolated Core' },
  'provider-free-offline-recovery-browser': { offlineUtilityDigest: utilityDigest, commands: executions(['offline-build', 'offline-full']) },
  'legacy-protocol-boundary-and-funding-intent-restart': executions(['legacy-unit-signet', 'legacy-unit-mainnet', 'database-v2-all', 'optimized-browser']),
  'real-default-signet-lifecycle': live,
};
const dossierDirectory = mkdtempSync('/tmp/btc-presigned-release-evidence.');
const evidence = PRESIGNED_RELEASE_CHECKS.map(check => {
  const dossier = dossiers[check]; writeAcceptanceJson(`${dossierDirectory}/${check}.json`, dossier);
  return { check, artifactDigest: commitmentDigest('vault/presigned-graph-v2/acceptance-category', { check, dossier }) };
});
const body: Omit<PresignedAcceptanceReceipt, 'receiptDigest'> = { version: 2, protocol: 'presigned-graph-v2',
  kind: 'presigned-v2-executable-acceptance', createdAt: new Date().toISOString(), sourceDigest,
  testedImageManifestDigest: (network === 'mainnet' ? mainnetImage : signetImage).testedImageManifestDigest,
  offlineUtilityDigest: utilityDigest, physicalPasskeys: 'deferred-to-friends-onboarding', evidence, liveSignetReceiptDigest: liveDigest };
const receipt = validatePresignedAcceptanceReceipt({ ...body,
  receiptDigest: commitmentDigest('vault/presigned-graph-v2/executable-acceptance', body) });
writeAcceptanceJson(output, receipt);
console.log(JSON.stringify({ passed: true, receiptDigest: receipt.receiptDigest, network, sourceDigest,
  testedImageManifestDigest: receipt.testedImageManifestDigest, evidence: dossierDirectory,
  physicalPasskeys: 'deferred-to-friends-onboarding', fundingAuthorized: false, imagePublished: false }));
