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
  assert.match(source, /readProtectedLiveSigbashProofReceipt/u);
  assert.match(source, /LIVE_SIGBASH_MAINNET_PROOF_DIGEST/u);
  assert.match(source, /FUNDING_RELEASE_REPORT_DIGEST/u);
  assert.match(source, /readProtectedFundingReleaseReport/u);
  assert.match(source, /expectedFinalTxid/u);
  assert.match(source, /submitPasskeyApprovedFunding/u);
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
