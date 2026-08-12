import { randomBytes, createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import postgres from 'postgres';
import { assertReviewedNodeRuntime } from '../../src/runtime-version';
import { assertDatabaseUrl } from '../lib/database-config';
import { webConfig } from '../lib/server/config';

assertReviewedNodeRuntime();
if (existsSync('.env.local')) loadEnvFile('.env.local');
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
  let vaultId = args['vault-id'];
  if (!vaultId) {
    const name = required(args, 'vault-name');
    const rows = await sql<Array<{ id: string }>>`
      INSERT INTO vaults (name) VALUES (${name}) RETURNING id
    `;
    vaultId = rows[0]!.id;
  }
  const rows = await sql<Array<{ id: string }>>`
    INSERT INTO invites (
      vault_id, participant_id, token_hash, suggested_name, expires_at
    ) VALUES (
      ${vaultId}::uuid, ${participantId}, ${tokenHash}, ${args.name || null},
      now() + (${hours} * interval '1 hour')
    )
    RETURNING id
  `;
  console.log(JSON.stringify({
    inviteId: rows[0]!.id,
    vaultId,
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
