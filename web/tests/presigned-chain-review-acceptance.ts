/** Synthetic independent-source contract tests, not proof of any real chain or HTTP service. */
import assert from 'node:assert/strict';
import * as bitcoin from 'bitcoinjs-lib';
import { BITCOIN_GENESIS_HASH, BITCOIN_NETWORK_NAME } from '../../src/network.js';
import { createPresignedFixture } from '../../src/presigned/fixtures.js';
import { assertPresignedFundingInputCurrent, observePresignedCoin, observePresignedConfirmedSource,
  observePresignedFundingInput, validatedPresignedChainApi } from '../lib/client/presigned-chain.js';

const { graph } = createPresignedFixture({ network: BITCOIN_NETWORK_NAME });
const raw = graph.fundingUnsignedTxHex;
const tx = bitcoin.Transaction.fromHex(raw);
const txid = tx.getId();
const tip = '11'.repeat(32), anchor = '22'.repeat(32), pending = '33'.repeat(32);
const input = { apiUrl: 'https://chain.example/api', txid, vout: 1, allowedOrigins: ['https://chain.example'] };
const checks: string[] = [];
async function check(name: string, test: () => Promise<void> | void) { await test(); checks.push(name); }
interface Variation { raw?: string; genesis?: string; active?: string; afterTip?: string; status?: unknown;
  outspend?: unknown; offline?: boolean; tip?: unknown }
function source(change: Variation = {}) {
  let tipRequests = 0;
  const calls: string[] = [];
  const request: typeof fetch = async (url, options) => {
    assert.equal(options?.credentials, 'omit'); assert.equal(options?.cache, 'no-store');
    assert.equal(options?.redirect, 'error'); assert.equal(options?.referrerPolicy, 'no-referrer');
    assert.equal(options?.headers, undefined); assert(options?.signal);
    const path = String(url).slice(input.apiUrl.length); calls.push(path);
    assert(String(url).startsWith(`${input.apiUrl}/`));
    if (change.offline) throw new Error('synthetic network failure');
    let body: string | undefined;
    if (path === '/blocks/tip/hash') body = (++tipRequests === 1 ? tip : change.afterTip ?? tip);
    else if (path === '/block-height/0') body = change.genesis ?? BITCOIN_GENESIS_HASH;
    else if (path === `/block/${tip}`) body = JSON.stringify(change.tip ?? { id: tip, height: 100 });
    else if (path === `/tx/${txid}/hex`) body = change.raw ?? raw;
    else if (path === `/tx/${txid}/status`) body = JSON.stringify(change.status ?? { confirmed: true, block_hash: anchor, block_height: 95 });
    else if (path === `/tx/${txid}/outspend/1`) body = JSON.stringify(change.outspend ?? { spent: false });
    else if (path === '/block-height/95') body = change.active ?? anchor;
    assert.notEqual(body, undefined, `unexpected synthetic path ${path}`);
    return new Response(body, { status: 200 });
  };
  return { request, calls };
}
await check('funding observation verifies exact native coin and sends no cookies, authorization or referrer', async () => {
  const fixture = source();
  const observed = await observePresignedFundingInput({ ...input, participantId: 'alice', changeScriptPubKeyHex: Buffer.from(tx.outs[1]!.script).toString('hex') }, fixture.request);
  assert.equal(observed.txid, txid); assert.equal(observed.valueSats, Number(tx.outs[1]!.value));
  assert.equal(observed.confirmations, 6); assert.equal(observed.confirmationBlockHash, anchor);
  assert.equal(fixture.calls.length, 8); assert(!('pendingSpendTxid' in observed));
});
await check('same exact coin can reanchor only after a fresh active-chain observation without mutating original commitment', async () => {
  const committed = await observePresignedFundingInput({ ...input, participantId: 'alice', changeScriptPubKeyHex: Buffer.from(tx.outs[1]!.script).toString('hex') }, source().request);
  const unchanged = JSON.stringify(committed);
  assert.equal(assertPresignedFundingInputCurrent(committed, { ...committed }), false);
  const nextAnchor = '44'.repeat(32);
  const observed = await observePresignedFundingInput({ ...input, participantId: 'alice', changeScriptPubKeyHex: committed.changeScriptPubKeyHex },
    source({ active: nextAnchor, status: { confirmed: true, block_hash: nextAnchor, block_height: 95 } }).request);
  assert.equal(assertPresignedFundingInputCurrent(committed, observed), true);
  assert.equal(JSON.stringify(committed), unchanged);
  for (const change of [{ valueSats: committed.valueSats + 1 }, { scriptPubKeyHex: '0014' + '55'.repeat(20) },
    { txid: '66'.repeat(32) }, { vout: 0 }, { confirmations: 5 }, { changeScriptPubKeyHex: null }]) {
    assert.throws(() => assertPresignedFundingInputCurrent(committed, { ...observed, ...change }));
  }
});
await check('pending competitor is reported for runtime sources but rejected for funding and sponsor coins', async () => {
  const variation = { outspend: { spent: true, txid: pending, status: { confirmed: false } } };
  const observed = await observePresignedConfirmedSource(input, source(variation).request);
  assert.equal(observed.pendingSpendTxid, pending); assert.equal(observed.confirmations, 6);
  await assert.rejects(observePresignedCoin(input, source(variation).request), /spent, conflicted/u);
  await assert.rejects(observePresignedFundingInput({ ...input, participantId: 'alice', changeScriptPubKeyHex: null }, source(variation).request), /spent, conflicted/u);
  assert.equal((await observePresignedConfirmedSource(input, source().request)).pendingSpendTxid, null);
});
for (const [label, variation] of Object.entries({
  wrongGenesis: { genesis: '00'.repeat(32) }, inactiveAnchor: { active: '00'.repeat(32) },
  movingTip: { afterTip: '00'.repeat(32) }, wrongTipIdentity: { tip: { id: '00'.repeat(32), height: 100 } },
  unconfirmedParent: { status: { confirmed: false } }, malformedRaw: { raw: 'zz' }, backendError: { offline: true },
  confirmedSpend: { outspend: { spent: true, txid: pending, status: { confirmed: true } } },
  unknownSpend: { outspend: {} }, unknownSpendConfirmation: { outspend: { spent: true, txid: pending } },
  missingPendingTxid: { outspend: { spent: true, status: { confirmed: false } } },
  malformedPendingTxid: { outspend: { spent: true, txid: 'invalid', status: { confirmed: false } } },
}) as Array<[string, Variation]>) await check(`${label} never becomes a usable funding or runtime coin`, async () => {
  await assert.rejects(observePresignedCoin(input, source(variation).request));
  await assert.rejects(observePresignedConfirmedSource(input, source(variation).request));
});
await check('CSP-disallowed and credential-bearing chain URLs are rejected before a request', async () => {
  assert.equal(validatedPresignedChainApi(input.apiUrl, input.allowedOrigins), input.apiUrl);
  for (const url of ['http://chain.example/api', 'https://user:password@chain.example/api',
    'https://chain.example/api?q=1', 'https://chain.example/api#fragment', 'https://blocked.example/api']) {
    let requested = false;
    await assert.rejects(observePresignedCoin({ ...input, apiUrl: url }, async () => { requested = true; throw new Error('must not fetch'); }));
    assert.equal(requested, false);
  }
});
console.log(JSON.stringify({ title: 'Presigned browser chain contract regressions', network: BITCOIN_NETWORK_NAME,
  passed: true, checks, syntheticChainFacts: true, networkContacted: false }, null, 2));
