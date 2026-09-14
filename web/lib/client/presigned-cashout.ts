'use client';
import { Buffer } from 'buffer';
import * as bitcoin from 'bitcoinjs-lib';
import { BITCOIN_GENESIS_HASH, BITCOIN_NETWORK_NAME } from '../../../src/network';
import { authorizePresignedCashoutTransaction, type PresignedCashoutRequest } from '../../../src/presigned/cashout';
import { payoutScript } from '../../../src/presigned/roster';
import type { PresignedParticipant, PresignedProtocol, PresignedPublicKit } from '../../../src/presigned/types';
import { assert, hexBytes, identifier, networkParameters, safeInteger, validatePresignedProtocol } from '../../../src/presigned/validation';
import type { PresignedCashoutStatus, PresignedSignedCashout } from '../server/presigned-cashout-store';
import { observePresignedCoin, validatedPresignedChainApi } from './presigned-chain';

export type CashoutIdentity = Pick<PresignedParticipant, 'id' | 'personalPublicKeyHex' | 'payoutXonlyPublicKeyHex'>;
export interface CashoutCoin { txid: string; vout: number; valueSats: number }
type ChainInput = { apiUrl: string; allowedOrigins: readonly string[] };

/** The payout identity was enrolled independently of coordinator status. */
export function assertCashoutOwner(kit: PresignedPublicKit, expected: {
  vaultId: string; protocol: PresignedProtocol; ownIdentity: CashoutIdentity;
}): PresignedParticipant {
  const owner = kit.graph.roster.participants.find(item => item.id === expected.ownIdentity.id);
  assert(kit.protocol === expected.protocol && kit.graph.roster.vaultId === expected.vaultId &&
    kit.graph.roster.network === BITCOIN_NETWORK_NAME && owner &&
    owner.personalPublicKeyHex === expected.ownIdentity.personalPublicKeyHex &&
    owner.payoutXonlyPublicKeyHex === expected.ownIdentity.payoutXonlyPublicKeyHex,
  'Cash-out kit differs from your enrolled payout identity, vault, protocol or network');
  return owner;
}

/** Discovery is a convenience only. Each chosen coin is independently reverified before signing. */
export async function discoverCashoutCoins(input: ChainInput & { publicKit: PresignedPublicKit; participantId: CashoutIdentity['id'] },
  request: typeof fetch = fetch): Promise<CashoutCoin[]> {
  const address = bitcoin.address.fromOutputScript(payoutScript(input.publicKit.graph.roster, input.participantId),
    networkParameters(input.publicKit.graph.roster.network));
  const raw = await chainText(input, `/address/${address}/utxo`, 200_000, request);
  const items = JSON.parse(raw) as Array<{ txid: string; vout: number; value: number; status: { confirmed: boolean } }>;
  assert(Array.isArray(items) && items.length <= 1000, 'Payout coin discovery exceeds the supported bound');
  const confirmed = items.filter(item => item.status?.confirmed === true).map(item => {
    hexBytes(item.txid, 32, 'payout transaction'); safeInteger(item.vout, 0, 0xffffffff, 'payout output');
    safeInteger(item.value, 1, 2_100_000_000_000_000, 'payout value');
    return { txid: item.txid, vout: item.vout, valueSats: item.value };
  });
  assert(new Set(confirmed.map(item => `${item.txid}:${item.vout}`)).size === confirmed.length, 'Payout discovery repeats a coin');
  return confirmed;
}

export async function observeCashoutSource(input: ChainInput & { txid: string; vout: number; requiredConfirmations: number },
  request: typeof fetch = fetch): Promise<Pick<PresignedCashoutRequest, 'sourceObservation' | 'parentTransactionHex'>> {
  const sourceObservation = await observePresignedCoin(input, request);
  assert(sourceObservation.confirmations >= input.requiredConfirmations, `Your payout needs ${input.requiredConfirmations} confirmations`);
  const parentTransactionHex = (await chainText(input, `/tx/${input.txid}/hex`, 800_000, request)).trim();
  assert(/^(?:[0-9a-f]{2})+$/u.test(parentTransactionHex), 'Payout parent has invalid transaction bytes');
  const tx = bitcoin.Transaction.fromHex(parentTransactionHex); const output = tx.outs[input.vout];
  assert(tx.toHex() === parentTransactionHex && tx.getId() === sourceObservation.txid && output &&
    Number(output.value) === sourceObservation.valueSats && Buffer.from(output.script).toString('hex') === sourceObservation.scriptPubKeyHex,
  'Payout parent changed after independent observation');
  return { sourceObservation: { ...sourceObservation, network: BITCOIN_NETWORK_NAME, genesisHash: BITCOIN_GENESIS_HASH,
    unspentInActiveChain: true, coinbase: false }, parentTransactionHex };
}

/** Last-observed labels are presentation only; the immutable owner-signed bytes establish authority. */
export function verifyCashoutStatus(value: PresignedCashoutStatus, expected: {
  vaultId: string; protocol: PresignedProtocol; ownIdentity: CashoutIdentity;
}): PresignedCashoutStatus {
  validatePresignedProtocol(value.version, value.protocol);
  assert(value.protocol === expected.protocol && value.vaultId === expected.vaultId &&
    value.participantId === expected.ownIdentity.id && typeof value.broadcastAvailable === 'boolean' &&
    value.chainAuthority === 'last-observed-not-live' && Array.isArray(value.intents) && value.intents.length <= 32,
  'Cash-out status changed its membership or bounds');
  const ids = new Set<string>();
  for (const intent of value.intents) {
    identifier(intent.cashoutId, 'cash-out intent'); assert(!ids.has(intent.cashoutId), 'Cash-out status repeats an intent'); ids.add(intent.cashoutId);
    verifySignedCashout(intent.artifact, expected);
    assert(intent.txid === intent.artifact.cashout.txid &&
      ['approved','prepared','submitting','pending','confirmed','spent','deferred'].includes(intent.status), 'Cash-out status changed signed bytes');
    assert(intent.reason === null || (typeof intent.reason === 'string' && intent.reason.length <= 2000), 'Cash-out status reason is oversized');
    if (intent.status === 'confirmed') { hexBytes(intent.confirmationBlockHash!, 32, 'observed cash-out confirmation');
      safeInteger(intent.confirmationHeight!, 1, 2_000_000, 'observed cash-out height'); }
  }
  return value;
}

export function verifySignedCashout(value: PresignedSignedCashout, expected: {
  vaultId: string; protocol: PresignedProtocol; ownIdentity: CashoutIdentity;
}): PresignedSignedCashout {
  assert(value && typeof value === 'object' && Object.keys(value).sort().join(',') === 'cashout,request,transactionHex', 'Invalid signed cash-out file');
  authorizePresignedCashoutTransaction(value);
  assertCashoutOwner(value.request.publicKit, expected);
  assert(value.cashout.participantId === expected.ownIdentity.id && value.request.participantId === expected.ownIdentity.id,
    'Cash-out belongs to another payout owner');
  return value;
}

async function chainText(input: ChainInput, path: string, limit: number, request: typeof fetch): Promise<string> {
  const base = validatedPresignedChainApi(input.apiUrl, input.allowedOrigins);
  const response = await request(`${base}${path}`, { credentials: 'omit', cache: 'no-store', redirect: 'error',
    signal: AbortSignal.timeout(15_000), referrerPolicy: 'no-referrer' });
  assert(response.ok, 'Independent payout source is unavailable');
  const reader = response.body?.getReader(); assert(reader, 'Independent payout source has no body');
  const decoder = new TextDecoder('utf-8', { fatal: true }); let size = 0; let text = '';
  try { for (;;) { const chunk = await reader.read(); if (chunk.done) break;
    size += chunk.value.byteLength; assert(size <= limit, 'Independent payout response is too large');
    text += decoder.decode(chunk.value, { stream: true }); }
    return text + decoder.decode();
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
