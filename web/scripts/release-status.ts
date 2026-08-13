import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import postgres from 'postgres';
import { getBlockchainInfo } from '../../src/bitcoin-rpc';
import { reviewedNodeRuntimeCheck } from '../../src/runtime-version';
import { databaseEndpointCheck } from '../lib/database-config';
import { EXPECTED_MIGRATION_VERSIONS } from '../lib/migrations';

if (existsSync('.env.local')) loadEnvFile('.env.local');

interface Check { name: string; ok: boolean; detail?: string }
const checks: Check[] = [];
const manualGates = [
  'The predeployment live-predeployment-proof output must show a real consensus-authorized Sigbash mainnet signature.',
  'Sigbash must explicitly enable mainnet for all three independent participant organization hashes.',
  'Each friend must complete setup and recovery with two real, distinct PRF-capable passkeys.',
  'Each friend must independently review the unanimous roster and tiny-mainnet economics.',
  'Before initial wallet signing, all three friends must review the same funding PSBT fingerprint, inputs, change outputs, vault output, and fee.',
  'The selected production database backup and restore procedure must be exercised.',
  'Funding remains a separate explicit decision after this report passes.',
];

const runtime = reviewedNodeRuntimeCheck();
checks.push(check(
  'reviewed Node runtime is active',
  runtime.ok,
  `Node ${runtime.actual}; expected ${runtime.expected}`,
));

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
const confirmationsRequired = explicitInteger('VAULT_CONFIRMATIONS_REQUIRED');
const fundingFee = explicitInteger('VAULT_FUNDING_FEE_SATS');
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
checks.push(check(
  'confirmation depth for funding and transitions is explicit',
  confirmationsRequired !== null && confirmationsRequired >= 1 && confirmationsRequired <= 144,
  confirmationsRequired === null ? undefined : `${confirmationsRequired} confirmations`,
));
checks.push(check(
  'three-wallet funding fee is explicit and cannot consume one deposit',
  fundingFee !== null && deposit !== null && fundingFee >= 500 && fundingFee < deposit,
  fundingFee === null ? undefined : `${fundingFee} sats total`,
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
  if (!databaseEndpoint.ok) {
    checks.push(check(
      'production database readiness query succeeds',
      false,
      'not attempted until the database endpoint passes TLS validation',
    ));
  } else {
    const sql = postgres(process.env.DATABASE_URL, { max: 1, connect_timeout: 10 });
    try {
      const version = await sql<Array<{ version: string }>>`SELECT version()`;
      checks.push(check('production database is PostgreSQL 16 or newer',
        /PostgreSQL (1[6-9]|[2-9][0-9])\./u.test(version[0]?.version || '')));
      const migrations = await sql<Array<{ version: string }>>`
        SELECT version FROM schema_migrations ORDER BY version
      `;
      checks.push(check(
        'all required database migrations are applied',
        JSON.stringify(migrations.map((row) => row.version)) === JSON.stringify(EXPECTED_MIGRATION_VERSIONS),
        `${migrations.length}/${EXPECTED_MIGRATION_VERSIONS.length} migrations`,
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
        funding_inputs: number;
        funding_signatures: number;
        funding_final_approvals: number;
        funding_finalization_status: string | null;
        funding_finalization_digest: string | null;
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
          (SELECT count(*)::integer FROM vault_coins WHERE status = 'current') AS current_coins,
          (SELECT count(*)::integer FROM participant_funding_inputs) AS funding_inputs,
          (SELECT count(*)::integer FROM participant_funding_signatures) AS funding_signatures,
          (SELECT count(*)::integer FROM funding_final_approvals) AS funding_final_approvals,
          (SELECT status FROM funding_finalizations LIMIT 1) AS funding_finalization_status,
          (SELECT encode(finalization_digest, 'hex') FROM funding_finalizations LIMIT 1)
            AS funding_finalization_digest
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
      const untouchedFunding = state.funding_inputs === 0 && state.funding_signatures === 0 &&
        state.funding_final_approvals === 0 && state.funding_finalization_status === null;
      const unanimouslyApprovedFunding = state.funding_inputs === 3 && state.funding_signatures === 3 &&
        state.funding_final_approvals === 3 && state.funding_finalization_status === 'approved' &&
        /^[0-9a-f]{64}$/u.test(state.funding_finalization_digest || '');
      checks.push(check(
        'funding ceremony is either untouched or unanimously approved and still unbroadcast',
        untouchedFunding || unanimouslyApprovedFunding,
        `${state.funding_inputs}/3 inputs; ${state.funding_signatures}/3 signatures; ` +
          `${state.funding_final_approvals}/3 final approvals; ` +
          `status ${state.funding_finalization_status || 'not started'}; ` +
          `digest ${state.funding_finalization_digest || 'none'}`,
      ));
    } catch (error) {
      checks.push(check('production database readiness query succeeds', false, safeError(error)));
    } finally {
      await sql.end();
    }
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
const reportBody = {
  version: 1,
  phase: 'funding',
  automatedPreflightPassed,
  fundingAllowed: false,
  deploymentGate: {
    evaluatedByThisReport: false,
    organizationCommand: 'npm run sigbash-proof-org-id',
    setupCommand: 'SIGBASH_MODE=live npm run live-predeployment-setup',
    proofCommand: 'SIGBASH_MODE=live npm run live-predeployment-proof',
  },
  reason: automatedPreflightPassed
    ? 'Automated funding checks passed; complete and document every manual gate. Funding still requires a later, separate approval.'
    : 'One or more mandatory automated funding gates are incomplete. Do not fund. This report does not evaluate the separate predeployment gate.',
  checks,
  manualGates,
};
const reportDigest = createHash('sha256').update(JSON.stringify(reportBody)).digest('hex');
console.log(JSON.stringify({ ...reportBody, reportDigest }, null, 2));
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
