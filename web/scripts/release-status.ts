import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import postgres from 'postgres';
import { getBlockchainInfo } from '../../src/bitcoin-rpc';

if (existsSync('.env.local')) loadEnvFile('.env.local');

interface Check { name: string; ok: boolean; detail?: string }
const checks: Check[] = [];
const manualGates = [
  'Each friend must complete setup and recovery with two real, distinct PRF-capable passkeys.',
  'Each friend must independently review the unanimous roster and tiny-mainnet economics.',
  'The selected production database backup and restore procedure must be exercised.',
  'Funding remains a separate explicit decision after this report passes.',
];

const nodeMajor = Number(process.versions.node.split('.')[0]);
checks.push(check('declared Node runtime is active', nodeMajor >= 22, `Node ${process.versions.node}`));

const rpId = process.env.WEBAUTHN_RP_ID;
const webauthnOrigin = parsedOrigin(process.env.WEBAUTHN_ORIGIN);
const appOrigin = parsedOrigin(process.env.APP_ORIGIN);
checks.push(check(
  'production WebAuthn origin and RP ID are explicit HTTPS values',
  Boolean(rpId && webauthnOrigin && appOrigin &&
    webauthnOrigin.protocol === 'https:' && appOrigin.protocol === 'https:' &&
    appOrigin.origin === webauthnOrigin.origin &&
    (webauthnOrigin.hostname === rpId || webauthnOrigin.hostname.endsWith(`.${rpId}`))),
));

const chainOrigins = (process.env.CHAIN_OBSERVATION_ORIGINS || '')
  .split(',')
  .filter(Boolean)
  .map(parsedOrigin);
checks.push(check(
  'at least one independent HTTPS chain-observation origin is explicit',
  Boolean(webauthnOrigin && chainOrigins.length > 0 && chainOrigins.every((origin) =>
    origin?.protocol === 'https:' && origin.origin !== webauthnOrigin.origin)),
  chainOrigins.length ? `${chainOrigins.length} configured origin(s)` : undefined,
));

const deposit = explicitInteger('VAULT_DEPOSIT_SATS');
const depositCap = explicitInteger('PRIVATE_BETA_MAX_DEPOSIT_SATS');
const recoveryDelay = explicitInteger('RECOVERY_DELAY_BLOCKS');
checks.push(check(
  'tiny-mainnet amount is explicit and within the private-beta cap',
  deposit !== null && depositCap !== null && deposit >= 10_000 && deposit <= depositCap,
  deposit === null || depositCap === null ? undefined : `${deposit} sats per participant; cap ${depositCap}`,
));
checks.push(check(
  'mainnet recovery delay is explicit and positive',
  recoveryDelay !== null && recoveryDelay > 0,
  recoveryDelay === null ? undefined : `${recoveryDelay} blocks`,
));

const sigbashServer = parsedOrigin(process.env.SIGBASH_SERVER_URL);
checks.push(check(
  'Sigbash service origin is an explicit credential-free HTTPS origin',
  Boolean(sigbashServer && sigbashServer.protocol === 'https:'),
));

await runtimePinCheck(
  'Sigbash WASM matches the pinned SHA-384',
  process.env.SIGBASH_WASM_URL || 'https://www.sigbash.com/sigbash.wasm',
  process.env.SIGBASH_WASM_SHA384,
);
await runtimePinCheck(
  'Sigbash Go loader matches the pinned SHA-384',
  process.env.SIGBASH_WASM_EXEC_URL || 'https://www.sigbash.com/wasm_exec.js',
  process.env.SIGBASH_WASM_EXEC_SHA384,
);

if (process.env.DATABASE_URL) {
  const databaseEndpoint = databaseEndpointCheck(process.env.DATABASE_URL);
  checks.push(check(
    'production database uses a non-local TLS endpoint',
    databaseEndpoint.ok,
    databaseEndpoint.detail,
  ));
  const sql = postgres(process.env.DATABASE_URL, { max: 1, connect_timeout: 10 });
  try {
    const version = await sql<Array<{ version: string }>>`SELECT version()`;
    checks.push(check('production database is PostgreSQL 16 or newer',
      /PostgreSQL (1[6-9]|[2-9][0-9])\./u.test(version[0]?.version || '')));
    const migrations = await sql<Array<{ version: string }>>`
      SELECT version FROM schema_migrations ORDER BY version
    `;
    const expectedMigrations = [
      '001_passkey_custody',
      '002_multi_passkey_recovery',
      '003_roster_ceremony',
      '004_sigbash_custody',
      '005_vault_runtime',
      '006_sigbash_readiness',
      '007_broadcast_approval',
      '008_security_rate_limits',
    ];
    checks.push(check(
      'all required database migrations are applied',
      JSON.stringify(migrations.map((row) => row.version)) === JSON.stringify(expectedMigrations),
      `${migrations.length}/${expectedMigrations.length} migrations`,
    ));
    const states = await sql<Array<{
      vaults: number;
      ready_vaults: number;
      members: number;
      recovery_ready_members: number;
      live_sigbash_keys: number;
      roster_confirmations: number;
      readiness_proofs: number;
      current_coins: number;
    }>>`
      SELECT
        (SELECT count(*)::integer FROM vaults) AS vaults,
        (SELECT count(*)::integer FROM vaults WHERE status = 'ready') AS ready_vaults,
        (SELECT count(*)::integer FROM vault_members) AS members,
        (SELECT count(*)::integer FROM (
          SELECT user_id FROM webauthn_credentials c
          JOIN passkey_envelopes e USING (credential_id)
          WHERE c.prf_enabled = true
          GROUP BY user_id HAVING count(DISTINCT c.credential_id) >= 2
        ) recovered) AS recovery_ready_members,
        (SELECT count(*)::integer FROM participant_sigbash_keys) AS live_sigbash_keys,
        (SELECT count(*)::integer FROM roster_confirmations) AS roster_confirmations,
        (SELECT count(*)::integer FROM participant_sigbash_readiness_proofs) AS readiness_proofs,
        (SELECT count(*)::integer FROM vault_coins WHERE status = 'current') AS current_coins
    `;
    const state = states[0]!;
    checks.push(check('exactly one three-person private-beta vault exists',
      state.vaults === 1 && state.members === 3, `${state.vaults} vault(s); ${state.members} member(s)`));
    checks.push(check('all three participants have two completed PRF passkey envelopes',
      state.recovery_ready_members === 3, `${state.recovery_ready_members}/3 participants`));
    checks.push(check('the immutable roster has nine live Sigbash keys and three confirmations',
      state.live_sigbash_keys === 9 && state.roster_confirmations === 3,
      `${state.live_sigbash_keys}/9 keys; ${state.roster_confirmations}/3 confirmations`));
    checks.push(check('all nine server-verified Sigbash readiness proofs are recorded',
      state.readiness_proofs === 9 && state.ready_vaults === 1,
      `${state.readiness_proofs}/9 proofs; ${state.ready_vaults} ready vault(s)`));
    checks.push(check('the pre-funding database contains no current Bitcoin coin',
      state.current_coins === 0, `${state.current_coins} current coin(s)`));
  } catch (error) {
    checks.push(check('production database readiness query succeeds', false, safeError(error)));
  } finally {
    await sql.end();
  }
} else {
  checks.push(check('production database is configured', false));
}

if (process.env.BITCOIN_BACKEND || process.env.BITCOIN_RPC_URL) {
  try {
    const info = await getBlockchainInfo();
    checks.push(check('configured Bitcoin backend identifies as mainnet',
      info.chain === 'main', `${info.blocks} blocks`));
  } catch (error) {
    checks.push(check('configured Bitcoin backend identifies as mainnet', false, safeError(error)));
  }
} else {
  checks.push(check('mainnet Bitcoin backend is configured', false));
}

const automatedPreflightPassed = checks.every((item) => item.ok);
console.log(JSON.stringify({
  automatedPreflightPassed,
  deploymentAndFundingAllowed: false,
  reason: automatedPreflightPassed
    ? 'Automated checks passed; complete and document every manual gate before deployment. Funding is always a later, separate approval.'
    : 'One or more mandatory automated gates are incomplete. Do not deploy or fund.',
  checks,
  manualGates,
}, null, 2));
if (!automatedPreflightPassed) process.exitCode = 1;

function check(name: string, ok: boolean, detail?: string): Check {
  return { name, ok, ...(detail ? { detail } : {}) };
}

function parsedOrigin(raw: string | undefined): URL | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.origin !== raw || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

function explicitInteger(name: string): number | null {
  const raw = process.env[name];
  if (!raw || !/^\d+$/u.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function databaseEndpointCheck(raw: string): { ok: boolean; detail?: string } {
  try {
    const url = new URL(raw);
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
    const sslMode = url.searchParams.get('sslmode');
    return {
      ok: (url.protocol === 'postgres:' || url.protocol === 'postgresql:') &&
        !local && (sslMode === 'require' || sslMode === 'verify-full'),
      detail: local ? 'local database endpoint' : `sslmode=${sslMode || 'absent'}`,
    };
  } catch {
    return { ok: false, detail: 'database URL is malformed' };
  }
}

async function runtimePinCheck(name: string, rawUrl: string, expected: string | undefined): Promise<void> {
  if (!expected || !/^[0-9a-f]{96}$/iu.test(expected)) {
    checks.push(check(name, false, 'pin is absent or malformed'));
    return;
  }
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
      throw new Error('runtime URL is not a credential-free HTTPS URL');
    }
    const response = await fetch(url, { cache: 'no-store', redirect: 'follow' });
    if (!response.ok) throw new Error(`runtime fetch returned ${response.status}`);
    const actual = createHash('sha384').update(Buffer.from(await response.arrayBuffer())).digest('hex');
    checks.push(check(name, actual === expected.toLowerCase()));
  } catch (error) {
    checks.push(check(name, false, safeError(error)));
  }
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'check failed';
  return message.replace(/postgres(?:ql)?:\/\/[^\s]+/giu, '[database URL redacted]').slice(0, 300);
}
