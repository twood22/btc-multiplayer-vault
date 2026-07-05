// Thin JSON-RPC client for Bitcoin Core on signet. RPC results are inherently
// untyped JSON; the narrow result shapes the CLI relies on are declared here.

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

interface RpcEnvelope {
  result?: unknown;
  error?: { code?: number; message?: string } | null;
}

export async function bitcoinRpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
  const url = process.env.BITCOIN_RPC_URL || 'http://127.0.0.1:38332';
  const username = process.env.BITCOIN_RPC_USER || process.env.BITCOIN_RPC_USERNAME;
  const password = process.env.BITCOIN_RPC_PASSWORD;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (username || password) {
    headers.authorization = `Basic ${Buffer.from(`${username || ''}:${password || ''}`).toString('base64')}`;
  }

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
      `Bitcoin RPC ${method} could not reach ${url}. Start Bitcoin Core on signet or set BITCOIN_RPC_URL/BITCOIN_RPC_USER/BITCOIN_RPC_PASSWORD. ${(error as Error).message}`,
    );
  }
  const body = (await response.json()) as RpcEnvelope;
  if (!response.ok || body.error) {
    throw new Error(
      `Bitcoin RPC ${method} failed: ${body.error?.message || response.statusText}`,
    );
  }
  return body.result as T;
}

export async function getTxOut(txid: string, vout: number): Promise<RpcTxOut | null> {
  return bitcoinRpc<RpcTxOut | null>('gettxout', [txid, vout, true]);
}

export async function getBlockchainInfo(): Promise<{ chain: string; blocks: number; headers: number }> {
  return bitcoinRpc('getblockchaininfo');
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
  return bitcoinRpc('getrawtransaction', [txid, verbose]);
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
  return bitcoinRpc('sendrawtransaction', [rawTxHex]);
}
