import { randomBytes, createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import postgres from 'postgres';
import { assertReviewedNodeRuntime } from '../../src/runtime-version';
import { assertDatabaseUrl } from '../lib/database-config';
import { LEGACY_PROTOCOL, PRESIGNED_PROTOCOL } from '../../src/presigned/types';

assertReviewedNodeRuntime();
if (existsSync('.env.local')) loadEnvFile('.env.local');
// Network/economics modules must see the selected private environment before
// evaluating; changing environment after static imports would freeze defaults.
const { webConfig, fundingFeeSats } = await import('../lib/server/config');
const { newPresignedCeremony } = await import('../../src/presigned/ceremony');
const { commitmentDigest } = await import('../../src/presigned/validation');
const { BITCOIN_NETWORK_NAME, BITCOIN_GENESIS_HASH } = await import('../../src/network');
const { VAULT_ECONOMICS } = await import('../../src/config');
const args = parseArgs(process.argv.slice(2));
const participantId = required(args, 'participant');
if (!['alice', 'bob', 'carol'].includes(participantId)) {
  throw new Error('--participant must be alice, bob, or carol');
}
const url = assertDatabaseUrl(process.env.DATABASE_URL, {
  production: process.env.NODE_ENV === 'production',
});
const appOrigin = webConfig().appOrigin;
const hours = Number(args['expires-hours'] || 48);
if (!Number.isInteger(hours) || hours < 1 || hours > 168) {
  throw new Error('--expires-hours must be an integer from 1 to 168');
}
const token = randomBytes(32).toString('base64url');
const tokenHash = createHash('sha256').update(token).digest();
const sql = postgres(url, { max: 1 });
try {
  const created = await sql.begin(async tx => {
    let vaultId = args['vault-id'];
    let protocol = args.protocol;
    if (!vaultId) {
      if (![LEGACY_PROTOCOL, PRESIGNED_PROTOCOL].includes(protocol as typeof LEGACY_PROTOCOL)) {
        throw new Error('--protocol must explicitly name sigbash-v1 or presigned-graph-v2 for a new vault');
      }
      const rows = await tx<Array<{ id: string }>>`
        INSERT INTO vaults (name,protocol) VALUES (${required(args, 'vault-name')},${protocol!}) RETURNING id
      `;
      vaultId = rows[0]!.id;
      if (protocol === PRESIGNED_PROTOCOL) {
        const maxChildFeeSats = Number(args['max-child-fee-sats']);
        if (!Number.isSafeInteger(maxChildFeeSats) || maxChildFeeSats < 1 || maxChildFeeSats > 100_000_000) {
          throw new Error('new presigned vault requires explicit --max-child-fee-sats from 1 to 100000000');
        }
        if (!process.env.RECOVERY_DELAY_BLOCKS || !process.env.VAULT_DEPOSIT_SATS) {
          throw new Error('new presigned vault requires explicit VAULT_DEPOSIT_SATS and RECOVERY_DELAY_BLOCKS');
        }
        const state = newPresignedCeremony(vaultId, { network: BITCOIN_NETWORK_NAME, genesisHash: BITCOIN_GENESIS_HASH,
          economics: VAULT_ECONOMICS, feePolicy: { kind: 'confirmed-truc-payout-cpfp-v1', maxChildFeeSats },
          fundingFeeSats: fundingFeeSats() });
        await tx`INSERT INTO presigned_ceremonies(vault_id,settings_json,settings_digest,state_json,state_digest)
          VALUES (${vaultId}::uuid,${tx.json(state.settings as never)},${Buffer.from(state.settingsDigest,'hex')},
            ${tx.json(state as never)},${Buffer.from(commitmentDigest('vault/presigned-graph-v2/ceremony/state',state),'hex')})`;
      }
    } else {
      const rows = await tx<Array<{ protocol: string; status: string }>>`SELECT protocol,status FROM vaults WHERE id=${vaultId}::uuid FOR UPDATE`;
      if (rows.length !== 1 || rows[0]!.status !== 'setup') throw new Error('invites require an existing setup vault');
      if (protocol && protocol !== rows[0]!.protocol) throw new Error('requested protocol differs from immutable existing vault');
      protocol = rows[0]!.protocol;
      if (protocol === PRESIGNED_PROTOCOL && !(await tx`SELECT 1 FROM presigned_ceremonies WHERE vault_id=${vaultId}::uuid`).length) {
        throw new Error('existing presigned vault lacks immutable settings; do not infer them');
      }
    }
    const rows = await tx<Array<{ id: string }>>`
      INSERT INTO invites (vault_id,participant_id,token_hash,suggested_name,expires_at)
      VALUES (${vaultId}::uuid,${participantId},${tokenHash},${args.name || null},now()+(${hours}*interval '1 hour')) RETURNING id
    `;
    return { inviteId: rows[0]!.id, vaultId, protocol };
  });
  console.log(JSON.stringify({
    ...created,
    participantId,
    expiresInHours: hours,
    inviteUrl: `${appOrigin}/join/${token}`,
  }, null, 2));
} finally {
  await sql.end();
}

function parseArgs(values: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < values.length; index += 1) {
    const item = values[index]!;
    if (!item.startsWith('--')) continue;
    const value = values[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${item}`);
    parsed[item.slice(2)] = value;
    index += 1;
  }
  return parsed;
}

function required(values: Record<string, string>, key: string): string {
  const value = values[key];
  if (!value) throw new Error(`--${key} is required`);
  return value;
}
