'use client';
import { Buffer } from 'buffer';
import * as bitcoin from 'bitcoinjs-lib';
import { BITCOIN_GENESIS_HASH, BITCOIN_NETWORK_CONFIG, BITCOIN_NETWORK_NAME } from '../../../src/network';
import { assert, hexBytes, safeInteger, supportedWalletScript } from '../../../src/presigned/validation';
import type { PresignedFundingInput, ParticipantId } from '../../../src/presigned/types';

export const DEFAULT_PRESIGNED_CHAIN_API = BITCOIN_NETWORK_CONFIG.defaultEsploraUrl;
type ChainFetch = typeof fetch;

/** The participant browser contacts its chosen independent source directly. */
export async function observePresignedFundingInput(input: {
  apiUrl: string; participantId: ParticipantId; txid: string; vout: number;
  changeScriptPubKeyHex: string | null; allowedOrigins?: readonly string[];
}, request: ChainFetch = fetch): Promise<PresignedFundingInput> {
  const observed = await observePresignedCoin(input, request);
  assert(supportedWalletScript(observed.scriptPubKeyHex), 'funding needs a native P2WPKH or P2TR wallet coin');
  return { participantId: input.participantId, ...observed, changeScriptPubKeyHex: input.changeScriptPubKeyHex };
}

/** Independent, active-block-anchored, mempool-aware coin observation. */
export async function observePresignedCoin(input: { apiUrl: string; txid: string; vout: number; allowedOrigins?: readonly string[] },
  request: ChainFetch = fetch) {
  const { pendingSpendTxid: _pending, ...coin } = await observeCoinFacts(input, false, request);
  return coin;
}

/** Runtime-only active-chain source check. An unconfirmed competing spend is reported, never
 * treated as a confirmed exit or as permission to alter the approved source/CSV-age predicates. */
export async function observePresignedConfirmedSource(input: {
  apiUrl: string; txid: string; vout: number; allowedOrigins?: readonly string[];
}, request: ChainFetch = fetch) {
  return observeCoinFacts(input, true, request);
}

async function observeCoinFacts(input: { apiUrl: string; txid: string; vout: number; allowedOrigins?: readonly string[] },
  allowPendingSpend: boolean, request: ChainFetch) {
  hexBytes(input.txid, 32, 'independent coin txid');
  safeInteger(input.vout, 0, 0xffffffff, 'independent coin vout');
  const base = validatedPresignedChainApi(input.apiUrl, input.allowedOrigins);
  const get = async (path: string) => {
    const response = await request(`${base}${path}`, { cache: 'no-store', credentials: 'omit',
      redirect: 'error', signal: AbortSignal.timeout(15_000), referrerPolicy: 'no-referrer' });
    assert(response.ok, 'independent chain source is unavailable or lacks the requested data');
    return response;
  };
  const tipHash = (await (await get('/blocks/tip/hash')).text()).trim();
  hexBytes(tipHash, 32, 'independent chain tip');
  const [genesis, tip, raw, transaction, outspend] = await Promise.all([
    get('/block-height/0').then(result => result.text()),
    get(`/block/${tipHash}`).then(result => result.json() as Promise<{ id: string; height: number }>),
    get(`/tx/${input.txid}/hex`).then(result => result.text()),
    get(`/tx/${input.txid}/status`).then(result => result.json() as Promise<{ confirmed: boolean; block_hash: string; block_height: number }>),
    get(`/tx/${input.txid}/outspend/${input.vout}`).then(result => result.json() as Promise<{
      spent: boolean; txid?: string; status?: { confirmed?: boolean };
    }>),
  ]);
  assert(genesis.trim() === BITCOIN_GENESIS_HASH, `independent chain source is not ${BITCOIN_NETWORK_NAME}`);
  assert(tip.id === tipHash, 'independent source changed its tip identity');
  safeInteger(tip.height, 1, 2_000_000, 'independent tip height');
  assert(typeof raw === 'string' && raw.trim().length <= 1_000_000 && /^(?:[0-9a-f]{2})+$/u.test(raw.trim()), 'independent source returned malformed transaction bytes');
  const tx = bitcoin.Transaction.fromHex(raw.trim());
  assert(tx.getId() === input.txid && input.vout < tx.outs.length, 'independent transaction bytes differ from requested outpoint');
  assert(!tx.isCoinbase(), 'coinbase coins are not supported for vault funding or sponsorship');
  let pendingSpendTxid: string | null = null;
  if (outspend.spent !== false) {
    assert(allowPendingSpend && outspend.spent === true && outspend.status?.confirmed === false,
      'independent source reports that the coin is spent, conflicted or has unknown spend status');
    hexBytes(outspend.txid!, 32, 'independent pending spender txid');
    pendingSpendTxid = outspend.txid!;
  }
  assert(transaction.confirmed === true, 'coin is not confirmed on the independently observed chain');
  hexBytes(transaction.block_hash, 32, 'independent confirmation block');
  safeInteger(transaction.block_height, 1, tip.height, 'independent confirmation height');
  const [activeHash, afterHash] = await Promise.all([
    get(`/block-height/${transaction.block_height}`).then(result => result.text()),
    get('/blocks/tip/hash').then(result => result.text()),
  ]);
  assert(activeHash.trim() === transaction.block_hash, 'independent source confirmation block is not active');
  assert(afterHash.trim() === tipHash, 'independent source tip changed during coin observation; retry');
  const output = tx.outs[input.vout]!;
  const valueSats = Number(output.value);
  safeInteger(valueSats, 1, 2_100_000_000_000_000, 'independent coin value');
  return { txid: input.txid, vout: input.vout, valueSats,
    scriptPubKeyHex: Buffer.from(output.script).toString('hex'),
    confirmationBlockHash: transaction.block_hash, confirmations: tip.height - transaction.block_height + 1, pendingSpendTxid };
}

export function validatedPresignedChainApi(value: string, allowedOrigins?: readonly string[]): string {
  const url = new URL(value);
  assert(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash,
    'independent chain API must be an HTTPS URL without credentials, query or fragment');
  assert(typeof window === 'undefined' || url.origin !== window.location.origin,
    'chain source must be independent of this coordinator');
  if (allowedOrigins) assert(allowedOrigins.includes(url.origin), 'chain API origin is not allowed by this deployment CSP');
  return url.href.replace(/\/$/u, '');
}

/** Compare a FRESH independent observation, not client/coordinator JSON. The original confirmation
 * anchor is an audit fact, not a funding sighash or CSV predicate. A reanchor never mutates the graph. */
export function assertPresignedFundingInputCurrent(committed: PresignedFundingInput, observed: PresignedFundingInput): boolean {
  assert(observed.participantId === committed.participantId && observed.txid === committed.txid &&
    observed.vout === committed.vout && observed.valueSats === committed.valueSats &&
    observed.scriptPubKeyHex === committed.scriptPubKeyHex && observed.changeScriptPubKeyHex === committed.changeScriptPubKeyHex,
  'a frozen funding input changed its exact outpoint, value, script or approved change');
  safeInteger(observed.confirmations, committed.confirmations, 2_000_000, 'fresh funding confirmations');
  hexBytes(observed.confirmationBlockHash, 32, 'fresh active funding anchor');
  return observed.confirmationBlockHash !== committed.confirmationBlockHash;
}
