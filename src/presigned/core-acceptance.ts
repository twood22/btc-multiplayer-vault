import assert from 'node:assert/strict';
import * as bitcoin from 'bitcoinjs-lib';
import { BITCOIN_CORE_CHAIN, BITCOIN_NETWORK_NAME } from '../network.js';
import { createPresignedCoreBackend, type PresignedCoreRpc } from './core.js';
import { createPresignedFixture, signPresignedFixtureFunding } from './fixtures.js';

// Synthetic transport-contract checks. Actual Core evidence is collected by
// web/tests/presigned-chain-broadcast-db-acceptance.ts; do not conflate the two.
const fixture = createPresignedFixture({ network: BITCOIN_NETWORK_NAME });
const completed = signPresignedFixtureFunding(fixture);
const tx = bitcoin.Transaction.fromHex(completed.transactionHex);
const tip = '55'.repeat(32); const block = '44'.repeat(32);
const outpoint = { txid: completed.txid, vout: 0 };
const output = { ...outpoint, valueSats: Number(tx.outs[0]!.value), scriptPubKeyHex: Buffer.from(tx.outs[0]!.script).toString('hex') };
type Override = (method: string, params: unknown[], result: any) => any;
function backend(override: Override = (_method, _params, result) => result) {
  const rpc: PresignedCoreRpc = async <T>(method: string, params: unknown[] = []): Promise<T> => {
    let result: any;
    if (method === 'getblockchaininfo') result = { chain: BITCOIN_CORE_CHAIN, blocks: 100, bestblockhash: tip, pruned: false, initialblockdownload: false };
    else if (method === 'getindexinfo') result = { txindex: { synced: true } };
    else if (method === 'getblockhash') result = params[0] === 0 ? fixture.roster.genesisHash : block;
    else if (method === 'getblockheader') result = { hash: block, height: 95, confirmations: 6 };
    else if (method === 'getrawtransaction') result = { txid: completed.txid, hex: completed.transactionHex, blockhash: block, confirmations: 6 };
    else if (method === 'gettxout') result = { bestblock: tip, confirmations: 6, value: output.valueSats / 1e8,
      scriptPubKey: { hex: output.scriptPubKeyHex }, coinbase: false };
    else throw new Error('unexpected synthetic RPC');
    return await override(method, params, result) as T;
  };
  return createPresignedCoreBackend({ network: BITCOIN_NETWORK_NAME, genesisHash: fixture.roster.genesisHash, rpc });
}
const cases: string[] = [];
const good = backend();
assert.equal((await good.getTip()).hash, tip);
assert.equal((await good.getTransaction(completed.txid)).kind, 'present');
assert.equal((await good.observeCoin(outpoint)).unspent, true);
assert.equal((await good.observeConfirmedCoin(outpoint)).unspentInActiveChain, true);
assert.equal((await good.getOutputAvailability(output)).kind, 'available');
cases.push('exact synchronized non-pruned indexed network, raw parent and independently active anchor accepted');

for (const [label, override] of [
  ['network', (m, _p, r) => m === 'getblockchaininfo' ? { ...r, chain: BITCOIN_CORE_CHAIN === 'main' ? 'signet' : 'main' } : r],
  ['pruned', (m, _p, r) => m === 'getblockchaininfo' ? { ...r, pruned: true } : r],
  ['initial-sync', (m, _p, r) => m === 'getblockchaininfo' ? { ...r, initialblockdownload: true } : r],
  ['index-missing', (m, _p, r) => m === 'getindexinfo' ? {} : r],
  ['index-unsynced', (m, _p, r) => m === 'getindexinfo' ? { txindex: { synced: false } } : r],
  ['genesis', (m, p, r) => m === 'getblockhash' && p[0] === 0 ? '66'.repeat(32) : r],
] as Array<[string, Override]>) {
  await assert.rejects(() => backend(override).getTip()); cases.push(`reject-${label}`);
}
for (const [label, override] of [
  ['spent', (m, _p, r) => m === 'gettxout' ? null : r],
  ['coinbase', (m, _p, r) => m === 'gettxout' ? { ...r, coinbase: true } : r],
  ['value', (m, _p, r) => m === 'gettxout' ? { ...r, value: r.value + 0.00000001 } : r],
  ['fractional-satoshi', (m, _p, r) => m === 'gettxout' ? { ...r, value: r.value + 0.000000001 } : r],
  ['script', (m, _p, r) => m === 'gettxout' ? { ...r, scriptPubKey: { hex: '51' } } : r],
  ['coin-tip', (m, _p, r) => m === 'gettxout' ? { ...r, bestblock: block } : r],
  ['raw-id', (m, _p, r) => m === 'getrawtransaction' ? { ...r, txid: '66'.repeat(32) } : r],
  ['raw-bytes', (m, _p, r) => m === 'getrawtransaction' ? { ...r, hex: '00' } : r],
  ['unconfirmed-parent', (m, _p, r) => m === 'getrawtransaction' ? { ...r, blockhash: undefined } : r],
  ['orphan', (m, _p, r) => m === 'getblockheader' ? { ...r, confirmations: -1 } : r],
  ['anchor-depth', (m, _p, r) => m === 'getblockheader' ? { ...r, confirmations: 5 } : r],
  ['active-height', (m, p, r) => m === 'getblockhash' && p[0] !== 0 ? '66'.repeat(32) : r],
] as Array<[string, Override]>) {
  await assert.rejects(() => backend(override).observeCoin(outpoint)); cases.push(`reject-${label}`);
}
let calls = 0;
await assert.rejects(() => backend((m, _p, r) => m === 'getblockchaininfo' && ++calls === 2
  ? { ...r, blocks: 101, bestblockhash: '66'.repeat(32) } : r).observeCoin(outpoint));
cases.push('reject-tip-moving-during-coin-observation');

for (const [code, expected] of [[-5, 'absent'], [-28, 'unknown'], [undefined, 'unknown']] as const) {
  const instance = backend((m, _p, r) => { if (m === 'getrawtransaction') throw Object.assign(new Error('synthetic unavailable'), { code }); return r; });
  assert.equal((await instance.getTransaction(completed.txid)).kind, expected);
  cases.push(`transaction-error-${String(code)}-${expected}`);
}
assert.equal((await backend((m, _p, r) => m === 'getrawtransaction' ? { ...r, hex: '00' } : r).getTransaction(completed.txid)).kind, 'unknown');
assert.equal((await backend((m, _p, r) => m === 'getblockheader' ? { ...r, confirmations: -1 } : r).getBlock(block)).kind, 'inactive');
assert.equal((await backend((m, _p, r) => { if (m === 'getblockheader') throw new Error('synthetic timeout'); return r; }).getBlock(block)).kind, 'unknown');
cases.push('invalid-raw-and-unknown-headers-never-become-absence-or-active');

const pending = backend((m, p, r) => m === 'gettxout' && p[2] === true ? null : r);
await assert.rejects(() => pending.observeCoin(outpoint));
assert.equal((await pending.observeConfirmedCoin(outpoint)).unspentInActiveChain, true);
assert.equal((await pending.getOutputAvailability(output)).kind, 'mempool-spent');
assert.equal((await backend((m, _p, r) => m === 'gettxout' ? null : r).getOutputAvailability(output)).kind, 'chain-spent');
assert.equal((await backend((m, _p, r) => { if (m === 'gettxout') throw new Error('synthetic timeout'); return r; }).getOutputAvailability(output)).kind, 'unknown');
assert.equal((await backend((m, p, r) => m === 'gettxout' && p[2] === false ? null : r).getOutputAvailability(output)).kind, 'unknown');
assert.equal((await good.getOutputAvailability({ ...output, valueSats: output.valueSats + 1 })).kind, 'unknown');
cases.push('mempool-conflict-does-not-block-confirmed-source; spent-versus-unknown-stays-explicit');
console.log(JSON.stringify({ passed: true, network: BITCOIN_NETWORK_NAME, cases: cases.length,
  evidence: 'synthetic-private-Core-contract', liveSignet: false, results: cases }, null, 2));
