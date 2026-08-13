import type { RpcBlockStatus, RpcTransaction, RpcTxOut } from './bitcoin-rpc.js';
import { BitcoinTransactionNotFoundError } from './bitcoin-backend-errors.js';
import {
  BITCOIN_CORE_CHAIN,
  DEFAULT_ESPLORA_URL,
  MAINNET_GENESIS_HASH,
} from './network.js';

// Esplora (mempool.space / blockstream) backend for the mainnet product flow.
// run without a local Bitcoin Core node. Enabled by BITCOIN_BACKEND=esplora
// (or by setting BITCOIN_ESPLORA_URL). Covers exactly the read/broadcast
// surface the CLI needs: gettxout, getrawtransaction, sendrawtransaction, and
// tip height. Policy verification and PSBT building never touch the chain.

export function esploraEnabled(): boolean {
  return process.env.BITCOIN_BACKEND === 'esplora' || Boolean(process.env.BITCOIN_ESPLORA_URL);
}

function baseUrl(): string {
  return (process.env.BITCOIN_ESPLORA_URL || DEFAULT_ESPLORA_URL).replace(/\/$/, '');
}

async function assertMainnetEsplora(): Promise<void> {
  const url = baseUrl();
  const response = await fetch(`${url}/block-height/0`);
  const genesisHash = (await response.text()).trim();
  if (!response.ok || genesisHash !== MAINNET_GENESIS_HASH) {
    throw new Error('configured Esplora backend is not Bitcoin mainnet');
  }
}

async function esploraGet(path: string): Promise<Response> {
  await assertMainnetEsplora();
  const url = `${baseUrl()}${path}`;
  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new Error(`Esplora request to ${url} failed: ${(error as Error).message}`);
  }
  return response;
}

interface EsploraVout {
  scriptpubkey: string;
  scriptpubkey_address?: string;
  value: number;
}

interface EsploraTx {
  txid: string;
  version: number;
  locktime: number;
  vin: Array<{
    txid: string;
    vout: number;
    sequence: number;
    witness?: string[];
    prevout?: EsploraVout | null;
  }>;
  vout: EsploraVout[];
  status: { confirmed: boolean; block_height?: number; block_hash?: string; block_time?: number };
}

async function tipHeight(): Promise<number> {
  const response = await esploraGet('/blocks/tip/height');
  if (!response.ok) throw new Error(`Esplora tip height failed: ${response.status}`);
  return Number(await response.text());
}

async function fetchTx(txid: string): Promise<EsploraTx> {
  const response = await esploraGet(`/tx/${txid}`);
  if (response.status === 404) throw new BitcoinTransactionNotFoundError(txid);
  if (!response.ok) throw new Error(`Esplora tx ${txid} failed (${response.status})`);
  return (await response.json()) as EsploraTx;
}

function confirmations(tx: EsploraTx, tip: number): number {
  if (!tx.status.confirmed || tx.status.block_height === undefined) return 0;
  return tip - tx.status.block_height + 1;
}

export async function esploraGetTxOut(txid: string, vout: number): Promise<RpcTxOut | null> {
  const spentResponse = await esploraGet(`/tx/${txid}/outspend/${vout}`);
  if (!spentResponse.ok) return null;
  const spent = (await spentResponse.json()) as { spent: boolean };
  if (spent.spent) return null;
  const tx = await fetchTx(txid);
  const output = tx.vout[vout];
  if (!output) return null;
  const tip = await tipHeight();
  return {
    bestblock: tx.status.block_hash || '',
    confirmations: confirmations(tx, tip),
    value: output.value / 100_000_000,
    scriptPubKey: {
      hex: output.scriptpubkey,
      address: output.scriptpubkey_address,
      type: 'witness_v1_taproot',
    },
  };
}

export async function esploraGetRawTransaction(txid: string): Promise<RpcTransaction> {
  const tx = await fetchTx(txid);
  const [tip, hexResponse] = await Promise.all([
    tipHeight(),
    esploraGet(`/tx/${txid}/hex`),
  ]);
  const hex = hexResponse.ok ? (await hexResponse.text()).trim() : undefined;
  return {
    txid: tx.txid,
    version: tx.version,
    locktime: tx.locktime,
    vin: tx.vin.map((input) => ({
      txid: input.txid,
      vout: input.vout,
      sequence: input.sequence,
      txinwitness: input.witness,
      prevout: input.prevout
        ? {
            value: input.prevout.value / 100_000_000,
            scriptPubKey: {
              hex: input.prevout.scriptpubkey,
              address: input.prevout.scriptpubkey_address,
            },
          }
        : undefined,
    })),
    vout: tx.vout.map((output, index) => ({
      n: index,
      value: output.value / 100_000_000,
      scriptPubKey: { hex: output.scriptpubkey, address: output.scriptpubkey_address },
    })),
    confirmations: confirmations(tx, tip),
    ...(tx.status.block_hash ? { blockhash: tx.status.block_hash } : {}),
    ...(tx.status.block_height !== undefined ? { blockheight: tx.status.block_height } : {}),
    ...(tx.status.block_time !== undefined ? { blocktime: tx.status.block_time, time: tx.status.block_time } : {}),
    ...(hex ? { hex } : {}),
  };
}

export async function esploraGetBlockStatus(blockHash: string): Promise<RpcBlockStatus> {
  const [statusResponse, blockResponse] = await Promise.all([
    esploraGet(`/block/${blockHash}/status`),
    esploraGet(`/block/${blockHash}`),
  ]);
  if (!statusResponse.ok || !blockResponse.ok) {
    throw new Error(`Esplora block ${blockHash} status is unavailable`);
  }
  const status = await statusResponse.json() as { in_best_chain?: unknown };
  const block = await blockResponse.json() as { id?: unknown; height?: unknown };
  if (typeof status.in_best_chain !== 'boolean' || block.id !== blockHash ||
      !Number.isSafeInteger(block.height) || Number(block.height) <= 0) {
    throw new Error('Esplora returned an invalid block status');
  }
  const height = Number(block.height);
  const tip = status.in_best_chain ? await tipHeight() : null;
  const blockConfirmations = tip === null ? -1 : tip - height + 1;
  if (!Number.isSafeInteger(blockConfirmations) ||
      (status.in_best_chain ? blockConfirmations <= 0 : blockConfirmations !== -1)) {
    throw new Error('Esplora returned an invalid block confirmation count');
  }
  return {
    hash: blockHash,
    height,
    confirmations: blockConfirmations,
    inBestChain: status.in_best_chain,
  };
}

export async function esploraSendRawTransaction(rawTxHex: string): Promise<string> {
  await assertMainnetEsplora();
  const url = `${baseUrl()}/tx`;
  const response = await fetch(url, { method: 'POST', body: rawTxHex });
  const body = (await response.text()).trim();
  if (!response.ok) throw new Error(`Esplora broadcast rejected: ${body}`);
  return body;
}

export async function esploraGetBlockchainInfo(): Promise<{ chain: string; blocks: number; headers: number }> {
  const blocks = await tipHeight();
  return { chain: BITCOIN_CORE_CHAIN, blocks, headers: blocks };
}
