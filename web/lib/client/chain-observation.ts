'use client';

import {
  BITCOIN_GENESIS_HASH,
  BITCOIN_NETWORK_CONFIG,
} from '../../../src/network.js';
import {
  vaultCoinSnapshotDigest,
  type VaultCoinSnapshot,
} from '../../../src/vault-runtime.js';

interface EsploraTransaction {
  txid: string;
  vout: Array<{ scriptpubkey: string; value: number }>;
  status: { confirmed: boolean; block_height?: number };
}

export interface ObservedFundingInput {
  txid: string;
  vout: number;
  valueSats: number;
  scriptPubKeyHex: string;
  sourceOrigin: string;
  confirmations: number;
  observedUnspent: true;
}

/** Resolve and independently verify a participant-selected funding coin on the configured network. */
export async function observeFundingInput(
  sourceOrigin: string,
  txid: string,
  vout: number,
): Promise<ObservedFundingInput> {
  if (!/^[0-9a-f]{64}$/u.test(txid.toLowerCase()) || !Number.isSafeInteger(vout) ||
      vout < 0 || vout > 0xffffffff) {
    throw new Error('funding input must be a valid transaction ID and output number');
  }
  const source = validatedSourceOrigin(sourceOrigin);
  const base = `${source.origin}/api`;
  const [genesisResponse, transactionResponse, outspendResponse, tipResponse] = await Promise.all([
    fetch(`${base}/block-height/0`, { cache: 'no-store', credentials: 'omit' }),
    fetch(`${base}/tx/${txid}`, { cache: 'no-store', credentials: 'omit' }),
    fetch(`${base}/tx/${txid}/outspend/${vout}`, { cache: 'no-store', credentials: 'omit' }),
    fetch(`${base}/blocks/tip/height`, { cache: 'no-store', credentials: 'omit' }),
  ]);
  if (!genesisResponse.ok || (await genesisResponse.text()).trim() !== BITCOIN_GENESIS_HASH) {
    throw new Error(`independent chain source is not ${BITCOIN_NETWORK_CONFIG.addressLabel}`);
  }
  if (!transactionResponse.ok) throw new Error('independent chain source did not find the funding transaction');
  if (!outspendResponse.ok) throw new Error('independent chain source could not verify the funding output');
  if (!tipResponse.ok) throw new Error('independent chain source did not return its tip height');
  const transaction = await transactionResponse.json() as EsploraTransaction;
  const outspend = await outspendResponse.json() as { spent?: unknown };
  const tip = Number((await tipResponse.text()).trim());
  const output = transaction.vout?.[vout];
  if (transaction.txid !== txid.toLowerCase() || !output || !Number.isSafeInteger(output.value) ||
      !/^[0-9a-f]+$/u.test(output.scriptpubkey)) {
    throw new Error('independent chain transaction does not contain a valid requested output');
  }
  if (outspend.spent !== false) throw new Error('independent chain source reports the funding output spent');
  if (!transaction.status?.confirmed || !Number.isSafeInteger(transaction.status.block_height)) {
    throw new Error(`funding output is not confirmed on ${BITCOIN_NETWORK_CONFIG.addressLabel}`);
  }
  if (!Number.isSafeInteger(tip) || tip < transaction.status.block_height!) {
    throw new Error('independent chain source returned an invalid tip height');
  }
  return {
    txid: transaction.txid,
    vout,
    valueSats: output.value,
    scriptPubKeyHex: output.scriptpubkey,
    sourceOrigin: source.origin,
    confirmations: tip - transaction.status.block_height! + 1,
    observedUnspent: true,
  };
}

/** Query an allowlisted Esplora server directly from the participant's browser. */
export async function observeVaultCoin(
  sourceOrigin: string,
  coin: VaultCoinSnapshot,
): Promise<{
  snapshotDigest: string;
  sourceOrigin: string;
  confirmations: number;
  observedUnspent: true;
}> {
  const source = validatedSourceOrigin(sourceOrigin);
  const base = `${source.origin}/api`;
  const [genesisResponse, transactionResponse, outspendResponse, tipResponse] = await Promise.all([
    fetch(`${base}/block-height/0`, { cache: 'no-store', credentials: 'omit' }),
    fetch(`${base}/tx/${coin.txid}`, { cache: 'no-store', credentials: 'omit' }),
    fetch(`${base}/tx/${coin.txid}/outspend/${coin.vout}`, { cache: 'no-store', credentials: 'omit' }),
    fetch(`${base}/blocks/tip/height`, { cache: 'no-store', credentials: 'omit' }),
  ]);
  if (!genesisResponse.ok || (await genesisResponse.text()).trim() !== BITCOIN_GENESIS_HASH) {
    throw new Error(`independent chain source is not ${BITCOIN_NETWORK_CONFIG.addressLabel}`);
  }
  if (!transactionResponse.ok) throw new Error('independent chain source did not find the vault transaction');
  if (!outspendResponse.ok) throw new Error('independent chain source could not verify the vault output');
  if (!tipResponse.ok) throw new Error('independent chain source did not return its tip height');
  const transaction = await transactionResponse.json() as EsploraTransaction;
  const outspend = await outspendResponse.json() as { spent?: unknown };
  const tip = Number((await tipResponse.text()).trim());
  const output = transaction.vout?.[coin.vout];
  if (transaction.txid !== coin.txid || !output) {
    throw new Error('independent chain transaction does not contain the expected outpoint');
  }
  if (output.value !== coin.valueSats || output.scriptpubkey !== coin.scriptPubKeyHex) {
    throw new Error('independent chain output differs from the committed value or script');
  }
  if (outspend.spent !== false) throw new Error('independent chain source reports the vault output spent');
  if (!transaction.status?.confirmed || !Number.isSafeInteger(transaction.status.block_height)) {
    throw new Error(`vault output is not confirmed on ${BITCOIN_NETWORK_CONFIG.addressLabel}`);
  }
  if (!Number.isSafeInteger(tip) || tip < transaction.status.block_height!) {
    throw new Error('independent chain source returned an invalid tip height');
  }
  return {
    snapshotDigest: vaultCoinSnapshotDigest(coin),
    sourceOrigin: source.origin,
    confirmations: tip - transaction.status.block_height! + 1,
    observedUnspent: true,
  };
}

function validatedSourceOrigin(sourceOrigin: string): URL {
  const source = new URL(sourceOrigin);
  if (source.origin !== sourceOrigin || source.protocol !== 'https:') {
    throw new Error('chain observation source must be an HTTPS origin');
  }
  return source;
}
