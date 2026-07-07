import type { RpcTransaction, RpcTxOut } from './bitcoin-rpc.js';

// Esplora (mempool.space / blockstream) backend so the live signet flow can
// run without a local Bitcoin Core node. Enabled by BITCOIN_BACKEND=esplora
// (or by setting BITCOIN_ESPLORA_URL). Covers exactly the read/broadcast
// surface the CLI needs: gettxout, getrawtransaction, sendrawtransaction, and
// tip height. Policy verification and PSBT building never touch the chain.

export function esploraEnabled(): boolean {
  return process.env.BITCOIN_BACKEND === 'esplora' || Boolean(process.env.BITCOIN_ESPLORA_URL);
}

function baseUrl(): string {
  return (process.env.BITCOIN_ESPLORA_URL || 'https://mempool.space/signet/api').replace(/\/$/, '');
}

async function esploraGet(path: string): Promise<Response> {
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
  if (!response.ok) throw new Error(`Esplora tx ${txid} not found (${response.status})`);
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
  const [tx, tip, hexResponse] = await Promise.all([
    fetchTx(txid),
    tipHeight(),
    esploraGet(`/tx/${txid}/hex`),
  ]);
  const hex = hexResponse.ok ? (await hexResponse.text()).trim() : undefined;
  return {
    txid: tx.txid,
    version: tx.version,
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

export async function esploraSendRawTransaction(rawTxHex: string): Promise<string> {
  const url = `${baseUrl()}/tx`;
  const response = await fetch(url, { method: 'POST', body: rawTxHex });
  const body = (await response.text()).trim();
  if (!response.ok) throw new Error(`Esplora broadcast rejected: ${body}`);
  return body;
}

export async function esploraGetBlockchainInfo(): Promise<{ chain: string; blocks: number; headers: number }> {
  const blocks = await tipHeight();
  return { chain: 'signet', blocks, headers: blocks };
}
