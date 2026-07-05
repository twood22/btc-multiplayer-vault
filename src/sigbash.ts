import { assertNonDefaultSeed } from './config.js';
import type { PolicyCondition, PolicyNode, PolicyTx, SoloPolicy } from './types.js';

// The live SDK is imported dynamically (it needs WASM + credentials), so its
// surface is typed here rather than pulled from the package at build time.
export interface SigbashSdk {
  loadWasm(options: { wasmUrl: string }): Promise<void>;
  SigbashClient: new (options: {
    serverUrl: string;
    apiKey: string;
    userKey: string;
    userSecretKey: string;
    musig2PrivateKey?: string;
  }) => SigbashLiveClient;
  conditionConfigToPoetPolicy(config: unknown): PoetPolicy;
  SDK_VERSION?: string;
}

export interface PoetPolicy {
  version: string;
  policy?: { operator?: string; children?: unknown[] };
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

/** What the adapters accept: a local policy-model tx or a real PSBT wrapper. */
export type AdapterTx = PolicyTx | { psbtBase64: string };

export interface SigbashAdapter {
  verifyPSBT(tx: AdapterTx, policy: SoloPolicy): Promise<SigbashVerifyResult>;
  signPSBT(tx: AdapterTx, policy: SoloPolicy): Promise<SigbashSignResult>;
}

export async function createSigbashAdapter(): Promise<SigbashAdapter> {
  if (process.env.SIGBASH_MODE === 'live') {
    return LiveSigbashAdapter.create();
  }
  return new LocalSigbashAdapter();
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
}

function isPolicyTx(tx: AdapterTx): tx is PolicyTx {
  return Array.isArray((tx as PolicyTx).outputs);
}

class LiveSigbashAdapter implements SigbashAdapter {
  static async create(): Promise<LiveSigbashAdapter> {
    const { sdk, client } = await createLiveSigbashClient();
    return new LiveSigbashAdapter(sdk, client);
  }

  constructor(
    private readonly sdk: SigbashSdk,
    private readonly client: SigbashLiveClient,
  ) {}

  toPoetPolicy(policy: SoloPolicy): PoetPolicy {
    return this.sdk.conditionConfigToPoetPolicy(toConditionConfig(policy));
  }

  async verifyPSBT(tx: AdapterTx, policy: SoloPolicy): Promise<SigbashVerifyResult> {
    if (!('psbtBase64' in tx) || !tx.psbtBase64 || !policy.keyId) {
      throw new Error('live verification requires tx.psbtBase64 and policy.keyId to fetch kmcJSON');
    }
    const { kmcJSON } = await this.client.getKey(policy.keyId, { verbose: true });
    return this.client.verifyPSBT({
      psbtBase64: tx.psbtBase64,
      kmcJSON,
      network: 'signet',
    });
  }

  async signPSBT(tx: AdapterTx, policy: SoloPolicy): Promise<SigbashSignResult> {
    if (!('psbtBase64' in tx) || !tx.psbtBase64 || !policy.keyId) {
      throw new Error('live signing requires tx.psbtBase64 and policy.keyId');
    }
    const { kmcJSON } = await this.client.getKey(policy.keyId, { verbose: true });
    return this.client.signPSBT({
      keyId: policy.keyId,
      psbtBase64: tx.psbtBase64,
      kmcJSON,
      network: 'signet',
    });
  }
}

export async function createLiveSigbashClient({
  participantId,
  musig2PrivateKey,
}: { participantId?: string; musig2PrivateKey?: string } = {}): Promise<{
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

  const wasmUrl = process.env.SIGBASH_WASM_URL || 'https://www.sigbash.com/sigbash.wasm';
  await sdk.loadWasm({ wasmUrl });
  const client = new sdk.SigbashClient({
    serverUrl: process.env.SIGBASH_SERVER_URL || 'https://www.sigbash.com',
    apiKey: participantEnv('SIGBASH_API_KEY', participantId),
    userKey: participantEnv('SIGBASH_USER_KEY', participantId),
    userSecretKey: participantEnv('SIGBASH_SECRET_KEY', participantId),
    ...(musig2PrivateKey ? { musig2PrivateKey } : {}),
  });
  return { sdk, client };
}

// Each participant should hold their own Sigbash credential triplet
// (SIGBASH_API_KEY_ALICE etc.). A shared triplet without suffix is accepted
// for single-operator demo runs, with the trust caveat noted in the README.
function participantEnv(name: string, participantId?: string): string {
  if (participantId) {
    const scoped = process.env[`${name}_${participantId.toUpperCase()}`];
    if (scoped) return scoped;
  }
  return requiredEnv(name);
}

export function toPoetPolicy(sdk: SigbashSdk, policy: SoloPolicy): PoetPolicy {
  return sdk.conditionConfigToPoetPolicy(toConditionConfig(policy));
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
    const expectedKey = node.local_key_identifier;
    if (tx.sigbashLeafKey !== expectedKey) {
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
function toConditionConfig(policy: PolicyNode | SoloPolicy): unknown {
  if ('logic' in policy) {
    return {
      logic: policy.logic,
      conditions: policy.conditions.map((condition) => toConditionConfig(condition)),
    };
  }
  const {
    local_key_identifier: _localKey,
    ...condition
  } = policy as PolicyCondition & { local_key_identifier?: string };
  return condition;
}

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

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required in SIGBASH_MODE=live`);
  return value;
}
