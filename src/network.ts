import * as bitcoin from 'bitcoinjs-lib';
import type { BitcoinNetworkName } from './types.js';

export interface BitcoinNetworkConfig {
  name: BitcoinNetworkName;
  bitcoinjs: typeof bitcoin.networks.bitcoin;
  coreChain: 'main' | 'signet';
  defaultRpcUrl: string;
  defaultEsploraUrl: string;
  genesisHash: string;
  bip32PublicPrefix: 'xpub' | 'tpub';
  addressLabel: 'mainnet' | 'default global Signet';
}

const NETWORK_CONFIGS: Record<BitcoinNetworkName, BitcoinNetworkConfig> = {
  mainnet: {
    name: 'mainnet',
    bitcoinjs: bitcoin.networks.bitcoin,
    coreChain: 'main',
    defaultRpcUrl: 'http://127.0.0.1:8332',
    defaultEsploraUrl: 'https://mempool.space/api',
    genesisHash: '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f',
    bip32PublicPrefix: 'xpub',
    addressLabel: 'mainnet',
  },
  signet: {
    name: 'signet',
    // BitcoinJS uses the same address, WIF, and BIP32 version bytes for
    // testnet and Signet. Chain identity is enforced independently below.
    bitcoinjs: bitcoin.networks.testnet,
    coreChain: 'signet',
    defaultRpcUrl: 'http://127.0.0.1:38332',
    defaultEsploraUrl: 'https://mempool.space/signet/api',
    genesisHash: '00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6',
    bip32PublicPrefix: 'tpub',
    addressLabel: 'default global Signet',
  },
};

function configuredNetworkName(): BitcoinNetworkName {
  const privateValue = typeof process === 'undefined' ? undefined : process.env.VAULT_NETWORK;
  const publicValue = typeof process === 'undefined'
    ? undefined
    : process.env.NEXT_PUBLIC_VAULT_NETWORK;
  if (privateValue && publicValue && privateValue !== publicValue) {
    throw new Error('VAULT_NETWORK and NEXT_PUBLIC_VAULT_NETWORK must match exactly');
  }
  const value = privateValue || publicValue || 'mainnet';
  if (value !== 'mainnet' && value !== 'signet') {
    throw new Error('vault network must be exactly "mainnet" or "signet"');
  }
  return value;
}

export const BITCOIN_NETWORK_CONFIG = NETWORK_CONFIGS[configuredNetworkName()];
export const BITCOIN_NETWORK = BITCOIN_NETWORK_CONFIG.bitcoinjs;
export const BITCOIN_NETWORK_NAME = BITCOIN_NETWORK_CONFIG.name;
export const BITCOIN_CORE_CHAIN = BITCOIN_NETWORK_CONFIG.coreChain;
export const DEFAULT_BITCOIN_RPC_URL = BITCOIN_NETWORK_CONFIG.defaultRpcUrl;
export const DEFAULT_ESPLORA_URL = BITCOIN_NETWORK_CONFIG.defaultEsploraUrl;
export const BITCOIN_GENESIS_HASH = BITCOIN_NETWORK_CONFIG.genesisHash;
export const MAINNET_GENESIS_HASH = NETWORK_CONFIGS.mainnet.genesisHash;
export const SIGNET_GENESIS_HASH = NETWORK_CONFIGS.signet.genesisHash;

export function assertConfiguredChain(chain: string): void {
  if (chain !== BITCOIN_CORE_CHAIN) {
    throw new Error(
      `configured Bitcoin backend is on chain ${JSON.stringify(chain)}, not ${BITCOIN_NETWORK_CONFIG.addressLabel}`,
    );
  }
}

/** Backwards-compatible name retained while callers migrate to the typed boundary. */
export const assertMainnetChain = assertConfiguredChain;
