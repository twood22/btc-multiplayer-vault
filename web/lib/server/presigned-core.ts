import 'server-only';
import { readFileSync, statSync } from 'node:fs';
import { BITCOIN_GENESIS_HASH, BITCOIN_NETWORK_NAME, DEFAULT_BITCOIN_RPC_URL } from '../../../src/network';
import { createPresignedCoreBackend, type PresignedCoreRpc } from '../../../src/presigned/core';
import type { PresignedAction } from '../../../src/presigned/ceremony';
import { assert } from '../../../src/presigned/validation';
import type { PresignedActionDependencies } from './presigned-store';
import { getPresignedCeremonyStatus } from './presigned-store';
import type { PresignedRuntimeActionDependencies } from './presigned-runtime-store';
import { chainConfirmationsRequired } from './config';

/** Private authenticated Core only. No explorer fallback or credential-bearing errors. */
export const presignedCoreRpc: PresignedCoreRpc = async <T>(method: string, params: unknown[] = []): Promise<T> => {
  const endpoint = new URL(process.env.BITCOIN_RPC_URL || DEFAULT_BITCOIN_RPC_URL);
  assert(['http:', 'https:'].includes(endpoint.protocol) && !endpoint.username && !endpoint.password &&
    !endpoint.search && !endpoint.hash, 'private Core endpoint configuration is invalid');
  assert(endpoint.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname),
    'remote private Core RPC requires HTTPS; cleartext is allowed only on loopback');
  const username = process.env.BITCOIN_RPC_USER || process.env.BITCOIN_RPC_USERNAME;
  const password = process.env.BITCOIN_RPC_PASSWORD;
  assert(Boolean(username) === Boolean(password), 'private Core needs both RPC username and password');
  const cookieFile = process.env.BITCOIN_RPC_COOKIE_FILE;
  assert(!(cookieFile && username), 'private Core must use either a cookie file or username/password');
  let credential = username ? `${username}:${password}` : null;
  if (cookieFile) {
    assert(cookieFile.startsWith('/'), 'private Core cookie file must be absolute');
    const metadata = statSync(cookieFile);
    assert(metadata.isFile() && metadata.size <= 1024 && (metadata.mode & 0o077) === 0 &&
      (process.getuid === undefined || metadata.uid === process.getuid()), 'private Core cookie must be an owner-only regular file');
    credential = readFileSync(cookieFile, 'utf8').trim();
    assert(/^__cookie__:[0-9a-f]{32,256}$/u.test(credential), 'private Core cookie is malformed');
  }
  assert(credential, 'private Core RPC authentication is required');
  try {
    const response = await fetch(endpoint, { method: 'POST', cache: 'no-store',
      headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(credential).toString('base64')}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'presigned-vault', method, params }),
      signal: AbortSignal.timeout(15_000), redirect: 'error',
    });
    const body = await response.json() as { result?: T; error?: { code?: unknown } | null };
    if (!response.ok || body.error) {
      const code = typeof body.error?.code === 'number' ? body.error.code : undefined;
      throw Object.assign(new Error(`private Core ${method} rejected the request${code === undefined ? '' : ` (code ${code})`}`), { code });
    }
    return body.result as T;
  } catch (error) {
    const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
    throw Object.assign(new Error(`private Core ${method} is unavailable or rejected the request${typeof code === 'number' ? ` (code ${code})` : ''}`),
      { code: typeof code === 'number' ? code : undefined });
  }
};

export function presignedCoreBackend() {
  return createPresignedCoreBackend({ network: BITCOIN_NETWORK_NAME, genesisHash: BITCOIN_GENESIS_HASH, rpc: presignedCoreRpc });
}

export const presignedActionDependencies: PresignedActionDependencies = {
  async verifyFundingInput({ network, genesisHash, input }) {
    assert(network === BITCOIN_NETWORK_NAME && genesisHash === BITCOIN_GENESIS_HASH, 'funding input belongs to another network');
    const { unspentInActiveChain: _active, coinbase: _coinbase, ...observed } = await presignedCoreBackend().observeCoin(input);
    return observed;
  },
};

export function presignedRuntimeActionDependencies(): PresignedRuntimeActionDependencies {
  return { requiredConfirmations: chainConfirmationsRequired(),
    async observeCoin({ network, genesisHash, source }) {
      assert(network === BITCOIN_NETWORK_NAME && genesisHash === BITCOIN_GENESIS_HASH, 'runtime source belongs to another network');
      return presignedCoreBackend().observeConfirmedCoin(source);
    } };
}

/** Revalidate the frozen inputs before either signature-release HTTP stage. */
export async function assertPresignedFundingInputsCurrent(userId: string, action: PresignedAction): Promise<void> {
  if (!['begin-wallet-signing', 'submit-funding-signature', 'approve-funding'].includes(action.kind)) return;
  const status = await getPresignedCeremonyStatus(userId);
  assert('epochId' in action && status.epoch?.epochId === action.epochId && status.epoch.graph,
    'wallet action changed the current funding epoch');
  const core = presignedCoreBackend();
  for (const committed of status.epoch.graph.funding.inputs) {
    const observed = await core.observeCoin(committed);
    // This block hash records initial input selection, not a Bitcoin transaction
    // or sighash field. An identical input may re-confirm in a different block;
    // preserve the frozen graph while freshly proving the exact active coin.
    assert(observed.valueSats === committed.valueSats && observed.scriptPubKeyHex === committed.scriptPubKeyHex &&
      observed.confirmations >= committed.confirmations,
    'funding input changed or lost its required active-chain confirmation depth');
  }
}
