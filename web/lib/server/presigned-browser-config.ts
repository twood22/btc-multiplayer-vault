import 'server-only';
import { BITCOIN_NETWORK_CONFIG } from '../../../src/network';
import { assert } from '../../../src/presigned/validation';
import { chainObservationOrigins } from './config';

/** Expose only the public HTTPS chain allowlist, never private Core configuration. */
export function presignedBrowserChainConfig(): { apiUrl: string; allowedOrigins: string[] } {
  const allowedOrigins = chainObservationOrigins();
  const configured = process.env.PRESIGNED_CHAIN_API_URL;
  const candidate = configured || BITCOIN_NETWORK_CONFIG.defaultEsploraUrl;
  const url = new URL(candidate);
  assert(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash,
    'PRESIGNED_CHAIN_API_URL must be a public HTTPS base URL without credentials, query or fragment');
  if (configured) assert(allowedOrigins.includes(url.origin), 'PRESIGNED_CHAIN_API_URL is blocked by CHAIN_OBSERVATION_ORIGINS');
  // A custom origin does not reveal its Esplora path. Ask for that base URL rather than guess or use a blocked default.
  return { apiUrl: allowedOrigins.includes(url.origin) ? url.href.replace(/\/$/u, '') : '', allowedOrigins };
}
