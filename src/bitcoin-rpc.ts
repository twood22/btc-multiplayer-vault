import {
  esploraEnabled,
  esploraGetBlockStatus,
  esploraGetBlockchainInfo,
  esploraGetRawTransaction,
  esploraGetTxOut,
  esploraSendRawTransaction,
} from './esplora.js';
import { BitcoinTransactionNotFoundError } from './bitcoin-backend-errors.js';
import { assertMainnetChain, DEFAULT_BITCOIN_RPC_URL } from './network.js';

// Thin JSON-RPC client for Bitcoin Core on mainnet. RPC results are inherently
// untyped JSON; the narrow result shapes the CLI relies on are declared here.
// When BITCOIN_BACKEND=esplora, chain reads/broadcast are served by a public
// Esplora API instead, so no local node is required.

export interface RpcScriptPubKey {
  hex?: string;
  address?: string;
  /** Legacy pre-22.0 field kept for compatibility with older nodes. */
  addresses?: string[];
  asm?: string;
  type?: string;
}

export interface RpcTxOut {
  bestblock: string;
  confirmations: number;
  value: number;
  scriptPubKey?: RpcScriptPubKey;
  coinbase?: boolean;
}

export interface RpcTxInput {
  txid?: string;
  vout?: number;
  sequence?: number;
  txinwitness?: string[];
  prevout?: { value?: number; scriptPubKey?: RpcScriptPubKey };
  coinbase?: string;
}

export interface RpcTxOutput {
  n: number;
  value: number;
  scriptPubKey?: RpcScriptPubKey;
}

export interface RpcTransaction {
  txid: string;
  hash?: string;
  version?: number;
  locktime?: number;
  vin: RpcTxInput[];
  vout: RpcTxOutput[];
  confirmations?: number;
  blockhash?: string;
  blockheight?: number;
  time?: number;
  blocktime?: number;
  hex?: string;
}

export interface RpcMempoolAcceptResult {
  txid: string;
  allowed?: boolean;
  'reject-reason'?: string;
  vsize?: number;
  fees?: { base?: number };
}

export interface RpcBlockStatus {
  hash: string;
  height: number;
  confirmations: number;
  inBestChain: boolean;
}

export interface RpcBlockchainInfo {
  chain: string;
  blocks: number;
  headers: number;
  pruned?: boolean;
  initialblockdownload?: boolean;
}

interface RpcEnvelope {
  result?: unknown;
  error?: { code?: number; message?: string } | null;
}

class BitcoinRpcError extends Error {
  readonly code: number | undefined;

  constructor(method: string, code: number | undefined, message: string) {
    super(`Bitcoin RPC ${method} failed: ${message}`);
    this.name = 'BitcoinRpcError';
    this.code = code;
  }
}

function rpcConfig(): { url: string; headers: Record<string, string> } {
  const url = process.env.BITCOIN_RPC_URL || DEFAULT_BITCOIN_RPC_URL;
  const username = process.env.BITCOIN_RPC_USER || process.env.BITCOIN_RPC_USERNAME;
  const password = process.env.BITCOIN_RPC_PASSWORD;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (username || password) {
    headers.authorization = `Basic ${Buffer.from(`${username || ''}:${password || ''}`).toString('base64')}`;
  }
  return { url, headers };
}

async function assertMainnetRpc(
  url: string,
  headers: Record<string, string>,
): Promise<RpcBlockchainInfo> {
  const info = await rawBitcoinRpc<RpcBlockchainInfo>('getblockchaininfo', [], url, headers);
  assertMainnetChain(info.chain);
  if (info.pruned !== false || info.initialblockdownload !== false) {
    throw new Error('Bitcoin Core must be fully synchronized and non-pruned');
  }
  const indexes = await rawBitcoinRpc<Record<string, { synced?: boolean }>>(
    'getindexinfo',
    [],
    url,
    headers,
  );
  if (indexes.txindex?.synced !== true) {
    throw new Error('Bitcoin Core requires a fully synchronized transaction index');
  }
  return info;
}

async function rawBitcoinRpc<T>(
  method: string,
  params: unknown[],
  url: string,
  headers: Record<string, string>,
): Promise<T> {

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '1.0',
        id: 'btc-multiplayer-vault',
        method,
        params,
      }),
    });
  } catch (error) {
    throw new Error(
      `Bitcoin RPC ${method} could not reach ${url}. Start Bitcoin Core on mainnet or set BITCOIN_RPC_URL/BITCOIN_RPC_USER/BITCOIN_RPC_PASSWORD. ${(error as Error).message}`,
    );
  }
  const body = (await response.json()) as RpcEnvelope;
  if (!response.ok || body.error) {
    throw new BitcoinRpcError(
      method,
      body.error?.code,
      body.error?.message || response.statusText,
    );
  }
  return body.result as T;
}

export async function bitcoinRpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
  const { url, headers } = rpcConfig();
  if (method !== 'getblockchaininfo' && method !== 'getindexinfo') {
    await assertMainnetRpc(url, headers);
  }
  return rawBitcoinRpc<T>(method, params, url, headers);
}

export async function getTxOut(txid: string, vout: number): Promise<RpcTxOut | null> {
  if (esploraEnabled()) return esploraGetTxOut(txid, vout);
  return bitcoinRpc<RpcTxOut | null>('gettxout', [txid, vout, true]);
}

export async function getBlockchainInfo(): Promise<RpcBlockchainInfo> {
  let info: RpcBlockchainInfo;
  if (esploraEnabled()) {
    info = await esploraGetBlockchainInfo();
  } else {
    const { url, headers } = rpcConfig();
    info = await assertMainnetRpc(url, headers);
  }
  assertMainnetChain(info.chain);
  return info;
}

/** Positive active-chain evidence for one previously recorded confirmation block. */
export async function getBlockStatus(blockHash: string): Promise<RpcBlockStatus> {
  if (!/^[0-9a-f]{64}$/u.test(blockHash)) throw new Error('Bitcoin block hash is invalid');
  if (esploraEnabled()) return esploraGetBlockStatus(blockHash);
  const header = await bitcoinRpc<{
    hash: string;
    height: number;
    confirmations: number;
  }>('getblockheader', [blockHash, true]);
  if (header.hash !== blockHash || !Number.isSafeInteger(header.height) || header.height <= 0 ||
      !Number.isSafeInteger(header.confirmations) ||
      (header.confirmations !== -1 && header.confirmations <= 0)) {
    throw new Error('Bitcoin Core returned an invalid block status');
  }
  return {
    hash: header.hash,
    height: header.height,
    confirmations: header.confirmations,
    inBestChain: header.confirmations >= 0,
  };
}

export async function getDescriptorInfo(descriptor: string): Promise<{ descriptor: string; checksum: string }> {
  return bitcoinRpc('getdescriptorinfo', [descriptor]);
}

export async function importDescriptors(requests: unknown[]): Promise<Array<{ success: boolean; error?: { message?: string } }>> {
  return bitcoinRpc('importdescriptors', [requests]);
}

export async function decodeRawTransaction(rawTxHex: string): Promise<RpcTransaction> {
  return bitcoinRpc('decoderawtransaction', [rawTxHex]);
}

// verbose accepts Core's numeric verbosity too (2 includes input prevouts).
export async function getRawTransaction(
  txid: string,
  verbose: boolean | number = true,
): Promise<RpcTransaction> {
  if (esploraEnabled()) return esploraGetRawTransaction(txid);
  let transaction: RpcTransaction;
  try {
    transaction = await bitcoinRpc<RpcTransaction>('getrawtransaction', [txid, verbose]);
  } catch (error) {
    if (error instanceof BitcoinRpcError && error.code === -5) {
      throw new BitcoinTransactionNotFoundError(txid);
    }
    throw error;
  }
  if (transaction.blockheight === undefined &&
      (transaction.confirmations || 0) > 0 &&
      transaction.blockhash) {
    const header = await bitcoinRpc<{ height: number }>('getblockheader', [transaction.blockhash, true]);
    if (!Number.isSafeInteger(header.height) || header.height <= 0) {
      throw new Error('Bitcoin RPC returned an invalid confirmed block height');
    }
    transaction.blockheight = header.height;
  }
  return transaction;
}

export async function testMempoolAccept(
  rawTxHex: string,
  maxFeeRateBtcPerKvB?: number,
): Promise<RpcMempoolAcceptResult[]> {
  const params: unknown[] = [[rawTxHex]];
  if (maxFeeRateBtcPerKvB !== undefined) params.push(maxFeeRateBtcPerKvB);
  return bitcoinRpc('testmempoolaccept', params);
}

export async function walletProcessPsbt(
  psbtBase64: string,
  {
    sign = true,
    sighashType = 'ALL',
    bip32Derivs = true,
  }: { sign?: boolean; sighashType?: string; bip32Derivs?: boolean } = {},
): Promise<{ psbt: string; complete: boolean }> {
  return bitcoinRpc('walletprocesspsbt', [psbtBase64, sign, sighashType, bip32Derivs]);
}

export async function combinePsbts(psbtBase64s: string[]): Promise<string> {
  return bitcoinRpc('combinepsbt', [psbtBase64s]);
}

export async function finalizePsbt(
  psbtBase64: string,
  extract = true,
): Promise<{ psbt?: string; hex?: string; complete: boolean }> {
  return bitcoinRpc('finalizepsbt', [psbtBase64, extract]);
}

export async function sendRawTransaction(rawTxHex: string): Promise<string> {
  if (esploraEnabled()) return esploraSendRawTransaction(rawTxHex);
  return bitcoinRpc('sendrawtransaction', [rawTxHex]);
}
