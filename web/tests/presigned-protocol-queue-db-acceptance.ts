import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { BITCOIN_NETWORK_NAME } from '../../src/network.js';
import { newPresignedCeremony, type PresignedFundingEpoch } from '../../src/presigned/ceremony.js';
import { createPresignedFixture } from '../../src/presigned/fixtures.js';
import { FIXED_RECOVERY_POLICY, PRESIGNED_PROTOCOL, PRESIGNED_PROTOCOL_V3 } from '../../src/presigned/types.js';
import { commitmentDigest, presignedDomain } from '../../src/presigned/validation.js';
import { EXPECTED_MIGRATION_FILES } from '../lib/migrations.js';
import { closeDatabase } from '../lib/server/db.js';
import { presignedBroadcastEnabled, retryPresignedBroadcasts, type PresignedBroadcastDependencies } from '../lib/server/presigned-broadcast-store.js';
import { retryPresignedFeePackages, type PresignedFeeDependencies } from '../lib/server/presigned-fee-store.js';

// Mainnet ADDRESS FORMAT only. Public, deliberately incomplete authority rows
// prove queue selection against real migrations, never a mainnet spend.
assert.equal(BITCOIN_NETWORK_NAME, 'mainnet');
assert(process.env.DATABASE_URL);
const endpoint = new URL(process.env.DATABASE_URL);
assert(['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) && /(?:test|acceptance)/u.test(endpoint.pathname));
const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
const json = (value: unknown): any => JSON.parse(JSON.stringify(value));
const flags = ['PRESIGNED_V2_BROADCAST_NETWORK', 'PRESIGNED_V2_MAINNET_AUTHORIZATION', 'PRESIGNED_V3_MAINNET_AUTHORIZATION'] as const;
const previous = Object.fromEntries(flags.map(name => [name, process.env[name]]));
let rpcCalls = 0;
const forbidden = async () => { rpcCalls++; throw new Error('This queue drill must not access Bitcoin or any network provider'); };
const backend = new Proxy({}, { get: () => forbidden }) as PresignedBroadcastDependencies['backend'];
const dependencies = { backend, rpc: forbidden, requiredConfirmations: 1,
  assertEnabled: (protocol: Parameters<typeof presignedBroadcastEnabled>[0]) => assert(presignedBroadcastEnabled(protocol)) };
try {
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations(version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
  for (const file of EXPECTED_MIGRATION_FILES) {
    if (!(await sql`SELECT 1 FROM schema_migrations WHERE version = ${file.slice(0, -4)}`).length)
      await sql.unsafe(readFileSync(resolve('db/migrations', file), 'utf8'));
  }
  process.env.PRESIGNED_V2_BROADCAST_NETWORK = 'mainnet';
  delete process.env.PRESIGNED_V2_MAINNET_AUTHORIZATION;
  process.env.PRESIGNED_V3_MAINNET_AUTHORIZATION = 'separately-approved-mainnet-spending';
  for (const protocol of [PRESIGNED_PROTOCOL, PRESIGNED_PROTOCOL_V3]) {
    const fixture = createPresignedFixture({ network: 'mainnet', protocol });
    const vaultId = randomUUID(); const epochId = randomUUID(); const userId = randomUUID();
    const v3 = protocol === PRESIGNED_PROTOCOL_V3;
    const state = newPresignedCeremony(vaultId, { network: 'mainnet', genesisHash: fixture.roster.genesisHash,
      economics: fixture.roster.economics, feePolicy: fixture.roster.feePolicy, fundingFeeSats: 600,
      ...(v3 ? { protocol, recoveryPolicy: FIXED_RECOVERY_POLICY } : {}) });
    const epoch: PresignedFundingEpoch = { epochId, status: 'collecting', inputs: [], graph: null,
      preauthorizations: [], backups: [], walletSigningStarted: [], signatures: [], finalization: null,
      fundingApprovals: [], restartApprovals: [], ...(v3 ? { recoveryAuthorizations: [] } : {}) };
    state.epochs = [epoch];
    await sql`INSERT INTO vaults(id, name, protocol) VALUES (${vaultId}, 'Isolated protocol queue regression', ${protocol})`;
    await sql`INSERT INTO users(id, display_name) VALUES (${userId}, 'Public queue fixture')`;
    await sql`INSERT INTO presigned_ceremonies(vault_id, protocol, settings_json, settings_digest, state_json, state_digest)
      VALUES (${vaultId}, ${protocol}, ${sql.json(json(state.settings))}, ${Buffer.from(state.settingsDigest, 'hex')},
        ${sql.json(json(state))}, ${Buffer.from(commitmentDigest(presignedDomain(protocol, 'ceremony/state'), state), 'hex')})`;
    await sql`INSERT INTO presigned_funding_epochs(epoch_id, vault_id, protocol, ordinal, status, snapshot_json, snapshot_digest)
      VALUES (${epochId}, ${vaultId}, ${protocol}, 1, 'collecting', ${sql.json(json(epoch))},
        ${Buffer.from(commitmentDigest(presignedDomain(protocol, 'ceremony/epoch'), epoch), 'hex')})`;
    for (let index = 0; index < (v3 ? 1 : 100); index++) {
      const timestamp = v3 ? '2025-01-01' : '2000-01-01';
      await sql`INSERT INTO presigned_broadcast_intents(vault_id, protocol, epoch_id, kind, authorization_digest,
        transaction_json, txids_json, status, created_at, updated_at)
        VALUES (${vaultId}, ${protocol}, ${epochId}, 'funding', ${randomBytes(32)}, '["00"]'::jsonb,
          '["00"]'::jsonb, 'accepted', ${timestamp}::timestamptz, ${timestamp}::timestamptz)`;
      await sql`INSERT INTO presigned_fee_packages(vault_id, protocol, epoch_id, user_id, participant_id,
        package_json, package_digest, status, created_at, updated_at)
        VALUES (${vaultId}, ${protocol}, ${epochId}, ${userId}, 'alice',
          ${sql.json({ version: state.version, protocol })}, ${randomBytes(32)}, 'accepted',
          ${timestamp}::timestamptz, ${timestamp}::timestamptz)`;
    }
  }
  const broadcasts = await retryPresignedBroadcasts(dependencies as PresignedBroadcastDependencies);
  const fees = await retryPresignedFeePackages(dependencies as PresignedFeeDependencies);
  assert.equal(broadcasts.results.length, 1, 'disabled historical V2 intents must not occupy the eligible V3 page');
  assert.equal(fees.results.length, 1, 'disabled historical V2 fee packages must not occupy the eligible V3 page');
  assert.equal(broadcasts.results[0]!.status, 'deferred');
  assert.equal(fees.results[0]!.status, 'deferred');
  for (const table of ['presigned_broadcast_intents', 'presigned_fee_packages']) {
    const rows = await sql.unsafe(`SELECT protocol, count(*)::int AS count, sum(attempt_count)::int AS attempts FROM ${table} GROUP BY protocol`);
    assert.deepEqual(rows.find(row => row.protocol === PRESIGNED_PROTOCOL), { protocol: PRESIGNED_PROTOCOL, count: 100, attempts: 0 });
    assert.deepEqual(rows.find(row => row.protocol === PRESIGNED_PROTOCOL_V3), { protocol: PRESIGNED_PROTOCOL_V3, count: 1, attempts: 1 });
  }
  assert.equal(rpcCalls, 0);
  console.log(JSON.stringify({ passed: true, protocol: PRESIGNED_PROTOCOL_V3, actualDatabase: 'disposable-loopback-PostgreSQL',
    disabledV2RowsPerQueue: 100, enabledV3RowsRetriedPerQueue: 1, rpcCalls, publicNetworkBroadcasts: 0,
    realMainnetAuthorizationGranted: false }));
} finally {
  for (const name of flags) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; }
  await closeDatabase(); await sql.end();
}
