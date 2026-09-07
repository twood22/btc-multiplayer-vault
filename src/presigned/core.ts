import { Buffer } from 'buffer';
import * as bitcoin from 'bitcoinjs-lib';
import type { BitcoinNetworkName } from '../types.js';
import type { PresignedChainBackend, PresignedChainTip } from './chain.js';
import { assert, genesisHash, hexBytes, safeInteger } from './validation.js';

/** Inject the private Core transport. No endpoint, credentials, or broadcast here. */
export type PresignedCoreRpc = <T = unknown>(method: string, params?: unknown[]) => Promise<T>;

export interface PresignedConfirmedCoin {
  network: BitcoinNetworkName;
  genesisHash: string;
  txid: string;
  vout: number;
  valueSats: number;
  scriptPubKeyHex: string;
  confirmationBlockHash: string;
  confirmations: number;
  unspentInActiveChain: true;
  coinbase: false;
}
export interface PresignedObservedCoin extends PresignedConfirmedCoin { unspent: true }
export type PresignedOutputAvailability = { kind: 'available' | 'mempool-spent' | 'chain-spent' } | { kind: 'unknown' };

interface BlockchainInfo {
  chain: string; blocks: number; bestblockhash: string; pruned: boolean; initialblockdownload: boolean;
}
interface Header { hash: string; height: number; confirmations: number }
interface RawTransaction { txid: string; hex: string; blockhash?: string; confirmations?: number }
interface TxOut { bestblock: string; confirmations: number; value: number; scriptPubKey: { hex: string }; coinbase: boolean }

export function createPresignedCoreBackend(input: {
  network: BitcoinNetworkName; genesisHash: string; rpc: PresignedCoreRpc;
}): PresignedChainBackend & {
  /** Suitable for funding and fresh fee sponsorship; rejects any mempool spend. */
  observeCoin(outpoint: { txid: string; vout: number }): Promise<PresignedObservedCoin>;
  /** For an exit's already confirmed source; does not assert mempool availability. */
  observeConfirmedCoin(outpoint: { txid: string; vout: number }): Promise<PresignedConfirmedCoin>;
  /** Only use for an independently confirmed, known graph output. */
  getOutputAvailability(output: { txid: string; vout: number; valueSats: number; scriptPubKeyHex: string }): Promise<PresignedOutputAvailability>;
} {
  assert(input.genesisHash === genesisHash(input.network), 'Core adapter has wrong genesis binding');
  const { rpc } = input;
  const getTip = async (): Promise<PresignedChainTip> => {
    const info = await rpc<BlockchainInfo>('getblockchaininfo');
    assert(info.chain === (input.network === 'mainnet' ? 'main' : 'signet'), 'Core is on another chain');
    assert(info.pruned === false && info.initialblockdownload === false, 'Core must be non-pruned and synchronized');
    const indexes = await rpc<Record<string, { synced?: boolean }>>('getindexinfo');
    assert(indexes.txindex?.synced === true, 'Core needs a synchronized transaction index');
    assert(await rpc<string>('getblockhash', [0]) === input.genesisHash, 'Core genesis differs from approved network');
    hexBytes(info.bestblockhash, 32, 'Core tip hash');
    safeInteger(info.blocks, 1, 2_000_000, 'Core tip height');
    return { network: input.network, genesisHash: input.genesisHash, hash: info.bestblockhash, height: info.blocks };
  };
  const getBlock = async (hash: string) => {
    hexBytes(hash, 32, 'Core block hash');
    try {
      const header = await rpc<Header>('getblockheader', [hash, true]);
      assert(header.hash === hash, 'Core returned another block');
      safeInteger(header.height, 0, 2_000_000, 'Core block height');
      if (header.confirmations === -1) return { kind: 'inactive' as const, hash, height: header.height };
      safeInteger(header.confirmations, 1, 2_000_000, 'Core block confirmations');
      // Independent hash-at-height check; do not merely echo getrawtransaction's anchor.
      assert(await rpc<string>('getblockhash', [header.height]) === hash, 'Core block is not active at its claimed height');
      return { kind: 'active' as const, hash, height: header.height, confirmations: header.confirmations };
    } catch { return { kind: 'unknown' as const, hash }; }
  };
  const observe = async (outpoint: { txid: string; vout: number }, includeMempool: boolean): Promise<PresignedConfirmedCoin> => {
      hexBytes(outpoint.txid, 32, 'observed coin txid');
      safeInteger(outpoint.vout, 0, 0xffffffff, 'observed coin vout');
      const before = await getTip();
      const coin = await rpc<TxOut | null>('gettxout', [outpoint.txid, outpoint.vout, includeMempool]);
      assert(coin, 'coin is spent, unavailable, or conflicted in the mempool');
      assert(coin.coinbase === false, 'coinbase inputs are not supported by the vault ceremony');
      assert(coin.bestblock === before.hash, 'coin observation spans different chain tips');
      safeInteger(coin.confirmations, 1, 2_000_000, 'coin confirmations');
      const raw = await rpc<RawTransaction>('getrawtransaction', [outpoint.txid, true]);
      assert(raw.txid === outpoint.txid && typeof raw.hex === 'string' && raw.hex.length <= 8_000_000 && raw.blockhash, 'coin lacks an exact confirmed parent');
      const tx = bitcoin.Transaction.fromHex(raw.hex);
      assert(tx.getId() === outpoint.txid && outpoint.vout < tx.outs.length, 'coin parent bytes differ from outpoint');
      const output = tx.outs[outpoint.vout]!;
      const valueSats = btcToSats(coin.value);
      assert(output.value === BigInt(valueSats) && Buffer.from(output.script).toString('hex') === coin.scriptPubKey.hex, 'coin differs from parent output');
      const anchor = await getBlock(raw.blockhash);
      assert(anchor.kind === 'active' && anchor.confirmations === coin.confirmations &&
        before.height - anchor.height + 1 === coin.confirmations, 'coin confirmation anchor is inconsistent');
      const after = await getTip();
      assert(after.hash === before.hash && after.height === before.height, 'chain tip changed during coin observation');
      return { network: input.network, genesisHash: input.genesisHash, txid: outpoint.txid, vout: outpoint.vout,
        valueSats, scriptPubKeyHex: coin.scriptPubKey.hex, confirmationBlockHash: raw.blockhash,
        confirmations: coin.confirmations, unspentInActiveChain: true, coinbase: false };
  };
  return {
    getTip,
    getBlock,
    async getTransaction(txid) {
      hexBytes(txid, 32, 'Core transaction id');
      try {
        const raw = await rpc<RawTransaction>('getrawtransaction', [txid, true]);
        assert(raw.txid === txid && typeof raw.hex === 'string' && raw.hex.length <= 8_000_000, 'Core returned an invalid transaction');
        assert(bitcoin.Transaction.fromHex(raw.hex).getId() === txid, 'Core transaction bytes have another id');
        if (raw.blockhash !== undefined) hexBytes(raw.blockhash, 32, 'Core transaction block');
        return { kind: 'present', txid, transactionHex: raw.hex, blockHash: raw.blockhash ?? null };
      } catch (error) {
        // Only the precise authoritative missing-transaction response is absence.
        const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
        return code === -5 ? { kind: 'absent', txid } : { kind: 'unknown', txid };
      }
    },
    async observeCoin(outpoint) { return { ...await observe(outpoint, true), unspent: true }; },
    async observeConfirmedCoin(outpoint) { return observe(outpoint, false); },
    async getOutputAvailability(output) {
      try {
        hexBytes(output.txid, 32, 'known output txid');
        safeInteger(output.vout, 0, 0xffffffff, 'known output vout');
        const before = await getTip();
        const confirmed = await rpc<TxOut | null>('gettxout', [output.txid, output.vout, false]);
        const mempool = await rpc<TxOut | null>('gettxout', [output.txid, output.vout, true]);
        for (const coin of [confirmed, mempool]) {
          if (!coin) continue;
          assert(coin.bestblock === before.hash && coin.coinbase === false && coin.confirmations >= 1 &&
            btcToSats(coin.value) === output.valueSats && coin.scriptPubKey.hex === output.scriptPubKeyHex,
          'known output availability changed its coin');
        }
        assert(confirmed !== null || mempool === null, 'output has inconsistent confirmed availability');
        const after = await getTip();
        assert(before.hash === after.hash && before.height === after.height, 'output availability crossed chain tips');
        return { kind: confirmed === null ? 'chain-spent' : mempool === null ? 'mempool-spent' : 'available' };
      } catch { return { kind: 'unknown' }; }
    },
  };
}

function btcToSats(value: number): number {
  const sats = Math.round(value * 1e8);
  safeInteger(sats, 1, 2_100_000_000_000_000, 'Core coin value');
  assert(Number.isFinite(value) && Math.abs(value - sats / 1e8) < 1e-12, 'Core coin value is not exact satoshis');
  return sats;
}
