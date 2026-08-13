import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditSpecState, type AuditCheck } from './audit.js';
import { PARTICIPANTS } from './config.js';
import {
  BITCOIN_CORE_CHAIN,
  BITCOIN_NETWORK_NAME,
  MAINNET_GENESIS_HASH,
} from './network.js';
import { createDemoState } from './vault.js';
import { EXPECTED_MIGRATION_FILES } from '../web/lib/migrations.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const checks: AuditCheck[] = [];

function record(name: string, assertion: () => void): void {
  try {
    assertion();
    checks.push({ name, ok: true });
  } catch (error) {
    checks.push({
      name,
      ok: false,
      details: error instanceof Error ? error.message : String(error),
    });
  }
}

record('the product network is Bitcoin mainnet everywhere at the root boundary', () => {
  assert.equal(BITCOIN_NETWORK_NAME, 'mainnet');
  assert.equal(BITCOIN_CORE_CHAIN, 'main');
  assert.equal(
    MAINNET_GENESIS_HASH,
    '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f',
  );
});

record('the semantic vault audit preserves the round game instead of a static threshold vault', () => {
  const report = auditSpecState(createDemoState());
  assert.equal(report.passed, true, report.checks.filter((item) => !item.ok).map((item) => item.name).join('; '));
  assert.equal(report.checks.length >= 24, true, 'semantic audit unexpectedly lost coverage');
});

record('the fixed product roster is exactly three independent participant seats', () => {
  assert.deepEqual(PARTICIPANTS.map((participant) => participant.id), ['alice', 'bob', 'carol']);
});

record('the user-facing session, signing, custody, funding, observation, and broadcast routes exist', () => {
  for (const path of [
    'app/api/session/logout/route.ts',
    'app/api/passkeys/register/options/route.ts',
    'app/api/passkeys/recovery/register/options/route.ts',
    'app/api/sigbash/provision/register/route.ts',
    'app/api/sigbash/readiness/finish/route.ts',
    'app/api/roster/confirm/finish/route.ts',
    'app/api/vault/funding/input/finish/route.ts',
    'app/api/vault/funding/signature/finish/route.ts',
    'app/api/vault/funding/final-approval/finish/route.ts',
    'app/api/vault/funding/restart/finish/route.ts',
    'app/api/vault/proposals/cooperative-contribution/route.ts',
    'app/api/vault/proposals/finalize-solo/route.ts',
    'app/api/vault/proposals/recovery-contribution/route.ts',
    'app/api/vault/broadcast/finish/route.ts',
  ]) {
    assert.equal(existsSync(resolve(root, path)), true, `missing product route ${path}`);
  }
});

record('initial funding has no browser-accessible broadcast route', () => {
  const routes = routeFiles(resolve(root, 'app/api'));
  const fundingBroadcastRoutes = routes.filter((path) =>
    /(?:funding.*broadcast|broadcast.*funding)/u.test(path.replaceAll('\\', '/')),
  );
  assert.deepEqual(fundingBroadcastRoutes, []);
});

record('the private funding command is bound to protected live-proof and funding-release artifacts', () => {
  const source = readFileSync(resolve(root, 'web/scripts/broadcast-funding.ts'), 'utf8');
  const release = readFileSync(resolve(root, 'web/scripts/release-status.ts'), 'utf8');
  const artifact = readFileSync(resolve(root, 'src/funding-release-report.ts'), 'utf8');
  assert.match(source, /readProtectedLiveSigbashProofReceipt/u);
  assert.match(source, /LIVE_SIGBASH_MAINNET_PROOF_DIGEST/u);
  assert.match(source, /FUNDING_RELEASE_REPORT_DIGEST/u);
  assert.match(source, /readProtectedFundingReleaseReport/u);
  assert.match(source, /DEPLOYED_IMAGE_MANIFEST_DIGEST/u);
  assert.match(release, /DEPLOYED_IMAGE_MANIFEST_DIGEST/u);
  assert.match(artifact, /deployedImageManifestDigest/u);
  assert.match(source, /expectedFinalTxid/u);
  assert.match(source, /submitPasskeyApprovedFunding/u);
});

record('live Sigbash setup stores a protected recovery kit before its public checkpoint', () => {
  const source = readFileSync(resolve(root, 'src/cli-main.ts'), 'utf8');
  const sdkSurface = readFileSync(resolve(root, 'src/sigbash.ts'), 'utf8');
  const journal = readFileSync(resolve(root, 'src/sigbash-recovery-journal.ts'), 'utf8');
  const exportAt = source.indexOf('const recoveryKit = await client.exportRecoveryKit');
  const recoveryAt = source.indexOf('appendSigbashRecoveryRecord(recoveryJournalPath');
  const checkpointAt = source.indexOf('appendProtectedFile(checkpointPath');
  assert.match(sdkSurface, /listKeys\(\)/u);
  assert.match(sdkSurface, /exportRecoveryKit/u);
  assert.match(source, /findMatchingSigbashKey\(listed, poetPolicy, NETWORK\)/u);
  assert.match(source, /has no matching protected recovery kit/u);
  assert.equal(exportAt >= 0 && recoveryAt > exportAt && checkpointAt > recoveryAt, true);
  assert.match(journal, /O_NOFOLLOW/u);
  assert.match(journal, /fsyncSync/u);
  assert.match(journal, /input\.network !== 'mainnet'/u);
});

record('the funding release requires executable production database restore evidence', () => {
  const packageJson = readFileSync(resolve(root, 'package.json'), 'utf8');
  const verifier = readFileSync(resolve(root, 'web/scripts/verify-database-restore.ts'), 'utf8');
  const release = readFileSync(resolve(root, 'web/scripts/release-status.ts'), 'utf8');
  assert.match(packageJson, /web:verify-database-restore/u);
  assert.match(verifier, /captureDatabaseSnapshot/u);
  assert.match(verifier, /RESTORED_DATABASE_URL/u);
  assert.match(verifier, /writeProtectedFile/u);
  assert.match(release, /readProtectedDatabaseRestoreReceipt/u);
  assert.match(release, /DATABASE_RESTORE_RECEIPT_DIGEST/u);
});

record('the private watcher continuously reconciles confirmed mainnet block anchors', () => {
  const runtime = readFileSync(resolve(root, 'web/lib/server/vault-runtime-store.ts'), 'utf8');
  const reconciliation = readFileSync(resolve(root, 'web/lib/server/chain-reconciliation.ts'), 'utf8');
  const rollback = readFileSync(resolve(root, 'web/lib/server/chain-reorganization-store.ts'), 'utf8');
  const watcher = readFileSync(resolve(root, 'web/scripts/watch-chain.ts'), 'utf8');
  const lease = readFileSync(resolve(root, 'web/lib/server/watcher-lease.ts'), 'utf8');
  assert.match(runtime, /reconcileConfirmedChainState/u);
  assert.match(runtime, /getBlockStatus/u);
  assert.match(reconciliation, /rollbackConfirmedFunding/u);
  assert.match(reconciliation, /rollbackConfirmedVaultTransition/u);
  assert.match(reconciliation, /isBitcoinTransactionNotFound/u);
  assert.match(rollback, /chain_reorganization_events/u);
  assert.match(rollback, /status = 'orphaned'/u);
  assert.match(rollback, /status = 'current', spent_by_txid = NULL/u);
  assert.match(watcher, /withChainWatcherLease/u);
  assert.match(lease, /pg_try_advisory_lock/u);
  assert.match(lease, /pg_advisory_unlock/u);
});

record('the release surface includes an actual Bitcoin Core reorganization drill', () => {
  const packageJson = readFileSync(resolve(root, 'package.json'), 'utf8');
  const runner = readFileSync(resolve(root, 'scripts/run-bitcoin-core-reorganization-drill.sh'), 'utf8');
  const acceptance = readFileSync(
    resolve(root, 'web/tests/bitcoin-core-reorganization-db-acceptance.ts'),
    'utf8',
  );
  assert.match(packageJson, /web:test:core-reorg/u);
  assert.match(runner, /CORE_SHA256/u);
  assert.match(runner, /-regtest/u);
  assert.match(acceptance, /invalidateblock/u);
  assert.match(acceptance, /controlled backend transport failure/u);
  assert.match(acceptance, /reconcileConfirmedChainState/u);
});

record('the release surface exercises the optimized standalone browser product', () => {
  const packageJson = readFileSync(resolve(root, 'package.json'), 'utf8');
  const runner = readFileSync(
    resolve(root, 'scripts/run-production-browser-acceptance.sh'),
    'utf8',
  );
  assert.match(packageJson, /web:test:browser:production/u);
  assert.match(runner, /npm run web:build/u);
  assert.match(runner, /\.next\/standalone\/server\.js/u);
  assert.match(runner, /cooperative-musig2\.spec\.ts/u);
  assert.match(runner, /recovery-final-sweep\.spec\.ts/u);
  assert.match(runner, /funding-wallet\.spec\.ts/u);
  assert.match(runner, /passkey-prf\.spec\.ts/u);
  assert.match(runner, /never live Sigbash, real-wallet, or funding evidence/u);
});

record('the release surface provides a fail-closed exact-container acceptance command', () => {
  const packageJson = readFileSync(resolve(root, 'package.json'), 'utf8');
  const runner = readFileSync(
    resolve(root, 'scripts/run-production-browser-acceptance.sh'),
    'utf8',
  );
  const dockerfile = readFileSync(resolve(root, 'Dockerfile'), 'utf8');
  const dockerignore = readFileSync(resolve(root, '.dockerignore'), 'utf8');
  assert.match(packageJson, /web:test:browser:container/u);
  assert.match(runner, /CONTAINER_ACCEPTANCE/u);
  assert.match(runner, /build --pull --tag/u);
  assert.match(runner, /image inspect --format/u);
  assert.match(runner, /run --rm --name/u);
  assert.match(dockerfile, /FROM node:22\.23\.2-bookworm-slim@sha256:[0-9a-f]{64}/u);
  assert.match(dockerfile, /npm ci --omit=dev/u);
  assert.match(dockerfile, /\.next\/standalone/u);
  assert.match(dockerfile, /USER node/u);
  assert.match(dockerfile, /\/api\/health\/ready/u);
  assert.match(dockerignore, /^\.env\.\*$/mu);
  assert.match(dockerignore, /^live-run$/mu);
});

record('the production Sigbash solo-signing and persistence boundaries have isolated acceptance coverage', () => {
  const packageJson = readFileSync(resolve(root, 'package.json'), 'utf8');
  const acceptance = readFileSync(
    resolve(root, 'web/tests/solo-signing-acceptance.ts'),
    'utf8',
  );
  const databaseAcceptance = readFileSync(
    resolve(root, 'web/tests/solo-finalization-db-acceptance.ts'),
    'utf8',
  );
  assert.match(packageJson, /tsx web\/tests\/solo-signing-acceptance\.ts/u);
  assert.match(packageJson, /tsx web\/tests\/solo-finalization-db-acceptance\.ts/u);
  assert.match(acceptance, /signAuthorizedSoloWithdrawal/u);
  assert.match(acceptance, /externalSigbashContacted: false/u);
  assert.match(acceptance, /liveMainnetEvidence: false/u);
  assert.match(acceptance, /rejects a signer response that mutates the committed transaction/u);
  assert.match(databaseAcceptance, /finalizeStoredSoloProposal/u);
  assert.match(databaseAcceptance, /externalSigbashContacted: false/u);
  assert.match(databaseAcceptance, /liveMainnetEvidence: false/u);
  assert.match(databaseAcceptance, /cannot be replayed through the finalization boundary/u);
});

record('every browser Sigbash flow disposes the SDK copy of private-key material', () => {
  const client = readFileSync(resolve(root, 'web/lib/client/sigbash-browser.ts'), 'utf8');
  assert.match(client, /export function disposeSigbashBrowserClient/u);
  assert.match(client, /client\.disconnect\(\)/u);
  assert.match(client, /client\.dispose\(\)/u);
  for (const path of [
    'web/components/sigbash-custody-setup.tsx',
    'web/components/sigbash-readiness-proof.tsx',
    'web/components/vault-runtime-panel.tsx',
  ]) {
    const source = readFileSync(resolve(root, path), 'utf8');
    assert.match(source, /disposeSigbashBrowserClient\(client\)/u, `${path} skips Sigbash SDK disposal`);
    assert.doesNotMatch(source, /client\?\.disconnect\(\)/u, `${path} only disconnects Sigbash sockets`);
  }
});

record('every command-line Sigbash adapter action owns and disposes its live client', () => {
  const adapter = readFileSync(resolve(root, 'src/sigbash.ts'), 'utf8');
  const cli = readFileSync(resolve(root, 'src/cli-main.ts'), 'utf8');
  assert.match(adapter, /export async function withSigbashAdapter/u);
  assert.match(adapter, /finally \{\s*adapter\.dispose\(\);/u);
  assert.match(adapter, /export function disposeSigbashLiveClient/u);
  assert.match(adapter, /client\.disconnect\?\.\(\)/u);
  assert.match(adapter, /client\.dispose\?\.\(\)/u);
  assert.doesNotMatch(cli, /createSigbashAdapter/u, 'CLI bypasses one-action adapter ownership');
  assert.doesNotMatch(cli, /client\.disconnect\?\.\(\)/u, 'CLI bypasses shared live-client disposal');
  assert.match(cli, /withSigbashAdapter/u);
  assert.match(cli, /disposeSigbashLiveClient\(client\)/u);
});

record('every required PostgreSQL product-state migration is present', () => {
  const actual = readdirSync(resolve(root, 'db/migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  assert.deepEqual(actual, [...EXPECTED_MIGRATION_FILES].sort());
});

record('the authoritative spec rejects signet, demos as completion, and static 3-of-3 substitution', () => {
  const specification = readFileSync(resolve(root, 'spec.md'), 'utf8');
  assert.match(specification, /authoritative product contract/u);
  assert.match(specification, /mainnet-only/u);
  assert.match(specification, /static 3-of-3 vault/u);
  assert.match(specification, /never evidence that the product is deployable/u);
  assert.doesNotMatch(specification, /Goal:\*\* build a working \*\*demo/u);
});

const passed = checks.every((item) => item.ok);
console.log(JSON.stringify({
  title: 'mainnet multiplayer-vault product conformance',
  localConformancePassed: passed,
  externalReleaseEvidenceEvaluated: false,
  deploymentAuthorized: false,
  fundingAuthorized: false,
  checks,
  remainingExternalGate:
    'Run and independently review the real protected Sigbash mainnet proof, then complete the physical-device, wallet, database, Bitcoin Core, and deployment drills.',
}, null, 2));

if (!passed) process.exitCode = 1;

function routeFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) found.push(...routeFiles(path));
    if (entry.isFile() && entry.name === 'route.ts') found.push(relative(root, path));
  }
  return found;
}
