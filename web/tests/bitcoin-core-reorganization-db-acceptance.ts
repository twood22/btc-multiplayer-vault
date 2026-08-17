import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import {
  BitcoinTransactionNotFoundError,
} from '../../src/bitcoin-backend-errors.js';
import type {
  RpcBlockStatus,
  RpcTransaction,
} from '../../src/bitcoin-rpc.js';
import {
  reconcileConfirmedChainState,
  type ChainReconciliationBackend,
} from '../lib/server/chain-reconciliation.js';

const databaseUrl = required('DATABASE_URL');
const rpcUrl = required('BITCOIN_CORE_DRILL_RPC_URL');
const cookie = readFileSync(required('BITCOIN_CORE_DRILL_COOKIE_FILE'), 'utf8').trim();
if (!cookie.includes(':') || /[\r\n]/u.test(cookie)) throw new Error('Bitcoin Core drill cookie is invalid');
const authorization = `Basic ${Buffer.from(cookie).toString('base64')}`;
const sql = postgres(databaseUrl, { max: 4 });
const checks: Array<{ name: string; ok: true }> = [];

const transitionVault = '83111111-1111-4111-8111-111111111111';
const fundingVault = '83111111-1111-4111-8111-111111111112';
const alice = '83222222-2222-4222-8222-222222222221';
const bob = '83222222-2222-4222-8222-222222222222';
const transitionProposal = '83333333-3333-4333-8333-333333333331';
const transitionInput = '83444444-4444-4444-8444-444444444441';
const transitionSuccessor = '83444444-4444-4444-8444-444444444442';
const fundingCoin = '83444444-4444-4444-8444-444444444451';
const transitionDigest = Buffer.alloc(32, 0xc1);
const fundingDigest = Buffer.alloc(32, 0xc2);
const requiredConfirmations = 2;

const backend: ChainReconciliationBackend = {
  getBlockStatus,
  getRawTransaction,
};

class DrillRpcError extends Error {
  constructor(readonly code: number | undefined, message: string) {
    super(message);
    this.name = 'DrillRpcError';
  }
}

try {
  await rpc('createwallet', ['reorganization-drill']);
  const miningAddress = await walletRpc<string>('getnewaddress', ['mining']);
  await rpc('generatetoaddress', [101, miningAddress]);
  const destination = await walletRpc<string>('getnewaddress', ['reorganization-target']);
  const txid = await walletRpc<string>('sendtoaddress', [destination, 0.001]);
  await rpc('generatetoaddress', [2, miningAddress]);
  const initiallyConfirmed = await getRawTransaction(txid, true);
  const initialBlockHash = exactHash(initiallyConfirmed.blockhash, 'initial block hash');
  const initialHeight = exactHeight(initiallyConfirmed.blockheight, 'initial block height');
  assert((initiallyConfirmed.confirmations || 0) >= requiredConfirmations);
  const rawTransaction = exactHex(initiallyConfirmed.hex, 'raw transaction');
  await seedProductState({ txid, rawTransaction, initialBlockHash, initialHeight });

  const stable = await reconcileConfirmedChainState({ backend, requiredConfirmations });
  assert.deepEqual(stable, emptyResult());
  checks.push({ name: 'the product reconciliation boundary accepts Core active-chain evidence without mutation', ok: true });

  await rpc('invalidateblock', [initialBlockHash]);
  const orphaned = await getBlockStatus(initialBlockHash);
  assert.equal(orphaned.inBestChain, false);
  assert.equal(orphaned.confirmations, -1);

  const unavailableBackend: ChainReconciliationBackend = {
    getBlockStatus,
    async getRawTransaction() {
      throw new Error('controlled backend transport failure');
    },
  };
  await assert.rejects(
    () => reconcileConfirmedChainState({ backend: unavailableBackend, requiredConfirmations }),
    /controlled backend transport failure/u,
  );
  await assertAnchors(initialBlockHash, initialHeight, 'confirmed', 'confirmed', 0);
  checks.push({ name: 'an orphaned block plus transaction-lookup outage changes no product state', ok: true });

  const replacementMiningAddress = await walletRpc<string>('getnewaddress', ['replacement-mining']);
  await rpc('generatetoaddress', [2, replacementMiningAddress]);
  const reIncluded = await getRawTransaction(txid, true);
  const replacementBlockHash = exactHash(reIncluded.blockhash, 'replacement block hash');
  const replacementHeight = exactHeight(reIncluded.blockheight, 'replacement block height');
  assert.notEqual(replacementBlockHash, initialBlockHash);
  assert((reIncluded.confirmations || 0) >= requiredConfirmations);
  const reanchored = await reconcileConfirmedChainState({ backend, requiredConfirmations });
  assert.deepEqual(reanchored, {
    reanchoredFundingTransactions: [txid],
    reanchoredTransactions: [txid],
    rolledBackFundingTransactions: [],
    rolledBackTransactions: [],
  });
  await assertAnchors(replacementBlockHash, replacementHeight, 'confirmed', 'confirmed', 2);
  checks.push({ name: 'Core re-inclusion moves funding and round state to the replacement block atomically', ok: true });

  await rpc('invalidateblock', [replacementBlockHash]);
  const mempoolTransaction = await getRawTransaction(txid, true);
  assert.equal(mempoolTransaction.confirmations || 0, 0);
  assert.equal(mempoolTransaction.blockhash, undefined);
  const rolledBack = await reconcileConfirmedChainState({ backend, requiredConfirmations });
  assert.deepEqual(rolledBack, {
    reanchoredFundingTransactions: [],
    reanchoredTransactions: [],
    rolledBackFundingTransactions: [txid],
    rolledBackTransactions: [txid],
  });
  await assertRolledBack(txid);
  checks.push({ name: 'a real Core reorganization restores exact inputs and orphans phantom successors descendant-first', ok: true });
} finally {
  await sql.end();
}

console.log(JSON.stringify({ passed: true, checks }, null, 2));

async function getBlockStatus(blockHash: string): Promise<RpcBlockStatus> {
  const header = await rpc<{
    hash: string;
    height: number;
    confirmations: number;
  }>('getblockheader', [blockHash, true]);
  if (header.hash !== blockHash || !Number.isSafeInteger(header.height) || header.height <= 0 ||
      !Number.isSafeInteger(header.confirmations) ||
      (header.confirmations !== -1 && header.confirmations <= 0)) {
    throw new Error('Bitcoin Core drill returned invalid block status');
  }
  return {
    hash: header.hash,
    height: header.height,
    confirmations: header.confirmations,
    inBestChain: header.confirmations >= 0,
  };
}

async function getRawTransaction(txid: string, verbose: boolean | number): Promise<RpcTransaction> {
  try {
    const transaction = await rpc<RpcTransaction>('getrawtransaction', [txid, verbose]);
    if (transaction.blockheight === undefined && (transaction.confirmations || 0) > 0 && transaction.blockhash) {
      const header = await rpc<{ height: number }>('getblockheader', [transaction.blockhash, true]);
      transaction.blockheight = header.height;
    }
    return transaction;
  } catch (error) {
    if (error instanceof DrillRpcError && error.code === -5) {
      throw new BitcoinTransactionNotFoundError(txid);
    }
    throw error;
  }
}

async function rpc<T = unknown>(method: string, params: unknown[]): Promise<T> {
  return rpcAt<T>(rpcUrl, method, params);
}

async function walletRpc<T = unknown>(method: string, params: unknown[]): Promise<T> {
  return rpcAt<T>(`${rpcUrl}/wallet/reorganization-drill`, method, params);
}

async function rpcAt<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '1.0', id: 'reorganization-drill', method, params }),
  });
  const body = await response.json() as {
    result?: T;
    error?: { code?: number; message?: string } | null;
  };
  if (!response.ok || body.error) {
    throw new DrillRpcError(body.error?.code, `Bitcoin Core drill ${method} failed: ${body.error?.message || response.statusText}`);
  }
  return body.result as T;
}

async function seedProductState(input: {
  txid: string;
  rawTransaction: string;
  initialBlockHash: string;
  initialHeight: number;
}): Promise<void> {
  await seedBase(transitionVault, transitionDigest);
  await seedBase(fundingVault, fundingDigest);
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO vault_coins (
        id, vault_id, roster_digest, kind, round_id, owner_participant_id,
        txid, vout, value_sats, script_pubkey, status, confirmed_height, spent_by_txid
      ) VALUES
      (
        ${transitionInput}::uuid, ${transitionVault}::uuid, ${transitionDigest}, 'vault',
        'alicebobcarol', NULL, ${Buffer.alloc(32, 0xc3)}, 0, 30000,
        ${taproot(0xc3)}, 'spent', ${input.initialHeight - 1}, ${Buffer.from(input.txid, 'hex')}
      ),
      (
        ${transitionSuccessor}::uuid, ${transitionVault}::uuid, ${transitionDigest}, 'vault',
        'bobcarol', NULL, ${Buffer.from(input.txid, 'hex')}, 0, 20000,
        ${taproot(0xc4)}, 'current', ${input.initialHeight}, NULL
      ),
      (
        ${fundingCoin}::uuid, ${fundingVault}::uuid, ${fundingDigest}, 'vault',
        'alicebobcarol', NULL, ${Buffer.from(input.txid, 'hex')}, 1, 30000,
        ${taproot(0xc5)}, 'current', ${input.initialHeight}, NULL
      )
    `;
    await tx`
      INSERT INTO vault_transaction_proposals (
        id, vault_id, roster_digest, input_coin_id, kind, round_id,
        actor_participant_id, proposer_user_id, psbt_base64, unsigned_txid,
        proposal_digest, status, finalized_tx_hex, final_txid, expires_at,
        confirmed_height, confirmed_block_hash
      ) VALUES (
        ${transitionProposal}::uuid, ${transitionVault}::uuid, ${transitionDigest},
        ${transitionInput}::uuid, 'solo', 'alicebobcarol', 'alice', ${alice}::uuid,
        'cHNidP8BAAAAAAAAAAAAAA==', ${Buffer.alloc(32, 0xc6)}, ${Buffer.alloc(32, 0xc7)},
        'confirmed', ${input.rawTransaction}, ${Buffer.from(input.txid, 'hex')},
        now() + interval '15 minutes', ${input.initialHeight},
        ${Buffer.from(input.initialBlockHash, 'hex')}
      )
    `;
    await tx`
      INSERT INTO funding_finalizations (
        vault_id, roster_digest, proposal_digest, finalization_digest,
        final_txid, transaction_hex, fee_sats, vsize, status,
        approved_at, submission_started_at, broadcast_at, confirmed_at,
        confirmed_height, confirmed_block_hash
      ) VALUES (
        ${fundingVault}::uuid, ${fundingDigest}, ${Buffer.alloc(32, 0xc8)},
        ${Buffer.alloc(32, 0xc9)}, ${Buffer.from(input.txid, 'hex')}, ${input.rawTransaction},
        600, 100, 'confirmed', now(), now(), now(), now(), ${input.initialHeight},
        ${Buffer.from(input.initialBlockHash, 'hex')}
      )
    `;
  });
}

async function seedBase(vaultId: string, digest: Buffer): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`INSERT INTO vaults (id, name, status) VALUES (${vaultId}::uuid, 'Core reorganization drill', 'active')`;
    for (const [userId, participantId, credentialId] of [
      [alice, 'alice', 'core-reorg-alice'],
      [bob, 'bob', 'core-reorg-bob'],
    ] as const) {
      await tx`
        INSERT INTO users (id, display_name) VALUES (${userId}::uuid, ${participantId})
        ON CONFLICT (id) DO NOTHING
      `;
      await tx`
        INSERT INTO vault_members (vault_id, user_id, participant_id)
        VALUES (${vaultId}::uuid, ${userId}::uuid, ${participantId})
      `;
      await tx`
        INSERT INTO webauthn_credentials (
          credential_id, user_id, public_key, counter, transports,
          device_type, backed_up, prf_enabled
        ) VALUES (
          ${credentialId}, ${userId}::uuid, ${Buffer.alloc(65, 0x55)}, 0,
          ARRAY['internal'], 'multiDevice', true, true
        ) ON CONFLICT (credential_id) DO NOTHING
      `;
    }
    await tx`
      INSERT INTO vault_rosters (
        vault_id, version, network, artifact_json, digest, funding_address, status, confirmed_at
      ) VALUES (
        ${vaultId}::uuid, 1, 'mainnet', '{}'::jsonb, ${digest},
        'bc1pcorereorganizationdrill', 'confirmed', now()
      )
    `;
  });
}

async function assertAnchors(
  blockHash: string,
  height: number,
  transitionStatus: string,
  fundingStatus: string,
  eventCount: number,
): Promise<void> {
  const rows = await sql<Array<{
    transition_status: string;
    transition_height: string;
    transition_block: Buffer;
    funding_status: string;
    funding_height: string;
    funding_block: Buffer;
    events: string;
  }>>`
    SELECT
      (SELECT status FROM vault_transaction_proposals WHERE id = ${transitionProposal}::uuid)
        AS transition_status,
      (SELECT confirmed_height::text FROM vault_transaction_proposals
        WHERE id = ${transitionProposal}::uuid) AS transition_height,
      (SELECT confirmed_block_hash FROM vault_transaction_proposals
        WHERE id = ${transitionProposal}::uuid) AS transition_block,
      (SELECT status FROM funding_finalizations WHERE vault_id = ${fundingVault}::uuid)
        AS funding_status,
      (SELECT confirmed_height::text FROM funding_finalizations
        WHERE vault_id = ${fundingVault}::uuid) AS funding_height,
      (SELECT confirmed_block_hash FROM funding_finalizations
        WHERE vault_id = ${fundingVault}::uuid) AS funding_block,
      (SELECT count(*)::text FROM chain_reorganization_events) AS events
  `;
  assert.equal(rows[0]?.transition_status, transitionStatus);
  assert.equal(rows[0]?.transition_height, String(height));
  assert.equal(rows[0]?.transition_block.toString('hex'), blockHash);
  assert.equal(rows[0]?.funding_status, fundingStatus);
  assert.equal(rows[0]?.funding_height, String(height));
  assert.equal(rows[0]?.funding_block.toString('hex'), blockHash);
  assert.equal(rows[0]?.events, String(eventCount));
}

async function assertRolledBack(txid: string): Promise<void> {
  const rows = await sql<Array<{
    transition_status: string;
    transition_height: string | null;
    input_status: string;
    input_spender: Buffer | null;
    successor_status: string;
    funding_status: string;
    funding_height: string | null;
    funding_vault_status: string;
    funding_coin_status: string;
    events: string;
  }>>`
    SELECT
      (SELECT status FROM vault_transaction_proposals WHERE id = ${transitionProposal}::uuid)
        AS transition_status,
      (SELECT confirmed_height::text FROM vault_transaction_proposals
        WHERE id = ${transitionProposal}::uuid) AS transition_height,
      (SELECT status FROM vault_coins WHERE id = ${transitionInput}::uuid) AS input_status,
      (SELECT spent_by_txid FROM vault_coins WHERE id = ${transitionInput}::uuid) AS input_spender,
      (SELECT status FROM vault_coins WHERE id = ${transitionSuccessor}::uuid) AS successor_status,
      (SELECT status FROM funding_finalizations WHERE vault_id = ${fundingVault}::uuid)
        AS funding_status,
      (SELECT confirmed_height::text FROM funding_finalizations
        WHERE vault_id = ${fundingVault}::uuid) AS funding_height,
      (SELECT status FROM vaults WHERE id = ${fundingVault}::uuid) AS funding_vault_status,
      (SELECT status FROM vault_coins WHERE id = ${fundingCoin}::uuid) AS funding_coin_status,
      (SELECT count(*)::text FROM chain_reorganization_events) AS events
  `;
  assert.deepEqual(rows[0], {
    transition_status: 'broadcast',
    transition_height: null,
    input_status: 'current',
    input_spender: null,
    successor_status: 'orphaned',
    funding_status: 'broadcast',
    funding_height: null,
    funding_vault_status: 'ready',
    funding_coin_status: 'orphaned',
    events: '4',
  });
  const audit = await sql<Array<{ scope: string; action: string; txid: Buffer }>>`
    SELECT event_scope AS scope, action, txid
    FROM chain_reorganization_events ORDER BY created_at, event_scope
  `;
  assert.equal(audit.length, 4);
  assert(audit.every((event) => event.txid.toString('hex') === txid));
  assert.deepEqual(new Set(audit.map((event) => `${event.scope}:${event.action}`)), new Set([
    'funding:reanchored',
    'vault_transition:reanchored',
    'funding:rolled_back',
    'vault_transition:rolled_back',
  ]));
}

function emptyResult() {
  return {
    reanchoredFundingTransactions: [],
    reanchoredTransactions: [],
    rolledBackFundingTransactions: [],
    rolledBackTransactions: [],
  };
}

function exactHash(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function exactHex(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length < 20 || !/^[0-9a-f]+$/u.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function exactHeight(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`${label} is invalid`);
  return Number(value);
}

function taproot(byte: number): Buffer {
  return Buffer.from(`5120${byte.toString(16).padStart(2, '0').repeat(32)}`, 'hex');
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
