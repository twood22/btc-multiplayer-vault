import * as bitcoin from 'bitcoinjs-lib';
import type { BitcoinNetworkName } from './types.js';

/**
 * The user-facing product is mainnet-only. Keep every Bitcoin and Sigbash
 * network decision here so an accidental non-mainnet default cannot produce a
 * different address or transaction on one code path.
 */
export const BITCOIN_NETWORK = bitcoin.networks.bitcoin;
export const BITCOIN_NETWORK_NAME: BitcoinNetworkName = 'mainnet';
export const BITCOIN_CORE_CHAIN = 'main' as const;
export const DEFAULT_BITCOIN_RPC_URL = 'http://127.0.0.1:8332';
export const DEFAULT_ESPLORA_URL = 'https://mempool.space/api';
export const MAINNET_GENESIS_HASH =
  '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f' as const;

export function assertMainnetChain(chain: string): void {
  if (chain !== BITCOIN_CORE_CHAIN) {
    throw new Error(`configured Bitcoin backend is on chain ${JSON.stringify(chain)}, not mainnet`);
  }
}
