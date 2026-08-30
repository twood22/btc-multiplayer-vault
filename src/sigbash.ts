import { assertNonDefaultSeed } from './config.js';
import { BITCOIN_NETWORK_NAME } from './network.js';
import { sigbashConditionConfig } from './sigbash-policy.js';
import type { PolicyCondition, PolicyNode, PolicyTx, SoloPolicy } from './types.js';

// The live SDK is imported dynamically (it needs WASM + credentials), so its
// surface is typed here rather than pulled from the package at build time.
export interface SigbashSdk {
  loadWasm(options: LoadWasmOptions): Promise<void>;
  SigbashClient: new (options: {
    serverUrl: string;
    apiKey: string;
    userKey: string;
    userSecretKey: string;
    musig2PrivateKey?: string | Uint8Array;
  }) => SigbashLiveClient;
  conditionConfigToPoetPolicy(config: unknown): PoetPolicy;
  SDK_VERSION?: string;
}

interface LoadWasmOptions {
  wasmUrl: string;
  expectedHash?: string;
}

export interface PoetPolicy {
  version: string;
  policy?: { operator?: string; children?: unknown[] };
}

export interface SigbashKeyListItem {
  keyId: string;
  network: string;
  policyRoot: string;
  require2FA: boolean;
  createdAt: string | null;
  bip328Xpub: string;
  poetJSON: object;
}

export interface SigbashRecoveryKit {
  version: 'sdk-recovery-v1';
  keyId: string;
  recoveryKEK: string;
  cekCiphertext: string;
  cekNonce: string;
  network: string;
  createdAt: number;
  apiKey?: string;
  userKey?: string;
  popSeed?: string;
}

export interface SigbashLiveClient {
  createKey(options: {
    policy: PoetPolicy;
    network: string;
    require2FA: boolean;
    keyIndex?: number;
    verbose?: boolean;
    updateable?: boolean;
  }): Promise<{
    keyId: string;
    keyIndex: number;
    policyRoot: string;
    bip328Xpub?: string;
    aggregatePubKeyHex?: string;
    p2trAddress?: string;
  }>;
  listKeys(): Promise<SigbashKeyListItem[]>;
  exportRecoveryKit(
    keyId: string,
    opts?: { keyIndex?: number },
  ): Promise<SigbashRecoveryKit>;
  getKey(keyId: string, opts?: { verbose?: boolean; keyIndex?: number }): Promise<{ kmcJSON: string }>;
  verifyPSBT(options: {
    psbtBase64: string;
    kmcJSON: string;
    network: string;
  }): Promise<SigbashVerifyResult>;
  signPSBT(options: {
    keyId: string;
    psbtBase64: string;
    kmcJSON: string;
    network: string;
  }): Promise<SigbashSignResult>;
  updatePolicy(opts: { keyId: string; newPolicyJson: string }): Promise<void>;
  disconnect?(): void;
  dispose?(): void;
}

export interface SigbashVerifyResult {
  passed?: boolean;
  success?: boolean;
  failures?: string[];
  error?: string;
  mode?: string;
  [extra: string]: unknown;
}

export interface SigbashSignResult {
  success?: boolean;
  psbt?: PolicyTx & { sigbashSignature?: string };
  txHex?: string;
  signedPSBT?: string;
  error?: string;
  mode?: string;
  [extra: string]: unknown;
}

/**
 * Fail-closed gate over the SDK's verifyPSBT result: only an explicit
 * passed === true with no error string counts as a pass. An absent boolean, a
 * legacy success-only shape, or any unexpected server reply is a rejection.
 */
export function sigbashVerificationPassed(
  result: SigbashVerifyResult | { passed?: boolean; error?: string } | null | undefined,
): boolean {
  return result?.passed === true && (result.error === undefined || result.error === '');
}

/** Only the service's explicit negative verdict counts as hostile-PSBT rejection. */
export function sigbashVerificationExplicitlyRejected(
  result: SigbashVerifyResult | { passed?: boolean } | null | undefined,
): boolean {
  return result?.passed === false;
}

export interface NormalizedSigningResult {
  success: boolean;
  txHex: string | null;
  signedPsbtBase64: string | null;
  pathId: string | null;
  policyRootHex: string | null;
  satisfiedClause: string | null;
  error: string | null;
}

// The SDK's signing result shape has drifted across versions; probe every
// field name it has used for the signed PSBT and final transaction hex.
// success is fail-closed: only an explicit success === true with no error
// counts — an absent or non-boolean success field never does.
export function normalizeSigbashSigningResult(
  rawResult: SigbashSignResult | { success?: boolean; error?: string } | null | undefined,
): NormalizedSigningResult {
  const result = (rawResult ?? {}) as Record<string, unknown>;
  const psbtField = result.psbt;
  const signedPsbtBase64 =
    (result.signedPSBT as string | undefined) ||
    (result.signedPsbt as string | undefined) ||
    (result.signedPsbtBase64 as string | undefined) ||
    (result.psbtBase64 as string | undefined) ||
    (typeof psbtField === 'string'
      ? psbtField
      : ((psbtField as { psbtBase64?: string } | undefined)?.psbtBase64)) ||
    null;
  const txHex =
    (result.txHex as string | undefined) ||
    (result.transactionHex as string | undefined) ||
    (result.hex as string | undefined) ||
    null;
  return {
    success: result.success === true && (result.error === undefined || result.error === null || result.error === ''),
    txHex,
    signedPsbtBase64,
    pathId: (result.pathId as string | undefined) || (result.satisfiedPath as string | undefined) || null,
    policyRootHex: (result.policyRootHex as string | undefined) || null,
    satisfiedClause: (result.satisfiedClause as string | undefined) || null,
    error: (result.error as string | undefined) || null,
  };
}

/** What the adapters accept: a local policy-model tx or a real PSBT wrapper. */
export type AdapterTx = PolicyTx | { psbtBase64: string };

export interface SigbashAdapter {
  verifyPSBT(tx: AdapterTx, policy: SoloPolicy): Promise<SigbashVerifyResult>;
  signPSBT(tx: AdapterTx, policy: SoloPolicy): Promise<SigbashSignResult>;
  dispose(): void;
}

/**
 * participantId selects the per-participant Sigbash credential triplet
 * (SIGBASH_API_KEY_<ID> etc.) in live mode, so verify and sign for a given
 * leaver always run under that participant's own credentials. The local
 * adapter has no credentials and ignores it.
 */
export async function createSigbashAdapter(
  { participantId }: { participantId?: string } = {},
): Promise<SigbashAdapter> {
  if (process.env.SIGBASH_MODE === 'live') {
    return LiveSigbashAdapter.create({ participantId });
  }
  return new LocalSigbashAdapter();
}

/** Own one adapter for exactly one action and always release copied key material. */
export async function withSigbashAdapter<T>(
  options: { participantId?: string },
  action: (adapter: SigbashAdapter) => Promise<T>,
): Promise<T> {
  const adapter = await createSigbashAdapter(options);
  return useSigbashAdapter(adapter, action);
}

/** Exported separately so failure-path disposal can be exercised without a live service. */
export async function useSigbashAdapter<T>(
  adapter: SigbashAdapter,
  action: (adapter: SigbashAdapter) => Promise<T>,
): Promise<T> {
  try {
    return await action(adapter);
  } finally {
    adapter.dispose();
  }
}

/** Close transport state and then overwrite any SDK-owned private-key copy. */
export function disposeSigbashLiveClient(
  client: Pick<SigbashLiveClient, 'disconnect' | 'dispose'>,
): void {
  try {
    client.disconnect?.();
  } finally {
    client.dispose?.();
  }
}

export class LocalSigbashAdapter implements SigbashAdapter {
  async verifyPSBT(tx: AdapterTx, policy: SoloPolicy): Promise<SigbashVerifyResult> {
    if (!isPolicyTx(tx)) {
      throw new Error('local verification requires a policy-model transaction, not a raw PSBT');
    }
    const failures = evaluatePolicy(tx, policy);
    return {
      success: failures.length === 0,
      failures,
      mode: 'local',
    };
  }

  async signPSBT(tx: AdapterTx, policy: SoloPolicy): Promise<SigbashSignResult> {
    if (!isPolicyTx(tx)) {
      throw new Error('local signing requires a policy-model transaction, not a raw PSBT');
    }
    const verified = await this.verifyPSBT(tx, policy);
    if (!verified.success) {
      return {
        success: false,
        error: verified.failures?.join('; '),
        mode: 'local',
      };
    }
    return {
      success: true,
      psbt: { ...tx, sigbashSignature: `local-sigbash-ok:${policy.id}` },
      mode: 'local',
    };
  }

  dispose(): void {}
}

function isPolicyTx(tx: AdapterTx): tx is PolicyTx {
  return Array.isArray((tx as PolicyTx).outputs);
}

class LiveSigbashAdapter implements SigbashAdapter {
  static async create(
    { participantId }: { participantId?: string } = {},
  ): Promise<LiveSigbashAdapter> {
    // Only participantId is threaded through: verify/sign are driven entirely
    // by the KMC fetched via getKey() — the SDK's signPSBT surface takes
    // {keyId, psbtBase64, kmcJSON, network} and nothing else, so no extra key
    // material (e.g. a musig2PrivateKey) may be invented here.
    const { sdk, client } = await createLiveSigbashClient({ participantId });
    return new LiveSigbashAdapter(sdk, client);
  }

  constructor(
    private readonly sdk: SigbashSdk,
    private readonly client: SigbashLiveClient,
  ) {}

  toPoetPolicy(policy: SoloPolicy): PoetPolicy {
    return this.sdk.conditionConfigToPoetPolicy(sigbashConditionConfig(policy));
  }

  async verifyPSBT(tx: AdapterTx, policy: SoloPolicy): Promise<SigbashVerifyResult> {
    if (!('psbtBase64' in tx) || !tx.psbtBase64 || !policy.keyId) {
      throw new Error('live verification requires tx.psbtBase64 and policy.keyId to fetch kmcJSON');
    }
    const { kmcJSON } = await this.client.getKey(policy.keyId, { verbose: true });
    return this.client.verifyPSBT({
      psbtBase64: tx.psbtBase64,
      kmcJSON,
      network: BITCOIN_NETWORK_NAME,
    });
  }

  // TODO(live-gate): actual live signPSBT success remains an external gate.
  // With the dual-leaf tree, live verifyPSBT passes and the client pipeline
  // reaches "sign tapscript input 0", but Sigbash's server signing service
  // still returns "server_error: Signing service error". Nothing in this
  // repository may claim end-to-end live signing works until Sigbash
  // resolves that server-side failure.
  async signPSBT(tx: AdapterTx, policy: SoloPolicy): Promise<SigbashSignResult> {
    if (!('psbtBase64' in tx) || !tx.psbtBase64 || !policy.keyId) {
      throw new Error('live signing requires tx.psbtBase64 and policy.keyId');
    }
    const keyId = policy.keyId;
    const { kmcJSON } = await this.client.getKey(keyId, { verbose: true });
    return withSigbashHexProofTransport(() => this.client.signPSBT({
      keyId,
      psbtBase64: tx.psbtBase64,
      kmcJSON,
      network: BITCOIN_NETWORK_NAME,
    }));
  }

  dispose(): void {
    disposeSigbashLiveClient(this.client);
  }
}

/**
 * The hosted signer currently decodes the complete `policy_proofs` transport
 * value as hex while the current hosted WASM emits raw JSON text. Interpose
 * before the SDK's PoP wrapper so the server receives—and the SDK
 * authenticates—the UTF-8 JSON bytes in its expected transport encoding.
 * Remove this compatibility boundary once Sigbash deploys matching
 * WASM/server versions.
 */
export async function withSigbashHexProofTransport<T>(action: () => Promise<T>): Promise<T> {
  const root = globalThis as typeof globalThis & { sharedMusigSocket?: SigbashRawSocket };
  const priorDescriptor = Object.getOwnPropertyDescriptor(root, 'sharedMusigSocket');
  let current = root.sharedMusigSocket;
  const restorers: Array<() => void> = [];
  const wrapped = new WeakSet<object>();
  const wrap = (socket: SigbashRawSocket | undefined): SigbashRawSocket | undefined => {
    if (!socket || typeof socket.emit !== 'function' || wrapped.has(socket)) return socket;
    const originalEmit = socket.emit;
    socket.emit = function (event: unknown, payload?: unknown, ...rest: unknown[]) {
      const rewritten = event === 'blind_signing_request'
        ? rewritePolicyProofBundlesAsHex(payload)
        : 0;
      if (event === 'blind_signing_request' && rewritten > 0 && typeof console !== 'undefined') {
        // Do not log proof material. This count is enough to confirm that the
        // compatibility boundary actually saw and rewrote the WASM payload.
        console.log(`[sigbash-compat] rewrote ${rewritten} policy proof bundle(s) as hex`);
      }
      if (event === 'blind_signing_request' &&
          typeof process !== 'undefined' && process.env.SIGBASH_PROOF_DIAGNOSTICS === '1' &&
          typeof console !== 'undefined') {
        // Field names, container types, and lengths only: never proof values.
        console.log(`[sigbash-compat] payload shape ${JSON.stringify(summarizePayloadShape(payload))}`);
      }
      return originalEmit.call(this, event, payload, ...rest);
    };
    wrapped.add(socket);
    restorers.push(() => { socket.emit = originalEmit; });
    return socket;
  };
  current = wrap(current);
  Object.defineProperty(root, 'sharedMusigSocket', {
    configurable: true,
    enumerable: priorDescriptor?.enumerable ?? true,
    get: () => current,
    set: (socket: SigbashRawSocket | undefined) => { current = wrap(socket); },
  });
  try {
    return await action();
  } finally {
    for (const restore of restorers.reverse()) restore();
    if (priorDescriptor) Object.defineProperty(root, 'sharedMusigSocket', priorDescriptor);
    else delete root.sharedMusigSocket;
  }
}

interface SigbashRawSocket {
  emit: (event: unknown, payload?: unknown, ...rest: unknown[]) => unknown;
}

function summarizePayloadShape(value: unknown): string[] {
  const fields: string[] = [];
  const seen = new WeakSet<object>();
  const visit = (item: unknown, path: string, depth: number): void => {
    if (fields.length >= 100) return;
    if (typeof item === 'string') {
      const isJson = item.startsWith('{') || item.startsWith('[');
      const shape = item.startsWith('{') ? 'json-object'
        : item.startsWith('[') ? 'json-array'
          : /^(?:[0-9a-f]{2})+$/u.test(item) ? 'hex'
            : /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(item) ? 'base64'
              : 'opaque';
      fields.push(`${path}:string:${shape}:${item.length}`);
      if (isJson && depth < 8) {
        try {
          visit(JSON.parse(item), `${path}<json>`, depth + 1);
        } catch {
          fields.push(`${path}<json>:invalid`);
        }
      }
      return;
    }
    if (!item || typeof item !== 'object') {
      fields.push(`${path}:${typeof item}`);
      return;
    }
    if (seen.has(item as object)) return;
    seen.add(item as object);
    if (Array.isArray(item)) {
      fields.push(`${path}:array:${item.length}`);
      if (depth < 8) {
        item.forEach((entry, index) => {
          if (typeof entry === 'string' || (entry && typeof entry === 'object')) {
            visit(entry, `${path}[${index}]`, depth + 1);
          }
        });
      }
      return;
    }
    const row = item as Record<string, unknown>;
    fields.push(`${path}:object:${Object.keys(row).length}`);
    if (depth < 8) {
      for (const [key, entry] of Object.entries(row)) visit(entry, `${path}.${key}`, depth + 1);
    }
  };
  visit(value, '$', 0);
  return fields;
}

function utf8ToHex(value: string): string {
  const binary = new TextEncoder().encode(value);
  let hex = '';
  for (let index = 0; index < binary.length; index += 1) {
    hex += binary[index]!.toString(16).padStart(2, '0');
  }
  return hex;
}

function rewritePolicyProofBundlesAsHex(value: unknown, seen = new WeakSet<object>()): number {
  if (!value || typeof value !== 'object' || seen.has(value as object)) return 0;
  seen.add(value as object);
  let rewritten = 0;
  if (Array.isArray(value)) {
    for (const item of value) rewritten += rewritePolicyProofBundlesAsHex(item, seen);
    return rewritten;
  }
  const row = value as Record<string, unknown>;
  for (const [key, item] of Object.entries(row)) {
    if (key === 'policy_proofs' && typeof item === 'string' &&
        (item.startsWith('{') || item.startsWith('['))) {
      row[key] = utf8ToHex(item);
      rewritten += 1;
    } else {
      rewritten += rewritePolicyProofBundlesAsHex(item, seen);
    }
  }
  return rewritten;
}

export async function createLiveSigbashClient({
  participantId,
  musig2PrivateKey,
}: { participantId?: string; musig2PrivateKey?: string | Uint8Array } = {}): Promise<{
  sdk: SigbashSdk;
  client: SigbashLiveClient;
}> {
  // Live Sigbash keys must never be bound to client shares derived from the
  // public default demo seed — anyone could reproduce the "browser half".
  assertNonDefaultSeed();
  let sdk: SigbashSdk;
  try {
    sdk = (await import('@sigbash/sdk')) as unknown as SigbashSdk;
  } catch (error) {
    throw new Error(
      `SIGBASH_MODE=live requires @sigbash/sdk to be installed: ${(error as Error).message}`,
    );
  }

  const credentials = resolveSigbashCredentials(process.env, participantId);
  const wasmUrl = process.env.SIGBASH_WASM_URL || 'https://www.sigbash.com/sigbash.wasm';
  // The SDK computes SHA-384 of the downloaded WASM and aborts on mismatch —
  // this is the defense against a swapped binary, so the pin is mandatory in
  // live mode and always passed to loadWasm.
  const expectedHash = validateWasmSha384(process.env.SIGBASH_WASM_SHA384);
  await sdk.loadWasm({ wasmUrl, expectedHash });
  const client = new sdk.SigbashClient({
    serverUrl: process.env.SIGBASH_SERVER_URL || 'https://www.sigbash.com',
    apiKey: credentials.apiKey,
    userKey: credentials.userKey,
    userSecretKey: credentials.userSecretKey,
    ...(musig2PrivateKey ? { musig2PrivateKey } : {}),
  });
  return { sdk, client };
}

export interface SigbashCredentials {
  apiKey: string;
  userKey: string;
  userSecretKey: string;
  source: 'participant' | 'shared';
}

const SIGBASH_CREDENTIAL_ENV_NAMES = [
  'SIGBASH_API_KEY',
  'SIGBASH_USER_KEY',
  'SIGBASH_SECRET_KEY',
] as const;

/**
 * Each participant should hold their own Sigbash credential triplet
 * (SIGBASH_API_KEY_ALICE etc.). The triplet is atomic: if any suffixed
 * variable is set, all three must be — a partial triplet is an error, never
 * silently mixed with the shared unsuffixed variables. Only when no suffixed
 * variable exists does the participant fall back to the shared triplet (the
 * single-operator demo setup, with the trust caveat noted in the README), and
 * that fallback is warned about by variable name only — values are never
 * echoed anywhere.
 */
export function resolveSigbashCredentials(
  env: Record<string, string | undefined>,
  participantId?: string,
  warn: (message: string) => void = (message) => console.warn(message),
): SigbashCredentials {
  if (participantId) {
    const suffix = `_${participantId.toUpperCase()}`;
    const scopedNames = SIGBASH_CREDENTIAL_ENV_NAMES.map((name) => `${name}${suffix}`);
    const [apiName, userName, secretName] = scopedNames;
    const missing = scopedNames.filter((name) => !env[name]);
    if (missing.length === 0) {
      return {
        apiKey: env[apiName!]!,
        userKey: env[userName!]!,
        userSecretKey: env[secretName!]!,
        source: 'participant',
      };
    }
    if (missing.length < scopedNames.length) {
      throw new Error(
        `partial Sigbash credential triplet for participant ${participantId}: missing ` +
          `${missing.join(', ')}. Set all three of ${scopedNames.join(', ')} or none — a ` +
          'partial triplet is never mixed with the shared SIGBASH_API_KEY/SIGBASH_USER_KEY/' +
          'SIGBASH_SECRET_KEY variables.',
      );
    }
    warn(
      `no ${scopedNames.join('/')} set; participant ${participantId} is using the shared ` +
        'SIGBASH_API_KEY/SIGBASH_USER_KEY/SIGBASH_SECRET_KEY triplet (single-operator demo ' +
        'setup — unacceptable for real funds)',
    );
  }
  const missingShared = SIGBASH_CREDENTIAL_ENV_NAMES.filter((name) => !env[name]);
  if (missingShared.length > 0) {
    throw new Error(`${missingShared.join(', ')} required in SIGBASH_MODE=live`);
  }
  return {
    apiKey: env.SIGBASH_API_KEY!,
    userKey: env.SIGBASH_USER_KEY!,
    userSecretKey: env.SIGBASH_SECRET_KEY!,
    source: 'shared',
  };
}

/**
 * SIGBASH_WASM_SHA384 is mandatory in live mode: without the pin a swapped
 * WASM binary would be loaded and trusted silently. SHA-384 is 48 bytes, so
 * the value must be exactly 96 hex characters. The rejected value is never
 * echoed back in the error.
 */
export function validateWasmSha384(value: string | undefined): string {
  if (!value) {
    throw new Error(
      'SIGBASH_WASM_SHA384 is required in SIGBASH_MODE=live: pin the expected SHA-384 of the Sigbash WASM binary (96 hex characters)',
    );
  }
  if (!/^[0-9a-fA-F]{96}$/.test(value)) {
    throw new Error('SIGBASH_WASM_SHA384 must be exactly 96 hex characters (SHA-384 of the WASM binary)');
  }
  return value;
}

export function toPoetPolicy(sdk: SigbashSdk, policy: SoloPolicy): PoetPolicy {
  return sdk.conditionConfigToPoetPolicy(sigbashConditionConfig(policy));
}

export function evaluatePolicy(tx: PolicyTx, policy: PolicyNode | undefined): string[] {
  if (!policy) throw new Error('no policy supplied for evaluation');
  return evaluateNode(tx, policy);
}

function evaluateNode(tx: PolicyTx, node: PolicyNode): string[] {
  if ('logic' in node) {
    const childResults = node.conditions.map((condition) => evaluateNode(tx, condition));
    if (node.logic === 'AND') {
      return childResults.flat();
    }
    if (node.logic === 'OR') {
      const passing = childResults.find((failures) => failures.length === 0);
      if (passing) return [];
      return childResults.map((failures, index) => `branch ${index} failed: ${failures.join(', ')}`);
    }
    throw new Error(`unsupported policy logic ${String(node.logic)}`);
  }

  const failures: string[] = [];
  if (node.type === 'OUTPUT_VALUE') {
    const output = tx.outputs[node.selector.index];
    if (!output) {
      failures.push(`missing output ${node.selector.index}`);
    } else if (!compare(output.value, node.operator, node.value)) {
      failures.push(
        `output ${node.selector.index} value ${output.value} failed ${node.operator} ${node.value}`,
      );
    }
  } else if (node.type === 'OUTPUT_DEST_IS_IN_SETS') {
    const output = tx.outputs[node.selector.index];
    if (!output) {
      failures.push(`missing output ${node.selector.index}`);
    } else if (!output.address || !node.addresses.includes(output.address)) {
      failures.push(`output ${node.selector.index} address is not allowed`);
    }
  } else if (node.type === 'TX_OUTPUT_COUNT') {
    if (!compare(tx.outputs.length, node.operator, node.value)) {
      failures.push(`output count ${tx.outputs.length} failed ${node.operator} ${node.value}`);
    }
  } else if (node.type === 'TX_INPUT_COUNT') {
    const inputCount = tx.inputCount ?? 0;
    if (!compare(inputCount, node.operator, node.value)) {
      failures.push(`input count ${inputCount} failed ${node.operator} ${node.value}`);
    }
  } else if (node.type === 'REQKEY') {
    if (tx.sigbashLeafKey !== node.local_key_identifier) {
      failures.push('required Sigbash tapscript key is missing');
    }
  } else {
    failures.push(`unsupported condition ${(node as { type: string }).type}`);
  }
  return failures;
}

// Convert the repo's policy objects into the SDK's condition-config shorthand.
// Fields that only exist for the local policy model (ids, round metadata, the
// local REQKEY key material) are stripped so Sigbash receives a clean policy.
function compare(actual: number, operator: string, expected: number): boolean {
  switch (operator) {
    case 'EQ':
      return actual === expected;
    case 'GTE':
      return actual >= expected;
    case 'LTE':
      return actual <= expected;
    case 'GT':
      return actual > expected;
    case 'LT':
      return actual < expected;
    case 'NEQ':
      return actual !== expected;
    default:
      throw new Error(`unsupported operator ${operator}`);
  }
}
